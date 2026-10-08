//+------------------------------------------------------------------+
//|                                          NeurotradeBridge.mq5    |
//|      NeuroTrade Multi-Asset Desk / resilient MetaTrader 5 EA     |
//+------------------------------------------------------------------+
//| Version 3.02                                                     |
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
#property version   "3.02"
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
   double trailMult;
   double trailActivateR;
   bool   trailEnabled;
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
// The heartbeat interval this EA is actually running with, sent in `clock` so
// the desk sizes its own patience from the terminal's contract instead of
// assuming a cadence: a slow heartbeat must not read as a dead terminal.
int       g_syncIntervalMs = 500;
string    g_newsCurrencies[];
string    g_newsCountries[];
string    g_newsNames[];

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

   Print("NeurotradeBridge v2 attached. Configure ServerUrl and PairingCode in EA Inputs; ",
         "pairing will retry without removing the EA from this chart.");
   if(StringLen(NormalisedServerUrl()) == 0)
      Print("NeurotradeBridge: ServerUrl is empty. Set it to the public Desk origin.");
   if(StringLen(PairingCode) == 0)
      Print("NeurotradeBridge: PairingCode is empty. Open Desk -> Link MT5 to generate one.");

   // Never fail initialization simply because pairing is not ready yet.
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
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
   if(g_token == "")
      TryPair();
   else
      Sync();

   RollDayBaselineIfNeeded();
   RefreshCalendar(false);
   ManageOpenPositions();
   EvaluatePlans();
}

//+------------------------------------------------------------------+
//| Pairing and HTTP                                                  |
//+------------------------------------------------------------------+
void TryPair()
{
   datetime now = NowServer();
   if(now < g_nextPairAttempt) return;
   g_nextPairAttempt = now + 5;

   string base = NormalisedServerUrl();
   if(base == "")
   {
      Log("Waiting for ServerUrl input.");
      return;
   }
   if(StringLen(StringTrimmed(PairingCode)) == 0)
   {
      Log("Waiting for PairingCode input.");
      return;
   }

   string body = "{\"pairingCode\":\"" + JsonEscape(StringTrimmed(PairingCode)) + "\",\"terminal\":{";
   body += "\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   body += "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   body += "\"company\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
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
         Print("NeurotradeBridge: PAIRING REFUSED — ", (g_lastHttpError == "" ? "this MT5 account is already connected in another browser." : g_lastHttpError));
         Print("NeurotradeBridge: open the Desk that holds account ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
               "@", AccountInfoString(ACCOUNT_SERVER), " and unlink it, or wait a few minutes. Retrying in 60s with the same code.");
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
   ApplyServerResponse(response);
   Print("NeurotradeBridge: paired successfully. Waiting for Desk market selections.");
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
   int status = WebRequest("POST", base + path, headers, 8000, post, result, resultHeaders);
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
         // user enter a fresh code rather than doing any blind work.
         g_token = "";
         g_tradingEnabled = false;
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
//+------------------------------------------------------------------+
int ServerUtcOffsetSeconds()
{
   long offset = (long)TimeTradeServer() - (long)TimeGMT();
   if(offset > 86400) offset = 86400;
   if(offset < -86400) offset = -86400;
   return (int)offset;
}

/** Trade-server datetime -> true UTC epoch, in milliseconds. */
long ToUtcMs(const datetime serverTime)
{
   return ((long)serverTime - (long)ServerUtcOffsetSeconds()) * 1000;
}

/** Trade-server tick clock (already in ms) -> true UTC epoch, in ms. */
long TickToUtcMs(const long tickMsc, const long fallbackServerSeconds)
{
   if(tickMsc > 0) return tickMsc - (long)ServerUtcOffsetSeconds() * 1000;
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
   // Tell the server how this terminal's clock relates to UTC. Combined with
   // the UTC-normalised timestamps below it lets the Desk detect a skewed
   // clock instead of trusting (or silently mis-trusting) every tick.
   body += "\"clock\":{\"serverUtcOffsetSeconds\":" + IntegerToString(ServerUtcOffsetSeconds())
         + ",\"terminalUtcMs\":" + IntegerToString(NowUtcMs())
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
   body += "\"news\":" + NewsJson() + ",";
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
         g_nextPairAttempt = 0;
      }
      // Bounded by the SERVER-silence budget, not the tick-freshness one: the
      // desk keeps a link alive for its own (adaptive) window, and the EA must
      // not stop executing plans while the desk still considers the link live.
      else if(NowServer() - g_lastOk > ServerSilenceSec) g_tradingEnabled = false;
      return;
   }

   g_lastOk = NowServer();
   g_results = "";
   if(JsonBool(response, "needsHistory") == 1) ResetSeeding();
   ApplyServerResponse(response);
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
      for(int t = 0; t < TF_COUNT; t++)
      {
         int want = IsSeeded(sourceIndex, t) ? (int)MathMax(2, DeltaBars) : (int)MathMax(60, HistoryBars);
         MqlRates rates[];
         ArraySetAsSeries(rates, false);
         int copied = CopyRates(symbols[s], TF_LIST[t], 0, want, rates);
         if(copied <= 0) continue;
         MarkSeeded(sourceIndex, t);
         if(!first) json += ",";
         first = false;
         json += "{\"symbol\":\"" + JsonEscape(symbols[s]) + "\",\"timeframe\":\"" + TF_NAMES[t] + "\",\"bars\":[";
         for(int b = 0; b < copied; b++)
         {
            if(b > 0) json += ",";
            json += "[" + IntegerToString(ToUtcMs(rates[b].time)) + "," +
                    DoubleToString(rates[b].open, 10) + "," +
                    DoubleToString(rates[b].high, 10) + "," +
                    DoubleToString(rates[b].low, 10) + "," +
                    DoubleToString(rates[b].close, 10) + "," +
                    IntegerToString((long)rates[b].tick_volume) + "]";
         }
         json += "]}";
      }
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
   // A day of forward visibility: the Desk renders an upcoming-events list,
   // and a two-hour window left it empty for most of the session.
   int count = CalendarValueHistory(values, now - 15 * 60, now + 24 * 60 * 60);
   if(count <= 0)
   {
      // Fallback: everything the terminal knows from six hours ago onward.
      int wide = CalendarValueHistory(values, now - 6 * 60 * 60, 0);
      if(wide > 0) count = wide;
   }

   g_rawCount = count > 0 ? count : 0;

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
      bool isBuy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0 || sl == 0) continue;

      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick)) continue;
      double current = isBuy ? tick.bid : tick.ask;
      double riskPoints = MathAbs(entry - sl) / point;
      if(riskPoints <= 0) continue;
      double movePoints = (isBuy ? current - entry : entry - current) / point;
      double progressR = movePoints / riskPoints;

      ArmedPlan plan;
      bool hasPlan = FindPlanForSymbol(symbol, plan);
      double beTrigger = hasPlan && plan.beTriggerR > 0 ? plan.beTriggerR : 1.0;
      double beOffset = hasPlan ? plan.beOffsetR : 0.2;
      double newSl = sl;
      if(progressR >= beTrigger)
      {
         double candidate = isBuy ? entry + beOffset * riskPoints * point : entry - beOffset * riskPoints * point;
         if((isBuy && candidate > newSl) || (!isBuy && candidate < newSl)) newSl = candidate;
      }
      if(hasPlan && plan.trailEnabled && progressR >= plan.trailActivateR)
      {
         double atr = AtrValue(symbol, PERIOD_M15, 14);
         if(atr > 0)
         {
            double candidate = isBuy ? current - atr * plan.trailMult : current + atr * plan.trailMult;
            if((isBuy && candidate > newSl) || (!isBuy && candidate < newSl)) newSl = candidate;
         }
      }
      if(newSl != sl && RespectsStopLevel(symbol, isBuy, current, newSl))
      {
         int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
         ModifyPositionByTicket(ticket, symbol, NormalizeDouble(newSl, digits), tp);
      }
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
   string trail = JsonObject(management, "trail");
   g_plans[slot].beTriggerR = JsonNumber(breakeven, "triggerR");
   g_plans[slot].beOffsetR = JsonNumber(breakeven, "offsetR");
   g_plans[slot].trailMult = JsonNumber(trail, "mult");
   g_plans[slot].trailActivateR = JsonNumber(trail, "activateAtR");
   g_plans[slot].trailEnabled = trail != "";
   if(g_plans[slot].beTriggerR <= 0) g_plans[slot].beTriggerR = 1.0;
   if(g_plans[slot].trailMult <= 0) g_plans[slot].trailMult = 2.5;
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
