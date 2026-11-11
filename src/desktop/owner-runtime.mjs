import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LocalOwner } from './local-owner.mjs';
import { OwnerRouter } from './owner-router.mjs';
import { CreationJournal } from './creation-journal.mjs';
import { ModelJournal } from './model-journal.mjs';
import { DesktopIpc } from './ipc.mjs';
import { desktopIpcPool } from './ipc-pool.mjs';
import { DesktopSession } from './session.mjs';
import { readProcessStartIdentity, reconcileExitedRecoveryExecutions } from './recovery-execution.mjs';
import { createCreatedThreadOwner } from './created-thread-owner.mjs';
import { openDesktopThread } from './open-thread.mjs';

export async function confirmRecoverySnapshot(threadId, ownerId, { socketPath, timeoutMs = 15000, createSession, createClient } = {}) {
  const session = createSession ? createSession(threadId) : new DesktopSession({ conversationId: threadId,
    createClient: createClient || (() => socketPath ? new DesktopIpc({ socketPath }) : desktopIpcPool.acquire()) });
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      session.on('state', state => {
        if (state.status !== 'ready') return;
        const valid = session.conversation?.ownerId === ownerId && session.value?.id === threadId && Number.isSafeInteger(session.revision);
        clearTimeout(timer); resolve(valid);
      });
      try { session.start(); } catch { clearTimeout(timer); resolve(false); }
    });
  } finally { await session.close(); }
}

export async function localProjects(codexHome = join(homedir(), '.codex')) {
  const state = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'));
  return Object.values(state['local-projects'] || {}).flatMap(project => {
    const roots = project?.rootPaths;
    return typeof project?.id === 'string' && Array.isArray(roots) && roots.length > 0 && roots.every(root => typeof root === 'string' && isAbsolute(root))
      ? [{ id: project.id, cwd: roots[0], runtimeWorkspaceRoots: roots }] : [];
  });
}

export async function discoverDesktopOwner(threadId, createClient) {
  const ipc = createClient();
  let connected = false;
  try {
    await ipc.connect(); connected = true;
    const { ownerId } = await ipc.discover(threadId);
    return { kind: 'owner', ownerId };
  } catch (error) {
    // An absent/refused local socket preserves the desktop-offline path. A
    // handshake timeout, unanswered discovery or broken bus proves no absence.
    const offline = !connected && ['ENOENT', 'ECONNREFUSED'].includes(error?.code);
    if (!offline && !(connected && error?.code === 'no-client-found')) throw error;
    return { kind: 'unknown' };
  } finally { await ipc.close(); }
}

// A bridge that dies without reaping its app-server leaves an orphan holding the
// thread writers. Every later resume then fails with "already has an active
// writer" and the phone can never take a task over again.
async function releaseStaleAppServer(pidFile) {
  try {
    const raw = await readFile(pidFile, 'utf8');
    let entry;
    try { entry = JSON.parse(raw); } catch { entry = { pid: Number(raw) }; }
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    if (Number(entry?.bridge) === process.pid) return;
    // Legacy PID-only records cannot distinguish an orphan from PID reuse.
    if (typeof entry.startedAt !== 'string' || !entry.startedAt || await readProcessStartIdentity(pid) !== entry.startedAt) return;
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await readProcessStartIdentity(pid) === entry.startedAt) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* no pid file */ }
}

export async function createOwnerRuntime({ hostId, codexHome = join(homedir(), '.codex'), dataDir = join(homedir(), '.config/codex-hub'), ownerOptions = {}, projects = () => localProjects(codexHome), openCreatedThread }) {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  const defaultSocketPath = process.platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : join(codexHome, 'ipc/ipc.sock');
  const socketPath = ownerOptions.socketPath ?? defaultSocketPath;
  const sharedClient = () => socketPath === defaultSocketPath
    ? desktopIpcPool.acquire() : new DesktopIpc({ socketPath, timeout: 1500 });
  const pidFile = join(dataDir, 'app-server.pid');
  await releaseStaleAppServer(pidFile);
  const owner = new LocalOwner({ binary: process.env.CODEX_BIN || (existsSync(bundled) ? bundled : 'codex'), cwd: homedir(), ...ownerOptions, socketPath });
  // start() creates its exact child synchronously before awaiting initialize.
  // A helper exiting while startup is stalled must not leave that child behind.
  const starting = owner.start();
  const child = owner.client?.child;
  const killChildOnExit = () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch { /* The exact assistant child already exited. */ }
  };
  if (child) {
    process.once('exit', killChildOnExit);
    child.once('exit', () => process.off('exit', killChildOnExit));
  }
  try { await starting; }
  catch (error) {
    if (!child || child.exitCode !== null || child.signalCode !== null) process.off('exit', killChildOnExit);
    throw error;
  }
  const childPid = owner.client?.child?.pid;
  const recoveryExecution = Number.isInteger(childPid) ? {
    instanceId: owner.client.instanceId, pid: childPid,
    startedAt: await readProcessStartIdentity(childPid).catch(() => null),
  } : null;
  if (Number.isInteger(childPid)) {
    await writeFile(pidFile, JSON.stringify({ pid: childPid, bridge: process.pid, instanceId: recoveryExecution.instanceId, startedAt: recoveryExecution.startedAt }), { mode: 0o600 }).catch(() => {});
  }
  let journal, modelJournal;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (existsSync(join(dataDir, 'model-writes.sqlite'))) throw new Error('Legacy model journal requires migration');
    journal = new CreationJournal(join(dataDir, 'creations.sqlite'));
    await reconcileExitedRecoveryExecutions(journal, hostId);
    modelJournal = new ModelJournal(join(dataDir, 'creations.sqlite'));
    const discover = threadId => discoverDesktopOwner(threadId, sharedClient);
    const verifyOwner = async (threadId, ownerId) => {
      const ipc = sharedClient();
      try { await ipc.connect(); return Boolean(await ipc.probeOwner(threadId, ownerId, { timeout: 2500 })); }
      catch { return false; }
      finally { ipc.close(); }
    };
    // Isolated/custom IPC runtimes have no native Desktop to open. Production
    // uses the installed protocol handler; tests can supply an isolated opener.
    const opener = openCreatedThread ?? (socketPath === defaultSocketPath ? openDesktopThread : null);
    const createdThreadOwner = opener ? createCreatedThreadOwner({ localOwner: owner, openThread: opener, createClient: sharedClient }) : null;
    const router = new OwnerRouter({ discover, verifyOwner, localOwner: owner, createdThreadOwner, historicalThreadOwner: createdThreadOwner, projects, journal, hostId, recoveryExecution, competeUnknown: true,
      confirmRecovery: (threadId, ownerId) => confirmRecoverySnapshot(threadId, ownerId, { createClient: sharedClient }) });
    let childExited = false, resolveChildExit;
    const childExit = new Promise(resolve => { resolveChildExit = resolve; });
    const onChildExit = () => {
      childExited = true;
      if (recoveryExecution) {
        try {
          if (router.closed) journal.retireRecoveryExecution(hostId, recoveryExecution);
          else router.recoveryExecutionExited(recoveryExecution);
        } catch { /* Preserve reservations if journal settlement fails. */ }
      }
      resolveChildExit();
    };
    owner.client.child.once('exit', onChildExit);
    if (owner.client.child.exitCode !== null || owner.client.child.signalCode !== null) onChildExit();
    let cleanupPromise, forceClosePromise;
    const cleanup = () => cleanupPromise ??= (async () => {
      // Cancelled operations may still finish a journal transition after their
      // awaited child request rejects. Keep SQLite alive until they settle.
      await router.whenIdle();
      await childExit;
      await new Promise(resolve => setImmediate(resolve));
      owner.client.child.off('exit', onChildExit);
      journal.close(); modelJournal.close();
      await unlink(pidFile).catch(() => {});
    })();
    const confirmChildExit = async () => {
      if (childExited) return;
      let timer;
      try {
        await Promise.race([childExit, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Assistant app-server exit was not confirmed')), 1000);
        })]);
      } finally { clearTimeout(timer); }
    };
    return { router, owner, modelJournal, async close({ force = false } = {}) {
      if (forceClosePromise) return forceClosePromise;
      if (force) {
        forceClosePromise = (async () => {
          router.close();
          await owner.close({ force: true });
          await confirmChildExit();
          const cleaning = cleanup();
          if (!router.inFlight) await cleaning;
          else void cleaning.catch(() => {});
        })();
        return forceClosePromise;
      }
      router.beginShutdown();
      try { await owner.close(); } catch (error) { router.cancelShutdown(); throw error; }
      router.close();
      await confirmChildExit();
      await cleanup();
    } };
  } catch (error) { modelJournal?.close(); journal?.close(); await owner.close({ force: true }); throw error; }
}
