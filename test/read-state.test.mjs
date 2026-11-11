import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectDesktopReadState, readDesktopReadState } from '../src/desktop/read-state.mjs';

const key = (account, user) => createHash('sha256').update(JSON.stringify(['chatgpt', account, user])).digest('hex');
const local = `local:${'a'.repeat(64)}`, remote = `remote:${'b'.repeat(64)}`;
function fixture(unread = ['first']) {
  return {
    'electron-persisted-atom-state': { 'local-document-identity': { accountId: 'account', userId: 'user' } },
    'electron-thread-read-state-v1': { unreadByIdentity: {
      [key('account', 'user')]: { [local]: unread, [remote]: ['remote-thread'] },
      [key('another-account', 'user')]: { [local]: ['private-other-account'] },
    } },
  };
}

test('projects only the current account and unique local host without exposing account data', () => {
  const state = fixture(['first', 'first', 'second']);
  const result = projectDesktopReadState(state);
  assert.equal(result.status, 'available');
  assert.equal(result.canReadUnread, true);
  assert.equal(result.canMarkRead, false);
  assert.deepEqual([...result.unreadThreadIds], ['first', 'second']);
  assert.deepEqual(Object.keys(result).sort(), ['canMarkRead', 'canReadUnread', 'scopeKey', 'status', 'unreadThreadIds']);
  const firstScope = result.scopeKey;
  assert.match(firstScope, /^[a-f0-9]{64}$/);
  assert.equal(projectDesktopReadState(fixture([])).scopeKey, firstScope);
  state['electron-persisted-atom-state']['local-document-identity'].accountId = 'another-account';
  assert.notEqual(projectDesktopReadState(state).scopeKey, firstScope);
  assert.deepEqual([...projectDesktopReadState(state).unreadThreadIds], ['private-other-account']);
  state['electron-persisted-atom-state']['local-document-identity'].userId = 'another-user';
  assert.equal(projectDesktopReadState(state).status, 'unavailable');
});

test('ambiguous or malformed persisted scopes fail closed instead of reporting everything read', () => {
  for (const mutate of [
    s => { delete s['electron-persisted-atom-state']; },
    s => { s['electron-persisted-atom-state']['local-document-identity'].accountId = ''; },
    s => { delete s['electron-thread-read-state-v1']; },
    s => { delete s['electron-thread-read-state-v1'].unreadByIdentity[key('account', 'user')][local]; },
    s => { s['electron-thread-read-state-v1'].unreadByIdentity[key('account', 'user')][`local:${'c'.repeat(64)}`] = []; },
    s => { s['electron-thread-read-state-v1'].unreadByIdentity[key('account', 'user')][local] = 'invalid'; },
    s => { s['electron-thread-read-state-v1'].unreadByIdentity[key('account', 'user')][local] = ['first', null]; },
  ]) {
    const state = fixture(); mutate(state);
    const result = projectDesktopReadState(state);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.canReadUnread, false);
    assert.equal(result.canMarkRead, false);
    assert.equal(result.unreadThreadIds, undefined);
  }
});

test('reads the latest native state without writing and distinguishes missing state from an empty unread set', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-read-state-'));
  const path = join(codexHome, '.codex-global-state.json');
  try {
    assert.equal((await readDesktopReadState({ codexHome })).status, 'unavailable');
    const unread = JSON.stringify(fixture());
    await writeFile(path, unread);
    assert.deepEqual([...(await readDesktopReadState({ codexHome })).unreadThreadIds], ['first']);
    assert.equal(await readFile(path, 'utf8'), unread);
    await writeFile(path, JSON.stringify(fixture([])));
    const clean = await readDesktopReadState({ codexHome });
    assert.equal(clean.status, 'available');
    assert.equal(clean.unreadThreadIds.size, 0);
    assert.equal(clean.canMarkRead, false);
    await writeFile(path, '{incomplete');
    assert.equal((await readDesktopReadState({ codexHome })).status, 'unavailable');
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});
