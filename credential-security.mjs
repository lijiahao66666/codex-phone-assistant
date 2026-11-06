import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

export function isCredentialStatSecure(info) {
  if (!info.isFile()) return false;
  if (process.platform === 'win32') return true;
  return (!process.getuid || info.uid === process.getuid()) && !(info.mode & 0o077);
}

export function isPrivateDirectoryStat(info) {
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (process.platform === 'win32') return true;
  return (!process.getuid || info.uid === process.getuid()) && !(info.mode & 0o077);
}

export function hardenPrivatePath(path) {
  if (process.platform !== 'win32') return;
  const account = userInfo().username;
  if (!account) throw new Error('Windows user identity unavailable');
  const result = spawnSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${account}:F`], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) throw new Error('Unable to secure credential path');
}
