import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { OwnerRouter } from '../src/desktop/owner-router.mjs';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { readProcessStartIdentity, reconcileExitedRecoveryExecutions } from '../src/desktop/recovery-execution.mjs';

const host = randomUUID(), device = randomUUID();
function reserve(journal, execution, threadId = randomUUID(), requestId = randomUUID()) {
  journal.beginRecoveryAttempt(host, device, threadId, requestId);
  assert.equal(journal.dispatchRecovery(host, device, threadId, requestId, execution), true);
  return { threadId, requestId };
}
async function childExecution() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const execution = { instanceId: randomUUID(), pid: child.pid, startedAt: await readProcessStartIdentity(child.pid) };
  return { child, execution, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  } };
}

test('a restart settles only recoveries whose recorded child execution exited', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-recovery-execution-'));
  const path = join(directory, 'journal.sqlite');
  const process = await childExecution();
  let journal = new CreationJournal(path);
  try {
    const pending = reserve(journal, process.execution);
    const accepted = reserve(journal, process.execution);
    assert.equal(journal.completeRecovery(host, device, accepted.threadId, accepted.requestId, 'accepted'), true);
    const legacy = reserve(journal, null);
    journal.close(); journal = new CreationJournal(path);
    assert.deepEqual(await reconcileExitedRecoveryExecutions(journal, host), []);
    assert.equal(journal.recoveryPending(host, pending.threadId), true);
    assert.equal(journal.recoveryAttempt(host, device, accepted.threadId, accepted.requestId), 'accepted');
    await process.close();
    assert.equal(await readProcessStartIdentity(process.execution.pid), null);
    journal.close(); journal = new CreationJournal(path);
    assert.deepEqual(await reconcileExitedRecoveryExecutions(journal, host), [{ threadId: pending.threadId, attemptId: pending.requestId }]);
    assert.equal(journal.recoveryAttempt(host, device, pending.threadId, pending.requestId), 'rejected');
    assert.equal(journal.recoveryAttempt(host, device, accepted.threadId, accepted.requestId), 'released');
    assert.equal(journal.recoveryPending(host, pending.threadId), false);
    assert.equal(journal.recoveryPending(host, legacy.threadId), true);
  } finally { journal.close(); await process.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed process inspection and an unattributed execution cannot release a reservation', async () => {
  const journal = new CreationJournal(':memory:');
  try {
    const execution = { instanceId: randomUUID(), pid: 12345, startedAt: 'recorded-start' };
    const pending = reserve(journal, execution);
    const unidentifiable = reserve(journal, { ...execution, instanceId: randomUUID(), startedAt: null });
    assert.deepEqual(await reconcileExitedRecoveryExecutions(journal, host, async () => { throw new Error('permission denied'); }), []);
    assert.deepEqual(await reconcileExitedRecoveryExecutions(journal, host, async () => undefined), []);
    assert.equal(journal.recoveryPending(host, pending.threadId), true);
    assert.deepEqual(await reconcileExitedRecoveryExecutions(journal, host, async () => 'different-start'), [{ threadId: pending.threadId, attemptId: pending.requestId }]);
    assert.equal(journal.recoveryPending(host, unidentifiable.threadId), true);
  } finally { journal.close(); }
});

test('runtime observes its isolated app-server exit and settles only that instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-recovery-runtime-'));
  const source = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(value.method==='initialize')process.stdout.write(JSON.stringify({id:value.id,result:{}})+'\\n');});`;
  let runtime;
  try {
    runtime = await createOwnerRuntime({ hostId: host, codexHome: directory, dataDir: directory, projects: async () => [],
      ownerOptions: { binary: process.execPath, args: ['-e', source], cwd: directory, timeout: 60, socketPath: join(directory, 'isolated.sock') } });
    runtime.router.discover = async () => ({ kind: 'unknown' });
    const threadId = randomUUID(), requestId = randomUUID();
    runtime.router.journal.beginRecoveryAttempt(host, device, threadId, requestId);
    await assert.rejects(runtime.router.route(threadId, { deviceId: device, requestId }), { code: 'resume-unknown' });
    assert.equal(runtime.router.isRecoveryLocked(threadId), true);
    const exited = once(runtime.owner.client.child, 'exit');
    runtime.owner.client.child.kill('SIGTERM'); await exited;
    assert.equal(runtime.router.isRecoveryLocked(threadId), false);
    assert.equal(runtime.router.journal.recoveryAttempt(host, device, threadId, requestId), 'rejected');
    const nextThread = randomUUID(), nextRequest = randomUUID();
    runtime.router.journal.beginRecoveryAttempt(host, device, nextThread, nextRequest);
    await assert.rejects(runtime.router.route(nextThread, { deviceId: device, requestId: nextRequest }), { code: 'unavailable' });
    assert.equal(runtime.router.journal.recoveryPending(host, nextThread), false);
  } finally { if (runtime) await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('old execution settlement cannot remove a replacement attempt or unrelated write journals', () => {
  const journal = new CreationJournal(':memory:');
  try {
    const old = { instanceId: randomUUID(), pid: 12345, startedAt: 'old-start' };
    const current = { ...old, instanceId: randomUUID(), startedAt: 'new-start' };
    const previous = reserve(journal, old);
    assert.equal(journal.completeRecovery(host, device, previous.threadId, previous.requestId, 'rejected'), true);
    const replacement = reserve(journal, current, previous.threadId);
    journal.db.prepare("INSERT INTO message_writes VALUES (?,?,?,'dispatching')").run(host, 'message-thread', 'message');
    journal.db.prepare("INSERT INTO model_writes VALUES (?,?,?,?,'unknown')").run(host, 'model-thread', device, 'model');
    journal.db.prepare("INSERT INTO raw_request_experiment (instance,request_key,thread,turn,item,method,digest,phase,host_id) VALUES (?,?,?,?,?,?,?,'unknown',?)").run('raw-instance', 'request', 'raw-thread', 'turn', 'item', 'method', 'digest', host);
    journal.begin(host, device, 'creation', 'project', 'a'.repeat(64));
    const tables = ['message_writes', 'model_writes', 'raw_request_experiment', 'creations'];
    const before = tables.map(table => journal.db.prepare(`SELECT * FROM ${table}`).all());
    assert.deepEqual(journal.retireRecoveryExecution(host, old), []);
    assert.equal(journal.recoveryPending(host, replacement.threadId), true);
    assert.equal(journal.recoveryAttempt(host, device, replacement.threadId, replacement.requestId), 'pending');
    assert.deepEqual(tables.map(table => journal.db.prepare(`SELECT * FROM ${table}`).all()), before);
  } finally { journal.close(); }
});

test('router binds the execution before dispatch and clears its guard after an actual child exit', async () => {
  const process = await childExecution();
  const journal = new CreationJournal(':memory:');
  const threadId = randomUUID(), requestId = randomUUID();
  const localOwner = { state: 'ready', async resume(id) {
    const row = journal.db.prepare('SELECT execution_id AS instanceId,execution_pid AS pid,execution_started AS startedAt FROM recovery_writes WHERE host_id=? AND thread_id=?').get(host, id);
    assert.deepEqual({ ...row }, process.execution);
    throw Object.assign(new Error('response lost'), { code: 'outcome-unknown' });
  } };
  const router = new OwnerRouter({ localOwner, journal, hostId: host, recoveryExecution: process.execution,
    discover: async () => ({ kind: 'unknown' }), projects: async () => [], competeUnknown: true });
  process.child.once('exit', () => router.recoveryExecutionExited(process.execution));
  try {
    journal.beginRecoveryAttempt(host, device, threadId, requestId);
    await assert.rejects(router.route(threadId, { deviceId: device, requestId }), { code: 'resume-unknown' });
    assert.equal(router.isRecoveryLocked(threadId), true);
    router.recoveryExecutionExited({ ...process.execution });
    assert.equal(router.isRecoveryLocked(threadId), true);
    await process.close();
    assert.equal(router.isRecoveryLocked(threadId), false);
    assert.equal(journal.recoveryAttempt(host, device, threadId, requestId), 'rejected');
  } finally { router.close(); journal.close(); await process.close(); }
});
