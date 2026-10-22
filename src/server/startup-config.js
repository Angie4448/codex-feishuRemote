import { isAbsolute } from "node:path";

// Validate before loading any persisted state or opening an IPC/IM connection.
// A direct invocation must not fall back to an existing upstream Comote profile.
export function assertDesktopSyncEnvironment(env = process.env) {
  const missing = [];
  if (env.COMOTE_CODEX_DESKTOP_IPC !== "1") missing.push("COMOTE_CODEX_DESKTOP_IPC=1");
  if (!String(env.COMOTE_CODEX_DESKTOP_IPC_THREAD_ID ?? "").trim()) missing.push("COMOTE_CODEX_DESKTOP_IPC_THREAD_ID");
  if (!env.COMOTE_STATE_PATH || !isAbsolute(env.COMOTE_STATE_PATH)) missing.push("an absolute COMOTE_STATE_PATH");
  if (!String(env.COMOTE_LOCAL_API_TOKEN ?? "").trim()) missing.push("COMOTE_LOCAL_API_TOKEN");
  if (missing.length) {
    throw new Error(`Required configuration: ${missing.join(", ")}. Use this project's Start-Sync.ps1 (Windows) or start-macos.sh (macOS) with a configured desktop thread.`);
  }
}
