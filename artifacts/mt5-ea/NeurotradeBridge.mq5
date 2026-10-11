//+------------------------------------------------------------------+
//|                                          NeurotradeBridge.mq5    |
//|      NeuroTrade Multi-Asset Desk / resilient MetaTrader 5 EA     |
//+------------------------------------------------------------------+
//| Version 3.04                                                     |
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
//|  9. THE LINK OUTLIVES EVERY RESTART.                              |
//|     The bearer token used to live only in the EA's memory and on   |
//|     the server's heap, so closing MT5, closing the browser or a    |
//|     server redeploy broke the connection. The EA then retried its  |
//|     old pairing code every 5 seconds, the server had forgotten it  |
//|     too, and the MT5 journal filled with                       |
//|       HTTP 401 ... Unknown or expired pairing code                 |
//|     while the Desk showed "reconnecting" and armed plans were      |
//|     never delivered. The token AND the pairing code are now saved  |
//|     in the terminal's common Files folder (shared by every chart   |
//|     of this installation) and restored at startup, and the server  |
//|     persists the link as well. The connection now ends only when   |
//|     the user unlinks the terminal in the Desk.                     |
//| 10. A REFUSED TOKEN NO LONGER MEANS A BLIND RETRY LOOP.            |
//|     A definitive 401 clears the saved token, prints ONE line       |
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
//+------------------------------------------------------------------+
#property copyright "NeuroTrade AI"
#property version   "4.00"
#property strict

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
// Minutes before a symbol's session end at which `flatBeforeSessionClose` plans
// are flattened. The check reads the broker's own session table; when the table
// cannot be read the rule stays silent rather than guessing a close time.
input int    SessionFlatMinutesBeforeClose = 15;
input bool   VerboseLog                = true;

#define MAX_PLANS      32
#define MAX_SEEN_CMDS  512
// Open positions the management state machine tracks. Sized well above the
// desk's own `maxOpenPositions` (12) so a hand-opened position can never push a
// managed one out of the table.
#define MAX_MGMT_POSITIONS 24
#define MAX_PARTIALS        4
#define MAX_ATR_HANDLES    48
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
   double maxSpreadPoints;
   double maxSlippagePoints;
   long   expiresAt;
   int    confirmTicks;
   int    confirmCount;
   bool   active;

   // ── Management rules, captured at fill (v4.00) ────────────────────────────
   // These used to be read for break-even and the trail only, and only while
   // this plan object happened to still be `active` — which, after a fill, it
   // never was. They are now the source of the PositionState that survives the
   // plan, so the whole block is carried.
   string entryTimeframe;
   string mode;
   double costPoints;
   double beTriggerR;
   double beOffsetR;
   bool   beStructure;
   int    partialCount;
   double partialAtR[MAX_PARTIALS];
   double partialPct[MAX_PARTIALS];
   double trailMult;
   double trailPeriod;
   double trailActivateR;
   double trailStepPoints;
   bool   trailEnabled;
   double timeStopBars;
   int    timeStopPeriod;
   bool   flatBeforeClose;
};

CTrade trade;
ArmedPlan g_plans[MAX_PLANS];

//+------------------------------------------------------------------+
//| Position management state (v4.00, WP0)                            |
//|                                                                  |
//| THE DEFECT THIS REPLACES                                           |
//|                                                                    |
//| `ExecutePlan()` cleared `g_plans[i].active` the moment an order     |
//| filled, and `ManageOpenPositions()` looked its rules up through     |
//| `FindPlanForSymbol()`, which requires `active`. So the server's     |
//| management block died at the fill: break-even fell back to a        |
//| hard-coded +1.0R/+0.2R, the trail never ran, and the partial ladder,|
//| time stop, pyramid and flat-before-close rules were produced by the |
//| server and executed by nobody.                                      |
//|                                                                    |
//| The fix is not to keep the plan alive. A plan is an INTENT that     |
//| expires; a position is a COMMITMENT that outlives it. At fill, the  |
//| plan's rules are CAPTURED into a PositionState keyed by ticket,     |
//| persisted to terminal global variables so a restart cannot lose     |
//| them, and cleared when the position closes. Nothing here is looked  |
//| up through `active`.                                                |
//|                                                                    |
//| This mirrors `position-manager.ts` function for function; the       |
//| mapping and the golden vectors live in that module's test file.     |
//+------------------------------------------------------------------+

// Phase identifiers — must match PositionPhase in position-manager.ts.
#define PHASE_OPEN_RISK       0
#define PHASE_BE_ARMED        1
#define PHASE_PARTIAL         2
#define PHASE_RUNNER          3
#define PHASE_TIME_STOP       4
#define PHASE_REGIME_EXIT     5
#define PHASE_SESSION_NEWS_FLAT 6
#define PHASE_PYRAMID         7

// Mode identifiers — must match the `mode` string on the wire.
#define MODE_SCALP    0
#define MODE_INTRADAY 1
#define MODE_SWING    2

// Tolerances. Identical in intent to R_EPSILON / LEVEL_EPSILON_POINTS in the
// TypeScript machine: a level measured at 1.4999999999999445R IS 1.5R.
#define R_EPSILON            1e-9
#define LEVEL_EPSILON_POINTS 1e-6

struct PositionState
{
   bool     active;
   ulong    ticket;
   string   symbol;
   bool     isBuy;
   int      mode;
   int      entryPeriod;         // ENUM_TIMEFRAMES value of the entry frame
   double   entry;
   double   initialSl;
   double   riskPoints;          // |entry - initialSl| / point, frozen at fill
   double   point;
   int      digits;
   double   initialVolume;
   double   openVolume;
   long     openedAtMs;
   double   costPoints;

   // Rules captured at fill.
   double   beTriggerR;
   double   beOffsetR;
   bool     beStructure;
   int      partialCount;
   double   partialAtR[MAX_PARTIALS];
   double   partialPct[MAX_PARTIALS];
   bool     partialDone[MAX_PARTIALS];
   double   trailMult;
   double   trailPeriod;
   double   trailActivateR;
   double   trailStepPoints;
   double   timeStopBars;
   int      timeStopPeriod;      // the time stop's OWN frame, which need not be the entry frame
   bool     flatBeforeClose;
   double   maxSpreadPoints;
   bool     regimeExit;

   // Running state.
   int      phase;
   double   currentSl;
   bool     beApplied;
   int      pyramidAdds;
   double   bestR;
   double   worstR;
};

PositionState g_positions[MAX_MGMT_POSITIONS];

// Management events produced since the last heartbeat, drained into the sync
// payload so every stop move, partial and flatten reaches the desk's journal.
string    g_mgmtEvents = "";
int       g_mgmtEventCount = 0;

// Indicator handles are created ONCE per symbol/timeframe/period and reused.
// The old `AtrValue()` created an iATR handle and released it on every call —
// on every managed position, every tick. That is a handle churn the terminal
// pays for with repeated history recalculation on exactly the path that has to
// be fast.
string    g_atrKeys[MAX_ATR_HANDLES];
int       g_atrHandles[MAX_ATR_HANDLES];
int       g_atrCount = 0;

string    g_seenCmds[MAX_SEEN_CMDS];
int       g_seenCount = 0;

string    g_token = "";
long      g_seq = 0;
datetime  g_lastOk = 0;
datetime  g_nextPairAttempt = 0;
bool      g_tradingEnabled = false;
bool      g_liveTradingEnabled = false;
// ── Durable link ────────────────────────────────────────────────────────────
// The token and the pairing code are kept in this terminal's common Files
// folder, keyed by account + server, and restored at startup. That is what
// makes "close MT5, reboot the VPS, redeploy the server" survive without the
// user touching anything — the connection ends only when they unlink the
// terminal in the Desk. The common folder is shared by every chart in this
// installation, so a second chart reads the same link instead of pairing again.
string    g_savedCode = "";
bool      g_linkLoaded = false;
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

   // Restore the saved link BEFORE anything else: if this terminal is already
   // paired, the very first heartbeat continues the connection and no code is
   // ever needed again.
   LoadSavedLink();

   // Rebuild the management table from terminal globals BEFORE the first tick:
   // positions that survived a restart must be managed to their own rules, not
   // adopted later by whatever loop happens to notice them first.
   for(int s = 0; s < MAX_MGMT_POSITIONS; s++) g_positions[s].active = false;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      string symbol = PositionGetSymbol(i);
      PositionState restored;
      if(!LoadPositionState(ticket, symbol, restored)) continue;
      for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
         if(!g_positions[s].active) { g_positions[s] = restored; break; }
      Print("NeurotradeBridge: restored management for position #", (long)ticket, " ", symbol,
            " (phase ", restored.phase, ").");
   }

   Print("NeurotradeBridge v4.00 attached. Configure ServerUrl and PairingCode in EA Inputs; ",
         "pairing will retry without removing the EA from this chart.");
   if(StringLen(NormalisedServerUrl()) == 0)
      Print("NeurotradeBridge: ServerUrl is empty. Set it to the public Desk origin.");
   if(g_token != "")
      Print("NeurotradeBridge: restored the saved link for account ",
            IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)), "@", AccountInfoString(ACCOUNT_SERVER),
            ". No pairing code is needed — the connection resumes automatically.");
   else if(StringLen(EffectivePairingCode()) == 0)
      Log("Waiting for PairingCode input. Open Desk -> Link MT5 to generate one.");

   // Never fail initialization simply because pairing is not ready yet.
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   // Persist every live position's running state so a chart reload does not
   // reset its progress counters, then release the cached indicator handles.
   for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
      if(g_positions[s].active) SavePositionState(g_positions[s]);
   ReleaseAtrHandles();
   Print("NeurotradeBridge: stopped (reason ", reason, ").");
}

// The chart tick is the fastest path for the chart's symbol; OnTimer below
// evaluates all plan symbols as well, so attaching to EURUSD can still manage
// an XAUUSD/BTCUSD plan safely.
void OnTick()
{
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
   long beatStart = GetTickCount64();
   if(g_token == "")
      TryPair();
   else
      Sync();
   long beatMs = GetTickCount64() - beatStart;
   if(beatMs > 1500)
      Log(StringFormat("heartbeat took %d ms — payload build or server response was slow; quotes may age past the freshness gate", (int)beatMs));

   RollDayBaselineIfNeeded();
   RefreshCalendar(false);
   ManageOpenPositions();
   EvaluatePlans();
}

//+------------------------------------------------------------------+
//| Durable link (terminal-side)                                      |
//|                                                                  |
//| The Desk persists the link server-side; this is the other half:  |
//| the EA stores the token it was issued, plus the pairing code that |
//| produced it, in the terminal's common Files folder so that        |
//| restarting MT5 (or the machine) reconnects instead of falling    |
//| back to a code the server has long forgotten.                    |
//|                                                                  |
//| The file lives in the COMMON folder on purpose: every chart of    |
//| this installation shares it, so a second chart adopts the existing |
//| link instead of pairing again (which is what made two instances   |
//| invalidate each other in a re-pair loop).                        |
//+------------------------------------------------------------------+
string LinkFileName()
{
   // One link per broker account, sanitised so a server name with spaces or
   // slashes can never escape the folder.
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

void SaveLink()
{
   string name = LinkFileName();
   ResetLastError();
   int handle = FileOpen(name, FILE_COMMON | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Log("Could not save the connection link (" + IntegerToString(GetLastError()) +
          "). This terminal will need the pairing code again after a restart.");
      return;
   }
   FileWriteString(handle, "v1\n");
   FileWriteString(handle, g_token + "\n");
   FileWriteString(handle, EffectivePairingCode() + "\n");
   FileClose(handle);
}

void LoadSavedLink()
{
   if(g_linkLoaded) return;
   g_linkLoaded = true;
   string name = LinkFileName();
   ResetLastError();
   if(!FileIsExist(name, FILE_COMMON)) return;
   int handle = FileOpen(name, FILE_COMMON | FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE) return;
   string version = FileReadString(handle);
   string token = FileReadString(handle);
   string code = FileReadString(handle);
   FileClose(handle);
   if(version != "v1") return;
   g_token = token;
   if(StringLen(code) > 0) g_savedCode = code;
}

/** Keep the saved token in step with memory (a 401 empties both). */
void ForgetSavedLinkToken()
{
   g_token = "";
   SaveLink();
}

/** The code to present: what the user typed, else the one that worked before. */
string EffectivePairingCode()
{
   string typed = StringTrimmed(PairingCode);
   if(StringLen(typed) > 0) return typed;
   return g_savedCode;
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
   body += "\"version\":\"4.00\",";
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
         // terminal, or rotated the code). Retrying it five times a second
         // produced thousands of identical 401 lines and hid the real reason.
         // Say it once, back off, and let the user paste a fresh code.
         g_pairAttemptDelaySeconds = 60;
         g_nextPairAttempt = now + 60;
         if(!g_refusalPrinted)
         {
            g_refusalPrinted = true;
            Print("NeurotradeBridge: this pairing code is not valid any more — it was either replaced ",
                  "or the terminal was unlinked in the Desk. Open the Desk, copy the current code into this ",
                  "EA's PairingCode input (or unlink and re-link), and the terminal will connect again. ",
                  "Still trying in the background every 60s.");
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
   g_lastOk = now;
   g_seq = 0;
   g_savedCode = code;
   g_pairAttemptDelaySeconds = 5;
   g_refusalPrinted = false;
   // Persist immediately: from here on, a restart of MT5 or of the server
   // reconnects with this token instead of asking the user for a code again.
   SaveLink();
   ApplyServerResponse(response);
   Print("NeurotradeBridge: paired successfully. The link is saved in this terminal, so closing MT5 ",
         "or restarting the platform will reconnect automatically. It ends only if you unlink the terminal in the Desk.");
}

bool HttpPost(const string path, const string body, string &response, const bool authenticated)
{
   string base = NormalisedServerUrl();
   if(base == "") return false;

   // Clear before every attempt: a transport failure must never leave the
   // previous call's status behind and be mistaken for a fresh refusal.
   g_lastHttpStatus = 0;
   g_lastHttpError = "";

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
   if(status < 200 || status >= 300)
   {
      Print("NeurotradeBridge: HTTP ", status, " from ", path, " — ", response);
      if(status == 401 && authenticated)
      {
         // Token may have been unpaired/replaced. Remain attached and let the
         // user enter a fresh code rather than doing any blind work. The saved
         // copy is cleared too — otherwise the next restart would restore the
         // very token the server just refused and the loop would never end.
         g_token = "";
         g_tradingEnabled = false;
         g_savedCode = EffectivePairingCode();
         SaveLink();
      }
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
   body += "\"version\":\"4.00\",";
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
   // What the position machine DID since the last beat. Without this the desk
   // could only see that a stop had moved, never why — and a partial exit was
   // indistinguishable from a manual close in the journal.
   body += "\"management\":[" + g_mgmtEvents + "]";
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
               "Unlink it there, then enter a fresh pairing code here.");
         g_token = "";
         g_tradingEnabled = false;
         SaveLink();
         g_nextPairAttempt = 0;
      }
      else if(g_lastHttpStatus == 401)
      {
         // The Desk no longer recognises this token. It backs off to a slow
         // re-pair attempt rather than a five-second loop; the saved code is
         // still tried (it may simply have been a transient server restart) and
         // the reason is printed once.
         if(!g_refusalPrinted)
         {
            g_refusalPrinted = true;
            Print("NeurotradeBridge: the Desk no longer accepts this terminal's link (401). It was most ",
                  "likely unlinked from the Desk. Open Desk -> Link MT5, copy the current pairing code into ",
                  "this EA's PairingCode input, and it will reconnect. Retrying slowly in the background.");
         }
         g_pairAttemptDelaySeconds = 60;
         g_nextPairAttempt = NowServer() + 60;
         g_tradingEnabled = false;
      }
      // Bounded by the SERVER-silence budget, not the tick-freshness one: the
      // desk keeps a link alive for its own (adaptive) window, and the EA must
      // not stop executing plans while the desk still considers the link live.
      else if(NowServer() - g_lastOk > ServerSilenceSec) g_tradingEnabled = false;
      return;
   }

   g_lastOk = NowServer();
   g_results = "";
   g_mgmtEvents = "";
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
         g_plans[i].active = false;
         continue;
      }

      bool through = g_plans[i].isBuy ? price >= g_plans[i].trigger : price <= g_plans[i].trigger;
      if(!through)
      {
         g_plans[i].confirmCount = 0;
         continue;
      }
      g_plans[i].confirmCount++;
      if(g_plans[i].confirmCount < g_plans[i].confirmTicks) continue;
      if(g_plans[i].maxSpreadPoints > 0 && spread > g_plans[i].maxSpreadPoints) continue;

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

      // THE POSITION NOW OWNS THE RULES.
      //
      // The plan is cleared on the next line, exactly as before — but the
      // management block is captured here first, keyed by the ticket the fill
      // produced and persisted to terminal globals. That is the whole of the
      // v4.00 fix: management is looked up by POSITION, never through a plan.
      // `ResultOrder()` is the opening order's ticket, which is also the
      // position's ticket for the trade this EA just placed. It is checked
      // against a real position before use: attaching rules to a ticket that does
      // not exist would look like management while protecting nothing.
      ulong positionTicket = (ulong)trade.ResultOrder();
      if(!PositionSelectByTicket(positionTicket) || PositionGetString(POSITION_SYMBOL) != symbol)
         positionTicket = FindPositionTicketBySymbol(symbol);
      if(positionTicket > 0)
      {
         int slot = -1;
         for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
            if(!g_positions[s].active) { slot = s; break; }
         if(slot >= 0)
         {
            CapturePositionStateFromPlan(slot, g_plans[index], positionTicket, symbol, fill, lots);
            AddMgmtEvent(positionTicket, symbol, "captured", 0,
                         "Management rules captured at fill: BE " +
                         DoubleToString(g_plans[index].beTriggerR, 2) + "R, " +
                         IntegerToString(g_plans[index].partialCount) + " partial(s), trail " +
                         DoubleToString(g_plans[index].trailMult, 1) + "x" +
                         (g_plans[index].trailEnabled ? "" : " (off)") + ".");
            Log("position #" + IntegerToString((long)positionTicket) + " is now managed (BE " +
                DoubleToString(g_plans[index].beTriggerR, 2) + "R, " +
                IntegerToString(g_plans[index].partialCount) + " partials).");
         }
         else
         {
            Log("WARNING: no free management slot for position #" +
                IntegerToString((long)positionTicket) + " — it has its SL/TP but no ladder.");
         }
      }
      else
      {
         Log("WARNING: filled order could not be matched to a position — the ladder was not attached.");
      }
   }
   else
   {
      AddResult(g_plans[index].id, "rejected", 0, 0, 0,
                "retcode " + IntegerToString(trade.ResultRetcode()) + " " + trade.ResultRetcodeDescription());
      Log("Order rejected on " + symbol + ": " + trade.ResultRetcodeDescription());
   }
   // Exactly one terminal attempt per plan. Retrying a failed buy here risks a
   // duplicate position after a broker timeout.
   g_plans[index].active = false;
}

//+------------------------------------------------------------------+
//| Management event queue                                            |
//|                                                                   |
//| Every action the machine takes is reported on the next heartbeat  |
//| so the desk's journal shows what happened to a position, not just |
//| that it appeared and later vanished.                              |
//+------------------------------------------------------------------+
void AddMgmtEvent(const ulong ticket, const string symbol, const string action,
                  const double value, const string detail)
{
   if(g_mgmtEvents != "") g_mgmtEvents += ",";
   g_mgmtEvents += "{\"ticket\":" + IntegerToString((long)ticket)
                 + ",\"symbol\":\"" + JsonEscape(symbol)
                 + "\",\"action\":\"" + JsonEscape(action)
                 + "\",\"value\":" + DoubleToString(value, 10)
                 + ",\"detail\":\"" + JsonEscape(detail)
                 + "\",\"ts\":" + IntegerToString(NowUtcMs()) + "}";
   g_mgmtEventCount++;
}

// Modifications are rate-limited per ticket. A trailing stop in a fast market
// can qualify on every tick; the broker does not need every one of them, and a
// rejected burst leaves the position on the OLD stop while the requests queue.
#define MODIFY_MIN_INTERVAL_MS 2000
ulong  g_lastModifyTicket[MAX_MGMT_POSITIONS];
long   g_lastModifyAtMs[MAX_MGMT_POSITIONS];

bool ModifyAllowedNow(const int slot, const ulong ticket)
{
   for(int i = 0; i < MAX_MGMT_POSITIONS; i++)
   {
      if(g_lastModifyTicket[i] != ticket) continue;
      return (GetTickCount64() - g_lastModifyAtMs[i]) >= MODIFY_MIN_INTERVAL_MS;
   }
   return true;
}

void NoteModify(const int slot, const ulong ticket)
{
   for(int i = 0; i < MAX_MGMT_POSITIONS; i++)
   {
      if(g_lastModifyTicket[i] == ticket)
      {
         g_lastModifyAtMs[i] = (long)GetTickCount64();
         return;
      }
   }
   // Claim a free slot, or overwrite the oldest.
   int target = -1;
   long oldest = 0;
   for(int i = 0; i < MAX_MGMT_POSITIONS; i++)
   {
      if(g_lastModifyTicket[i] == 0) { target = i; break; }
      if(target < 0 || g_lastModifyAtMs[i] < oldest) { oldest = g_lastModifyAtMs[i]; target = i; }
   }
   if(target >= 0)
   {
      g_lastModifyTicket[target] = ticket;
      g_lastModifyAtMs[target] = (long)GetTickCount64();
   }
}

// Apply a modify with back-off, honouring the stop level and the freeze level.
bool ApplyStopModify(const int slot, PositionState &st, const double newSl)
{
   if(!ModifyAllowedNow(slot, st.ticket)) return false;

   MqlTick tick;
   if(!SymbolInfoTick(st.symbol, tick)) return false;
   double price = st.isBuy ? tick.bid : tick.ask;
   if(!StopIsLegal(st.symbol, st.isBuy, price, newSl, st.point)) return false;

   double tp = 0;
   if(PositionSelectByTicket(st.ticket)) tp = PositionGetDouble(POSITION_TP);
   double digits = (double)st.digits;
   if(!ModifyPositionByTicket(st.ticket, st.symbol, NormalizeDouble(newSl, (int)digits), tp))
      return false;

   NoteModify(slot, st.ticket);
   return true;
}

// ── Step 1: terminal exits ───────────────────────────────────────────────────
// Session flat, news flat, regime exit, time stop — in that order, and any of
// them ends the position, so the caller returns immediately.
bool PositionTerminalExit(const int slot, PositionState &st, const MqlTick &tick)
{
   if(st.flatBeforeClose && SymbolSessionClosingSoon(st.symbol, SessionFlatMinutesBeforeClose))
   {
      st.phase = PHASE_SESSION_NEWS_FLAT;
      AddMgmtEvent(st.ticket, st.symbol, "close_all", 0,
                   "Session close — flat before the session ends.");
      ClosePosition(st.ticket, 0, "");
      return true;
   }
   if(IsNewsBlackout(st.symbol))
   {
      st.phase = PHASE_SESSION_NEWS_FLAT;
      AddMgmtEvent(st.ticket, st.symbol, "close_all", 0,
                   "High-impact release — flattening rather than holding through it.");
      ClosePosition(st.ticket, 0, "");
      return true;
   }
   if(st.regimeExit)
   {
      st.phase = PHASE_REGIME_EXIT;
      AddMgmtEvent(st.ticket, st.symbol, "close_all", 0,
                   "The regime that justified this trade no longer holds.");
      ClosePosition(st.ticket, 0, "");
      return true;
   }
   if(st.timeStopBars > 0)
   {
      int bars = BarsSinceOpen(st, (ENUM_TIMEFRAMES)st.timeStopPeriod);
      if(bars >= (int)st.timeStopBars && st.bestR < 0.5)
      {
         st.phase = PHASE_TIME_STOP;
         AddMgmtEvent(st.ticket, st.symbol, "close_all", 0,
                      StringFormat("%d bars with no progress (best %.2fR < 0.50R) — freeing the margin.",
                                   bars, st.bestR));
         ClosePosition(st.ticket, 0, "");
         return true;
      }
   }
   return false;
}

// ── Step 2: partials ─────────────────────────────────────────────────────────
void PositionApplyPartials(const int slot, PositionState &st, const double progress)
{
   for(int i = 0; i < st.partialCount && i < MAX_PARTIALS; i++)
   {
      if(st.partialDone[i]) continue;
      if(!Reached(progress, st.partialAtR[i])) continue;

      double volumeMin = SymbolInfoDouble(st.symbol, SYMBOL_VOLUME_MIN);
      double slice = QuantiseVolume(st.symbol, st.initialVolume * (st.partialPct[i] / 100.0));
      double remainder = NormalizeDouble(st.openVolume - slice, 8);

      // Infeasible now means infeasible forever — volume only shrinks — so the
      // slice is retired rather than re-tested on every tick.
      if(slice < volumeMin || remainder < volumeMin || slice > st.openVolume)
      {
         st.partialDone[i] = true;
         SavePositionState(st);
         continue;
      }

      if(ClosePosition(st.ticket, slice, ""))
      {
         st.partialDone[i] = true;
         st.openVolume = remainder;
         if(st.phase == PHASE_OPEN_RISK || st.phase == PHASE_BE_ARMED) st.phase = PHASE_PARTIAL;
         AddMgmtEvent(st.ticket, st.symbol, "close_partial", slice,
                      StringFormat("%.0f%% banked at %.1fR (%.2fR reached).",
                                   st.partialPct[i], st.partialAtR[i], progress));
         SavePositionState(st);
      }
   }
}

// ── Step 3: break-even ───────────────────────────────────────────────────────
// The pending stop is the single modification this tick will send; break-even
// and the trail both propose into it and only ever replace it with something
// tighter (see PositionApplyTrail).
void PositionApplyBreakeven(const int slot, PositionState &st, const double progress,
                            double &pendingSl, bool &hasPending, string &pendingDetail)
{
   if(st.beTriggerR <= 0) return;
   if(!Reached(progress, st.beTriggerR)) return;
   if(!StructureConfirmedForBE(st)) return;

   double offset = (st.costPoints + 0.05 * st.riskPoints) * st.point;
   double candidate = st.isBuy ? st.entry + offset : st.entry - offset;
   candidate = NormalizeDouble(candidate, st.digits);
   double reference = hasPending ? pendingSl : st.currentSl;

   if(Tightens(st.isBuy, candidate, reference, st.point * 0.01))
   {
      pendingSl = candidate;
      hasPending = true;
      pendingDetail = StringFormat("%.2fR reached — stop to entry + %.1fpt cost + %.1fpt buffer.",
                                   progress, st.costPoints, 0.05 * st.riskPoints);
   }
   // Set regardless of who wins the comparison: either way the stop is at or
   // beyond entry, so the base is risk-free and the pyramid rule may rely on it.
   st.beApplied = true;
   if(st.phase == PHASE_OPEN_RISK) st.phase = PHASE_BE_ARMED;
}

// ── Step 4: trail ────────────────────────────────────────────────────────────
// Chandelier on the ENTRY timeframe's ATR — never a fixed M15 — and only by at
// least max(plan step, 0.1 × ATR), so a trending market is not modified on noise.
void PositionApplyTrail(const int slot, PositionState &st, const MqlTick &tick,
                        const double progress, double &pendingSl, bool &hasPending,
                        string &pendingDetail)
{
   if(st.trailMult <= 0) return;
   if(!Reached(progress, st.trailActivateR)) return;

   double atrPrice = AtrValue(st.symbol, (ENUM_TIMEFRAMES)st.entryPeriod, (int)MathMax(2, st.trailPeriod));
   if(atrPrice <= 0) return;

   double current = st.isBuy ? tick.bid : tick.ask;
   double chandelier = st.isBuy ? current - atrPrice * st.trailMult
                                : current + atrPrice * st.trailMult;
   chandelier = NormalizeDouble(chandelier, st.digits);

   double reference = hasPending ? pendingSl : st.currentSl;
   double atrPoints = atrPrice / st.point;
   double minStepPoints = MathMax(st.trailStepPoints, atrPoints * 0.1);
   double improvementPoints = MathAbs(chandelier - reference) / st.point;

   if(Tightens(st.isBuy, chandelier, reference, 0) && improvementPoints >= minStepPoints)
   {
      pendingSl = chandelier;
      hasPending = true;
      pendingDetail = StringFormat("Chandelier %.1f× ATR(%d) on %s — stop trailed (+%.1fpt step).",
                                   st.trailMult, (int)st.trailPeriod,
                                   EnumToString((ENUM_TIMEFRAMES)st.entryPeriod),
                                   improvementPoints);
      if(st.beApplied) st.phase = PHASE_RUNNER;
   }
}

// ── Step 5: pyramid ──────────────────────────────────────────────────────────
void PositionApplyPyramid(const int slot, PositionState &st, const double progress,
                          const double spreadPoints, const double portfolioRiskR)
{
   // The add rules ride on the base state; they are written into the state at
   // fill from the plan's pyramid block, which is non-null only in a trend.
   if(st.trailMult <= 0) return;                 // no trend context captured
   if(st.pyramidAdds >= 1 && st.mode != MODE_SWING) return;
   if(st.pyramidAdds >= 2) return;
   if(!st.beApplied) return;
   if(!Reached(progress, 1.5)) return;
   if(st.maxSpreadPoints > 0 && spreadPoints > st.maxSpreadPoints) return;
   if(portfolioRiskR + 1 > 1.5) return;

   double volumeMin = SymbolInfoDouble(st.symbol, SYMBOL_VOLUME_MIN);
   double volumeMax = SymbolInfoDouble(st.symbol, SYMBOL_VOLUME_MAX);
   double lots = QuantiseVolume(st.symbol, st.initialVolume * 0.5);
   if(lots < volumeMin || lots > volumeMax) return;
   if(st.openVolume + lots > volumeMax) return;

   trade.SetDeviationInPoints(10);
   bool ok = st.isBuy
      ? trade.Buy(lots, st.symbol, 0.0, st.currentSl, 0, "nt:pyramid:" + st.symbol)
      : trade.Sell(lots, st.symbol, 0.0, st.currentSl, 0, "nt:pyramid:" + st.symbol);
   if(!ok) return;

   st.pyramidAdds++;
   st.phase = PHASE_PYRAMID;
   AddMgmtEvent(st.ticket, st.symbol, "pyramid_add", lots,
                StringFormat("Base at break-even and %.2fR clear — added %.2f lots (add %d).",
                             progress, lots, st.pyramidAdds));
   SavePositionState(st);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
// Fixed order 1→5 with the early return on a terminal exit, exactly as in
// managePosition(). Read the two side by side; they are meant to be compared.
void ManagePositionState(const int slot, PositionState &st, const MqlTick &tick)
{
   if(st.phase == PHASE_TIME_STOP || st.phase == PHASE_REGIME_EXIT ||
      st.phase == PHASE_SESSION_NEWS_FLAT)
      return;

   double current = st.isBuy ? tick.bid : tick.ask;
   double progress = ProgressR(st, current);
   st.bestR  = MathMax(st.bestR, progress);
   st.worstR = MathMin(st.worstR, progress);

   // 1 — terminal exits
   if(PositionTerminalExit(slot, st, tick)) return;

   // 2 — partials
   PositionApplyPartials(slot, st, progress);

   // 3 + 4 — one stop modification per tick, the tighter of break-even and trail
   double pendingSl = 0;
   bool hasPending = false;
   string pendingDetail = "";
   PositionApplyBreakeven(slot, st, progress, pendingSl, hasPending, pendingDetail);
   PositionApplyTrail(slot, st, tick, progress, pendingSl, hasPending, pendingDetail);

   if(hasPending && ApplyStopModify(slot, st, pendingSl))
   {
      st.currentSl = pendingSl;
      AddMgmtEvent(st.ticket, st.symbol, "modify_sl", pendingSl, pendingDetail);
   }

   // 5 — pyramid
   double spreadPoints = st.point > 0 ? (tick.ask - tick.bid) / st.point : 0;
   PositionApplyPyramid(slot, st, progress, spreadPoints, 0);

   SavePositionState(st);
}

// Capture the plan's rules into a fresh position state AT FILL. This is the
// moment the plan stops being an intent and becomes a commitment.
void CapturePositionStateFromPlan(const int slot, const ArmedPlan &plan, const ulong ticket,
                                  const string symbol, const double fillPrice, const double lots)
{
   PositionState st;
   st.active = true;
   st.ticket = ticket;
   st.symbol = symbol;
   st.isBuy = plan.isBuy;
   st.mode = ModeFromString(plan.mode);
   st.entryPeriod = (int)TimeframeFromName(plan.entryTimeframe);
   st.entry = fillPrice;
   st.initialSl = plan.sl;
   st.point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   st.digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   st.riskPoints = st.point > 0 ? MathAbs(fillPrice - plan.sl) / st.point : 0;
   st.initialVolume = lots;
   st.openVolume = lots;
   st.openedAtMs = NowUtcMs();
   st.costPoints = plan.costPoints;

   st.beTriggerR = plan.beTriggerR;
   st.beOffsetR = plan.beOffsetR;
   st.beStructure = plan.beStructure;
   st.partialCount = (int)MathMin(MAX_PARTIALS, plan.partialCount);
   for(int i = 0; i < MAX_PARTIALS; i++)
   {
      st.partialAtR[i] = i < st.partialCount ? plan.partialAtR[i] : 0;
      st.partialPct[i] = i < st.partialCount ? plan.partialPct[i] : 0;
      st.partialDone[i] = false;
   }
   st.trailMult = plan.trailMult;
   st.trailPeriod = plan.trailPeriod;
   st.trailActivateR = plan.trailActivateR;
   st.trailStepPoints = plan.trailStepPoints;
   st.timeStopBars = plan.timeStopBars;
   st.timeStopPeriod = plan.timeStopPeriod > 0 ? plan.timeStopPeriod : st.entryPeriod;
   st.flatBeforeClose = plan.flatBeforeClose;
   st.maxSpreadPoints = plan.maxSpreadPoints;
   st.regimeExit = false;

   st.phase = PHASE_OPEN_RISK;
   st.currentSl = plan.sl;
   st.beApplied = false;
   st.pyramidAdds = 0;
   st.bestR = 0;
   st.worstR = 0;

   g_positions[slot] = st;
   SavePositionState(st);
}

void ManageOpenPositions()
{
   if(DailyLossBreached())
   {
      FlattenAll("local daily loss circuit breaker");
      return;
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i);
      if(symbol == "") continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0) continue;

      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick)) continue;

      // Find (or rebuild) this position's state. A position with no captured
      // rules — one opened before the upgrade, or by hand — is left completely
      // alone: this EA never invents management for a trade it did not plan.
      int slot = -1;
      for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
         if(g_positions[s].active && g_positions[s].ticket == ticket) { slot = s; break; }

      if(slot < 0)
      {
         for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
            if(!g_positions[s].active) { slot = s; break; }
         if(slot < 0) continue;
         PositionState restored;
         if(!LoadPositionState(ticket, symbol, restored))
         {
            // No state on disk either. Adopt it with a conservative identity so
            // it is still protected, but with no partials, no pyramid and no
            // BE offset it never had. The stop it already carries is kept.
            restored.active = true;
            restored.ticket = ticket;
            restored.symbol = symbol;
            restored.isBuy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
            restored.mode = MODE_INTRADAY;
            restored.entryPeriod = (int)PERIOD_M15;
            restored.entry = PositionGetDouble(POSITION_PRICE_OPEN);
            restored.initialSl = PositionGetDouble(POSITION_SL);
            restored.point = point;
            restored.digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
            restored.riskPoints = restored.initialSl > 0
               ? MathAbs(restored.entry - restored.initialSl) / point : 0;
            restored.initialVolume = PositionGetDouble(POSITION_VOLUME);
            restored.openVolume = restored.initialVolume;
            restored.openedAtMs = (long)PositionGetInteger(POSITION_TIME) * 1000;
            restored.costPoints = 0;
            restored.beTriggerR = 0;
            restored.beOffsetR = 0;
            restored.beStructure = false;
            restored.partialCount = 0;
            restored.trailMult = 0;
            restored.trailPeriod = 14;
            restored.trailActivateR = 0;
            restored.trailStepPoints = 0;
            restored.timeStopBars = 0;
            restored.timeStopPeriod = (int)PERIOD_M15;
            restored.flatBeforeClose = false;
            restored.maxSpreadPoints = 0;
            restored.regimeExit = false;
            restored.phase = PHASE_OPEN_RISK;
            restored.currentSl = restored.initialSl;
            restored.beApplied = false;
            restored.pyramidAdds = 0;
            restored.bestR = 0;
            restored.worstR = 0;
            Log("adopted position #" + IntegerToString((long)ticket) + " " + symbol +
                " with no captured plan — protecting it, but applying no ladder.");
         }
         g_positions[slot] = restored;
      }

      if(g_positions[slot].riskPoints <= 0) continue;

      // Keep the tracked volume honest: a manual partial, a broker-side action
      // or a pyramid add changes it without the machine's involvement.
      if(PositionSelectByTicket(ticket))
         g_positions[slot].openVolume = PositionGetDouble(POSITION_VOLUME);

      ManagePositionState(slot, g_positions[slot], tick);
   }

   // Retire state for positions that no longer exist, so a closed ticket cannot
   // leave a stale rule set behind for the next position to inherit.
   for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
   {
      if(!g_positions[s].active) continue;
      if(PositionSelectByTicket(g_positions[s].ticket)) continue;
      ClearPositionState(g_positions[s].ticket);
      AddMgmtEvent(g_positions[s].ticket, g_positions[s].symbol, "closed", 0,
                   StringFormat("Position closed — final phase %d, best %.2fR, worst %.2fR.",
                                g_positions[s].phase, g_positions[s].bestR, g_positions[s].worstR));
      g_positions[s].active = false;
   }
}

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
   else if(type == "set_management") SetManagementCommand(obj, id);
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
   ParseManagementIntoPlan(plan, g_plans[slot]);
   g_plans[slot].active = true;
   AddResult(commandId, "done", 0, 0, 0, "");
}

// Read the plan's whole management block into the EA's plan record.
//
// Extracted from ArmPlanFromJson because `set_management` updates the rules of
// an OPEN position through the same reader — one parser, one meaning.
void ParseManagementIntoPlan(const string plan, ArmedPlan &target)
{
   target.entryTimeframe = JsonString(plan, "entryTimeframe");
   target.mode = JsonString(plan, "mode");
   target.costPoints = JsonNumber(plan, "costPoints");

   string management = JsonObject(plan, "management");
   if(management == "") management = plan;   // set_management sends it at the top level
   string breakeven = JsonObject(management, "breakeven");
   string trail = JsonObject(management, "trail");
   string timeStop = JsonObject(management, "timeStop");
   string guards = JsonObject(management, "guards");

   target.beTriggerR = JsonNumber(breakeven, "triggerR");
   target.beOffsetR = JsonNumber(breakeven, "offsetR");
   int structure = JsonBool(breakeven, "structureBuffer");
   target.beStructure = structure == 1;

   target.trailMult = JsonNumber(trail, "mult");
   target.trailPeriod = JsonNumber(trail, "period");
   target.trailActivateR = JsonNumber(trail, "activateAtR");
   target.trailStepPoints = JsonNumber(trail, "stepPoints");
   target.trailEnabled = trail != "";
   if(target.trailPeriod <= 0) target.trailPeriod = 14;

   target.timeStopBars = JsonNumber(timeStop, "noProgressBars");
   target.timeStopPeriod = (int)TimeframeFromName(JsonString(timeStop, "timeframe"));

   int flat = JsonBool(guards, "flatBeforeSessionClose");
   target.flatBeforeClose = flat == 1;
   target.maxSpreadPoints = JsonNumber(guards, "maxSpreadPoints");

   // The partial ladder: an array of objects, so each element is extracted by
   // brace matching before its fields are read. Reading `atR` straight out of the
   // array text would match the FIRST element for every slot.
   target.partialCount = 0;
   string partials = JsonArray(management, "partials");
   int cursor = 0;
   while(target.partialCount < MAX_PARTIALS)
   {
      string element = NextObjectInArray(partials, cursor);
      if(element == "") break;
      target.partialAtR[target.partialCount] = JsonNumber(element, "atR");
      target.partialPct[target.partialCount] = JsonNumber(element, "closePct");
      target.partialCount++;
   }
   for(int i = 0; i < MAX_PARTIALS; i++)
   {
      if(i >= target.partialCount) { target.partialAtR[i] = 0; target.partialPct[i] = 0; }
   }
}

void CancelPlan(const string planId, const string commandId)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].id == planId) g_plans[i].active = false;
   AddResult(commandId, "done", 0, 0, 0, "");
}

bool ClosePosition(const ulong ticket, const double lots, const string commandId)
{
   if(!PositionSelectByTicket(ticket))
   {
      if(commandId != "") AddResult(commandId, "skipped", 0, 0, 0, "position not found");
      return false;
   }
   double currentVolume = PositionGetDouble(POSITION_VOLUME);
   string symbol = PositionGetString(POSITION_SYMBOL);
   double requested = lots > 0 ? NormaliseVolume(symbol, lots) : 0;
   // A partial that normalises below the broker minimum is not a partial — it is
   // a rejected order. Closing the whole position instead would be a silent exit
   // the plan never asked for, so the request is refused instead.
   if(lots > 0 && requested <= 0)
   {
      if(commandId != "") AddResult(commandId, "rejected", (long)ticket, 0, 0, "partial below broker minimum");
      return false;
   }
   bool ok = (requested > 0 && requested < currentVolume)
      ? trade.PositionClosePartial(ticket, requested)
      : trade.PositionClose(ticket);
   // Management-driven calls pass an empty command id: they are journaled through
   // the management event queue, not the command result queue.
   if(commandId != "")
      AddResult(commandId, ok ? "done" : "rejected", (long)ticket, trade.ResultPrice(), 0,
                ok ? "" : trade.ResultRetcodeDescription());
   return ok;
}

// `set_management` gives the desk a way to retune an OPEN position's rules —
// widen a time stop in a slow session, withdraw the pyramid after a regime
// change — without touching the position itself. The command type was declared
// in types.ts and implemented nowhere; this is the other half.
void SetManagementCommand(const string obj, const string commandId)
{
   ulong ticket = (ulong)JsonNumber(obj, "ticket");
   if(!PositionSelectByTicket(ticket))
   {
      AddResult(commandId, "skipped", 0, 0, 0, "position not found");
      return;
   }
   string symbol = PositionGetString(POSITION_SYMBOL);
   int slot = -1;
   for(int s = 0; s < MAX_MGMT_POSITIONS; s++)
      if(g_positions[s].active && g_positions[s].ticket == ticket) { slot = s; break; }
   if(slot < 0)
   {
      AddResult(commandId, "skipped", 0, 0, 0, "position has no captured management state");
      return;
   }

   ArmedPlan updated;
   ParseManagementIntoPlan(obj, updated);

   PositionState st = g_positions[slot];
   // Only the RULES move. Entry, risk unit, volumes and progress are facts about
   // the position and are never rewritten by a command.
   if(updated.beTriggerR > 0) st.beTriggerR = updated.beTriggerR;
   if(updated.beOffsetR > 0) st.beOffsetR = updated.beOffsetR;
   st.beStructure = updated.beStructure;
   st.partialCount = updated.partialCount;
   for(int i = 0; i < MAX_PARTIALS; i++)
   {
      st.partialAtR[i] = updated.partialAtR[i];
      st.partialPct[i] = updated.partialPct[i];
      if(i >= updated.partialCount) st.partialDone[i] = false;
   }
   st.trailMult = updated.trailMult;
   st.trailPeriod = updated.trailPeriod;
   st.trailActivateR = updated.trailActivateR;
   st.trailStepPoints = updated.trailStepPoints;
   st.timeStopBars = updated.timeStopBars;
   if(updated.timeStopPeriod > 0) st.timeStopPeriod = updated.timeStopPeriod;
   st.flatBeforeClose = updated.flatBeforeClose;
   if(updated.maxSpreadPoints > 0) st.maxSpreadPoints = updated.maxSpreadPoints;

   if(JsonBool(obj, "regimeExit") == 1) st.regimeExit = true;

   g_positions[slot] = st;
   SavePositionState(st);
   AddMgmtEvent(ticket, symbol, "management_updated", 0, "Management rules updated by the desk.");
   AddResult(commandId, "done", (long)ticket, 0, 0, "");
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

void FlattenAll(const string reason)
{
   for(int i = 0; i < MAX_PLANS; i++) g_plans[i].active = false;
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

//+------------------------------------------------------------------+
//| Cached indicator handles                                          |
//|                                                                   |
//| One handle per symbol|timeframe|period, created on first use and   |
//| released in OnDeinit. The previous implementation created and      |
//| released an ATR handle on EVERY call — per managed position, per   |
//| tick — which makes the terminal recalculate history on the hottest |
//| path the EA has. BarsCalculated is checked before CopyBuffer so a  |
//| handle that has not warmed up reports "no ATR yet" instead of a    |
//| zero that would be read as a flat market.                          |
//+------------------------------------------------------------------+
int AtrHandle(const string symbol, const ENUM_TIMEFRAMES timeframe, const int period)
{
   string key = symbol + "|" + IntegerToString((int)timeframe) + "|" + IntegerToString(period);
   for(int i = 0; i < g_atrCount; i++)
      if(g_atrKeys[i] == key) return g_atrHandles[i];

   int handle = iATR(symbol, timeframe, period);
   if(handle == INVALID_HANDLE) return INVALID_HANDLE;
   if(g_atrCount >= MAX_ATR_HANDLES) return handle; // rare; never released, still correct

   g_atrKeys[g_atrCount] = key;
   g_atrHandles[g_atrCount] = handle;
   g_atrCount++;
   return handle;
}

double AtrValue(const string symbol, const ENUM_TIMEFRAMES timeframe, const int period)
{
   int handle = AtrHandle(symbol, timeframe, period);
   if(handle == INVALID_HANDLE) return 0;
   if(BarsCalculated(handle) < period + 1) return 0;
   double buffer[];
   int copied = CopyBuffer(handle, 0, 0, 1, buffer);
   return copied > 0 ? buffer[0] : 0;
}

void ReleaseAtrHandles()
{
   for(int i = 0; i < g_atrCount; i++)
      if(g_atrHandles[i] != INVALID_HANDLE) IndicatorRelease(g_atrHandles[i]);
   g_atrCount = 0;
}

bool FindPlanForSymbol(const string symbol, ArmedPlan &out)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].symbol == symbol) { out = g_plans[i]; return true; }
   return false;
}

// The newest position for `symbol` carrying this EA's magic. Used to attach
// management rules to a fill whose order ticket did not resolve to a position
// (netting accounts, or a broker that renumbers on the deal).
ulong FindPositionTicketBySymbol(const string symbol)
{
   ulong newest = 0;
   long newestTime = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) != symbol) continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      long opened = (long)PositionGetInteger(POSITION_TIME);
      if(opened >= newestTime)
      {
         newestTime = opened;
         newest = (ulong)PositionGetInteger(POSITION_TICKET);
      }
   }
   return newest;
}

//+------------------------------------------------------------------+
//| Position management — mirror of position-manager.ts (WP0)         |
//|                                                                   |
//| Function-by-function mapping (TS → MQL5):                          |
//|   progressR()               → ProgressR()                          |
//|   quantiseVolume()          → QuantiseVolume()                     |
//|   tightens()                → Tightens()                           |
//|   stopIsLegal()             → StopIsLegal()                        |
//|   managePosition() step 1   → PositionTerminalExit()               |
//|   managePosition() step 2   → PositionApplyPartials()              |
//|   managePosition() step 3   → PositionApplyBreakeven()             |
//|   managePosition() step 4   → PositionApplyTrail()                 |
//|   managePosition() step 5   → PositionApplyPyramid()               |
//|   managePosition() dispatch → ManagePositionState()                |
//|   positionStateFromFill()   → CapturePositionStateFromPlan()       |
//|   state persistence         → SavePositionState()/LoadPositionState|
//|                                                                   |
//| The FIVE-STEP ORDER and the early return on a terminal exit are    |
//| part of the contract, not an implementation detail: the golden     |
//| vectors in position-manager.test.ts pin the order, and this file   |
//| runs the steps in the same sequence with the same early returns.   |
//+------------------------------------------------------------------+

int ModeFromString(const string value)
{
   if(value == "scalp") return MODE_SCALP;
   if(value == "swing") return MODE_SWING;
   return MODE_INTRADAY;
}

ENUM_TIMEFRAMES TimeframeFromName(const string name)
{
   for(int i = 0; i < TF_COUNT; i++)
      if(TF_NAMES[i] == name) return TF_LIST[i];
   return PERIOD_M15;
}

double ProgressR(const PositionState &st, const double price)
{
   if(st.riskPoints <= 0 || st.point <= 0) return 0;
   double distance = st.isBuy ? price - st.entry : st.entry - price;
   return distance / (st.riskPoints * st.point);
}

// `progress` has reached `level`, tolerant of representation error — the exact
// rule R_EPSILON documents on the TypeScript side.
bool Reached(const double progress, const double level)
{
   return progress >= level - R_EPSILON;
}

double QuantiseVolume(const string symbol, const double lots)
{
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double quantised = MathFloor(lots / step + 1e-9) * step;
   int volumeDigits = step < 0.01 ? 3 : 2;
   return NormalizeDouble(quantised, volumeDigits);
}

// Is `candidate` a genuine tightening of `current` for this side?
bool Tightens(const bool isBuy, const double candidate, const double current, const double epsilon)
{
   return isBuy ? candidate > current + epsilon : candidate < current - epsilon;
}

bool StopIsLegal(const string symbol, const bool isBuy, const double price,
                 const double sl, const double point, const double *unused = NULL)
{
   if(point <= 0) return false;
   double distancePoints = MathAbs(price - sl) / point;
   long stops = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   long freeze = SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   if(stops > 0 && distancePoints < (double)stops - LEVEL_EPSILON_POINTS) return false;
   if(freeze > 0 && distancePoints < (double)freeze - LEVEL_EPSILON_POINTS) return false;
   return isBuy ? sl < price : sl > price;
}

// The last CLOSED bar on the entry frame cleared the break-even trigger. Read
// from bar index 1 on purpose: a forming bar is not structure, and reading it
// would be the one place in this file where a decision saw the future.
bool StructureConfirmedForBE(const PositionState &st)
{
   if(!st.beStructure) return true;
   if(st.beTriggerR <= 0) return true;
   double level = st.isBuy
      ? st.entry + st.beTriggerR * st.riskPoints * st.point
      : st.entry - st.beTriggerR * st.riskPoints * st.point;
   MqlRates rates[];
   if(CopyRates(st.symbol, (ENUM_TIMEFRAMES)st.entryPeriod, 1, 1, rates) < 1) return false;
   return st.isBuy ? rates[0].close >= level : rates[0].close <= level;
}

// Closed bars on the entry frame since the position opened.
int BarsSinceOpen(const PositionState &st, const ENUM_TIMEFRAMES timeframe)
{
   datetime openServer = (datetime)(st.openedAtMs / 1000 + g_brokerUtcOffsetSec);
   datetime now = NowServer();
   if(openServer <= 0 || now <= openServer) return 0;
   int elapsed = Bars(st.symbol, timeframe, openServer, now);
   return elapsed > 1 ? elapsed - 1 : 0;
}

// The broker's own session table says this symbol's session ends within
// `minutesBefore`. When the table cannot be read the answer is FALSE: an
// unreadable session is not a closing session, and flattening on a guess is
// exactly the kind of invented data this desk refuses everywhere else.
bool SymbolSessionClosingSoon(const string symbol, const int minutesBefore)
{
   MqlDateTime now;
   TimeToStruct(NowServer(), now);
   long nowSeconds = (long)now.hour * 3600 + (long)now.min * 60 + now.sec;

   datetime from = 0, to = 0;
   int sessions = SymbolInfoSessionTrade(symbol, (ENUM_DAY_OF_WEEK)now.day_of_week, 0, from, to);
   if(sessions <= 0) return false;
   for(int i = 0; i < sessions; i++)
   {
      if(!SymbolInfoSessionTrade(symbol, (ENUM_DAY_OF_WEEK)now.day_of_week, i, from, to)) continue;
      long startSeconds = (long)from;
      long endSeconds = (long)to;
      // The MT5 session table reports the day's last session with `to` of 00:00
      // meaning midnight, i.e. the end of the day rather than the start.
      if(endSeconds <= startSeconds) endSeconds += 24 * 3600;
      if(nowSeconds < startSeconds) continue;
      long remaining = endSeconds - nowSeconds;
      if(remaining > 0 && remaining <= (long)minutesBefore * 60) return true;
   }
   return false;
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Terminal global variables survive a restart, a chart reload and a VPS reboot,
// so a position opened before a restart is still managed to the same rules after
// it. Everything numeric is a global; the strings (plan id, symbol) come from the
// position itself — the comment carries `nt:<planId>` and MT5 carries the symbol.
string StateKey(const ulong ticket, const string field)
{
   return StringFormat("NTP4_%I64d_%s_%s", AccountInfoInteger(ACCOUNT_LOGIN),
                       IntegerToString((long)ticket), field);
}

void SavePositionState(const PositionState &st)
{
   if(st.ticket == 0) return;
   GlobalVariableSet(StateKey(st.ticket, "magic"),  7781);
   GlobalVariableSet(StateKey(st.ticket, "entry"),  st.entry);
   GlobalVariableSet(StateKey(st.ticket, "isl"),    st.initialSl);
   GlobalVariableSet(StateKey(st.ticket, "risk"),   st.riskPoints);
   GlobalVariableSet(StateKey(st.ticket, "point"),  st.point);
   GlobalVariableSet(StateKey(st.ticket, "digits"), st.digits);
   GlobalVariableSet(StateKey(st.ticket, "ivol"),   st.initialVolume);
   GlobalVariableSet(StateKey(st.ticket, "ovol"),   st.openVolume);
   GlobalVariableSet(StateKey(st.ticket, "omts"),   (double)st.openedAtMs);
   GlobalVariableSet(StateKey(st.ticket, "cost"),   st.costPoints);
   GlobalVariableSet(StateKey(st.ticket, "btr"),    st.beTriggerR);
   GlobalVariableSet(StateKey(st.ticket, "boff"),   st.beOffsetR);
   GlobalVariableSet(StateKey(st.ticket, "bstr"),   st.beStructure ? 1 : 0);
   GlobalVariableSet(StateKey(st.ticket, "npart"),  st.partialCount);
   for(int i = 0; i < st.partialCount && i < MAX_PARTIALS; i++)
   {
      GlobalVariableSet(StateKey(st.ticket, "pat" + IntegerToString(i)), st.partialAtR[i]);
      GlobalVariableSet(StateKey(st.ticket, "ppc" + IntegerToString(i)), st.partialPct[i]);
      GlobalVariableSet(StateKey(st.ticket, "pdn" + IntegerToString(i)), st.partialDone[i] ? 1 : 0);
   }
   GlobalVariableSet(StateKey(st.ticket, "tmult"),  st.trailMult);
   GlobalVariableSet(StateKey(st.ticket, "tper"),   st.trailPeriod);
   GlobalVariableSet(StateKey(st.ticket, "tact"),   st.trailActivateR);
   GlobalVariableSet(StateKey(st.ticket, "tstep"),  st.trailStepPoints);
   GlobalVariableSet(StateKey(st.ticket, "tstop"),  st.timeStopBars);
   GlobalVariableSet(StateKey(st.ticket, "tstprd"), st.timeStopPeriod);
   GlobalVariableSet(StateKey(st.ticket, "fflat"),  st.flatBeforeClose ? 1 : 0);
   GlobalVariableSet(StateKey(st.ticket, "mspread"),st.maxSpreadPoints);
   GlobalVariableSet(StateKey(st.ticket, "rexit"),  st.regimeExit ? 1 : 0);
   GlobalVariableSet(StateKey(st.ticket, "phase"),  st.phase);
   GlobalVariableSet(StateKey(st.ticket, "csl"),    st.currentSl);
   GlobalVariableSet(StateKey(st.ticket, "beapp"),  st.beApplied ? 1 : 0);
   GlobalVariableSet(StateKey(st.ticket, "padds"),  st.pyramidAdds);
   GlobalVariableSet(StateKey(st.ticket, "best"),   st.bestR);
   GlobalVariableSet(StateKey(st.ticket, "worst"),  st.worstR);
   GlobalVariableSet(StateKey(st.ticket, "mode"),   st.mode);
   GlobalVariableSet(StateKey(st.ticket, "eprd"),   st.entryPeriod);
   GlobalVariableSet(StateKey(st.ticket, "buy"),    st.isBuy ? 1 : 0);
}

bool HasSavedPositionState(const ulong ticket)
{
   return GlobalVariableCheck(StateKey(ticket, "magic"));
}

double ReadState(const ulong ticket, const string field, const double fallback)
{
   string key = StateKey(ticket, field);
   if(!GlobalVariableCheck(key)) return fallback;
   return GlobalVariableGet(key);
}

bool LoadPositionState(const ulong ticket, const string symbol, PositionState &st)
{
   if(!HasSavedPositionState(ticket)) return false;
   st.active        = true;
   st.ticket        = ticket;
   st.symbol        = symbol;
   st.isBuy         = ReadState(ticket, "buy", 1) != 0;
   st.mode          = (int)ReadState(ticket, "mode", MODE_INTRADAY);
   st.entryPeriod   = (int)ReadState(ticket, "eprd", (double)PERIOD_M15);
   st.entry         = ReadState(ticket, "entry", 0);
   st.initialSl     = ReadState(ticket, "isl", 0);
   st.riskPoints    = ReadState(ticket, "risk", 0);
   st.point         = ReadState(ticket, "point", 0);
   st.digits        = (int)ReadState(ticket, "digits", 5);
   st.initialVolume = ReadState(ticket, "ivol", 0);
   st.openVolume    = ReadState(ticket, "ovol", 0);
   st.openedAtMs    = (long)ReadState(ticket, "omts", 0);
   st.costPoints    = ReadState(ticket, "cost", 0);
   st.beTriggerR    = ReadState(ticket, "btr", 0);
   st.beOffsetR     = ReadState(ticket, "boff", 0);
   st.beStructure   = ReadState(ticket, "bstr", 0) != 0;
   st.partialCount  = (int)ReadState(ticket, "npart", 0);
   for(int i = 0; i < MAX_PARTIALS; i++)
   {
      st.partialAtR[i] = ReadState(ticket, "pat" + IntegerToString(i), 0);
      st.partialPct[i] = ReadState(ticket, "ppc" + IntegerToString(i), 0);
      st.partialDone[i]= ReadState(ticket, "pdn" + IntegerToString(i), 0) != 0;
   }
   st.trailMult       = ReadState(ticket, "tmult", 0);
   st.trailPeriod     = ReadState(ticket, "tper", 14);
   st.trailActivateR  = ReadState(ticket, "tact", 0);
   st.trailStepPoints = ReadState(ticket, "tstep", 0);
   st.timeStopBars    = ReadState(ticket, "tstop", 0);
   st.timeStopPeriod  = (int)ReadState(ticket, "tstprd", (double)PERIOD_M15);
   st.flatBeforeClose = ReadState(ticket, "fflat", 0) != 0;
   st.maxSpreadPoints = ReadState(ticket, "mspread", 0);
   st.regimeExit      = ReadState(ticket, "rexit", 0) != 0;
   st.phase           = (int)ReadState(ticket, "phase", PHASE_OPEN_RISK);
   st.currentSl       = ReadState(ticket, "csl", st.initialSl);
   st.beApplied       = ReadState(ticket, "beapp", 0) != 0;
   st.pyramidAdds     = (int)ReadState(ticket, "padds", 0);
   st.bestR           = ReadState(ticket, "best", 0);
   st.worstR          = ReadState(ticket, "worst", 0);
   return true;
}

void ClearPositionState(const ulong ticket)
{
   if(ticket == 0) return;
   GlobalVariableDel(StateKey(ticket, "magic"));
   GlobalVariableDel(StateKey(ticket, "entry"));
   GlobalVariableDel(StateKey(ticket, "isl"));
   GlobalVariableDel(StateKey(ticket, "risk"));
   GlobalVariableDel(StateKey(ticket, "point"));
   GlobalVariableDel(StateKey(ticket, "digits"));
   GlobalVariableDel(StateKey(ticket, "ivol"));
   GlobalVariableDel(StateKey(ticket, "ovol"));
   GlobalVariableDel(StateKey(ticket, "omts"));
   GlobalVariableDel(StateKey(ticket, "cost"));
   GlobalVariableDel(StateKey(ticket, "btr"));
   GlobalVariableDel(StateKey(ticket, "boff"));
   GlobalVariableDel(StateKey(ticket, "bstr"));
   GlobalVariableDel(StateKey(ticket, "npart"));
   for(int i = 0; i < MAX_PARTIALS; i++)
   {
      GlobalVariableDel(StateKey(ticket, "pat" + IntegerToString(i)));
      GlobalVariableDel(StateKey(ticket, "ppc" + IntegerToString(i)));
      GlobalVariableDel(StateKey(ticket, "pdn" + IntegerToString(i)));
   }
   GlobalVariableDel(StateKey(ticket, "tmult"));
   GlobalVariableDel(StateKey(ticket, "tper"));
   GlobalVariableDel(StateKey(ticket, "tact"));
   GlobalVariableDel(StateKey(ticket, "tstep"));
   GlobalVariableDel(StateKey(ticket, "tstop"));
   GlobalVariableDel(StateKey(ticket, "tstprd"));
   GlobalVariableDel(StateKey(ticket, "fflat"));
   GlobalVariableDel(StateKey(ticket, "mspread"));
   GlobalVariableDel(StateKey(ticket, "rexit"));
   GlobalVariableDel(StateKey(ticket, "phase"));
   GlobalVariableDel(StateKey(ticket, "csl"));
   GlobalVariableDel(StateKey(ticket, "beapp"));
   GlobalVariableDel(StateKey(ticket, "padds"));
   GlobalVariableDel(StateKey(ticket, "best"));
   GlobalVariableDel(StateKey(ticket, "worst"));
   GlobalVariableDel(StateKey(ticket, "mode"));
   GlobalVariableDel(StateKey(ticket, "eprd"));
   GlobalVariableDel(StateKey(ticket, "buy"));
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

// The raw text between the brackets of `"key":[` … `]`. Empty when the key is
// absent, so a caller can distinguish "no array" from "empty array".
string JsonArray(const string json, const string key)
{
   string needle = "\"" + key + "\":[";
   int start = StringFind(json, needle);
   if(start < 0) return "";
   start += StringLen(needle);
   int depth = 0;
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{' || ch == '[') depth++;
      else if(ch == '}' || ch == ']')
      {
         if(ch == ']' && depth == 0) return StringSubstr(json, start, i - start);
         depth--;
      }
   }
   return "";
}

// The next `{…}` element of an array body, advancing `cursor` past it. Brace
// matching means a nested object cannot truncate its parent.
string NextObjectInArray(const string body, int &cursor)
{
   int start = -1;
   for(int i = cursor; i < StringLen(body); i++)
      if(StringGetCharacter(body, i) == '{') { start = i; break; }
   if(start < 0) return "";
   int depth = 0;
   for(int i = start; i < StringLen(body); i++)
   {
      ushort ch = StringGetCharacter(body, i);
      if(ch == '{') depth++;
      else if(ch == '}')
      {
         depth--;
         if(depth == 0)
         {
            cursor = i + 1;
            return StringSubstr(body, start, i - start + 1);
         }
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
