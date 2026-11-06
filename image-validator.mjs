import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

// The helper is supplied by the Mac application bundle, not chosen by a client.
export function validateImage(path, { helperPath, timeoutMs = 8000 } = {}) {
  if (!isAbsolute(path ?? '') || !isAbsolute(helperPath ?? '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid image validation request');
  return runHelper([path], { helperPath, timeoutMs, fd: 'ignore' });
}

export function validateImageFile(file, { helperPath, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(file?.fd) || file.fd < 0 || !isAbsolute(helperPath ?? '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid image validation request');
  return runHelper(['--fd3'], { helperPath, timeoutMs, fd: file.fd });
}

function runHelper(args, { helperPath, timeoutMs, fd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'ignore', fd] });
    let output = '', timedOut = false, tooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024) { tooLarge = true; child.kill('SIGKILL'); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || tooLarge || code !== 0) return reject(new Error('Image validation failed'));
      try {
        const result = JSON.parse(output);
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.mime) || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192 || result.width * result.height > 16000000) throw new Error();
        resolve(result);
      } catch { reject(new Error('Invalid image validation result')); }
    });
  });
}
