//+------------------------------------------------------------------+
//|                                          NeurotradeBridge.mq5    |
//|      NeuroTrade Multi-Asset Desk / resilient MetaTrader 5 EA     |
//+------------------------------------------------------------------+
//| Version 3.05                                                     |
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
//| WHAT CHANGED IN v3.05                                            |
//| 14. POST-FILL MANAGEMENT IS ENFORCED BY THE TERMINAL.            |
//|     v3.04 dropped each plan at the fill, so one breakeven step   |
//|     was the only management that ever ran. Partials, the time    |
//|     stop and the trail were computed by the desk and ignored.    |
//|     Each filled position now keeps a record of its plan: a       |
//|     breakeven (once), an extension at checkAtR when the trend    |
//|     still favours the trade, and a time stop. Progress is measured|
//|     against the ORIGINAL risk, so a stop moved to breakeven cannot|
//|     inflate it. The records survive a restart (common folder).   |
//| 15. CLOSED TRADES ARE REPORTED FROM THE TERMINAL'S OWN RECORDS.  |
//|     closedDeals carries each closed position's realised P&L,     |
//|     commission, exit reason and excursions. It is re-sent until the|
//|     desk acknowledges it, so a lost response cannot lose a trade.|
//|     A vanished position no longer counts as a close on its own.  |
//|                                                                  |
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
#property version   "3.05"
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
input bool   VerboseLog                = true;

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
   double beTriggerR;
   double beOffsetR;
   long   maxHoldSec;
   bool   extEnabled;
   double checkAtR;
   double extendToR;
   double lockR;
   int    emaPeriod;
   string tfName;
   bool   active;
};

CTrade trade;
ArmedPlan g_plans[MAX_PLANS];
string    g_seenCmds[MAX_SEEN_CMDS];
int       g_seenCount = 0;

//+------------------------------------------------------------------+
//| Post-fill management (v3.05)                                      |
//|                                                                  |
//| When an order fills, the plan that produced it is finished, so   |
//| its management settings move into a per-ticket record. The record |
//| lives until the position has closed AND the desk has acknowledged |
//| that close. Everything the desk promised after the fill is         |
//| enforced here:                                                    |
//|   breakeven  once progress reaches triggerR, the stop moves to     |
//|              entry + offsetR, once                                 |
//|   extension  at checkAtR, if the trend still favours the trade,    |
//|              the target moves to extendToR and the stop to +lockR |
//|   time stop  the position is closed when its hold is exhausted     |
//| Progress is measured against the ORIGINAL risk, so a stop moved    |
//| to breakeven does not make a trade look further in profit.         |
//+------------------------------------------------------------------+
#define MAX_MANAGED            64
#define DEAL_LOOKBACK_SECONDS  (2 * 24 * 60 * 60)
#define DEAL_SCAN_THROTTLE_MS  2000
#define DEALS_PER_BEAT         50
#define MANAGED_FILE_VERSION   "v2"

// extendState: 0 = decision pending, 1 = declined (fixed target stands), 2 = applied.
struct ManagedPosition
{
   bool     active;
   ulong    ticket;
   string   planId;
   string   symbol;
   bool     isBuy;
   double   entry;
   double   riskPrice;
   double   riskMoney;
   double   beTriggerR;
   double   beOffsetR;
   bool     beDone;
   long     maxHoldSec;
   datetime openTime;
   bool     extEnabled;
   double   checkAtR;
   double   extendToR;
   double   lockR;
   int      emaPeriod;
   string   tfName;
   int      extendState;
   double   mfeR;
   double   maeR;
   ulong    closeDeal;
   string   closeReason;
   datetime lastSeen;
};

ManagedPosition g_managed[MAX_MANAGED];
ulong    g_dealWatermark = 0;   // highest close deal the desk has acknowledged
ulong    g_pendingDealMax = 0;  // highest deal included in the body being sent
ulong    g_lastDealScanMs = 0;
bool     g_managedDirty = false;
bool     g_managedLoaded = false;

string ManagedFileName()
{
   return "NeurotradeBridge_managed_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ".txt";
}

int FindManaged(const ulong ticket)
{
   for(int i = 0; i < MAX_MANAGED; i++)
      if(g_managed[i].active && g_managed[i].ticket == ticket) return i;
   return -1;
}

int FreeManagedSlot()
{
   for(int i = 0; i < MAX_MANAGED; i++)
      if(!g_managed[i].active) return i;
   return -1;
}

/** Write every live record and the deal watermark, so a restart resumes management. */
void SaveManagedState()
{
   ResetLastError();
   int handle = FileOpen(ManagedFileName(), FILE_COMMON | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Log("Could not save managed-position state (" + IntegerToString(GetLastError()) +
          "). Open positions keep their stops, but breakeven, extension and time stop will not survive a restart.");
      return;
   }
   FileWriteString(handle, MANAGED_FILE_VERSION + "\n");
   FileWriteString(handle, "W|" + IntegerToString((long)g_dealWatermark) + "\n");
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active) continue;
      string line = "R|" + IntegerToString((long)g_managed[i].ticket) + "|" + g_managed[i].planId + "|" +
         g_managed[i].symbol + "|" + (g_managed[i].isBuy ? "1" : "0") + "|" +
         DoubleToString(g_managed[i].entry, 10) + "|" + DoubleToString(g_managed[i].riskPrice, 10) + "|" +
         DoubleToString(g_managed[i].riskMoney, 2) + "|" + DoubleToString(g_managed[i].beTriggerR, 4) + "|" +
         DoubleToString(g_managed[i].beOffsetR, 4) + "|" + (g_managed[i].beDone ? "1" : "0") + "|" +
         IntegerToString(g_managed[i].maxHoldSec) + "|" + IntegerToString((long)g_managed[i].openTime) + "|" +
         (g_managed[i].extEnabled ? "1" : "0") + "|" + DoubleToString(g_managed[i].checkAtR, 4) + "|" +
         DoubleToString(g_managed[i].extendToR, 4) + "|" + DoubleToString(g_managed[i].lockR, 4) + "|" +
         IntegerToString(g_managed[i].emaPeriod) + "|" + g_managed[i].tfName + "|" +
         IntegerToString(g_managed[i].extendState) + "|" + DoubleToString(g_managed[i].mfeR, 4) + "|" +
         DoubleToString(g_managed[i].maeR, 4) + "|" + IntegerToString((long)g_managed[i].closeDeal) + "|" +
         g_managed[i].closeReason + "|" + IntegerToString((long)g_managed[i].lastSeen) + "\n";
      FileWriteString(handle, line);
   }
   FileClose(handle);
   g_managedDirty = false;
}

/** Restore records after a restart. With no file, the watermark starts past existing history. */
void LoadManagedState()
{
   if(g_managedLoaded) return;
   g_managedLoaded = true;
   string name = ManagedFileName();
   ResetLastError();
   if(!FileIsExist(name, FILE_COMMON))
   {
      InitialiseDealWatermark();
      return;
   }
   int handle = FileOpen(name, FILE_COMMON | FILE_READ | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      InitialiseDealWatermark();
      return;
   }
   string version = FileReadString(handle);
   if(version != MANAGED_FILE_VERSION)
   {
      FileClose(handle);
      InitialiseDealWatermark();
      return;
   }
   while(!FileIsEnding(handle))
   {
      string line = FileReadString(handle);
      string parts[];
      int n = StringSplit(line, '|', parts);
      if(n < 2) continue;
      if(parts[0] == "W")
      {
         g_dealWatermark = (ulong)StringToInteger(parts[1]);
         continue;
      }
      if(parts[0] != "R" || n < 25) continue;
      int slot = FreeManagedSlot();
      if(slot < 0) break;
      g_managed[slot].active = true;
      g_managed[slot].ticket = (ulong)StringToInteger(parts[1]);
      g_managed[slot].planId = parts[2];
      g_managed[slot].symbol = parts[3];
      g_managed[slot].isBuy = parts[4] == "1";
      g_managed[slot].entry = StringToDouble(parts[5]);
      g_managed[slot].riskPrice = StringToDouble(parts[6]);
      g_managed[slot].riskMoney = StringToDouble(parts[7]);
      g_managed[slot].beTriggerR = StringToDouble(parts[8]);
      g_managed[slot].beOffsetR = StringToDouble(parts[9]);
      g_managed[slot].beDone = parts[10] == "1";
      g_managed[slot].maxHoldSec = StringToInteger(parts[11]);
      g_managed[slot].openTime = (datetime)StringToInteger(parts[12]);
      g_managed[slot].extEnabled = parts[13] == "1";
      g_managed[slot].checkAtR = StringToDouble(parts[14]);
      g_managed[slot].extendToR = StringToDouble(parts[15]);
      g_managed[slot].lockR = StringToDouble(parts[16]);
      g_managed[slot].emaPeriod = (int)StringToInteger(parts[17]);
      g_managed[slot].tfName = parts[18];
      g_managed[slot].extendState = (int)StringToInteger(parts[19]);
      g_managed[slot].mfeR = StringToDouble(parts[20]);
      g_managed[slot].maeR = StringToDouble(parts[21]);
      g_managed[slot].closeDeal = (ulong)StringToInteger(parts[22]);
      g_managed[slot].closeReason = parts[23];
      g_managed[slot].lastSeen = (datetime)StringToInteger(parts[24]);
   }
   FileClose(handle);
}

/**
 * First attach with no saved state: history that predates the desk must not be
 * reported as new trades, so the watermark starts at the newest existing deal.
 */
void InitialiseDealWatermark()
{
   datetime now = TimeCurrent();
   if(!HistorySelect(now - DEAL_LOOKBACK_SECONDS, now + 60)) return;
   ulong top = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal > top) top = deal;
   }
   g_dealWatermark = top;
   g_managedDirty = true;
}

/** Value at risk to the stop, in account currency. 0 when it cannot be priced. */
double RiskMoneyFor(const string symbol, const bool isBuy, const double volume, const double entry, const double sl)
{
   if(sl <= 0 || volume <= 0 || entry <= 0) return 0;
   double profit = 0;
   ENUM_ORDER_TYPE type = isBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!OrderCalcProfit(type, symbol, volume, entry, sl, profit)) return 0;
   return MathAbs(profit);
}

/** The position an armed plan just opened: the newest unregistered one on its symbol. */
void RegisterManagedFill(const ArmedPlan &plan)
{
   ulong newest = 0;
   datetime newestTime = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      string symbol = PositionGetSymbol(i);
      if(symbol == "" || symbol != plan.symbol) continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
      if(FindManaged(ticket) >= 0) continue;
      datetime when = (datetime)PositionGetInteger(POSITION_TIME);
      if(newest == 0 || when >= newestTime)
      {
         newest = ticket;
         newestTime = when;
      }
   }
   if(newest == 0 || !PositionSelectByTicket(newest))
   {
      Log("Filled, but the new position could not be found to attach its management (" + plan.symbol + ").");
      return;
   }
   int slot = FreeManagedSlot();
   if(slot < 0)
   {
      Log("No free slot for managed positions; #" + IntegerToString((long)newest) + " runs on its stop alone.");
      return;
   }
   ManagedPosition m;
   m.active = true;
   m.ticket = newest;
   m.planId = plan.id;
   m.symbol = PositionGetString(POSITION_SYMBOL);
   m.isBuy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
   m.entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl = PositionGetDouble(POSITION_SL);
   m.riskPrice = MathAbs(m.entry - sl);
   m.riskMoney = RiskMoneyFor(m.symbol, m.isBuy, PositionGetDouble(POSITION_VOLUME), m.entry, sl);
   m.beTriggerR = plan.beTriggerR;
   m.beOffsetR = plan.beOffsetR;
   m.beDone = false;
   m.maxHoldSec = plan.maxHoldSec;
   m.openTime = (datetime)PositionGetInteger(POSITION_TIME);
   m.extEnabled = plan.extEnabled;
   m.checkAtR = plan.checkAtR;
   m.extendToR = plan.extendToR;
   m.lockR = plan.lockR;
   m.emaPeriod = plan.emaPeriod;
   m.tfName = plan.tfName;
   m.extendState = 0;
   m.mfeR = 0;
   m.maeR = 0;
   m.closeDeal = 0;
   m.closeReason = "";
   m.lastSeen = TimeCurrent();
   if(m.riskPrice <= 0)
      Log("WARNING: #" + IntegerToString((long)newest) + " has no stop, so its progress cannot be measured.");
   g_managed[slot] = m;
   g_managedDirty = true;
   SaveManagedState();
}

/**
 * A position this EA did not register: its state file is gone, or it was opened
 * before v3.05. It is managed with the legacy breakeven defaults. It has no time
 * stop or extension, because the plan that set them is no longer known.
 */
int AdoptPosition(const ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return -1;
   int slot = FreeManagedSlot();
   if(slot < 0) return -1;
   ManagedPosition m;
   m.active = true;
   m.ticket = ticket;
   m.planId = "";
   m.symbol = PositionGetString(POSITION_SYMBOL);
   m.isBuy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
   m.entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl = PositionGetDouble(POSITION_SL);
   m.riskPrice = MathAbs(m.entry - sl);
   m.riskMoney = RiskMoneyFor(m.symbol, m.isBuy, PositionGetDouble(POSITION_VOLUME), m.entry, sl);
   m.beTriggerR = 1.0;
   m.beOffsetR = 0.2;
   m.beDone = false;
   m.maxHoldSec = 0;
   m.openTime = (datetime)PositionGetInteger(POSITION_TIME);
   m.extEnabled = false;
   m.checkAtR = 0;
   m.extendToR = 0;
   m.lockR = 0;
   m.emaPeriod = 0;
   m.tfName = "";
   m.extendState = 2;
   m.mfeR = 0;
   m.maeR = 0;
   m.closeDeal = 0;
   m.closeReason = "";
   m.lastSeen = TimeCurrent();
   g_managed[slot] = m;
   g_managedDirty = true;
   Log("Adopted #" + IntegerToString((long)ticket) + " with the default breakeven; it was not opened by a plan this terminal still holds.");
   return slot;
}

ENUM_TIMEFRAMES TimeframeFromName(const string name)
{
   for(int i = 0; i < TF_COUNT; i++)
      if(TF_NAMES[i] == name) return TF_LIST[i];
   return PERIOD_M15;
}

/**
 * Is the trend still in the trade's favour? The last closed bar must sit on the
 * trade's side of an EMA that has been moving that way for the last five bars.
 * It is computed from iClose, so no indicator handle is needed. A missing bar
 * means the trend cannot be confirmed, which counts as not favourable.
 */
bool TrendStillFavourable(const string symbol, const bool isBuy, const ENUM_TIMEFRAMES tf, const int period)
{
   if(period < 2) return false;
   const int lag = 5;
   int seedEnd = period * 3 + lag + 1;
   double alpha = 2.0 / (period + 1.0);
   double sum = 0;
   for(int s = seedEnd; s > seedEnd - period; s--)
   {
      double c = iClose(symbol, tf, s);
      if(c <= 0) return false;
      sum += c;
   }
   double ema = sum / period;
   double emaNow = 0;
   double emaLag = 0;
   for(int s = seedEnd - period; s >= 1; s--)
   {
      double c = iClose(symbol, tf, s);
      if(c <= 0) return false;
      ema = alpha * c + (1.0 - alpha) * ema;
      if(s == 1) emaNow = ema;
      if(s == 1 + lag) emaLag = ema;
   }
   double last = iClose(symbol, tf, 1);
   if(last <= 0) return false;
   return isBuy ? (last > emaNow && emaNow > emaLag) : (last < emaNow && emaNow < emaLag);
}

/**
 * Closed positions since the watermark, as the terminal's own records. Each
 * position is reported ONCE, from its last OUT deal, with its whole-trade P&L.
 * `topDeal` returns the highest deal reported; it becomes the watermark only
 * after the desk acknowledges the response.
 */
string ClosedDealsJson(ulong &topDeal)
{
   topDeal = 0;
   datetime now = TimeCurrent();
   if(!HistorySelect(now - DEAL_LOOKBACK_SECONDS, now + 60)) return "[]";
   ulong candidates[];
   int count = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total && count < DEALS_PER_BEAT; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0 || deal <= g_dealWatermark) continue;
      if((int)HistoryDealGetInteger(deal, DEAL_MAGIC) != MagicNumber) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      ArrayResize(candidates, count + 1);
      candidates[count] = deal;
      count++;
   }
   string json = "[";
   bool first = true;
   for(int k = 0; k < count; k++)
   {
      string item = ClosedDealJson(candidates[k]);
      if(item == "") continue;
      if(!first) json += ",";
      first = false;
      json += item;
      if(candidates[k] > topDeal) topDeal = candidates[k];
   }
   json += "]";
   return json;
}

/** One closed position as JSON, or "" if it is not the final close of its position. */
string ClosedDealJson(const ulong outDeal)
{
   long positionId = HistoryDealGetInteger(outDeal, DEAL_POSITION_ID);
   if(positionId <= 0) return "";
   string symbol = HistoryDealGetString(outDeal, DEAL_SYMBOL);
   if(!HistorySelectByPosition(positionId)) return "";

   double profit = 0;
   double commission = 0;
   double swap = 0;
   double openPrice = 0;
   double volume = 0;
   datetime openTime = 0;
   long openType = -1;
   bool isLast = true;
   int total = HistoryDealsTotal();
   for(int j = 0; j < total; j++)
   {
      ulong d = HistoryDealGetTicket(j);
      if(d == 0) continue;
      profit += HistoryDealGetDouble(d, DEAL_PROFIT);
      commission += HistoryDealGetDouble(d, DEAL_COMMISSION);
      swap += HistoryDealGetDouble(d, DEAL_SWAP);
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_IN && openType < 0)
      {
         openType = HistoryDealGetInteger(d, DEAL_TYPE);
         openPrice = HistoryDealGetDouble(d, DEAL_PRICE);
         openTime = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
         volume = HistoryDealGetDouble(d, DEAL_VOLUME);
      }
      if((entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY) && d > outDeal) isLast = false;
   }
   if(!isLast) return "";

   double closePrice = HistoryDealGetDouble(outDeal, DEAL_PRICE);
   datetime closeTime = (datetime)HistoryDealGetInteger(outDeal, DEAL_TIME);
   string side = (openType == DEAL_TYPE_SELL) ? "sell" : "buy";
   long reasonCode = HistoryDealGetInteger(outDeal, DEAL_REASON);
   string reason = "other";
   if(reasonCode == DEAL_REASON_SL) reason = "sl";
   else if(reasonCode == DEAL_REASON_TP) reason = "tp";
   else if(reasonCode == DEAL_REASON_SO) reason = "stop_out";
   else if(reasonCode == DEAL_REASON_EXPERT) reason = "expert";
   else if(reasonCode == DEAL_REASON_CLIENT || reasonCode == DEAL_REASON_MOBILE || reasonCode == DEAL_REASON_WEB) reason = "manual";

   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   string planId = "";
   double riskMoney = 0;
   double riskPoints = 0;
   double mfe = 0;
   double mae = 0;
   int slot = FindManaged((ulong)positionId);
   if(slot >= 0)
   {
      planId = g_managed[slot].planId;
      riskMoney = g_managed[slot].riskMoney;
      if(point > 0) riskPoints = g_managed[slot].riskPrice / point;
      if(g_managed[slot].closeReason != "") reason = g_managed[slot].closeReason;
      else if(reason == "sl" && g_managed[slot].beDone) reason = "breakeven_stop";
      mfe = g_managed[slot].mfeR;
      mae = g_managed[slot].maeR;
      g_managed[slot].closeDeal = outDeal;
      g_managedDirty = true;
   }

   string json = "{";
   json += "\"dealTicket\":" + IntegerToString((long)outDeal) + ",";
   json += "\"positionId\":" + IntegerToString(positionId) + ",";
   json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
   json += "\"side\":\"" + side + "\",";
   json += "\"volume\":" + DoubleToString(volume, 4) + ",";
   json += "\"openPrice\":" + DoubleToString(openPrice, 10) + ",";
   json += "\"closePrice\":" + DoubleToString(closePrice, 10) + ",";
   json += "\"openTime\":" + IntegerToString(ToUtcMs(openTime)) + ",";
   json += "\"closeTime\":" + IntegerToString(ToUtcMs(closeTime)) + ",";
   json += "\"profit\":" + DoubleToString(profit, 2) + ",";
   json += "\"commission\":" + DoubleToString(commission, 2) + ",";
   json += "\"swap\":" + DoubleToString(swap, 2) + ",";
   json += "\"reason\":\"" + reason + "\",";
   json += "\"planId\":\"" + JsonEscape(planId) + "\",";
   json += "\"initialRiskMoney\":" + (riskMoney > 0 ? DoubleToString(riskMoney, 2) : "null") + ",";
   json += "\"initialRiskPoints\":" + (riskPoints > 0 ? DoubleToString(riskPoints, 2) : "null") + ",";
   json += "\"mfeR\":" + DoubleToString(mfe, 4) + ",";
   json += "\"maeR\":" + DoubleToString(mae, 4) + "}";
   return json;
}

/** The desk has stored these closes: advance the watermark and release their records. */
void AckClosedDeals(const ulong upTo)
{
   if(upTo <= g_dealWatermark) return;
   g_dealWatermark = upTo;
   for(int i = 0; i < MAX_MANAGED; i++)
      if(g_managed[i].active && g_managed[i].closeDeal != 0 && g_managed[i].closeDeal <= upTo)
         g_managed[i].active = false;
   g_managedDirty = true;
   SaveManagedState();
}


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
   LoadManagedState();

   Print("NeurotradeBridge v3.05 attached. Configure ServerUrl and PairingCode in EA Inputs; ",
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
   SaveManagedState();
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
   body += "\"version\":\"3.05\",";
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
   body += "\"version\":\"3.05\",";
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
   // Closed trades from the terminal's own records. Scanned at most every two
   // seconds; the same deals are re-sent until the desk acknowledges them.
   g_pendingDealMax = 0;
   string deals = "[]";
   ulong nowMs = GetTickCount64();
   if(nowMs - g_lastDealScanMs >= DEAL_SCAN_THROTTLE_MS)
   {
      g_lastDealScanMs = nowMs;
      deals = ClosedDealsJson(g_pendingDealMax);
   }
   body += "\"closedDeals\":" + deals + ",";
   body += "\"positions\":" + PositionsJson() + ",";
   body += "\"results\":[" + g_results + "]";
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
   AckClosedDeals(g_pendingDealMax);
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
      json += "\"commission\":0";
      // Open-position commission stays 0: the close's own deal carries the whole of it.
      int managedSlot = FindManaged((ulong)PositionGetInteger(POSITION_TICKET));
      if(managedSlot >= 0 && g_managed[managedSlot].riskMoney > 0)
      {
         double pointSize = SymbolInfoDouble(symbol, SYMBOL_POINT);
         json += ",\"initialRiskMoney\":" + DoubleToString(g_managed[managedSlot].riskMoney, 2);
         if(pointSize > 0)
            json += ",\"initialRiskPoints\":" + DoubleToString(g_managed[managedSlot].riskPrice / pointSize, 2);
      }
      json += ",\"comment\":\"" + JsonEscape(PositionGetString(POSITION_COMMENT)) + "\"}";
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
      RegisterManagedFill(g_plans[index]);
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
      int slot = FindManaged(ticket);
      if(slot < 0) slot = AdoptPosition(ticket);
      if(slot < 0) continue;
      g_managed[slot].lastSeen = TimeCurrent();

      bool isBuy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double entry = g_managed[slot].entry;
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double riskPrice = g_managed[slot].riskPrice;
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      if(point <= 0 || riskPrice <= 0) continue;

      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick)) continue;
      // The price a close would fill at: the bid for a long, the ask for a short.
      double current = isBuy ? tick.bid : tick.ask;
      double progressR = (isBuy ? current - entry : entry - current) / riskPrice;
      if(progressR > g_managed[slot].mfeR) g_managed[slot].mfeR = progressR;
      if(progressR < g_managed[slot].maeR) g_managed[slot].maeR = progressR;

      // Time stop: the hold is exhausted, so close at market. Retried if the close fails.
      if(g_managed[slot].maxHoldSec > 0 &&
         TimeCurrent() - g_managed[slot].openTime >= g_managed[slot].maxHoldSec)
      {
         if(trade.PositionClose(ticket))
         {
            g_managed[slot].closeReason = "time_stop";
            g_managedDirty = true;
            Log("Time stop: closed #" + IntegerToString((long)ticket) + " after " +
                IntegerToString(g_managed[slot].maxHoldSec / 60) + " min.");
         }
         else Log("Time stop on #" + IntegerToString((long)ticket) + " failed; retrying on the next beat.");
         continue;
      }

      // Breakeven: once, when progress reaches the trigger. The stop only ever tightens.
      if(!g_managed[slot].beDone && g_managed[slot].beTriggerR > 0 && progressR >= g_managed[slot].beTriggerR)
      {
         double candidate = isBuy ? entry + g_managed[slot].beOffsetR * riskPrice
                                  : entry - g_managed[slot].beOffsetR * riskPrice;
         double newSl = sl;
         if(isBuy ? candidate > sl : candidate < sl) newSl = candidate;
         if(newSl == sl)
         {
            g_managed[slot].beDone = true;
            g_managedDirty = true;
         }
         else if(RespectsStopLevel(symbol, isBuy, current, newSl) &&
                 ModifyPositionByTicket(ticket, symbol, NormalizeDouble(newSl, digits), tp))
         {
            g_managed[slot].beDone = true;
            g_managedDirty = true;
            sl = newSl;
            Log("Breakeven: #" + IntegerToString((long)ticket) + " stop moved to entry " +
                DoubleToString(g_managed[slot].beOffsetR, 2) + "R.");
         }
      }

      // Extension: decided once, at checkAtR. The target moves out only while the
      // trend still favours the trade; otherwise the fixed target stands.
      if(g_managed[slot].extEnabled && g_managed[slot].extendState == 0 &&
         progressR >= g_managed[slot].checkAtR)
      {
         if(TrendStillFavourable(symbol, isBuy, TimeframeFromName(g_managed[slot].tfName), g_managed[slot].emaPeriod))
         {
            double newTp = isBuy ? entry + g_managed[slot].extendToR * riskPrice
                                 : entry - g_managed[slot].extendToR * riskPrice;
            double lock = isBuy ? entry + g_managed[slot].lockR * riskPrice
                                : entry - g_managed[slot].lockR * riskPrice;
            double newSl = sl;
            if(isBuy ? lock > sl : lock < sl) newSl = lock;
            if(ModifyPositionByTicket(ticket, symbol, NormalizeDouble(newSl, digits), NormalizeDouble(newTp, digits)))
            {
               g_managed[slot].extendState = 2;
               g_managedDirty = true;
               Log("Extension: #" + IntegerToString((long)ticket) + " trend still favours the trade; target to " +
                   DoubleToString(g_managed[slot].extendToR, 1) + "R.");
            }
         }
         else
         {
            g_managed[slot].extendState = 1;
            g_managedDirty = true;
            Log("Extension declined: #" + IntegerToString((long)ticket) + " trend no longer favours the trade.");
         }
      }
   }

   // A record whose position is gone and whose close was never reported is released
   // after an hour. Its deal would have appeared within that time.
   for(int k = 0; k < MAX_MANAGED; k++)
   {
      if(!g_managed[k].active || g_managed[k].closeDeal != 0) continue;
      if(PositionSelectByTicket(g_managed[k].ticket)) continue;
      if(TimeCurrent() - g_managed[k].lastSeen > 3600)
      {
         g_managed[k].active = false;
         g_managedDirty = true;
      }
   }
   if(g_managedDirty) SaveManagedState();
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
   string management = JsonObject(plan, "management");
   string breakeven = JsonObject(management, "breakeven");
   string extension = JsonObject(management, "extension");
   string timeStop = JsonObject(management, "timeStop");
   g_plans[slot].beTriggerR = JsonNumber(breakeven, "triggerR");
   g_plans[slot].beOffsetR = JsonNumber(breakeven, "offsetR");
   if(g_plans[slot].beTriggerR <= 0) g_plans[slot].beTriggerR = 1.0;
   g_plans[slot].maxHoldSec = (long)(JsonNumber(timeStop, "maxHoldMinutes") * 60.0);
   g_plans[slot].checkAtR = JsonNumber(extension, "checkAtR");
   g_plans[slot].extendToR = JsonNumber(extension, "extendToR");
   g_plans[slot].lockR = JsonNumber(extension, "lockR");
   g_plans[slot].emaPeriod = (int)JsonNumber(extension, "emaPeriod");
   g_plans[slot].tfName = JsonString(extension, "timeframe");
   // An extension is honoured only when it is coherent: the decision must come
   // before the extended target, and the trend needs a real EMA. Otherwise the
   // plan keeps its fixed target.
   g_plans[slot].extEnabled = extension != ""
      && g_plans[slot].checkAtR > 0
      && g_plans[slot].extendToR > g_plans[slot].checkAtR
      && g_plans[slot].emaPeriod >= 2
      && g_plans[slot].lockR >= 0;
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

double AtrValue(const string symbol, const ENUM_TIMEFRAMES timeframe, const int period)
{
   int handle = iATR(symbol, timeframe, period);
   if(handle == INVALID_HANDLE) return 0;
   double buffer[];
   int copied = CopyBuffer(handle, 0, 0, 1, buffer);
   IndicatorRelease(handle);
   return copied > 0 ? buffer[0] : 0;
}

bool FindPlanForSymbol(const string symbol, ArmedPlan &out)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].symbol == symbol) { out = g_plans[i]; return true; }
   return false;
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
