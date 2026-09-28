import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { BEFORE_PURCHASE } from './state/constants';
import { analyseDigitForgeCandidate, DIGIT_FORGE_ANALYSIS_LIMITS } from './digit-forge-analysis';
import { isDigitForgeContract } from './digit-forge-contracts';

const QUOTE_TIMEOUT_MS = 5000;
const PREPARED_TRADE_TTL_MS = 10000;
const modeFor = inRecovery => (inRecovery === true ? 'RECOVERY' : inRecovery === false ? 'NORMAL' : null);

/** A one-shot quote, never a cached proposal from the startup trade definition.
 * Quote failure means HOLD, not a buy using a fallback prediction or payout. */
async function quoteDigitTrade({ symbol, contract, barrier, currency }, amount) {
    const request = {
        proposal: 1,
        amount,
        basis: 'stake',
        contract_type: contract,
        currency,
        duration: 1,
        duration_unit: 't',
        underlying_symbol: symbol,
        barrier,
    };
    let timeout;
    try {
        const response = await Promise.race([
            api_base.api.send(request),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Digit quote timed out')), QUOTE_TIMEOUT_MS);
            }),
        ]);
        const { proposal, echo_req: echo = {} } = response ?? {};
        // A mismatched or malformed response must never be promoted to a buy.
        if (
            response?.error ||
            typeof proposal?.id !== 'string' ||
            !proposal.id.trim() ||
            Object.entries(request).some(
                ([key, value]) => echo[key] !== undefined && String(echo[key]) !== String(value)
            )
        )
            return null;
        const askPrice = Number(proposal.ask_price);
        const payout = Number(proposal.payout);
        if (
            !Number.isFinite(askPrice) ||
            Math.abs(askPrice - amount) > 1e-8 ||
            !Number.isFinite(payout) ||
            payout <= askPrice
        )
            return null;
        return { id: proposal.id, askPrice, payout, multiplier: payout / askPrice };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Digit Forge's two-phase handoff. Blockly still owns the recovery ledger and
 * computes the SAME debt/markup stake as the app. Prepare binds the selected
 * tuple to a live $1 payout BEFORE that calculation. Purchase then binds the
 * resulting amount to a fresh proposal for that SAME tuple and buys its id.
 * Neither step may fall back to tradeOptions' old prediction/amount/proposals.
 */
export default Engine =>
    class DigitForge extends Engine {
        ntDigitContextMatches(inRecovery, symbol, contract, barrier, decision = this.nt_digit_decision) {
            const mode = modeFor(inRecovery);
            return Boolean(
                mode &&
                isDigitForgeContract(mode, contract, barrier) &&
                decision &&
                decision === this.nt_digit_decision &&
                decision.mode === mode &&
                decision.symbol === symbol &&
                decision.contract === contract &&
                decision.barrier === barrier &&
                this.symbol === symbol &&
                this.options?.symbol === symbol &&
                this.tradeOptions &&
                this.store.getState().scope === BEFORE_PURCHASE &&
                !this.is_purchasing &&
                this.data?.contract?.status !== 'open'
            );
        }

        async ntPrepareDigitTrade(inRecovery, symbol, contract, barrier, forced = false) {
            if (this.nt_digit_preparing || this.nt_digit_purchase_pending) return 0;
            this.nt_digit_prepared = null;
            const decision = this.nt_digit_decision;
            const forceNormal = forced === true && inRecovery === false;
            if (
                !this.ntDigitContextMatches(inRecovery, symbol, contract, barrier, decision) ||
                (decision.eligible !== true && !forceNormal) ||
                !Number.isFinite(decision.samples) ||
                decision.samples < 20 ||
                !Array.isArray(decision.digits) ||
                decision.digits.length < 20 ||
                (inRecovery && !(decision.confirmations >= DIGIT_FORGE_ANALYSIS_LIMITS.recoveryConfirmations))
            )
                return 0;

            this.nt_digit_preparing = true;
            const tradeOptions = this.tradeOptions;
            const candidate = { symbol, contract, barrier, currency: tradeOptions.currency };
            try {
                const quote = await quoteDigitTrade(candidate, 1);
                if (
                    !quote ||
                    tradeOptions !== this.tradeOptions ||
                    !this.ntDigitContextMatches(inRecovery, symbol, contract, barrier, decision)
                )
                    return 0;

                // Ranking uses canonical payouts until a live quote is available.
                // Feed this quote back into subsequent rankings, and re-check this
                // entry at the actual price. Patience is NEVER a recovery bypass.
                this.nt_digit_live_payouts ??= new Map();
                this.nt_digit_live_payouts.set(`${symbol}:${contract}:${barrier}`, {
                    payout: quote.multiplier,
                    at: Date.now(),
                });
                const liveAnalysis = analyseDigitForgeCandidate({
                    digits: decision.digits,
                    contract,
                    barrier,
                    payout: quote.multiplier,
                    mode: decision.mode,
                });
                if (!forceNormal && !liveAnalysis.eligible) {
                    globalObserver.emit(
                        'ui.log.info',
                        'Digit Forge HOLD · setup no longer qualifies at the live payout'
                    );
                    return 0;
                }
                this.nt_digit_prepared = {
                    ...candidate,
                    inRecovery,
                    decision,
                    tradeOptions,
                    quote,
                    forceNormal,
                    at: Date.now(),
                };
                return quote.multiplier;
            } catch (_) {
                globalObserver.emit('ui.log.warn', 'Digit Forge HOLD · fresh quote unavailable; rescanning');
                return 0;
            } finally {
                this.nt_digit_preparing = false;
            }
        }

        async ntPurchaseDigitTrade(inRecovery, symbol, contract, barrier, amount, maxStake) {
            if (this.nt_digit_preparing || this.nt_digit_purchase_pending) return false;
            const prepared = this.nt_digit_prepared;
            // Single-use: a retry must re-scan, re-quote and re-size, never replay an
            // old candidate after a loss, market switch, stop or rejected purchase.
            this.nt_digit_prepared = null;
            const contextValid = () =>
                Boolean(
                    prepared &&
                    prepared.inRecovery === inRecovery &&
                    prepared.symbol === symbol &&
                    prepared.contract === contract &&
                    prepared.barrier === barrier &&
                    prepared.tradeOptions === this.tradeOptions &&
                    prepared.currency === this.tradeOptions.currency &&
                    Date.now() - prepared.at <= PREPARED_TRADE_TTL_MS &&
                    this.ntDigitContextMatches(inRecovery, symbol, contract, barrier, prepared.decision)
                );
            const affordable = () => {
                const balance = Number(this.getBalance());
                return (
                    Number.isFinite(amount) &&
                    amount >= 0.35 &&
                    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8 &&
                    Number.isFinite(maxStake) &&
                    amount <= maxStake &&
                    Number.isFinite(balance) &&
                    amount <= balance
                );
            };
            if (!contextValid()) return false;
            if (!affordable()) {
                globalObserver.emit(
                    'ui.log.warn',
                    'Digit Forge HOLD · no valid stake within the balance and max-stake limits'
                );
                return false;
            }

            this.nt_digit_purchase_pending = true;
            try {
                let quote;
                try {
                    quote = amount === 1 ? prepared.quote : await quoteDigitTrade(prepared, amount);
                } catch (_) {
                    // Quote failures are safe to retry on a fresh scan. Buy failures
                    // below are NOT swallowed: an ambiguous buy must stop/reconcile.
                    globalObserver.emit('ui.log.warn', 'Digit Forge HOLD · stake quote unavailable; rescanning');
                    return false;
                }
                if (!quote || !contextValid() || !affordable()) return false;
                const liveAnalysis = analyseDigitForgeCandidate({
                    digits: prepared.decision.digits,
                    contract,
                    barrier,
                    payout: quote.multiplier,
                    mode: modeFor(inRecovery),
                });
                if (!prepared.forceNormal && !liveAnalysis.eligible) return false;

                // Update all fields together for logging/settlement, but execute by
                // THIS quote id even when stock payout/proposal blocks are present.
                this.tradeOptions = {
                    ...this.tradeOptions,
                    symbol,
                    prediction: barrier,
                    amount,
                    basis: 'stake',
                    duration: 1,
                    duration_unit: 't',
                };
                this.data.proposals = [];
                this.trade_option = null;
                this.proposal_templates = [];
                const purchased = await this.purchase(contract, quote);
                if (purchased) this.nt_digit_recovery_confirmation = undefined;
                return Boolean(purchased);
            } finally {
                this.nt_digit_purchase_pending = false;
            }
        }
    };
