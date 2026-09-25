import React from 'react';
import PropTypes from 'prop-types';

// The builder is one long-lived page: swapping it wholesale for a full-screen
// error page (the vendored `ErrorComponent`, i.e. the "Sorry for the
// interruption / Refresh" screen) throws away the workspace AND any bot the user
// is running. A transient render error during a stop/start handshake is not
// worth that, so the subtree is retried a few times instead; only if the same
// tree keeps failing do we show a compact in-place message that keeps the app
// shell alive and never reloads the page on its own.
const MAX_AUTO_RETRIES = 5;
const RETRY_DELAY_MS = 150;

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, retries: 0 };
        this.retry_timeout = null;
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, info) {
        if (window.TrackJS) window.TrackJS.console.log(this.props.root_store);

        // eslint-disable-next-line no-console
        console.error('[bot-builder] contained a render error; retrying', error, info?.componentStack);

        if (this.state.retries < MAX_AUTO_RETRIES) {
            this.scheduleRetry();
        }
    }

    componentWillUnmount() {
        if (this.retry_timeout) clearTimeout(this.retry_timeout);
    }

    scheduleRetry = () => {
        if (this.retry_timeout) return;
        this.retry_timeout = setTimeout(() => {
            this.retry_timeout = null;
            this.setState(prev_state => ({ hasError: false, error: null, retries: prev_state.retries + 1 }));
        }, RETRY_DELAY_MS);
    };

    retryNow = () => {
        if (this.retry_timeout) {
            clearTimeout(this.retry_timeout);
            this.retry_timeout = null;
        }
        this.setState({ hasError: false, error: null, retries: 0 });
    };

    render() {
        const { hasError, retries, error } = this.state;

        if (!hasError) return this.props.children;

        // Remounting on the next tick — hold the frame instead of replacing the
        // whole builder with an error page.
        if (retries < MAX_AUTO_RETRIES) return null;

        // Last resort. Deliberately NOT the vendored full-screen error page and
        // deliberately without any auto-refresh: the builder keeps its state and
        // the user decides when to try again.
        return (
            <div
                className='app-root'
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.6rem', padding: '2.4rem', textAlign: 'center' }}
            >
                <strong style={{ fontSize: '1.6rem' }}>The bot panel needs a moment</strong>
                <span style={{ fontSize: '1.4rem', maxWidth: '44rem', lineHeight: 1.5 }}>
                    Your account, journal and transaction history are safe. Try reloading the panel — or open Reports to check
                    your trades.
                </span>
                {error?.message ? (
                    <code style={{ fontSize: '1.2rem', opacity: 0.6, maxWidth: '60rem', wordBreak: 'break-word' }}>{String(error.message)}</code>
                ) : null}
                <button type='button' className='dc-btn dc-btn__effect dc-btn--primary' onClick={this.retryNow}>
                    Try again
                </button>
            </div>
        );
    }
}

ErrorBoundary.propTypes = {
    root_store: PropTypes.object,
    children: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.node), PropTypes.node]),
};

export default ErrorBoundary;
