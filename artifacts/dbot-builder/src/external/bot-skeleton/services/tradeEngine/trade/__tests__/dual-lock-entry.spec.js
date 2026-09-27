import { analyseDualLockEntry, DUAL_LOCK_ENTRY_DEFAULTS } from '../dual-lock-entry';

/** A tape where every digit satisfies the locked contract. */
const cleanTape = (contract, barrier, length = 80) =>
    Array.from({ length }, () => (contract === 'DIGITUNDER' ? Math.max(0, barrier - 1) : Math.min(9, barrier + 1)));

/** A tape where every digit violates the locked contract. */
const hostileTape = (contract, barrier, length = 80) =>
    Array.from({ length }, () => (contract === 'DIGITUNDER' ? Math.min(9, barrier + 1) : Math.max(0, barrier - 1)));

const entry = overrides => ({
    digits: cleanTape('DIGITOVER', 1),
    contract: 'DIGITOVER',
    barrier: 1,
    waited: 1,
    patience: DUAL_LOCK_ENTRY_DEFAULTS.patience,
    ...overrides,
});

describe('Dual-Lock in-bot first-entry timing', () => {
    it('starts immediately when the tape is clean and the range is holding', () => {
        const decision = analyseDualLockEntry(entry());

        expect(decision.ready).toBe(true);
        expect(decision.forced).toBe(false);
        expect(decision.state).toBe('CLEAN');
        expect(decision.confidence).toBeGreaterThanOrEqual(decision.threshold);
        expect(decision.quietTicks).toBeGreaterThan(2);
        expect(decision.reason).toMatch(/^TIMED ENTRY/);
    });

    it('refuses to start inside a burst of range violations', () => {
        const digits = [...cleanTape('DIGITOVER', 1, 70), ...hostileTape('DIGITOVER', 1, 4)];
        const decision = analyseDualLockEntry(entry({ digits }));

        expect(decision.ready).toBe(false);
        expect(decision.state).toBe('VIOLATION');
        expect(decision.quietTicks).toBe(0);
        expect(decision.burst).toBeGreaterThan(1);
        expect(decision.reason).toMatch(/^TIMING 1\/12/);
    });

    it('waits for the cluster to clear, then enters on the recovered tape', () => {
        const held = analyseDualLockEntry(entry({ digits: [...cleanTape('DIGITOVER', 1, 70), 0, 0, 9] }));
        expect(held.ready).toBe(false); // only 1 clean tick — the early gate wants 2

        const stillBursty = analyseDualLockEntry(entry({ digits: [...cleanTape('DIGITOVER', 1, 70), 0, 0, 9, 9, 9] }));
        expect(stillBursty.ready).toBe(false); // 2 misses still inside the 5-tick burst window

        const entered = analyseDualLockEntry(entry({ digits: [...cleanTape('DIGITOVER', 1, 70), 0, 0, 9, 9, 9, 9, 9] }));
        expect(entered.ready).toBe(true);
        expect(entered.forced).toBe(false);
        expect(entered.quietTicks).toBe(5);
    });

    it('relaxes its threshold as the deadline approaches instead of deadlocking', () => {
        const digits = [...cleanTape('DIGITOVER', 1, 60), ...hostileTape('DIGITOVER', 1, 6)];
        const thresholds = [1, 4, 8, 11].map(waited => analyseDualLockEntry(entry({ digits, waited })).threshold);

        for (let index = 1; index < thresholds.length; index++) {
            expect(thresholds[index]).toBeLessThan(thresholds[index - 1]);
        }
    });

    it('always starts at the patience deadline — the wait is provably bounded', () => {
        const patience = 12;
        const digits = hostileTape('DIGITOVER', 1);

        for (let waited = 1; waited < patience; waited++) {
            expect(analyseDualLockEntry(entry({ digits, waited, patience })).ready).toBe(false);
        }
        const forced = analyseDualLockEntry(entry({ digits, waited: patience, patience }));
        expect(forced.ready).toBe(true);
        expect(forced.forced).toBe(true);
        expect(forced.reason).toMatch(/patience budget reached/);
    });

    it('is self-calibrating: the same gate works for every locked barrier', () => {
        for (const [contract, barrier] of [
            ['DIGITOVER', 1],
            ['DIGITOVER', 2],
            ['DIGITUNDER', 7],
            ['DIGITUNDER', 8],
        ]) {
            const clean = analyseDualLockEntry(
                entry({ contract, barrier, digits: cleanTape(contract, barrier) })
            );
            const hostile = analyseDualLockEntry(
                entry({ contract, barrier, digits: hostileTape(contract, barrier) })
            );

            expect(clean.ready).toBe(true);
            expect(clean.contract).toBe(contract);
            expect(clean.barrier).toBe(barrier);
            expect(hostile.ready).toBe(false);
        }
    });

    it('never throws and still honours the deadline on a missing or broken tape', () => {
        for (const digits of [undefined, null, [], ['x', null, 99, -3], [5]]) {
            const early = analyseDualLockEntry(entry({ digits, waited: 1 }));
            expect(early.ready).toBe(false);
            expect(early.reason).toContain('tape');

            const deadline = analyseDualLockEntry(entry({ digits, waited: 40, patience: 12 }));
            expect(deadline.ready).toBe(true);
            expect(deadline.forced).toBe(true);
        }
    });

    it('clamps hostile inputs into a safe, terminating configuration', () => {
        const wild = analyseDualLockEntry(entry({ patience: 5000, waited: -7, barrier: 42, contract: 'NONSENSE' }));

        expect(wild.patience).toBe(40);
        expect(wild.waited).toBe(0);
        expect(wild.barrier).toBe(9);
        expect(wild.contract).toBe('DIGITOVER');
    });

    it('terminates within the patience budget on random tapes (500 trials)', () => {
        const patience = 12;
        let worstWait = 0;

        for (let trial = 0; trial < 500; trial++) {
            const digits = Array.from({ length: 90 }, () => Math.floor(Math.random() * 10));
            let waited = 0;
            while (waited < patience) {
                waited += 1;
                if (analyseDualLockEntry({ digits, contract: 'DIGITOVER', barrier: 1, waited, patience }).ready) break;
            }
            worstWait = Math.max(worstWait, waited);
            expect(waited).toBeLessThanOrEqual(patience);
        }

        expect(worstWait).toBeLessThanOrEqual(patience);
    });
});
