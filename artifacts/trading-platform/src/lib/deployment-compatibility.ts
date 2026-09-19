import {
  BOT_CONSOLE_CONTRACT_VERSION,
  type DeploymentRelease,
} from "@workspace/deployment-contract";

export interface BotCatalogueDeployment {
  botConsoleContract?: string;
  release?: Partial<DeploymentRelease> | null;
}

/**
 * Refuse specialist controls when the browser and API disagree about their
 * protocol. That is safer than sending accumulator/twin/pulse settings through
 * the generic bot endpoints, which is exactly what a stale production bundle
 * did before this guard existed.
 */
export function botDeploymentIssue(
  catalogue: BotCatalogueDeployment | null | undefined,
): string | null {
  if (!catalogue) return null;

  const apiContract =
    catalogue.botConsoleContract ?? catalogue.release?.botConsoleContract;
  if (!apiContract) {
    return "The API did not identify its bot-console contract. Production is running an older service release.";
  }
  if (apiContract !== BOT_CONSOLE_CONTRACT_VERSION) {
    return `Web/API bot-console mismatch (${BOT_CONSOLE_CONTRACT_VERSION} vs ${apiContract}).`;
  }
  return null;
}

export function shortCommit(commit: string | undefined): string {
  if (!commit) return "unknown";
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}
