import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRolloutHistory, readRolloutHistory } from '../src/desktop/rollout-history.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('subagent history requires its actual parent and a matching session file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'subagent-history-'));
  const id = '12345678-1234-1234-1234-123456789012', parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', wrong = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  try {
    const sessions = join(home, 'sessions'); await mkdir(sessions);
    const path = join(sessions, 'child.jsonl');
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, path, 'Child', null, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } }), 'subagent'); db.close();
    await writeFile(path, [ { type: 'session_meta', payload: { id } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } }, { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'one', item: { type: 'AgentMessage', id: 'reply', content: [{ type: 'Text', text: 'result' }] } } } ].map(JSON.stringify).join('\n') + '\n');
    assert.equal((await readRolloutHistory(id, { codexHome: home, parentThreadId: parent })).turns[0].items[0].text, 'result');
    assert.equal(await readRolloutHistory(id, { codexHome: home, parentThreadId: wrong }), null);
    assert.equal(await readRolloutHistory(id, { codexHome: home }), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('reads only a matching indexed session inside the sessions directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rollout-history-'));
  const id = '12345678-1234-1234-1234-123456789012';
  const sessions = join(home, 'sessions'), path = join(sessions, 'alternate-rollout-name.jsonl');
  try {
    await mkdir(sessions);
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, path, 'Title', null, 'vscode', 'user');
    db.close();
    const records = [{ type: 'session_meta', payload: { id } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } }];
    await writeFile(path, records.map(JSON.stringify).join('\n') + '\n');
    assert.equal((await readRolloutHistory(id, { codexHome: home })).turns.length, 1);
    await writeFile(path, records.map(JSON.stringify).join('\n') + '\n' + '{"type":');
    assert.equal((await readRolloutHistory(id, { codexHome: home })).turns.length, 1);
    await writeFile(path, records.map(JSON.stringify).join('\n') + '\n' + '{"type":\n');
    assert.equal(await readRolloutHistory(id, { codexHome: home }), null);
    const old = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'old' }, padding: 'x'.repeat(1500) };
    const recent = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'recent' } };
    await writeFile(path, [records[0], old, recent].map(JSON.stringify).join('\n') + '\n');
    const tail = await readRolloutHistory(id, { codexHome: home, maxBytes: 1024 });
    assert.deepEqual(tail.turns.map(turn => turn.id), ['recent']);
    records[0].payload.id = 'different';
    await writeFile(path, records.map(JSON.stringify).join('\n') + '\n');
    assert.equal(await readRolloutHistory(id, { codexHome: home }), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('projects recorded messages without treating unfinished turns as live', () => {
  const event = payload => ({ type: 'event_msg', payload });
  const records = [
    event({ type: 'task_started', turn_id: 'one' }),
    event({ type: 'item_completed', thread_id: 'thread', turn_id: 'one', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'hello' }] } }),
    event({ type: 'item_completed', thread_id: 'thread', turn_id: 'one', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'reply' }] } }),
    event({ type: 'task_complete', turn_id: 'one' }),
    event({ type: 'task_started', turn_id: 'two' }),
    event({ type: 'item_completed', thread_id: 'other', turn_id: 'two', item: { type: 'AgentMessage', id: 'x', content: [{ type: 'Text', text: 'wrong thread' }] } }),
  ];
  const view = projectRolloutHistory(records, 'thread', 'Test');
  assert.deepEqual(view.turns.map(turn => turn.status), ['completed', 'unknown']);
  assert.deepEqual(view.turns[0].items.map(item => item.text), ['hello', 'reply']);
  assert.deepEqual(view.turns[1].items, []);
  assert.deepEqual(view.history, { complete: false, reason: 'recorded-history' });
});

test('deduplicates item events and preserves interrupted status', () => {
  const event = payload => ({ type: 'event_msg', payload });
  const item = { type: 'Reasoning', id: 'r', summary_text: ['summary'] };
  const view = projectRolloutHistory([
    event({ type: 'task_started', turn_id: 'one' }),
    event({ type: 'item_completed', turn_id: 'one', item }),
    event({ type: 'item_completed', turn_id: 'one', item }),
    event({ type: 'turn_aborted', turn_id: 'one' }),
  ], 'thread');
  assert.equal(view.turns[0].status, 'interrupted');
  assert.equal(view.turns[0].items.length, 1);
  assert.deepEqual(view.turns[0].items[0].summary, ['summary']);
});

test('retains recorded files, tools, subagent activity, and message phases without private payloads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recorded-activities-'));
  const id = '12345678-1234-1234-1234-123456789012', parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const nested = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  try {
    const sessions = join(home, 'sessions'); await mkdir(sessions);
    const path = join(sessions, 'activities.jsonl');
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, path, 'Child', null, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } }), 'subagent');
    db.close();
    const event = payload => ({ type: 'event_msg', payload: { thread_id: id, turn_id: 'one', ...payload } });
    const items = [
      { type: 'AgentMessage', id: 'comment', phase: 'commentary', content: [{ type: 'Text', text: 'Checking the file' }] },
      { type: 'FileChange', id: 'edit', status: 'completed', changes: { 'src/example.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-before\n+after', move_path: null } }, stdout: 'private stdout', stderr: 'private stderr' },
      { type: 'McpToolCall', id: 'tool', server: 'docs', tool: 'read', status: 'failed', arguments: { token: 'private-token' }, result: { text: 'private-result' } },
      { type: 'SubAgentActivity', id: 'child', kind: 'completed', agent_thread_id: nested, agent_path: '/root/review', model: 'private-model' },
      { type: 'CollabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed', agents_states: {}, receiver_agents: ['private-receiver'] },
      { type: 'AgentMessage', id: 'answer', phase: 'final_answer', content: [{ type: 'Text', text: 'Done' }] },
    ];
    await writeFile(path, [{ type: 'session_meta', payload: { id } }, event({ type: 'task_started' }), ...items.map(item => event({ type: 'item_completed', item })), event({ type: 'task_complete' })].map(JSON.stringify).join('\n') + '\n');
    const view = await readRolloutHistory(id, { codexHome: home, parentThreadId: parent });
    assert.deepEqual(view.turns[0].items, [
      { id: 'comment', type: 'agentMessage', text: 'Checking the file', phase: 'commentary' },
      { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: 'src/example.js', diff: '@@ -1 +1 @@\n-before\n+after' }] },
      { id: 'tool', type: 'mcpToolCall', status: 'failed', server: 'docs', tool: 'read' },
      { id: 'child', type: 'subAgentActivity', kind: 'completed', agentPath: '/root/review', agentThreadId: nested },
      { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agents: [] },
      { id: 'answer', type: 'agentMessage', text: 'Done', phase: 'final_answer' },
    ]);
    assert.equal(view.turns[0].status, 'completed');
    assert.deepEqual(view.history, { complete: false, reason: 'recorded-history' });
    assert.deepEqual(view.requests, []);
    assert.doesNotMatch(JSON.stringify(view), /private-|stdout|stderr|arguments|receiver_agents/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('recorded activity projection rejects invalid identities and ignores unverified nested fields', () => {
  const event = payload => ({ type: 'event_msg', payload: { turn_id: 'one', ...payload } });
  const items = [
    { type: 'SubAgentActivity', id: 'bad-kind', kind: 'private-kind', agent_thread_id: 'not-a-thread', agent_path: '/root/child' },
    { type: 'SubAgentActivity', id: 'safe-child', kind: 'started', agent_thread_id: 'not-a-thread', agent_path: { private: 'path' } },
    { type: 'FileChange', id: 'file', status: 'private-status', changes: { '': { unified_diff: 'omit empty path' }, 'valid.txt': { unified_diff: 42, private: 'payload' }, 'null.txt': null, 'array.txt': [] } },
    { type: 'McpToolCall', id: 'tool', status: { private: 'status' }, server: [], tool: 42, arguments: 'private-arguments' },
    { type: 'CollabAgentToolCall', id: 'collab', tool: 'wait', status: 'completed', agents_states: { '/root/known': { status: 'failed', private: 'payload' }, '/root/unknown': { status: 'private-status' }, '/root/invalid': 'private-value' } },
    { type: 'CollabAgentToolCall', id: 'array', tool: 'wait', agents_states: [{ status: 'completed' }] },
    { type: 'AgentMessage', id: 'message', phase: 'private-phase', content: [{ type: 'Text', text: 'Reply' }] },
    { type: 'UnknownTool', id: 'unknown', arguments: 'private-arguments' },
  ];
  const view = projectRolloutHistory([event({ type: 'task_started' }), ...items.map(item => event({ type: 'item_completed', item }))], 'thread');
  assert.deepEqual(view.turns[0].items, [
    { id: 'safe-child', type: 'subAgentActivity', kind: 'started', agentPath: '' },
    { id: 'file', type: 'fileChange', status: '', changes: [{ path: 'valid.txt' }] },
    { id: 'tool', type: 'mcpToolCall', status: '', server: '', tool: '' },
    { id: 'collab', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agents: [{ id: '/root/known', status: 'failed' }, { id: '/root/unknown', status: '' }] },
    { id: 'array', type: 'collabAgentToolCall', tool: 'wait', status: '', agents: [] },
    { id: 'message', type: 'agentMessage', text: 'Reply' },
  ]);
  assert.equal(view.turns[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(view), /private-|not-a-thread|UnknownTool/);
});

test('reads projected history when rollout is missing and never exposes it as active', async () => {
  const home = await mkdtemp(join(tmpdir(), 'projected-history-'));
  const id = '12345678-1234-1234-1234-123456789012';
  try {
    const state = new DatabaseSync(join(home, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT)');
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, join(home, 'missing.jsonl'), 'Title', null, 'vscode', 'user');
    state.close();
    const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    history.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, rollout_ordinal INTEGER); CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_json TEXT, rollout_ordinal INTEGER)');
    history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)').run(id, 'turn', 'inProgress', 1, 1);
    history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)').run(id, 'turn', JSON.stringify({ type: 'agentMessage', id: 'item', text: 'saved' }), 1);
    for (let i = 0; i < 8; i++) history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)').run(id, 'turn', JSON.stringify({ type: 'agentMessage', id: `large-${i}`, text: 'x'.repeat(100000) }), i + 2);
    history.close();
    const view = await readRolloutHistory(id, { codexHome: home });
    assert.equal(view.turns[0].status, 'unknown');
    assert.equal(view.turns[0].items.at(-1).id, 'large-7');
    assert.ok(view.turns[0].items.length < 9);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 512 * 1024);
    assert.equal(view.history.complete, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
