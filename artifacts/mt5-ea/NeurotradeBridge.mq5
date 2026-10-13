//+------------------------------------------------------------------+
//|                                          NeurotradeBridge.mq5    |
//|      NeuroTrade Multi-Asset Desk / resilient MetaTrader 5 EA     |
//+------------------------------------------------------------------+
//| Version 3.08                                                     |
//|                                                                    |
//| WHAT CHANGED IN v3.00                                             |
//|  1. TIMESTAMPS ARE NOW TRUE UTC.                                  |
//|     MT5 reports ticks (MqlTick.time_msc), bars (CopyRates.time)   |
//|     and economic-calendar events (MqlCalendarValue.time) in the   |
//|     broker's TRADE SERVER timezone, not UTC. Sending those raw    |
//|     values as epoch milliseconds shifts every timestamp by the    |
//|     server's GMT offset — usually 2-3 hours. That is why news     |
//|     showed the wrong time and why quotes read as impossibly       |
//|     fresh or permanently stale. All three are now converted with  |
//|     TimeTradeServer() - TimeGMT() before they leave the terminal.  |
//|  2. QUOTES ARE SENT FOR EVERY SELECTED SYMBOL ON EVERY HEARTBEAT.  |
//|     Ticks are tiny; rotating them in batches meant a symbol could |
//|     go many seconds between updates while the Desk kept painting  |
//|     its last known price as if it were live. Only candles — the   |
//|     genuinely large payload — are still batched.                   |
//|  3. STALE TICKS ARE DROPPED AT SOURCE.                            |
//|     A symbol that Market Watch is not subscribed to returns a     |
//|     cached tick, sometimes hours old. We now select the symbol,   |
//|     read the tick, check its age and refuse to ship anything the  |
//|     terminal itself considers old.                                 |
//|  4. M2, M3 AND W1 TIMEFRAMES ADDED.                               |
//|     Scalps are analysed on 3-minute-and-below structure (M1-M3),  |
//|     swing trades from H1 to W1. The old fixed 7-timeframe set     |
//|     could not express either.                                      |
//|                                                                    |
//| WHAT CHANGED IN v3.01                                             |
//|  5. ONE ACCOUNT, ONE DESK.                                        |
//|     The platform now refuses to pair an account that is already    |
//|     connected in another browser: two Desks on one account would   |
//|     stream the same balance, arm plans against it independently    |
//|     and each could flatten positions the other believed it owned.  |
//|     A refused pairing no longer burns the pairing code — the       |
//|     reason is printed once and retried slowly, so the terminal     |
//|     connects by itself as soon as the other Desk lets go. A        |
//|     terminal whose account has since been taken over is told to    |
//|     stop on its next heartbeat instead of sharing the balance.     |
//|                                                                    |
//| WHAT CHANGED IN v3.02                                             |
//|  6. PLAN EXPIRY COMPARES LIKE WITH LIKE.                          |
//|     `expiresAt` arrives from the server as a UTC epoch in          |
//|     milliseconds; it was compared against NowServer() * 1000 — a   |
//|     trade-server epoch. With a broker at GMT+3 every plan was      |
//|     therefore "expired" the instant it was armed, so a setup the   |
//|     desk had approved never reached the market. Expiry now uses    |
//|     the same UTC clock as the value it tests.                     |
//|  7. THE HEARTBEAT CANNOT BE POSTPONED BY LOCAL WORK.               |
//|     Sync() now runs FIRST in OnTimer(). It used to run after the   |
//|     calendar refresh and the local plan evaluation, which on a     |
//|     busy terminal could delay it by seconds — and the Desk         |
//|     reported that as a paused connection. The EA also publishes    |
//|     its heartbeat interval (clock.syncIntervalMs) so the desk can  |
//|     size its own patience from the terminal's real cadence.        |
//|  8. THE CALENDAR READ IS NO LONGER SILENTLY OPTIMISTIC.            |
//|     MT5 can return an empty array with a success code while its    |
//|     economic-calendar database is still syncing. The old code      |
//|     latched "available" on that result and the Desk printed "No    |
//|     high-impact events in the next 24 hours. The gate stays        |
//|     armed." — an all-clear it had never verified, while the        |
//|     terminal's own calendar showed three red-folder releases. The  |
//|     EA now retries with an open-ended window, publishes rawCount/  |
//|     redCount, and reports the calendar as unavailable (fail closed |
//|     for new entries) when the read returns nothing at all.         |
//|                                                                    |
//| WHAT CHANGED IN v3.03                                             |
//|  9. (REVERSED IN v3.08 — SEE BELOW.) The link used to be saved in  |
//|     the terminal's common Files folder and restored at startup, so |
//|     closing MT5, closing the browser or a server redeploy silently |
//|     resumed the connection. v3.08 ends that: the token lives in    |
//|     memory only, MT5 closing ends the link, and reconnecting needs |
//|     a new pairing code. The note is kept because the failure it    |
//|     answered — a 5-second                                    |
//|       HTTP 401 ... Unknown or expired pairing code                 |
//|     loop over a code nobody had rotated — is still worth not       |
//|     re-introducing: a refusal is printed once and spaced out.      |
//| 10. A REFUSED TOKEN NO LONGER MEANS A BLIND RETRY LOOP.            |
//|     A definitive 401 clears this terminal's token, prints ONE line |
//|     saying what to do, and backs off to a slow re-pair cadence     |
//|     instead of hammering the server five times a second.           |
//| 11. THE CALENDAR READ COVERS THE DAY THE DESK DESCRIBES.           |
//|     The Desk lists the last 12 hours of red-folder releases and    |
//|     the next 24; the EA only ever fetched the next two. The        |
//|     terminal's own calendar could show three releases for today    |
//|     while the Desk showed none. The window is now 12 h back to     |
//|     24 h ahead, and the range actually read is published on the    |
//|     wire so the Desk can show what it covered.                     |
//| 12. INSTANCES ARE IDENTIFIED.                                      |
//|     A second chart (or a restarted EA) reporting a lower sequence  |
//|     counter looked like "the terminal restarted", which cleared    |
//|     armed plans and dropped the setup the user had just approved.  |
//|     Each instance now identifies itself, so the Desk re-sends      |
//|     armed plans to a new instance instead of discarding them.      |
//|                                                                    |
//| WHAT CHANGED IN v3.04                                             |
//| 13. TIMESTAMPS NO LONGER TRUST THE MACHINE CLOCK.                  |
//|     v3.00-3.03 derived the UTC offset from TimeGMT() — the         |
//|     computer's clock. A machine 51 s behind produced a 51 s skew   |
//|     warning on the Desk even though the Desk corrected every age.  |
//|     The EA now LEARNS the true broker-vs-UTC offset from the       |
//|     platform server's own clock (the `serverTime` field of every    |
//|     sync response) and converts with that. Quote, candle, news     |
//|     and expiry timestamps are then correct no matter what the      |
//|     machine clock says, and the Desk's measured skew reads ~0.     |
//|     The machine's own clock error is still reported separately     |
//|     (`clock.computerClockSkewMs`) and printed once in the Experts  |
//|     log, so "sync NTP" is a calm, actionable note — not a red      |
//|     dashboard alarm. The Desk's skew correction remains as the      |
//|     safety net for older EAs.                                      |
//| 14. HISTORY RE-SEEDS ARE EXACT AND BOUNDED.                        |
//|     The Desk used to answer `needsHistory: true` on every heartbeat |
//|     until EVERY selected series held 60 bars, and this EA answered |
//|     by re-seeding its whole batch — 220 bars x 10 timeframes x 12  |
//|     symbols, a multi-megabyte JSON built by string concatenation —  |
//|     on EVERY beat. One series the terminal could never fill (a      |
//|     young symbol's W1, an unsupported timeframe, a halted          |
//|     contract) kept that loop alive forever: heartbeats took         |
//|     seconds, quotes aged past the Desk's freshness gate, every     |
//|     market showed STALE, and beats that outlived the WebRequest    |
//|     timeout produced the "Reconnecting - last heartbeat 33s ago"   |
//|     banner. Now the EA reports how many bars the terminal holds    |
//|     per series (`barsAvailable`), the Desk asks only for the        |
//|     `symbol|timeframe` keys it is actually short on (`history`),    |
//|     and this EA re-seeds exactly those keys. Candle JSON is also    |
//|     buffered per symbol so building it stays linear.                |
//| 15. A HUNG SERVER COSTS ONE BEAT, NOT EIGHT.                       |
//|     WebRequest is synchronous; an 8 s timeout meant one slow or      |
//|     hung response froze the heartbeat loop for eight seconds. The   |
//|     timeout is now 3 s, and any heartbeat slower than 1.5 s is      |
//|     logged to the Experts journal with its duration, so a slow      |
//|     beat is visible at the source instead of guessed from a stale  |
//|     board.                                                         |
//|                                                                    |
//| WHAT CHANGED IN v3.05                                             |
//|  19. THE MANAGEMENT PLAN SURVIVES THE FILL.                       |
//|     v3.04 armed a plan carrying breakeven, partials, a trailing    |
//|     stop, a time stop and a pyramid ladder — and then, at fill,    |
//|     set the plan inactive. Every management feature was looked up  |
//|     through FindPlanForSymbol(), which requires an ACTIVE plan, so |
//|     after the fill the position lost all of it: breakeven fell     |
//|     back to a hardcoded +1.0R/+0.2R, the trail never ran, and the  |
//|     partial/time-stop/session-flatten ladder the server computed   |
//|     executed nowhere. Management is now a state machine keyed by   |
//|     TICKET that owns its own policy copy, persists it in the       |
//|     terminal's common folder (a global variable cannot hold a      |
//|     29-field record — it stores a double, so it carries the ticket |
//|     index and the record itself lives in the file), and is         |
//|     restored after a restart.                                      |
//|  20. THE TRAIL RUNS ON THE ENTRY TIMEFRAME.                       |
//|     It used an M15 ATR for every mode: several times a scalp's     |
//|     whole risk unit, so on a scalp the trail sat BELOW the entry   |
//|     and never protected anything. Multiples are now 2.0/2.5/3.0    |
//|     (scalp/intraday/swing) on the frame the stop was placed on,    |
//|     with a 0.1-ATR minimum step and a never-loosen guarantee.      |
//|  21. INDICATOR HANDLES ARE CACHED.                                |
//|     AtrValue() created, copied and released an iATR handle on      |
//|     every call — several per tick per position. Handles are now    |
//|     created once per symbol/timeframe/period, guarded by           |
//|     BarsCalculated(), and released in OnDeinit.                    |
//|  22. PENDING ORDERS, BAR-CLOSE CONFIRMATION, AND THE TICK TAPE.    |
//|     Limit/stop entries place a real pending order with an expiry   |
//|     instead of chasing the trigger tick by tick; confirmation can  |
//|     be a closed bar rather than N ticks; and (behind an input,     |
//|     off by default because it is bytes on every beat) the chart    |
//|     symbol's tick tape rides the heartbeat so a flow agent can     |
//|     measure something other than one quote per 500 ms.             |
//| WHAT CHANGED IN v3.06                                             |
//| 24. A 401 NO LONGER DESTROYS THE SAVED LINK ON SIGHT.            |
//|     The Desk answers 401 for two different things: "this link was |
//|     revoked" (the user pressed Unlink terminal — final) and "I    |
//|     could not verify this token" (a deploy in progress, a         |
//|     database failover, the bootstrap DDL still being applied      |
//|     while the HTTP port was already open, a second replica that   |
//|     has not seen the row). v3.05 treated both as final: it emptied|
//|     the token, wrote that empty token over the link file in the   |
//|     COMMON folder — which every chart of the account shares, so   |
//|     one chart's bad answer disarmed all of them — disabled        |
//|     trading and fell back to the pairing code, which was stored   |
//|     in the same place and failed for the same reason. A few       |
//|     seconds of unreadable database therefore ended the link       |
//|     permanently, and the journal said "Unknown or expired pairing |
//|     code" over a code that was never expired. The server now      |
//|     answers 503 for "could not check" and sends a machine-readable|
//|     `code`; this EA keeps its token through four spaced            |
//|     retries before abandoning it, treats 5xx as transient, and    |
//|     discards the token ONLY for an explicit revocation.           |
//| 25. "IT DETACHED ITSELF" IS ANSWERED, NOT GUESSED.               |
//|     OnDeinit printed a bare reason number. This program never     |
//|     removes itself — there is no ExpertRemove() call and OnInit() |
//|     always returns INIT_SUCCEEDED — so every removal comes from   |
//|     the terminal, and the terminal says which one it was. The     |
//|     reason is now named (recompiled, chart symbol or timeframe    |
//|     changed, inputs changed, another account activated, template  |
//|     applied, chart or terminal closed), and the terminal-caused   |
//|     ones say plainly that nobody unlinked anything and that the   |
//|     token is retried, and a fresh code (if needed) reconnects it.  |
//| 26. SERVER PROBLEMS ARE PRINTED ONCE EVERY FIVE MINUTES.         |
//|     A 5xx on a 500 ms heartbeat would otherwise reproduce the     |
//|     journal flooding the 401 backoff was written to stop.         |
//| 23. THE v3.05 SECTION COMPILES.                                  |
//|     MQL5 resolves names in TEXT ORDER, and v3.05 was spliced in  |
//|     at the position its FUNCTIONS belong — after the plan and    |
//|     command handlers that already used PositionState and the     |
//|     PM_* constants. The published file therefore compiled        |
//|     nowhere: "declaration without type", "undeclared             |
//|     identifier 'PM_TRAIL_MULT_*'", "cannot convert parameter     |
//|     'PositionState' to 'int'". Everything the position machine   |
//|     SHARES (macros, structs, arrays) is now declared with the    |
//|     plan and link state near the top of this file, and the two   |
//|     GetTickCount64() readings are `ulong`, as the API returns    |
//|     them, instead of `long`.                                     |
//| WHAT CHANGED IN v3.07                                             |
//| 27. THE EXPERT NO LONGER DETACHES AFTER A FILL.                  |
//|     The journal showed "array out of range in 'NeurotradeBridge'  |
//|     .mq5 (2641,24)" 0.5 s after "FILLED". That line is            |
//|     PsEncode() indexing TF_NAMES[] with a position state's        |
//|     entry timeframe. The reconcile pass that adopts a fresh fill  |
//|     (plan already inactive, so the defaults branch) never set     |
//|     that timeframe or the mode, and PsEnsure() reused slots       |
//|     without clearing them, so the first save read a stale index.  |
//|     MQL5 STOPS an expert on an out-of-range error, and the chart  |
//|     shows it as removed. Now: every state field is initialised    |
//|     (PsInitBlank), the reconcile and defaults paths set a valid   |
//|     mode and timeframe, a corrupt record is repaired on decode,   |
//|     and every timeframe lookup goes through SafeTfIndex/TfNameAt. |
//|     src/lib/ea-tf-index-safety.test.ts pins all of this.         |
//|                                                                    |
//| WHAT CHANGED IN v3.08                                             |
//| 28. THE LINK LIVES ONLY AS LONG AS THIS TERMINAL.                 |
//|     v3.03 note 9 saved the token and the pairing code in the       |
//|     terminal's common Files folder and restored them at startup,   |
//|     so a closed terminal reconnected by itself with a key nobody   |
//|     had to remember. That is reversed. Nothing is written to disk  |
//|     any more: the token exists only in this process's memory, and  |
//|     a file left behind by an older build is DELETED on sight.      |
//|                                                                    |
//|     Closing MT5 (or removing the EA from its last chart) ends the  |
//|     link — OnDeinit posts /api/bridge/disconnect while the terminal|
//|     is still alive, and the server releases the link, its pairing  |
//|     code and the account claim. If MT5 is killed outright there is |
//|     no deinit to run, so the server ends the link anyway after     |
//|     120 s of silence (its heartbeat lease). Either way the         |
//|     connection is gone, and the next session starts from a NEW     |
//|     code in the Desk.                                              |
//|                                                                    |
//|     An EA reload inside the SAME running terminal (a recompile,    |
//|     an input change, a timeframe change) does not end anything:    |
//|     the link is still live, so the EA re-pairs with the code still |
//|     in its PairingCode input and the Desk keeps its state.         |
//| 29. A SPENT CODE SAYS SO.                                        |
//|     The server answers 401 with code "pairing_code_spent" when a  |
//|     code belongs to a terminal session that is over. The journal   |
//|     gets one actionable line (open the Desk, copy the NEW code),   |
//|     not a silent retry loop, and the EA keeps trying in the        |
//|     background so pasting a fresh code connects on its own.        |
//| WHAT CHANGED IN v3.09                                             |
//| 30. THE LINK ENDS ONLY WHEN THE USER SAYS SO.                     |
//|     v3.08 made the link die with the terminal session, and it did  |
//|     so for reasons the user never chose: 120 s without a heartbeat |
//|     (a sleeping laptop, a weekend, a broker maintenance window)    |
//|     revoked the token, released the account claim and cleared the  |
//|     Desk — and the terminal came back to a refusal it was allowed  |
//|     to treat as final. That is reversed, per the owner's rule.     |
//|                                                                    |
//|     A link now ends for exactly two reasons:                       |
//|       1. the user unlinks the terminal in the Desk                 |
//|          (`bridge_link_revoked` — the ONE answer that is final);   |
//|       2. the user closes MT5 (`OnDeinit`, REASON_CLOSE only, which |
//|          posts /api/bridge/disconnect).                            |
//|                                                                    |
//|     Everything else costs nothing. The token and the pairing code  |
//|     are saved per MT5 account in the terminal's common folder, so  |
//|     a reboot, an MT5 restart, an API redeploy, a database that     |
//|     could not be read or a network outage all re-adopt the SAME    |
//|     link — no new code, no user action. The saved credential is    |
//|     deleted in exactly one place: on `bridge_link_revoked`.        |
//|                                                                    |
//|     The lease no longer ends anything; the Desk shows a silent     |
//|     terminal as STALE and keeps the pairing.                       |
//| 31. STRUCTURE HAS A DEADLINE (the "1R and nothing happens" fix).   |
//|     Break-even required a confirmed structure shift, which on a    |
//|     fast frame can simply never print: the trigger was met, the    |
//|     confirmation never came, and a winning position kept its       |
//|     original stop indefinitely. `structureFallbackR` — sent by the |
//|     Desk per mode, default 0.35R, 0 = wait forever — moves the     |
//|     stop on the R trigger alone once the deadline passes, and the  |
//|     journal records that it was the deadline and not structure.    |
//|     The server's state machine implements the identical rule.      |
//| 32. NO PLAN NO LONGER MEANS NO PROTECTION.                         |
//|     A position with no plan (an EA reload between the fill and the |
//|     first sync, a manual trade, a position opened while the Desk   |
//|     was redeploying) got `partialCount = 0` and nothing else, so   |
//|     the one position in the terminal with nothing scheduled was    |
//|     the orphaned one. The default policy now carries a 1R/50%      |
//|     rung — quantised against the real broker volume exactly like   |
//|     a plan's ladder, skipped if it cannot be split — until the      |
//|     Desk pushes the owner's own policy on the next heartbeat.       |
//| 33. EVERY SETTING THE OWNER CAN SET IS ONE THE TERMINAL OBEYS.      |
//|     The Desk's auto-trader surface exposes `offsetR` and three      |
//|     trailing styles, and the EA used to read both and then ignore   |
//|     them: the break-even landed at a hard-coded 0.05R whatever the  |
//|     owner chose, and every trail was a chandelier, so picking        |
//|     "structure" or "fixed points" changed nothing in MT5. Both now  |
//|     come from the plan (and from `set_management`, so a change      |
//|     applies to OPEN positions too), and the record carries the      |
//|     mode so a restart cannot quietly revert it.                     |
//| 34. THE MINIMUM TRAIL STEP IS THE OWNER'S, NOT OURS.                |
//|     `minStepAtr`/`stepPoints` are settings; the terminal used to    |
//|     force its own 0.1xATR floor on top of them, which silently      |
//|     widened a deliberately tight trail. The Desk folds the two      |
//|     knobs into one step before sending; the built-in floor now      |
//|     applies only to a position with no pushed policy at all.        |
//| INSTALL                                                            |
//|  1. Put this file in MQL5/Experts and compile it in MetaEditor.   |
//|  2. MT5 -> Tools -> Options -> Expert Advisors -> enable          |
//|     "Allow WebRequest for listed URL" and add the exact public     |
//|     ServerUrl origin, for example https://desk.example.com.       |
//|  3. Attach to ANY chart. Set ServerUrl and PairingCode from the    |
//|     NeuroTrade Desk bridge dialog.                                 |
//|                                                                    |
//| IMPORTANT: this EA intentionally returns INIT_SUCCEEDED even when |
//| the URL/code is missing or a network request fails. It remains on |
//| the chart, reports the reason in the Experts/Journal log, and     |
//| retries pairing when configuration becomes valid. This prevents a |
//| transient WebRequest failure from making the EA appear to "not     |
//| attach" to a chart.                                                |
#property copyright "NeuroTrade AI"
#property version   "3.09"
#property strict

// The version this EA reports on the wire.
//
// `#property version` must be a literal, so the value necessarily appears
// twice; the integrity test asserts the two agree. v3.05 shipped with the
// PAIRING body reporting 3.05 and the HEARTBEAT body still reporting 3.04 — and
// the heartbeat is the one the Desk stores (`desk.terminal.eaVersion`), so the
// Desk's "this terminal is running an older EA" check could never tell a v3.05
// terminal from a v3.04 one.
#define EA_VERSION "3.09"

#include <Trade/Trade.mqh>

//--- Connection and coverage ---------------------------------------------------
input string ServerUrl                 = "";     // Platform origin only; do not append /api
input string PairingCode               = "";     // One-time code from the Desk
input int    SyncIntervalMs            = 500;    // Heartbeat; 250-10000 ms (ticks push every beat)
input int    SymbolsPerHeartbeat       = 12;     // CANDLE batch per beat, not a selection cap
input bool   SendAllQuotesEachBeat     = true;   // Stream every selected symbol's tick every beat
input int    HistoryBars               = 220;    // Initial bars per selected symbol/timeframe
input int    DeltaBars                 = 4;      // Forming + recent bars after seed

//--- Execution guards ----------------------------------------------------------
input int    MagicNumber               = 7781001;
input bool   AllowLiveAccount          = false;  // Independent real-account safety switch
input double MaxDailyLossPct           = 3.0;
input int    StaleAfterSec             = 30;    // Reject a tick older than this (quote freshness)
input int    ServerSilenceSec          = 120;   // Server silent this long -> local trading pauses
input bool   UseEconomicCalendar       = true;
input int    NewsBlackoutBeforeMinutes = 30;
input int    NewsBlackoutAfterMinutes  = 15;
input bool   VerboseLog                = true;

//--- v3.05 execution and management --------------------------------------------
input bool   UsePendingOrders          = true;   // Place limit/stop entries as real pending orders
input bool   ConfirmOnBarClose         = true;   // "confirm" entries wait for a closed bar, not N ticks
input bool   StreamTicks               = false;  // Send the chart symbol's tick tape (WP4D; bytes per beat)
input int    TickStreamPerSymbol       = 40;     // Most recent ticks per symbol per heartbeat
input int    MaxPendingOrderMinutes    = 60;     // Hard local cap on a pending order's life

#define MAX_PLANS      32
#define MAX_SEEN_CMDS  512
#define NEWS_REFRESH_SECONDS 60
// The Desk lists red-folder releases from the last 12 hours and the next 24.
// The EA must fetch the SAME span: fetching only the next two hours meant the
// terminal's own calendar could show three red-folder releases for the day
// while the Desk showed none — and the Desk's window is the one the news gate
// reasons about.
#define NEWS_LOOKBEHIND_SECONDS (12 * 60 * 60)
#define NEWS_LOOKAHEAD_SECONDS  (24 * 60 * 60)

// M2/M3 exist so a scalp book can be analysed on 3-minute-and-below structure;
// W1 so a swing book can see the weekly candle it is actually held against.
#define TF_COUNT 10
ENUM_TIMEFRAMES TF_LIST[TF_COUNT] = {PERIOD_M1, PERIOD_M2, PERIOD_M3, PERIOD_M5,
                                     PERIOD_M15, PERIOD_M30, PERIOD_H1, PERIOD_H4,
                                     PERIOD_D1, PERIOD_W1};
string TF_NAMES[TF_COUNT] = {"M1", "M2", "M3", "M5", "M15", "M30", "H1", "H4", "D1", "W1"};

/** Index of a timeframe name in TF_LIST, or -1 when it is not a broker frame. */
int TfIndexFromName(const string name)
{
   for(int i = 0; i < TF_COUNT; i++) if(TF_NAMES[i] == name) return i;
   return -1;
}

/**
 * v3.07: every timeframe index that reaches TF_NAMES[] / TF_LIST[] goes through
 * these helpers. An index that is negative or past TF_COUNT is an
 * "array out of range" runtime error, and MQL5 STOPS the expert on that error —
 * the chart shows it as removed, which is the "MT5 bot detached itself after a
 * trade" bug. Nothing here can index out of bounds.
 */
#define TF_FALLBACK_INDEX 1   // M2, the scalp default (same as PmTfIndex)

int SafeTfIndex(const int index)
{
   return (index >= 0 && index < TF_COUNT) ? index : TF_FALLBACK_INDEX;
}

string TfNameAt(const int index)
{
   return TF_NAMES[SafeTfIndex(index)];
}

/** The entry timeframe a position of a given mode gets when no plan supplies one. */
int TfIndexForMode(const int mode)
{
   return (mode == 0 ? 1 : (mode == 1 ? 4 : 6)); // M2 / M15 / H1
}

struct ArmedPlan
{
   string id;
   string symbol;
   bool   isBuy;
   double trigger;
   double invalidate;
   double sl;
   double tp;
   double lots;
   double riskPoints;
   // v3.05: what the position manager needs, captured AT ARM TIME rather than
   // looked up at fill time (the defect this version fixes).
   int    entryType;         // 0 market, 1 limit, 2 stop
   bool   barConfirm;        // wait for a CLOSED bar beyond the trigger
   int    mode;              // 0 scalp, 1 intraday, 2 swing
   int    entryTfIndex;      // index into TF_LIST
   double costPrice;         // round-trip cost in price units
   double maxSpreadPoints;
   double maxSlippagePoints;
   long   expiresAt;
   int    confirmTicks;
   int    confirmCount;
   ulong  pendingTicket;     // non-zero while a pending order is working
   long   pendingPlacedAt;
   double beTriggerR;
   double beOffsetR;
   bool   beStructure;
   double beFallbackR;   // structure deadline, R past the trigger (0 = never)
   int    partialCount;
   double partialAtR[4];
   double partialPct[4];
   double trailMult;
   double trailActivateR;
   double trailStepPoints;
   int    trailPeriod;
   bool   trailEnabled;
   int    trailMode;         // 0 = ATR chandelier, 1 = structure, 2 = fixed points
   int    timeStopBars;
   int    pyramidMaxAdds;
   double pyramidAddAtR;
   double pyramidSizeRatio;
   bool   pyramidRequireBe;
   bool   flatBeforeClose;
   bool   active;
};

CTrade trade;
ArmedPlan g_plans[MAX_PLANS];
string    g_seenCmds[MAX_SEEN_CMDS];
int       g_seenCount = 0;

string    g_token = "";
long      g_seq = 0;
datetime  g_lastOk = 0;
datetime  g_nextPairAttempt = 0;
bool      g_tradingEnabled = false;
bool      g_liveTradingEnabled = false;
// ── The link SURVIVES a restart, and ends only when the user says so ─────────
// v3.09: the token and the pairing code are saved per MT5 account in the
// terminal's common folder (see SaveLinkFile). A reboot, a closed laptop, an
// API redeploy, a database that could not be read, a rejected heartbeat — none
// of them end the link, and none of them need the user to fetch a new code: the
// EA re-attaches on the credential it already holds.
//
// The credential is cleared in exactly one place: when the Desk answers
// `bridge_link_revoked`, which is the user pressing Unlink in the Desk. The
// other permitted ending is the user closing MT5, and that is the only reason
// that posts /api/bridge/disconnect (see LinkEndsWithThisRun).
//
// Within one running terminal the link also survives an EA reload: MT5 calls
// OnDeinit/OnInit for a recompile, an input change or a symbol/timeframe
// change, and the link itself is untouched.
// A definitive refusal (401) must not be retried every five seconds forever:
// that is what buried the real reason in thousands of identical journal lines.
int       g_pairAttemptDelaySeconds = 5;
bool      g_refusalPrinted = false;
// Identity of THIS instance (one OnInit). The Desk needs it to tell "a second
// chart" from "the same EA restarted": the former must be handed the armed
// plans again, the latter means the terminal's local plans are genuinely gone.
string    g_instanceId = "";
double    g_dayStartEquity = 0;
int       g_dayStamp = -1;
string    g_results = "";
// Status and server-supplied `error` of the most recent HTTP call. Pairing
// needs them to tell "this account is already connected elsewhere" (409) apart
// from an ordinary network failure, which must keep retrying quickly.
int       g_lastHttpStatus = 0;
string    g_lastHttpError = "";
// Server-supplied machine-readable `code` of the most recent HTTP call.
// v3.06: this is what lets the EA tell a FINAL refusal from an unverified one.
//   "bridge_link_revoked"     the user pressed "Unlink terminal" — the link is
//                             dead and may be discarded;
//   "pairing_code_spent"      v3.08: this code belonged to a terminal session
//                             that is over — the user needs a NEW code;
//   "pairing_code_unknown"    no such code (rotated, or the terminal it paired
//                             was closed and the code was deleted with it);
//   "bridge_token_unknown"    no such link — unverified, so it is retried;
//   "bridge_store_unavailable" the server could not read its own link store
//                             (503) — nothing was revoked, retry soon;
//   ""                        an older server that only sent a bare 401.
string    g_lastHttpCode = "";

// ── v3.06: a 401 no longer destroys the link on sight ───────────────────────
// v3.05 treated EVERY 401 as final: it emptied g_token (and, in that build,
// wrote the empty token over a link file in the terminal's common folder — which every
// chart of this account shared, so one chart's bad response disarmed all of
// them), disabled trading and fell back to the pairing code. But a 401 is also
// what the server answered
// when it simply could not READ its link store: a deploy in progress, a
// database failover, the bootstrap DDL still being applied while the HTTP port
// was already open, or a second replica that had not seen the row. The code was
// stored in the same place, so it failed for the same reason, and the terminal
// ended up permanently disconnected by a few seconds of unreadable database.
//
// The server now says which of the two happened (`code`, and 503 for "could not
// check"). This is the terminal's half: an unverified refusal is retried a few
// times, spaced out, before the credential is abandoned — and only an explicit
// revocation clears it immediately. (v3.08 keeps all of this: a 503 while MT5 is
// open must never cost the terminal the link it is holding.)
#define TOKEN_REFUSAL_GRACE   4     // unverified 401s tolerated before the token is dropped
#define TOKEN_RETRY_SECONDS   15    // spacing between those retries (quiet, not a hammer)
int       g_tokenRefusals = 0;      // consecutive unverified refusals of the current token
datetime  g_nextTokenRetry = 0;     // earliest moment the token may be presented again
datetime  g_lastStoreWarnAt = 0;    // rate limit for "the server could not verify" lines

// Dynamically sized: users may select any number of instruments. Data is sent
// in rotating batches so an enormous selection does not create a giant request
// or force MT5 to freeze. The Desk marks a symbol stale until its next live
// batch and will never analyse or execute it while stale.
string    g_symbols[];
bool      g_seeded[];       // flattened [symbolIndex * 7 + timeframeIndex]
int       g_batchCursor = 0;

// Local copy of high-importance events. If the MT5 calendar cannot be read,
// this remains unavailable and TradingAllowed fails closed for new entries.
bool      g_calendarAvailable = false;
datetime  g_lastCalendarCheck = 0;
datetime  g_newsTimes[];
// Rows the MT5 calendar returned vs rows kept, published on the wire so the
// desk can tell "nothing is scheduled" from "the read returned nothing".
int       g_rawCount = 0;
int       g_redCount = 0;
// The UTC range actually read from the calendar, published on the wire so the
// Desk can show what "0 red-folder events" is actually describing.
long      g_calendarFromMs = 0;
long      g_calendarToMs = 0;
// The heartbeat interval this EA is actually running with, sent in `clock` so
// the desk sizes its own patience from the terminal's contract instead of
// assuming a cadence: a slow heartbeat must not read as a dead terminal.
int       g_syncIntervalMs = 500;
string    g_newsCurrencies[];
string    g_newsCountries[];
string    g_newsNames[];

// ── Learned UTC reference (v3.04) ────────────────────────────────────────────
// The trade-server clock vs TRUE UTC, learned from the platform server's own
// clock (the `serverTime` field of every sync response). Until the first
// successful sync arrives, the computer clock (TimeGMT) is the fallback —
// v3.03 behaviour — so a misclocked machine degrades to a skew warning for one
// beat instead of wrong data forever. Every timestamp this EA emits is
// converted with this offset, so the Desk's measured skew reads ~0 even when
// the machine clock is off.
long      g_brokerUtcOffsetSec   = 0;
bool      g_brokerClockLearned   = false;
// The machine's OWN clock vs true UTC, reported separately (`computerClockSkewMs`)
// so the Desk can say "sync NTP" calmly instead of alarming the dashboard.
long      g_computerClockSkewMs  = 0;
bool      g_clockWarningPrinted  = false;

//+------------------------------------------------------------------+
//| v3.05 position-manager SHARED STATE                              |
//| Declared HERE, not beside the machine that uses it.              |
//+------------------------------------------------------------------+
// WHY: MQL5's preprocessor is single-pass and the compiler resolves names in
// TEXT ORDER. A `#define`, a `struct` or a global referenced ABOVE its
// declaration is an error — "undeclared identifier", "declaration without
// type", "cannot convert parameter" — never a forward reference. (C++ accepts
// some of these; MQL5 does not.)
//
// v3.05 was appended to this file at the position its FUNCTIONS belong in —
// after `ArmPlanFromJson()` and the command handlers, which already used
// `PositionState` and the `PM_*` constants — so the published EA did not
// compile for anybody:
//
//   int ParsePartials(const string json, PositionState &ps)
//      -> declaration without type / comma expected
//   ParsePartials(management, policyCarrier)  [ArmPlanFromJson]
//      -> cannot convert parameter 'PositionState' to 'int'
//   PM_TRAIL_MULT_SCALP / _INTRADAY / _SWING
//      -> undeclared identifier
//
// So every macro, type and array the position manager SHARES with the rest of
// the EA lives here; only its functions stay in the v3.05 section below (see
// "POSITION MANAGEMENT STATE MACHINE"). src/lib/ea-source-integrity.test.ts
// pins this ordering, so a re-splice cannot reintroduce it.

#define MAX_POS_STATES   128
#define MAX_ATR_HANDLES  48
#define MAX_TICK_BUF     4000
#define MAX_MGMT_EVENTS  64
// MQL5 global variables hold a DOUBLE only. A 29-field position record cannot
// fit in one, so the durable record lives in the terminal's COMMON files
// folder (shared by every chart, exactly like the link file) and a global
// variable is kept as the TICKET INDEX + freshness mirror. That is what makes
// `PsRestoreAll()` able to find every position this EA manages after a
// restart without scanning the filesystem.
#define PS_PREFIX        "NTPS_"
#define PS_DIR           "Neurotrade\\pos\\"

// Chandelier multiples on the ENTRY timeframe's ATR (v3.05).
#define PM_TRAIL_MULT_SCALP    2.0
#define PM_TRAIL_MULT_INTRADAY 2.5
#define PM_TRAIL_MULT_SWING    3.0
#define PM_TRAIL_MIN_STEP_ATR  0.1
#define PM_BREAKEVEN_PROFIT_R  0.05
// The structure deadline (see ManageOnePosition). R past the break-even trigger
// after which an unconfirmed structure no longer blocks the stop move. The Desk
// sends its own value per plan/mode; this is the default for a policy that
// predates the field — and it is the same number the server's state machine
// uses (BREAKEVEN_STRUCTURE_FALLBACK_R), so the two never disagree.
#define PM_BREAKEVEN_STRUCTURE_FALLBACK_R 0.35
#define PM_MODIFY_COOLDOWN_MS  1500
#define PM_MODIFY_COOLDOWN_R   0.5
#define PM_TIME_STOP_PROGRESS_R 0.5
#define PM_TIME_STOP_MFE_R      1.0
#define PM_FLAT_BEFORE_CLOSE_MIN 15
#define PM_SWING_LOOKBACK       2
// A modify that fails is retried on a later evaluation with this back-off,
// never in a tight loop: OrderSend() is synchronous and a rejected modify
// retried immediately is a rejected modify.
#define PM_RETRY_BACKOFF_MS     2000
#define PM_MAX_RETRY            4

/** One managed position. Mirrors position-manager.ts `PositionState` 1:1. */
struct PositionState
{
   ulong           ticket;
   string          planId;
   string          symbol;
   bool            isBuy;
   int             mode;            // 0 scalp, 1 intraday, 2 swing
   int             entryTfIndex;    // index into TF_LIST
   double          entry;
   double          initialSl;
   double          sl;
   double          tp;
   double          riskPrice;
   double          volume;
   double          initialVolume;
   long            openedAt;        // UTC epoch ms
   int             barsSinceEntry;
   double          progressR;
   double          mfeR;
   double          bestPrice;
   string          stage;
   int             partialsDone;
   bool            beDone;
   bool            trailArmed;
   int             pyramidAdds;
   double          closedVolume;
   double          costPrice;
   double          atrEntry;
   long            lastModifyAt;
   double          lastModifyR;
   long            retryAfter;
   int             retryCount;
   // ── Policy: the position's own copy. Never looked up in g_plans. ──────────
   double          beTriggerR;
   double          beOffsetR;
   bool            beStructure;
   double          beFallbackR;   // structure deadline, R past the trigger (0 = never)
   int             partialCount;
   double          partialAtR[4];
   double          partialPct[4];
   bool            trailEnabled;
   int             trailMode;    // 0 = ATR chandelier, 1 = structure, 2 = fixed points
   double          trailMult;
   double          trailActivateR;
   double          trailStepPoints;
   int             trailPeriod;
   bool            timeStopEnabled;
   int             timeStopBars;
   bool            pyramidEnabled;
   int             pyramidMaxAdds;
   double          pyramidAddAtR;
   double          pyramidSizeRatio;
   bool            pyramidRequireBe;
   bool            flatBeforeClose;
};

struct AtrHandleRec
{
   string          symbol;
   ENUM_TIMEFRAMES tf;
   int             period;
   int             handle;
};

struct TickRec
{
   string          symbol;
   long            ts;
   double          bid;
   double          ask;
};

PositionState g_ps[MAX_POS_STATES];
int           g_psCount = 0;
AtrHandleRec  g_atrHandles[MAX_ATR_HANDLES];
int           g_atrHandleCount = 0;
TickRec       g_ticks[MAX_TICK_BUF];
int           g_tickCount = 0;
string        g_mgmtEvents[MAX_MGMT_EVENTS];
int           g_mgmtEventCount = 0;

//+------------------------------------------------------------------+
//| v3.06: diagnostics for a link the server could not verify        |
//+------------------------------------------------------------------+
/**
 * Print a store/server problem at most once per five minutes.
 *
 * A 503 (or an unverified 401) is retried every few seconds by design, so an
 * unguarded Print here would fill the Experts journal the same way the old
 * five-second 401 loop did — thousands of identical lines burying the reason.
 * The first occurrence is always printed; later ones are five minutes apart.
 */
void WarnServerOnce(const string message)
{
   datetime now = NowServer();
   if(g_lastStoreWarnAt != 0 && now - g_lastStoreWarnAt < 300) return;
   g_lastStoreWarnAt = now;
   Print("NeurotradeBridge: ", message);
}

/**
 * Name the reason MT5 stopped this expert.
 *
 * WHY: "the EA detached itself from the chart and I did not remove it" is
 * unanswerable from a bare `stopped (reason 4)`. The EA never removes itself —
 * it has no ExpertRemove() call and OnInit() always returns INIT_SUCCEEDED, so
 * it cannot fail to attach — which means every removal comes from the terminal,
 * and the terminal always says which of them it was. Translating the code turns
 * a mystery into a one-line answer in the journal.
 *
 * The constants are MQL5's `REASON_*` (ENUM_DEINIT_REASON), and their VALUES are
 * the ones in the MQL5 reference — they are not the MQL4 numbers, and they do
 * not start at 1:
 *
 *   0 REASON_PROGRAM      ExpertRemove() was called — this EA never calls it
 *   1 REASON_REMOVE       removed from the chart
 *   2 REASON_RECOMPILE    MetaEditor rebuilt the .ex5 under a running chart;
 *                         MT5 re-attaches the EA immediately and the link —
 *                         which lives in the running terminal, not on disk —
 *                         continues with no new pairing code
 *   3 REASON_CHARTCHANGE  the chart symbol or timeframe changed, so MT5
 *                         restarts the expert
 *   4 REASON_CHARTCLOSE   the chart was closed
 *   5 REASON_PARAMETERS   the inputs were changed in the properties dialog
 *   6 REASON_ACCOUNT      another account was activated, or the terminal
 *                         reconnected after an account-settings change. The
 *                         link belongs to the account it paired, so this one
 *                         ENDS it (see LinkEndsWithThisRun) — the terminal is
 *                         now a different account and must pair again
 *   7 REASON_TEMPLATE     a different chart template was applied
 *   8 REASON_INITFAILED   OnInit() returned non-zero — not reachable in this
 *                         build, which always returns INIT_SUCCEEDED
 *   9 REASON_CLOSE        the terminal was closed
 *
 * KNOWN MT5 QUIRK: a symbol or timeframe change is sometimes reported as
 * REASON_REMOVE instead of REASON_CHARTCHANGE, so neither of those two means a
 * person acted. Both are spelled out below rather than blamed on the user.
 *
 * WHICH REASONS END THE LINK (v3.08): CHARTCLOSE, CLOSE, INITFAILED and
 * ACCOUNT — the cases where this chart, this terminal or this account is
 * finished. NOT REASON_REMOVE, precisely because of that quirk: disconnecting
 * on it would drop the link every time a user changed the chart's timeframe.
 * An EA that was genuinely removed by hand leaves no heartbeats behind, so the
 * server releases that link on its own after the heartbeat lease expires.
 */
string DeinitReasonText(const int reason)
{
   if(reason == REASON_PROGRAM)     return "the program ended by itself (an ExpertRemove call — this EA never makes one)";
   if(reason == REASON_REMOVE)      return "the EA was removed from the chart — by hand, or by MT5, which also reports some symbol/timeframe changes this way";
   if(reason == REASON_RECOMPILE)   return "MetaEditor recompiled the EA, so MT5 restarted it on this chart";
   if(reason == REASON_CHARTCHANGE) return "the chart symbol or timeframe changed, so MT5 restarted the EA";
   if(reason == REASON_CHARTCLOSE)  return "the chart was closed";
   if(reason == REASON_PARAMETERS)  return "the EA inputs were changed in the properties dialog";
   if(reason == REASON_ACCOUNT)     return "another trading account was activated, or the terminal reconnected after an account-settings change";
   if(reason == REASON_TEMPLATE)    return "a different chart template was applied";
   if(reason == REASON_INITFAILED)  return "initialisation failed (OnInit returned a non-zero value)";
   if(reason == REASON_CLOSE)       return "the terminal was closed";
   return "an unrecognised reason (" + IntegerToString(reason) + ")";
}

/** True when MT5 — not the user, and not this program — restarted the expert. */
bool DeinitWasTerminalRestart(const int reason)
{
   return (reason == REASON_RECOMPILE || reason == REASON_CHARTCHANGE ||
           reason == REASON_PARAMETERS || reason == REASON_ACCOUNT ||
           reason == REASON_TEMPLATE || reason == REASON_CLOSE);
}

/**
 * Does this shutdown mean the terminal session is over?
 *
 * v3.08: if it does, the link is released NOW (POST /api/bridge/disconnect) so
 * the Desk and the next session both see a clean end — the user gets a new
 * pairing code instead of inheriting one that is already spent.
 *
 * REASON_REMOVE is deliberately NOT here. MT5 reports some symbol/timeframe
 * changes with that code instead of REASON_CHARTCHANGE (see above), and ending a
 * live link because somebody switched from H1 to M15 would be worse than the
 * problem it solves. An EA removed by hand stops beating, and the server's
 * heartbeat lease ends the link within BRIDGE_LINK_LEASE_MS on its own.
 *
 * REASON_ACCOUNT IS here: the terminal is now a different account, and this
 * link — which is bound to one account and holds that account's claim — cannot
 * be carried over.
 */
/**
 * Does this deinit mean the operator is finished with the terminal?
 *
 * ── v3.09: ONE reason, not four ─────────────────────────────────────────────
 *
 * v3.08 sent `/disconnect` for CHARTCLOSE, CLOSE, INITFAILED and ACCOUNT as
 * well. Every one of those is something the USER did to the chart, not a
 * decision to end the connection: closing one chart of a two-chart terminal,
 * switching accounts to check something, even an attach that MT5 aborted. The
 * owner's rule is explicit — the link ends when the user unlinks it in the Desk
 * or when they close MT5, and nothing else.
 *
 * So only REASON_CLOSE (the terminal itself going down) tells the Desk the
 * session is over. Everything else leaves the link alone; if the EA really is
 * gone, the Desk shows the terminal as stale and keeps the pairing, and the
 * next attach resumes on the saved link without the user fetching a new code.
 */
bool LinkEndsWithThisRun(const int reason)
{
   return (reason == REASON_CLOSE);
}

//+------------------------------------------------------------------+
//| Lifecycle                                                         |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetAsyncMode(false);
   trade.SetDeviationInPoints(10);
   ResetDayBaseline();
   RefreshCalendar(true);

   int interval = (int)MathMax(500, MathMin(10000, SyncIntervalMs));
   g_syncIntervalMs = interval;
   EventSetMillisecondTimer(interval);

   // A fresh identity per attach. Two charts (or a reloaded EA) are then
   // distinguishable, which is what lets the Desk hand armed plans back to a
   // terminal that has none instead of assuming the whole terminal restarted.
   MathSrand((int)(TimeLocal() + (long)GetTickCount()));
   g_instanceId = StringFormat("%s-%I64d-%d",
                               AccountInfoString(ACCOUNT_SERVER),
                               AccountInfoInteger(ACCOUNT_LOGIN),
                               MathRand());

   // v3.09: re-adopt the saved link, if this account has one.
   //
   // This is what makes a reboot, an MT5 restart, an API redeploy or a
   // transient network failure cost nothing: the terminal holds the credential
   // the Desk issued, so it re-attaches to the SAME link instead of asking the
   // user for a new pairing code. The credential is cleared in exactly one
   // place — when the Desk answers that the link was revoked (the user pressed
   // Unlink), which is the only answer that is final.
   {
      string savedToken = "", savedCode = "";
      if(LoadLinkFile(savedToken, savedCode))
      {
         g_token = savedToken;
         Print("NeurotradeBridge: resuming the saved link for account ",
               IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)), "@", AccountInfoString(ACCOUNT_SERVER),
               ". Nothing to do — the Desk keeps its pairing until you unlink it here or close MT5.");
      }
   }

   // v3.05: rebuild management state for every position this terminal already
   // manages. The record lives in the terminal's common folder, so a restart,
   // a reconnect or an EA reload resumes mid-trade management instead of
   // leaving open positions unmanaged.
   PsRestoreAll();

   // v3.06: a fresh instance starts with no opinion about the token it is
   // about to restore — the refusal counter belongs to the previous instance.
   g_tokenRefusals = 0;
   g_nextTokenRetry = 0;
   g_lastStoreWarnAt = 0;

   Print("NeurotradeBridge v3.09 attached. Configure ServerUrl and PairingCode in EA Inputs; ",
         "pairing will retry without removing the EA from this chart.");
   if(StringLen(NormalisedServerUrl()) == 0)
      Print("NeurotradeBridge: ServerUrl is empty. Set it to the public Desk origin.");
   if(StringLen(EffectivePairingCode()) == 0)
      Log("Waiting for PairingCode input. Open Desk -> Link MT5 to generate one.");
   else
      Print("NeurotradeBridge: this session connects with the pairing code in the PairingCode input. The link ",
            "lives only while this terminal is open — closing MT5 ends it, and the next session needs a NEW ",
            "code from Desk -> Link MT5.");

   // Never fail initialization simply because pairing is not ready yet.
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   // v3.05: flush the management state of every open position, then release the
   // cached indicator handles. A handle created and never released leaks in the
   // terminal for the life of the chart.
   for(int i = 0; i < g_psCount; i++)
      if(PositionSelectByTicket(g_ps[i].ticket)) PsSave(g_ps[i]);
   ReleaseAtrHandles();
   // v3.06: name the reason. "It detached itself" is otherwise unanswerable —
   // this program never removes itself, so whatever happened came from the
   // terminal, and the terminal says which thing it was.
   Print("NeurotradeBridge: stopped — ", DeinitReasonText(reason), ".");
   // v3.08: the terminal session may be over. Say so while there is still a
   // process to make the request from — the server then releases the link, its
   // pairing code and this account's claim immediately, instead of waiting out
   // the heartbeat lease. Best effort: MT5 does not wait for an expert's
   // shutdown, and a hard kill runs nothing at all, which is why the lease
   // exists.
   if(LinkEndsWithThisRun(reason))
      DisconnectBridge("the terminal or chart was closed");
   else if(DeinitWasTerminalRestart(reason))
      Print("NeurotradeBridge: MT5 restarted this expert on its own; nobody unlinked it. The link belongs to this ",
            "running terminal and is still alive, so the EA re-attaches and continues on the same pairing code.");
}

// The chart tick is the fastest path for the chart's symbol; OnTimer below
// evaluates all plan symbols as well, so attaching to EURUSD can still manage
// an XAUUSD/BTCUSD plan safely.
void OnTick()
{
   // v3.05 (WP4D): the chart symbol's tick tape. StreamTicks is off by default
   // because it is bytes on every heartbeat; the flow agent needs it on.
   if(StreamTicks)
   {
      MqlTick tick;
      if(SymbolInfoTick(_Symbol, tick)) PushTick(_Symbol, tick);
   }
   ManageOpenPositions();
   EvaluatePlans();
}

void OnTimer()
{
   // HEARTBEAT FIRST.
   //
   // The desk's freshness window is measured from the moment this call lands,
   // so nothing local is allowed to delay it. It used to run after the calendar
   // refresh and the local plan evaluation, and on a busy terminal — history
   // being copied, a trade modification round-trip — that could postpone the
   // heartbeat by whole seconds. The desk, whose own window was thirty seconds,
   // then announced "Quotes and agent entries are paused" for what was only a
   // slow timer tick.
   //
   // v3.04: the beat is timed. A heartbeat slower than 1.5 s is logged with its
   // duration, so a slow beat (payload build, server response) is visible in
   // the Experts journal instead of guessed from a stale board.
   //
   // GetTickCount64() returns `ulong`. Holding it in a `long` (as v3.05 did) is
   // a narrowing conversion MetaEditor reports as "possible loss of data due to
   // type conversion from 'ulong' to 'long'", and a tick counter that wrapped
   // would read as a huge negative duration. The elapsed time is unsigned.
   ulong beatStart = GetTickCount64();
   // v3.06: while an unverified refusal or a 5xx is being waited out, do not
   // present the token on every beat. The token is kept (only an explicit
   // revocation or a spent retry budget gives it up), but a 500 ms heartbeat
   // must not become a 500 ms 401 loop — that flooding is exactly what the
   // original backoff was written to stop — and a struggling server must not be
   // handed a full payload twice a second.
   bool waitingForLinkRetry = (NowServer() < g_nextTokenRetry);
   if(g_token == "")
      TryPair();
   else if(!waitingForLinkRetry)
      Sync();
   ulong beatMs = GetTickCount64() - beatStart;
   if(beatMs > (ulong)1500)
      Log(StringFormat("heartbeat took %d ms — payload build or server response was slow; quotes may age past the freshness gate", (int)beatMs));

   RollDayBaselineIfNeeded();
   RefreshCalendar(false);
   ManageOpenPositions();
   EvaluatePlans();
}

//+------------------------------------------------------------------+
//| The link (terminal-side)                                          |
//|                                                                  |
//| NOTHING IS WRITTEN TO DISK. The bearer token exists only in this  |
//| process's memory and dies with it, which is the point: the link    |
//| lives exactly as long as the MT5 terminal that created it.        |
//|                                                                  |
//| Reconnecting is therefore a deliberate act — the user opens the   |
//| Desk, copies a NEW pairing code into PairingCode, and that code is |
//| valid only for the terminal session it pairs. Closing MT5 ends the |
//| link here (OnDeinit -> DisconnectBridge) and on the server (the    |
//| heartbeat lease, for a terminal that never got to say goodbye).    |
//|                                                                  |
//| An EA reload INSIDE one running terminal is not a new session:     |
//| MT5 calls OnDeinit/OnInit for a recompile, an input change or a    |
//| symbol/timeframe change, the link is untouched, and the EA re-pairs|
//| with the code still in its PairingCode input — no user action and  |
//| no interruption.                                                   |
//+------------------------------------------------------------------+

/**
 * ── THE SAVED LINK (v3.09) ──────────────────────────────────────────────────
 *
 * One file per MT5 account in the terminal's common Files folder, holding the
 * bearer token and the pairing code this terminal last connected with.
 *
 * WHY IT IS BACK, AND WHY IT IS DIFFERENT FROM v3.03's VERSION:
 *
 * The owner's rule is that a link ends for exactly two reasons — the user
 * unlinks the terminal in the Desk, or the user closes MT5. Everything else
 * (a reboot, a closed laptop, an API redeploy, a store that could not be read,
 * a rejected heartbeat) must not cost the user their connection, and without a
 * credential on disk the terminal cannot re-adopt a link it already owns: the
 * server has nothing to recognise it by, and the user is sent to the Desk for a
 * new code. That is what the report describes as "the desk disconnects itself
 * from the MT5 at times".
 *
 * What is different from v3.03: the file is deleted the moment the Desk says
 * the link was REVOKED, and that answer is the only one that clears it. It is
 * never used to keep a link alive that the server has ended — the server only
 * ends a link when the user unlinks it, so a saved credential can only ever
 * re-adopt a link that is still the user's.
 *
 * The file is written with the token, so it is a credential: it lives in the
 * terminal's COMMON folder (per terminal, not per chart), and it is the reason
 * the EA can come back from a restart without the user touching anything.
 */
#define LINK_DIR  "Neurotrade\\"

string LinkFileName()
{
   string account = StringFormat("%I64d_%s",
                                 AccountInfoInteger(ACCOUNT_LOGIN),
                                 AccountInfoString(ACCOUNT_SERVER));
   string safe = "";
   for(int i = 0; i < StringLen(account); i++)
   {
      ushort ch = StringGetCharacter(account, i);
      if((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_')
         safe += ShortToString(ch);
      else
         safe += "_";
   }
   return "NeurotradeBridge_" + safe + ".link";
}

/** Persist the live link so the next MT5 session re-adopts it. */
void SaveLinkFile(const string token, const string code)
{
   if(token == "" || code == "") return;
   string file = LinkFileName();
   int handle = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Log("could not save the link file " + file + " (" + IntegerToString(GetLastError()) +
          "). The link still works for this session; a restart will need the pairing code again.");
      return;
   }
   FileWriteString(handle, "v1|" + token + "|" + code);
   FileClose(handle);
}

/** Read the saved link, if this account has one. Returns false when absent. */
bool LoadLinkFile(string &token, string &code)
{
   token = "";
   code = "";
   string file = LinkFileName();
   if(!FileIsExist(file, FILE_COMMON)) return false;
   int handle = FileOpen(file, FILE_READ | FILE_TXT | FILE_COMMON | FILE_ANSI);
   if(handle == INVALID_HANDLE) return false;
   string text = "";
   while(!FileIsEnding(handle)) text += FileReadString(handle);
   FileClose(handle);
   StringTrimRight(text);
   StringReplace(text, "\r", "");
   StringReplace(text, "\n", "");
   string parts[];
   if(StringSplit(text, StringGetCharacter("|", 0), parts) != 3) return false;
   if(parts[0] != "v1") return false;
   token = parts[1];
   code = parts[2];
   return (StringLen(token) > 0 && StringLen(code) > 0);
}

/** Forget the saved link. Called for the ONE answer that is final: revoked. */
void DeleteLinkFile(const string why)
{
   string file = LinkFileName();
   if(!FileIsExist(file, FILE_COMMON)) return;
   if(FileDelete(file, FILE_COMMON))
      Print("NeurotradeBridge: cleared the saved link (", why, ").");
   else
      Log("could not clear the saved link file " + file + " (" + IntegerToString(GetLastError()) + ").");
}

/**
 * The code to present: what the user typed into PairingCode.
 *
 * There is no fallback any more. v3.03-v3.07 remembered the last code that
 * worked, which is what let a closed terminal reconnect on a spent credential;
 * a code is now valid only for the terminal session that redeemed it, so the
 * input IS the credential and a new session needs a new one.
 */
string EffectivePairingCode()
{
   string typed = StringTrimmed(PairingCode);
   if(StringLen(typed) > 0) return typed;
   // No code in the inputs: this is an unattended restart (an MT5 reboot, a
   // terminal that came back after a crash). The saved link carries the code it
   // paired with, and the server accepts that code for as long as the link
   // remains unrevoked — which is exactly the "nothing but the user ends it"
   // contract. An empty answer means "no saved link": the EA waits for a code.
   string token = "", code = "";
   if(LoadLinkFile(token, code)) return code;
   return "";
}

/**
 * Tell the server this terminal is going away.
 *
 * Called from OnDeinit for the reasons that end a session (see
 * LinkEndsWithThisRun). The server releases the link, its pairing code and this
 * account's claim immediately, so the Desk does not sit on a dead terminal and
 * the next session is not refused with "one account, one Desk".
 *
 * Best effort by definition: MT5 does not wait for an expert's shutdown. If the
 * request does not land — the terminal is already tearing down, WebRequest is
 * not allowlisted, the network is gone — nothing is lost: the server's
 * heartbeat lease ends the same link within BRIDGE_LINK_LEASE_MS.
 *
 * The token is deliberately KEPT in g_token afterwards. If MT5 changes its mind
 * and re-attaches the EA (a recompile during shutdown, a chart that reappears),
 * the link may still be live and the next beat continues on it.
 */
void DisconnectBridge(const string why)
{
   if(StringLen(NormalisedServerUrl()) == 0) return;
   if(g_token == "")
      return; // Nothing was ever paired on this chart; nothing to release.

   string response = "";
   bool sent = HttpPost("/api/bridge/disconnect",
                        "{\"reason\":\"" + JsonEscape(why) + "\"}",
                        response, true);
   if(!sent)
   {
      Print("NeurotradeBridge: could not tell the Desk this session ended (", why,
            "). The link will be released by the server's own heartbeat timeout.");
      return;
   }
   if(g_lastHttpStatus >= 200 && g_lastHttpStatus < 300)
   {
      // JsonBool returns an int: 1 true, 0 false, -1 key absent. `ended` is
      // false when another chart of this terminal is still streaming, in which
      // case the link stays up and nothing needs re-pairing.
      int ended = JsonBool(response, "ended");
      Print("NeurotradeBridge: the Desk released this link (", why, "). Open Desk -> Link MT5 ",
            ended == 1 ? "for a NEW pairing code when you next start MT5."
                       : "to see the terminal still connected — another chart of this terminal is still running.");
   }
   else if(g_lastHttpStatus >= 500)
   {
      WarnServerOnce("the Desk could not process the disconnect just now (" + IntegerToString(g_lastHttpStatus) +
                     "). Nothing is wrong with the account — the link is released by the heartbeat timeout.");
   }
   else
   {
      Print("NeurotradeBridge: the Desk answered ", IntegerToString(g_lastHttpStatus),
            " to the disconnect. The link is released by the heartbeat timeout.");
   }
}

//+------------------------------------------------------------------+
//| Pairing and HTTP                                                  |
//+------------------------------------------------------------------+
void TryPair()
{
   datetime now = NowServer();
   if(now < g_nextPairAttempt) return;
   g_nextPairAttempt = now + g_pairAttemptDelaySeconds;

   string base = NormalisedServerUrl();
   if(base == "")
   {
      Log("Waiting for ServerUrl input.");
      return;
   }
   string code = EffectivePairingCode();
   if(StringLen(code) == 0)
   {
      Log("Waiting for PairingCode input.");
      return;
   }

   string body = "{\"pairingCode\":\"" + JsonEscape(code) + "\",\"terminal\":{";
   body += "\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   body += "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   body += "\"company\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
   body += "\"version\":\"" + EA_VERSION + "\",";
   body += "\"instanceId\":\"" + JsonEscape(g_instanceId) + "\",";
   body += "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\"},";
   // All broker symbols are discovered once at pairing. This is a catalogue,
   // not a quote feed: live specs/quotes/bars are sent only for user-selected
   // markets on subsequent rotating heartbeats.
   body += "\"catalog\":" + CatalogJson() + "}";

   string response = "";
   if(!HttpPost("/api/bridge/pair", body, response, false))
   {
      // HTTP 409: this MT5 account is already connected to another Desk. The
      // server keeps the pairing code alive precisely so we can keep retrying
      // with the same value, so back off instead of hammering it every 5s and
      // print the server's own explanation once, where the user will see it.
      if(g_lastHttpStatus == 409)
      {
         g_nextPairAttempt = now + 60;
         g_pairAttemptDelaySeconds = 60;
         Print("NeurotradeBridge: PAIRING REFUSED — ", (g_lastHttpError == "" ? "this MT5 account is already connected in another browser." : g_lastHttpError));
         Print("NeurotradeBridge: open the Desk that holds account ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
               "@", AccountInfoString(ACCOUNT_SERVER), " and unlink it, or wait a few minutes. Retrying in 60s with the same code.");
      }
      else if(g_lastHttpStatus == 401)
      {
         // The code itself is unknown or was retired (the user unlinked the
         // terminal, rotated the code, or the store that held it was not
         // durable and the server restarted). Retrying it five times a second
         // produced thousands of identical 401 lines and hid the real reason.
         // Say it once, back off, and let the user paste a fresh code.
         //
         // v3.06: a 503 never reaches this branch. "The server could not read
         // its own link store" is a transport problem, not a verdict on the
         // code, and is retried every five seconds by the branch below without
         // telling the user their code is dead.
         g_pairAttemptDelaySeconds = 60;
         g_nextPairAttempt = now + 60;
         if(!g_refusalPrinted)
         {
            g_refusalPrinted = true;
            // v3.08: since a code is active only while the terminal that used it
            // is running, the ordinary reason for this refusal is now "the
            // session that code belonged to is over". Say that, and say what to
            // do — a fresh code, not a new link, is all that is needed.
            if(g_lastHttpCode == "pairing_code_spent")
               Print("NeurotradeBridge: this pairing code has already been used and the terminal it connected is ",
                     "no longer open. Open Desk -> Link MT5, copy the NEW code into this EA's PairingCode input, and ",
                     "the terminal will connect. A code is valid only while the MT5 session it paired with is ",
                     "running. Still trying in the background every 60s.");
            else
               Print("NeurotradeBridge: this pairing code is not valid any more — it was replaced, it was already ",
                     "used by a terminal session that has since ended, or the terminal was unlinked in the Desk. ",
                     "Open Desk -> Link MT5, copy the NEW code into this EA's PairingCode input, and the terminal ",
                     "will connect. Still trying in the background every 60s.");
         }
      }
      else
      {
         g_pairAttemptDelaySeconds = 5;
         g_nextPairAttempt = now + g_pairAttemptDelaySeconds;
      }
      return;
   }

   string token = JsonString(response, "bridgeToken");
   if(token == "")
   {
      Print("NeurotradeBridge: pairing response did not include a bridge token: ", response);
      return;
   }

   g_token = token;
   // v3.09: remember the link on disk, so the next session re-adopts it rather
   // than needing a new code. Written only here — where the Desk has just
   // confirmed the pairing — and cleared only on a revocation.
   SaveLinkFile(token, code);
   g_lastOk = now;
   g_seq = 0;
   g_pairAttemptDelaySeconds = 5;
   g_refusalPrinted = false;
   // v3.06: a fresh token starts with a clean refusal budget.
   g_tokenRefusals = 0;
   g_nextTokenRetry = 0;
   g_lastStoreWarnAt = 0;
   ApplyServerResponse(response);
   Print("NeurotradeBridge: paired with account ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
         "@", AccountInfoString(ACCOUNT_SERVER), ". The link is saved for this account: MT5 restarts, an API ",
         "redeploy and a network outage all resume it automatically. It ends only when you unlink the terminal ",
         "in the Desk, or when you close MT5.");
}

bool HttpPost(const string path, const string body, string &response, const bool authenticated)
{
   string base = NormalisedServerUrl();
   if(base == "") return false;

   // Clear before every attempt: a transport failure must never leave the
   // previous call's status behind and be mistaken for a fresh refusal.
   g_lastHttpStatus = 0;
   g_lastHttpError = "";
   g_lastHttpCode = "";

   string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
   if(authenticated && g_token != "") headers += "Authorization: Bearer " + g_token + "\r\n";

   char post[], result[];
   StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
   // StringToCharArray adds a NUL terminator. HTTP JSON must not include it.
   if(ArraySize(post) > 0) ArrayResize(post, ArraySize(post) - 1);

   string resultHeaders = "";
   ResetLastError();
   // v3.04: WebRequest is synchronous, so the timeout is how long one hung or
   // slow response can freeze the heartbeat loop. 3 s (was 8 s): the server
   // answers in tens of milliseconds; anything slower is a fault, and the next
   // beat retries immediately rather than costing eight seconds of silence.
   int status = WebRequest("POST", base + path, headers, 3000, post, result, resultHeaders);
   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4014)
         Print("NeurotradeBridge: WebRequest is blocked. Add ", base,
               " in MT5 -> Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL.");
      else
         Print("NeurotradeBridge: WebRequest failed (", err, ") for ", path, ". EA remains attached and will retry.");
      return false;
   }

   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   // Published for callers that need to distinguish a refusal (409) from a
   // transport failure. MQL5 forbids default values on reference parameters,
   // so this is the clean way to hand the status back to TryPair().
   g_lastHttpStatus = status;
   g_lastHttpError = JsonString(response, "error");
   // v3.06: the server's machine-readable verdict — "bridge_link_revoked"
   // (final), "bridge_token_unknown" (unverified), "bridge_store_unavailable"
   // (the server could not read its own link store and revoked nothing).
   g_lastHttpCode = JsonString(response, "code");
   if(status < 200 || status >= 300)
   {
      if(status >= 500)
      {
         // The server answered but could not do the work. Nothing is revoked,
         // so the token stays exactly as it was and the next beat retries.
         // Rate-limited: a rolling deploy or a database failover answers 503 on
         // every beat for a while, and an unguarded Print here would reproduce
         // the journal-flooding the 401 backoff was written to stop.
         WarnServerOnce(StringFormat("HTTP %d from %s — %s. Nothing was revoked; this terminal's token is kept and will be retried.",
                                     status, path,
                                     (g_lastHttpError == "" ? "the server could not complete the request" : g_lastHttpError)));
         return false;
      }
      Print("NeurotradeBridge: HTTP ", status, " from ", path, " — ", response);
      // v3.06: NOTHING is discarded here any more. This function is the lowest
      // level and cannot know whether a 401 was a verified verdict or a server
      // that could not check; wiping the token here is what turned one
      // unreadable database row into a permanently disconnected terminal (and,
      // because the link file lives in the COMMON folder, disconnected every
      // other chart of the same account with it). Sync() and TryPair() decide.
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Timezone correction                                              |
//|                                                                  |
//| MetaTrader reports ticks (MqlTick.time_msc), bars                |
//| (CopyRates().time) and calendar events (MqlCalendarValue.time)   |
//| in the broker's TRADE SERVER timezone. Consumed as epoch         |
//| milliseconds they are wrong by the server's GMT offset — usually |
//| two or three hours — which is what made news show the wrong      |
//| local time and made quotes look either impossibly fresh or       |
//| permanently stale.                                               |
//|                                                                  |
//| The correction is measured live rather than hard-coded, so it    |
//| survives brokers on any offset and follows DST automatically.    |
//| In the strategy tester TimeGMT() equals the simulated server      |
//| time, so the offset is 0 there and nothing changes.              |
//|                                                                  |
//| v3.04: the offset is LEARNED from the platform server's own      |
//| clock (sync response `serverTime`) instead of the machine clock.  |
//| A machine whose clock is 51 s behind no longer skews every       |
//| timestamp — the Desk's measured skew reads ~0 because the data   |
//| genuinely is right. The machine's own error is reported          |
//| separately as computerClockSkewMs.                               |
//+------------------------------------------------------------------+

/** Trade-server clock vs the computer clock (pre-v3.04 fallback). */
int ServerUtcOffsetSeconds()
{
   long offset = (long)TimeTradeServer() - (long)TimeGMT();
   if(offset > 86400) offset = 86400;
   if(offset < -86400) offset = -86400;
   return (int)offset;
}

/**
 * Trade-server clock vs TRUE UTC. Learned from the platform server's clock
 * once the first sync response arrives; the computer clock is the fallback
 * until then (one beat of v3.03 behaviour, then self-corrected).
 */
long BrokerUtcOffsetSeconds()
{
   if(g_brokerClockLearned) return g_brokerUtcOffsetSec;
   return (long)ServerUtcOffsetSeconds();
}

/** Trade-server datetime -> true UTC epoch, in milliseconds. */
long ToUtcMs(const datetime serverTime)
{
   return ((long)serverTime - BrokerUtcOffsetSeconds()) * 1000;
}

/** Trade-server tick clock (already in ms) -> true UTC epoch, in ms. */
long TickToUtcMs(const long tickMsc, const long fallbackServerSeconds)
{
   if(tickMsc > 0) return tickMsc - BrokerUtcOffsetSeconds() * 1000;
   return ToUtcMs((datetime)fallbackServerSeconds);
}

/** The terminal's current time as a true UTC epoch, in ms. */
long NowUtcMs()
{
   return ToUtcMs(NowServer());
}

//+------------------------------------------------------------------+
//| Sync: terminal truth in, guarded work out                        |
//+------------------------------------------------------------------+
void Sync()
{
   if(g_token == "") return;

   string batch[];
   int batchCount = CollectBatch(batch);

   g_seq++;
   string body = "{";
   body += "\"seq\":" + IntegerToString(g_seq) + ",";
   // Who is speaking, and with which build. The instance id keeps a second
   // chart's counter from looking like a terminal restart; the version lets the
   // Desk say "your EA is out of date" instead of leaving a stale terminal
   // silently disagreeing with it about the calendar.
   body += "\"instanceId\":\"" + JsonEscape(g_instanceId) + "\",";
   body += "\"version\":\"" + EA_VERSION + "\",";
   // Tell the server how this terminal's clock relates to UTC. Combined with
   // the UTC-normalised timestamps below it lets the Desk detect a skewed
   // clock instead of trusting (or silently mis-trusting) every tick. From
   // v3.04 the offset is learned from the server's own clock, so a misclocked
   // MACHINE no longer skews anything; the machine's own error is reported
   // separately as computerClockSkewMs.
   body += "\"clock\":{\"serverUtcOffsetSeconds\":" + IntegerToString(BrokerUtcOffsetSeconds())
         + ",\"terminalUtcMs\":" + IntegerToString(NowUtcMs())
         + ",\"computerClockSkewMs\":" + IntegerToString(g_computerClockSkewMs)
         // The cadence this EA is actually running with. The desk uses it to
         // size its staleness window (12 missed beats, bounded), so a terminal
         // configured with a slow heartbeat is not declared dead on schedule.
         + ",\"syncIntervalMs\":" + IntegerToString(g_syncIntervalMs)
         + ",\"label\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\"},";
   body += "\"account\":" + AccountJson() + ",";
   body += "\"specs\":" + SpecsJson(batch) + ",";
   // Quotes cover the whole selection on every beat; candles stay batched.
   if(SendAllQuotesEachBeat)
      body += "\"quotes\":" + QuotesJson(g_symbols) + ",";
   else
      body += "\"quotes\":" + QuotesJson(batch) + ",";
   body += "\"candles\":" + CandlesJson(batch) + ",";
   // How many bars the terminal holds per symbol|timeframe. The desk asks for
   // history only for series it is genuinely short on (see v3.04 note 14), so
   // one thin series can no longer trigger a full re-seed on every beat.
   body += "\"barsAvailable\":" + BarsAvailableJson() + ",";
   body += "\"news\":" + NewsJson() + ",";
   body += "\"positions\":" + PositionsJson() + ",";
   body += "\"results\":[" + g_results + "],";
   // v3.05: the tick tape (WP4D) and the management journal. Both are opt-in
   // shapes — the Desk ignores them when the feature flags are off, and an
   // older Desk simply never reads the keys.
   body += "\"ticks\":" + TicksJson(batch, TickStreamPerSymbol) + ",";
   body += "\"managementEvents\":" + ManagementEventsJson();
   body += "}";

   string response = "";
   if(!HttpPost("/api/bridge/sync", body, response, true))
   {
      // HTTP 409: this account has been connected to another Desk. The token is
      // still valid, so this is the only place the handover can be enforced —
      // continuing would mean two Desks streaming, arming and flattening one
      // balance. Drop the token and stop trading; the user must re-pair here.
      if(g_lastHttpStatus == 409)
      {
         Print("NeurotradeBridge: DISCONNECTED — ", (g_lastHttpError == "" ? "this MT5 account is now connected in another browser." : g_lastHttpError));
         Print("NeurotradeBridge: this terminal has stopped trading to avoid two desks managing one balance. ",
               "Unlink it there, then paste a fresh pairing code from Desk -> Link MT5 into PairingCode here.");
         g_token = "";
         g_tradingEnabled = false;
         g_nextPairAttempt = 0;
      }
      else if(g_lastHttpStatus == 401)
      {
         // v3.06: two very different refusals arrive as a 401, and only one of
         // them is final. The server says which in `code`.
         if(g_lastHttpCode == "bridge_link_revoked")
         {
            // FINAL. The user pressed "Unlink terminal" in the Desk, the row is
            // marked revoked, and no retry will ever succeed — so the token is
            // discarded now and nothing can resurrect it.
            if(!g_refusalPrinted)
            {
               g_refusalPrinted = true;
               Print("NeurotradeBridge: the Desk REVOKED this terminal's link — it was unlinked. Open Desk -> Link ",
                     "MT5, copy the NEW pairing code into this EA's PairingCode input, and it will reconnect. ",
                     "Retrying slowly in the background.");
            }
            g_token = "";
            g_tokenRefusals = 0;
            g_tradingEnabled = false;
            g_pairAttemptDelaySeconds = 60;
            g_nextPairAttempt = NowServer() + 60;
            // The saved link is cleared HERE and nowhere else: this is the ONE
            // answer from the Desk that is final (the user unlinked the
            // terminal). Every other refusal — including a 5xx, a 503 and an
            // unverified 401 — keeps the credential, because none of them mean
            // the user decided anything.
            DeleteLinkFile("the terminal was unlinked in the Desk");
         }
         else
         {
            // UNVERIFIED — "no such link" from a store that has just been
            // emptied (a redeploy, a second replica, a database restored
            // without its rows), or an older server that could not read its own
            // link store and answered 401 for it. v3.05 wiped the token here on
            // the FIRST such answer, which is how a few seconds of unreadable
            // database became a permanently disconnected terminal. The token is
            // kept and retried a few times, spaced out, before the pairing code
            // is tried instead — and while MT5 is open, a new code is one click
            // away in the Desk.
            g_tokenRefusals++;
            g_tradingEnabled = false;
            if(g_tokenRefusals >= TOKEN_REFUSAL_GRACE)
            {
               if(!g_refusalPrinted)
               {
                  g_refusalPrinted = true;
                  Print("NeurotradeBridge: the Desk refused this terminal's link ", IntegerToString(g_tokenRefusals),
                        " times in a row, so the token is being abandoned and the pairing code will be tried ",
                        "instead. If that is refused too, open Desk -> Link MT5 and paste a NEW code into ",
                        "PairingCode. The EA stays on this chart.");
               }
               g_token = "";
               g_tokenRefusals = 0;
               g_pairAttemptDelaySeconds = 60;
               g_nextPairAttempt = NowServer() + 60;
            }
            else
            {
               WarnServerOnce(StringFormat(
                  "the Desk could not verify this terminal's link (refusal %d of %d). NOTHING was unlinked: the token is kept and retried in %d s.",
                  g_tokenRefusals, TOKEN_REFUSAL_GRACE, TOKEN_RETRY_SECONDS));
               g_nextTokenRetry = NowServer() + TOKEN_RETRY_SECONDS;
            }
         }
      }
      // v3.06: a 5xx means the server is UP and could not do the work — most
      // often `bridge_store_unavailable`, i.e. it could not read its own link
      // store and has revoked NOTHING. Space the next attempt by the server's
      // own `retryAfterMs` hint rather than sending a full payload (quotes,
      // candles, positions) twice a second at a service that is already
      // struggling. The token — the whole link — is untouched.
      if(g_lastHttpStatus >= 500)
      {
         long retryMs = (long)JsonNumber(response, "retryAfterMs");
         int waitSeconds = retryMs > 0 ? (int)MathMin(60, MathMax(1, retryMs / 1000)) : 5;
         g_nextTokenRetry = NowServer() + waitSeconds;
      }

      // Bounded by the SERVER-silence budget, not the tick-freshness one: the
      // desk keeps a link alive for its own (adaptive) window, and the EA must
      // not stop executing plans while the desk still considers the link live.
      // This runs for EVERY failed beat — a 5xx, a transport failure, anything
      // else — so a long outage still pauses new entries on schedule. (A 409 or
      // a revocation has already paused them above.)
      if(NowServer() - g_lastOk > ServerSilenceSec) g_tradingEnabled = false;
      return;
   }

   g_lastOk = NowServer();
   // The link is confirmed: forget the refusal budget and the retry spacing, so
   // a LATER outage gets its own retries and its own single journal line.
   g_tokenRefusals = 0;
   g_nextTokenRetry = 0;
   g_refusalPrinted = false;
   g_results = "";
   for(int i = 0; i < g_mgmtEventCount; i++) g_mgmtEvents[i] = "";
   g_mgmtEventCount = 0;
   // Learn the true UTC offset from the platform server's own clock BEFORE the
   // next beat builds its timestamps (v3.04, note 13).
   LearnBrokerClock(response);
   // Re-seed exactly the series the desk is short on (v3.04, note 14).
   ApplyHistoryRequest(response);
   ApplyServerResponse(response);
}

//+------------------------------------------------------------------+
//| Learn the true UTC offset from the platform server's clock        |
//| (v3.04, note 13).                                                 |
//|                                                                   |
//| Every sync response carries `serverTime` — the platform server's own  |
//| epoch milliseconds, which is NTP-synced infrastructure time. The      |
//| difference between TimeTradeServer() and that value is the TRUE      |
//| broker-vs-UTC offset, independent of this machine's clock. From the   |
//| next beat every timestamp this EA emits is converted with it, so a    |
//| machine whose clock is minutes off no longer skews anything.          |
//+------------------------------------------------------------------+
void LearnBrokerClock(const string response)
{
   long serverMs = (long)JsonNumber(response, "serverTime");
   if(serverMs <= 0) return;
   long serverSec = serverMs / 1000;
   long offset = (long)TimeTradeServer() - serverSec;
   if(offset > 86400) offset = 86400;
   if(offset < -86400) offset = -86400;
   g_brokerUtcOffsetSec = offset;
   g_brokerClockLearned = true;

   // The machine's OWN clock vs true UTC — reported separately so the Desk
   // can say so calmly. The data is already correct; this is the "sync NTP"
   // signal, printed once.
   long computerSkewMs = (long)TimeGMT() * 1000 - serverMs;
   g_computerClockSkewMs = computerSkewMs;
   if(!g_clockWarningPrinted && MathAbs(computerSkewMs) > 5000)
   {
      g_clockWarningPrinted = true;
      Print("NeurotradeBridge: this machine's clock is ", MathAbs(computerSkewMs) / 1000, "s ",
            computerSkewMs > 0 ? "ahead of" : "behind",
            " UTC. The EA compensates automatically, so desk prices and times stay correct. ",
            "Sync the machine's clock (NTP) to keep time-based features inside MT5 exact.");
   }
}

//+------------------------------------------------------------------+
//| Re-seed exactly the series the desk still needs (v3.04, note 14). |
//|                                                                   |
//| The server sends `history` — the `symbol|timeframe` keys it is short   |
//| on — and this EA re-seeds exactly those, instead of re-copying its    |
//| whole batch. A legacy server (no `history` field) still gets the       |
//| boolean `needsHistory`, answered with a full ResetSeeding() as before; |
//| the server bounds that path itself.                                    |
//+------------------------------------------------------------------+
void ApplyHistoryRequest(const string response)
{
   string keys[];
   if(JsonStringArray(response, "history", keys))
   {
      for(int i = 0; i < ArraySize(keys); i++)
      {
         int sep = StringFind(keys[i], "|");
         if(sep <= 0) continue;
         string symbol = StringSubstr(keys[i], 0, sep);
         string tfName = StringSubstr(keys[i], sep + 1);
         int si = SymbolIndex(symbol);
         if(si < 0) continue;
         for(int t = 0; t < TF_COUNT; t++)
         {
            if(TF_NAMES[t] == tfName)
            {
               g_seeded[SeedIndex(si, t)] = false;
               break;
            }
         }
      }
      return;
   }
   // Legacy server: boolean only — re-seed the whole batch.
   if(JsonBool(response, "needsHistory") == 1) ResetSeeding();
}

/** How many bars the terminal holds per symbol|timeframe (sent every beat). */
string BarsAvailableJson()
{
   string json = "{";
   bool first = true;
   for(int s = 0; s < ArraySize(g_symbols); s++)
   {
      // One fragment per symbol keeps string building linear in the symbol
      // count (see note 14 on CandlesJson).
      string frag = "";
      for(int t = 0; t < TF_COUNT; t++)
      {
         int n = Bars(g_symbols[s], TF_LIST[t]);
         if(n < 0) n = 0;
         if(t > 0) frag += ",";
         frag += "\"" + g_symbols[s] + "|" + TF_NAMES[t] + "\":" + IntegerToString(n);
      }
      if(frag == "") continue;
      if(!first) json += ",";
      first = false;
      json += frag;
   }
   json += "}";
   return json;
}

void ApplyServerResponse(const string json)
{
   int tradingFlag = JsonBool(json, "tradingEnabled");
   int liveFlag = JsonBool(json, "liveTradingEnabled");
   // An omitted guard is never permission. Pair responses omit limits, while
   // sync responses specify them explicitly.
   g_tradingEnabled = (tradingFlag == 1);
   g_liveTradingEnabled = (liveFlag == 1);

   string subscriptions = JsonObject(json, "subscriptions");
   if(subscriptions != "")
   {
      string next[];
      if(JsonStringArray(subscriptions, "symbols", next)) UpdateSubscriptions(next);
   }

   int cursor = StringFind(json, "\"commands\"");
   if(cursor < 0) return;
   int start = StringFind(json, "[", cursor);
   if(start < 0) return;

   int depth = 0;
   int objStart = -1;
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{')
      {
         if(depth == 0) objStart = i;
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 0 && objStart >= 0)
         {
            HandleCommand(StringSubstr(json, objStart, i - objStart + 1));
            objStart = -1;
         }
      }
      else if(ch == ']' && depth == 0) break;
   }
}

//+------------------------------------------------------------------+
//| Broker catalogue and live-data batching                           |
//+------------------------------------------------------------------+
string CatalogJson()
{
   string json = "[";
   bool first = true;
   int total = SymbolsTotal(false); // false = every symbol the broker exposes
   for(int i = 0; i < total; i++)
   {
      string symbol = SymbolName(i, false);
      if(symbol == "") continue;
      if(!first) json += ",";
      first = false;
      long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
      json += "{";
      json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      json += "\"description\":\"" + JsonEscape(SymbolInfoString(symbol, SYMBOL_DESCRIPTION)) + "\",";
      json += "\"path\":\"" + JsonEscape(SymbolInfoString(symbol, SYMBOL_PATH)) + "\",";
      json += "\"assetClass\":\"" + ClassifySymbol(symbol) + "\",";
      json += "\"tradeable\":" + (tradeMode == SYMBOL_TRADE_MODE_DISABLED ? "false" : "true");
      json += "}";
   }
   json += "]";
   return json;
}

int CollectBatch(string &batch[])
{
   ArrayResize(batch, 0);
   int total = ArraySize(g_symbols);
   if(total <= 0) return 0;

   int budget = (int)MathMax(1, SymbolsPerHeartbeat);
   int count = (int)MathMin(total, budget);
   ArrayResize(batch, count);
   for(int i = 0; i < count; i++)
   {
      int index = (g_batchCursor + i) % total;
      batch[i] = g_symbols[index];
   }
   g_batchCursor = (g_batchCursor + count) % total;
   return count;
}

void UpdateSubscriptions(const string &next[])
{
   int nextCount = ArraySize(next);
   bool same = (nextCount == ArraySize(g_symbols));
   if(same)
      for(int i = 0; i < nextCount; i++)
         if(next[i] != g_symbols[i]) { same = false; break; }
   if(same) return;

   ArrayResize(g_symbols, nextCount);
   for(int i = 0; i < nextCount; i++)
   {
      g_symbols[i] = next[i];
      // Select only the symbols the user chose, not every broker symbol.
      SymbolSelect(g_symbols[i], true);
   }
   g_batchCursor = 0;
   ResetSeeding();
   Print("NeurotradeBridge: live coverage updated: ", nextCount, " selected broker market(s).");
}

void ResetSeeding()
{
   int count = ArraySize(g_symbols) * TF_COUNT;
   ArrayResize(g_seeded, count);
   for(int i = 0; i < count; i++) g_seeded[i] = false;
}

int SymbolIndex(const string symbol)
{
   for(int i = 0; i < ArraySize(g_symbols); i++)
      if(g_symbols[i] == symbol) return i;
   return -1;
}

int SeedIndex(const int symbolIndex, const int timeframeIndex)
{
   return symbolIndex * TF_COUNT + timeframeIndex;
}

bool IsSeeded(const int symbolIndex, const int timeframeIndex)
{
   int index = SeedIndex(symbolIndex, timeframeIndex);
   return index >= 0 && index < ArraySize(g_seeded) && g_seeded[index];
}

void MarkSeeded(const int symbolIndex, const int timeframeIndex)
{
   int index = SeedIndex(symbolIndex, timeframeIndex);
   if(index >= 0 && index < ArraySize(g_seeded)) g_seeded[index] = true;
}

string SpecsJson(const string &symbols[])
{
   string json = "[";
   bool first = true;
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      string s = symbols[i];
      if(!SymbolSelect(s, true)) continue;
      double point = SymbolInfoDouble(s, SYMBOL_POINT);
      if(point <= 0) continue;
      if(!first) json += ",";
      first = false;
      json += "{";
      json += "\"symbol\":\"" + JsonEscape(s) + "\",";
      json += "\"assetClass\":\"" + ClassifySymbol(s) + "\",";
      json += "\"point\":" + DoubleToString(point, 10) + ",";
      json += "\"digits\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS)) + ",";
      json += "\"tickSize\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) + ",";
      json += "\"tickValue\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE_LOSS), 8) + ",";
      json += "\"contractSize\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 4) + ",";
      json += "\"volumeMin\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) + ",";
      json += "\"volumeMax\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 4) + ",";
      json += "\"volumeStep\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) + ",";
      json += "\"stopsLevel\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL)) + ",";
      json += "\"freezeLevel\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_FREEZE_LEVEL)) + ",";
      json += "\"marginInitial\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_MARGIN_INITIAL), 4) + ",";
      json += "\"swapLong\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_LONG), 4) + ",";
      json += "\"swapShort\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_SHORT), 4) + ",";
      json += "\"commissionPerLot\":0,";
      json += "\"spreadPoints\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_SPREAD)) + ",";
      json += "\"baseCurrency\":\"" + JsonEscape(SymbolInfoString(s, SYMBOL_CURRENCY_BASE)) + "\",";
      json += "\"quoteCurrency\":\"" + JsonEscape(SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT)) + "\"";
      json += "}";
   }
   json += "]";
   return json;
}

/**
 * Live ticks for the user's selected symbols.
 *
 * v3.00: this is called with the FULL selection on every heartbeat, not with a
 * rotating batch. A tick is a handful of bytes; rotating them meant a symbol
 * could wait several beats for a refresh while the Desk kept displaying its
 * last known price as though it were current. Candles are still batched —
 * they are the only payload big enough to be worth it.
 *
 * Two correctness guards, both added because a well-formed number can still be
 * the wrong number:
 *   - the symbol is selected in Market Watch first, because a symbol the
 *     terminal is not subscribed to returns a CACHED tick, sometimes hours old;
 *   - the tick's age is checked against StaleAfterSec, and an old tick is
 *     dropped here rather than shipped for the server to police.
 */
string QuotesJson(const string &symbols[])
{
   string json = "[";
   bool first = true;
   long nowUtc = NowUtcMs();
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      string s = symbols[i];
      SymbolSelect(s, true);
      MqlTick tick;
      if(!SymbolInfoTick(s, tick) || tick.bid <= 0 || tick.ask <= 0) continue;

      long utcMs = TickToUtcMs(tick.time_msc, (long)tick.time);
      long ageMs = nowUtc - utcMs;
      if(ageMs < 0) ageMs = -ageMs;
      if(ageMs > (long)StaleAfterSec * 1000) continue;

      if(!first) json += ",";
      first = false;
      json += "{\"symbol\":\"" + JsonEscape(s) + "\",";
      json += "\"bid\":" + DoubleToString(tick.bid, 10) + ",";
      json += "\"ask\":" + DoubleToString(tick.ask, 10) + ",";
      json += "\"spreadPoints\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_SPREAD)) + ",";
      json += "\"ageMs\":" + IntegerToString(ageMs) + ",";
      json += "\"ts\":" + IntegerToString(utcMs) + "}";
   }
   json += "]";
   return json;
}

string CandlesJson(const string &symbols[])
{
   string json = "[";
   bool first = true;
   for(int s = 0; s < ArraySize(symbols); s++)
   {
      int sourceIndex = SymbolIndex(symbols[s]);
      if(sourceIndex < 0) continue;
      // v3.04: build this symbol's fragment separately and append it once.
      // Appending every bar to the top-level string made string building
      // quadratic in the bar count — a full re-seed (220 bars x 10 frames x
      // 12 symbols, ~2 MB) took seconds on the terminal, which aged every
      // quote past the Desk's freshness gate. Per-symbol fragments keep the
      // number of large reallocations linear in the symbol count.
      string frag = "";
      bool fragFirst = true;
      for(int t = 0; t < TF_COUNT; t++)
      {
         int want = IsSeeded(sourceIndex, t) ? (int)MathMax(2, DeltaBars) : (int)MathMax(60, HistoryBars);
         MqlRates rates[];
         ArraySetAsSeries(rates, false);
         int copied = CopyRates(symbols[s], TF_LIST[t], 0, want, rates);
         if(copied <= 0) continue;
         MarkSeeded(sourceIndex, t);
         if(!fragFirst) frag += ",";
         fragFirst = false;
         frag += "{\"symbol\":\"" + JsonEscape(symbols[s]) + "\",\"timeframe\":\"" + TF_NAMES[t] + "\",\"bars\":[";
         for(int b = 0; b < copied; b++)
         {
            if(b > 0) frag += ",";
            frag += "[" + IntegerToString(ToUtcMs(rates[b].time)) + "," +
                    DoubleToString(rates[b].open, 10) + "," +
                    DoubleToString(rates[b].high, 10) + "," +
                    DoubleToString(rates[b].low, 10) + "," +
                    DoubleToString(rates[b].close, 10) + "," +
                    IntegerToString((long)rates[b].tick_volume) + "]";
         }
         frag += "]}";
      }
      if(frag == "") continue;
      if(!first) json += ",";
      first = false;
      json += frag;
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| MT5 account and position snapshots                                |
//+------------------------------------------------------------------+
string AccountJson()
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   bool isLive = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL);
   bool netting = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_NETTING);
   string json = "{";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(equity, 2) + ",";
   json += "\"margin\":" + DoubleToString(margin, 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",";
   json += "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"mode\":\"" + (netting ? "netting" : "hedging") + "\",";
   json += "\"isLive\":" + (isLive ? "true" : "false");
   json += "}";
   return json;
}

string PositionsJson()
{
   string json = "[";
   bool first = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i); // also selects the position
      if(symbol == "") continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      if(!first) json += ",";
      first = false;
      long type = PositionGetInteger(POSITION_TYPE);
      json += "{\"ticket\":" + IntegerToString(PositionGetInteger(POSITION_TICKET)) + ",";
      json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      json += "\"side\":\"" + (type == POSITION_TYPE_BUY ? "buy" : "sell") + "\",";
      json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 4) + ",";
      json += "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 10) + ",";
      json += "\"openTime\":" + IntegerToString(ToUtcMs((datetime)PositionGetInteger(POSITION_TIME))) + ",";
      json += "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 10) + ",";
      json += "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 10) + ",";
      json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
      json += "\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2) + ",";
      json += "\"commission\":0}";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Red-folder economic calendar                                      |
//+------------------------------------------------------------------+
/**
 * Read the MT5 economic calendar for the day, with a retry ladder.
 *
 * WHY THERE IS A LADDER
 *
 * `CalendarValueHistory` returns SUCCESS with a zero-length array while the
 * terminal's calendar database is still syncing (and in some builds, for a
 * window it has no rows for). The previous version latched
 * `g_calendarAvailable = true` on that result, so the Desk reported
 * "No high-impact events in the next 24 hours. The gate stays armed" — an
 * all-clear — on a terminal whose calendar it had never actually read, while
 * the MT5 calendar tab visibly showed three red-folder releases for the day.
 * The news gate was silently disarmed.
 *
 * So: try the windowed read; if it yields no rows at all, retry with an open
 * upper bound (`datetime_to = 0` means "everything known from here on"), which
 * is the form the MQL5 examples use; if THAT also yields nothing, the terminal
 * genuinely cannot tell us the schedule, and the feed is published as
 * unavailable with the reason — the desk then fails closed and says why,
 * instead of showing a calm that was never verified.
 *
 * `g_rawCount` / `g_redCount` are published on the wire so the desk can make
 * that distinction visible to the user as well.
 */
void RefreshCalendar(const bool force)
{
   if(!UseEconomicCalendar)
   {
      g_calendarAvailable = false;
      return;
   }
   datetime now = NowServer();
   if(!force && g_lastCalendarCheck > 0 && now - g_lastCalendarCheck < NEWS_REFRESH_SECONDS) return;
   g_lastCalendarCheck = now;

   MqlCalendarValue values[];
   ResetLastError();
   // The window the Desk renders: the day's releases that have already happened
   // plus the next 24 hours. Both halves matter — the upcoming list is what
   // gates new entries, and the passed list is the evidence that the gate is
   // working at all ("0 red-folder events" next to an MT5 calendar showing
   // three of them is indistinguishable from a broken feed).
   datetime windowFrom = now - NEWS_LOOKBEHIND_SECONDS;
   datetime windowTo = now + NEWS_LOOKAHEAD_SECONDS;
   int count = CalendarValueHistory(values, windowFrom, windowTo);
   if(count <= 0)
   {
      // Fallback: everything the terminal knows from the same look-behind
      // onward, with an open upper bound — the form MQL5's own examples use.
      int wide = CalendarValueHistory(values, windowFrom, 0);
      if(wide > 0)
      {
         count = wide;
         windowTo = 0;   // open-ended; reported as "no upper bound" on the wire
      }
   }

   g_rawCount = count > 0 ? count : 0;
   g_calendarFromMs = ToUtcMs(windowFrom);
   g_calendarToMs = windowTo > 0 ? ToUtcMs(windowTo) : 0;

   ArrayResize(g_newsTimes, 0);
   ArrayResize(g_newsCurrencies, 0);
   ArrayResize(g_newsCountries, 0);
   ArrayResize(g_newsNames, 0);

   for(int i = 0; i < count; i++)
   {
      MqlCalendarEvent event;
      if(!CalendarEventById(values[i].event_id, event)) continue;
      if(event.importance != CALENDAR_IMPORTANCE_HIGH) continue;
      // A value with no scheduled time cannot be rendered or compared against.
      // It is counted (so the read is not mistaken for an empty calendar) but
      // it is not listed.
      if(values[i].time <= 0) continue;
      MqlCalendarCountry country;
      string currency = "";
      string countryName = "";
      if(CalendarCountryById(event.country_id, country))
      {
         currency = country.currency;
         countryName = country.name;
      }
      int index = ArraySize(g_newsTimes);
      ArrayResize(g_newsTimes, index + 1);
      ArrayResize(g_newsCurrencies, index + 1);
      ArrayResize(g_newsCountries, index + 1);
      ArrayResize(g_newsNames, index + 1);
      g_newsTimes[index] = values[i].time;
      g_newsCurrencies[index] = currency;
      g_newsCountries[index] = countryName;
      g_newsNames[index] = event.name;
   }

   g_redCount = ArraySize(g_newsTimes);
   g_calendarAvailable = (g_rawCount > 0);
   if(!g_calendarAvailable)
      Print("NeurotradeBridge: MT5 returned no calendar rows for this window — the terminal's ",
            "economic calendar may still be syncing. New entries are paused until it reads.");
}

string NewsJson()
{
   RefreshCalendar(false);
   string json = "{\"available\":" + (g_calendarAvailable ? "true" : "false") + ",";
   // g_newsTimes stays in trade-server time so IsNewsBlackout() can compare it
   // directly with NowServer(); only the wire format is converted to UTC.
   json += "\"checkedAt\":" + IntegerToString(ToUtcMs(g_lastCalendarCheck)) + ",";
   json += "\"detail\":\"" + (g_calendarAvailable ? "MT5 economic calendar" : "MT5 economic calendar unavailable") + "\",";
   // Rows read vs rows kept. `rawCount > 0, redCount == 0` is a genuine
   // all-clear; `rawCount == 0` means the terminal could not read its calendar
   // at all, and the desk must say so rather than promise a quiet session.
   json += "\"rawCount\":" + IntegerToString(g_rawCount) + ",";
   json += "\"redCount\":" + IntegerToString(g_redCount) + ",";
   // The span actually read. Without it the Desk can only say "no red-folder
   // events" without saying over what — which is how a two-hour window came to
   // be displayed as an all-clear for the whole day.
   json += "\"windowFromMs\":" + IntegerToString(g_calendarFromMs) + ",";
   if(g_calendarToMs > 0)
      json += "\"windowToMs\":" + IntegerToString(g_calendarToMs) + ",";
   json += "\"events\":[";
   for(int i = 0; i < ArraySize(g_newsTimes); i++)
   {
      if(i > 0) json += ",";
      json += "{\"id\":\"" + IntegerToString(ToUtcMs(g_newsTimes[i])) + "-" + JsonEscape(g_newsCurrencies[i]) + "-" + IntegerToString(i) + "\",";
      json += "\"time\":" + IntegerToString(ToUtcMs(g_newsTimes[i])) + ",";
      json += "\"currency\":\"" + JsonEscape(g_newsCurrencies[i]) + "\",";
      json += "\"country\":\"" + JsonEscape(g_newsCountries[i]) + "\",";
      json += "\"name\":\"" + JsonEscape(g_newsNames[i]) + "\",";
      json += "\"importance\":\"high\"}";
   }
   json += "]}";
   return json;
}

bool IsNewsBlackout(const string symbol)
{
   if(!UseEconomicCalendar || !g_calendarAvailable) return true; // fail closed
   datetime now = NowServer();
   string base = ToUpper(SymbolInfoString(symbol, SYMBOL_CURRENCY_BASE));
   string quote = ToUpper(SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT));
   bool noCurrency = (StringLen(base) == 0 && StringLen(quote) == 0);

   for(int i = 0; i < ArraySize(g_newsTimes); i++)
   {
      if(now < g_newsTimes[i] - NewsBlackoutBeforeMinutes * 60 ||
         now > g_newsTimes[i] + NewsBlackoutAfterMinutes * 60) continue;
      string currency = ToUpper(g_newsCurrencies[i]);
      if(noCurrency || currency == "" || currency == base || currency == quote) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Local execution / plan management                                 |
//+------------------------------------------------------------------+
/**
 * Place a real pending order for a limit/stop entry.
 *
 * v3.04 had no pending-order path at all: a limit entry was simulated by
 * watching the trigger tick-by-tick and firing a market order the moment price
 * touched it. That is not a limit order — it pays whatever the market is when
 * the EA's timer next runs, which on a 500 ms heartbeat is up to half a second
 * of movement in a fast market, on exactly the entries (pullbacks) where the
 * fill price is the whole edge.
 *
 * Returns true when an order is working (either just placed, or already live).
 */
bool TryPlacePending(const int index)
{
   string symbol = g_plans[index].symbol;
   if(g_plans[index].pendingTicket != 0) return true;
   if(g_plans[index].entryType != 1 && g_plans[index].entryType != 2) return false;

   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) return false;
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0) return false;
   double spread = (tick.ask - tick.bid) / point;
   if(g_plans[index].maxSpreadPoints > 0 && spread > g_plans[index].maxSpreadPoints) return false;
   if(!TradingAllowed(symbol)) return false;

   bool isBuy = g_plans[index].isBuy;
   bool isLimit = (g_plans[index].entryType == 1);
   double trigger = g_plans[index].trigger;
   // Brokers reject a pending order on the wrong side of the market. When the
   // market is already through the trigger, `false` lets the caller fall back
   // to the tick-through path — the entry is not lost, it is simply no longer
   // a resting order.
   if(isBuy && isLimit && !(trigger < tick.ask - point)) return false;
   if(isBuy && !isLimit && !(trigger > tick.ask + point)) return false;
   if(!isBuy && isLimit && !(trigger > tick.bid + point)) return false;
   if(!isBuy && !isLimit && !(trigger < tick.bid - point)) return false;

   // Expiry: the plan's own TTL, capped by a local maximum so a plan with no
   // server expiry cannot rest in the book indefinitely.
   long capMs = NowUtcMs() + (long)MathMax(1, MaxPendingOrderMinutes) * 60 * 1000;
   long expireMs = (g_plans[index].expiresAt > 0 ? MathMin(g_plans[index].expiresAt, capMs) : capMs);
   datetime expiry = (datetime)(expireMs / 1000);
   ENUM_ORDER_TYPE_TIME timeType = ORDER_TIME_SPECIFIED;
   long modes = SymbolInfoInteger(symbol, SYMBOL_EXPIRATION_MODE);
   if((modes & SYMBOL_EXPIRATION_SPECIFIED) == 0)
   {
      // The broker will not honour a stated expiry; fall back to GTC and rely
      // on the local expiry check above (which cancels it), rather than
      // refusing an otherwise valid entry.
      timeType = ORDER_TIME_GTC;
      expiry = 0;
   }

   trade.SetDeviationInPoints((int)MathMax(1, g_plans[index].maxSlippagePoints));
   string comment = "nt:" + g_plans[index].id;
   double lots = NormaliseVolume(symbol, g_plans[index].lots);
   if(lots <= 0) return false;
   bool ok = false;
   if(isBuy && isLimit)       ok = trade.BuyLimit(lots, trigger, symbol, g_plans[index].sl, g_plans[index].tp, timeType, expiry, comment);
   else if(isBuy)             ok = trade.BuyStop(lots, trigger, symbol, g_plans[index].sl, g_plans[index].tp, timeType, expiry, comment);
   else if(isLimit)           ok = trade.SellLimit(lots, trigger, symbol, g_plans[index].sl, g_plans[index].tp, timeType, expiry, comment);
   else                       ok = trade.SellStop(lots, trigger, symbol, g_plans[index].sl, g_plans[index].tp, timeType, expiry, comment);

   if(ok)
   {
      g_plans[index].pendingTicket = (ulong)trade.ResultOrder();
      g_plans[index].pendingPlacedAt = NowUtcMs();
      PmEvent((ulong)trade.ResultOrder(), "pending_placed",
              StringFormat("%s %s %.5f (%s) expiry %s",
                           (isBuy ? "BUY" : "SELL"), (isLimit ? "LIMIT" : "STOP"),
                           trigger, symbol,
                           (timeType == ORDER_TIME_SPECIFIED ? TimeToString(expiry, TIME_DATE | TIME_MINUTES) : "GTC/local")));
      AddResult(g_plans[index].id, "done", (long)trade.ResultOrder(), trigger, 0,
                StringFormat("pending %s placed at %.5f", (isLimit ? "limit" : "stop"), trigger));
      return true;
   }
   AddResult(g_plans[index].id, "rejected", 0, 0, 0,
             "pending rejected: retcode " + IntegerToString(trade.ResultRetcode()) + " " + trade.ResultRetcodeDescription());
   return false;
}

void CancelPending(const int index, const string reason)
{
   if(g_plans[index].pendingTicket == 0) return;
   ulong ticket = g_plans[index].pendingTicket;
   if(trade.OrderDelete(ticket))
      PmEvent(ticket, "pending_cancelled", reason);
   else
      PmEvent(ticket, "pending_cancel_failed", trade.ResultRetcodeDescription());
   g_plans[index].pendingTicket = 0;
}

bool LastClosedBarBeyondTrigger(const string symbol, const bool isBuy, const double trigger)
{
   MqlRates rates[];
   if(CopyRates(symbol, PERIOD_CURRENT, 0, 3, rates) < 3) return false;
   double closed = rates[1].close; // rates[0] is the forming bar
   return isBuy ? (closed >= trigger) : (closed <= trigger);
}

void EvaluatePlans()
{
   // UTC, because `expiresAt` comes from the server as a UTC epoch in
   // milliseconds. Comparing it with NowServer()*1000 — a trade-server epoch —
   // put the clock two or three hours ahead of itself on a normal broker, so
   // EVERY plan was declared expired on the first evaluation after arming and
   // nothing the desk approved ever reached the market. It also meant a broker
   // west of UTC kept plans alive hours after their TTL.
   long nowMs = NowUtcMs();
   for(int i = 0; i < MAX_PLANS; i++)
   {
      if(!g_plans[i].active) continue;
      if(g_plans[i].expiresAt > 0 && nowMs > g_plans[i].expiresAt)
      {
         Log("Plan " + g_plans[i].id + " expired untriggered.");
         CancelPending(i, "plan expired");
         g_plans[i].active = false;
         continue;
      }

      string symbol = g_plans[i].symbol;
      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick)) continue;
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0) continue;
      double price = g_plans[i].isBuy ? tick.ask : tick.bid;
      double spread = (tick.ask - tick.bid) / point;

      bool invalidated = g_plans[i].isBuy ? tick.bid <= g_plans[i].invalidate : tick.ask >= g_plans[i].invalidate;
      if(invalidated)
      {
         Log("Plan " + g_plans[i].id + " invalidated before trigger.");
         CancelPending(i, "plan invalidated");
         g_plans[i].active = false;
         continue;
      }

      // ── v3.05: a working pending order owns the plan until it fills,
      // expires, is invalidated, or the market runs away from it.
      if(UsePendingOrders && g_plans[i].entryType != 0 && g_plans[i].pendingTicket != 0)
      {
         ulong pendingTicket = g_plans[i].pendingTicket;
         if(!OrderSelect(pendingTicket))
         {
            // Filled or removed at the terminal: the state is created by
            // OnTradeTransaction/the reconcile pass, so the plan is done.
            g_plans[i].pendingTicket = 0;
            g_plans[i].active = false;
            continue;
         }
         double riskPoints = g_plans[i].riskPoints > 0 ? g_plans[i].riskPoints : MathAbs(g_plans[i].trigger - g_plans[i].sl) / point;
         // "Ran away": the entry missed by half a risk unit. Chasing it from
         // here would fill at a price the plan was never sized for.
         double away = g_plans[i].isBuy ? (price - g_plans[i].trigger) / point
                                        : (g_plans[i].trigger - price) / point;
         if(riskPoints > 0 && away >= riskPoints * 0.5)
         {
            CancelPending(i, StringFormat("price ran %.2fR away from the trigger unfilled — entry missed", away / riskPoints));
            g_plans[i].active = false;
            continue;
         }
         continue;
      }

      // Keep the plan through a temporary news blackout; it will expire using
      // its server-generated TTL instead of turning a calendar pause into a
      // blind post-news market order.
      if(IsNewsBlackout(symbol))
      {
         Log("Plan " + g_plans[i].id + " held: high-impact news blackout.");
         continue;
      }
      if(!TradingAllowed(symbol))
      {
         g_plans[i].active = false;
         continue;
      }

      // ── v3.05: prefer a resting order for limit/stop entries ──────────────
      if(UsePendingOrders && g_plans[i].entryType != 0 && TryPlacePending(i)) continue;

      bool through = g_plans[i].isBuy ? price >= g_plans[i].trigger : price <= g_plans[i].trigger;
      if(!through)
      {
         g_plans[i].confirmCount = 0;
         continue;
      }
      if(ConfirmOnBarClose && g_plans[i].barConfirm)
      {
         // Confirmation is a CLOSED bar beyond the trigger, not N ticks of a
         // forming one: N ticks can all belong to the same wig that immediately
         // reverses, which is what makes a breakout-chase entry systematically
         // worse than the level it is chasing.
         if(!LastClosedBarBeyondTrigger(symbol, g_plans[i].isBuy, g_plans[i].trigger))
         {
            g_plans[i].confirmCount = 0;
            continue;
         }
      }
      else
      {
         g_plans[i].confirmCount++;
         if(g_plans[i].confirmCount < g_plans[i].confirmTicks) continue;
      }
      if(g_plans[i].maxSpreadPoints > 0 && spread > g_plans[i].maxSpreadPoints) continue;

      ExecutePlan(i, price);
   }
}

void ExecutePlan(const int index, const double referencePrice)
{
   string symbol = g_plans[index].symbol;
   double lots = NormaliseVolume(symbol, g_plans[index].lots);
   if(lots <= 0)
   {
      AddResult(g_plans[index].id, "rejected", 0, 0, 0, "volume normalises below broker minimum");
      g_plans[index].active = false;
      return;
   }

   trade.SetDeviationInPoints((int)MathMax(1, g_plans[index].maxSlippagePoints));
   bool ok = g_plans[index].isBuy
      ? trade.Buy(lots, symbol, 0.0, g_plans[index].sl, g_plans[index].tp, "nt:" + g_plans[index].id)
      : trade.Sell(lots, symbol, 0.0, g_plans[index].sl, g_plans[index].tp, "nt:" + g_plans[index].id);

   if(ok)
   {
      double fill = trade.ResultPrice();
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      double slip = point > 0 ? MathAbs(fill - referencePrice) / point : 0;
      AddResult(g_plans[index].id, "filled", (long)trade.ResultOrder(), fill, slip, "");
      Log("FILLED " + symbol + " " + (g_plans[index].isBuy ? "BUY" : "SELL") + " " + DoubleToString(lots, 2));
   }
   else
   {
      AddResult(g_plans[index].id, "rejected", 0, 0, 0,
                "retcode " + IntegerToString(trade.ResultRetcode()) + " " + trade.ResultRetcodeDescription());
      Log("Order rejected on " + symbol + ": " + trade.ResultRetcodeDescription());
   }
   // Exactly one terminal attempt per plan. Retrying a failed buy here risks a
   // duplicate position after a broker timeout.
   g_plans[index].pendingTicket = 0;
   g_plans[index].active = false;
}

// NOTE (v3.05): the v3.04 ManageOpenPositions() lived here. It looked its
// management plan up through the symbol→plan lookup helper, which only ever
// returns a plan that is still ACTIVE — and a fill deactivates the plan — so
// after a fill (which deactivates the plan) every threshold fell back to a
// hard-coded +1.0R/+0.2R breakeven, the trail (M15 ATR for every mode) and the
// partial/time-stop/pyramid ladder never ran. It has been replaced by the
// ticket-keyed state machine further down this file; see "v3.05 — POSITION
// MANAGEMENT STATE MACHINE".

bool ModifyPositionByTicket(const ulong ticket, const string symbol, const double sl, const double tp)
{
   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = sl;
   request.tp = tp;
   bool sent = OrderSend(request, result);
   if(!sent || result.retcode != TRADE_RETCODE_DONE)
   {
      Log("SL/TP modification failed on #" + IntegerToString(ticket) + ": " + IntegerToString((long)result.retcode));
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Commands                                                          |
//+------------------------------------------------------------------+
void HandleCommand(const string obj)
{
   string id = JsonString(obj, "id");
   string type = JsonString(obj, "type");
   if(id == "" || type == "") return;
   if(AlreadySeen(id)) return;
   MarkSeen(id);

   if(type == "arm_plan") ArmPlanFromJson(obj, id);
   else if(type == "cancel_plan") CancelPlan(JsonString(obj, "planId"), id);
   else if(type == "close") ClosePosition((ulong)JsonNumber(obj, "ticket"), 0, id);
   else if(type == "close_partial") ClosePosition((ulong)JsonNumber(obj, "ticket"), JsonNumber(obj, "lots"), id);
   else if(type == "modify") ModifyPositionCommand(obj, id);
   else if(type == "set_management") ApplyManagementCommand(obj, id);
   else if(type == "flatten_all") { FlattenAll(JsonString(obj, "reason")); AddResult(id, "done", 0, 0, 0, ""); }
   else AddResult(id, "skipped", 0, 0, 0, "unknown command type");
}

void ArmPlanFromJson(const string obj, const string commandId)
{
   if(!g_tradingEnabled)
   {
      AddResult(commandId, "skipped", 0, 0, 0, "trading disabled by server");
      return;
   }
   string plan = JsonObject(obj, "plan");
   if(plan == "")
   {
      AddResult(commandId, "rejected", 0, 0, 0, "arm_plan has no nested plan");
      return;
   }
   string symbol = JsonString(plan, "symbol");
   if(symbol == "" || !TradingAllowed(symbol))
   {
      AddResult(commandId, "skipped", 0, 0, 0, "local safety guard blocked this plan");
      return;
   }

   int slot = -1;
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].symbol == symbol) g_plans[i].active = false;
   for(int i = 0; i < MAX_PLANS; i++)
      if(!g_plans[i].active) { slot = i; break; }
   if(slot < 0)
   {
      AddResult(commandId, "rejected", 0, 0, 0, "no free local plan slot");
      return;
   }

   g_plans[slot].id = JsonString(plan, "id");
   g_plans[slot].symbol = symbol;
   g_plans[slot].isBuy = JsonString(plan, "side") == "buy";
   g_plans[slot].trigger = JsonNumber(plan, "trigger");
   g_plans[slot].invalidate = JsonNumber(plan, "invalidate");
   g_plans[slot].sl = JsonNumber(plan, "sl");
   g_plans[slot].tp = JsonFirstArrayNumber(plan, "tp");
   g_plans[slot].lots = JsonNumber(plan, "lots");
   g_plans[slot].maxSpreadPoints = JsonNumber(plan, "maxSpreadPoints");
   g_plans[slot].maxSlippagePoints = JsonNumber(plan, "maxSlippagePoints");
   g_plans[slot].expiresAt = (long)JsonNumber(plan, "expiresAt");
   g_plans[slot].confirmTicks = (int)MathMax(1, JsonNumber(plan, "confirmTicks"));
   g_plans[slot].confirmCount = 0;
   g_plans[slot].pendingTicket = 0;
   g_plans[slot].pendingPlacedAt = 0;

   // ── v3.05: entry semantics, mode and the entry frame ──────────────────────
   // "break"/"market" fire on the trigger tick (legacy behaviour, unchanged);
   // "limit"/"stop" place a REAL pending order instead of chasing the price;
   // "confirm"/"retest" wait for a closed bar beyond the trigger when
   // ConfirmOnBarClose is on.
   string triggerType = JsonString(plan, "triggerType");
   if(triggerType == "limit")       g_plans[slot].entryType = 1;
   else if(triggerType == "stop")   g_plans[slot].entryType = 2;
   else                             g_plans[slot].entryType = 0;
   g_plans[slot].barConfirm = (triggerType == "confirm" || triggerType == "retest");

   string modeName = JsonString(plan, "mode");
   g_plans[slot].mode = (modeName == "scalp" ? 0 : (modeName == "swing" ? 2 : 1));
   g_plans[slot].costPrice = JsonNumber(plan, "costPrice");

   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double riskPoints = JsonNumber(plan, "riskPoints");
   if(riskPoints <= 0 && point > 0)
      riskPoints = MathAbs(g_plans[slot].trigger - g_plans[slot].sl) / point;
   g_plans[slot].riskPoints = riskPoints;

   string entryTf = JsonString(plan, "entryTimeframe");
   int tfIndex = TfIndexFromName(entryTf);
   if(tfIndex < 0)
   {
      string managementForTf = JsonObject(plan, "management");
      string timeStopForTf = JsonObject(managementForTf, "timeStop");
      tfIndex = TfIndexFromName(JsonString(timeStopForTf, "timeframe"));
   }
   if(tfIndex < 0)
      tfIndex = (g_plans[slot].mode == 0 ? 1 : (g_plans[slot].mode == 1 ? 4 : 6)); // M2 / M15 / H1
   g_plans[slot].entryTfIndex = tfIndex;

   // ── Management policy is captured HERE, at arm time ───────────────────────
   // The whole point of v3.05: the position must not need the plan later.
   string management = JsonObject(plan, "management");
   string breakeven = JsonObject(management, "breakeven");
   g_plans[slot].beTriggerR = JsonNumber(breakeven, "triggerR");
   g_plans[slot].beOffsetR = JsonNumber(breakeven, "offsetR");
   int structureFlag = JsonBool(breakeven, "structureBuffer");
   g_plans[slot].beStructure = (structureFlag != 0);
   // The structure deadline. Presence is checked by NAME rather than by value,
   // because 0 is a meaningful setting ("wait for structure, however long it
   // takes") and must not be confused with a plan that predates the field.
   g_plans[slot].beFallbackR = (StringFind(breakeven, "\"structureFallbackR\"") >= 0)
                                  ? JsonNumber(breakeven, "structureFallbackR")
                                  : PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
   string trail = JsonObject(management, "trail");
   g_plans[slot].trailMult = JsonNumber(trail, "mult");
   g_plans[slot].trailActivateR = JsonNumber(trail, "activateAtR");
   g_plans[slot].trailStepPoints = JsonNumber(trail, "stepPoints");
   g_plans[slot].trailMode = PmTrailModeFromName(JsonString(trail, "mode"));
   double trailPeriod = JsonNumber(trail, "period");
   g_plans[slot].trailPeriod = (trailPeriod > 0 ? (int)trailPeriod : 14);
   g_plans[slot].trailEnabled = (trail != "");
   string timeStop = JsonObject(management, "timeStop");
   g_plans[slot].timeStopBars = (int)JsonNumber(timeStop, "noProgressBars");
   string pyramid = JsonObject(management, "pyramid");
   g_plans[slot].pyramidMaxAdds = (int)JsonNumber(pyramid, "maxAdds");
   g_plans[slot].pyramidAddAtR = JsonNumber(pyramid, "addAtR");
   g_plans[slot].pyramidSizeRatio = JsonNumber(pyramid, "sizeRatio");
   g_plans[slot].pyramidRequireBe = (JsonBool(pyramid, "requireBaseAtBreakeven") == 1);
   string guards = JsonObject(management, "guards");
   g_plans[slot].flatBeforeClose = (JsonBool(guards, "flatBeforeSessionClose") == 1);
   PositionState policyCarrier;
   ParsePartials(management, policyCarrier);
   g_plans[slot].partialCount = policyCarrier.partialCount;
   for(int i = 0; i < 4; i++)
   {
      g_plans[slot].partialAtR[i] = policyCarrier.partialAtR[i];
      g_plans[slot].partialPct[i] = policyCarrier.partialPct[i];
   }

   if(g_plans[slot].beTriggerR <= 0) g_plans[slot].beTriggerR = 1.0;
   if(g_plans[slot].trailMult <= 0)
      g_plans[slot].trailMult = (g_plans[slot].mode == 0 ? PM_TRAIL_MULT_SCALP :
                                (g_plans[slot].mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING));
   g_plans[slot].active = true;
   AddResult(commandId, "done", 0, 0, 0, "");
}

void CancelPlan(const string planId, const string commandId)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].id == planId) g_plans[i].active = false;
   AddResult(commandId, "done", 0, 0, 0, "");
}

void ClosePosition(const ulong ticket, const double lots, const string commandId)
{
   if(!PositionSelectByTicket(ticket))
   {
      AddResult(commandId, "skipped", 0, 0, 0, "position not found");
      return;
   }
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   string symbol = PositionGetString(POSITION_SYMBOL);
   bool ok = (lots > 0 && lots < currentVolume)
      ? trade.PositionClosePartial(ticket, NormaliseVolume(symbol, lots))
      : trade.PositionClose(ticket);
   AddResult(commandId, ok ? "done" : "rejected", (long)ticket, trade.ResultPrice(), 0,
             ok ? "" : trade.ResultRetcodeDescription());
}

void ModifyPositionCommand(const string obj, const string commandId)
{
   ulong ticket = (ulong)JsonNumber(obj, "ticket");
   if(!PositionSelectByTicket(ticket))
   {
      AddResult(commandId, "skipped", 0, 0, 0, "position not found");
      return;
   }
   string symbol = PositionGetString(POSITION_SYMBOL);
   bool ok = ModifyPositionByTicket(ticket, symbol, JsonNumber(obj, "sl"), JsonNumber(obj, "tp"));
   AddResult(commandId, ok ? "done" : "rejected", (long)ticket, 0, 0, ok ? "" : "modify rejected");
}

/**
 * Parse the `partials` ladder out of a management block into a position state.
 *
 * The ladder is a JSON array of objects. It is scanned object-by-object with
 * the same brace counter the command splitter uses, rather than by string
 * search for each key, so a nested object inside a rung cannot be mistaken for
 * the rung itself. Parsing stops at the array's closing bracket — never at the
 * end of the enclosing document, which is how a missing rung once produced a
 * "partial" at R=0.
 */
int ParsePartials(const string json, PositionState &ps)
{
   ps.partialCount = 0;
   for(int i = 0; i < 4; i++) { ps.partialAtR[i] = 0; ps.partialPct[i] = 0; }
   int cursor = StringFind(json, "\"partials\"");
   if(cursor < 0) return 0;
   int start = StringFind(json, "[", cursor);
   if(start < 0) return 0;
   int depth = 0;
   int objStart = -1;
   int count = 0;
   int length = StringLen(json);
   for(int i = start; i < length && count < 4; i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{')
      {
         if(depth == 0) objStart = i;
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 0 && objStart >= 0)
         {
            string obj = StringSubstr(json, objStart, i - objStart + 1);
            double atR = JsonNumber(obj, "atR");
            double pct = JsonNumber(obj, "closePct");
            if(atR > 0 && pct > 0)
            {
               ps.partialAtR[count] = atR;
               ps.partialPct[count] = pct;
               count++;
            }
            objStart = -1;
         }
      }
      else if(ch == ']' && depth == 0) break;
   }
   ps.partialCount = count;
   return count;
}

/**
 * `set_management` — replace the management policy of an OPEN position.
 *
 * v3.04 declared this command in types.ts and never implemented it: the server
 * could send it, the EA's switch fell through to "unknown command type", and
 * the management a plan had described was silently lost when the plan itself
 * was replaced. It is implemented here against the POSITION STATE (by ticket),
 * which is the only object that survives the plan.
 */
void ApplyManagementCommand(const string obj, const string commandId)
{
   ulong ticket = (ulong)JsonNumber(obj, "ticket");
   if(ticket == 0 || !PositionSelectByTicket(ticket))
   {
      AddResult(commandId, "skipped", (long)ticket, 0, 0, "position not found");
      return;
   }
   int index = PsEnsure(ticket);
   if(index < 0)
   {
      AddResult(commandId, "rejected", (long)ticket, 0, 0, "no free position-state slot");
      return;
   }
   string management = JsonObject(obj, "management");
   if(management == "")
   {
      AddResult(commandId, "rejected", (long)ticket, 0, 0, "set_management has no management block");
      return;
   }
   PositionState ps = g_ps[index];
   string breakeven = JsonObject(management, "breakeven");
   if(breakeven != "")
   {
      ps.beTriggerR = JsonNumber(breakeven, "triggerR");
      ps.beOffsetR = JsonNumber(breakeven, "offsetR");
      ps.beStructure = (JsonBool(breakeven, "structureBuffer") == 1);
      // Absent = a policy from an older desk → the default deadline, not "no
      // deadline": a stop that never moves is the defect being fixed.
      ps.beFallbackR = (StringFind(breakeven, "\"structureFallbackR\"") >= 0)
                          ? JsonNumber(breakeven, "structureFallbackR")
                          : PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
      // A policy sent WITHOUT break-even (`breakeven` absent) means "no
      // scheduled stop move", so the deadline must not fire either.
   }
   else
   {
      ps.beTriggerR = 0;
      ps.beStructure = false;
      ps.beFallbackR = 0;
   }
   string trail = JsonObject(management, "trail");
   ps.trailEnabled = (trail != "");
   if(trail != "")
   {
      ps.trailMult = JsonNumber(trail, "mult");
      ps.trailActivateR = JsonNumber(trail, "activateAtR");
      ps.trailStepPoints = JsonNumber(trail, "stepPoints");
      ps.trailMode = PmTrailModeFromName(JsonString(trail, "mode"));
      double period = JsonNumber(trail, "period");
      ps.trailPeriod = (period > 0 ? (int)period : 14);
      if(ps.trailMult <= 0)
         ps.trailMult = (ps.mode == 0 ? PM_TRAIL_MULT_SCALP :
                        (ps.mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING));
   }
   string timeStop = JsonObject(management, "timeStop");
   ps.timeStopBars = (int)JsonNumber(timeStop, "noProgressBars");
   ps.timeStopEnabled = (timeStop != "" && ps.timeStopBars > 0);
   string guards = JsonObject(management, "guards");
   ps.flatBeforeClose = (JsonBool(guards, "flatBeforeSessionClose") == 1);
   string pyramid = JsonObject(management, "pyramid");
   ps.pyramidEnabled = (pyramid != "");
   if(pyramid != "")
   {
      ps.pyramidMaxAdds = (int)JsonNumber(pyramid, "maxAdds");
      ps.pyramidAddAtR = JsonNumber(pyramid, "addAtR");
      ps.pyramidSizeRatio = JsonNumber(pyramid, "sizeRatio");
      ps.pyramidRequireBe = (JsonBool(pyramid, "requireBaseAtBreakeven") == 1);
   }
   ps.partialCount = ParsePartials(management, ps);
   g_ps[index] = ps;
   PsSave(ps);
   PmEvent(ticket, "set_management", "management policy replaced by the Desk");
   AddResult(commandId, "done", (long)ticket, 0, 0, "");
}

void FlattenAll(const string reason)
{
   for(int i = 0; i < MAX_PLANS; i++)
   {
      // A pending order is a live order: flattening must remove it, or the
      // desk has "closed everything" while an entry waits in the book.
      if(g_plans[i].active && g_plans[i].pendingTicket != 0) CancelPending(i, "flatten_all: " + reason);
      g_plans[i].active = false;
   }
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i);
      if(symbol == "") continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      trade.PositionClose((ulong)PositionGetInteger(POSITION_TICKET));
   }
   Log("FLATTEN ALL: " + reason);
}

//+------------------------------------------------------------------+
//| Safety guards                                                     |
//+------------------------------------------------------------------+
bool TradingAllowed(const string symbol)
{
   if(!g_tradingEnabled) return false;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return false;
   if(SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) return false;
   if(DailyLossBreached()) return false;
   if(IsNewsBlackout(symbol)) return false;

   bool isLive = AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL;
   if(isLive && (!AllowLiveAccount || !g_liveTradingEnabled)) return false;
   return true;
}

bool DailyLossBreached()
{
   if(g_dayStartEquity <= 0 || MaxDailyLossPct <= 0) return false;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   return ((g_dayStartEquity - equity) / g_dayStartEquity * 100.0) >= MaxDailyLossPct;
}

void ResetDayBaseline()
{
   g_dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   MqlDateTime stamp;
   TimeToStruct(NowServer(), stamp);
   g_dayStamp = stamp.day_of_year;
}

void RollDayBaselineIfNeeded()
{
   MqlDateTime stamp;
   TimeToStruct(NowServer(), stamp);
   if(g_dayStamp != stamp.day_of_year) ResetDayBaseline();
}

bool RespectsStopLevel(const string symbol, const bool isBuy, const double price, const double sl)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   long stops = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(point <= 0 || stops <= 0) return true;
   return MathAbs(price - sl) / point >= (double)stops;
}

double NormaliseVolume(const string symbol, const double lots)
{
   double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double normalised = MathFloor(lots / step + 1e-9) * step;
   if(normalised < minVolume) return 0;
   if(normalised > maxVolume) normalised = maxVolume;
   int volumeDigits = step < 0.01 ? 3 : 2;
   return NormalizeDouble(normalised, volumeDigits);
}

// AtrValue() moved to the v3.05 state-machine section: the v3.04 version
// created, copied and released an indicator handle on EVERY call — several per
// tick, per position. The cached version lives with the state machine.

// REMOVED in v3.05: FindPlanForSymbol(). It was the path by which management
// looked a plan up by symbol, and because it required `active` it returned
// nothing after a fill — the root of the lost-management defect. Management is
// keyed by ticket now (see ManageOnePosition), so there is no reason for a
// symbol lookup to exist, and leaving one would invite the defect back.

//+------------------------------------------------------------------+
//| v3.05 — POSITION MANAGEMENT STATE MACHINE                        |
//|                                                                  |
//| WHY THIS REPLACES THE OLD ManageOpenPositions()                  |
//|                                                                  |
//| v3.04 lost the management plan at fill. ExecutePlan() set        |
//| g_plans[i].active = false, and every management feature —        |
//| breakeven, the trailing stop, partials, the time stop, the       |
//| session flatten, pyramiding — was looked up through              |
//| FindPlanForSymbol(), which requires `active`. After a fill the   |
//| EA therefore fell back to hard-coded +1.0R / +0.2R breakeven,    |
//| never trailed, and executed NONE of the partial/time-stop/       |
//| pyramid ladder the server had computed.                          |
//|                                                                  |
//| The state below is keyed by TICKET and owns its own copy of the  |
//| policy. It never consults an armed plan: the plan can be         |
//| replaced, expired, cancelled or lost with a terminal restart and  |
//| the position is still managed exactly as it was planned.         |
//|                                                                  |
//| The rules implemented here are the SAME rules as                 |
//| artifacts/api-server/src/lib/multiasset/position-manager.ts, and  |
//| they are pinned by golden vectors on both sides (see              |
//| docs/mt5-live-desk-v4.md, "MQL5 ↔ TypeScript mapping").           |
//+------------------------------------------------------------------+

// The state this section operates on — the `PositionState` record, its arrays
// and the `PM_*` policy constants — is declared in the SHARED STATE section
// near the top of this file, together with the plan and link state it belongs
// with. MQL5 resolves names in TEXT ORDER, and the plan/command handlers ABOVE
// this section already reference them, so the declarations cannot live here.

//+------------------------------------------------------------------+
//| State array plumbing                                             |
//+------------------------------------------------------------------+
int PsIndex(const ulong ticket)
{
   for(int i = 0; i < g_psCount; i++)
      if(g_ps[i].ticket == ticket) return i;
   return -1;
}

/**
 * v3.07: a blank position state with EVERY field set. Before v3.07 only six
 * fields were set here, and the reconcile pass (and PsApplyDefaults) never set
 * entryTfIndex or mode. The slot kept whatever an earlier position had left in
 * it, so PsEncode() read a stale timeframe index, indexed TF_NAMES[] out of
 * range on the first save after a fill, and the expert was stopped.
 */
void PsInitBlank(PositionState &ps, const ulong ticket)
{
   ps.ticket = ticket;
   ps.planId = "";
   ps.symbol = "";
   ps.isBuy = true;
   ps.mode = 1;                                  // intraday until a plan says otherwise
   ps.entryTfIndex = TfIndexForMode(1);
   ps.entry = 0;
   ps.initialSl = 0;
   ps.sl = 0;
   ps.tp = 0;
   ps.riskPrice = 0;
   ps.volume = 0;
   ps.initialVolume = 0;
   ps.openedAt = 0;
   ps.barsSinceEntry = 0;
   ps.progressR = 0;
   ps.mfeR = 0;
   ps.bestPrice = 0;
   ps.stage = "OPEN_RISK";
   ps.partialsDone = 0;
   ps.beDone = false;
   ps.trailArmed = false;
   ps.pyramidAdds = 0;
   ps.closedVolume = 0;
   ps.costPrice = 0;
   ps.atrEntry = 0;
   ps.lastModifyAt = 0;
   ps.lastModifyR = 0;
   ps.retryAfter = 0;
   ps.retryCount = 0;
   ps.beTriggerR = 0;
   ps.beOffsetR = 0;
   ps.beStructure = true;
   ps.beFallbackR = PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
   ps.trailMode = 0;
   ps.partialCount = 0;
   for(int i = 0; i < 4; i++)
   {
      ps.partialAtR[i] = 0;
      ps.partialPct[i] = 0;
   }
   ps.trailEnabled = false;
   ps.trailMode = 0;
   ps.trailMult = 0;
   ps.trailActivateR = 0;
   ps.trailStepPoints = 0;
   ps.trailPeriod = 14;
   ps.timeStopEnabled = false;
   ps.timeStopBars = 0;
   ps.pyramidEnabled = false;
   ps.pyramidMaxAdds = 0;
   ps.pyramidAddAtR = 0;
   ps.pyramidSizeRatio = 0;
   ps.pyramidRequireBe = false;
   ps.flatBeforeClose = false;
}

int PsEnsure(const ulong ticket)
{
   int index = PsIndex(ticket);
   if(index >= 0) return index;
   if(g_psCount >= MAX_POS_STATES) return -1;
   PositionState blank;
   PsInitBlank(blank, ticket);
   g_ps[g_psCount] = blank;
   return g_psCount++;
}

void PsRemove(const ulong ticket)
{
   int index = PsIndex(ticket);
   if(index < 0) return;
   for(int i = index; i < g_psCount - 1; i++) g_ps[i] = g_ps[i + 1];
   g_psCount--;
   string name = PS_PREFIX + IntegerToString((long)ticket);
   if(GlobalVariableCheck(name)) GlobalVariableDel(name);
   string file = PS_DIR + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "_" +
                 IntegerToString((long)ticket) + ".csv";
   FileDelete(file, FILE_COMMON);
}

//+------------------------------------------------------------------+
//| Persistence (COMMON files + global-variable index)               |
//+------------------------------------------------------------------+
string PsStageOr(const string stage) { return stage == "" ? "OPEN_RISK" : stage; }

string PsEncode(const PositionState &ps)
{
   string f[];
   ArrayResize(f, 31);
   f[0]  = "v3";
   f[1]  = IntegerToString((long)ps.ticket);
   f[2]  = ps.planId;
   f[3]  = ps.symbol;
   f[4]  = ps.isBuy ? "b" : "s";
   f[5]  = (ps.mode == 0 ? "S" : (ps.mode == 1 ? "I" : "W"));
   f[6]  = TfNameAt(ps.entryTfIndex);
   f[7]  = DoubleToString(ps.entry, 8);
   f[8]  = DoubleToString(ps.initialSl, 8);
   f[9]  = DoubleToString(ps.sl, 8);
   f[10] = (ps.tp > 0 ? DoubleToString(ps.tp, 8) : "");
   f[11] = DoubleToString(ps.riskPrice, 8);
   f[12] = DoubleToString(ps.volume, 8);
   f[13] = DoubleToString(ps.initialVolume, 8);
   f[14] = IntegerToString(ps.openedAt);
   f[15] = IntegerToString(ps.barsSinceEntry);
   f[16] = DoubleToString(ps.progressR, 8);
   f[17] = DoubleToString(ps.mfeR, 8);
   f[18] = DoubleToString(ps.bestPrice, 8);
   f[19] = PsStageOr(ps.stage);
   f[20] = IntegerToString(ps.partialsDone);
   f[21] = (ps.beDone ? "1" : "0");
   f[22] = (ps.trailArmed ? "1" : "0");
   f[23] = IntegerToString(ps.pyramidAdds);
   f[24] = DoubleToString(ps.closedVolume, 8);
   f[25] = DoubleToString(ps.costPrice, 8);
   f[26] = DoubleToString(ps.atrEntry, 8);
   f[27] = IntegerToString(ps.lastModifyAt);
   f[28] = DoubleToString(ps.lastModifyR, 8);
   // v2 (v3.09): the structure deadline travels with the position, so a restart
   // does not silently revert a policy the owner configured. Appended LAST so a
   // v1 record written by an earlier build still decodes.
   f[29] = DoubleToString(ps.beFallbackR, 8);
   // v3 (v3.09): the owner's TRAIL MODE travels with the position too, so a
   // restart cannot quietly turn a structure trail back into a chandelier.
   // Appended last again, so a v1 or v2 record still decodes.
   f[30] = IntegerToString(ps.trailMode);
   string out = f[0];
   for(int i = 1; i < 31; i++) out += "|" + f[i];
   return out;
}

bool PsDecode(const string text, PositionState &ps)
{
   string f[];
   int n = StringSplit(text, StringGetCharacter("|", 0), f);
   // v1 (29 fields, v3.08 — no deadline, no trail mode), v2 (30 fields, v3.09 —
   // adds beFallbackR) and v3 (31 fields, v3.09 — adds trailMode). Older records
   // decode with the defaults rather than being discarded: an upgrade must not
   // orphan a live position's management state.
   bool v1 = (n == 29 && f[0] == "v1");
   bool v2 = (n == 30 && f[0] == "v2");
   bool v3 = (n == 31 && f[0] == "v3");
   if(!v1 && !v2 && !v3) return false;
   ps.ticket         = (ulong)StringToInteger(f[1]);
   ps.planId         = f[2];
   ps.symbol         = f[3];
   ps.isBuy          = (f[4] == "b");
   ps.mode           = (f[5] == "S" ? 0 : (f[5] == "I" ? 1 : 2));
   // v3.07: a record with an unknown timeframe name is repaired, not stored as -1.
   int decodedTf = TfIndexFromName(f[6]);
   ps.entryTfIndex   = (decodedTf >= 0 ? decodedTf : TfIndexForMode(ps.mode));
   ps.entry          = StringToDouble(f[7]);
   ps.initialSl      = StringToDouble(f[8]);
   ps.sl             = StringToDouble(f[9]);
   ps.tp             = (f[10] == "" ? 0 : StringToDouble(f[10]));
   ps.riskPrice      = StringToDouble(f[11]);
   ps.volume         = StringToDouble(f[12]);
   ps.initialVolume  = StringToDouble(f[13]);
   ps.openedAt       = (long)StringToInteger(f[14]);
   ps.barsSinceEntry = (int)StringToInteger(f[15]);
   ps.progressR      = StringToDouble(f[16]);
   ps.mfeR           = StringToDouble(f[17]);
   ps.bestPrice      = StringToDouble(f[18]);
   ps.stage          = f[19];
   ps.partialsDone   = (int)StringToInteger(f[20]);
   ps.beDone         = (f[21] == "1");
   ps.trailArmed     = (f[22] == "1");
   ps.pyramidAdds    = (int)StringToInteger(f[23]);
   ps.closedVolume   = StringToDouble(f[24]);
   ps.costPrice      = StringToDouble(f[25]);
   ps.atrEntry       = StringToDouble(f[26]);
   ps.lastModifyAt   = (long)StringToInteger(f[27]);
   ps.lastModifyR    = StringToDouble(f[28]);
   ps.beFallbackR    = (v2 || v3) ? StringToDouble(f[29]) : PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
   ps.trailMode      = v3 ? (int)StringToInteger(f[30]) : 0;
   if(ps.trailMode < 0 || ps.trailMode > 2) ps.trailMode = 0;
   return (ps.entryTfIndex >= 0 && ps.riskPrice > 0);
}

string PsFileName(const ulong ticket)
{
   return PS_DIR + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "_" +
          IntegerToString((long)ticket) + ".csv";
}

void PsSave(const PositionState &ps)
{
   string file = PsFileName(ps.ticket);
   int handle = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Log("position state write failed for #" + IntegerToString((long)ps.ticket));
      return;
   }
   FileWriteString(handle, PsEncode(ps));
   FileClose(handle);
   GlobalVariableSet(PS_PREFIX + IntegerToString((long)ps.ticket), (double)NowUtcMs());
}

bool PsLoad(const ulong ticket, PositionState &ps)
{
   string file = PsFileName(ticket);
   if(!FileIsExist(file, FILE_COMMON)) return false;
   int handle = FileOpen(file, FILE_READ | FILE_TXT | FILE_COMMON | FILE_ANSI);
   if(handle == INVALID_HANDLE) return false;
   string text = "";
   while(!FileIsEnding(handle)) text += FileReadString(handle);
   FileClose(handle);
   StringTrimRight(text);
   StringTrimLeft(text);
   if(text == "") return false;
   return PsDecode(text, ps);
}

/**
 * Rebuild every managed position after a restart.
 *
 * The global variables are the INDEX (which tickets this terminal manages) and
 * the files are the RECORD. A ticket whose position no longer exists is
 * cleared from both — a stale record must never resurrect management for a
 * position that is already closed.
 */
void PsRestoreAll()
{
   g_psCount = 0;
   int total = GlobalVariablesTotal();
   int restored = 0;
   for(int i = 0; i < total; i++)
   {
      string name = GlobalVariableName(i);
      if(StringFind(name, PS_PREFIX) != 0) continue;
      ulong ticket = (ulong)StringToInteger(StringSubstr(name, StringLen(PS_PREFIX)));
      if(ticket == 0) continue;
      PositionState ps;
      if(!PositionSelectByTicket(ticket))
      {
         PsRemove(ticket);
         continue;
      }
      if(!PsLoad(ticket, ps)) continue;
      int slot = PsEnsure(ticket);
      if(slot < 0) continue;
      g_ps[slot] = ps;
      restored++;
   }
   if(restored > 0)
      Print("NeurotradeBridge: restored management for ", restored, " open position(s) after restart.");
}

//+------------------------------------------------------------------+
//| Structure and ATR (entry timeframe!)                             |
//+------------------------------------------------------------------+
/**
 * Cached ATR handle.
 *
 * The old AtrValue() created an indicator handle, copied one value and
 * released it ON EVERY CALL — several handles per tick, per position, and the
 * terminal's indicator subsystem is not free. Handles are now created once per
 * symbol/timeframe/period, checked with BarsCalculated() before the copy (a
 * fresh handle returns nothing for the first ticks) and released in OnDeinit.
 */
int AtrHandle(const string symbol, const ENUM_TIMEFRAMES tf, const int period)
{
   for(int i = 0; i < g_atrHandleCount; i++)
      if(g_atrHandles[i].symbol == symbol && g_atrHandles[i].tf == tf && g_atrHandles[i].period == period)
         return g_atrHandles[i].handle;
   if(g_atrHandleCount >= MAX_ATR_HANDLES) return INVALID_HANDLE;
   int handle = iATR(symbol, tf, period);
   if(handle == INVALID_HANDLE) return INVALID_HANDLE;
   g_atrHandles[g_atrHandleCount].symbol = symbol;
   g_atrHandles[g_atrHandleCount].tf = tf;
   g_atrHandles[g_atrHandleCount].period = period;
   g_atrHandles[g_atrHandleCount].handle = handle;
   g_atrHandleCount++;
   return handle;
}

void ReleaseAtrHandles()
{
   for(int i = 0; i < g_atrHandleCount; i++)
      if(g_atrHandles[i].handle != INVALID_HANDLE) IndicatorRelease(g_atrHandles[i].handle);
   g_atrHandleCount = 0;
}

double AtrValue(const string symbol, const ENUM_TIMEFRAMES timeframe, const int period)
{
   int handle = AtrHandle(symbol, timeframe, period);
   if(handle == INVALID_HANDLE) return 0;
   if(BarsCalculated(handle) < 2) return 0;
   double buffer[];
   if(CopyBuffer(handle, 0, 0, 1, buffer) <= 0) return 0;
   return buffer[0];
}

/**
 * The trail mode, from the name the Desk sends.
 *
 * The Desk's settings surface offers three trailing styles, so the terminal has
 * to implement three — a dropdown whose value the EA ignored was exactly the
 * "setting that does not apply" the owner reported. Anything unknown (an older
 * Desk, a name this build does not know) degrades to the chandelier, which is
 * every preset's default.
 */
int PmTrailModeFromName(const string name)
{
   if(name == "structure")    return 1;
   if(name == "fixed_points") return 2;
   return 0;   // "atr_chandelier", and anything unrecognised
}

/**
 * Breakeven's structure requirement: a confirmed higher low (buy) / lower high
 * (sell) beyond the entry, plus a closed bar in profit.
 *
 * "Price ticked +1R for one tick" is not structure. This is the difference
 * between a stop that protects a trade and a stop that scratches one.
 */
bool PmStructureConfirmed(const string symbol, const ENUM_TIMEFRAMES tf,
                          const bool isBuy, const double entry)
{
   MqlRates rates[];
   int need = PM_SWING_LOOKBACK * 2 + 12;
   if(CopyRates(symbol, tf, 0, need, rates) < need) return false;
   int n = ArraySize(rates);
   // The last element is the FORMING bar: only closed bars may confirm.
   int lastClosed = n - 2;
   if(lastClosed < PM_SWING_LOOKBACK * 2) return false;
   if(isBuy && !(rates[lastClosed].close > entry)) return false;
   if(!isBuy && !(rates[lastClosed].close < entry)) return false;

   // Most recent fractal pivot, scanning backwards; a pivot needs lookback bars
   // AFTER it, so it can never be one of the last two.
   for(int i = lastClosed - PM_SWING_LOOKBACK; i >= PM_SWING_LOOKBACK; i--)
   {
      bool isPivot = true;
      for(int j = i - PM_SWING_LOOKBACK; j <= i + PM_SWING_LOOKBACK; j++)
      {
         if(j == i) continue;
         if(isBuy && rates[j].low <= rates[i].low) { isPivot = false; break; }
         if(!isBuy && rates[j].high >= rates[i].high) { isPivot = false; break; }
      }
      if(!isPivot) continue;
      double pivot = isBuy ? rates[i].low : rates[i].high;
      return isBuy ? (pivot > entry) : (pivot < entry);
   }
   return false;
}

/**
 * WHERE structure is now, for the `structure` trail.
 *
 * `PmStructureConfirmed` answers "has structure turned?"; this answers "where is
 * the level?". Same fractal rule, walked backwards from the newest closed bar,
 * and only a pivot BEYOND the entry is offered — a swing on the wrong side of
 * entry is not a stop, it is a loss. Returning false means "no level yet"; the
 * caller defers and asks again on the next tick rather than loosening the rule.
 */
bool PmLastSwingStop(const string symbol, const ENUM_TIMEFRAMES tf, const bool isBuy,
                     const double entry, double &out)
{
   MqlRates rates[];
   int need = PM_SWING_LOOKBACK * 2 + 12;
   if(CopyRates(symbol, tf, 0, need, rates) < need) return false;
   int n = ArraySize(rates);
   int lastClosed = n - 2;
   if(lastClosed < PM_SWING_LOOKBACK * 2) return false;
   for(int i = lastClosed - PM_SWING_LOOKBACK; i >= PM_SWING_LOOKBACK; i--)
   {
      bool isPivot = true;
      for(int j = i - PM_SWING_LOOKBACK; j <= i + PM_SWING_LOOKBACK; j++)
      {
         if(j == i) continue;
         if(isBuy && rates[j].low <= rates[i].low) { isPivot = false; break; }
         if(!isBuy && rates[j].high >= rates[i].high) { isPivot = false; break; }
      }
      if(!isPivot) continue;
      double level = isBuy ? rates[i].low : rates[i].high;
      if(isBuy ? (level < entry) : (level > entry)) continue;
      out = level;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Broker distance rules and modification                           |
//+------------------------------------------------------------------+
bool PmRespectsBroker(const string symbol, const bool isBuy, const double sl, const double atr)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0) return false;
   double stops = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   double buffer = MathMax(stops, atr * 0.1);
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) return false;
   // A buy's stop must clear the BID (that is where it would fill); a sell's the ASK.
   return isBuy ? (sl <= tick.bid - buffer) : (sl >= tick.ask + buffer);
}

bool PmModifyStop(const string symbol, const ulong ticket, const double sl, const double tp)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(point <= 0) return false;
   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = NormalizeDouble(sl, digits);
   request.tp = NormalizeDouble(tp, digits);
   if(!OrderSend(request, result)) return false;
   return (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED);
}

//+------------------------------------------------------------------+
//| Management events (the audit trail the journal shows)            |
//+------------------------------------------------------------------+
void PmEvent(const ulong ticket, const string kind, const string detail)
{
   string entry = "{\"ticket\":" + IntegerToString((long)ticket) +
                  ",\"kind\":\"" + JsonEscape(kind) +
                  "\",\"detail\":\"" + JsonEscape(detail) +
                  "\",\"ts\":" + IntegerToString(NowUtcMs()) + "}";
   if(g_mgmtEventCount < MAX_MGMT_EVENTS)
   {
      g_mgmtEvents[g_mgmtEventCount++] = entry;
      return;
   }
   for(int i = 0; i < MAX_MGMT_EVENTS / 2; i++) g_mgmtEvents[i] = g_mgmtEvents[i + MAX_MGMT_EVENTS / 2];
   g_mgmtEventCount = MAX_MGMT_EVENTS / 2;
   g_mgmtEvents[g_mgmtEventCount++] = entry;
}

string ManagementEventsJson()
{
   string json = "[";
   for(int i = 0; i < g_mgmtEventCount; i++)
   {
      if(i > 0) json += ",";
      json += g_mgmtEvents[i];
   }
   return json + "]";
}

//+------------------------------------------------------------------+
//| Tick stream (v3.05, WP4D)                                        |
//|                                                                  |
//| The flow agent needs the tick TAPE, not a 500 ms sample of it:    |
//| signed-volume imbalance, 1 s/10 s variance ratios and burst       |
//| intensity are all invisible in one quote per beat. The chart       |
//| symbol's ticks are buffered locally on every OnTick and the most   |
//| recent ones ride the heartbeat; other symbols are sampled once per |
//| beat (MT5 delivers no OnTick for an unselected chart symbol).      |
//+------------------------------------------------------------------+
void PushTick(const string symbol, const MqlTick &tick)
{
   if(g_tickCount < MAX_TICK_BUF)
   {
      g_ticks[g_tickCount].symbol = symbol;
      g_ticks[g_tickCount].ts = (long)tick.time_msc;
      g_ticks[g_tickCount].bid = tick.bid;
      g_ticks[g_tickCount].ask = tick.ask;
      g_tickCount++;
      return;
   }
   // Buffer full: drop the OLDEST tick of the same symbol, keeping a rolling
   // window per symbol rather than the whole tape of one busy instrument.
   for(int i = 0; i < MAX_TICK_BUF; i++)
   {
      if(g_ticks[i].symbol != symbol) continue;
      for(int j = i; j < MAX_TICK_BUF - 1; j++) g_ticks[j] = g_ticks[j + 1];
      g_ticks[MAX_TICK_BUF - 1].symbol = symbol;
      g_ticks[MAX_TICK_BUF - 1].ts = (long)tick.time_msc;
      g_ticks[MAX_TICK_BUF - 1].bid = tick.bid;
      g_ticks[MAX_TICK_BUF - 1].ask = tick.ask;
      return;
   }
}

string TicksJson(const string &symbols[], const int perSymbol)
{
   if(!StreamTicks) return "[]";
   string json = "[";
   bool first = true;
   for(int s = 0; s < ArraySize(symbols); s++)
   {
      string symbol = symbols[s];
      if(symbol == "") continue;
      int emitted = 0;
      for(int i = g_tickCount - 1; i >= 0 && emitted < perSymbol; i--)
      {
         if(g_ticks[i].symbol != symbol) continue;
         if(!first) json += ",";
         first = false;
         json += "{\"symbol\":\"" + JsonEscape(symbol) +
                 "\",\"ts\":" + IntegerToString(g_ticks[i].ts) +
                 ",\"bid\":" + DoubleToString(g_ticks[i].bid, 8) +
                 ",\"ask\":" + DoubleToString(g_ticks[i].ask, 8) + "}";
         emitted++;
      }
   }
   return json + "]";
}

//+------------------------------------------------------------------+
//| THE STATE MACHINE                                                |
//|                                                                  |
//| Priority: session/news flatten → regime exit → time stop →        |
//| partials → breakeven → trail → pyramid. At most ONE stop          |
//| modification per evaluation: several would race into the broker    |
//| and the last to land would win, which is not a decision.          |
//+------------------------------------------------------------------+
int PmTfIndex(const int index)
{
   return (index >= 0 && index < TF_COUNT) ? index : 1;
}

bool PmQuantiseVolume(const string symbol, const double want, double &out)
{
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   if(step <= 0) step = 0.01;
   if(vmin <= 0) vmin = step;
   double units = MathFloor(want / step + 1e-9);
   out = NormalizeDouble(units * step, 8);
   return (out >= vmin);
}

void ManageOnePosition(const int index)
{
   ulong ticket = g_ps[index].ticket;
   if(!PositionSelectByTicket(ticket))
   {
      PmEvent(ticket, "closed", "position no longer exists — state cleared");
      PsRemove(ticket);
      return;
   }
   PositionState ps = g_ps[index];
   string symbol = PositionGetString(POSITION_SYMBOL);
   bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double currentSl = PositionGetDouble(POSITION_SL);
   double currentTp = PositionGetDouble(POSITION_TP);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(point <= 0) return;

   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) return;

   // Book-keeping from the broker (the position is the truth, not our copy).
   ps.volume = volume;
   if(!ps.isBuy == isBuy) ps.isBuy = isBuy;
   if(ps.entry <= 0) ps.entry = entry;
   if(ps.initialSl <= 0 && currentSl > 0) ps.initialSl = currentSl;
   ps.sl = currentSl;
   ps.tp = currentTp;
   if(ps.riskPrice <= 0 && currentSl > 0)
      ps.riskPrice = MathAbs(entry - currentSl);
   if(ps.riskPrice <= 0) return;
   if(ps.entryTfIndex < 0 || ps.entryTfIndex >= TF_COUNT) ps.entryTfIndex = 1;
   ENUM_TIMEFRAMES tf = TF_LIST[SafeTfIndex(ps.entryTfIndex)];

   double exitPrice = isBuy ? tick.bid : tick.ask;
   double movePrice = isBuy ? (exitPrice - ps.entry) : (ps.entry - exitPrice);
   ps.progressR = movePrice / ps.riskPrice;
   ps.mfeR = MathMax(ps.mfeR, ps.progressR);
   ps.bestPrice = isBuy ? MathMax(ps.bestPrice <= 0 ? ps.entry : ps.bestPrice, exitPrice)
                        : MathMin(ps.bestPrice <= 0 ? ps.entry : ps.bestPrice, exitPrice);

   // Bars COMPLETED on the entry frame since the fill.
   datetime openSec = (datetime)(ps.openedAt / 1000);
   int shift = iBarShift(symbol, tf, openSec, false);
   ps.barsSinceEntry = (shift > 0 ? shift : 0);

   double atr = AtrValue(symbol, tf, ps.trailPeriod > 0 ? ps.trailPeriod : 14);
   if(atr <= 0) atr = ps.atrEntry;

   // ── 1. Session / news flatten ─────────────────────────────────────────────
   if(ps.flatBeforeClose && IsNewsBlackout(symbol) && ps.mode != 2)
   {
      if(trade.PositionClose(ticket))
      {
         PmEvent(ticket, "flatten_news", "high-impact news blackout — position flattened");
         ps.stage = "SESSION_NEWS_FLAT";
         g_ps[index] = ps;
         PsSave(ps);
      }
      return;
   }

   // ── 2. Time stop ──────────────────────────────────────────────────────────
   if(ps.timeStopEnabled && ps.barsSinceEntry >= ps.timeStopBars)
   {
      if(ps.progressR < PM_TIME_STOP_PROGRESS_R && ps.mfeR < PM_TIME_STOP_MFE_R)
      {
         if(trade.PositionClose(ticket))
         {
            string detail = StringFormat("%d %s bars with no progress (%.2fR, MFE %.2fR) — time stop",
                                         ps.barsSinceEntry, TfNameAt(ps.entryTfIndex), ps.progressR, ps.mfeR);
            PmEvent(ticket, "time_stop", detail);
            ps.stage = "TIME_STOP";
            g_ps[index] = ps;
            PsSave(ps);
         }
         return;
      }
   }

   bool modifyDone = false;

   // ── 3. Ladder partials ────────────────────────────────────────────────────
   if(ps.partialCount > 0 && ps.partialsDone < ps.partialCount && ps.partialsDone < 4)
   {
      if(ps.progressR >= ps.partialAtR[ps.partialsDone])
      {
         double want = ps.initialVolume * (ps.partialPct[ps.partialsDone] / 100.0);
         double lots = 0;
         bool legal = PmQuantiseVolume(symbol, want, lots);
         double remainder = ps.volume - lots;
         double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
         if(!legal)
         {
            PmEvent(ticket, "partial_skipped",
                    StringFormat("%.0f%% rung is below the broker minimum — rung consumed",
                                 ps.partialPct[ps.partialsDone]));
            ps.partialsDone++;
         }
         else if(lots >= ps.volume)
         {
            if(trade.PositionClose(ticket))
            {
               PmEvent(ticket, "close_all", "ladder rung is the whole position");
               ps.stage = "CLOSED";
               g_ps[index] = ps;
               PsSave(ps);
            }
            return;
         }
         else if(remainder < vmin)
         {
            double shrunk = 0;
            if(PmQuantiseVolume(symbol, ps.volume - vmin, shrunk) && shrunk >= vmin)
            {
               lots = shrunk;
            }
            else if(trade.PositionClose(ticket))
            {
               PmEvent(ticket, "close_all", "a partial would leave an illegal remainder — closed instead");
               ps.stage = "CLOSED";
               g_ps[index] = ps;
               PsSave(ps);
               return;
            }
         }
         if(lots > 0 && trade.PositionClosePartial(ticket, lots))
         {
            ps.partialsDone++;
            ps.volume = NormalizeDouble(ps.volume - lots, 8);
            ps.closedVolume = NormalizeDouble(ps.closedVolume + lots, 8);
            if(ps.stage == "OPEN_RISK" || ps.stage == "BE_ARMED") ps.stage = "PARTIAL";
            PmEvent(ticket, "partial", StringFormat("%.0f%% ladder rung: closed %.2f lots at %.2fR, %.2f left",
                                                    ps.partialPct[ps.partialsDone - 1], lots, ps.progressR, ps.volume));
            g_ps[index] = ps;
            PsSave(ps);
         }
      }
   }

   // ── 4. Breakeven ──────────────────────────────────────────────────────────
   if(ps.beTriggerR > 0 && !ps.beDone && ps.progressR >= ps.beTriggerR)
   {
      bool structural = !ps.beStructure || PmStructureConfirmed(symbol, tf, isBuy, ps.entry);
      /**
       * THE STRUCTURE DEADLINE.
       *
       * Structure confirmation is the better reading of "+1R" and it is also how
       * a winning position kept its original stop indefinitely: on a fast frame
       * the pivot the rule wants may simply never print, so the trigger is met,
       * the confirmation never comes, and nothing happens. That is the reported
       * defect.
       *
       * `ps.beFallbackR` is R past the trigger after which the stop moves on the
       * R trigger alone. 0 disables the fallback (wait for structure, however
       * long it takes). The Desk sets it per mode; its own state machine
       * implements the identical rule, and both are pinned by golden vectors.
       */
      bool pastDeadline = (ps.beFallbackR > 0) && (ps.progressR >= ps.beTriggerR + ps.beFallbackR);
      bool confirmed = structural || pastDeadline;
      if(confirmed)
      {
         /**
          * THE OWNER'S OFFSET, NOT A CONSTANT.
          *
          * `offsetR` is a setting (0–2R, per mode) and it used to be captured —
          * and then ignored, because this line used the EA's own constant. An
          * owner who asked for the stop half an R beyond entry got 0.05R, which
          * is a setting that does not apply. The constant is now only the floor
          * for a position the Desk has not pushed a policy to yet.
          */
         double beOffsetR = (ps.beOffsetR > 0) ? ps.beOffsetR : PM_BREAKEVEN_PROFIT_R;
         double offset = ps.costPrice + beOffsetR * ps.riskPrice;
         double candidate = isBuy ? ps.entry + offset : ps.entry - offset;
         bool tighter = (currentSl <= 0) || (isBuy ? candidate > currentSl : candidate < currentSl);
         if(!PmRespectsBroker(symbol, isBuy, candidate, atr))
         {
            // Not marked done: a breakeven that never reached the market must
            // not read as "risk-free" to the pyramid rule or the desk.
            if(VerboseLog)
               Log("breakeven deferred on #" + IntegerToString((long)ticket) + ": candidate inside the stop level");
         }
         else if(!tighter)
         {
            ps.beDone = true;
            if(ps.stage == "OPEN_RISK") ps.stage = "BE_ARMED";
            g_ps[index] = ps;
            PsSave(ps);
         }
         else if(NowUtcMs() >= ps.retryAfter)
         {
            if(PmModifyStop(symbol, ticket, candidate, currentTp))
            {
               ps.beDone = true;
               ps.sl = candidate;
               ps.lastModifyAt = NowUtcMs();
               ps.lastModifyR = ps.progressR;
               ps.retryCount = 0;
               if(ps.stage == "OPEN_RISK") ps.stage = "BE_ARMED";
               modifyDone = true;
               PmEvent(ticket, "breakeven",
                       structural
                         ? StringFormat("+%.2fR with structure confirmed → stop %.5f (entry + cost + %.2fR)",
                                        ps.progressR, candidate, beOffsetR)
                         : StringFormat("+%.2fR — structure had not confirmed by +%.2fR (deadline) → stop %.5f anyway (entry + cost + %.2fR)",
                                        ps.progressR, ps.beTriggerR + ps.beFallbackR, candidate, beOffsetR));
               g_ps[index] = ps;
               PsSave(ps);
            }
            else
            {
               ps.retryCount++;
               ps.retryAfter = NowUtcMs() + PM_RETRY_BACKOFF_MS * ps.retryCount;
               PmEvent(ticket, "modify_failed",
                       StringFormat("breakeven modify rejected (attempt %d) — retrying after back-off", ps.retryCount));
               g_ps[index] = ps;
               PsSave(ps);
            }
         }
      }
   }

   // ── 5. Trailing stop — the OWNER'S mode ──────────────────────────────────
   //
   // Three styles, all three implemented here because all three are offered in
   // the Desk's settings surface:
   //
   //   0 atr_chandelier  the extreme minus an ATR multiple (every preset)
   //   1 structure       behind the last confirmed swing beyond entry
   //   2 fixed_points    a fixed distance in points behind the extreme
   //
   // Structure mode can find no level yet (a pivot needs bars AFTER it): that is
   // a deferral, never a reason to loosen the rule or to fall back silently.
   if(ps.trailEnabled && !modifyDone && ps.progressR >= ps.trailActivateR && atr > 0)
   {
      double mult = ps.trailMult > 0 ? ps.trailMult : (ps.mode == 0 ? PM_TRAIL_MULT_SCALP :
                                                      (ps.mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING));
      double best = ps.bestPrice > 0 ? ps.bestPrice : exitPrice;
      double candidate = 0;
      string trailNote = "";
      if(ps.trailMode == 1)
      {
         double swing = 0;
         if(PmLastSwingStop(symbol, tf, isBuy, ps.entry, swing))
         {
            candidate = swing;
            trailNote = StringFormat("structure: last confirmed %s %.5f",
                                     isBuy ? "swing low" : "swing high", swing);
         }
         else if(VerboseLog)
            Log("trail deferred on #" + IntegerToString((long)ticket) + ": no confirmed swing beyond entry yet");
      }
      else if(ps.trailMode == 2)
      {
         double distance = (ps.trailStepPoints > 0 ? ps.trailStepPoints * point : mult * atr);
         candidate = isBuy ? best - distance : best + distance;
         trailNote = StringFormat("fixed: %.5f behind the extreme (%.0f points)", best, distance / point);
      }
      else
      {
         candidate = isBuy ? best - mult * atr : best + mult * atr;
         trailNote = StringFormat("chandelier: best %.5f − %.1fxATR(%d,%s)", best, mult, ps.trailPeriod, TfNameAt(ps.entryTfIndex));
      }

      // The Desk folds `minStepAtr` into `stepPoints` before sending, so a
      // non-zero step IS the owner's minimum. The ATR floor only applies to a
      // position with no pushed policy (stepPoints still 0).
      double minStep = (ps.trailStepPoints > 0) ? ps.trailStepPoints * point : PM_TRAIL_MIN_STEP_ATR * atr;
      double improvement = (candidate > 0) ? (isBuy ? (candidate - currentSl) : (currentSl - candidate))
                                           : -1.0;
      bool cooling = (NowUtcMs() - ps.lastModifyAt) < PM_MODIFY_COOLDOWN_MS;
      bool meaningful = (ps.progressR - ps.lastModifyR) >= PM_MODIFY_COOLDOWN_R;
      if(candidate > 0 && improvement >= minStep)
      {
         if(cooling && !meaningful)
         {
            // Deferred, not lost: the next evaluation re-tests it.
         }
         else if(!PmRespectsBroker(symbol, isBuy, candidate, atr))
         {
            if(VerboseLog)
               Log("trail deferred on #" + IntegerToString((long)ticket) + ": candidate inside the stop level");
         }
         else if(NowUtcMs() >= ps.retryAfter)
         {
            if(PmModifyStop(symbol, ticket, candidate, currentTp))
            {
               ps.sl = candidate;
               ps.trailArmed = true;
               ps.lastModifyAt = NowUtcMs();
               ps.lastModifyR = ps.progressR;
               ps.retryCount = 0;
               if(ps.beDone && ps.partialsDone > 0) ps.stage = "RUNNER";
               PmEvent(ticket, "trail", trailNote + StringFormat(" → stop %.5f", candidate));
               g_ps[index] = ps;
               PsSave(ps);
            }
            else
            {
               ps.retryCount++;
               ps.retryAfter = NowUtcMs() + PM_RETRY_BACKOFF_MS * ps.retryCount;
               g_ps[index] = ps;
               PsSave(ps);
            }
         }
      }
   }

   // ── 6. Pyramid ────────────────────────────────────────────────────────────
   if(ps.pyramidEnabled && ps.pyramidAdds < ps.pyramidMaxAdds)
   {
      bool baseSafe = !ps.pyramidRequireBe || ps.beDone;
      if(baseSafe && ps.progressR >= ps.pyramidAddAtR)
      {
         double addLots = 0;
         if(PmQuantiseVolume(symbol, ps.initialVolume * ps.pyramidSizeRatio, addLots))
         {
            trade.SetDeviationInPoints(10);
            bool ok = isBuy ? trade.Buy(addLots, symbol, 0.0, ps.initialSl, currentTp,
                                        "nt-add:" + ps.planId)
                            : trade.Sell(addLots, symbol, 0.0, ps.initialSl, currentTp,
                                         "nt-add:" + ps.planId);
            if(ok)
            {
               ps.pyramidAdds++;
               ps.stage = "PYRAMID";
               // The add is a NEW position with its own ticket and its own
               // state; the base keeps managing itself.
               ulong addTicket = (ulong)trade.ResultOrder();
               PsCreateFromPlanId(addTicket, ps.planId, isBuy, addLots, trade.ResultPrice(), 0, symbol);
               PmEvent(ticket, "pyramid",
                       StringFormat("added %.2f lots at %.5f at %.2fR (stop %.5f)",
                                    addLots, trade.ResultPrice(), ps.progressR, ps.initialSl));
            }
            else
            {
               PmEvent(ticket, "pyramid_failed", trade.ResultRetcodeDescription());
            }
         }
         g_ps[index] = ps;
         PsSave(ps);
      }
   }

   g_ps[index] = ps;
   PsSave(ps);
}

/**
 * Reconcile positions whose state is missing.
 *
 * This is the path that CATCHES A PENDING-ORDER FILL (and a market fill that
 * happened while the EA was reloading): the position exists, the tape says so,
 * but no state was written because the fill did not come from ExecutePlan().
 * The plan id travels in the position comment (`nt:<planId>`), so the original
 * policy is recovered from the plan when it is still present; otherwise the
 * state is seeded from the position itself with conservative defaults.
 */
void ReconcileFilledPositions()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i);
      if(symbol == "") continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      if(PsIndex(ticket) >= 0) continue;
      string comment = PositionGetString(POSITION_COMMENT);
      string planId = "";
      int marker = StringFind(comment, "nt:");
      if(marker >= 0)
      {
         planId = StringSubstr(comment, marker + 3);
      }
      int dash = StringFind(planId, "-add:");
      if(dash >= 0) planId = StringSubstr(planId, 0, dash);
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double volume = PositionGetDouble(POSITION_VOLUME);
      long openedMs = ToUtcMs((datetime)PositionGetInteger(POSITION_TIME));
      int slot = PsEnsure(ticket);
      if(slot < 0) return;
      PositionState ps = g_ps[slot];
      ps.symbol = symbol;
      ps.planId = planId;
      ps.isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      ps.entry = entry;
      ps.initialSl = sl;
      ps.sl = sl;
      ps.tp = tp;
      ps.volume = volume;
      ps.initialVolume = volume;
      ps.openedAt = openedMs;
      ps.riskPrice = (sl > 0 ? MathAbs(entry - sl) : 0);
      ps.bestPrice = entry;
      ps.stage = "OPEN_RISK";
      // v3.07: the reconcile path never knew the mode or timeframe. Set both
      // explicitly here (intraday until a plan says otherwise) instead of
      // inheriting whatever the slot held.
      ps.mode = 1;
      ps.entryTfIndex = TfIndexForMode(ps.mode);
      // Recover the plan's policy if the plan is still armed.
      bool found = false;
      for(int p = 0; p < MAX_PLANS; p++)
      {
         if(!g_plans[p].active || g_plans[p].id != planId) continue;
         if(planId == "") continue;
         PsApplyPlanPolicy(ps, g_plans[p]);
         found = true;
         break;
      }
      if(!found) PsApplyDefaults(ps);
      else PmEvent(ticket, "reconciled", "state created from the armed plan at reconcile");
      g_ps[slot] = ps;
      PsSave(ps);
   }
}

/** Conservative defaults for a position with no plan (EA restarted, plan gone). */
void PsApplyDefaults(PositionState &ps)
{
   // v3.07: a defaulted position must still carry a valid mode and timeframe.
   if(ps.mode < 0 || ps.mode > 2) ps.mode = 1;
   ps.entryTfIndex = TfIndexForMode(ps.mode);
   ps.beTriggerR = 1.0;
   ps.beOffsetR = PM_BREAKEVEN_PROFIT_R;
   ps.beStructure = true;
   ps.beFallbackR = PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
   /**
    * v3.09: a defaulted position is no longer the one position in the terminal
    * with no ladder at all.
    *
    * The old default was `partialCount = 0` plus a structure-confirmed 1R
    * break-even — so a position whose plan had gone (an EA reload between the
    * fill and the first sync, a manual trade, a position opened while the desk
    * was redeploying) had NOTHING that could happen at 1R. The Desk pushes a
    * proper policy on the next heartbeat (`reconcileManagement`), and until it
    * arrives this rung is what makes "+1R and nothing happens" impossible: the
    * EA quantises it against the real broker volume and skips it if the
    * position cannot be split, exactly as it does for a plan's own ladder.
    */
   ps.partialCount = 1;
   ps.partialAtR[0] = 1.0;
   ps.partialPct[0] = 50;
   ps.partialAtR[1] = 0; ps.partialPct[1] = 0;
   ps.partialAtR[2] = 0; ps.partialPct[2] = 0;
   ps.partialAtR[3] = 0; ps.partialPct[3] = 0;
   ps.trailEnabled = true;
   ps.trailMode = 0;   // chandelier — every preset's default
   ps.trailMult = (ps.mode == 0 ? PM_TRAIL_MULT_SCALP : (ps.mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING));
   ps.trailActivateR = 1.2;
   ps.trailStepPoints = 1;
   ps.trailPeriod = 14;
   ps.timeStopEnabled = false;
   ps.pyramidEnabled = false;
   ps.flatBeforeClose = false;
}

/** Copy an armed plan's management policy onto a position state. */
void PsApplyPlanPolicy(PositionState &ps, const ArmedPlan &plan)
{
   ps.entryTfIndex = PmTfIndex(plan.entryTfIndex);
   ps.costPrice = plan.costPrice;
   ps.beTriggerR = (plan.beTriggerR > 0 ? plan.beTriggerR : 1.0);
   ps.beOffsetR = plan.beOffsetR;
   ps.beStructure = plan.beStructure;
   ps.beFallbackR = (plan.beFallbackR > 0 || plan.beStructure == false)
                       ? plan.beFallbackR
                       : PM_BREAKEVEN_STRUCTURE_FALLBACK_R;
   ps.partialCount = (int)MathMin(4, MathMax(0, plan.partialCount));
   for(int i = 0; i < ps.partialCount; i++)
   {
      ps.partialAtR[i] = plan.partialAtR[i];
      ps.partialPct[i] = plan.partialPct[i];
   }
   ps.trailEnabled = plan.trailEnabled;
   ps.trailMode = plan.trailMode;
   ps.trailMult = (plan.trailMult > 0 ? plan.trailMult :
                   (ps.mode == 0 ? PM_TRAIL_MULT_SCALP : (ps.mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING)));
   ps.trailActivateR = plan.trailActivateR;
   ps.trailStepPoints = (plan.trailStepPoints > 0 ? plan.trailStepPoints : 1);
   ps.trailPeriod = (plan.trailPeriod > 0 ? plan.trailPeriod : 14);
   ps.timeStopEnabled = (plan.timeStopBars > 0);
   ps.timeStopBars = plan.timeStopBars;
   ps.pyramidEnabled = (plan.pyramidMaxAdds > 0);
   ps.pyramidMaxAdds = plan.pyramidMaxAdds;
   ps.pyramidAddAtR = plan.pyramidAddAtR;
   ps.pyramidSizeRatio = plan.pyramidSizeRatio;
   ps.pyramidRequireBe = plan.pyramidRequireBe;
   ps.flatBeforeClose = plan.flatBeforeClose;
}

/**
 * Create the state for a position that has just been opened by an order this
 * EA placed (`resultTicket` is the ORDER ticket; the position ticket may
 * differ, but MT5 assigns both from the same sequence and the reconcile pass
 * above is the safety net either way).
 */
void PsCreateFromPlanId(const ulong orderTicket, const string planId, const bool isBuy,
                        const double lots, const double fillPrice, const int modeHint,
                        const string symbolHint)
{
   // Find the newest position on that symbol that has no state yet.
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i);
      if(symbol == "") continue;
      if(symbolHint != "" && symbol != symbolHint) continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      if(PsIndex(ticket) >= 0) continue;
      int slot = PsEnsure(ticket);
      if(slot < 0) return;
      PositionState ps = g_ps[slot];
      ps.symbol = symbol;
      ps.planId = planId;
      ps.isBuy = isBuy;
      ps.mode = (modeHint >= 0 ? modeHint : 1);
      ps.entry = (fillPrice > 0 ? fillPrice : PositionGetDouble(POSITION_PRICE_OPEN));
      ps.initialSl = PositionGetDouble(POSITION_SL);
      ps.sl = ps.initialSl;
      ps.tp = PositionGetDouble(POSITION_TP);
      ps.volume = lots;
      ps.initialVolume = lots;
      ps.openedAt = ToUtcMs((datetime)PositionGetInteger(POSITION_TIME));
      ps.riskPrice = (ps.initialSl > 0 ? MathAbs(ps.entry - ps.initialSl) : 0);
      ps.bestPrice = ps.entry;
      ps.stage = "OPEN_RISK";
      ps.entryTfIndex = (ps.mode == 0 ? 1 : (ps.mode == 1 ? 4 : 6)); // M2 / M15 / H1
      bool found = false;
      for(int p = 0; p < MAX_PLANS; p++)
      {
         if(!g_plans[p].active || g_plans[p].id != planId || planId == "") continue;
         PsApplyPlanPolicy(ps, g_plans[p]);
         found = true;
         break;
      }
      if(!found) PsApplyDefaults(ps);
      if(!(ps.riskPrice > 0))
      {
         // No stop on the position: nothing can be managed. Say so loudly —
         // an unprotected position is the one state the desk must never hide.
         PmEvent(ticket, "unprotected",
                 "position opened without a stop loss — management cannot size R; close it or set a stop");
      }
      g_ps[slot] = ps;
      PsSave(ps);
      PmEvent(ticket, "opened",
              StringFormat("state created at fill: entry %.5f, stop %.5f, R %.5f, %s",
                           ps.entry, ps.initialSl, ps.riskPrice, TfNameAt(ps.entryTfIndex)));
      return;
   }
   // The order is working but not filled yet (a pending order): the reconcile
   // pass creates the state when it fills.
}

//+------------------------------------------------------------------+
//| OnTradeTransaction — the fastest path from fill to managed state  |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(trans.deal)) return;
   if((int)HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != MagicNumber) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_ENTRY) != DEAL_ENTRY_IN) return;
   ulong positionId = (ulong)HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);
   if(PsIndex(positionId) >= 0) return;
   string symbol = HistoryDealGetString(trans.deal, DEAL_SYMBOL);
   double price = HistoryDealGetDouble(trans.deal, DEAL_PRICE);
   double volume = HistoryDealGetDouble(trans.deal, DEAL_VOLUME);
   string comment = HistoryDealGetString(trans.deal, DEAL_COMMENT);
   string planId = "";
   int marker = StringFind(comment, "nt:");
   if(marker >= 0) planId = StringSubstr(comment, marker + 3);
   int dash = StringFind(planId, "-add:");
   if(dash >= 0) planId = StringSubstr(planId, 0, dash);
   bool isBuy = (HistoryDealGetInteger(trans.deal, DEAL_TYPE) == DEAL_TYPE_BUY);
   PsCreateFromPlanId(positionId, planId, isBuy, volume, price, -1, symbol);
}

//+------------------------------------------------------------------+
//| The management loop                                              |
//+------------------------------------------------------------------+
void ManageOpenPositions()
{
   if(DailyLossBreached())
   {
      // Local circuit breaker: flatten and record why for every position, so
      // the journal shows the management path that led there.
      for(int i = g_psCount - 1; i >= 0; i--) PmEvent(g_ps[i].ticket, "flatten_daily_loss", "local daily loss circuit breaker");
      FlattenAll("local daily loss circuit breaker");
      return;
   }

   // Positions that appeared without an ExecutePlan() fill (pending orders,
   // an EA reload mid-trade) get their state here, before management runs.
   ReconcileFilledPositions();

   for(int i = g_psCount - 1; i >= 0; i--)
   {
      if(i >= g_psCount) continue;
      ManageOnePosition(i);
   }
}

//+------------------------------------------------------------------+
//| Result queue and command idempotency                              |
//+------------------------------------------------------------------+
bool AlreadySeen(const string id)
{
   for(int i = 0; i < g_seenCount; i++)
      if(g_seenCmds[i] == id) return true;
   return false;
}

void MarkSeen(const string id)
{
   if(g_seenCount < MAX_SEEN_CMDS)
   {
      g_seenCmds[g_seenCount++] = id;
      return;
   }
   for(int i = 0; i < MAX_SEEN_CMDS / 2; i++) g_seenCmds[i] = g_seenCmds[i + MAX_SEEN_CMDS / 2];
   g_seenCount = MAX_SEEN_CMDS / 2;
   g_seenCmds[g_seenCount++] = id;
}

void AddResult(const string commandId, const string status, const long ticket,
               const double price, const double slippage, const string error)
{
   if(g_results != "") g_results += ",";
   g_results += "{\"commandId\":\"" + JsonEscape(commandId) + "\",\"status\":\"" + status +
                "\",\"ticket\":" + IntegerToString(ticket) +
                ",\"price\":" + DoubleToString(price, 10) +
                ",\"slippagePoints\":" + DoubleToString(slippage, 2) +
                ",\"error\":" + (error == "" ? "null" : "\"" + JsonEscape(error) + "\"") +
                ",\"ts\":" + IntegerToString(NowUtcMs()) + "}";
}

//+------------------------------------------------------------------+
//| Small JSON helpers                                                |
//| The server generates responses, so a compact reader avoids an    |
//| external dependency in an EA. Nested objects are extracted before|
//| reading fields so command and plan `id` fields cannot collide.   |
//+------------------------------------------------------------------+
string JsonString(const string json, const string key)
{
   string needle = "\"" + key + "\":\"";
   int start = StringFind(json, needle);
   if(start < 0) return "";
   start += StringLen(needle);
   int end = StringFind(json, "\"", start);
   return end < 0 ? "" : StringSubstr(json, start, end - start);
}

double JsonNumber(const string json, const string key)
{
   string needle = "\"" + key + "\":";
   int start = StringFind(json, needle);
   if(start < 0) return 0;
   start += StringLen(needle);
   int end = start;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      bool numeric = (ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E';
      if(!numeric) break;
      end++;
   }
   return end == start ? 0 : StringToDouble(StringSubstr(json, start, end - start));
}

double JsonFirstArrayNumber(const string json, const string key)
{
   string needle = "\"" + key + "\":[";
   int start = StringFind(json, needle);
   if(start < 0) return 0;
   start += StringLen(needle);
   int end = start;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      bool numeric = (ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E';
      if(!numeric) break;
      end++;
   }
   return end == start ? 0 : StringToDouble(StringSubstr(json, start, end - start));
}

int JsonBool(const string json, const string key)
{
   string needle = "\"" + key + "\":";
   int start = StringFind(json, needle);
   if(start < 0) return -1;
   start += StringLen(needle);
   return StringSubstr(json, start, 4) == "true" ? 1 : 0;
}

string JsonObject(const string json, const string key)
{
   string needle = "\"" + key + "\":{";
   int start = StringFind(json, needle);
   if(start < 0) return "";
   start += StringLen(needle) - 1;
   int depth = 0;
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{') depth++;
      else if(ch == '}')
      {
         depth--;
         if(depth == 0) return StringSubstr(json, start, i - start + 1);
      }
   }
   return "";
}

bool JsonStringArray(const string json, const string key, string &items[])
{
   ArrayResize(items, 0);
   string needle = "\"" + key + "\":[";
   int cursor = StringFind(json, needle);
   if(cursor < 0) return false;
   cursor += StringLen(needle);
   while(cursor < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, cursor);
      if(ch == ']') break;
      if(ch != '"') { cursor++; continue; }
      int start = ++cursor;
      int end = StringFind(json, "\"", start);
      if(end < 0) return false;
      int count = ArraySize(items);
      ArrayResize(items, count + 1);
      items[count] = StringSubstr(json, start, end - start);
      cursor = end + 1;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Generic helpers                                                   |
//+------------------------------------------------------------------+
string JsonEscape(string text)
{
   StringReplace(text, "\\", "\\\\");
   StringReplace(text, "\"", "\\\"");
   StringReplace(text, "\n", " ");
   StringReplace(text, "\r", " ");
   return text;
}

string StringTrimmed(string text)
{
   StringTrimLeft(text);
   StringTrimRight(text);
   return text;
}

string NormalisedServerUrl()
{
   string value = StringTrimmed(ServerUrl);
   while(StringLen(value) > 0 && StringGetCharacter(value, StringLen(value) - 1) == '/')
      value = StringSubstr(value, 0, StringLen(value) - 1);
   return value;
}

string ToUpper(string text)
{
   StringToUpper(text);
   return text;
}

bool Contains(const string haystack, const string needle)
{
   return StringFind(haystack, needle) >= 0;
}

bool IsFxCurrency(const string currency)
{
   string known[] = {"USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "NOK", "SEK", "DKK", "ZAR", "TRY", "MXN", "SGD", "HKD", "PLN", "CZK", "HUF"};
   for(int i = 0; i < ArraySize(known); i++) if(currency == known[i]) return true;
   return false;
}

string ClassifySymbol(const string symbol)
{
   string upper = ToUpper(symbol);
   string path = ToUpper(SymbolInfoString(symbol, SYMBOL_PATH));
   string base = ToUpper(SymbolInfoString(symbol, SYMBOL_CURRENCY_BASE));
   string quote = ToUpper(SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT));
   if(Contains(path, "CRYPTO") || Contains(upper, "BTC") || Contains(upper, "ETH") || Contains(upper, "XRP") || Contains(upper, "SOL")) return "crypto";
   if(Contains(path, "METAL") || Contains(upper, "XAU") || Contains(upper, "XAG") || Contains(upper, "XPT") || Contains(upper, "XPD")) return "metals";
   if(Contains(path, "FUTURE")) return "futures";
   if(Contains(path, "STOCK") || Contains(path, "SHARE") || Contains(path, "EQUITY")) return "stocks";
   if(Contains(path, "INDEX") || Contains(path, "INDICE") || Contains(upper, "US30") || Contains(upper, "NAS") || Contains(upper, "SPX") || Contains(upper, "DAX") || Contains(upper, "FTSE")) return "indices";
   if(Contains(path, "COMMOD") || Contains(path, "ENERGY") || Contains(upper, "WTI") || Contains(upper, "BRENT") || Contains(upper, "NGAS")) return "commodities";
   if(Contains(path, "FOREX") || Contains(path, " FX") || (IsFxCurrency(base) && IsFxCurrency(quote))) return "forex";
   return "other";
}

datetime NowServer()
{
   datetime value = TimeTradeServer();
   if(value <= 0) value = TimeCurrent();
   if(value <= 0) value = TimeLocal();
   return value;
}

void Log(const string message)
{
   if(VerboseLog) Print("NeurotradeBridge: ", message);
}
//+------------------------------------------------------------------+
