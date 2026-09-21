import { z } from "zod";
import { OMNI_CONTRACT_TYPES } from "./omni-analysis";

/** No client-supplied probabilities, fitted parameters, payouts, digits or recovery overrides. */
export const omniConfigSchema = z
  .object({
    enabledContracts: z
      .array(z.enum(OMNI_CONTRACT_TYPES))
      .min(1, "Enable at least one contract")
      .max(8)
      .refine(
        (xs) => new Set(xs).size === xs.length,
        "Duplicate contracts are not allowed",
      )
      .transform((xs) => OMNI_CONTRACT_TYPES.filter((t) => xs.includes(t))),
    stake: z
      .number()
      .finite()
      .min(0.35)
      .max(1_000_000)
      .refine(
        (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-7,
        "Stake must use whole cents",
      ),
    stopLoss: z.number().finite().min(0.35).max(1_000_000),
    takeProfit: z.number().finite().positive().max(1_000_000),
    marketMode: z.enum(["locked", "switching"]),
    executionMode: z.enum(["paper", "live"]),
  })
  .strict()
  .refine(
    (v) => v.stake <= v.stopLoss,
    "Base stake must fit the session stop loss",
  );
export type OmniConfig = z.infer<typeof omniConfigSchema>;
/** Public scans/deployments only execute on the connected (demo or real) account.
 * Internal paper execution remains only as a deterministic engine test harness. */
export const omniConnectedConfigSchema = omniConfigSchema.refine(
  (config) => config.executionMode === "live",
  "Omni Sentinel trades the connected account; paper mode is not available",
);
export const omniStartSchema = z
  .object({
    config: omniConnectedConfigSchema,
    scanId: z.string().uuid(),
    symbol: z.string().min(1).max(40),
    acknowledgeLiveRisk: z.boolean().optional(),
  })
  .strict();

export function omniConfigKey(config: OmniConfig): string {
  // The scan measures ALL markets with the same models regardless of the
  // eventual deployment mode. Only lock/switch may change after the scan;
  // contract permissions, risk and execution mode remain bound to its token.
  const { marketMode: _deploymentChoice, ...scannedConfig } = config;
  return JSON.stringify({
    ...scannedConfig,
    enabledContracts: [...config.enabledContracts].sort(),
  });
}
