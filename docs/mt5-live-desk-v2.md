# MT5 Live Desk v2

> **Superseded in part by [mt5-live-desk-v3.md](./mt5-live-desk-v3.md)**, which fixes
> timestamps sent in broker-server time, adds a server-sent price stream, switches the Desk to
> Nairobi time, and replaces the Markov veto with a seven-family evidence ensemble.

The Multi-Asset Desk is now a **live-terminal-only** workspace. It does not render a replay balance, synthetic quote, mock scanner result, embedded chart, or paper account while MT5 is unlinked.

## What changed

- `artifacts/mt5-ea/NeurotradeBridge.mq5` is a resilient v2 connector.
  - It returns `INIT_SUCCEEDED` even when its URL, pairing code, WebRequest permission, or network is not yet ready.
  - It remains attached to the chart, logs the problem in the MT5 Journal, and retries pairing every five seconds.
  - Attach it to any chart: its timer manages selected symbols and open NeuroTrade positions across the terminal, not only the chart symbol.
- The Desk’s charts (the in-house candle chart and TradingView iframe) were removed. The responsive Desk now focuses on operational information: the broker universe, selected live coverage, agent gates, scanner, positions, armed plans, risk, red-folder calendar and journal.
- The global `Active Engine / No bot running` overlay and floating engine launcher are hidden on the Desk, so they cannot obscure terminal controls.
- The EA discovers the complete broker symbol catalogue using `SymbolsTotal(false)`. The UI groups it into forex, metals, indices, commodities, crypto, futures, stocks and other broker-defined products. Users can select any number of tradeable broker symbols; there is no server-side `20`-symbol cap.
- A selected universe is transported in rotating batches. This is a network scheduling mechanism, not a selection limit. The server labels each symbol `live`, `warming`, or `stale`, and **refuses analysis, arming and new execution on a non-fresh quote**.
- The MT5 economic calendar supplies high-importance (“red-folder”) events. New entries are paused around relevant currency events and the system fails closed if the terminal cannot provide a current calendar status. Existing positions continue to receive local risk/stop management.

## Installation

1. Open **Desk → Link MT5** and download `NeurotradeBridge.mq5`.
2. In MetaEditor, put it in `MQL5/Experts`, then compile it.
3. In MT5 go to **Tools → Options → Expert Advisors**:
   - enable **Allow algorithmic trading** as appropriate;
   - enable **Allow WebRequest for listed URL**;
   - add the exact public Desk origin, for example `https://desk.example.com`.
4. Attach the EA to any open chart. It should remain attached even before configuration is complete.
5. In EA Inputs set:
   - `ServerUrl` to the same public origin, with no `/api` suffix;
   - `PairingCode` to the current one-time value from the Desk dialog.
6. Wait for the Desk status to show **MT5 LIVE**, then choose broker markets from the market universe.

> A terminal running on another machine/VPS must use the deployed public HTTPS URL. It cannot use a developer browser’s `localhost` URL.

## Data and execution guarantees

- MT5 is the authoritative source for account values, broker contract specifications, quotes, bars, positions and economic calendar status.
- The browser never submits an MT5 password; pairing exchanges a short-lived code for a scoped bridge token.
- The server sends a time-bound armed plan, not a blind market order. The EA evaluates the trigger and its spread/news/local risk guards close to the broker.
- A lost terminal heartbeat, stale quote, unavailable calendar, or missing history blocks new entries. It does not silently substitute simulated data.
- The EA enforces its own live-account opt-in (`AllowLiveAccount`) in addition to the server’s live-trading policy.

## Large market selections

Selecting many assets is allowed. The EA sends selected symbols in rotating `SymbolsPerHeartbeat` batches so MT5 and the HTTP bridge do not try to upload every timeframe for every asset in one request. This means a large universe can temporarily show markets as **warming** or **stale** while it is being seeded/refreshed. The Desk shows that state visibly and will not use it for a trade.

For the tightest coverage, select the markets that you genuinely want the agent to monitor and increase `SymbolsPerHeartbeat` only after checking the MT5 Journal and network capacity.

## Red-folder policy

The connector reads MT5’s economic calendar every minute. For relevant high-impact events it blocks fresh entries from 30 minutes before until 15 minutes after the release by default (`NewsBlackoutBeforeMinutes` and `NewsBlackoutAfterMinutes` are EA inputs). Scalp mode applies an even more conservative post-event pause at the server level. If calendar access fails, the Desk shows that condition and blocks new entries rather than assuming the schedule is clear.
