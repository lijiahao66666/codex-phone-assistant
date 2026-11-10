import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function readWindowsProcessStartIdentity(pid) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$process = Get-Process -Id ${pid}`,
    '$start = $process.StartTime.ToUniversalTime().ToFileTimeUtc()',
    '[Console]::Out.Write(("{0}|{1}" -f $start, $process.ProcessName))',
  ].join('; ');
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000, maxBuffer: 8192, windowsHide: true });
  return stdout.trim();
}

// PID alone is insufficient: the operating system may reuse it after a crash.
// A failed inspection is unknown; only ESRCH establishes that it is absent.
export async function readProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new TypeError('invalid process identity');
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw error; }
  try {
    const identity = process.platform === 'win32'
      ? await readWindowsProcessStartIdentity(pid)
      : (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { timeout: 2000, maxBuffer: 8192 })).stdout.trim();
    if (identity) return identity;
  } catch (error) {
    try { process.kill(pid, 0); }
    catch (probe) { if (probe.code === 'ESRCH') return null; }
    throw error;
  }
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw error; }
  throw new Error('Process start identity unavailable');
}

export async function reconcileExitedRecoveryExecutions(journal, hostId, readIdentity = readProcessStartIdentity) {
  const retired = [];
  for (const execution of journal.recoveryExecutions(hostId)) {
    // Older rows cannot be attributed safely to an app-server execution.
    if (typeof execution.startedAt !== 'string' || !execution.startedAt) continue;
    let current;
    try { current = await readIdentity(execution.pid); } catch { continue; }
    if (current !== null && (typeof current !== 'string' || !current)) continue;
    if (current !== null && current === execution.startedAt) continue;
    retired.push(...journal.retireRecoveryExecution(hostId, execution));
  }
  return retired;
}
