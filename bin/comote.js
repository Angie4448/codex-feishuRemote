#!/usr/bin/env node
// Restricted entrypoint for the desktop-sync distribution. Do not import the
// upstream CLI dispatcher: its offline commands can touch a ~/.comote profile.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv.length === 0 || (argv.length === 1 && ["daemon", "serve"].includes(argv[0]))) {
  await import("../src/server/index.js");
} else if (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0])) {
  console.log("Codex desktop / Feishu same-thread sync\n\nStart:  Start-Sync.ps1\nManage: Open-Settings.ps1\nStop:   Stop-Sync.ps1\n\nAllowed commands: daemon, serve, help, --version, update [--json]\nDaemon startup requires explicit IPC, thread, state-path and token configuration.");
} else if (argv.length === 1 && ["version", "--version", "-v"].includes(argv[0])) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
} else if (argv[0] === "update" && argv.slice(1).every(flag => ["--json", "--plain", "--no-color"].includes(flag))) {
  const { run } = await import("../src/cli/commands/update.js");
  process.exitCode = await run({
    parsed: { flags: { json: argv.includes("--json"), plain: argv.includes("--plain"), color: !argv.includes("--no-color") } },
    env: process.env,
    write: text => process.stdout.write(text),
  });
} else {
  // Do not echo arbitrary arguments; they may contain credentials or paths.
  console.error("Legacy Comote CLI commands are disabled in this build. Use Start-Sync.ps1 to start and Open-Settings.ps1 to manage desktop sync. No runtime state was read.");
  process.exitCode = 2;
}
