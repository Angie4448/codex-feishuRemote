import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

export const WINDOWS_IPC_ENDPOINT = '\\\\.\\pipe\\codex-ipc';

// Observed in Codex Desktop 26.1013.4894 app.asar:
// .vite/build/application-network-startup-DB1VeU3v.js, bn()/Fc().
// The non-Windows endpoint is CODEX_HOME (or ~/.codex)/ipc/ipc.sock.
// We deliberately do not probe legacy temporary-directory endpoints.
export function resolveDesktopIpcEndpoint({ endpoint, platform = process.platform,
  env = process.env, home = homedir() } = {}) {
  const configured = endpoint ?? env.COMOTE_CODEX_DESKTOP_IPC_ENDPOINT;
  let selected = configured;
  if (selected == null || selected === '') {
    if (platform === 'win32') selected = WINDOWS_IPC_ENDPOINT;
    else if (platform === 'darwin' || platform === 'linux') {
      const codexHome = env.CODEX_HOME || posix.join(home, '.codex');
      if (!posix.isAbsolute(codexHome)) throw new Error('CODEX_HOME must be an absolute local path for desktop IPC');
      selected = posix.join(codexHome, 'ipc', 'ipc.sock');
    } else throw new Error(`Desktop IPC is not supported on platform: ${platform}`);
  }
  assertEndpointPath(selected, platform);
  return selected;
}

function assertEndpointPath(endpoint, platform) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.includes('\0')) {
    throw new Error('Desktop IPC endpoint must be a nonempty local path without NUL bytes');
  }
  if (platform === 'win32') {
    if (!/^\\\\\.\\pipe\\[^\\/]+$/i.test(endpoint)) {
      throw new Error('Windows desktop IPC requires a local named pipe under \\\\.\\pipe\\');
    }
    return;
  }
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`Desktop IPC is not supported on platform: ${platform}`);
  if (!posix.isAbsolute(endpoint) || endpoint.startsWith('//') || endpoint.split('/').includes('..')) {
    throw new Error('Desktop IPC requires an absolute local Unix socket path without parent traversal');
  }
  // sun_path includes a terminating NUL: macOS has room for 103 path bytes.
  const maxBytes = platform === 'darwin' ? 103 : 107;
  if (Buffer.byteLength(endpoint, 'utf8') > maxBytes) {
    throw new Error(`Desktop IPC socket path exceeds the ${maxBytes}-byte limit`);
  }
}

export function validateDesktopIpcEndpoint(endpoint, { platform = process.platform,
  uid = process.getuid?.(), lstat = lstatSync } = {}) {
  assertEndpointPath(endpoint, platform);
  if (platform === 'win32') return endpoint;
  if (!Number.isInteger(uid) || uid < 0) throw new Error('Cannot verify the current user for the desktop IPC socket');
  let socket;
  let directory;
  try {
    socket = lstat(endpoint);
    directory = lstat(posix.dirname(endpoint));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Desktop IPC socket not found. Open Codex Desktop as the same user, or set --ipc-socket to its verified socket path.');
    }
    throw new Error('Cannot inspect desktop IPC socket ownership and permissions', { cause: error });
  }
  // lstat prevents a symlink from being accepted as a socket or its directory.
  if (!socket.isSocket() || socket.isSymbolicLink?.()) throw new Error('Desktop IPC endpoint is not a Unix socket');
  if (!directory.isDirectory() || directory.isSymbolicLink?.()) throw new Error('Desktop IPC parent must be a real directory');
  if (socket.uid !== uid || directory.uid !== uid) throw new Error('Desktop IPC socket and its parent must be owned by the current user');
  if ((directory.mode & 0o022) !== 0) throw new Error('Desktop IPC parent directory must not be writable by other users');
  if ((socket.mode & 0o077) !== 0 || (socket.mode & 0o200) === 0) {
    throw new Error('Desktop IPC socket requires private owner permissions (normally 0600)');
  }
  return endpoint;
}
