# Market Intelligence signal desk

`/market-intelligence` is an independent, signal-only surface. It does not call the legacy options/digit engine, AI bots, autonomous engine, or recovery system.

## Live-data contract

The service uses Deriv's public WebSocket for `active_symbols`, candle `ticks_history`, and tick history. It never falls back to the legacy simulated tick manager. If the live feed is unavailable, the service returns `LIVE_MARKET_DATA_UNAVAILABLE` and the UI generates no signal.

Deriv's public feed provides OHLC candles and ticks, but it does not provide exchange-traded volume, individual trade size, or a Level 2 order book. Therefore the desk labels delta and signed-volume values as `TICK_PROXY`; it must not claim to have true institutional order flow or fabricate volume.

## Advanced stack

The signal is a weighted ensemble of bounded, transparent modules:

- Micro and macro fractal structure, break of structure, change of character, and displacement.
- Liquidity-level clustering and sweep/reversal detection.
- Realized log-return distribution, quantiles, z-score, autocorrelation, Hurst exponent, and permutation entropy.
- Markov state transitions over live directional return states.
- Tick direction imbalance and signed movement as a clearly labelled proxy.
- Bootstrap Monte Carlo paths resampled from live returns.
- Higher-timeframe agreement and freshness vetoes.
- Volatility- and liquidity-derived entry, stop, and minimum 1:2 target levels.

The desk supports 1m, 5m, 15m, 1h, 4h, and 1D analysis. It fetches only the selected market plus one higher timeframe and bounds signal-tape refreshes to the newest eight open signals.

## Execution

This surface is advisory only. It never places or manages trades. Lot sizing is indicative and requires the user to confirm the instrument's actual contract size, point value, minimum lot, spread, and slippage with Deriv before acting.
