/**
 * One pair = TWO stakes. With one winning recovery leg, its total payout has
 * to repay BOTH stakes before it can reduce old debt. For equal stakes s:
 * netPair = s * (min(winningReturnMultiplier) - 2).
 * Using the single-contract divisor (multiplier - 1) would under-recover.
 */
const cents = value => Math.round(value * 100);
const money = value => cents(value) / 100;
const ceilCents = value => Math.ceil(value * 100 - 1e-9) / 100;
const floorCents = value => Math.floor(value * 100 + 1e-9) / 100;

export function sizeDigit45Pair({
    mode, baseStake, debt, markupPercent, maxStake, balance, stopLoss, sessionProfit,
    payoutOver, payoutUnder,
}) {
    const values = [baseStake, debt, markupPercent, maxStake, balance, stopLoss, sessionProfit];
    if (!values.every(Number.isFinite) || baseStake < 0.35 || debt < 0 ||
        markupPercent < 0 || markupPercent > 100 || maxStake < baseStake ||
        stopLoss <= 0 || balance <= 0 || !['normal', 'recovery'].includes(mode)) {
        throw new Error('Invalid paired-trade risk settings; no contracts were bought.');
    }
    if ((mode === 'normal' && debt > 0.005) || (mode === 'recovery' && debt < 0.005)) {
        throw new Error('Pair mode does not match recovery debt; no contracts were bought.');
    }
    const cap = floorCents(Math.min(maxStake, balance / 2));
    if (cap < 0.35) throw new Error('Balance cannot cover TWO minimum-stake contracts.');
    let requested = baseStake;
    if (mode === 'recovery') {
        if (![payoutOver, payoutUnder].every(p => Number.isFinite(p) && p > 2)) {
            throw new Error('Recovery quote must pay more than TWO stakes if one leg wins. No buy was placed.');
        }
        requested = ceilCents(debt * (1 + markupPercent / 100) / (Math.min(payoutOver, payoutUnder) - 2));
    }
    if (mode === 'normal' && cap < baseStake) {
        throw new Error('Balance cannot cover both normal legs at the configured stake.');
    }
    const stake = money(Math.min(Math.max(0.35, requested), cap));
    // Stop loss is checked AGAINST THE WHOLE PAIR, including a worst-case
    // double loss. Do not send a single order when that exposure breaks the cap.
    if (money(sessionProfit - stake * 2) < -stopLoss) {
        throw new Error('The full two-leg exposure could exceed stop loss. No buy was placed.');
    }
    return { stake, pairExposure: money(stake * 2), canClearDebtOnOneWin: requested <= cap };
}

/** Pair outcomes are settled only after EVERY accepted broker contract is sold. */
export function settleDigit45Pair(legs, mode) {
    if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2 || legs.some(l =>
        l?.buyPrice === null || l?.buyPrice === undefined || l?.buyPrice === '' ||
        l?.sellPrice === null || l?.sellPrice === undefined || l?.sellPrice === '' ||
        !Number.isFinite(Number(l.buyPrice)) || Number(l.buyPrice) <= 0 ||
        !Number.isFinite(Number(l.sellPrice)) || Number(l.sellPrice) < 0)) {
        throw new Error('Cannot reconcile an unsettled paired trade');
    }
    const profitCents = legs.reduce((sum, l) => sum + cents(Number(l.sellPrice)) - cents(Number(l.buyPrice)), 0);
    return {
        mode,
        profit: profitCents / 100,
        stake: money(legs.reduce((sum, l) => sum + Number(l.buyPrice), 0)),
        bothLost: legs.length === 2 && legs.every(l => cents(Number(l.sellPrice)) < cents(Number(l.buyPrice))),
        partial: legs.length !== 2,
    };
}
