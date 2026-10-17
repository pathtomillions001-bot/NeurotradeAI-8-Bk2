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
    sizePairRecovery,
} from './hedge-pair-analysis';

const QUOTE_TIMEOUT_MS = 5000;
const QUOTE_TTL_MS = 5000;
const BALANCE_EPSILON = 1e-8;
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
    isSettledContract,
    medianTickSeconds,
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
            };
            this.nt_pair_busy = false;
            this.nt_pair_active = null;
            this.nt_pair_confirmation = null;
            this.nt_pair_quote_cache = new Map();
            this.nt_pair_last_log = '';
            this.nt_pair_log_epoch = 0;
            this.nt_pair_pair_serial = 0;
            return super.init(...args);
        }

        ntHedgePairStatus(field = 'continue') {
            const state = this.nt_pair_state;
            const key = String(field || 'continue').toLowerCase();
            if (key === 'continue' || key === 'eligible') return Boolean(state && !state.halted);
            if (!state) return key === 'debt' || key === 'profit' || key === 'step' ? 0 : '';
            if (key === 'debt') return Number(state.debt || 0);
            if (key === 'profit') return Number(state.sessionProfit || 0);
            if (key === 'step') return Number(state.recoveryStep || 0);
            if (key === 'reason') return state.haltReason || '';
            if (key === 'pairs') return Number(state.completedPairs || 0);
            if (key === 'recovery armed') return Boolean(state.recoveryArmed);
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
            const lastEpoch = Number(epoch) || 0;
            const changed = message !== this.nt_pair_last_log;
            const periodic = lastEpoch > 0 && lastEpoch - this.nt_pair_log_epoch >= 10;
            if (changed || periodic) {
                log('info', message);
                this.nt_pair_last_log = message;
                this.nt_pair_log_epoch = lastEpoch;
            }
        }

        ntPairLogAnalysis({ analysis, symbol, mode, epoch, confirmationCount, confirmationRequired }) {
            if (!analysis) return;
            const decision = analysis.eligible ? 'QUALIFIED' : 'HOLD';
            const signature = [symbol, mode, decision, analysis.reason].join('|');
            if (signature === this.nt_pair_last_analysis_signature) return;
            this.nt_pair_last_analysis_signature = signature;
            const lower = Number(analysis.lowerBound);
            const mean = Number(analysis.expectedEdge);
            log(analysis.eligible ? 'success' : 'info',
                `Hedge Pair Forge ANALYSIS ${decision} · ${symbol} · ${mode} · ${analysis.family || this.nt_pair_config?.family || 'pair'} · ` +
                `${analysis.samples ?? 0} paired samples (${analysis.contextSamples ?? 0} current-context) · ` +
                `joint EV ${Number.isFinite(mean) ? `${(mean * 100).toFixed(2)}%` : 'n/a'} · ` +
                `95% LCB ${Number.isFinite(lower) ? `${(lower * 100).toFixed(2)}%` : 'n/a'} · ` +
                `timing ${analysis.timingScore ?? 'n/a'}/100 · confirmations ${confirmationCount ?? 0}/${confirmationRequired ?? 0} · ` +
                `reason: ${analysis.reason || 'not provided'}`);
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
        ) {
            if (this.nt_pair_busy || this.nt_pair_active || api_base.is_stopping || this.$scope?.stopped) return false;
            if (this.store?.getState?.().scope !== BEFORE_PURCHASE || this.is_purchasing) return false;
            if (!api_base.api || !this.$scope?.ticksService) {
                this.ntPairLogHold('Builder Deriv connection unavailable', 0);
                return false;
            }

            let config;
            try {
                config = normalizePairConfig({
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
                const ticks = extractTicks(rawTicks).slice(-HEDGE_PAIR_ANALYSIS_LIMITS.maxTicks);
                const latestTick = ticks.at(-1);
                const latestEpoch = latestTick?.epoch;
                const tickSeconds = medianTickSeconds(ticks) || 1;
                const analysisTicks = ticks.slice(-config.analysisWindow);
                if (analysisTicks.length < 20) {
                    this.ntPairLogHold('collecting market ticks history', latestEpoch);
                    return false;
                }
                const prices = analysisTicks.map(tick => tick.quote);
                const epochs = analysisTicks.map(tick => tick.epoch);
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
                if (!analysis.eligible) {
                    this.ntPairLogAnalysis({ analysis, symbol, mode, epoch: latestEpoch });
                    this.nt_pair_confirmation = null;
                    this.ntPairLogHold(analysis.reason, latestEpoch);
                    return false;
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
                this.ntPairLogAnalysis({
                    analysis, symbol, mode, epoch: latestEpoch,
                    confirmationCount: confirmations,
                    confirmationRequired: requiredConfirmations,
                });
                if (confirmations < requiredConfirmations) {
                    this.ntPairLogHold(`${mode} timing confirmation ${confirmations}/${requiredConfirmations}`, latestEpoch);
                    return false;
                }

                let stakePerLeg = baseStake;
                if (isRecovery) {
                    if (Number(state.recoveryStep || 0) < 1 || Number(state.recoveryStep || 0) > config.maxRecoverySteps) {
                        this.ntPairSetHalt('recovery step is outside the configured ladder');
                        return false;
                    }
                    const recovery = sizePairRecovery({
                        debt: state.debt,
                        lowerBoundPerCombinedStake: analysis.lowerBound,
                        baseStake,
                        multiplier: config.recoveryMultiplier,
                        step: state.recoveryStep,
                        markupPercent: config.markupPercent,
                        maxStake: config.maxStake,
                        availableBalance: balance,
                    });
                    if (!recovery) {
                        this.ntPairLogHold('recovery has no positive joint-edge sizing within balance and caps', latestEpoch);
                        return false;
                    }
                    stakePerLeg = recovery.stakePerLeg;
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
                    if (!analysis.eligible) {
                        this.nt_pair_confirmation = null;
                        this.ntPairLogHold(`final live payouts no longer qualify · ${analysis.reason}`, latestEpoch);
                        return false;
                    }
                    if (!isRecovery) break;

                    const finalSizing = sizePairRecovery({
                        debt: state.debt,
                        lowerBoundPerCombinedStake: analysis.lowerBound,
                        baseStake,
                        multiplier: config.recoveryMultiplier,
                        step: state.recoveryStep,
                        markupPercent: config.markupPercent,
                        maxStake: config.maxStake,
                        availableBalance: balance,
                    });
                    if (!finalSizing) {
                        this.ntPairLogHold('final live payout edge cannot size recovery within balance and caps', latestEpoch);
                        return false;
                    }
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

                if (isRecovery) {
                    const target = Number(state.debt || 0) * (1 + Number(config.markupPercent || 0) / 100);
                    const modelledNetAtFinalStake = Number.isFinite(Number(analysis.lowerBound))
                        ? 2 * stakePerLeg * Number(analysis.lowerBound)
                        : NaN;
                    const requiredMultiplier = baseStake > 0
                        ? Math.pow(stakePerLeg / baseStake, 1 / Math.max(1, Number(state.recoveryStep || 1)))
                        : NaN;
                    log('warn',
                        `Hedge Pair Forge RECOVERY SIZE · debt ${Number(state.debt).toFixed(2)} · target debt+markup ${target.toFixed(2)} · ` +
                        `joint 95% LCB ${(Number(analysis.lowerBound) * 100).toFixed(2)}% · required step multiplier ${Number.isFinite(requiredMultiplier) ? `${requiredMultiplier.toFixed(2)}x` : 'n/a'} · ` +
                        `stake ${stakePerLeg.toFixed(2)} each (${(2 * stakePerLeg).toFixed(2)} pair exposure) · modelled LCB net ${Number.isFinite(modelledNetAtFinalStake) ? modelledNetAtFinalStake.toFixed(2) : 'n/a'} · ` +
                        `recovery profit is not guaranteed`);
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
                log('info', `Hedge Pair Forge ${fills.length === 2 ? 'PAIR LIVE' : 'PARTIAL EXPOSURE'} · ${familyDefinition.label} · ${symbol} · ${stakePerLeg.toFixed(2)} each · ${duration.amount}${duration.unit} (${durationTicks} observed tick(s)) · ${mode} · paired buys are non-atomic`);
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
                    log('error', `PAIR DOUBLE LOSS · ${result.totalStake.toFixed(2)} total stake added to recovery debt · debt ${Number(this.nt_pair_state.debt).toFixed(2)} · recovery ${this.nt_pair_state.recoveryArmed ? 'armed' : 'blocked'}`);
                } else if (result.split) {
                    log(result.netProfit < 0 ? 'warn' : 'info', `PAIR SPLIT · aggregate P&L ${result.netProfit >= 0 ? '+' : ''}${result.netProfit.toFixed(2)} · no recovery trigger${Number(this.nt_pair_state.debt) > 0 ? ` · existing debt ${Number(this.nt_pair_state.debt).toFixed(2)} remains` : ''}`);
                } else {
                    log('success', `PAIR SETTLED · ${result.bothWon ? 'both legs won' : 'no double loss'} · aggregate P&L ${result.netProfit >= 0 ? '+' : ''}${result.netProfit.toFixed(2)} · debt ${Number(this.nt_pair_state.debt || 0).toFixed(2)}`);
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
