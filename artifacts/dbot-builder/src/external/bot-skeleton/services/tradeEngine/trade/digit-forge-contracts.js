/** One runtime allowlist for BOTH ranking and execution. Never mix a side from
 * one candidate with the prediction of another (e.g. Under + startup Over 2).
 * Kept in parity with the API generator by digit-forge-dbot.test.ts. */
export const DIGIT_FORGE_CONTRACTS = Object.freeze({
    NORMAL: Object.freeze([
        Object.freeze({ contract: 'DIGITOVER', barrier: 1, payout: 1.23 }),
        Object.freeze({ contract: 'DIGITOVER', barrier: 2, payout: 1.4 }),
        Object.freeze({ contract: 'DIGITUNDER', barrier: 7, payout: 1.4 }),
        Object.freeze({ contract: 'DIGITUNDER', barrier: 8, payout: 1.23 }),
    ]),
    RECOVERY: Object.freeze([
        Object.freeze({ contract: 'DIGITOVER', barrier: 5, payout: 2.43 }),
        Object.freeze({ contract: 'DIGITUNDER', barrier: 4, payout: 2.43 }),
    ]),
});

export const isDigitForgeContract = (mode, contract, barrier) =>
    (mode === 'NORMAL' || mode === 'RECOVERY') &&
    DIGIT_FORGE_CONTRACTS[mode].some(candidate => candidate.contract === contract && candidate.barrier === barrier);
