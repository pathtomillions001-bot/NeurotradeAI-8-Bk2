// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import ErrorBoundary from '../error-boundary';

const INTERRUPTION_TEXT = /Sorry for the interruption/i;

describe('ErrorBoundary', () => {
    let error_spy;
    // React 19 re-reports errors that an error boundary handled to the global
    // handler; preventDefault stops jest from counting that as a failure.
    const swallow_reported = (event: ErrorEvent) => event.preventDefault();

    beforeEach(() => {
        jest.useFakeTimers();
        // The error screen renders inside a portal (Modal → #modal_root).
        const portal = document.createElement('div');
        portal.id = 'modal_root';
        document.body.appendChild(portal);
        window.addEventListener('error', swallow_reported);
        error_spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        window.removeEventListener('error', swallow_reported);
        error_spy.mockRestore();
        document.getElementById('modal_root')?.remove();
        jest.useRealTimers();
    });

    // Driven at the lifecycle level on purpose: React 19 auto-retries a failed
    // render before the boundary's fallback can paint, so a render-level probe
    // cannot tell a self-healing boundary from a latching one.
    describe('lifecycle', () => {
        it('derives the error state so the fallback can paint', () => {
            expect(typeof ErrorBoundary.getDerivedStateFromError).toBe('function');
            expect(ErrorBoundary.getDerivedStateFromError(new Error('boom'))).toEqual({ hasError: true });
        });

        it('recovers from a transient error instead of latching forever', () => {
            const boundary = new ErrorBoundary({ root_store: {} });
            boundary.setState = jest.fn();

            boundary.componentDidCatch(new Error('transient'), {});
            jest.runAllTimers();

            expect(boundary.setState).toHaveBeenCalledWith({ hasError: false });
        });

        it('stops recovering and keeps the interruption screen on a crash loop', () => {
            const boundary = new ErrorBoundary({ root_store: {} });
            boundary.setState = jest.fn();
            const error = new Error('permanent');

            // Three failures inside the recovery window == give up, otherwise we
            // would re-render into the same throw indefinitely.
            boundary.componentDidCatch(error, {});
            boundary.componentDidCatch(error, {});
            boundary.componentDidCatch(error, {});
            jest.runAllTimers();

            expect(boundary.setState).not.toHaveBeenCalledWith({ hasError: false });
        });

        it('counts failures only within the recovery window', () => {
            const boundary = new ErrorBoundary({ root_store: {} });
            boundary.setState = jest.fn();
            const error = new Error('permanent');

            boundary.componentDidCatch(error, {});
            boundary.componentDidCatch(error, {});
            jest.advanceTimersByTime(20000); // window expires
            boundary.componentDidCatch(error, {});
            jest.runAllTimers();

            expect(boundary.setState).toHaveBeenCalledWith({ hasError: false });
        });

        it('renders children when there is no error', () => {
            const boundary = new ErrorBoundary({ root_store: {} });
            const children = <div>builder content</div>;
            boundary.props = { root_store: {}, children };
            boundary.state = { hasError: false };

            expect(boundary.render()).toBe(children);
        });
    });

    it('shows the interruption screen once the boundary has latched', () => {
        const AlwaysThrows = () => {
            throw new Error('permanent render failure');
        };

        try {
            render(
                <ErrorBoundary>
                    <AlwaysThrows />
                </ErrorBoundary>
            );
        } catch (e) {
            // React 19 re-surfaces the caught error to the caller of act().
        }

        for (let i = 0; i < 4; i++) {
            act(() => {
                jest.runAllTimers();
            });
        }

        expect(screen.getByText(INTERRUPTION_TEXT)).toBeTruthy();
    });
});
