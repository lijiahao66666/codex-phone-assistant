import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Use the native conversation route so Desktop establishes its IPC owner too.
// The background wake route only acquires the app-server writer.
export async function openDesktopThread(threadId, {
  platform = process.platform,
  execute = execFile,
} = {}) {
  if (typeof threadId !== 'string' || threadId.length !== 36 || !uuid.test(threadId)) {
    throw new TypeError('Invalid Desktop thread ID');
  }
  const uri = `codex://threads/${threadId}`;
  const options = { shell: false, timeout: 15_000, windowsHide: true };
  if (platform === 'darwin') {
    await execute('open', ['-g', uri], options);
  } else if (platform === 'win32') {
    // Only the validated UUID enters this fixed script; no shell or arbitrary
    // user text is interpreted. Windows resolves the installed URI handler.
    const script = `Start-Process -FilePath '${uri}'`;
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], options);
  } else if (platform === 'linux') {
    await execute('xdg-open', [uri], options);
  } else {
    throw new Error(`Desktop thread opening is unsupported on ${platform}`);
  }
  return uri;
}
