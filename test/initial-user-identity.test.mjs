import test from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../src/desktop/vendor/remodex/desktop-ipc-conversation-adapter.cjs';
import { desktopView } from '../src/desktop/view.mjs';
import { fixture, threadId, until } from './helpers/owner-history-fixture.mjs';

const text = value => [{ type: 'text', text: value, text_elements: [] }];
const image = path => [{ type: 'localImage', path }];
const user = (id, content, clientId) => ({ type: 'userMessage', id, content, ...(clientId ? { clientId } : {}) });
const users = state => desktopView(state, { imageHandles: new Map([['/first.png', 'first-image'], ['/second.png', 'second-image']]) }).turns[0].items.filter(i => i.type === 'userMessage');

test('native follower starts without a client identity correlate the initial echo while retaining a genuine identical steer', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    const request = f.native('thread-follower-start-turn', { turnStart: { request: { threadId, input: text('你好') } } });
    await until(() => f.replyFor(request), 'native start acknowledgement');
    const start = f.requests.find(r => r.method === 'turn/start');
    assert.match(start.params.clientUserMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(f.state().turns[0].params.clientUserMessageId, start.params.clientUserMessageId);
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'native', items: [], itemsView: 'notLoaded', status: 'inProgress' } } });
    const initial = user('native-initial', text('你好'), start.params.clientUserMessageId);
    f.notify({ method: 'item/started', params: { threadId, turnId: 'native', item: initial } });
    f.notify({ method: 'item/completed', params: { threadId, turnId: 'native', item: initial } });
    f.notify({ method: 'item/completed', params: { threadId, turnId: 'native', item: user('native-steer', text('你好'), 'another-client') } });
    f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'native', itemsView: 'summary', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] } } });
    await until(() => f.state().turns[0]?.status === 'completed', 'native completion');
    assert.equal(f.state().turns.length, 1);
    assert.deepEqual(users(f.state()).map(i => i.text), ['你好', '你好']);
    assert.deepEqual(f.state().turns[0].items.filter(i => i.type === 'userMessage').map(i => i.id), ['native-steer']);
  } finally { await f.close(); }
});

test('native follower starts preserve a supplied client identity', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    const request = f.native('thread-follower-start-turn', { turnStart: { request: { threadId, input: text('hello'), clientUserMessageId: 'existing-client' } } });
    await until(() => f.replyFor(request), 'native identified start acknowledgement');
    assert.equal(f.requests.find(r => r.method === 'turn/start').params.clientUserMessageId, 'existing-client');
    assert.equal(f.state().turns[0].params.clientUserMessageId, 'existing-client');
  } finally { await f.close(); }
});

test('image-only initial prompt and a second image retain both attachments across completion', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    await f.local.startTurn(threadId, '', { attachments: [{ kind: 'image', path: '/first.png' }] });
    const initialClientId = f.requests.find(r => r.method === 'turn/start').params.clientUserMessageId;
    assert.match(initialClientId, /^[a-f0-9-]{36}$/);
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', items: [], itemsView: 'notLoaded', status: 'inProgress' } } });
    for (const item of [user('first', image('/first.png'), initialClientId), user('second', image('/second.png')), user('second', image('/second.png'))]) {
      f.notify({ method: 'item/completed', params: { threadId, turnId: 'active', item } });
    }
    f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'active', itemsView: 'summary', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] } } });
    await until(() => f.state().turns[0]?.status === 'completed', 'completed image turn');
    assert.deepEqual(f.state().turns[0].params.input, image('/first.png'));
    assert.deepEqual(users(f.state()).map(i => i.images), [['first-image'], ['second-image']]);
    assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test('a repeated initial text with distinct server or client identity survives, while replay stays singular', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    await f.local.write('turn/start', { threadId, input: text('repeat'), clientUserMessageId: 'first-client' });
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', items: [], itemsView: 'notLoaded', status: 'inProgress' } } });
    for (const item of [user('first', text('repeat'), 'first-client'), { type: 'reasoning', id: 'work', summary: [] },
      user('second', text('repeat'), 'second-client'), user('second', text('repeat'), 'second-client'),
      user('third', text('repeat')), user('first', text('repeat'), 'first-client')]) {
      f.notify({ method: 'item/completed', params: { threadId, turnId: 'active', item } });
    }
    f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'active', itemsView: 'summary', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] } } });
    await until(() => f.state().turns[0]?.status === 'completed', 'completed repeated input');
    assert.deepEqual(users(f.state()).map(i => i.text), ['repeat', 'repeat', 'repeat']);
    assert.deepEqual(f.state().turns[0].items.filter(i => i.type === 'userMessage').map(i => i.id), ['second', 'third']);
  } finally { await f.close(); }
});

test('hydrated initial identity survives snapshot rebuild and later identical messages', () => {
  const { buildConversationStateFromThread: build, applyAppServerMessageToConversationState: apply } = adapter;
  let state = build({ id: threadId, turns: [{ id: 'active', itemsView: 'full', items: [user('initial', image('/first.png'))] }] });
  state = build({ id: threadId, turns: [{ id: 'active', itemsView: 'summary', items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] }] }, { previous: state });
  const conversations = new Map([[threadId, state]]);
  for (const item of [user('initial', image('/first.png')), user('later', image('/first.png')), user('later', image('/first.png'))]) {
    apply({ conversations, shouldOwnThread: () => true, message: { method: 'item/completed', params: { threadId, turnId: 'active', item } } });
  }
  assert.deepEqual(users(state).map(i => i.images), [['first-image'], ['first-image']]);
  assert.deepEqual(state.turns[0].items.filter(i => i.type === 'userMessage').map(i => i.id), ['later']);
});

test('unidentified legacy echoes are retained instead of discarding a possible real repeat', () => {
  const { buildConversationStateFromThread: build, applyAppServerMessageToConversationState: apply } = adapter;
  const state = build({ id: threadId, turns: [{ id: 'active', items: [], status: 'inProgress' }] });
  state.turns[0].params.input = text('repeat');
  const conversations = new Map([[threadId, state]]);
  for (const item of [user('unknown', text('repeat')), user('unknown', text('repeat'))]) {
    apply({ conversations, shouldOwnThread: () => true, message: { method: 'item/completed', params: { threadId, turnId: 'active', item } } });
  }
  assert.deepEqual(users(state).map(i => i.text), ['repeat', 'repeat']);
  assert.deepEqual(state.turns[0].items.map(i => i.id), ['unknown']);
});

test('fresh authoritative hydration repairs an unidentified legacy initial prompt while warm cached params remain ambiguous', () => {
  const { buildConversationStateFromThread: build } = adapter;
  const cached = build({ id: threadId, turns: [{ id: 'legacy', items: [], status: 'completed' }] });
  cached.turns[0].params.input = text('hello');
  const authoritative = { id: threadId, turns: [{ id: 'legacy', status: 'completed', itemsView: 'full', items: [
    user('actual-initial', text('hello')),
    { type: 'agentMessage', id: 'answer', text: 'done' },
  ] }] };
  assert.equal(users(build(authoritative, { previous: cached })).length, 2, 'a warm rebuild cannot infer whether the uncorrelated item repeats its cached prompt');
  const fresh = build(authoritative);
  assert.equal(users(fresh).length, 1, 'a new owner with no cached prompt adopts the authoritative initial item');
  assert.equal(fresh.turns[0].remodexInitialUserMessageId, 'actual-initial');
});

test('a mismatching client identity cannot consume a pending initial echo', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    await f.local.write('turn/start', { threadId, input: text('repeat'), clientUserMessageId: 'initial-client' });
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', items: [], itemsView: 'notLoaded', status: 'inProgress' } } });
    // The initial server echo is absent from this observer; the first visible
    // item is a genuine follow-up with a different client identity.
    for (const item of [user('follow-up', text('repeat'), 'different-client'), user('initial', text('repeat'), 'initial-client')]) {
      f.notify({ method: 'item/completed', params: { threadId, turnId: 'active', item } });
    }
    await until(() => f.state().turns[0]?.items.some(i => i.id === 'follow-up'), 'uncorrelated follow-up');
    assert.deepEqual(users(f.state()).map(i => i.text), ['repeat', 'repeat']);
    assert.deepEqual(f.state().turns[0].items.map(i => i.id), ['follow-up']);
  } finally { await f.close(); }
});

test('legacy events without server IDs use client identity when available and otherwise retain ambiguous input', () => {
  const { buildConversationStateFromThread: build, applyAppServerMessageToConversationState: apply } = adapter;
  const state = build({ id: threadId, turns: [{ id: 'active', items: [], status: 'inProgress' }] });
  state.turns[0].params.input = text('initial');
  const conversations = new Map([[threadId, state]]);
  for (const item of [user(undefined, text('with client'), 'client'), user(undefined, text('with client'), 'client'),
    user(undefined, image('/first.png')), user(undefined, image('/second.png'))]) {
    apply({ conversations, shouldOwnThread: () => true, message: { method: 'item/completed', params: { threadId, turnId: 'active', item } } });
  }
  assert.equal(users(state).length, 4);
  assert.deepEqual(users(state).map(i => i.images), [undefined, undefined, ['first-image'], ['second-image']]);
});

test('a missing initial echo cannot consume an identical follow-up without client identity', async () => {
  for (const legacyStart of [false, true]) {
    const f = await fixture({ data: [], nextCursor: null });
    try {
      await f.resume();
      if (legacyStart) await f.local.write('turn/start', { threadId, input: text('repeat') });
      else await f.local.startTurn(threadId, 'repeat');
      f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', items: [], itemsView: 'notLoaded', status: 'inProgress' } } });
      f.notify({ method: 'item/completed', params: { threadId, turnId: 'active', item: user('actual-follow-up', text('repeat')) } });
      // Follow with completion so observing no new item is also a definitive
      // failure, rather than relying on a negative timing assertion.
      f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'active', itemsView: 'summary', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] } } });
      await until(() => f.state().turns[0]?.status === 'completed', 'unidentified follow-up completion');
      assert.deepEqual(users(f.state()).map(i => i.text), ['repeat', 'repeat']);
      assert.deepEqual(f.state().turns[0].items.filter(i => i.type === 'userMessage').map(i => i.id), ['actual-follow-up']);
    } finally { await f.close(); }
  }
});
