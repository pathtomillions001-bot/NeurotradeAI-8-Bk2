/// <reference types="vite/client" />

declare module "virtual:neurotrade-release" {
  const release: import("@workspace/deployment-contract").DeploymentRelease;
  export default release;
}
