import test from 'node:test';
import assert from 'node:assert/strict';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { OwnerRouter } from '../src/desktop/owner-router.mjs';

test('creates a project chat once and retains its thread for subsequent requests', async () => {
  const journal = new CreationJournal(':memory:');
  let creates = 0, turns = 0;
  const localOwner = { async create() { creates++; return { id: 'thread' }; }, async startTurn() { turns++; } };
  const router = new OwnerRouter({ discover: async () => ({ kind: 'unknown' }), localOwner, projects: async () => [{ id: 'project', cwd: '/tmp' }], journal, hostId: 'host' });
  try {
    const request = { projectId: 'project', text: 'hello', deviceId: 'device', requestId: 'request' };
    assert.deepEqual(await router.create(request), { threadId: 'thread' });
    assert.deepEqual(await router.create(request), { threadId: 'thread' });
    assert.equal(creates, 1); assert.equal(turns, 1);
  } finally { router.close(); journal.close(); }
});

test('unknown owner can resume, but writer conflicts never force takeover', async () => {
  const journal = new CreationJournal(':memory:');
  let resume = 0, owns = false, conflict = false;
  const localOwner = { ownerId: () => 'local', async resume() { resume++; if (conflict) throw Object.assign(new Error('busy'), { code: 'writer-conflict' }); owns = true; } };
  const router = new OwnerRouter({ discover: async () => owns ? { kind: 'owner', ownerId: 'local' } : { kind: 'unknown' }, localOwner, projects: async () => [], journal, hostId: 'host', competeUnknown: true, confirmRecovery: async () => true });
  try {
    assert.deepEqual(await router.route('thread'), { kind: 'owner', ownerId: 'local' });
    owns = false; conflict = true;
    await assert.rejects(router.route('other'), { code: 'unavailable' });
    assert.equal(resume, 2);
  } finally { router.close(); journal.close(); }
});

test('shutdown and duplicate recovery cannot interrupt an in-flight owner recovery', async () => {
  const journal = new CreationJournal(':memory:');
  let resumeEntered, releaseResume, owns = false, resumes = 0;
  const entered = new Promise(resolve => { resumeEntered = resolve; });
  const gate = new Promise(resolve => { releaseResume = resolve; });
  const localOwner = { ownerId: () => 'local', async resume() { resumes++; resumeEntered(); await gate; owns = true; } };
  const router = new OwnerRouter({ discover: async () => owns ? { kind: 'owner', ownerId: 'local' } : { kind: 'unknown' },
    localOwner, projects: async () => [], journal, hostId: 'host', competeUnknown: true, confirmRecovery: async () => true });
  try {
    const recovery = router.route('thread');
    await entered;
    assert.throws(() => router.beginShutdown(), { code: 'tasks-active' });
    await assert.rejects(router.route('thread'), { code: 'unavailable' });
    releaseResume();
    assert.deepEqual(await recovery, { kind: 'owner', ownerId: 'local' });
    assert.equal(resumes, 1);
    router.beginShutdown();
    await assert.rejects(router.route('thread'), { code: 'unavailable' });
  } finally { releaseResume(); router.close(); journal.close(); }
});

test('an unknown resume result remains locked and is not automatically dispatched twice', async () => {
  const journal = new CreationJournal(':memory:');
  let resumes = 0;
  const localOwner = { async resume() { resumes++; throw Object.assign(new Error('lost response'), { code: 'outcome-unknown' }); } };
  const options = { discover: async () => ({ kind: 'unknown' }), localOwner, projects: async () => [], journal, hostId: 'host', competeUnknown: true };
  const first = new OwnerRouter(options);
  let restarted;
  try {
    await assert.rejects(first.route('thread'), { code: 'resume-unknown' });
    assert.equal(first.isRecoveryLocked('thread'), true);
    first.close();
    restarted = new OwnerRouter(options);
    await assert.rejects(restarted.route('thread'), { code: 'resume-unknown' });
    assert.equal(resumes, 1);
  } finally { first.close(); restarted?.close(); journal.close(); }
});

test('a recovery reservation that never reports back stops blocking after its TTL', async () => {
  const journal = new CreationJournal(':memory:');
  try {
    assert.equal(journal.beginRecovery('host', 'thread', 'attempt'), true);
    assert.equal(journal.recoveryPending('host', 'thread'), true);
    // Simulate a bridge restart in the middle of a resume: the reservation is
    // still on disk but no request can complete it anymore.
    journal.db.prepare('UPDATE recovery_writes SET created_at=? WHERE host_id=? AND thread_id=?').run(Date.now() - 120000, 'host', 'thread');
    assert.equal(journal.recoveryPending('host', 'thread'), false);
    assert.equal(journal.recoveryPending('host', 'thread'), false);
    const retry = journal.beginRecovery('host', 'thread', 'next-attempt');
    assert.equal(retry, true);
  } finally { journal.close(); }
});

test('legacy recovery reservations without a timestamp are treated as abandoned', async () => {
  const journal = new CreationJournal(':memory:');
  try {
    journal.db.prepare('INSERT INTO recovery_writes (host_id,thread_id,attempt_id,created_at) VALUES (?,?,?,0)').run('host', 'thread', 'legacy');
    assert.equal(journal.recoveryPending('host', 'thread'), false);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS count FROM recovery_writes').get().count, 0);
  } finally { journal.close(); }
});

test('the in-memory recovery guard expires with the same TTL', async () => {
  const journal = new CreationJournal(':memory:');
  const localOwner = { async resume() { throw Object.assign(new Error('lost response'), { code: 'outcome-unknown' }); } };
  const router = new OwnerRouter({ discover: async () => ({ kind: 'unknown' }), localOwner, projects: async () => [], journal, hostId: 'host', competeUnknown: true, recoveryLockTtlMs: 0 });
  try {
    await assert.rejects(router.route('thread'), { code: 'resume-unknown' });
    assert.equal(router.uncertainRecovery.has('thread'), true);
    // The in-memory guard must not outlive the TTL even when the journal still
    // holds the reservation; the journal applies the same TTL on its own.
    assert.equal(router.isRecoveryLocked('thread'), true);
    assert.equal(router.uncertainRecovery.has('thread'), false);
  } finally { router.close(); journal.close(); }
});
