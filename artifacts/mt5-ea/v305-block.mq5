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
   int             partialCount;
   double          partialAtR[4];
   double          partialPct[4];
   bool            trailEnabled;
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
//| State array plumbing                                             |
//+------------------------------------------------------------------+
int PsIndex(const ulong ticket)
{
   for(int i = 0; i < g_psCount; i++)
      if(g_ps[i].ticket == ticket) return i;
   return -1;
}

int PsEnsure(const ulong ticket)
{
   int index = PsIndex(ticket);
   if(index >= 0) return index;
   if(g_psCount >= MAX_POS_STATES) return -1;
   PositionState blank;
   blank.ticket = ticket;
   blank.stage = "OPEN_RISK";
   blank.beTriggerR = 0;
   blank.trailMult = 0;
   blank.beStructure = true;
   blank.trailPeriod = 14;
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
   ArrayResize(f, 29);
   f[0]  = "v1";
   f[1]  = IntegerToString((long)ps.ticket);
   f[2]  = ps.planId;
   f[3]  = ps.symbol;
   f[4]  = ps.isBuy ? "b" : "s";
   f[5]  = (ps.mode == 0 ? "S" : (ps.mode == 1 ? "I" : "G"));
   f[6]  = TF_NAMES[ps.entryTfIndex];
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
   string out = f[0];
   for(int i = 1; i < 29; i++) out += "|" + f[i];
   return out;
}

bool PsDecode(const string text, PositionState &ps)
{
   string f[];
   int n = StringSplit(text, '|', f);
   if(n != 29) return false;
   if(f[0] != "v1") return false;
   ps.ticket         = (ulong)StringToInteger(f[1]);
   ps.planId         = f[2];
   ps.symbol         = f[3];
   ps.isBuy          = (f[4] == "b");
   ps.mode           = (f[5] == "S" ? 0 : (f[5] == "I" ? 1 : 2));
   ps.entryTfIndex   = TfIndexFromName(f[6]);
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
   ENUM_TIMEFRAMES tf = TF_LIST[ps.entryTfIndex];

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
                                         ps.barsSinceEntry, TF_NAMES[ps.entryTfIndex], ps.progressR, ps.mfeR);
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
      bool confirmed = !ps.beStructure || PmStructureConfirmed(symbol, tf, isBuy, ps.entry);
      if(confirmed)
      {
         double offset = ps.costPrice + PM_BREAKEVEN_PROFIT_R * ps.riskPrice;
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
                       StringFormat("+%.2fR with structure confirmed → stop %.5f (entry + cost + %.2fR)",
                                    ps.progressR, candidate, PM_BREAKEVEN_PROFIT_R));
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

   // ── 5. Trailing stop (ENTRY timeframe ATR, chandelier) ────────────────────
   if(ps.trailEnabled && !modifyDone && ps.progressR >= ps.trailActivateR && atr > 0)
   {
      double mult = ps.trailMult > 0 ? ps.trailMult : (ps.mode == 0 ? PM_TRAIL_MULT_SCALP :
                                                      (ps.mode == 1 ? PM_TRAIL_MULT_INTRADAY : PM_TRAIL_MULT_SWING));
      double best = ps.bestPrice > 0 ? ps.bestPrice : exitPrice;
      double candidate = isBuy ? best - mult * atr : best + mult * atr;
      double minStep = MathMax(ps.trailStepPoints * point, PM_TRAIL_MIN_STEP_ATR * atr);
      double improvement = isBuy ? (candidate - currentSl) : (currentSl - candidate);
      bool cooling = (NowUtcMs() - ps.lastModifyAt) < PM_MODIFY_COOLDOWN_MS;
      bool meaningful = (ps.progressR - ps.lastModifyR) >= PM_MODIFY_COOLDOWN_R;
      if(improvement >= minStep)
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
               PmEvent(ticket, "trail",
                       StringFormat("chandelier: best %.5f − %.1fxATR(%d,%s) = %.5f",
                                    best, mult, ps.trailPeriod, TF_NAMES[ps.entryTfIndex], candidate));
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
   ps.beTriggerR = 1.0;
   ps.beOffsetR = PM_BREAKEVEN_PROFIT_R;
   ps.beStructure = true;
   ps.partialCount = 0;
   ps.trailEnabled = true;
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
   ps.partialCount = (int)MathMin(4, MathMax(0, plan.partialCount));
   for(int i = 0; i < ps.partialCount; i++)
   {
      ps.partialAtR[i] = plan.partialAtR[i];
      ps.partialPct[i] = plan.partialPct[i];
   }
   ps.trailEnabled = plan.trailEnabled;
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
                           ps.entry, ps.initialSl, ps.riskPrice, TF_NAMES[ps.entryTfIndex]));
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

