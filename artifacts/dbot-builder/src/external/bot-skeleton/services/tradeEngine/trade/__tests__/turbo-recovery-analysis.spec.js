import withTicks from '../Ticks';
import { analyseTurboRecovery, TURBO_RECOVERY_ANALYSIS_LIMITS } from '../turbo-recovery-analysis';

const input = overrides => ({
    digits: Array.from({ length: 161 }, (_, index) => (index % 2 === 0 ? 0 : 9)),
    contract: 'DIGITOVER',
    barrier: 4,
    payout: 1.95,
    stake: 1,
    balance: 1000,
    ...overrides,
});

describe('Turbo in-bot recovery analysis', () => {
    it('approves a stable loss-to-win transition edge with positive utility', () => {
        const decision = analyseTurboRecovery(input());

        expect(decision.currentState).toBe('LOSS');
        expect(decision.contextSamples).toBeGreaterThanOrEqual(70);
        expect(decision.lowerBound).toBeGreaterThan(decision.breakEven);
        expect(decision.clusterRatio).toBeLessThan(1);
        expect(decision.expectedUtility).toBeGreaterThan(0);
        expect(decision.eligible).toBe(true);
        expect(decision.reason).toMatch(/^READY/);
    });

    it('waits safely while the live history is still warming up', () => {
        const decision = analyseTurboRecovery(input({ digits: [0, 9, 0, 9, 0] }));

        expect(decision.eligible).toBe(false);
        expect(decision.reason).toContain(`samples 5/${TURBO_RECOVERY_ANALYSIS_LIMITS.minSamples}`);
    });

    it('rejects a clustered recovery-loss regime', () => {
        const decision = analyseTurboRecovery(input({ digits: Array.from({ length: 160 }, () => 0) }));

        expect(decision.eligible).toBe(false);
        expect(decision.clusterRatio).toBeGreaterThan(TURBO_RECOVERY_ANALYSIS_LIMITS.maxClusterRatio);
        expect(decision.reason).toContain('loss clustering');
    });

    it('uses payout break-even rather than a hard-coded hit-rate threshold', () => {
        const normalQuote = analyseTurboRecovery(input({ payout: 1.95 }));
        const poorQuote = analyseTurboRecovery(input({ payout: 1.05 }));

        expect(normalQuote.eligible).toBe(true);
        expect(poorQuote.breakEven).toBeCloseTo(1 / 1.05);
        expect(poorQuote.eligible).toBe(false);
        expect(poorQuote.reason).toContain('90% lower bound');
    });

    it('refuses a recovery stake when the account balance cannot safely carry it', () => {
        const decision = analyseTurboRecovery(input({ stake: 100, balance: 100 }));

        expect(decision.eligible).toBe(false);
        expect(decision.reason).toContain('stake/balance unavailable or unsafe');
    });

    it('runs through the real Tick interface with live proposal payout and exposes decision fields', async () => {
        class BaseEngine {
            constructor(scope) {
                this.$scope = scope;
                this.symbol = 'R_100';
                this.tradeOptions = { amount: 1 };
                this.data = {
                    proposals: [{ contract_type: 'DIGITOVER', barrier: 4, ask_price: 1, payout: 1.95 }],
                };
            }

            getBalance() {
                return 1000;
            }
        }
        const TickEngine = withTicks(BaseEngine);
        const quotes = Array.from({ length: 161 }, (_, index) => ({
            quote: index % 2 === 0 ? 100.0 : 100.09,
            epoch: index + 1,
        }));
        const engine = new TickEngine({
            ticksService: {
                pipSizes: { R_100: 2 },
                request: jest.fn(() => Promise.resolve(quotes)),
            },
        });

        // The post-trade rescan mandate holds the first sighting at 1/2…
        await expect(engine.ntAnalyseTurboRecovery('DIGITOVER', 4, 1.8, 200, 1)).resolves.toBe(false);
        // …and a genuinely fresh tick (same loss-context ending) completes it.
        quotes.push({ quote: 100.0, epoch: 162 });
        await expect(engine.ntAnalyseTurboRecovery('DIGITOVER', 4, 1.8, 200, 1)).resolves.toBe(true);
        await expect(engine.ntTurboRecoveryDecision('eligible')).resolves.toBe(true);
        await expect(engine.ntTurboRecoveryDecision('payout')).resolves.toBeCloseTo(1.95);
        await expect(engine.ntTurboRecoveryDecision('reason')).resolves.toMatch(/^READY/);
    });
});
