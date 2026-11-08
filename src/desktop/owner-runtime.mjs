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
    try { process.kill(pid, 0); } catch { return; }
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 400));
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  } catch { /* no pid file */ }
}

export async function createOwnerRuntime({ hostId, codexHome = join(homedir(), '.codex'), dataDir = join(homedir(), '.config/codex-hub'), ownerOptions = {}, projects = () => localProjects(codexHome) }) {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  const socketPath = ownerOptions.socketPath ?? join(codexHome, 'ipc/ipc.sock');
  const sharedClient = () => socketPath === join(homedir(), '.codex', 'ipc/ipc.sock')
    ? desktopIpcPool.acquire() : new DesktopIpc({ socketPath, timeout: 1500 });
  const pidFile = join(dataDir, 'app-server.pid');
  await releaseStaleAppServer(pidFile);
  const owner = await new LocalOwner({ binary: process.env.CODEX_BIN || (existsSync(bundled) ? bundled : 'codex'), cwd: homedir(), ...ownerOptions, socketPath }).start();
  const childPid = owner.client?.child?.pid;
  if (Number.isInteger(childPid)) {
    await writeFile(pidFile, JSON.stringify({ pid: childPid, bridge: process.pid }), { mode: 0o600 }).catch(() => {});
    process.once('exit', () => { try { process.kill(childPid, 'SIGTERM'); } catch { /* already gone */ } });
  }
  let journal, modelJournal;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (existsSync(join(dataDir, 'model-writes.sqlite'))) throw new Error('Legacy model journal requires migration');
    journal = new CreationJournal(join(dataDir, 'creations.sqlite'));
    modelJournal = new ModelJournal(join(dataDir, 'creations.sqlite'));
    const discover = async threadId => {
      const ipc = sharedClient();
      try { await ipc.connect(); const { ownerId } = await ipc.discover(threadId); return { kind: 'owner', ownerId }; }
      catch { return { kind: 'unknown' }; }
      finally { ipc.close(); }
    };
    const verifyOwner = async (threadId, ownerId) => {
      const ipc = sharedClient();
      try { await ipc.connect(); return Boolean(await ipc.probeOwner(threadId, ownerId, { timeout: 2500 })); }
      catch { return false; }
      finally { ipc.close(); }
    };
    const router = new OwnerRouter({ discover, verifyOwner, localOwner: owner, projects, journal, hostId, competeUnknown: true,
      confirmRecovery: (threadId, ownerId) => confirmRecoverySnapshot(threadId, ownerId, { createClient: sharedClient }) });
    return { router, owner, modelJournal, async close() {
      router.beginShutdown();
      try { await owner.close(); } catch (error) { router.cancelShutdown(); throw error; }
      router.close(); journal.close(); modelJournal.close();
      await unlink(pidFile).catch(() => {});
    } };
  } catch (error) { modelJournal?.close(); journal?.close(); await owner.close({ force: true }); throw error; }
}
