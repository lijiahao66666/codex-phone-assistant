import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listDesktopThreads } from '../src/desktop/thread-list.mjs';
import { createHash } from 'node:crypto';

test('lists only visible desktop user threads in assigned projects and paginates ties', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-hub-list-'));
  try {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, recency_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, cwd TEXT, attached_thread_parent_id TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)');
    insert.run('c', 'C', null, 100, 0, 'vscode', 'user', 'shown');
    insert.run('b', 'B', 'Renamed', 100, 0, 'vscode', 'agent_created_thread', 'shown');
    insert.run('a', 'A', null, 90, 0, 'vscode', 'user', 'shown');
    insert.run('x', 'Hidden', null, 200, 1, 'vscode', 'user', 'shown');
    insert.run('y', 'Subagent', null, 200, 0, '{"subagent":{}}', 'subagent', 'shown');
    db.prepare('INSERT INTO threads VALUES (?, ?, NULL, ?, 0, ?, ?, ?, NULL, ?)').run('attached', 'Attached', 300, 'vscode', 'user', 'shown', 'c');
    db.close();
    await writeFile(join(dir, '.codex-global-state.json'), JSON.stringify({
      'local-projects': { p: { id: 'p', name: 'Project' }, empty: { id: 'empty', name: 'Empty' } }, 'project-order': ['empty', 'p'],
      'thread-project-assignments': { c: { projectKind: 'local', projectId: 'p' } },
      'electron-persisted-atom-state': { 'sidebar-project-expanded-v1-codex:p': true },
      'projectless-thread-ids': ['b', 'a'],
    }));
    const first = await listDesktopThreads({ codexHome: dir, limit: 2 });
    assert.deepEqual(first.projects, [{ id: 'empty', name: 'Empty', expanded: false, threads: [] }, { id: 'p', name: 'Project', expanded: true, threads: [{ id: 'c', title: 'C', status: 'unknown' }] }]);
    assert.deepEqual(first.recent, [{ id: 'b', title: 'Renamed', status: 'unknown' }]);
    assert.deepEqual(first.nextCursor, { recency: 100, id: 'b' });
    const second = await listDesktopThreads({ codexHome: dir, limit: 2, before: first.nextCursor });
    assert.deepEqual(second.recent.map(item => item.id), ['a']);
    assert.equal(second.nextCursor, null);
    await assert.rejects(() => listDesktopThreads({ codexHome: dir, limit: 501 }), /invalid limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('only projects unread state for the current identity and unambiguous local host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-hub-unread-'));
  try {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, recency_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, cwd TEXT); INSERT INTO threads VALUES ('a','A',NULL,1,0,'vscode','user','shown',NULL)");
    db.close();
    const identity = { accountId: 'account', userId: 'user' };
    const identityKey = createHash('sha256').update(JSON.stringify(['chatgpt', identity.accountId, identity.userId])).digest('hex');
    const state = { 'electron-persisted-atom-state': { 'local-document-identity': identity }, 'electron-thread-read-state-v1': { unreadByIdentity: { [identityKey]: { [`local:${'a'.repeat(64)}`]: ['a'], [`remote:${'b'.repeat(64)}`]: ['other'] } } } };
    const path = join(dir, '.codex-global-state.json');
    await writeFile(path, JSON.stringify(state));
    assert.equal((await listDesktopThreads({ codexHome: dir })).recent[0].unread, true);
    state['electron-thread-read-state-v1'].unreadByIdentity[identityKey][`local:${'b'.repeat(64)}`] = ['a'];
    await writeFile(path, JSON.stringify(state));
    assert.equal((await listDesktopThreads({ codexHome: dir })).recent[0].unread, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unassigned threads use an unambiguous project directory and respect exclusions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-hub-roots-'));
  try {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, recency_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, cwd TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)');
    const base = join(dirname(dir), 'codex-hub-roots-fixture');
    const one = join(base, 'one');
    const nested = join(one, 'nested');
    const child = join(nested, 'child');
    const rows = [
      ['a', 'A', 9, one],
      ['b', 'B', 8, one],
      ['c', 'C', 7, nested],
      ['d', 'D', 6, `${one}-other`],
      ['e', 'E', 5, child],
      ['f', 'F', 4, child],
      ['g', 'G', 3, child],
      ['h', 'H', 2, join(child, 'deeper')],
    ];
    for (const [id, title, recency, cwd] of rows) insert.run(id, title, recency, 'vscode', 'user', 'shown', cwd);
    db.close();
    await writeFile(join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'One', rootPaths: [one] }, q: { id: 'q', name: 'Nested', rootPaths: [child] } }, 'projectless-thread-ids': ['b', 'g'], 'thread-project-assignments': { f: { projectKind: 'local', projectId: 'p' } } }));
    const result = await listDesktopThreads({ codexHome: dir });
    assert.deepEqual(result.projects[0].threads.map(thread => thread.id), ['a', 'c', 'f']);
    assert.deepEqual(result.projects[1].threads.map(thread => thread.id), ['e']);
    assert.deepEqual(result.recent.map(thread => thread.id), ['b', 'd', 'g', 'h']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
