import { act, render, screen, waitFor } from '@testing-library/react';
import ErrorBoundary from '../error-boundary';

// The boundary is what stands between a transient render error and the whole
// builder being replaced by the vendored "Sorry for the interruption / Refresh"
// page (which also kills a running bot). These tests pin that behaviour:
// it retries by itself, and it never renders a refresh page.

const Boom = ({ should_throw }: { should_throw: boolean }) => {
    if (should_throw) throw new Error('render exploded');
    return <div>workspace is alive</div>;
};

describe('<ErrorBoundary/>', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // React logs every caught error; keep the test output readable.
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('renders children untouched while nothing throws', () => {
        render(
            <ErrorBoundary>
                <Boom should_throw={false} />
            </ErrorBoundary>
        );

        expect(screen.getByText('workspace is alive')).toBeInTheDocument();
    });

    it('auto-retries instead of showing an interruption page', () => {
        let should_throw = true;

        const { rerender } = render(
            <ErrorBoundary>
                <Boom should_throw={should_throw} />
            </ErrorBoundary>
        );

        // The failing subtree is held back, not replaced by an error screen.
        expect(screen.queryByText('render exploded')).not.toBeInTheDocument();
        expect(screen.queryByText(/interruption/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();

        // Let the first retry fire — this time the child renders fine.
        should_throw = false;
        rerender(
            <ErrorBoundary>
                <Boom should_throw={should_throw} />
            </ErrorBoundary>
        );
        act(() => {
            jest.advanceTimersByTime(200);
        });

        expect(screen.getByText('workspace is alive')).toBeInTheDocument();
    });

    it('shows a compact in-place recovery panel (no refresh) when it keeps failing', async () => {
        // Real timers here: each retry remounts the failing subtree, which is
        // itself what schedules the next retry — easier to let that settle.
        jest.useRealTimers();

        render(
            <ErrorBoundary>
                <Boom should_throw={true} />
            </ErrorBoundary>
        );

        // Burn through the automatic retries (5 × 150ms) and expect the
        // contained panel — never the vendored interruption/refresh page.
        await waitFor(() => expect(screen.getByText('The bot panel needs a moment')).toBeInTheDocument(), {
            timeout: 4000,
        });
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByText(/interruption/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
    });
});
