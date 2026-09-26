/** Bot Arena badge is reserved for consoles that actually expose Create DBot. */
export function hasCreateDbotScanner(bot: { console?: string }): boolean {
  // Over/Under Turbo has both its own scanner and a Create DBot handoff.
  // Other specialist/Omni bots can scan to deploy directly, but have NO
  // Create DBot button, so labeling them "Scanner" would be misleading.
  return bot.console === "overunder-turbo@2";
}

/** The standalone Digit 4/5 scanner has a Create DBot action, but does not
 * belong to the deployable /api/bots catalogue: scanning NEVER buys anything. */
export const DIGIT45_SCANNER_PATH = "/scanners/digit-45";
