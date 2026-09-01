/**
 * Production safety gate for real-money Deriv execution.
 *
 * Live trading is opt-in. Keeping the default closed means a fresh deployment
 * can be smoke-tested with simulated trades even if an account token is later
 * connected. Set LIVE_TRADING_ENABLED=true only after production checks and
 * risk controls have been verified.
 */
export function isLiveTradingEnabled(): boolean {
  const value = process.env.LIVE_TRADING_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}
