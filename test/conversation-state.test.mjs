import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationState } from '../src/desktop/conversation-state.mjs';

test('applies nested changes and array splice with Immer semantics', () => {
  const state = new ConversationState();
  const input = { turns: [{ text: 'a' }, { text: 'b' }] };
  assert.equal(state.accept('owner', { type: 'snapshot', revision: 3, conversationState: input }).status, 'ready');
  input.turns[0].text = 'external';
  const result = state.accept('owner', { type: 'patches', baseRevision: 3, revision: 4, patches: [
    { op: 'replace', path: ['turns', 0, 'text'], value: 'updated' },
    { op: 'remove', path: ['turns', 1] },
    { op: 'add', path: ['turns', 1], value: { text: 'c' } },
  ] });
  assert.deepEqual(result.value, { turns: [{ text: 'updated' }, { text: 'c' }] });
  assert.equal(result.revision, 4);
});

test('version gap and owner change clear state until a fresh snapshot', () => {
  const state = new ConversationState();
  state.accept('a', { type: 'snapshot', revision: 2, conversationState: { text: 'old' } });
  assert.equal(state.accept('a', { type: 'patches', baseRevision: 1, revision: 3, patches: [] }).reason, 'revision-gap');
  assert.equal(state.value, null);
  assert.equal(state.accept('a', { type: 'patches', baseRevision: 2, revision: 3, patches: [] }).reason, 'snapshot-required');
  state.accept('a', { type: 'snapshot', revision: 4, conversationState: {} });
  assert.equal(state.accept('b', { type: 'patches', baseRevision: 4, revision: 5, patches: [] }).reason, 'owner-changed');
  assert.equal(state.value, null);
  assert.equal(state.accept('b', { type: 'snapshot', revision: 0, conversationState: { text: 'new' } }).status, 'ready');
});

test('invalid patches and explicit disconnect invalidate cached data', () => {
  const state = new ConversationState();
  state.accept('a', { type: 'snapshot', revision: 1, conversationState: { nested: {} } });
  assert.equal(state.accept('a', { type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['missing', 'key'], value: 1 },
  ] }).reason, 'invalid-patches');
  assert.equal(state.value, null);
  state.accept('a', { type: 'snapshot', revision: 1, conversationState: {} });
  assert.equal(state.invalidate('disconnected').reason, 'disconnected');
  assert.equal(state.revision, null);
  assert.equal(state.value, null);
});
