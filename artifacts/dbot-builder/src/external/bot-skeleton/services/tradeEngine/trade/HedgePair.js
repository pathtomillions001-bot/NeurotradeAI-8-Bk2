import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import ApiHelpers from '../../api/api-helpers';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { BEFORE_PURCHASE, DURING_PURCHASE, NEW_TICK, PURCHASE_SUCCESSFUL } from './state/constants';
import { openContractReceived, purchaseSuccessful, sell } from './state/actions';
import {
    HEDGE_PAIR_DEFINITIONS,
    HEDGE_PAIR_FAMILIES,
    HEDGE_PAIR_ANALYSIS_LIMITS,
    analyseHedgePairTape,
    applyPairSettlement,
    lastDigitFromQuote,
    normalizePairConfig,
    normalizeWatchMarkets,
    pairEvidenceScore,
    rankHedgePairMarkets,
    sizePairRecovery,
} from './hedge-pair-analysis';

const QUOTE_TIMEOUT_MS = 5000;
const QUOTE_TTL_MS = 5000;
const BALANCE_EPSILON = 1e-8;
/**
 * A hold that never changes its message still gets one journal line this often.
 * The old heartbeat was epoch-gated (`lastEpoch > 0 && lastEpoch - last >= 10`)
 * and twelve of the fifteen hold sites run BEFORE any tape exists, so they pass
 * epoch 0: a bot that failed at configuration printed once and then went silent
 * for the rest of the session. That silence — not a missing analysis — is what
 * made Hedge Pair Forge look like it "does nothing" next to Nexus Forge.
 */
const HOLD_HEARTBEAT_MS = 30000;
/** Minimum spacing for the per-tick analysis-flow lines. */
const FLOW_LOG_INTERVAL_MS = 5000;
const money = value => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00');
const percent = value => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : 'n/a');
const UNIT_ORDER = ['t', 's', 'm', 'h', 'd'];
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => String(value ?? '').trim();
// Keep up to eight decimal places so settlement accounting remains exact for
// Deriv account currencies whose minor unit is not two decimal places.
const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;
const formatOffset = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 8 });
};

function parseContractDuration(value) {
    const match = String(value ?? '').trim().match(/^(\d+)\s*([tsmhd])$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    return Number.isInteger(amount) && amount > 0 && UNIT_ORDER.includes(unit) ? { amount, unit } : null;
}

function secondsForDuration(duration, tickSeconds) {
    if (duration.unit === 't') return duration.amount * tickSeconds;
    return duration.amount * UNIT_SECONDS[duration.unit];
}

function supportsDurationUnit(range, candidate) {
    return UNIT_ORDER.indexOf(candidate) >= UNIT_ORDER.indexOf(range.min.unit) &&
        UNIT_ORDER.indexOf(candidate) <= UNIT_ORDER.indexOf(range.max.unit);
}

/**
 * Select the shortest shared duration from actual `contracts_for` metadata.
 * Tick is preferred. If both contracts do not support ticks, the returned
 * common duration is the actual minimum in the finest shared supported unit.
 * Missing/malformed metadata fails closed; no hard-coded duration fallback.
 */
function chooseCommonPairDuration(contractsA, typeA, contractsB, typeB, requestedTicks, tickSeconds, barriersA, barriersB) {
    const rangesFor = (contracts, type, expectedBarriers) => contracts
        .filter(item => {
            const barrierCount = item?.barriers === undefined || item?.barriers === null ? 0 : Number(item.barriers);
            return String(item?.contract_type ?? '').toUpperCase() === type &&
                barrierCount === Number(expectedBarriers);
        })
        .map(contract => ({
            contract,
            min: parseContractDuration(contract?.min_contract_duration),
            max: parseContractDuration(contract?.max_contract_duration),
        }))
        .filter(range => range.min && range.max && UNIT_ORDER.indexOf(range.min.unit) <= UNIT_ORDER.indexOf(range.max.unit));
    const rangesA = rangesFor(contractsA, typeA, barriersA);
    const rangesB = rangesFor(contractsB, typeB, barriersB);
    if (rangesA.length === 0 || rangesB.length === 0 || !(Number(tickSeconds) > 0)) return null;

    const candidates = [];
    for (const a of rangesA) {
        for (const b of rangesB) {
            for (const unit of UNIT_ORDER) {
                if (!supportsDurationUnit(a, unit) || !supportsDurationUnit(b, unit)) continue;
                const unitSeconds = unit === 't' ? tickSeconds : UNIT_SECONDS[unit];
                const minA = Math.ceil(secondsForDuration(a.min, tickSeconds) / unitSeconds - 1e-10);
                const minB = Math.ceil(secondsForDuration(b.min, tickSeconds) / unitSeconds - 1e-10);
                const maxA = Math.floor(secondsForDuration(a.max, tickSeconds) / unitSeconds + 1e-10);
                const maxB = Math.floor(secondsForDuration(b.max, tickSeconds) / unitSeconds + 1e-10);
                const floor = Math.max(1, minA, minB, unit === 't' ? Math.trunc(Number(requestedTicks) || 1) : 1);
                const ceiling = Math.min(maxA, maxB);
                if (floor > ceiling) continue;
                const amount = floor;
                const seconds = amount * unitSeconds;
                const durationTicks = Math.max(1, Math.ceil(seconds / tickSeconds - 1e-10));
                candidates.push({ amount, unit, durationTicks, tickSeconds, seconds, sourceA: a.contract, sourceB: b.contract });
                // The first common unit is the finest advertised unit for this
                // exact contract-range pair; coarser equivalents cannot reduce
                // the actual duration for that same pair.
                break;
            }
        }
    }
    candidates.sort((a, b) => a.seconds - b.seconds || UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit));
    if (candidates.length === 0) return null;
    const { seconds, ...shortest } = candidates[0];
    return shortest;
}

function medianTickSeconds(ticks) {
    const epochs = ticks.map(tick => Number(tick?.epoch)).filter(Number.isFinite);
    const deltas = [];
    for (let index = Math.max(1, epochs.length - 100); index < epochs.length; index += 1) {
        const delta = epochs[index] - epochs[index - 1];
        if (delta > 0 && delta <= 60) deltas.push(delta);
    }
    if (deltas.length < 3) return null;
    deltas.sort((a, b) => a - b);
    const middle = Math.floor(deltas.length / 2);
    return deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
}

function barrierFields(family, legIndex, upperOffset, lowerOffset) {
    const familyDefinition = HEDGE_PAIR_DEFINITIONS[family];
    const leg = familyDefinition?.legs?.[legIndex];
    if (!leg) return {};
    if (family === 'DIGIT_OVERUNDER') return { barrier: String(leg.barrier) };
    if (!familyDefinition.needsPriceBarriers) return {};
    const high = `+${formatOffset(upperOffset)}`;
    const low = `-${formatOffset(lowerOffset)}`;
    const request = {};
    if (leg.barrier === 'upper') request.barrier = high;
    else if (leg.barrier === 'lower') request.barrier = low;
    if (leg.barrier2 === 'upper') request.barrier2 = high;
    else if (leg.barrier2 === 'lower') request.barrier2 = low;
    return request;
}

function validateEcho(request, echo) {
    if (!echo || typeof echo !== 'object' || Array.isArray(echo)) return false;
    return Object.entries(request).every(([key, expected]) => {
        if (echo[key] === undefined || echo[key] === null) return false;
        if (typeof expected === 'number') return Number(echo[key]) === expected;
        return String(echo[key]) === String(expected);
    });
}

function withTimeout(promise, label, timeoutMs = QUOTE_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function quotePairLeg({ symbol, currency, contractType, duration, amount, barriers }) {
    if (!api_base.api || !duration || !Number.isFinite(Number(amount)) || Number(amount) < 0.35) return null;
    const request = {
        proposal: 1,
        amount: Number(amount),
        basis: 'stake',
        contract_type: contractType,
        currency,
        duration: duration.amount,
        duration_unit: duration.unit,
        underlying_symbol: symbol,
        ...barriers,
    };
    try {
        const response = await withTimeout(api_base.api.send(request), 'Hedge-pair live quote');
        const proposal = response?.proposal;
        if (
            response?.error ||
            typeof proposal?.id !== 'string' || !proposal.id.trim() ||
            !validateEcho(request, response?.echo_req)
        ) return null;
        const askPrice = Number(proposal.ask_price);
        const payout = Number(proposal.payout);
        if (
            !Number.isFinite(askPrice) || Math.abs(askPrice - Number(amount)) > BALANCE_EPSILON ||
            !Number.isFinite(payout) || payout <= askPrice
        ) return null;
        return {
            proposalId: proposal.id,
            askPrice,
            payout,
            multiplier: payout / askPrice,
            request,
            quotedAt: Date.now(),
        };
    } catch (_) {
        return null;
    }
}

/** Both socket sends occur before awaiting either response: closest available to simultaneity. */
function buyPairQuotesConcurrently(quotes) {
    if (!Array.isArray(quotes) || quotes.length !== 2 || !api_base.api) {
        return Promise.resolve([]);
    }
    const attempts = quotes.map(quote => {
        try {
            return Promise.resolve(api_base.api.send({ buy: quote.proposalId, price: quote.askPrice }));
        } catch (error) {
            return Promise.reject(error);
        }
    });
    return Promise.allSettled(attempts);
}

function extractTicks(ticks) {
    if (!Array.isArray(ticks)) return [];
    return ticks.map(tick => ({ quote: Number(tick?.quote), epoch: Number(tick?.epoch) }))
        .filter(tick => Number.isFinite(tick.quote) && Number.isFinite(tick.epoch));
}

/** Deriv `ticks_history` (style 'ticks') → the Builder's `{quote, epoch}` shape. */
function extractHistoryTicks(response) {
    const prices = Array.isArray(response?.history?.prices) ? response.history.prices : [];
    const times = Array.isArray(response?.history?.times) ? response.history.times : [];
    const ticks = [];
    for (let index = 0; index < Math.min(prices.length, times.length); index += 1) {
        const quote = Number(prices[index]);
        const epoch = Number(times[index]);
        if (Number.isFinite(quote) && Number.isFinite(epoch)) ticks.push({ quote, epoch });
    }
    return ticks;
}

/**
 * Join the cached deep tape with whatever the live stream has produced since.
 *
 * The deep tape is a snapshot (it is cached for a minute to stay inside Deriv's
 * request budget) while the live ring buffer carries the newest ticks — and the
 * newest tick is the one the whole cycle is timed against. Keeping them separate
 * would either analyse a stale tape or throw away the deep history that makes a
 * minute-duration family measurable at all, so they are merged by epoch and the
 * analysis window is taken from the tail.
 */
function mergeTapes(deepTicks, liveTicks, wantCount) {
    const live = Array.isArray(liveTicks) ? liveTicks : [];
    const deep = Array.isArray(deepTicks) ? deepTicks : [];
    const want = Math.max(2, Math.trunc(Number(wantCount)) || deep.length || live.length);
    if (deep.length === 0) return live.slice(-want);
    if (live.length === 0) return deep.slice(-want);
    const lastDeepEpoch = Number(deep.at(-1)?.epoch);
    const newer = live.filter(tick => Number(tick.epoch) > lastDeepEpoch);
    const merged = newer.length === 0 ? deep : deep.concat(newer);
    return merged.slice(-want);
}

function contractProfit(contract) {
    const buyPrice = Number(contract?.buy_price);
    const sellPrice = Number(contract?.sell_price);
    const hasReportedProfit = contract?.profit !== undefined && contract?.profit !== null && contract?.profit !== '';
    const reportedProfit = hasReportedProfit ? Number(contract.profit) : NaN;
    if (Number.isFinite(reportedProfit)) return roundMoney(reportedProfit);
    if (Number.isFinite(buyPrice) && Number.isFinite(sellPrice)) return roundMoney(sellPrice - buyPrice);
    return NaN;
}

function contractOutcome(contract, profit) {
    const status = String(contract?.status ?? '').toLowerCase();
    // Prefer Deriv's terminal per-contract classification. Only infer from
    // realized P&L if the broker omitted a recognized win/loss status.
    if (status === 'lost') return 'lost';
    if (status === 'won') return 'won';
    if (profit < -0.000001) return 'lost';
    if (profit > 0.000001) return 'won';
    return 'sold';
}

function isSettledContract(contract) {
    return Boolean(contract && (
        contract.is_sold === true || contract.is_expired === true ||
        ['won', 'lost', 'sold'].includes(String(contract.status ?? '').toLowerCase())
    ));
}

function log(kind, message) {
    globalObserver.emit(`ui.log.${kind}`, message);
}

export {
    barrierFields,
    buyPairQuotesConcurrently,
    chooseCommonPairDuration,
    contractOutcome,
    contractProfit,
    extractHistoryTicks,
    isSettledContract,
    medianTickSeconds,
    mergeTapes,
    parseContractDuration,
    quotePairLeg,
};

export default Engine =>
    class HedgePair extends Engine {
        init(...args) {
            this.nt_pair_config = null;
            this.nt_pair_state = {
                sessionProfit: 0,
                debt: 0,
                recoveryStep: 0,
                doubleLossRun: 0,
                completedPairs: 0,
                recoveryArmed: false,
                halted: false,
                haltReason: '',
                lastPairNetProfit: 0,
                lastPairOutcome: null,
                /**
                 * The live winning-leg payout the current recovery ladder was
                 * sized against. A market rotation that lands on a WORSE payout
                 * lengthens the ladder, so the journal compares the two instead
                 * of silently re-sizing (doc §5, recovery-rotation guard).
                 */
                recoveryReferenceMultiplier: 0,
            };
            this.nt_pair_busy = false;
            this.nt_pair_active = null;
            this.nt_pair_confirmation = null;
            this.nt_pair_quote_cache = new Map();
            this.nt_pair_last_log = '';
            this.nt_pair_log_epoch = 0;
            this.nt_pair_log_at = 0;
            this.nt_pair_pair_serial = 0;
            /** symbol → { at, ticks, source } — the deep-history cache. */
            this.nt_pair_tape_cache = new Map();
            /** Last multi-market ranking table + switch decision. */
            this.nt_pair_rank_cache = null;
            /** label → last journal time, so a tick cannot flood the analysis flow. */
            this.nt_pair_flow_at = new Map();
            /** Wall-clock start of an unbroken soft-blocker-only hold (patience valve). */
            this.nt_pair_soft_hold_since = 0;
            /** Most recent analysis, exposed through `nt_hedge_pair_status`. */
            this.nt_pair_last_analysis = null;
            this.nt_pair_market = {
                symbol: '',
                evaluations: 0,
                evaluationsOnCurrent: 0,
                evaluationsSinceSwitch: 0,
                switches: 0,
                lastSwitchFrom: '',
                lastSwitchReason: '',
            };
            return super.init(...args);
        }

        ntHedgePairStatus(field = 'continue') {
            const state = this.nt_pair_state;
            const key = String(field || 'continue').toLowerCase();
            const analysis = this.nt_pair_last_analysis;
            const market = this.nt_pair_market ?? {};
            const rank = this.nt_pair_rank_cache;
            if (key === 'continue' || key === 'eligible') return Boolean(state && !state.halted);
            if (!state) return ['debt', 'profit', 'step', 'pairs', 'samples', 'edge', 'lower bound', 'instability', 'timing', 'repayment', 'both lost', 'switches', 'markets watched']
                .includes(key) ? 0 : '';
            if (key === 'debt') return Number(state.debt || 0);
            if (key === 'profit') return Number(state.sessionProfit || 0);
            if (key === 'step') return Number(state.recoveryStep || 0);
            if (key === 'reason') return state.haltReason || (analysis && !analysis.eligible ? analysis.reason : '');
            if (key === 'pairs') return Number(state.completedPairs || 0);
            if (key === 'recovery armed') return Boolean(state.recoveryArmed);
            if (key === 'target') return Number(state.recoveryTarget || 0);
            // ── The analysis itself, so a Blockly bot (or a notify block) can
            // surface WHY the pair is or is not being bought. Before this the
            // status block exposed seven bookkeeping fields and not one number
            // from the 4 998-sample replay the engine had just performed.
            if (key === 'market') return String(market.symbol || analysis?.symbol || this.symbol || '');
            if (key === 'mode') return String(analysis?.mode || (state.recoveryArmed && Number(state.debt || 0) > 0 ? 'recovery' : 'normal'));
            if (key === 'samples') return Number(analysis?.samples || 0);
            if (key === 'samples required') return Number(analysis?.samplesRequired || 0);
            if (key === 'low confidence') return Boolean(analysis?.lowConfidence);
            if (key === 'edge') return Number(analysis?.expectedEdge || 0);
            if (key === 'lower bound') return Number(analysis?.lowerBound || 0);
            if (key === 'instability') return Number(analysis?.instability || 0);
            if (key === 'timing') return Number(analysis?.timingScore || 0);
            if (key === 'timing ready') return Boolean(analysis?.timingReady);
            if (key === 'both win') return Number(analysis?.stateCounts?.bothWin || 0);
            if (key === 'only a') return Number(analysis?.stateCounts?.onlyA || 0);
            if (key === 'only b') return Number(analysis?.stateCounts?.onlyB || 0);
            if (key === 'both lost') return Number(analysis?.stateCounts?.bothLose || 0);
            if (key === 'repayment') {
                const counts = analysis?.stateCounts;
                if (!counts || !Number(analysis?.samples)) return 0;
                return (Number(counts.bothWin || 0) + Number(counts.onlyA || 0) + Number(counts.onlyB || 0)) / Number(analysis.samples);
            }
            if (key === 'hard blockers') return Number(analysis?.hardBlockers?.length || 0);
            if (key === 'soft blockers') return Number(analysis?.softBlockers?.length || 0);
            if (key === 'analysis') return analysis ? String(analysis.reason || '') : '';
            if (key === 'multiplier a') return Number(analysis?.multiplierA || 0);
            if (key === 'multiplier b') return Number(analysis?.multiplierB || 0);
            if (key === 'win multiplier') return analysis ? Math.min(Number(analysis.multiplierA) || 0, Number(analysis.multiplierB) || 0) : 0;
            if (key === 'markets watched') return Number(this.nt_pair_config?.watchMarkets?.length || 0);
            if (key === 'markets') return String((this.nt_pair_config?.watchMarkets || []).join(', '));
            if (key === 'best market') return String(rank?.best?.symbol || '');
            if (key === 'rank') return String(rank?.decision?.reason || '');
            if (key === 'switches') return Number(market.switches || 0);
            if (key === 'forced entry') return Boolean(state.lastForcedEntry);
            return Boolean(state && !state.halted);
        }

        ntPairSetHalt(reason) {
            if (!this.nt_pair_state) {
                this.nt_pair_state = {
                    sessionProfit: Number(this.sessionProfit || 0), debt: 0, recoveryStep: 0,
                    doubleLossRun: 0, completedPairs: 0, recoveryArmed: false,
                    halted: false, haltReason: '',
                };
            }
            this.nt_pair_state.halted = true;
            this.nt_pair_state.haltReason = String(reason || 'safety stop');
            this.nt_pair_confirmation = null;
            log('error', `Hedge Pair Forge HALT · ${this.nt_pair_state.haltReason}`);
        }

        ntPairLogHold(reason, epoch) {
            const message = `Hedge Pair Forge HOLD · ${String(reason || 'no qualified paired setup')}`;
            const changed = message !== this.nt_pair_last_log;
            const now = Date.now();
            // Wall-clock heartbeat, not epoch-gated: a hold raised before any tape
            // exists has no epoch at all, and those are exactly the holds an owner
            // most needs to see repeated (bad offsets, missing precision, no common
            // duration). One line per changed message, then one every 30 s.
            const heartbeat = now - Number(this.nt_pair_log_at || 0) >= HOLD_HEARTBEAT_MS;
            if (changed || heartbeat) {
                log('info', message);
                this.nt_pair_last_log = message;
                this.nt_pair_log_at = now;
                this.nt_pair_log_epoch = Number(epoch) || 0;
            }
        }

        /**
         * Analysis-flow journal line, rate limited per label.
         *
         * Nexus Forge prints its market-to-market reasoning (`ANALYSING …`,
         * `NEXUS SWITCH …`) because its generator emits notify blocks; this bot
         * emitted none, so a session produced three lines at settlement and
         * nothing in between. These lines come from the runtime instead of the
         * XML, which keeps every generated bot — including the seven committed
         * fixtures — byte-identical while still showing the work.
         */
        ntPairLogFlow(label, message, { kind = 'info', minIntervalMs = FLOW_LOG_INTERVAL_MS, force = false } = {}) {
            const key = String(label || 'flow');
            this.nt_pair_flow_at ??= new Map();
            const now = Date.now();
            if (!force && now - Number(this.nt_pair_flow_at.get(key) || 0) < minIntervalMs) return false;
            this.nt_pair_flow_at.set(key, now);
            log(kind, message);
            return true;
        }

        /**
         * Deep tick history for one symbol, cached for `deepTapeTtlMs`.
         *
         * `ticks_service.js` asks Deriv for `count: 1000` and keeps a 1 000-tick
         * ring, and the analysis window was clamped to that same 1 000. Pair
         * replay is NON-OVERLAPPING — one observation per completed event — so a
         * family whose shortest common duration is a minute (Ends / Stays
         * Between, whose expiry contracts are never tick-denominated) produced
         * 16 samples against an 80-sample floor and could never be analysed.
         * Deriv's own maximum for one `ticks_history` call is 4 999 (5 000 is
         * rejected outright), which turns those 16 into 83.
         *
         * Failures are negative-cached for the same TTL and the caller degrades to
         * the Builder's ring, so a rejected `ticks_history` costs one request per
         * minute per symbol instead of one per tick.
         */
        async ntPairDeepTape(symbol, wantCount) {
            const limits = HEDGE_PAIR_ANALYSIS_LIMITS;
            const count = Math.max(50, Math.min(limits.deepHistoryCount, Math.trunc(Number(wantCount)) || limits.deepHistoryCount));
            this.nt_pair_tape_cache ??= new Map();
            const cached = this.nt_pair_tape_cache.get(symbol);
            const age = cached ? Date.now() - Number(cached.at || 0) : Infinity;
            if (cached && age < limits.deepTapeTtlMs) {
                if (cached.source === 'failed') return { ticks: [], source: 'failed', age, error: cached.error, requested: count };
                if (cached.ticks.length >= 2) return { ticks: cached.ticks, source: cached.source, age, requested: count };
            }
            if (!api_base.api?.send) {
                return { ticks: [], source: 'unavailable', age: 0, error: 'Builder Deriv connection unavailable', requested: count };
            }
            try {
                const response = await withTimeout(api_base.api.send({
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count,
                    end: 'latest',
                    style: 'ticks',
                }), 'Hedge-pair deep tick history');
                if (response?.error) throw new Error(response.error.message || response.error.code || 'ticks_history was rejected');
                const ticks = extractHistoryTicks(response);
                if (ticks.length < 2) throw new Error(`ticks_history returned ${ticks.length} usable tick(s)`);
                this.nt_pair_tape_cache.set(symbol, { at: Date.now(), ticks, source: 'ticks_history' });
                return { ticks, source: 'ticks_history', age: 0, requested: count };
            } catch (error) {
                const message = error?.message || 'deep tick history unavailable';
                this.nt_pair_tape_cache.set(symbol, { at: Date.now(), ticks: [], source: 'failed', error: message });
                return { ticks: [], source: 'failed', age: 0, error: message, requested: count };
            }
        }

        /**
         * One ranking row for a candidate market.
         *
         * Each market is measured on ITS OWN tape, ITS OWN price precision and
         * ITS OWN `contracts_for` duration — a family can be a 1-tick pair on one
         * index and a 5-tick pair on another, so borrowing the incumbent's
         * duration would compare different contracts. The incumbent's LIVE
         * payouts are used as the payout proxy for every candidate: quoting both
         * legs on eight markets per tick would exhaust Deriv's request budget
         * before a single pair was bought. Only the winner is then quoted live and
         * re-gated on real payouts, so no buy ever rests on a proxy number.
         */
        async ntPairMarketRow({ symbol, config, familyDefinition, legTypes, currency, proxyMultipliers, liveTicks = null }) {
            const row = { symbol, samples: 0, stateCounts: {}, timingScore: 0, instability: 0, configuredMinSamples: config.minSamples, hardBlockers: [], softBlockers: [] };
            try {
                const pipSize = Number(this.$scope?.ticksService?.pipSizes?.[symbol] ?? api_base.pip_sizes?.[symbol]);
                if (!Number.isFinite(pipSize) || pipSize < 0) {
                    row.hardBlockers.push('price precision unavailable for this market');
                    return row;
                }
                const deep = await this.ntPairDeepTape(symbol, config.analysisWindow);
                const ticks = mergeTapes(deep.ticks, liveTicks || [], config.analysisWindow);
                if (ticks.length < 20) {
                    row.hardBlockers.push(deep.source === 'failed'
                        ? `no usable tape · ${deep.error || 'deep history unavailable'}`
                        : `only ${ticks.length} tick(s) of history`);
                    return row;
                }
                const contractsFor = ApiHelpers?.instance?.contracts_for;
                if (!contractsFor?.getContractsFor) {
                    row.hardBlockers.push('contracts_for metadata service unavailable');
                    return row;
                }
                const available = await contractsFor.getContractsFor(symbol);
                if (!Array.isArray(available) || available.length === 0) {
                    row.hardBlockers.push('contracts_for returned no live contract metadata');
                    return row;
                }
                const tickSeconds = medianTickSeconds(ticks) || 1;
                const pairDuration = chooseCommonPairDuration(
                    available.filter(contract => String(contract?.contract_type ?? '').toUpperCase() === legTypes[0]), legTypes[0],
                    available.filter(contract => String(contract?.contract_type ?? '').toUpperCase() === legTypes[1]), legTypes[1],
                    config.requestedDuration, tickSeconds,
                    familyDefinition.legs[0].barriers, familyDefinition.legs[1].barriers,
                );
                if (!pairDuration) {
                    row.hardBlockers.push('no common duration in this market\'s two contracts_for ranges');
                    return row;
                }
                const duration = { amount: pairDuration.amount, unit: pairDuration.unit };
                const analysis = analyseHedgePairTape({
                    family: config.family,
                    prices: ticks.map(tick => tick.quote),
                    epochs: ticks.map(tick => tick.epoch),
                    duration: pairDuration.durationTicks,
                    durationSeconds: duration.unit === 't' ? 0 : secondsForDuration(duration, tickSeconds),
                    pipSize,
                    upperOffset: config.upperOffset,
                    lowerOffset: config.lowerOffset,
                    minSamples: config.minSamples,
                    requiredEdge: config.requiredEdge,
                    multiplierA: proxyMultipliers?.[0],
                    multiplierB: proxyMultipliers?.[1],
                    mode: 'NORMAL',
                    // Ranking measures which market this pair does better on; the
                    // entry-context gate belongs to the buy decision on the
                    // incumbent, which the cycle applies separately.
                    requireTiming: false,
                });
                return {
                    symbol,
                    ...analysis,
                    duration,
                    durationTicks: pairDuration.durationTicks,
                    tapeTicks: ticks.length,
                    tapeSource: deep.source,
                    tapeAge: Math.round(deep.age / 1000),
                };
            } catch (error) {
                row.hardBlockers.push(error?.message || 'market could not be analysed');
                return row;
            }
        }

        /**
         * Rank the watch list and decide whether to move. Returns null when the
         * bot watches a single market (the pre-switching behaviour, and what every
         * already-generated XML does until its owner adds markets).
         */
        async ntPairEvaluateMarkets({ config, familyDefinition, legTypes, currency, incumbent, liveTicks, proxyMultipliers, isRecovery }) {
            const limits = HEDGE_PAIR_ANALYSIS_LIMITS;
            const market = this.nt_pair_market;
            market.evaluations += 1;
            if (market.symbol && market.symbol !== incumbent) market.evaluationsOnCurrent = 0;
            market.symbol = incumbent;
            market.evaluationsOnCurrent += 1;
            market.evaluationsSinceSwitch += 1;

            const markets = Array.isArray(config.watchMarkets) ? config.watchMarkets : [incumbent];
            if (markets.length < 2) {
                this.nt_pair_rank_cache = null;
                return null;
            }
            const cache = this.nt_pair_rank_cache;
            const reusable = cache &&
                cache.family === config.family &&
                cache.incumbent === incumbent &&
                cache.markets.join(',') === markets.join(',') &&
                market.evaluations - cache.atEvaluation < limits.rankIntervalEvaluations;
            if (reusable) return cache;

            const rows = [];
            for (const symbol of markets) {
                // Sequential, not Promise.all: eight concurrent ticks_history calls
                // is exactly the burst Deriv's rate limiter punishes. The incumbent
                // is re-measured here on the SAME terms as every candidate (no
                // timing gate, proxy payouts) so the comparison is apples to
                // apples; the buy decision keeps using its own gated analysis.
                rows.push(await this.ntPairMarketRow({
                    symbol,
                    config,
                    familyDefinition,
                    legTypes,
                    currency,
                    proxyMultipliers,
                    liveTicks: symbol === incumbent ? liveTicks : null,
                }));
            }
            const ranked = rankHedgePairMarkets(rows, {
                currentSymbol: incumbent,
                isRecovery,
                evaluationsOnCurrent: market.evaluationsOnCurrent,
                evaluationsSinceSwitch: market.evaluationsSinceSwitch,
                switchEdgeDelta: limits.switchEdgeDelta,
                switchDwellEvaluations: limits.switchDwellEvaluations,
                switchCooldownEvaluations: limits.switchCooldownEvaluations,
            });
            const table = {
                family: config.family,
                incumbent,
                markets,
                atEvaluation: market.evaluations,
                at: Date.now(),
                best: ranked.best,
                rows: ranked.ranked,
                decision: ranked.decision,
            };
            this.nt_pair_rank_cache = table;
            this.ntPairLogFlow('rank', `Hedge Pair Forge RANK · ${config.family} · ${markets.length} markets · ` +
                ranked.ranked.slice(0, 5).map(row => `${row.symbol} ${((row.evidence?.score ?? 0) * 100).toFixed(1)}` +
                    `${row.analysable ? '' : ' (blocked)'}`).join(' · ') +
                ` · ${ranked.decision.reason}`, { minIntervalMs: 2000 });
            return table;
        }

        /**
         * Move the whole bot to another market between contracts.
         *
         * Reuses `Ticks.ntSwitchMarket` (the handshake Digit Forge proved: stop the
         * old tick monitor, clear `this.symbol`, `watchTicks(next)`, then repoint
         * options/tradeOptions and drop every cached proposal). Refuses while a
         * pair is live, being bought, or while the engine is purchasing — a
         * two-leg position must never be re-based mid-flight.
         */
        async ntPairSwitchMarket(nextSymbol, decision) {
            const from = String(this.symbol || '');
            const to = String(nextSymbol || '');
            if (!to || to === from) return false;
            if (this.nt_pair_active || this.is_purchasing || this.data?.contract?.status === 'open') {
                this.ntPairLogFlow('switch-refused', `Hedge Pair Forge SWITCH REFUSED · ${from} → ${to} · a pair is live or being prepared`, { kind: 'warn' });
                return false;
            }
            if (typeof this.ntSwitchMarket !== 'function') {
                this.ntPairLogFlow('switch-missing', `Hedge Pair Forge SWITCH UNAVAILABLE · ${from} → ${to} · this engine has no ntSwitchMarket; staying on ${from}`, { kind: 'warn' });
                return false;
            }
            let switched = false;
            try {
                switched = await this.ntSwitchMarket(to, 'Hedge Pair Forge') === true;
            } catch (error) {
                log('warn', `Hedge Pair Forge switch ${from} → ${to} failed · ${error?.message || 'unknown error'} · staying on ${from}`);
                return false;
            }
            if (!switched) {
                this.ntPairLogFlow('switch-failed', `Hedge Pair Forge SWITCH FAILED · ${from} → ${to} · staying on ${from}; the ranker will propose it again after the cooldown`, { kind: 'warn' });
                return false;
            }
            // Every cache below belongs to the market we just left. Keeping the
            // quote cache is how a bot buys a stale proposal for another symbol;
            // keeping the confirmation counter is how a switch inherits a
            // confirmation streak it never earned.
            this.nt_pair_confirmation = null;
            this.nt_pair_quote_cache?.clear?.();
            this.nt_pair_rank_cache = null;
            this.nt_pair_soft_hold_since = 0;
            this.nt_pair_last_analysis = null;
            const market = this.nt_pair_market;
            market.symbol = to;
            market.evaluationsOnCurrent = 0;
            market.evaluationsSinceSwitch = 0;
            market.switches += 1;
            market.lastSwitchFrom = from;
            market.lastSwitchReason = decision?.reason || '';
            log('info', `Hedge Pair Forge SWITCH · ${from} → ${to} · ${decision?.reason || 'better measured pair evidence'} · per-market caches cleared`);
            return true;
        }

        async ntHedgePairCycle(
            family,
            requestedDuration,
            upperOffset,
            lowerOffset,
            analysisWindow,
            minSamples,
            requiredEdge,
            recoveryMultiplier,
            maxRecoverySteps,
            markupPercent,
            maxStake,
            takeProfit,
            stopLoss,
            maxConsecutiveDoubleLosses,
            entryConfirmations,
            recoveryConfirmations,
            // Appended LAST so every already-generated XML — including the seven
            // committed fixtures, which pass fourteen positional arguments — keeps
            // calling this cycle with exactly the meaning it was built with.
            watchMarkets,
            forceEntryAfter,
        ) {
            if (this.nt_pair_busy || this.nt_pair_active || api_base.is_stopping || this.$scope?.stopped) return false;
            if (this.store?.getState?.().scope !== BEFORE_PURCHASE || this.is_purchasing) return false;
            if (!api_base.api || !this.$scope?.ticksService) {
                this.ntPairLogHold('Builder Deriv connection unavailable', 0);
                return false;
            }

            const seedSymbol = String(this.symbol || this.options?.symbol || this.tradeOptions?.symbol || '');
            let config;
            try {
                config = normalizePairConfig({
                    family,
                    symbol: seedSymbol,
                    requestedDuration,
                    upperOffset,
                    lowerOffset,
                    analysisWindow,
                    minSamples,
                    requiredEdge,
                    recoveryMultiplier,
                    maxRecoverySteps,
                    markupPercent,
                    maxStake,
                    takeProfit,
                    stopLoss,
                    maxConsecutiveDoubleLosses,
                    entryConfirmations,
                    recoveryConfirmations,
                    watchMarkets,
                    forceEntryAfter,
                });
            } catch (error) {
                this.ntPairLogHold(error?.message || 'invalid pair configuration', 0);
                return false;
            }
            this.nt_pair_config = config;

            const state = this.nt_pair_state ?? {
                sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0,
                completedPairs: 0, recoveryArmed: false, halted: false, haltReason: '',
            };
            this.nt_pair_state = state;
            if (state.halted) return false;
            if (Number(state.recoveryStep || 0) > config.maxRecoverySteps) {
                this.ntPairSetHalt(`recovery step cap ${config.maxRecoverySteps} exhausted`);
                return false;
            }

            this.nt_pair_busy = true;
            try {
                const symbol = String(this.symbol || this.options?.symbol || this.tradeOptions?.symbol || '');
                const currency = String(this.tradeOptions?.currency || api_base.account_info?.currency || '');
                const baseStake = Number(this.tradeOptions?.amount);
                const balance = Number(this.getBalance?.());
                if (!symbol || !/^[A-Z0-9_]{2,30}$/.test(symbol) || !/^[A-Za-z0-9]{2,20}$/.test(currency)) {
                    this.ntPairLogHold('symbol or account currency unavailable', 0);
                    return false;
                }
                if (!Number.isFinite(baseStake) || baseStake < 0.35 || baseStake > config.maxStake) {
                    this.ntPairLogHold('base stake is outside the account risk cap', 0);
                    return false;
                }
                if (!Number.isFinite(balance) || balance < 0.70) {
                    this.ntPairLogHold('balance unavailable or below two minimum stakes', 0);
                    return false;
                }

                const familyDefinition = HEDGE_PAIR_DEFINITIONS[config.family];
                const legTypes = familyDefinition.legs.map(leg => leg.type);
                const rawTicks = await this.$scope.ticksService.request({ symbol, retry_limit: 3 });
                const liveTicks = extractTicks(rawTicks).slice(-HEDGE_PAIR_ANALYSIS_LIMITS.maxTicks);
                const latestTick = liveTicks.at(-1);
                const latestEpoch = latestTick?.epoch;
                // Deep history, cached per symbol, joined with the live tail. The
                // Builder's ring alone cannot measure a minute-duration pair.
                const deep = await this.ntPairDeepTape(symbol, config.analysisWindow);
                const analysisTicks = mergeTapes(deep.ticks, liveTicks, config.analysisWindow);
                const tickSeconds = medianTickSeconds(liveTicks) || medianTickSeconds(analysisTicks) || 1;
                if (analysisTicks.length < 20) {
                    this.ntPairLogHold(deep.source === 'failed'
                        ? `collecting market ticks history (${analysisTicks.length} tick(s); deep history: ${deep.error || 'unavailable'})`
                        : 'collecting market ticks history', latestEpoch);
                    return false;
                }
                const prices = analysisTicks.map(tick => tick.quote);
                const epochs = analysisTicks.map(tick => tick.epoch);
                // Labelled per symbol: after a market switch the new market's tape
                // must be reported at once instead of inheriting the old market's
                // rate-limit window.
                this.ntPairLogFlow(`tape:${symbol}`, `Hedge Pair Forge TAPE · ${symbol} · ${analysisTicks.length} ticks analysed ` +
                    `(deep history ${deep.source === 'ticks_history' ? `${deep.ticks.length} ticks, ${Math.round(deep.age / 1000)}s old` : `unavailable · ${deep.error || deep.source}`}; ` +
                    `live ring ${liveTicks.length}) · tick cadence ${tickSeconds}s`, { minIntervalMs: 15000 });
                const pipSize = Number(this.$scope.ticksService.pipSizes?.[symbol] ?? api_base.pip_sizes?.[symbol]);
                if (!Number.isFinite(pipSize) || pipSize < 0) {
                    this.ntPairLogHold('symbol price precision unavailable', latestEpoch);
                    return false;
                }

                const contractsFor = ApiHelpers?.instance?.contracts_for;
                if (!contractsFor?.getContractsFor) {
                    this.ntPairLogHold('contracts_for metadata service unavailable', latestEpoch);
                    return false;
                }
                const availableContracts = await contractsFor.getContractsFor(symbol);
                if (!Array.isArray(availableContracts) || availableContracts.length === 0) {
                    this.ntPairLogHold('contracts_for returned no live contract metadata', latestEpoch);
                    return false;
                }
                const contractsA = availableContracts.filter(contract => String(contract?.contract_type ?? '').toUpperCase() === legTypes[0]);
                const contractsB = availableContracts.filter(contract => String(contract?.contract_type ?? '').toUpperCase() === legTypes[1]);
                const pairDuration = chooseCommonPairDuration(
                    contractsA,
                    legTypes[0],
                    contractsB,
                    legTypes[1],
                    config.requestedDuration,
                    tickSeconds,
                    familyDefinition.legs[0].barriers,
                    familyDefinition.legs[1].barriers,
                );
                if (!pairDuration) {
                    this.ntPairLogHold('no common duration in the two live contracts_for ranges', latestEpoch);
                    return false;
                }
                const duration = { amount: pairDuration.amount, unit: pairDuration.unit };
                const durationTicks = pairDuration.durationTicks;
                const analysisArgs = {
                    family: config.family,
                    prices,
                    epochs,
                    duration: durationTicks,
                    durationSeconds: duration.unit === 't' ? 0 : secondsForDuration(duration, tickSeconds),
                    pipSize,
                    upperOffset: config.upperOffset,
                    lowerOffset: config.lowerOffset,
                    minSamples: config.minSamples,
                    requiredEdge: config.requiredEdge,
                };
                const isRecovery = Boolean(state.recoveryArmed && Number(state.debt || 0) > 0);
                const mode = isRecovery ? 'recovery' : 'normal';
                const quoteStake = baseStake;
                const quoteBarrierA = barrierFields(config.family, 0, config.upperOffset, config.lowerOffset);
                const quoteBarrierB = barrierFields(config.family, 1, config.upperOffset, config.lowerOffset);
                this.nt_pair_quote_cache ??= new Map();
                const quoteCacheKey = [
                    symbol, config.family, `${duration.amount}${duration.unit}`, currency,
                    baseStake, config.upperOffset, config.lowerOffset,
                ].join(':');
                const cachedQuote = this.nt_pair_quote_cache.get(quoteCacheKey);
                let analysisMultipliers = cachedQuote && Date.now() - cachedQuote.at <= 10000
                    ? cachedQuote.multipliers
                    : null;
                if (!analysisMultipliers) {
                    const analysisQuotes = await Promise.all([
                        quotePairLeg({ symbol, currency, contractType: legTypes[0], duration, amount: quoteStake, barriers: quoteBarrierA }),
                        quotePairLeg({ symbol, currency, contractType: legTypes[1], duration, amount: quoteStake, barriers: quoteBarrierB }),
                    ]);
                    if (analysisQuotes.some(quote => !quote)) {
                        this.ntPairLogHold('one or both live proposals failed validation', latestEpoch);
                        return false;
                    }
                    analysisMultipliers = [analysisQuotes[0].multiplier, analysisQuotes[1].multiplier];
                    this.nt_pair_quote_cache.set(quoteCacheKey, { at: Date.now(), multipliers: analysisMultipliers });
                }

                let quotes = null;
                let analysis = analyseHedgePairTape({
                    ...analysisArgs,
                    multiplierA: analysisMultipliers[0],
                    multiplierB: analysisMultipliers[1],
                    mode,
                });
                analysis = { ...analysis, symbol, mode, tapeTicks: analysisTicks.length, tapeSource: deep.source };
                this.nt_pair_last_analysis = analysis;

                // ── Market-to-market ranking ────────────────────────────────────
                // Runs on the incumbent's LIVE payouts as the proxy for every
                // candidate (see ntPairMarketRow). A switch ends this cycle: the
                // next tick analyses the new market from a clean confirmation and
                // quote state, so no buy can ever be built from another symbol's
                // cached numbers.
                const rankTable = await this.ntPairEvaluateMarkets({
                    config,
                    familyDefinition,
                    legTypes,
                    currency,
                    incumbent: symbol,
                    liveTicks,
                    proxyMultipliers: analysisMultipliers,
                    isRecovery,
                });
                if (rankTable?.decision?.switch && rankTable?.best?.symbol) {
                    const switched = await this.ntPairSwitchMarket(rankTable.best.symbol, rankTable.decision);
                    if (switched) return false;
                }

                // ── Patience valve ──────────────────────────────────────────────
                // SOFT blockers only (expected value below the hurdle) can be
                // overridden after `forceEntryAfter` seconds of continuous holding;
                // HARD blockers (too few samples, no repayment path, unstable
                // estimate, timing) never can. Off by default: the bot would rather
                // explain itself forever than buy a negative-EV pair on a timer.
                // Recovery is exempt — forcing a debt-sized pair into the market is
                // how a ladder becomes a liquidation.
                const hardBlockers = analysis.hardBlockers ?? [];
                const softBlockers = analysis.softBlockers ?? [];
                const softOnly = hardBlockers.length === 0 && softBlockers.length > 0;
                if (softOnly && !isRecovery) {
                    if (!this.nt_pair_soft_hold_since) this.nt_pair_soft_hold_since = Date.now();
                } else {
                    this.nt_pair_soft_hold_since = 0;
                }
                const patienceMs = Number(config.forceEntryAfter || 0) * 1000;
                const patienceExpired = patienceMs > 0 && softOnly &&
                    this.nt_pair_soft_hold_since > 0 && Date.now() - this.nt_pair_soft_hold_since >= patienceMs;

                this.ntPairLogFlow(`analysing:${symbol}`, `Hedge Pair Forge ANALYSING · ${familyDefinition.label} · ${symbol} · ` +
                    `${duration.amount}${duration.unit} (${durationTicks} observed tick(s)) · ${mode} · ` +
                    `${analysis.samples} paired samples${analysis.lowConfidence ? ` (floor ${analysis.samplesRequired}, reachable ${analysis.samplesReachable})` : ''} · ` +
                    `both-win ${analysis.stateCounts.bothWin} · A-only ${analysis.stateCounts.onlyA} · B-only ${analysis.stateCounts.onlyB} · ` +
                    `both-lost ${analysis.stateCounts.bothLose} (${analysis.samples ? ((analysis.stateCounts.bothLose / analysis.samples) * 100).toFixed(1) : '0.0'}%) · ` +
                    `repayment ${((pairEvidenceScore(analysis).repaymentRate) * 100).toFixed(1)}% · ` +
                    `EV ${percent(analysis.expectedEdge)} vs hurdle ${percent(analysis.edgeHurdle)} · LCB ${percent(analysis.lowerBound)} · ` +
                    `instability ${(analysis.instability * 100).toFixed(2)}pt · timing ${analysis.timingScore}/100 (${analysis.timingContext || 'n/a'}) · ` +
                    `live legs ${Number(analysis.multiplierA).toFixed(2)}× / ${Number(analysis.multiplierB).toFixed(2)}× · ` +
                    `${analysis.eligible ? 'QUALIFIED' : patienceExpired ? 'FORCED BY PATIENCE VALVE' : 'holding'}`);

                if (!analysis.eligible && !patienceExpired) {
                    this.nt_pair_confirmation = null;
                    this.ntPairLogHold(analysis.reason, latestEpoch);
                    return false;
                }
                if (patienceExpired) {
                    state.lastForcedEntry = true;
                    this.ntPairLogFlow('patience', `Hedge Pair Forge PATIENCE VALVE · ${Math.round((Date.now() - this.nt_pair_soft_hold_since) / 1000)}s of soft-blocked holding ` +
                        `reached the configured ${config.forceEntryAfter}s limit · entering anyway on ${symbol} · ${softBlockers.join('; ')}`, { kind: 'warn', minIntervalMs: 15000 });
                } else if (state.lastForcedEntry) {
                    state.lastForcedEntry = false;
                }

                const confirmationKey = `${symbol}:${config.family}:${duration.amount}${duration.unit}`;
                const requiredConfirmations = isRecovery
                    ? config.recoveryConfirmations
                    : config.entryConfirmations;
                const prior = this.nt_pair_confirmation;
                let confirmations = 1;
                if (prior?.key === confirmationKey) {
                    if (Number(prior.epoch) === latestEpoch) {
                        confirmations = Number(prior.count);
                    } else if (latestEpoch > Number(prior.epoch)) {
                        confirmations = Number(prior.count) + 1;
                    } else {
                        this.nt_pair_confirmation = null;
                        this.ntPairLogHold('tick history moved backwards; waiting for a fresh market tick', latestEpoch);
                        return false;
                    }
                }
                if (!prior || prior.key !== confirmationKey || latestEpoch > Number(prior.epoch)) {
                    this.nt_pair_confirmation = { key: confirmationKey, epoch: latestEpoch, count: confirmations };
                }
                if (confirmations < requiredConfirmations) {
                    this.ntPairLogHold(`${mode} timing confirmation ${confirmations}/${requiredConfirmations}`, latestEpoch);
                    return false;
                }

                let stakePerLeg = baseStake;
                let recoveryPlan = null;
                if (isRecovery) {
                    if (Number(state.recoveryStep || 0) < 1 || Number(state.recoveryStep || 0) > config.maxRecoverySteps) {
                        this.ntPairSetHalt('recovery step is outside the configured ladder');
                        return false;
                    }
                    recoveryPlan = sizePairRecovery({
                        debt: state.debt,
                        // Sizing is driven by the LIVE payouts, never by the ladder
                        // alone: `winMultiplier` is the poorer leg, so the plan
                        // never assumes the better one pays.
                        winMultiplier: Math.min(Number(analysis.multiplierA), Number(analysis.multiplierB)),
                        multiplierA: analysis.multiplierA,
                        multiplierB: analysis.multiplierB,
                        lowerBoundPerCombinedStake: analysis.lowerBound,
                        baseStake,
                        multiplier: config.recoveryMultiplier,
                        step: state.recoveryStep,
                        markupPercent: config.markupPercent,
                        maxStake: config.maxStake,
                        availableBalance: balance,
                    });
                    if (!recoveryPlan) {
                        const target = Number(state.debt || 0) * (1 + Number(config.markupPercent || 0) / 100);
                        this.ntPairLogHold(`recovery cannot be sized · debt ${money(state.debt)} · target with this bot's ` +
                            `${config.markupPercent}% markup ${money(target)} · live legs ${Number(analysis.multiplierA).toFixed(2)}× / ` +
                            `${Number(analysis.multiplierB).toFixed(2)}× · a winning leg must pay more than 1.00× its stake to repay anything · ` +
                            `balance ${money(balance)} · max stake ${money(config.maxStake)}`, latestEpoch);
                        return false;
                    }
                    if (!recoveryPlan.repayableByPairWin) {
                        // m ≤ 2 means one winning leg cannot cover BOTH premiums, so
                        // the ~80 % outcome (a split) would leave the debt exactly
                        // where it was after risking two more premiums. Refusing is
                        // the only honest move; the ranker keeps looking for a
                        // market whose legs pay better.
                        this.ntPairLogHold(`recovery refused · live legs pay ${recoveryPlan.winMultiplier.toFixed(2)}×, and a split win would net ` +
                            `${money(recoveryPlan.projectedNetOnPairWin)} on ${money(recoveryPlan.pairStake)} of pair stake · the winning leg must pay ` +
                            `above 2.00× before a pair can repay debt ${money(state.debt)}`, latestEpoch);
                        return false;
                    }
                    stakePerLeg = recoveryPlan.stakePerLeg;
                    // Recovery-rotation guard (doc §5): remember the payout this
                    // ladder was sized against so a later market change can be
                    // reported as the cost it is, not absorbed silently.
                    const priorReference = Number(state.recoveryReferenceMultiplier || 0);
                    if (priorReference > 0 && recoveryPlan.winMultiplier < priorReference - 1e-9) {
                        this.ntPairLogFlow('rotation-cost', `Hedge Pair Forge RECOVERY ROTATION COST · ${symbol} legs pay ` +
                            `${recoveryPlan.winMultiplier.toFixed(2)}× against ${priorReference.toFixed(2)}× when this ladder started · the same debt ` +
                            `${money(state.debt)} now needs ${money(stakePerLeg)}/leg instead of ` +
                            `${money(Number(state.debt) * (1 + Number(config.markupPercent || 0) / 100) / (priorReference - 1))}/leg`, { kind: 'warn', force: true });
                    }
                    state.recoveryReferenceMultiplier = recoveryPlan.winMultiplier;
                    this.ntPairLogFlow('recovery', `Hedge Pair Forge RECOVERY · ${symbol} · debt ${money(recoveryPlan.debt)} × (1 + ${recoveryPlan.markupPercent}% markup) = ` +
                        `target ${money(recoveryPlan.targetDebt)} ÷ (${recoveryPlan.winMultiplier.toFixed(2)} − 1) = ${money(recoveryPlan.exactPerLeg)}/leg → ` +
                        `staking ${money(recoveryPlan.stakePerLeg)} each (${money(recoveryPlan.pairStake)} at risk, ladder ceiling ${money(recoveryPlan.ladderCap)} step ${state.recoveryStep}` +
                        `${recoveryPlan.capBinding === 'none' ? '' : `, clamped by ${recoveryPlan.capBinding}`}) · a split win nets ` +
                        `${money(recoveryPlan.projectedNetOnPairWin)} and leaves ${money(recoveryPlan.residualDebtAfterWin)} · recovery stays armed until the debt is 0`, { force: true });
                }
                if (
                    stakePerLeg < 0.35 || stakePerLeg > config.maxStake ||
                    stakePerLeg * 2 > balance + BALANCE_EPSILON
                ) {
                    this.ntPairLogHold('two-leg stake exceeds min, max-stake or current-balance limits', latestEpoch);
                    return false;
                }

                // Always obtain two single-use, final-stake proposals immediately
                // before buying. Cached quotes above are analysis inputs only.
                // Recovery payouts can change with stake size, so re-size against
                // each final quote pair and fail closed if the live sizing does
                // not stabilize within two upward adjustments.
                let recoveryQuoteAdjustments = 0;
                while (true) {
                    quotes = await Promise.all([
                        quotePairLeg({ symbol, currency, contractType: legTypes[0], duration, amount: stakePerLeg, barriers: quoteBarrierA }),
                        quotePairLeg({ symbol, currency, contractType: legTypes[1], duration, amount: stakePerLeg, barriers: quoteBarrierB }),
                    ]);
                    if (quotes.some(quote => !quote)) {
                        this.ntPairLogHold('final-stake proposal validation failed', latestEpoch);
                        return false;
                    }
                    analysis = analyseHedgePairTape({
                        ...analysisArgs,
                        multiplierA: quotes[0].multiplier,
                        multiplierB: quotes[1].multiplier,
                        mode,
                    });
                    analysis = { ...analysis, symbol, mode, tapeTicks: analysisTicks.length, tapeSource: deep.source, finalQuote: true };
                    this.nt_pair_last_analysis = analysis;
                    if (!analysis.eligible && !patienceExpired) {
                        this.nt_pair_confirmation = null;
                        this.ntPairLogHold(`final live payouts no longer qualify · ${analysis.reason}`, latestEpoch);
                        return false;
                    }
                    if (!isRecovery) break;

                    const finalSizing = sizePairRecovery({
                        debt: state.debt,
                        winMultiplier: Math.min(Number(quotes[0].multiplier), Number(quotes[1].multiplier)),
                        multiplierA: quotes[0].multiplier,
                        multiplierB: quotes[1].multiplier,
                        lowerBoundPerCombinedStake: analysis.lowerBound,
                        baseStake,
                        multiplier: config.recoveryMultiplier,
                        step: state.recoveryStep,
                        markupPercent: config.markupPercent,
                        maxStake: config.maxStake,
                        availableBalance: balance,
                    });
                    if (!finalSizing) {
                        this.ntPairLogHold(`final live payouts cannot size recovery · legs ${Number(quotes[0].multiplier).toFixed(2)}× / ` +
                            `${Number(quotes[1].multiplier).toFixed(2)}× · debt ${money(state.debt)} · balance ${money(balance)}`, latestEpoch);
                        return false;
                    }
                    if (!finalSizing.repayableByPairWin) {
                        this.ntPairLogHold(`final live payouts pay ${finalSizing.winMultiplier.toFixed(2)}× · a split win would net ` +
                            `${money(finalSizing.projectedNetOnPairWin)}, so debt ${money(state.debt)} cannot shrink · waiting for legs above 2.00×`, latestEpoch);
                        return false;
                    }
                    recoveryPlan = finalSizing;
                    // The ladder is bought at THIS payout, so the rotation guard
                    // must remember it rather than the cached analysis quote that
                    // produced the first estimate.
                    state.recoveryReferenceMultiplier = finalSizing.winMultiplier;
                    if (finalSizing.stakePerLeg <= stakePerLeg + BALANCE_EPSILON) break;
                    if (recoveryQuoteAdjustments >= 2) {
                        this.ntPairLogHold('recovery size did not stabilize against final live proposal payouts', latestEpoch);
                        return false;
                    }
                    stakePerLeg = finalSizing.stakePerLeg;
                    if (stakePerLeg > config.maxStake || stakePerLeg * 2 > balance + BALANCE_EPSILON) {
                        this.ntPairLogHold('final recovery pair stake exceeds live balance or configured caps', latestEpoch);
                        return false;
                    }
                    recoveryQuoteAdjustments += 1;
                }

                if (api_base.is_stopping || this.$scope?.stopped || this.store?.getState?.().scope !== BEFORE_PURCHASE) return false;
                if (quotes.some(quote => Date.now() - quote.quotedAt > QUOTE_TTL_MS)) {
                    this.ntPairLogHold('final live proposal expired; requesting a fresh pair next tick', latestEpoch);
                    return false;
                }

                this.nt_pair_confirmation = null;
                const pairId = `hp-${Date.now()}-${++this.nt_pair_pair_serial}`;
                const pair = {
                    id: pairId,
                    family: config.family,
                    symbol,
                    mode,
                    partial: false,
                    expectedLegs: 2,
                    duration,
                    durationTicks,
                    stakePerLeg,
                    analysis,
                    latestEpoch,
                    openedAt: Date.now(),
                    legs: [],
                    settlements: new Map(),
                    subscription: null,
                    subscriptionIds: new Set(),
                    streamRequested: new Set(),
                    pollTimer: null,
                    polling: false,
                    finalized: false,
                    config,
                    /** The debt-driven sizing this pair was bought with, or null in normal mode. */
                    recovery: isRecovery ? recoveryPlan : null,
                    /** True only when the patience valve overrode a soft blocker. */
                    forcedEntry: Boolean(patienceExpired),
                    /** Multi-market ranking snapshot at entry time (null = one market watched). */
                    rank: rankTable ? { best: rankTable.best?.symbol ?? '', decision: rankTable.decision?.reason ?? '', markets: rankTable.markets } : null,
                };
                // Reserve the pair before writing to the socket. If Run is stopped
                // while the two buy responses are pending, stop() must wait for
                // reconciliation rather than tear down the settlement listener.
                this.nt_pair_active = pair;
                const buyResults = await buyPairQuotesConcurrently(quotes);
                const fills = [];
                for (let index = 0; index < buyResults.length; index += 1) {
                    const result = buyResults[index];
                    if (result.status !== 'fulfilled' || result.value?.error) continue;
                    const buy = result.value?.buy;
                    const contractId = buy?.contract_id;
                    const actualStake = Number(buy?.buy_price);
                    if ((typeof contractId !== 'string' && typeof contractId !== 'number') || !String(contractId).trim() || !Number.isFinite(actualStake) || actualStake <= 0) continue;
                    fills.push({
                        index,
                        contractType: legTypes[index],
                        barrier: index === 0 ? quoteBarrierA : quoteBarrierB,
                        contractId: String(contractId),
                        buy,
                        quote: quotes[index],
                        stake: roundMoney(actualStake),
                        outcome: null,
                        profit: null,
                    });
                    contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                    try { this.updateAndReturnTotalRuns?.(); } catch (_) { /* trade monitor remains authoritative */ }
                }
                pair.legs = fills;
                pair.partial = fills.length !== 2;
                pair.expectedLegs = fills.length;

                if (fills.length === 0) {
                    this.nt_pair_active = null;
                    this.ntPairSetHalt('buy response was missing or ambiguous; inspect Deriv portfolio before restarting');
                    log('error', 'Hedge Pair Forge halted · neither buy returned a verifiable contract id; no retry was sent because execution may be ambiguous');
                    this.ntPairReleaseLoop(pair, false);
                    return false;
                }

                if (fills.length === 1) {
                    this.nt_pair_state.halted = true;
                    this.nt_pair_state.haltReason = 'partial pair fill; remaining leg was not confirmed';
                    log('error', 'Hedge Pair Forge PARTIAL FILL · one contract was confirmed. New entries are halted; attempting to close the exposed leg and monitoring it to settlement.');
                    try {
                        const compensation = await api_base.api.send({ sell: fills[0].contractId, price: 0 });
                        if (compensation?.error) log('warn', `Partial-fill close not accepted · ${compensation.error.message || compensation.error.code || 'Deriv rejected sell'}; exposure remains monitored`);
                        else log('info', 'Partial-fill compensation sell requested; exposure remains monitored until the contract is confirmed settled.');
                    } catch (_) {
                        log('warn', 'Partial-fill compensation could not be confirmed; exposure remains monitored until settlement.');
                    }
                }

                this.store?.dispatch?.(purchaseSuccessful());
                if (this.store?.getState?.().scope === BEFORE_PURCHASE) {
                    this.store.dispatch({ type: PURCHASE_SUCCESSFUL });
                }
                this.ntPairStartMonitoring(pair);
                // The capital-at-risk sentence is printed on every entry, not only
                // in recovery: a pair spends TWO premiums, and an owner reading the
                // journal should never have to multiply by two in their head.
                log('info', `Hedge Pair Forge ${fills.length === 2 ? 'PAIR LIVE' : 'PARTIAL EXPOSURE'} · ${familyDefinition.label} · ${symbol} · ` +
                    `${money(stakePerLeg)} each = ${money(stakePerLeg * fills.length)} at risk · ${duration.amount}${duration.unit} (${durationTicks} observed tick(s)) · ${mode} · ` +
                    `EV ${percent(analysis.expectedEdge)} · LCB ${percent(analysis.lowerBound)} · ${analysis.samples} samples · ` +
                    `repayment ${((analysis.stateCounts.bothWin + analysis.stateCounts.onlyA + analysis.stateCounts.onlyB) / Math.max(1, analysis.samples) * 100).toFixed(1)}% · ` +
                    `both-lost ${(analysis.stateCounts.bothLose / Math.max(1, analysis.samples) * 100).toFixed(1)}% · legs ${Number(quotes[0].multiplier).toFixed(2)}× / ${Number(quotes[1].multiplier).toFixed(2)}×` +
                    `${patienceExpired ? ' · ENTERED VIA PATIENCE VALVE (negative measured EV)' : ''}` +
                    `${rankTable ? ` · best of ${rankTable.markets.length} markets` : ''} · paired buys are non-atomic`);
                if (isRecovery && recoveryPlan) {
                    log('warn', `Hedge Pair Forge RECOVERY EXPOSURE · debt ${money(recoveryPlan.debt)} · this pair risks ${money(recoveryPlan.pairStake)} ` +
                        `(2 × ${money(recoveryPlan.stakePerLeg)}) to win ${money(recoveryPlan.projectedNetOnPairWin)} on a split · ` +
                        `${recoveryPlan.repayableByPairWin ? `a win leaves ${money(recoveryPlan.residualDebtAfterWin)} still owed` : 'a win cannot repay it'} · ` +
                        `a double loss would take the debt to ${money(Number(recoveryPlan.debt) + Number(recoveryPlan.pairStake))}`);
                }
                return true;
            } catch (error) {
                this.ntPairLogHold(error?.message || 'pair cycle failed safely', 0);
                return false;
            } finally {
                this.nt_pair_busy = false;
            }
        }

        ntPairStartMonitoring(pair) {
            if (!pair || !api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data?.msg_type === 'proposal_open_contract') {
                    this.ntPairHandleContract(pair, data.proposal_open_contract);
                }
            });
            pair.subscription = subscription;
            api_base.pushSubscription(subscription);

            const poll = async () => {
                if (pair.finalized || this.nt_pair_active !== pair || pair.polling) return;
                pair.polling = true;
                try {
                    await Promise.all(pair.legs.map(async leg => {
                    if (pair.settlements.has(leg.contractId)) return;
                    const firstRequest = !pair.streamRequested.has(leg.contractId);
                    if (firstRequest) pair.streamRequested.add(leg.contractId);
                    try {
                        const request = { proposal_open_contract: 1, contract_id: leg.contractId, ...(firstRequest ? { subscribe: 1 } : {}) };
                        const response = await api_base.api.send(request);
                        if (response?.error) {
                            if (firstRequest) pair.streamRequested.delete(leg.contractId);
                            log('warn', `Hedge-pair settlement monitor retry · ${response.error.message || response.error.code || 'open-contract request failed'}`);
                            return;
                        }
                        const subId = response?.subscription?.id;
                        if (subId) pair.subscriptionIds.add(String(subId));
                        if (response?.proposal_open_contract) this.ntPairHandleContract(pair, response.proposal_open_contract);
                    } catch (_) {
                        if (firstRequest) pair.streamRequested.delete(leg.contractId);
                        log('warn', 'Hedge-pair settlement stream unavailable; retaining the open exposure and retrying status polling.');
                    }
                    }));
                } finally {
                    pair.polling = false;
                }
            };
            poll();
            pair.pollTimer = setInterval(poll, 1500);
            if (typeof pair.pollTimer?.unref === 'function') pair.pollTimer.unref();
        }

        ntPairHandleContract(pair, contract) {
            if (!pair || pair.finalized || !contract) return;
            const id = String(contract.contract_id ?? '');
            const leg = pair.legs.find(item => item.contractId === id);
            if (!leg) return;
            try { broadcastContract({ accountID: api_base.account_info?.loginid, ...contract }); } catch (_) { /* journalling must not break settlement */ }
            this.store?.dispatch?.(openContractReceived());
            this.store?.dispatch?.({ type: NEW_TICK, payload: { pair: pair.id, contract: id, at: Date.now() } });
            if (!isSettledContract(contract) || pair.settlements.has(id)) return;

            const profit = contractProfit(contract);
            if (!Number.isFinite(profit)) {
                pair.unknownSettlement = true;
                pair.settlements.set(id, { contract, contractId: id, profit: null, stake: leg.stake, outcome: 'unknown' });
                leg.profit = null;
                leg.outcome = 'unknown';
                leg.settledContract = contract;
                this.ntPairSetHalt(`settlement for contract ${id} has no verifiable realized P&L`);
                log('error', `Hedge Pair Forge · contract ${id} is closed but its realized P&L is missing; no recovery will be armed and account reconciliation is required`);
                if (pair.settlements.size >= pair.legs.length) this.ntPairFinalize(pair);
                return;
            }
            const settlement = {
                contract,
                contractId: id,
                profit,
                stake: Number(contract.buy_price) || leg.stake,
                outcome: contractOutcome(contract, profit),
            };
            pair.settlements.set(id, settlement);
            leg.profit = profit;
            leg.outcome = settlement.outcome;
            leg.settledContract = contract;
            try { this.updateTotals?.(contract); } catch (error) {
                log('warn', `Builder trade totals did not update cleanly · ${error?.message || 'unknown accounting error'}`);
            }
            log(profit >= 0 ? 'success' : 'warn', `Hedge leg settled · ${leg.contractType} · ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} ${contract.currency || this.tradeOptions?.currency || ''}`);
            if (pair.settlements.size >= pair.legs.length) this.ntPairFinalize(pair);
        }

        ntPairFinalize(pair) {
            if (!pair || pair.finalized || this.nt_pair_active !== pair) return;
            pair.finalized = true;
            clearInterval(pair.pollTimer);
            try { pair.subscription?.unsubscribe?.(); } catch (_) { /* best effort */ }
            for (const id of pair.subscriptionIds) {
                try { api_base.api?.send({ forget: id }); } catch (_) { /* best effort */ }
            }

            const settledLegs = pair.legs.map(leg => ({
                profit: leg.profit,
                outcome: leg.outcome,
                stake: Number(leg.settledContract?.buy_price) || leg.stake,
            }));
            if (pair.partial || pair.unknownSettlement || pair.legs.length !== 2 || settledLegs.length !== 2) {
                const knownProfit = settledLegs.reduce((sum, leg) =>
                    sum + (leg.profit !== null && leg.profit !== undefined && Number.isFinite(Number(leg.profit)) ? Number(leg.profit) : 0),
                    0,
                );
                this.nt_pair_state.sessionProfit = roundMoney(Number(this.sessionProfit || this.nt_pair_state.sessionProfit || 0));
                this.nt_pair_state.lastPairNetProfit = roundMoney(knownProfit);
                this.nt_pair_state.lastPairOutcome = pair.unknownSettlement ? 'settlement-unknown; manual reconciliation; no recovery trigger' : 'partial-fill; no recovery trigger';
                this.nt_pair_state.halted = true;
                this.nt_pair_state.haltReason = pair.unknownSettlement
                    ? 'settlement P&L was not verifiable; manual account reconciliation required'
                    : 'partial pair fill; actual exposed-leg P&L recorded, manual review required';
                if (pair.partial || pair.legs.length !== 2) {
                    this.nt_pair_state.completedPairs = Number(this.nt_pair_state.completedPairs || 0) + 1;
                }
                log('error', pair.unknownSettlement
                    ? `Hedge Pair Forge SETTLEMENT UNKNOWN · known leg P&L ${knownProfit >= 0 ? '+' : ''}${knownProfit.toFixed(2)} · no recovery debt armed · inspect account history`
                    : `Hedge Pair Forge PARTIAL SETTLEMENT · ${knownProfit >= 0 ? '+' : ''}${knownProfit.toFixed(2)} realized · no recovery debt was armed · manual review required`);
            } else {
                const result = applyPairSettlement(this.nt_pair_state, settledLegs, {
                    markupPercent: pair.config.markupPercent,
                    maxConsecutiveDoubleLosses: pair.config.maxConsecutiveDoubleLosses,
                });
                this.nt_pair_state = result.state;
                this.nt_pair_state.sessionProfit = roundMoney(Number(this.sessionProfit || result.state.sessionProfit));
                if (result.bothLost) {
                    log('error', `PAIR DOUBLE LOSS · ${result.totalStake.toFixed(2)} total stake added to recovery debt · debt ${Number(this.nt_pair_state.debt).toFixed(2)} · recovery ${this.nt_pair_state.recoveryArmed ? 'armed' : 'blocked'} · step ${Number(this.nt_pair_state.recoveryStep || 0)}/${this.nt_pair_config?.maxRecoverySteps ?? 0} · consecutive double losses ${Number(this.nt_pair_state.doubleLossRun || 0)}`);
                } else if (result.split) {
                    // The re-arm fix, made visible: a split does not TRIGGER
                    // recovery, but it no longer disarms an existing debt either.
                    const debt = Number(this.nt_pair_state.debt || 0);
                    log(result.netProfit < 0 ? 'warn' : 'info', `PAIR SPLIT · aggregate P&L ${result.netProfit >= 0 ? '+' : ''}${result.netProfit.toFixed(2)} · no new recovery trigger` +
                        (debt > 0
                            ? ` · debt ${debt.toFixed(2)} remains and recovery STAYS ARMED (target ${Number(this.nt_pair_state.recoveryTarget || 0).toFixed(2)} at this bot's ${this.nt_pair_config?.markupPercent ?? 0}% markup) · the next pair is sized against the residual`
                            : ' · no debt outstanding'));
                } else {
                    const debt = Number(this.nt_pair_state.debt || 0);
                    log('success', `PAIR SETTLED · ${result.bothWon ? 'both legs won' : 'no double loss'} · aggregate P&L ${result.netProfit >= 0 ? '+' : ''}${result.netProfit.toFixed(2)} · debt ${debt.toFixed(2)}` +
                        (debt > 0 ? ` · recovery stays armed until it reaches 0` : ' · recovery complete'));
                }
                if (Number(this.nt_pair_state.recoveryStep || 0) > pair.config.maxRecoverySteps) {
                    this.nt_pair_state.halted = true;
                    this.nt_pair_state.haltReason = `recovery step cap ${pair.config.maxRecoverySteps} exhausted`;
                }
                if (Number(this.nt_pair_state.sessionProfit) >= pair.config.takeProfit) {
                    this.nt_pair_state.halted = true;
                    this.nt_pair_state.haltReason = `session take-profit ${pair.config.takeProfit.toFixed(2)} reached`;
                }
                if (Number(this.nt_pair_state.sessionProfit) <= -pair.config.stopLoss) {
                    this.nt_pair_state.halted = true;
                    this.nt_pair_state.haltReason = `session stop-loss ${pair.config.stopLoss.toFixed(2)} reached`;
                }
                if (this.nt_pair_state.halted) log('error', `Hedge Pair Forge safety stop · ${this.nt_pair_state.haltReason}`);
            }

            this.nt_pair_active = null;
            this.nt_pair_confirmation = null;
            if (this.store?.getState?.().scope === DURING_PURCHASE) this.store.dispatch(sell());
            contractStatus({
                id: 'contract.sold',
                data: pair.legs.map(leg => leg.settledContract?.transaction_ids?.sell).filter(Boolean),
                pair,
            });
        }

        ntPairReleaseLoop(pair, hadFill) {
            if (this.store?.getState?.().scope === BEFORE_PURCHASE) {
                if (hadFill) this.store.dispatch(purchaseSuccessful());
                else this.store.dispatch({ type: PURCHASE_SUCCESSFUL });
            }
            // Let the interpreter leave watch('before') and attach to
            // watch('during') before moving the store to STOP; immediate
            // BUY→SELL dispatches can otherwise strand its before-scope waiter.
            setTimeout(() => {
                if (this.store?.getState?.().scope === DURING_PURCHASE) this.store.dispatch(sell());
                contractStatus({ id: 'contract.sold', data: pair?.id || 'no-pair-fill', pair });
            }, 0);
        }
    };
