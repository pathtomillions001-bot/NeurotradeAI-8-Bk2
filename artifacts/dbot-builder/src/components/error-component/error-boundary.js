import React from 'react';
import PropTypes from 'prop-types';
import ErrorComponent from './index';

// A single transient render error (a chunk that flaked, a contract object that
// was momentarily null while the bot was stopping) used to latch this boundary
// permanently: `componentDidCatch` set hasError and nothing ever cleared it, so
// the whole builder was replaced by the "Sorry for the interruption / Refresh"
// screen and the running bot died with it. We now self-heal and only escalate
// to that screen when the SAME subtree keeps throwing — i.e. a real crash loop
// that cannot be rendered around.
const RECOVERY_WINDOW_MS = 10000;
const MAX_FAILURES_BEFORE_GIVING_UP = 3;

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
        this.recent_failure_times = [];
        this.recovery_timer = null;
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch = (error, info) => {
        // Keep the diagnostic the old implementation emitted.
        console.error('[bot-builder] Recoverable render error caught by ErrorBoundary:', error, info);
        if (window.TrackJS) window.TrackJS.console.log(this.props.root_store);

        const now = Date.now();
        this.recent_failure_times = [
            ...this.recent_failure_times.filter(time => now - time < RECOVERY_WINDOW_MS),
            now,
        ];

        if (this.recent_failure_times.length >= MAX_FAILURES_BEFORE_GIVING_UP) {
            // Genuine crash loop — rendering children again would just throw
            // again. Stay on the error screen, and cancel the recovery the
            // previous (still-recovering) failure scheduled, or it would fire
            // right after this decision and un-latch us anyway.
            if (this.recovery_timer) {
                clearTimeout(this.recovery_timer);
                this.recovery_timer = null;
            }
            return;
        }

        // Transient: let React re-render the real UI on the next tick instead of
        // bricking the builder. The bot keeps its strategy, connection and run
        // state because the store tree is never unmounted.
        if (this.recovery_timer) clearTimeout(this.recovery_timer);
        this.recovery_timer = setTimeout(() => {
            this.recovery_timer = null;
            this.setState({ hasError: false });
        }, 0);
    };

    componentWillUnmount() {
        if (this.recovery_timer) clearTimeout(this.recovery_timer);
    }

    render = () => (this.state.hasError ? <ErrorComponent should_show_refresh={true} /> : this.props.children);
}

ErrorBoundary.propTypes = {
    root_store: PropTypes.object,
    children: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.node), PropTypes.node]),
};

export default ErrorBoundary;
