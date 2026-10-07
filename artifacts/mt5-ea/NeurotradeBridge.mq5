//+------------------------------------------------------------------+
//|                                          NeurotradeBridge.mq5    |
//|           Multi-Asset Desk — MetaTrader 5 execution bridge        |
//+------------------------------------------------------------------+
//
// WHAT THIS IS
// ------------
// The local half of the split-brain architecture described in
// docs/multi-asset-architecture.md.
//
//   SERVER (the heavy brain)  runs every 1-5 s. Regime detection, Markov
//   persistence, Monte Carlo expectancy, multi-timeframe confluence and
//   position sizing. It never says "buy now" — by the time a network message
//   lands, the price has moved. It publishes an ARMED PLAN: a trigger level,
//   an invalidation level, SL/TP, a lot size and a hard expiry.
//
//   THIS EA (the trigger finger) holds that plan in memory and evaluates it on
//   EVERY TICK, locally. When price trades through the trigger and the spread
//   is inside the limit, it sends the order in under 10 ms with no network
//   round trip. It also enforces the management plan — breakeven, partials,
//   trailing — tick by tick.
//
// WHY IT IS BUILT THIS WAY
// ------------------------
//   * No credentials leave this machine. Pairing uses a short-lived code; the
//     server only ever learns an account number.
//   * The broker's own feed is both the data source and the execution venue,
//     so the prices the agent reasons about are the prices you are filled at.
//   * Every command carries a UUID and is executed at most once.
//   * Losing contact with the server degrades to MANAGE-ONLY, never to
//     trading blind. That is the fail-safe direction.
//
// SETUP
// -----
//   1. Copy this file to MQL5/Experts and compile it in MetaEditor.
//   2. Tools -> Options -> Expert Advisors -> "Allow WebRequest for listed
//      URL" and add your platform origin (e.g. https://your-app.example.com).
//   3. Attach to any chart, paste the pairing code from the Desk page.
//   4. Start on a DEMO account. Live trading stays server-side disabled until
//      you explicitly enable it.
//
//+------------------------------------------------------------------+
#property copyright "NeuroTrade AI"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- inputs ---------------------------------------------------------
input string ServerUrl        = "https://your-app.example.com"; // Platform origin (must be in the WebRequest allowlist)
input string PairingCode      = "";          // One-time code from the Desk page
input string SymbolsCsv       = "EURUSD,GBPUSD,USDJPY,XAUUSD,US30,NAS100,BTCUSD";
input int    SyncIntervalMs   = 1000;        // Server heartbeat interval
input int    HistoryBars      = 320;         // Bars sent on the first sync (seeds the server)
input int    DeltaBars        = 4;           // Bars sent per heartbeat thereafter
input int    MagicNumber      = 7781001;     // Identifies this EA's orders
input bool   AllowLiveAccount = false;       // Extra local guard for real-money accounts
input double MaxDailyLossPct  = 3.0;         // Local circuit breaker (mirrors the server)
input int    StaleAfterSec    = 30;          // No contact -> manage-only
input bool   VerboseLog       = true;

//--- constants ------------------------------------------------------
#define MAX_PLANS      16
#define MAX_SEEN_CMDS  256
#define MAX_SYMBOLS    32

ENUM_TIMEFRAMES TF_LIST[7] = {PERIOD_M1, PERIOD_M5, PERIOD_M15,
                              PERIOD_M30, PERIOD_H1, PERIOD_H4, PERIOD_D1};
string TF_NAMES[7] = {"M1", "M5", "M15", "M30", "H1", "H4", "D1"};

//--- armed plan -----------------------------------------------------
struct ArmedPlan
{
   string   id;
   string   symbol;
   bool     isBuy;
   double   trigger;
   double   invalidate;
   double   sl;
   double   tp;
   double   lots;
   double   maxSpreadPoints;
   double   maxSlippagePoints;
   long     expiresAt;        // epoch ms
   int      confirmTicks;
   int      confirmCount;     // consecutive ticks beyond the trigger
   // management
   double   beTriggerR;
   double   beOffsetR;
   double   trailMult;
   double   trailActivateR;
   bool     trailEnabled;
   bool     active;
};

ArmedPlan g_plans[MAX_PLANS];
string    g_seenCmds[MAX_SEEN_CMDS];
int       g_seenCount = 0;

string    g_token      = "";
long      g_seq        = 0;
datetime  g_lastSync   = 0;
datetime  g_lastOk     = 0;
bool      g_tradingEnabled     = false;
bool      g_liveTradingEnabled = false;
double    g_dayStartEquity     = 0;
int       g_dayStamp           = 0;
string    g_symbols[MAX_SYMBOLS];
int       g_symbolCount = 0;

// Results pending delivery to the server.
string    g_results = "";

// History is seeded once per symbol/timeframe, then only the newest bars are
// sent. Shipping 320 bars × 7 timeframes × every symbol on a 1 s heartbeat is
// megabytes per second of mostly unchanged data; the server merges by
// timestamp, so a small overlapping tail keeps it in sync for free.
bool      g_seeded[MAX_SYMBOLS][7];

CTrade        trade;
CPositionInfo posinfo;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetAsyncMode(false);
   trade.SetDeviationInPoints(10);

   SplitSymbols(SymbolsCsv);
   for(int i = 0; i < g_symbolCount; i++)
      SymbolSelect(g_symbols[i], true);

   ResetSeeding();
   ResetDayBaseline();

   if(!Pair())
   {
      Print("NeurotradeBridge: pairing failed. Check ServerUrl, the WebRequest allowlist and the pairing code.");
      return(INIT_FAILED);
   }

   EventSetMillisecondTimer(SyncIntervalMs);
   Print("NeurotradeBridge: linked. Watching ", g_symbolCount, " symbols.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("NeurotradeBridge: stopped (reason ", reason, ").");
}

//+------------------------------------------------------------------+
//| TICK — the latency-critical path. No network here, ever.         |
//+------------------------------------------------------------------+
void OnTick()
{
   ManageOpenPositions();
   EvaluatePlans();
}

//+------------------------------------------------------------------+
//| TIMER — the heartbeat. All network I/O lives here.               |
//+------------------------------------------------------------------+
void OnTimer()
{
   RollDayBaselineIfNeeded();
   Sync();
}

//+------------------------------------------------------------------+
//| Local trigger evaluation                                         |
//+------------------------------------------------------------------+
void EvaluatePlans()
{
   long now = (long)TimeGMT() * 1000;

   for(int i = 0; i < MAX_PLANS; i++)
   {
      if(!g_plans[i].active) continue;

      // Expiry is enforced locally so a plan cannot outlive its analysis even
      // if the server goes away.
      if(g_plans[i].expiresAt > 0 && now > g_plans[i].expiresAt)
      {
         Log("Plan " + g_plans[i].id + " expired untriggered.");
         g_plans[i].active = false;
         continue;
      }

      string sym = g_plans[i].symbol;
      MqlTick tick;
      if(!SymbolInfoTick(sym, tick)) continue;

      double price  = g_plans[i].isBuy ? tick.ask : tick.bid;
      double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
      if(point <= 0) continue;
      double spread = (tick.ask - tick.bid) / point;

      // Invalidation: the setup is dead, do not wait for expiry.
      bool invalidated = g_plans[i].isBuy
                         ? (tick.bid <= g_plans[i].invalidate)
                         : (tick.ask >= g_plans[i].invalidate);
      if(invalidated)
      {
         Log("Plan " + g_plans[i].id + " invalidated at " + DoubleToString(price, _Digits));
         g_plans[i].active = false;
         continue;
      }

      // Trigger: price must trade through the level in the trade direction.
      bool through = g_plans[i].isBuy ? (price >= g_plans[i].trigger)
                                      : (price <= g_plans[i].trigger);
      if(!through)
      {
         g_plans[i].confirmCount = 0;
         continue;
      }

      // Require N consecutive confirming ticks — one print through a level is
      // noise, especially on a scalp.
      g_plans[i].confirmCount++;
      if(g_plans[i].confirmCount < g_plans[i].confirmTicks) continue;

      // Execution gates, evaluated at the moment of firing rather than when
      // the plan was built.
      if(g_plans[i].maxSpreadPoints > 0 && spread > g_plans[i].maxSpreadPoints)
      {
         Log("Plan " + g_plans[i].id + " skipped: spread " + DoubleToString(spread, 1) +
             " > limit " + DoubleToString(g_plans[i].maxSpreadPoints, 1));
         continue;
      }
      if(!TradingAllowed(sym))
      {
         g_plans[i].active = false;
         continue;
      }

      ExecutePlan(i, price);
   }
}

void ExecutePlan(int index, double price)
{
   string sym = g_plans[index].symbol;
   double lots = NormaliseVolume(sym, g_plans[index].lots);
   if(lots <= 0)
   {
      Log("Plan " + g_plans[index].id + " rejected: volume normalises to zero.");
      g_plans[index].active = false;
      return;
   }

   trade.SetDeviationInPoints((int)MathMax(1, g_plans[index].maxSlippagePoints));

   bool ok = g_plans[index].isBuy
             ? trade.Buy(lots, sym, 0.0, g_plans[index].sl, g_plans[index].tp, "nt:" + g_plans[index].id)
             : trade.Sell(lots, sym, 0.0, g_plans[index].sl, g_plans[index].tp, "nt:" + g_plans[index].id);

   if(ok)
   {
      double fill = trade.ResultPrice();
      double point = SymbolInfoDouble(sym, SYMBOL_POINT);
      double slip = (point > 0) ? MathAbs(fill - price) / point : 0;
      AddResult(g_plans[index].id, "filled", (long)trade.ResultOrder(), fill, slip, "");
      Log("FILLED " + sym + " " + (g_plans[index].isBuy ? "BUY" : "SELL") + " " +
          DoubleToString(lots, 2) + " @ " + DoubleToString(fill, _Digits) +
          " (slip " + DoubleToString(slip, 1) + " pts)");
   }
   else
   {
      AddResult(g_plans[index].id, "rejected", 0, 0, 0,
                "retcode " + IntegerToString(trade.ResultRetcode()) + " " + trade.ResultRetcodeDescription());
      Log("REJECTED " + sym + ": " + trade.ResultRetcodeDescription());
   }

   // One shot per plan either way. A retry loop here is how duplicate
   // positions get opened during a broker hiccup.
   g_plans[index].active = false;
}

//+------------------------------------------------------------------+
//| Position management — breakeven, trailing, local circuit breaker |
//+------------------------------------------------------------------+
void ManageOpenPositions()
{
   // Local daily-loss breaker. The server enforces this too, but a breaker
   // that depends on connectivity is not a breaker.
   if(DailyLossBreached())
   {
      FlattenAll("local daily loss limit");
      return;
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posinfo.SelectByIndex(i)) continue;
      if(posinfo.Magic() != MagicNumber) continue;

      string sym   = posinfo.Symbol();
      double entry = posinfo.PriceOpen();
      double sl    = posinfo.StopLoss();
      double tp    = posinfo.TakeProfit();
      bool   isBuy = (posinfo.PositionType() == POSITION_TYPE_BUY);
      double point = SymbolInfoDouble(sym, SYMBOL_POINT);
      if(point <= 0 || sl == 0) continue;

      double riskPoints = MathAbs(entry - sl) / point;
      if(riskPoints <= 0) continue;

      MqlTick tick;
      if(!SymbolInfoTick(sym, tick)) continue;
      double current = isBuy ? tick.bid : tick.ask;
      double movePoints = (isBuy ? (current - entry) : (entry - current)) / point;
      double progressR = movePoints / riskPoints;

      ArmedPlan plan;
      bool hasPlan = FindPlanForSymbol(sym, plan);
      double beTrigger = hasPlan ? plan.beTriggerR : 1.0;
      double beOffset  = hasPlan ? plan.beOffsetR  : 0.2;

      double newSl = sl;

      // Breakeven: only once the trade has earned it.
      if(progressR >= beTrigger)
      {
         double bePrice = isBuy ? entry + beOffset * riskPoints * point
                                : entry - beOffset * riskPoints * point;
         if((isBuy && bePrice > newSl) || (!isBuy && bePrice < newSl))
            newSl = bePrice;
      }

      // ATR chandelier trail, when the server's plan enabled it.
      if(hasPlan && plan.trailEnabled && progressR >= plan.trailActivateR)
      {
         double atr = AtrValue(sym, PERIOD_M15, 14);
         if(atr > 0)
         {
            double trailPrice = isBuy ? current - atr * plan.trailMult
                                      : current + atr * plan.trailMult;
            if((isBuy && trailPrice > newSl) || (!isBuy && trailPrice < newSl))
               newSl = trailPrice;
         }
      }

      if(newSl != sl && RespectsStopLevel(sym, isBuy, current, newSl))
      {
         newSl = NormalizeDouble(newSl, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS));
         if(!trade.PositionModify(posinfo.Ticket(), newSl, tp))
            Log("Modify failed on #" + IntegerToString(posinfo.Ticket()) + ": " + trade.ResultRetcodeDescription());
      }
   }
}

//+------------------------------------------------------------------+
//| Server sync                                                      |
//+------------------------------------------------------------------+
void Sync()
{
   if(g_token == "") return;

   g_seq++;
   string body = "{";
   body += "\"seq\":" + IntegerToString(g_seq) + ",";
   body += "\"account\":" + AccountJson() + ",";
   body += "\"specs\":" + SpecsJson() + ",";
   body += "\"quotes\":" + QuotesJson() + ",";
   body += "\"candles\":" + CandlesJson() + ",";
   body += "\"positions\":" + PositionsJson() + ",";
   body += "\"results\":[" + g_results + "]";
   body += "}";

   string response = "";
   if(!HttpPost("/api/bridge/sync", body, response, true))
   {
      // Stale connection: stop opening anything new, keep managing what is
      // already on. Silence must never mean "carry on trading blind".
      if(TimeCurrent() - g_lastOk > StaleAfterSec)
         g_tradingEnabled = false;
      return;
   }

   g_lastOk  = TimeCurrent();
   g_results = "";          // delivered

   // The server tells us when it has no history for us — after a restart or a
   // re-pair — and we re-seed rather than leaving it analysing four bars.
   if(JsonBool(response, "needsHistory") == 1) ResetSeeding();
   ApplyServerResponse(response);
}

void ApplyServerResponse(const string json)
{
   g_tradingEnabled     = (JsonBool(json, "tradingEnabled")     == 1);
   g_liveTradingEnabled = (JsonBool(json, "liveTradingEnabled") == 1);

   // Commands arrive as a JSON array; walk it object by object.
   int cursor = StringFind(json, "\"commands\"");
   if(cursor < 0) return;
   int start = StringFind(json, "[", cursor);
   if(start < 0) return;

   int depth = 0, objStart = -1;
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

void HandleCommand(const string obj)
{
   string id   = JsonString(obj, "id");
   string type = JsonString(obj, "type");
   if(id == "" || type == "") return;

   // Idempotency: a retried sync must never execute a command twice.
   if(AlreadySeen(id)) return;
   MarkSeen(id);

   if(type == "arm_plan")            ArmPlanFromJson(obj, id);
   else if(type == "cancel_plan")    CancelPlan(JsonString(obj, "planId"), id);
   else if(type == "close")          ClosePosition((long)JsonNumber(obj, "ticket"), 0, id);
   else if(type == "close_partial")  ClosePosition((long)JsonNumber(obj, "ticket"), JsonNumber(obj, "lots"), id);
   else if(type == "modify")         ModifyPosition(obj, id);
   else if(type == "flatten_all")    { FlattenAll(JsonString(obj, "reason")); AddResult(id, "done", 0, 0, 0, ""); }
   else                              AddResult(id, "skipped", 0, 0, 0, "unknown command type");
}

void ArmPlanFromJson(const string obj, const string cmdId)
{
   if(!g_tradingEnabled)
   {
      AddResult(cmdId, "skipped", 0, 0, 0, "trading disabled by the server");
      return;
   }

   int slot = -1;
   for(int i = 0; i < MAX_PLANS; i++)
      if(!g_plans[i].active) { slot = i; break; }
   if(slot < 0)
   {
      AddResult(cmdId, "rejected", 0, 0, 0, "no free plan slot");
      return;
   }

   // Everything below reads from the nested plan object, never the command
   // wrapper — see JsonObject() for why that distinction matters.
   string plan = JsonObject(obj, "plan");
   if(plan == "")
   {
      AddResult(cmdId, "rejected", 0, 0, 0, "arm_plan command carried no plan");
      return;
   }

   string sym = JsonString(plan, "symbol");
   if(!TradingAllowed(sym))
   {
      AddResult(cmdId, "skipped", 0, 0, 0, "local guard blocked this symbol");
      return;
   }

   // One plan per symbol: a second would race the first and could double the
   // intended exposure.
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].symbol == sym) g_plans[i].active = false;

   g_plans[slot].id                = JsonString(plan, "id");
   g_plans[slot].symbol            = sym;
   g_plans[slot].isBuy             = (JsonString(plan, "side") == "buy");
   g_plans[slot].trigger           = JsonNumber(plan, "trigger");
   g_plans[slot].invalidate        = JsonNumber(plan, "invalidate");
   g_plans[slot].sl                = JsonNumber(plan, "sl");
   g_plans[slot].tp                = JsonFirstArrayNumber(plan, "tp");
   g_plans[slot].lots              = JsonNumber(plan, "lots");
   g_plans[slot].maxSpreadPoints   = JsonNumber(plan, "maxSpreadPoints");
   g_plans[slot].maxSlippagePoints = JsonNumber(plan, "maxSlippagePoints");
   g_plans[slot].expiresAt         = (long)JsonNumber(plan, "expiresAt");
   g_plans[slot].confirmTicks      = (int)MathMax(1, JsonNumber(plan, "confirmTicks"));
   g_plans[slot].confirmCount      = 0;
   string mgmt      = JsonObject(plan, "management");
   string breakeven = JsonObject(mgmt, "breakeven");
   string trail     = JsonObject(mgmt, "trail");

   g_plans[slot].beTriggerR        = JsonNumber(breakeven, "triggerR");
   g_plans[slot].beOffsetR         = JsonNumber(breakeven, "offsetR");
   g_plans[slot].trailMult         = JsonNumber(trail, "mult");
   g_plans[slot].trailActivateR    = JsonNumber(trail, "activateAtR");
   g_plans[slot].trailEnabled      = (trail != "");
   g_plans[slot].active            = true;

   if(g_plans[slot].beTriggerR <= 0) g_plans[slot].beTriggerR = 1.0;
   if(g_plans[slot].trailMult  <= 0) g_plans[slot].trailMult  = 2.5;

   AddResult(cmdId, "done", 0, 0, 0, "");
   Log("ARMED " + sym + " " + (g_plans[slot].isBuy ? "BUY" : "SELL") +
       " trigger " + DoubleToString(g_plans[slot].trigger, _Digits) +
       " lots " + DoubleToString(g_plans[slot].lots, 2));
}

void CancelPlan(const string planId, const string cmdId)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].active && g_plans[i].id == planId) g_plans[i].active = false;
   AddResult(cmdId, "done", 0, 0, 0, "");
}

void ClosePosition(long ticket, double lots, const string cmdId)
{
   if(!posinfo.SelectByTicket(ticket))
   {
      AddResult(cmdId, "skipped", 0, 0, 0, "position not found");
      return;
   }

   bool ok = (lots > 0 && lots < posinfo.Volume())
             ? trade.PositionClosePartial(ticket, NormaliseVolume(posinfo.Symbol(), lots))
             : trade.PositionClose(ticket);

   AddResult(cmdId, ok ? "done" : "rejected", ticket, trade.ResultPrice(), 0,
             ok ? "" : trade.ResultRetcodeDescription());
}

void ModifyPosition(const string obj, const string cmdId)
{
   long ticket = (long)JsonNumber(obj, "ticket");
   if(!posinfo.SelectByTicket(ticket))
   {
      AddResult(cmdId, "skipped", 0, 0, 0, "position not found");
      return;
   }
   double sl = JsonNumber(plan, "sl");
   double tp = JsonNumber(obj, "tp");
   bool ok = trade.PositionModify(ticket, sl, tp);
   AddResult(cmdId, ok ? "done" : "rejected", ticket, 0, 0,
             ok ? "" : trade.ResultRetcodeDescription());
}

void FlattenAll(const string reason)
{
   for(int i = 0; i < MAX_PLANS; i++) g_plans[i].active = false;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posinfo.SelectByIndex(i)) continue;
      if(posinfo.Magic() != MagicNumber) continue;
      trade.PositionClose(posinfo.Ticket());
   }
   Log("FLATTEN ALL: " + reason);
}

//+------------------------------------------------------------------+
//| Guards                                                           |
//+------------------------------------------------------------------+
bool TradingAllowed(const string sym)
{
   if(!g_tradingEnabled) return false;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return false;
   if(!SymbolInfoInteger(sym, SYMBOL_TRADE_MODE)) return false;

   // Real-money accounts need BOTH the server flag and the local input. Two
   // independent switches, because this is the one mistake that cannot be
   // undone.
   bool isLive = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL);
   if(isLive && (!AllowLiveAccount || !g_liveTradingEnabled)) return false;

   if(DailyLossBreached()) return false;
   return true;
}

bool DailyLossBreached()
{
   if(g_dayStartEquity <= 0) return false;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double lossPct = (g_dayStartEquity - equity) / g_dayStartEquity * 100.0;
   return (lossPct >= MaxDailyLossPct);
}

void ResetSeeding()
{
   for(int i = 0; i < MAX_SYMBOLS; i++)
      for(int t = 0; t < 7; t++)
         g_seeded[i][t] = false;
}

void ResetDayBaseline()
{
   g_dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   g_dayStamp = dt.day_of_year;
}

void RollDayBaselineIfNeeded()
{
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   if(dt.day_of_year != g_dayStamp) ResetDayBaseline();
}

bool RespectsStopLevel(const string sym, bool isBuy, double price, double sl)
{
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   long stops   = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   if(point <= 0 || stops <= 0) return true;
   return (MathAbs(price - sl) / point) >= (double)stops;
}

double NormaliseVolume(const string sym, double lots)
{
   double minv = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;

   // Floor, never round up: rounding up would exceed the risk the server sized.
   double normalised = MathFloor(lots / step + 1e-9) * step;
   if(normalised < minv) return 0;
   if(normalised > maxv) normalised = maxv;
   return NormalizeDouble(normalised, 2);
}

double AtrValue(const string sym, ENUM_TIMEFRAMES tf, int period)
{
   int handle = iATR(sym, tf, period);
   if(handle == INVALID_HANDLE) return 0;
   double buffer[];
   if(CopyBuffer(handle, 0, 0, 1, buffer) <= 0) return 0;
   return buffer[0];
}

bool FindPlanForSymbol(const string sym, ArmedPlan &out)
{
   for(int i = 0; i < MAX_PLANS; i++)
      if(g_plans[i].symbol == sym) { out = g_plans[i]; return true; }
   return false;
}

bool AlreadySeen(const string id)
{
   for(int i = 0; i < g_seenCount; i++)
      if(g_seenCmds[i] == id) return true;
   return false;
}

void MarkSeen(const string id)
{
   if(g_seenCount < MAX_SEEN_CMDS) { g_seenCmds[g_seenCount++] = id; return; }
   // Ring buffer: drop the oldest half rather than growing without bound.
   for(int i = 0; i < MAX_SEEN_CMDS / 2; i++)
      g_seenCmds[i] = g_seenCmds[i + MAX_SEEN_CMDS / 2];
   g_seenCount = MAX_SEEN_CMDS / 2;
   g_seenCmds[g_seenCount++] = id;
}

void AddResult(const string cmdId, const string status, long ticket,
               double price, double slip, const string err)
{
   if(g_results != "") g_results += ",";
   g_results += "{\"commandId\":\"" + cmdId + "\",\"status\":\"" + status +
                "\",\"ticket\":" + IntegerToString(ticket) +
                ",\"price\":" + DoubleToString(price, 8) +
                ",\"slippagePoints\":" + DoubleToString(slip, 2) +
                ",\"error\":" + (err == "" ? "null" : "\"" + JsonEscape(err) + "\"") +
                ",\"ts\":" + IntegerToString((long)TimeGMT() * 1000) + "}";
}

//+------------------------------------------------------------------+
//| Payload builders                                                 |
//+------------------------------------------------------------------+
string AccountJson()
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   bool   isLive = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL);
   bool   netting = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_NETTING);

   string json = "{";
   json += "\"balance\":"    + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":"     + DoubleToString(equity, 2) + ",";
   json += "\"margin\":"     + DoubleToString(margin, 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\",";
   json += "\"leverage\":"   + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"mode\":\""     + (netting ? "netting" : "hedging") + "\",";
   json += "\"isLive\":"     + (isLive ? "true" : "false");
   json += "}";
   return json;
}

string SpecsJson()
{
   string json = "[";
   for(int i = 0; i < g_symbolCount; i++)
   {
      string s = g_symbols[i];
      if(i > 0) json += ",";
      json += "{";
      json += "\"symbol\":\"" + s + "\",";
      json += "\"point\":"        + DoubleToString(SymbolInfoDouble(s, SYMBOL_POINT), 10) + ",";
      json += "\"digits\":"       + IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS)) + ",";
      json += "\"tickSize\":"     + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) + ",";
      // The LOSS-side tick value, in the account currency: size against the
      // worse of the two, and let MT5 do the FX conversion for us.
      json += "\"tickValue\":"    + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE_LOSS), 8) + ",";
      json += "\"contractSize\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 4) + ",";
      json += "\"volumeMin\":"    + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) + ",";
      json += "\"volumeMax\":"    + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 4) + ",";
      json += "\"volumeStep\":"   + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) + ",";
      json += "\"stopsLevel\":"   + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL)) + ",";
      json += "\"freezeLevel\":"  + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_FREEZE_LEVEL)) + ",";
      json += "\"marginInitial\":" + DoubleToString(SymbolInfoDouble(s, SYMBOL_MARGIN_INITIAL), 4) + ",";
      json += "\"swapLong\":"     + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_LONG), 4) + ",";
      json += "\"swapShort\":"    + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_SHORT), 4) + ",";
      json += "\"commissionPerLot\":0,";
      json += "\"spreadPoints\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_SPREAD)) + ",";
      json += "\"baseCurrency\":\""  + SymbolInfoString(s, SYMBOL_CURRENCY_BASE)   + "\",";
      json += "\"quoteCurrency\":\"" + SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT) + "\"";
      json += "}";
   }
   json += "]";
   return json;
}

string QuotesJson()
{
   string json = "[";
   bool first = true;
   for(int i = 0; i < g_symbolCount; i++)
   {
      MqlTick tick;
      if(!SymbolInfoTick(g_symbols[i], tick)) continue;
      if(!first) json += ",";
      first = false;
      json += "{\"symbol\":\"" + g_symbols[i] + "\",";
      json += "\"bid\":" + DoubleToString(tick.bid, 8) + ",";
      json += "\"ask\":" + DoubleToString(tick.ask, 8) + ",";
      json += "\"spreadPoints\":" + IntegerToString(SymbolInfoInteger(g_symbols[i], SYMBOL_SPREAD)) + ",";
      json += "\"ts\":" + IntegerToString((long)tick.time * 1000) + "}";
   }
   json += "]";
   return json;
}

string CandlesJson()
{
   string json = "[";
   bool first = true;

   for(int s = 0; s < g_symbolCount; s++)
   {
      for(int t = 0; t < 7; t++)
      {
         int want = g_seeded[s][t] ? MathMax(2, DeltaBars) : HistoryBars;

         MqlRates rates[];
         ArraySetAsSeries(rates, false);          // chronological, oldest first
         int copied = CopyRates(g_symbols[s], TF_LIST[t], 0, want, rates);
         if(copied <= 0) continue;
         g_seeded[s][t] = true;

         if(!first) json += ",";
         first = false;
         json += "{\"symbol\":\"" + g_symbols[s] + "\",\"timeframe\":\"" + TF_NAMES[t] + "\",\"bars\":[";
         for(int b = 0; b < copied; b++)
         {
            if(b > 0) json += ",";
            json += "[" + IntegerToString((long)rates[b].time * 1000) + "," +
                    DoubleToString(rates[b].open, 8)  + "," +
                    DoubleToString(rates[b].high, 8)  + "," +
                    DoubleToString(rates[b].low, 8)   + "," +
                    DoubleToString(rates[b].close, 8) + "," +
                    IntegerToString(rates[b].tick_volume) + "]";
         }
         json += "]}";
      }
   }
   json += "]";
   return json;
}

string PositionsJson()
{
   string json = "[";
   bool first = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posinfo.SelectByIndex(i)) continue;
      if(posinfo.Magic() != MagicNumber) continue;
      if(!first) json += ",";
      first = false;
      json += "{\"ticket\":"   + IntegerToString(posinfo.Ticket()) + ",";
      json += "\"symbol\":\""  + posinfo.Symbol() + "\",";
      json += "\"side\":\""    + (posinfo.PositionType() == POSITION_TYPE_BUY ? "buy" : "sell") + "\",";
      json += "\"volume\":"    + DoubleToString(posinfo.Volume(), 2) + ",";
      json += "\"openPrice\":" + DoubleToString(posinfo.PriceOpen(), 8) + ",";
      json += "\"openTime\":"  + IntegerToString((long)posinfo.Time() * 1000) + ",";
      json += "\"sl\":"        + DoubleToString(posinfo.StopLoss(), 8) + ",";
      json += "\"tp\":"        + DoubleToString(posinfo.TakeProfit(), 8) + ",";
      json += "\"profit\":"    + DoubleToString(posinfo.Profit(), 2) + ",";
      json += "\"swap\":"      + DoubleToString(posinfo.Swap(), 2) + ",";
      json += "\"commission\":" + DoubleToString(posinfo.Commission(), 2) + "}";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
//| Pairing                                                          |
//+------------------------------------------------------------------+
bool Pair()
{
   if(PairingCode == "")
   {
      Print("NeurotradeBridge: set the PairingCode input from the Desk page.");
      return false;
   }

   string body = "{\"pairingCode\":\"" + PairingCode + "\",\"terminal\":{";
   body += "\"login\":"    + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   body += "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER))  + "\",";
   body += "\"company\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
   body += "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\"}}";

   string response = "";
   if(!HttpPost("/api/bridge/pair", body, response, false)) return false;

   g_token = JsonString(response, "bridgeToken");
   if(g_token == "")
   {
      Print("NeurotradeBridge: server did not return a bridge token. ", response);
      return false;
   }
   g_lastOk = TimeCurrent();
   return true;
}

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
bool HttpPost(const string path, const string body, string &response, bool authenticated)
{
   string headers = "Content-Type: application/json\r\n";
   if(authenticated) headers += "Authorization: Bearer " + g_token + "\r\n";

   char post[], result[];
   StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   // StringToCharArray appends a terminating zero; sending it corrupts the
   // JSON body for strict parsers.
   ArrayResize(post, ArraySize(post) - 1);

   string resultHeaders = "";
   ResetLastError();
   int status = WebRequest("POST", ServerUrl + path, headers, 8000, post, result, resultHeaders);

   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4014)
         Print("NeurotradeBridge: WebRequest is not permitted. Add ", ServerUrl,
               " to Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL.");
      else
         Print("NeurotradeBridge: WebRequest failed, error ", err);
      return false;
   }

   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(status < 200 || status >= 300)
   {
      Print("NeurotradeBridge: HTTP ", status, " from ", path, " — ", response);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Minimal JSON readers                                             |
//|                                                                  |
//| Deliberately tiny: the payloads are generated by our own server  |
//| and are flat, so a full parser would be weight without benefit.  |
//+------------------------------------------------------------------+
string JsonString(const string json, const string key)
{
   string needle = "\"" + key + "\":\"";
   int start = StringFind(json, needle);
   if(start < 0) return "";
   start += StringLen(needle);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
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
   if(end == start) return 0;
   return StringToDouble(StringSubstr(json, start, end - start));
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
      bool numeric = (ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == 'e' || ch == 'E';
      if(!numeric) break;
      end++;
   }
   if(end == start) return 0;
   return StringToDouble(StringSubstr(json, start, end - start));
}

int JsonBool(const string json, const string key)
{
   string needle = "\"" + key + "\":";
   int start = StringFind(json, needle);
   if(start < 0) return -1;
   start += StringLen(needle);
   return (StringSubstr(json, start, 4) == "true") ? 1 : 0;
}

//
// Extracts a nested object: JsonObject(cmd, "plan") -> "{...}".
// Needed because an arm_plan command and the plan inside it BOTH have an "id",
// and a flat substring search would return the command's, leaving the EA
// unable to match a later cancel_plan.
string JsonObject(const string json, const string key)
{
   string needle = "\"" + key + "\":{";
   int start = StringFind(json, needle);
   if(start < 0) return "";
   start += StringLen(needle) - 1;      // land on the opening brace

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

string JsonEscape(const string text)
{
   string out = text;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\n", " ");
   StringReplace(out, "\r", " ");
   return out;
}

void SplitSymbols(const string csv)
{
   string parts[];
   int count = StringSplit(csv, ',', parts);
   g_symbolCount = 0;
   for(int i = 0; i < count && g_symbolCount < MAX_SYMBOLS; i++)
   {
      string s = parts[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s != "") g_symbols[g_symbolCount++] = s;
   }
}

void Log(const string message)
{
   if(VerboseLog) Print("NeurotradeBridge: ", message);
}
//+------------------------------------------------------------------+
