#!/usr/bin/env node
// A non-secret per-launch cookie stays in the OS command line for ownership
// checks. The server still enforces its own explicit configuration guard.
if (process.argv.length !== 3 || !/^--launcher-instance=[0-9a-f-]{36}$/.test(process.argv[2])) {
  console.error('Start this daemon with start-macos.sh. Arbitrary arguments are not accepted.');
  process.exitCode = 2;
} else {
  await import('../src/server/index.js');
}
