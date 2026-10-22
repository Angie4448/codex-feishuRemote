// Local metadata only. This fork must never recommend replacing itself with
// upstream Comote, and it does not poll GitHub or cache upstream release data.
export const REPOSITORY_URL = "https://github.com/Angie4448/codex-feishuRemote";

export function getVersionStatus(currentVersion = null) {
  return {
    current: currentVersion,
    latest: null,
    hasUpdate: false,
    updatesDisabled: true,
    updatePolicy: "manual",
    repositoryUrl: REPOSITORY_URL,
    releaseUrl: null,
    downloadUrl: null,
    updateCommand: null,
    platform: process.platform,
    checkedAt: null,
    error: null,
  };
}
