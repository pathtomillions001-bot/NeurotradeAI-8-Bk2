import {
    analyseDigitForgeCandidate,
    DIGIT_FORGE_ANALYSIS_LIMITS,
} from '../digit-forge-analysis';

const digitsFromWins = wins => wins.map(won => (won ? 9 : 0));

// Stable 2-wins/1-loss tape: Over 4 wins 66.7%, every loss is followed by a
// win, both recent horizons agree and no adverse run is present.
const STABLE_RECOVERY = digitsFromWins(
    Array.from({ length: 60 }, () => [true, true, false]).flat()
);

const analyse = (digits, mode = 'RECOVERY') =>
    analyseDigitForgeCandidate({
        digits,
        contract: 'DIGITOVER',
        barrier: 4,
        payout: 1.95,
        mode,
    });

describe('Digit Forge regime-aware analysis', () => {
    it('admits a stable recovery edge supported by the loss-conditioned row', () => {
        const result = analyse(STABLE_RECOVERY);
        expect(result.eligible).toBe(true);
        expect(result.afterLossLowerBound).toBeGreaterThan(result.breakEven - 0.02);
        expect(result.shortRate).toBeGreaterThan(result.breakEven);
        expect(result.mediumRate).toBeGreaterThan(result.breakEven);
        expect(result.adverseRun).toBeLessThanOrEqual(DIGIT_FORGE_ANALYSIS_LIMITS.maxRecoveryAdverseRun);
    });

    it('vetoes a clustered adverse tail even when the long-window average is attractive', () => {
        const result = analyse([...STABLE_RECOVERY, 0, 0, 0, 0, 0]);
        expect(result.eligible).toBe(false);
        expect(result.adverseRun).toBe(6);
        expect(result.blockers.join(' ')).toMatch(/adverse run|recent horizons|clustering/);
    });

    it('vetoes a regime reversal instead of spending recovery debt on stale history', () => {
        const oldEdge = Array.from({ length: 120 }, (_, index) => (index % 5 === 0 ? 0 : 9));
        const recentFailure = Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? 9 : 0));
        const result = analyse([...oldEdge, ...recentFailure]);
        expect(result.eligible).toBe(false);
        expect(result.blockers.join(' ')).toMatch(/recent horizons|unstable|clustering|adverse run/);
    });

    it('fails closed on malformed input without throwing or producing NaN', () => {
        const result = analyseDigitForgeCandidate({
            digits: [null, -1, 12, 'x'],
            contract: 'UNKNOWN',
            barrier: Number.NaN,
            payout: Number.NaN,
            mode: 'RECOVERY',
        });
        expect(result.eligible).toBe(false);
        expect(result.samples).toBe(0);
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.reason).toMatch(/^HOLD/);
    });
});
