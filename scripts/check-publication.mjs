// A pre-publication hygiene check; not a complete secret detector.
// Deliberately prints locations/categories only, never matched values.
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['.git', 'node_modules', 'coverage']);
const forbiddenName = /^(?:\.env(?:\..+)?|state\.json(?:\..*)?|api-token\.txt|tokens?\.json|sync\.config\.json|local-settings\.json|instance\.json|launcher\.lock|.*credentials.*\.json)$|\.(?:log|pid|jsonl|db|sqlite\d*|pem|key|bak)$/i;
const forbiddenDir = /(?:^|\/)(?:runtime|data|logs|backups|work|context-management|\.comote)(?:\/|$)/i;
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['api-key', /\b(?:AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/],
  ['platform-identity', /\b(?:o[cu]_[a-f0-9]{20,}|cli_[a-f0-9]{12,})\b/i],
  ['personal-home-path', /[A-Z]:[\\/]+Users[\\/]+(?!example(?:[\\/]|$)|Public(?:[\\/]|$)|<)[^\\/\s"'<>]+/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['literal-credential', /(?:appSecret|app_secret|client_secret|apiKey|api_key|access_token|botToken|password)\s*[=:]\s*["'][A-Za-z0-9_+\/-]{24,}["']/i],
];

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files;
}

let files;
if (existsSync(resolve(root, '.git'))) {
  const result = spawnSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot read Git file list');
  files = result.stdout.split('\0').filter(Boolean);
  if (!files.length) throw new Error('No tracked files; stage the intended release before checking');
} else files = await walk(root);

let failures = 0;
for (const file of files) {
  const name = basename(file);
  if ((forbiddenName.test(name) && name !== '.env.example') || forbiddenDir.test(file)) {
    console.error(`${file}: forbidden-runtime-file`); failures++; continue;
  }
  const path = resolve(root, file);
  if ((await stat(path)).size > 2 * 1024 * 1024) {
    console.error(`${file}: unexpected-large-file`); failures++; continue;
  }
  const bytes = await readFile(path);
  if (bytes.includes(0) || bytes.includes(0xff)) {
    console.error(`${file}: unexpected-binary-file`); failures++; continue;
  }
  const lines = bytes.toString('utf8').split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    for (const [category, pattern] of patterns) {
      if (pattern.test(lines[line])) {
        console.error(`${file}:${line + 1}: ${category}`); failures++;
      }
    }
  }
}
if (failures) {
  console.error(`Publication check failed: ${failures} finding(s).`);
  process.exitCode = 1;
} else console.log(`Publication check passed: ${files.length} files; manually review new content too.`);
