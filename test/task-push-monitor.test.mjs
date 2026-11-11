import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TaskNotificationMonitor, taskNotificationSummary } from '../src/notifications/task-monitor.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const fakeProbeClient = () => ({ async connect() {}, async discover() { return { ownerId: 'fixture-owner' }; }, async close() {} });
const threadId = randomUUID();
const turn = (turnId, status = 'inProgress', items = []) => ({ turnId, status, items });
const state = (id, latest, requests = [], active = latest?.status === 'inProgress') => ({ id, turns: latest ? [latest] : [], requests, threadRuntimeStatus: { type: active ? 'active' : 'idle' } });
function request(id, method = 'item/tool/requestUserInput', turnId = 'turn-a') {
  return { id, method, params: { threadId, turnId, itemId: 'item-' + id } };
}
class FakeSession extends EventEmitter {
  start() { this.started = true; }
  publish(value) { this.value = value; this.emit('state', { status: 'ready', value }); }
  unavailable() { this.emit('state', { status: 'unavailable' }); }
  async close() { this.closed = true; this.removeAllListeners(); }
}
function fixture(overrides = {}) {
  const rows = [{ id: threadId, recency: 1 }], sessions = [], events = [], clears = [], health = [];
  let clock = 1794382000000;
  const monitor = new TaskNotificationMonitor({
    createProbeClient: fakeProbeClient, readState: async () => ({ status: 'unavailable' }),
    listThreads: async () => ({ projects: [], recent: rows, nextCursor: null }),
    createSession: options => { const session = new FakeSession(); session.options = options; sessions.push(session); return session; },
    now: () => clock, onEvent: event => events.push(event), onClear: event => clears.push(event), onHealth: value => health.push(value), ...overrides,
  });
  return { monitor, rows, sessions, events, clears, health, advance: ms => clock += ms };
}

test('lightweight summary handles canonical tail, pending controls and answered asynchronous questions', () => {
  const question = { id: 'question-item', type: 'agentMessage', questions: [{ title: 'Continue?', options: ['Yes'] }] };
  const value = state(threadId, null, [request(7), request(8, 'item/commandExecution/requestApproval'), { ...request(9), completed: true }, { ...request(10), params: { ...request(10).params, threadId: randomUUID() } }]);
  value.turnHistory = { kind: 'canonical', history: { islands: [{ newerBoundary: { status: 'exhausted' }, entries: [{ value: 'tail' }] }], entitiesByKey: { tail: turn('turn-a', 'inProgress', [question]) } } };
  let summary = taskNotificationSummary(value);
  assert.equal(summary.turnId, 'turn-a'); assert.equal(summary.active, true);
  assert.deepEqual(summary.controls.map(x => x.kind).sort(), ['approval', 'question', 'question']);
  value.turnHistory.history.entitiesByKey.tail.items.push({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'question-item', 0]), question: 'Continue?', answer: 'Yes' }]) + '\n</send_user_message_question_reply>' }] });
  summary = taskNotificationSummary(value);
  assert.equal(summary.controls.length, 2);
  assert.ok(!JSON.stringify(summary).includes('Continue?'));
});

test('initial snapshot is baseline; live task completion emits once and releases the idle follower', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    assert.equal(f.sessions.length, 1);
    const s = f.sessions[0]; s.publish(state(threadId, turn('turn-a')));
    assert.equal(f.events.length, 0);
    s.publish(state(threadId, turn('turn-a', 'completed'))); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.events[0].kind, 'completed');
    assert.equal(f.events[0].threadId, threadId); assert.equal(s.closed, true);
    await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 1);
  } finally { await f.monitor.close(); }
});

test('recency changes reopen a normally released idle thread and detect completion between polls', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, turn('old', 'completed'))); await flush();
    assert.equal(f.events.length, 0);
    f.rows[0].recency = 2; await f.monitor.poll(); await flush();
    assert.equal(f.sessions.length, 2);
    f.sessions[1].publish(state(threadId, { ...turn('new', 'completed'), turnStartedAtMs: 1794382000000 })); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.events[0].kind, 'completed');
    f.rows[0].recency = 3; await f.monitor.poll(); await flush();
    f.sessions[2].publish(state(threadId, turn('new', 'completed'))); await flush();
    assert.equal(f.events.length, 1);
  } finally { await f.monitor.close(); }
});

test('history loading or an unproven completed tail does not masquerade as a new completed task', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, turn('old', 'completed'))); await flush();
    f.rows[0].recency = 2; await f.monitor.poll(); await flush();
    f.sessions[1].publish(state(threadId, { ...turn('previously-unloaded', 'completed'), turnStartedAtMs: 1794381000000 })); await flush();
    f.rows[0].recency = 3; await f.monitor.poll(); await flush();
    f.sessions[2].publish(state(threadId, turn('unknown-start-time', 'completed'))); await flush();
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('disconnect closes the auto retry session; later owner discovery is backoff and baseline only', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, turn('turn-a')));
    f.sessions[0].unavailable(); await flush();
    assert.equal(f.sessions[0].closed, true);
    await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 1);
    f.advance(30000); await f.monitor.poll(); await flush();
    assert.equal(f.sessions.length, 2);
    f.sessions[1].publish(state(threadId, turn('turn-a', 'completed'))); await flush();
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('coalesced updates emit new question and approval identities without repeating existing requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('turn-a')));
    for (let index = 0; index < 100; index++) s.publish(state(threadId, turn('turn-a', 'inProgress', [{ type: 'agentMessage', id: 'output', text: 'x'.repeat(index) }]), [request('question') ]));
    assert.equal(f.events.length, 0);
    t.mock.timers.tick(250);
    assert.deepEqual(f.events.map(x => x.kind), ['question']);
    s.publish(state(threadId, turn('turn-a'), [request('question'), request('approval', 'item/fileChange/requestApproval')]));
    t.mock.timers.tick(250);
    assert.deepEqual(f.events.map(x => x.kind), ['question', 'approval']);
    s.publish(state(threadId, turn('turn-a'), [request('question'), request('approval', 'item/fileChange/requestApproval')]));
    t.mock.timers.tick(250); assert.equal(f.events.length, 2);
  } finally { await f.monitor.close(); }
});

test('snapshot admission is bounded, active capacity is reported and queued threads continue when capacity is released', async () => {
  const f = fixture({ concurrency: 2, maxActive: 3 });
  f.rows.splice(0, 1, ...Array.from({ length: 6 }, (_, n) => ({ id: randomUUID(), recency: n + 1 })));
  f.monitor.start(); await flush();
  try {
    assert.equal(f.sessions.length, 2);
    assert.equal(f.sessions[0].options.conversationId, f.rows[5].id);
    for (const s of f.sessions.slice()) s.publish(state(s.options.conversationId, turn('turn-a')));
    assert.equal(f.sessions.length, 3);
    f.sessions[2].publish(state(f.sessions[2].options.conversationId, turn('turn-a')));
    assert.ok(f.health.some(value => value.reason === 'active-capacity'));
    f.sessions[0].publish(state(f.sessions[0].options.conversationId, turn('turn-a', 'completed')));
    assert.equal(f.sessions.length, 4);
    assert.equal(f.monitor.entries.size, 3);
  } finally { await f.monitor.close(); assert.ok(f.sessions.every(s => s.closed)); }
});

test('initial scanning budget continues the remaining queue on the next poll', async () => {
  const f = fixture({ probesPerPoll: 2 });
  f.rows.splice(0, 1, ...Array.from({ length: 5 }, (_, n) => ({ id: randomUUID(), recency: n })));
  f.monitor.start(); await flush();
  try {
    for (const s of f.sessions.slice()) s.publish(state(s.options.conversationId, turn('old', 'completed')));
    await flush(); assert.equal(f.sessions.length, 2);
    await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 4);
    for (const s of f.sessions.slice(2)) s.publish(state(s.options.conversationId, turn('old', 'completed')));
    await flush(); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 5);
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('snapshot timeout and stop release all sessions, timers, and queued work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  t.mock.timers.tick(15000); await flush();
  assert.equal(f.sessions[0].closed, true);
  await f.monitor.stop();
  const count = f.sessions.length;
  t.mock.timers.tick(120000); await flush();
  assert.equal(f.sessions.length, count); assert.equal(f.monitor.entries.size, 0); assert.equal(f.monitor.records.size, 0);
});

test('a malformed list reports failure and preserves existing observers', async () => {
  let broken = false;
  const f = fixture({ listThreads: async () => broken ? {} : { recent: [{ id: threadId, recency: 1 }], projects: [] } });
  f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, turn('turn-a')));
    broken = true; await f.monitor.poll(); await flush();
    assert.equal(f.monitor.entries.size, 1);
    assert.ok(f.health.some(x => x.reason === 'list-unavailable'));
  } finally { await f.monitor.close(); }
});

test('1000 unchanged historical threads only probe the recent 64 once and never retry unknown owners', async () => {
  const sessions = [], rows = Array.from({ length: 1000 }, (_, n) => ({ id: randomUUID(), recency: n + 1 }));
  let clock = 1794382000000;
  const monitor = new TaskNotificationMonitor({ now: () => clock, createProbeClient: fakeProbeClient, readState: async () => ({ status: 'unavailable' }),
    listThreads: async () => ({ projects: [], recent: rows }),
    createSession: options => {
      const session = new FakeSession(); session.options = options; sessions.push(session);
      session.start = () => queueMicrotask(() => session.unavailable()); return session;
    },
  });
  monitor.start(); await flush();
  try {
    assert.equal(sessions.length, 64);
    assert.equal(monitor.queue.size, 0);
    assert.equal(monitor.records.size, 1000);
    const recent = new Set(rows.slice(-64).map(row => row.id));
    assert.ok(sessions.every(session => recent.has(session.options.conversationId)));
    for (let poll = 0; poll < 100; poll++) { clock += 30000; await monitor.poll(); }
    await flush(); assert.equal(sessions.length, 64);
    // A previously ignored old task becomes interesting only when its recency
    // changes, and then receives one new read-only probe.
    rows[0].recency = 2000; await monitor.poll(); await flush();
    assert.equal(sessions.length, 65); assert.equal(sessions.at(-1).options.conversationId, rows[0].id);
    clock += 600000; await monitor.poll(); await flush(); assert.equal(sessions.length, 65);
  } finally { await monitor.close(); }
});

test('known active owner retries back off exponentially while unchanged idle history never reopens', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, turn('live'))); f.sessions[0].unavailable(); await flush();
    f.advance(30000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 2);
    f.sessions[1].unavailable(); await flush();
    f.advance(30000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 2);
    f.advance(30000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 3);
    f.sessions[2].unavailable(); await flush();
    f.advance(60000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 3);
    f.advance(60000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 4);
    f.sessions[3].publish(state(threadId, turn('live', 'completed'))); await flush();
    assert.equal(f.events.length, 0);
    f.advance(600000); await f.monitor.poll(); await flush(); assert.equal(f.sessions.length, 4);
    assert.equal(f.health.at(-1).reason, 'ready');
  } finally { await f.monitor.close(); }
});

test('a burst of changed tasks has a bounded recent-first queue without silently losing deferred changes', async () => {
  const f = fixture({ initialProbeLimit: 1, probesPerPoll: 2, maxQueued: 4 });
  f.rows.splice(0, 1, ...Array.from({ length: 30 }, (_, n) => ({ id: randomUUID(), recency: n + 1 })));
  f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(f.sessions[0].options.conversationId, turn('old', 'completed'))); await flush();
    for (const row of f.rows) row.recency += 100;
    await f.monitor.poll(); await flush(); assert.ok(f.monitor.queue.size <= 4); assert.equal(f.sessions.length, 3);
    assert.equal(f.sessions[1].options.conversationId, f.rows.at(-1).id);
    assert.ok(f.health.some(value => value.reason === 'queue-capacity'));
    let processed = 1;
    for (let batch = 0; batch < 20; batch++) {
      while (processed < f.sessions.length) { const s = f.sessions[processed++]; s.publish(state(s.options.conversationId, turn('old', 'completed'))); }
      await flush(); await f.monitor.poll(); await flush(); assert.ok(f.monitor.queue.size <= 4);
    }
    while (processed < f.sessions.length) { const s = f.sessions[processed++]; s.publish(state(s.options.conversationId, turn('old', 'completed'))); }
    assert.equal(f.sessions.length, 31);
    assert.equal([...f.monitor.records.values()].filter(record => record.needsProbe).length, 0);
  } finally { await f.monitor.close(); }
});

test('health becomes ready only after actual baseline probes finish and recovers after owner reconnection', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    assert.equal(f.health.some(value => value.reason === 'ready'), false);
    f.sessions[0].publish(state(threadId, turn('live')));
    assert.equal(f.health.at(-1).reason, 'ready');
    f.sessions[0].unavailable(); await flush(); assert.equal(f.health.at(-1).reason, 'observe-unavailable');
    f.advance(30000); await f.monitor.poll(); await flush(); assert.equal(f.health.at(-1).reason, 'observe-unavailable');
    f.sessions[1].publish(state(threadId, turn('live')));
    assert.equal(f.health.at(-1).reason, 'ready');
  } finally { await f.monitor.close(); }
});

test('summary scans control identities without reading historical or current agent output text', () => {
  const historical = { type: 'agentMessage', id: 'old-output' }; Object.defineProperty(historical, 'text', { get() { throw new Error('Historical output touched'); } });
  const old = turn('old', 'completed', [historical]);
  const message = { id: 'large-output', type: 'agentMessage' }; Object.defineProperty(message, 'text', { get() { throw new Error('Agent text touched'); } });
  const latest = turn('live', 'inProgress', [message, { type: 'userMessage', content: [{ type: 'text', text: 'x'.repeat(500000) }] }]);
  const value = state(threadId, latest); value.turns.unshift(old);
  assert.equal(taskNotificationSummary(value).turnId, 'live');
});

test('an asynchronous question wins over same-turn completion and answering never adds a completion notification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('question-turn')));
    const question = { type: 'agentMessage', id: 'question-item', questions: [{ title: 'Continue?', options: ['Yes'] }] };
    s.publish(state(threadId, turn('question-turn', 'completed', [question])));
    assert.deepEqual(f.events.map(value => value.kind), ['question']);
    // The runtime briefly resumes while applying the answer. Neither that
    // transition nor its later completed state may add a completion alert.
    const answer = questionAnswer('question-item');
    s.publish({ ...state(threadId, turn('question-turn', 'inProgress', [question, answer])), resumeState: 'resumed' });
    t.mock.timers.tick(250);
    s.publish({ ...state(threadId, turn('question-turn', 'completed', [question, answer])), resumeState: 'resumed' });
    await flush(); assert.deepEqual(f.events.map(value => value.kind), ['question']);
    f.rows[0].recency = 2; await f.monitor.poll(); await flush();
    const next = f.sessions[1]; next.publish(state(threadId, turn('next-turn')));
    next.publish(state(threadId, turn('next-turn', 'completed')));
    assert.deepEqual(f.events.map(value => value.kind), ['question', 'completed']);
  } finally { await f.monitor.close(); }
});

test('initial pending question snapshot is baseline and is not pushed after the question is answered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0];
    s.publish(state(threadId, turn('existing-question'), [request('existing', 'item/tool/requestUserInput', 'existing-question')]));
    assert.equal(f.events.length, 0);
    s.publish(state(threadId, turn('existing-question'))); t.mock.timers.tick(250);
    s.publish(state(threadId, turn('existing-question', 'completed')));
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('approval waiting suppresses simultaneous completion but permits real completion after the approval is resolved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('approval-turn')));
    s.publish(state(threadId, turn('approval-turn', 'completed'), [request('approve', 'item/commandExecution/requestApproval', 'approval-turn')]));
    assert.deepEqual(f.events.map(value => value.kind), ['approval']);
    s.publish(state(threadId, turn('approval-turn'))); t.mock.timers.tick(250);
    s.publish(state(threadId, turn('approval-turn', 'completed')));
    assert.deepEqual(f.events.map(value => value.kind), ['approval', 'completed']);
  } finally { await f.monitor.close(); }
});

test('a newly created short task completed before its first snapshot still notifies when native start time proves it is new', async () => {
  const f = fixture(); f.rows.length = 0; f.monitor.start(); await flush();
  try {
    f.advance(1000);
    const id = randomUUID(); f.rows.push({ id, recency: 2 });
    await f.monitor.poll(); await flush();
    f.sessions[0].publish(state(id, { ...turn('short-new', 'completed'), turnStartedAtMs: 1794382000500 }));
    assert.deepEqual(f.events.map(value => value.kind), ['completed']);
    assert.equal(f.events[0].threadId, id);
  } finally { await f.monitor.close(); }
});

test('newly listed historical tasks or missing native start times never masquerade as fresh short tasks', async () => {
  const f = fixture(); f.rows.length = 0; f.monitor.start(); await flush();
  try {
    f.advance(1000);
    const old = randomUUID(), unknown = randomUUID();
    f.rows.push({ id: old, recency: 2 }, { id: unknown, recency: 3 });
    await f.monitor.poll(); await flush();
    for (const s of f.sessions) s.publish(state(s.options.conversationId, { ...turn('history', 'completed'), ...(s.options.conversationId === old ? { turnStartedAtMs: 1794381000000 } : {}) }));
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('a short newly listed task after an incomplete list is baseline rather than an inferred live creation', async () => {
  let partial = true;
  const rows = [];
  const f = fixture({ listThreads: async () => ({ recent: rows, projects: [], truncated: partial }) });
  f.monitor.start(); await flush();
  try {
    rows.push({ id: threadId, recency: 2 }); partial = false;
    await f.monitor.poll(); await flush();
    f.sessions[0].publish(state(threadId, { ...turn('unproven', 'completed'), turnStartedAtMs: 1794382000000 }));
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('initial activation never replays a completed task even when its native timestamp is recent', async () => {
  const f = fixture(); f.monitor.start(); await flush();
  try {
    f.sessions[0].publish(state(threadId, { ...turn('already-complete', 'completed'), turnStartedAtMs: 1794382000000 }));
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('eight lightweight discoveries bypass absent owners while only two full snapshots are admitted', async () => {
  const calls = [];
  let clients = 0, connects = 0, closes = 0, peakProbes = 0;
  const f = fixture({ createProbeClient: () => {
    clients++;
    return { async connect() { connects++; }, async close() { closes++; },
      discover(id, _host, { signal }) {
        const call = { id, signal, settled: false };
        calls.push(call);
        peakProbes = Math.max(peakProbes, calls.filter(item => !item.settled).length);
        return new Promise((resolve, reject) => {
          call.resolve = () => { call.settled = true; resolve({ ownerId: 'fixture-owner' }); };
          call.reject = () => { call.settled = true; reject(new Error('no-client-found')); };
          signal.addEventListener('abort', call.reject, { once: true });
        });
      },
    };
  } });
  f.rows.splice(0, 1, ...Array.from({ length: 12 }, (_, n) => ({ id: randomUUID(), recency: n + 1 })));
  f.monitor.start(); await flush();
  try {
    assert.equal(calls.length, 8); assert.equal(f.sessions.length, 0);
    assert.equal(f.health.some(item => item.reason === 'ready'), false);
    calls[0].reject(); await flush();
    assert.equal(calls.length, 9, 'absence releases a discovery slot without consuming a snapshot slot');
    for (const call of calls.slice(1, 6)) call.resolve();
    await flush();
    assert.equal(f.sessions.length, 2);
    assert.equal(f.monitor.ready.size, 3);
    assert.ok(f.monitor.probing.size <= 8); assert.ok(peakProbes <= 8);
    assert.equal(f.health.some(item => item.reason === 'ready'), false, 'queued discoveries and snapshots block readiness');
    const absentId = calls[0].id;
    assert.ok(f.sessions.every(session => session.options.conversationId !== absentId));
    for (const s of f.sessions.slice()) s.publish(state(s.options.conversationId, turn('live')));
    assert.equal(f.sessions.length, 4);
    assert.equal([...f.monitor.entries.values()].filter(entry => !entry.initialized).length, 2);
  } finally { await f.monitor.close(); }
  assert.equal(clients, 1); assert.equal(connects, 1); assert.equal(closes, 1);
  assert.ok(calls.every(call => call.settled || call.signal.aborted));
  assert.equal(f.monitor.probing.size, 0); assert.equal(f.monitor.ready.size, 0);
  assert.ok(f.sessions.every(session => session.closed));
  const count = f.sessions.length;
  for (const call of calls) call.resolve();
  await flush(); assert.equal(f.sessions.length, count, 'late discoveries cannot reopen stopped observers');
});

test('removed records cancel their discovery and a disconnected probe lease is replaced on later work', async () => {
  const clients = [], calls = [];
  const f = fixture({ createProbeClient: () => {
    const client = { state: 'new', async connect() { this.state = 'ready'; }, async close() { this.state = 'closed'; },
      discover(id, _host, { signal }) {
        return new Promise((resolve, reject) => {
          calls.push({ id, resolve, signal });
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    };
    clients.push(client); return client;
  } });
  f.monitor.start(); await flush();
  try {
    const removed = calls[0];
    f.rows.length = 0; await f.monitor.poll(); await flush();
    assert.equal(removed.signal.aborted, true);
    removed.resolve({ ownerId: 'old-owner' }); await flush();
    assert.equal(f.sessions.length, 0);
    clients[0].state = 'closed';
    f.rows.push({ id: randomUUID(), recency: 3 });
    await f.monitor.poll(); await flush();
    assert.equal(clients.length, 2);
    calls.at(-1).resolve({ ownerId: 'new-owner' }); await flush();
    assert.equal(f.sessions.length, 1);
  } finally { await f.monitor.close(); }
});

test('resolved controls clear only exact emitted identities and leave other pending approvals intact, including reconnect baseline', async () => {
  const f = fixture({ coalesceMs: 1 }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('live')));
    s.publish(state(threadId, turn('live'), [request('a'), request('b', 'item/commandExecution/requestApproval')]));
    await new Promise(resolve => setTimeout(resolve, 5));
    const a = f.events.find(event => event.kind === 'question'), b = f.events.find(event => event.kind === 'approval');
    assert.ok(a && b);
    s.publish(state(threadId, turn('live'), [request('b', 'item/commandExecution/requestApproval')]));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.clears.map(event => [event.eventId, event.reason]), [[a.eventId, 'resolved']]);
    s.unavailable(); await flush(); f.advance(30000); await f.monitor.poll(); await flush();
    f.sessions[1].publish(state(threadId, turn('live')));
    assert.deepEqual(f.clears.map(event => [event.eventId, event.reason]), [[a.eventId, 'resolved'], [b.eventId, 'resolved']]);
    f.sessions[1].publish(state(threadId, turn('live'))); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.clears.length, 2);
  } finally { await f.monitor.close(); }
});

test('initial historical pending controls never emit retrospective clear events', async () => {
  const f = fixture({ coalesceMs: 1 }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('old'), [request('baseline')]));
    s.publish(state(threadId, turn('old'))); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.events.length, 0); assert.equal(f.clears.length, 0);
  } finally { await f.monitor.close(); }
});

const nativeRead = (scopeKey, unread = []) => ({ status: 'available', canReadUnread: true, scopeKey, unreadThreadIds: new Set(unread) });
test('desktop read clears only an emitted completion after a continuous valid same-scope unread to read transition', async () => {
  let receipt = nativeRead('scope-a');
  const f = fixture({ readState: async () => receipt }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('live'))); s.publish(state(threadId, turn('live', 'completed')));
    const completed = f.events[0]; assert.equal(completed.kind, 'completed');
    await f.monitor.poll(); await flush(); assert.equal(f.clears.length, 0, 'baseline false is not proof of read');
    receipt = nativeRead('scope-a', [threadId]); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 0);
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.deepEqual(f.clears.map(event => [event.threadId, event.eventId, event.reason]), [[threadId, completed.eventId, 'desktop-read']]);
    await f.monitor.poll(); await flush(); assert.equal(f.clears.length, 1);
  } finally { await f.monitor.close(); }
});

test('scope changes, missing native state and initial historical completions cannot infer desktop read', async () => {
  let receipt = nativeRead('scope-a', [threadId]);
  const f = fixture({ readState: async () => receipt }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('live'))); s.publish(state(threadId, turn('live', 'completed')));
    receipt = nativeRead('scope-b'); await f.monitor.poll(); await flush(); assert.equal(f.clears.length, 0);
    receipt = nativeRead('scope-b', [threadId]); await f.monitor.poll(); await flush();
    receipt = { status: 'unavailable' }; await f.monitor.poll(); await flush();
    receipt = nativeRead('scope-b'); await f.monitor.poll(); await flush(); assert.equal(f.clears.length, 0);
    receipt = nativeRead('scope-b', [threadId]); await f.monitor.poll(); await flush();
    const before = f.clears.length; await f.monitor.close(); receipt = nativeRead('scope-b'); await f.monitor.poll();
    assert.equal(f.clears.length, before); assert.equal(f.monitor.nativeReadState, null);
  } finally { await f.monitor.close(); }
  const historical = fixture({ readState: async () => receipt });
  receipt = nativeRead('scope-c', [threadId]); historical.monitor.start(); await flush();
  try {
    historical.sessions[0].publish(state(threadId, turn('history', 'completed')));
    receipt = nativeRead('scope-c'); await historical.monitor.poll(); await flush();
    assert.equal(historical.clears.length, 0);
  } finally { await historical.monitor.close(); }
});

test('a previous turn unread observation cannot authorize clearing a new completion before its own unread scan', async () => {
  let receipt = nativeRead('scope-a', [threadId]);
  const f = fixture({ readState: async () => receipt }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('new'))); s.publish(state(threadId, turn('new', 'completed')));
    const completed = f.events[0]; assert.equal(completed.kind, 'completed');
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 0, 'the true sample was taken before this completion event');
    receipt = nativeRead('scope-a', [threadId]); await f.monitor.poll(); await flush();
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.deepEqual(f.clears.map(value => value.eventId), [completed.eventId]);
  } finally { await f.monitor.close(); }
});

test('an in-flight native unread scan cannot acknowledge a completion emitted after the scan began', async () => {
  let receipt = nativeRead('scope-a'), pending = null, resolveRead;
  const f = fixture({ readState: () => pending ?? Promise.resolve(receipt) });
  f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('new')));
    pending = new Promise(resolve => { resolveRead = resolve; });
    const poll = f.monitor.poll();
    s.publish(state(threadId, turn('new', 'completed')));
    const completed = f.events[0]; assert.equal(completed.kind, 'completed');
    resolveRead(nativeRead('scope-a', [threadId])); pending = null;
    await poll; await flush();
    assert.equal(f.monitor.records.get(threadId).unreadSeen, null, 'the delayed sample predates this event');
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 0, 'a false sample after the stale true sample cannot clear the new event');
    receipt = nativeRead('scope-a', [threadId]); await f.monitor.poll(); await flush();
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.deepEqual(f.clears.map(value => value.eventId), [completed.eventId]);
  } finally { await f.monitor.close(); }
});

test('replacement completion resets unread evidence and a new scope false sample cannot clear it', async () => {
  let receipt = nativeRead('scope-a');
  const f = fixture({ readState: async () => receipt }); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0]; s.publish(state(threadId, turn('first'))); s.publish(state(threadId, turn('first', 'completed')));
    receipt = nativeRead('scope-a', [threadId]); await f.monitor.poll(); await flush();
    assert.ok(f.monitor.records.get(threadId).unreadSeen);
    f.advance(1000); f.rows[0].recency++; await f.monitor.poll(); await flush();
    const next = f.sessions[1]; next.publish(state(threadId, { ...turn('second', 'completed'), turnStartedAtMs: 1794382001000 }));
    assert.equal(f.events.length, 2); assert.equal(f.monitor.records.get(threadId).unreadSeen, null);
    receipt = nativeRead('scope-a'); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 0);
    receipt = nativeRead('scope-a', [threadId]); await f.monitor.poll(); await flush();
    receipt = nativeRead('scope-b'); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 0); assert.equal(f.monitor.records.get(threadId).unreadSeen, null);
    receipt = nativeRead('scope-b', [threadId]); await f.monitor.poll(); await flush();
    receipt = nativeRead('scope-b'); await f.monitor.poll(); await flush();
    assert.equal(f.clears.length, 1); assert.equal(f.clears[0].eventId, f.events[1].eventId);
  } finally { await f.monitor.close(); }
});


function questionAnswer(itemId, { type = 'userMessage', ...rest } = {}) {
  return { type, id: 'answer-' + itemId, content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', itemId, 0]), question: 'Continue?', answer: 'Yes' }]) + '\n</send_user_message_question_reply>' }], ...rest };
}
function canonicalQuestions(turns, { islands, boundary = 'exhausted' } = {}) {
  return {
    ...state(threadId, null),
    turnHistory: { kind: 'canonical', history: {
      isComplete: false,
      islands: islands ?? [{ newerBoundary: { status: boundary }, entries: turns.map(turn => ({ value: turn.turnId })) }],
      entitiesByKey: Object.fromEntries(turns.map(turn => [turn.turnId, turn])),
    } },
  };
}

test('async reminder survives later turns and unknown history, never re-notifies, and resolves only on a proven accepted answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0], question = { type: 'agentMessage', id: 'old-question', questions: [{ title: 'Continue?', options: ['Yes'] }] };
    s.publish(canonicalQuestions([turn('question-turn')]));
    const asked = turn('question-turn', 'completed', [question]);
    s.publish(canonicalQuestions([asked]));
    assert.equal(f.events.length, 1);
    const eventId = f.events[0].eventId;
    const later = turn('later-turn', 'completed');
    s.publish(canonicalQuestions([asked, later]));
    assert.equal(f.events.length, 1); assert.equal(f.clears.length, 0);
    assert.ok(taskNotificationSummary(canonicalQuestions([asked, later])).controls.some(control => control.eventId === eventId));

    // Unknown gaps, incomplete live items and missing newest boundary cannot
    // prove the old question resolved, nor count as an ordinary completion.
    for (const unknown of [
      canonicalQuestions([asked, later], { islands: [
        { newerBoundary: { status: 'exhausted' }, entries: [{ value: asked.turnId }] },
        { newerBoundary: { status: 'exhausted' }, entries: [{ value: later.turnId }] },
      ] }),
      canonicalQuestions([asked, { ...later, itemsPagination: { hasLoadedOldest: false } }]),
      canonicalQuestions([asked, later], { boundary: 'available' }),
    ]) {
      s.publish(unknown); t.mock.timers.tick(250);
      assert.equal(f.clears.length, 0); assert.equal(f.events.length, 1);
      assert.equal(s.closed, undefined);
      s.publish(canonicalQuestions([asked, later])); t.mock.timers.tick(250);
      assert.equal(f.events.length, 1, 'regaining pending proof must not duplicate the system alert');
    }
    const optimistic = { ...later, remodexOptimisticPendingTurn: true, items: [questionAnswer(question.id)] };
    s.publish(canonicalQuestions([asked, optimistic])); t.mock.timers.tick(250);
    assert.equal(f.clears.length, 0); assert.equal(f.events.length, 1);
    const accepted = { ...later, items: [questionAnswer(question.id)] };
    s.publish(canonicalQuestions([asked, accepted])); t.mock.timers.tick(250);
    assert.deepEqual(f.clears.map(clear => [clear.eventId, clear.reason]), [[eventId, 'resolved']]);
    await flush();
    assert.equal(f.events.length, 1); assert.equal(s.closed, true);
  } finally { await f.monitor.close(); }
});

test('an accepted answer behind an incomplete canonical boundary does not clear a retained async event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0], question = { type: 'agentMessage', id: 'question', questions: [{ title: 'Continue?' }] };
    s.publish(canonicalQuestions([turn('asked')]));
    const asked = turn('asked', 'completed', [question]);
    s.publish(canonicalQuestions([asked]));
    const answered = turn('answered', 'completed', [questionAnswer(question.id)]);
    s.publish(canonicalQuestions([asked, answered], { boundary: 'available' })); t.mock.timers.tick(250);
    assert.equal(f.clears.length, 0); assert.equal(f.events.length, 1);
    s.publish(canonicalQuestions([asked, answered])); t.mock.timers.tick(250);
    assert.equal(f.clears.length, 1); assert.equal(f.events.length, 1);
  } finally { await f.monitor.close(); }
});


test('duplicate question identities across an unsafe island and safe suffix neither notify nor authorize resolution', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0], question = { type: 'agentMessage', id: 'duplicate-question', questions: [{ title: 'Continue?' }] };
    s.publish(canonicalQuestions([turn('asked')]));
    const asked = turn('asked', 'completed', [question]);
    const earlier = turn('unsafe', 'completed', [{ ...question }]);
    const latest = turn('answered', 'completed', [questionAnswer(question.id)]);
    const islands = [
      { newerBoundary: { status: 'exhausted' }, entries: [{ value: 'unsafe' }] },
      { newerBoundary: { status: 'exhausted' }, entries: [{ value: 'asked' }, { value: 'answered' }] },
    ];
    const ambiguous = canonicalQuestions([earlier, asked, latest], { islands });
    assert.deepEqual(taskNotificationSummary(ambiguous).controls, []);
    assert.deepEqual(taskNotificationSummary(ambiguous).resolvedAsyncControls, []);
    s.publish(canonicalQuestions([asked]));
    assert.equal(f.events.length, 1);
    s.publish(ambiguous); t.mock.timers.tick(250);
    assert.equal(f.clears.length, 0); assert.equal(f.events.length, 1);
    s.publish(canonicalQuestions([asked, latest])); t.mock.timers.tick(250);
    assert.equal(f.clears.length, 1);
  } finally { await f.monitor.close(); }
});

test('a historical baseline async question cannot turn unknown into a fresh completion notification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.monitor.start(); await flush();
  try {
    const s = f.sessions[0], question = { type: 'agentMessage', id: 'baseline-question', questions: [{ title: 'Continue?' }] };
    const asked = turn('asked', 'completed', [question]);
    s.publish(canonicalQuestions([asked]));
    const later = { ...turn('later', 'completed'), turnStartedAtMs: 1794382000000 };
    s.publish(canonicalQuestions([asked, later], { boundary: 'available' })); t.mock.timers.tick(250);
    assert.equal(f.events.length, 0); assert.equal(f.clears.length, 0); assert.equal(s.closed, undefined);
    s.publish(canonicalQuestions([asked, later])); t.mock.timers.tick(250);
    assert.equal(f.events.length, 0);
  } finally { await f.monitor.close(); }
});

test('native accepted steering answers follow their unique steered marker chronology', () => {
  const question = { type: 'agentMessage', id: 'ordered-question', questions: [{ title: 'Continue?' }] };
  const answer = questionAnswer(question.id, { type: 'steeringUserMessage', status: 'accepted', serverUserMessageId: 'server-answer' });
  answer.input = answer.content; delete answer.content;
  const beforeQuestion = canonicalQuestions([turn('asked', 'completed', [{ type: 'steered', id: 'server-answer' }, question, answer])]);
  assert.equal(taskNotificationSummary(beforeQuestion).controls.length, 1);
  assert.equal(taskNotificationSummary(beforeQuestion).resolvedAsyncControls.length, 0);
  const afterQuestion = canonicalQuestions([turn('asked', 'completed', [answer, question, { type: 'steered', id: 'server-answer' }])]);
  assert.equal(taskNotificationSummary(afterQuestion).controls.length, 0);
  assert.equal(taskNotificationSummary(afterQuestion).resolvedAsyncControls.length, 1);
});
