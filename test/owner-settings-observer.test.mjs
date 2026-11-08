import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOwner } from '../src/desktop/local-owner.mjs';
import { createOwnerSettingsObserver } from '../src/desktop/owner-settings-observer.mjs';
import { desktopView } from '../src/desktop/view.mjs';

test('LocalOwner projects effective start/resume settings without sending a settings mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-settings-'));
  const requests = [];
  let nextResult;
  const spawnProcess = () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 1, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.id == null) continue;
        requests.push(message);
        const result = ['initialize', 'getAuthStatus'].includes(message.method) ? {} : nextResult;
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
      }
      done();
    } });
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    return child;
  };
  const owner = await new LocalOwner({ binary: 'fake', cwd: dir, socketPath: join(dir, 'isolated.sock'), spawnProcess }).start();
  const thread = { id: 'thread', model: 'thread-model', turns: [{ id: 'old-turn', status: 'completed', items: [] }] };
  const view = () => desktopView(owner.owner._debugSnapshot(thread.id));
  try {
    nextResult = { thread, model: 'effective-start', reasoningEffort: 'high' };
    await owner.create({ cwd: dir });
    assert.deepEqual([view().model, view().reasoningEffort], ['effective-start', 'high']);

    nextResult = { thread, model: 'effective-resume', reasoningEffort: 'medium' };
    await owner.resume(thread.id);
    assert.deepEqual([view().model, view().reasoningEffort], ['effective-resume', 'medium']);

    nextResult = { thread, model: 'explicit-default', reasoningEffort: null };
    await owner.resume(thread.id);
    assert.deepEqual([view().model, view().reasoningEffort], ['explicit-default', null]);

    nextResult = { thread, reasoningEffort: 'low' };
    await owner.resume(thread.id);
    assert.deepEqual([view().model, view().reasoningEffort], ['explicit-default', 'low']);
    nextResult = { thread, model: 'model-only' };
    await owner.resume(thread.id);
    assert.deepEqual([view().model, view().reasoningEffort], ['model-only', 'low']);

    owner.client.emit('outbound', '', { method: 'thread/settings/updated', params: { threadId: thread.id, threadSettings: { model: 'later-model', effort: 'high' } } });
    assert.deepEqual([view().model, view().reasoningEffort], ['later-model', 'high']);
    assert.ok(requests.every(request => ['initialize', 'getAuthStatus', 'thread/start', 'thread/resume'].includes(request.method)));
    assert.deepEqual(requests.filter(request => request.method !== 'getAuthStatus').map(request => request.method), ['initialize', 'thread/start', ...Array(4).fill('thread/resume')]);
  } finally {
    await owner.close({ force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

function harness(options) {
  const updates = [];
  const owner = { observeInbound() {}, observeOutbound(_raw, value) { if (value.method === 'thread/settings/updated') updates.push(value.params); }, isThreadOwned: () => true };
  return { observer: createOwnerSettingsObserver(owner, options), updates };
}
const resume = (observer, id, threadId = 'thread') => observer.observeInbound('', { id, method: 'thread/resume', params: { threadId } });
const response = (observer, id, result = {}) => observer.observeOutbound('', { id, result: { thread: { id: 'thread' }, reasoningEffort: 'high', ...result } });

test('correlates late responses by request ID without replacing newer confirmed settings', () => {
  const { observer, updates } = harness();
  resume(observer, 1); resume(observer, 2);
  response(observer, 99);
  response(observer, 2, { reasoningEffort: 'medium' });
  response(observer, 1);
  response(observer, 1);
  assert.deepEqual(updates.map(update => update.threadSettings), [{ effort: 'medium' }]);
});

test('a pending newer resume does not invalidate an older successful response', () => {
  const { observer, updates } = harness();
  resume(observer, 1); resume(observer, 2);
  response(observer, 1);
  observer.observeOutbound('', { id: 2, error: { code: -32600 } });
  assert.deepEqual(updates.map(update => update.threadSettings), [{ effort: 'high' }]);
});

test('a real settings notification prevents a late resume from restoring older settings', () => {
  const { observer, updates } = harness();
  resume(observer, 1);
  observer.observeOutbound('', { method: 'thread/settings/updated', params: { threadId: 'thread', threadSettings: { model: 'current', effort: null } } });
  response(observer, 1);
  assert.deepEqual(updates.map(update => update.threadSettings), [{ model: 'current', effort: null }]);
  resume(observer, 2);
  response(observer, 2, { reasoningEffort: 'low' });
  assert.deepEqual(updates.at(-1).threadSettings, { effort: 'low' });
});

test('partial settings notifications preserve independent effort from a pending resume', () => {
  for (const notification of [{ model: 'current' }, { serviceTier: 'priority' }]) {
    const { observer, updates } = harness();
    resume(observer, 1);
    observer.observeOutbound('', { method: 'thread/settings/updated', params: { threadId: 'thread', threadSettings: notification } });
    response(observer, 1, { model: 'resume-model' });
    assert.deepEqual(updates.at(-1).threadSettings, {
      ...(!Object.hasOwn(notification, 'model') ? { model: 'resume-model' } : {}), effort: 'high',
    });
  }
});

test('new effort confirmations including null protect effort without discarding a pending model', () => {
  for (const effort of ['low', null]) {
    for (const notification of [{ effort }, { collaborationMode: { settings: { reasoning_effort: effort } } }]) {
      const { observer, updates } = harness();
      resume(observer, 1);
      observer.observeOutbound('', { method: 'thread/settings/updated', params: { threadId: 'thread', threadSettings: notification } });
      response(observer, 1, { model: 'resume-model' });
      assert.deepEqual(updates.at(-1).threadSettings, { model: 'resume-model' });
    }
  }
});

test('a newer partial resume only supersedes its confirmed fields', () => {
  const { observer, updates } = harness();
  resume(observer, 1); resume(observer, 2);
  response(observer, 2, { model: 'current-model', reasoningEffort: undefined });
  response(observer, 1, { model: 'old-model' });
  assert.deepEqual(updates.map(update => update.threadSettings), [{ model: 'current-model' }, { effort: 'high' }]);
});

test('rejects failed, mismatched, mirrored and malformed setting responses', () => {
  const { observer, updates } = harness();
  resume(observer, 1); observer.observeOutbound('', { id: 1, error: { code: -32600 } });
  resume(observer, 2, 'different'); response(observer, 2);
  resume(observer, 3); response(observer, 3, { remodexDesktopIpcMirror: true });
  resume(observer, 4); response(observer, 4, { reasoningEffort: undefined, model: 123 });
  resume(observer, 5); observer.observeOutbound('', { id: 5, result: { thread: { id: 'thread' }, reasoningEffort: 'high' }, error: null });
  assert.deepEqual(updates, []);
});

test('pending correlation is bounded and cleared on owner shutdown', () => {
  const { observer, updates } = harness({ pendingLimit: 2 });
  resume(observer, 1); resume(observer, 2); resume(observer, 3);
  response(observer, 1);
  response(observer, 2);
  observer.clear();
  response(observer, 3);
  assert.equal(updates.length, 1);
});
