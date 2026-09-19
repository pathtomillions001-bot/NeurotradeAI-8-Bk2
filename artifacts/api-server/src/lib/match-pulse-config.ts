/** Strict hand-written boundary, matching the other /bots routes. */
export interface PulseScanConfig {
  executionMode: "paper" | "live";
  lockedDigit?: number;
}
export interface PulseConfig extends PulseScanConfig {
  scanId: string;
  selectedSymbol: string;
  marketMode: "locked" | "switching";
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  maxConsecutiveLosses: number;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A JSON object is required");
  return input as Record<string, unknown>;
}
function scanFields(body: Record<string, unknown>): PulseScanConfig {
  const executionMode = body.executionMode ?? "paper";
  if (executionMode !== "paper" && executionMode !== "live") throw new Error("executionMode must be paper or live");
  const digit = body.lockedDigit;
  if (digit !== undefined && digit !== null && (typeof digit !== "number" || !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new Error("lockedDigit must be an integer from 0 to 9, or null for auto");
  }
  return { executionMode, lockedDigit: digit == null ? undefined : digit as number };
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
}
export function parsePulseScan(input: unknown): PulseScanConfig {
  const body = object(input);
  onlyKeys(body, ["executionMode", "lockedDigit"]);
  return scanFields(body);
}
export function parsePulseConfig(input: unknown): PulseConfig {
  const body = object(input);
  onlyKeys(body, ["executionMode", "lockedDigit", "scanId", "selectedSymbol", "marketMode", "stake", "stopLoss", "takeProfit", "maxRecoverySteps", "maxConsecutiveLosses"]);
  const spec = scanFields(body);
  if (typeof body.scanId !== "string" || !/^[a-f\d-]{36}$/i.test(body.scanId)) throw new Error("Run a fresh server scan before deploying");
  if (typeof body.selectedSymbol !== "string" || !body.selectedSymbol) throw new Error("Choose a scanned market");
  if (body.marketMode !== "locked" && body.marketMode !== "switching") throw new Error("marketMode must be locked or switching");
  const money = (key: string): number => {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.35 || value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      throw new Error(`${key} must be a finite amount from 0.35 to 1000000, with at most two decimals`);
    }
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = body[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  const stake = money("stake");
  const stopLoss = money("stopLoss");
  if (stake > stopLoss) throw new Error("The base stake cannot exceed the session stop loss");
  return { ...spec, scanId: body.scanId, selectedSymbol: body.selectedSymbol, marketMode: body.marketMode,
    stake, stopLoss, takeProfit: money("takeProfit"),
    maxRecoverySteps: integer("maxRecoverySteps", 3, 1, 10),
    maxConsecutiveLosses: integer("maxConsecutiveLosses", 6, 3, 20) };
}


/** Public console policy: broker orders on the selected Deriv account, AI digits.
 * "live" is the transport, not the account type: demo accounts also use Deriv.
 * The internal paper/digit fixtures stay available to offline engine tests only.
 */
export function parsePulseAccountScan(input: unknown): PulseScanConfig {
  const body = object(input);
  onlyKeys(body, []);
  return { executionMode: "live" };
}
export function parsePulseAccountConfig(input: unknown): PulseConfig {
  const body = object(input);
  onlyKeys(body, ["scanId", "selectedSymbol", "marketMode", "stake", "stopLoss", "takeProfit", "maxRecoverySteps", "maxConsecutiveLosses"]);
  return parsePulseConfig({ ...body, executionMode: "live" });
}
