import {
  BOT_CONSOLE_CONTRACT_VERSION,
  type DeploymentRelease,
} from "@workspace/deployment-contract";

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

/** Public, non-secret build provenance returned by health/catalogue endpoints. */
export const deploymentRelease: DeploymentRelease = Object.freeze({
  commit:
    firstNonEmpty(
      process.env["RAILWAY_GIT_COMMIT_SHA"],
      process.env["GITHUB_SHA"],
      process.env["GIT_COMMIT_SHA"],
    ) ?? "development",
  service:
    firstNonEmpty(
      process.env["RAILWAY_SERVICE_NAME"],
      process.env["SERVICE_NAME"],
    ) ?? "api-server",
  botConsoleContract: BOT_CONSOLE_CONTRACT_VERSION,
});
