import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { desktopView } from '../src/desktop/view.mjs';
import { makePage } from '../src/desktop/history-pagination.mjs';

const thread = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
async function fixture(turns) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let session;
  const connected = once(server, 'connection');
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), hostId: 'test-host', allowInsecureForTests: true,
    createSession() {
      session = new EventEmitter();
      session.status = 'ready'; session.revision = 1;
      session.value = { id: thread, title: 'Stream test', resumeState: 'resumed', turnsPagination: { hasLoadedOldest: true }, threadRuntimeStatus: { type: 'idle' }, turns };
      session.start = () => session.emit('state', { status: 'ready', value: session.value, revision: 1 });
      session.close = async () => {};
      return session;
    },
  });
  connector.start();
  const [peer] = await connected;
  const received = [], waiting = [];
  peer.on('message', raw => {
    const value = JSON.parse(raw); received.push(value);
    for (const check of [...waiting]) check(value);
  });
  const request = (value, match) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(check), 1); reject(new Error('stream response timeout: '+JSON.stringify(received.map(message => ({ type: message.type, event: message.event, id: message.id, ok: message.ok, code: message.code }))))); }, 5000);
    const check = message => { if (match(message)) { clearTimeout(timer); waiting.splice(waiting.indexOf(check), 1); resolve(message); } };
    waiting.push(check); peer.send(JSON.stringify(value));
  });
  return { received, request, session: () => session,
    async close() { await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); } };
}
const turn = (index, text) => ({ turnId: `turn-${index}`, status: 'completed', items: [{ id: `item-${index}`, type: 'agentMessage', text }] });

test('modern streams default to a recent history window when their optional header was omitted', async () => {
  const turns = [...Array.from({ length: 10 }, (_, index) => turn(index, 'x'.repeat(900 * 1024))), ...Array.from({ length: 3 }, (_, index) => turn(index + 10, `recent-${index}`))];
  const f = await fixture(turns);
  try {
    const event = await f.request({ type: 'request', id: 'view', conversationId: thread, path: `/api/threads/${thread}/events`, deviceId: device, viewDelta: 3 }, message => message.type === 'stream-error' || message.type === 'event' && message.event === 'state');
    assert.equal(event.type, 'event');
    assert.equal(event.event, 'state');
    assert.deepEqual(event.data.conversation.turns.map(value => value.id), ['turn-10', 'turn-11', 'turn-12']);
    assert.equal(event.data.conversation.history.available, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(event)) < 4096);
    assert.equal(f.session().historyWindow, true);
    const history = event.data.conversation.history;
    const expectedPage = makePage(desktopView(f.session().value), { historicalHash: history.historicalHash, before: history.cursor });
    const page = await f.request({ type: 'history-page', id: 'older', deviceId: device, conversationId: thread, before: history.cursor, historicalHash: history.historicalHash, validatePageHash: expectedPage.pageHash }, message => message.id === 'older');
    assert.equal(page.ok, true);
    assert.equal(page.data.authorized, true);
    assert.equal(page.data.pageHash, expectedPage.pageHash);
    assert.equal(f.received.some(message => message.type === 'stream-error'), false);
  } finally { await f.close(); }
});

test('small new chat streams remain complete and legacy streams retain their unpaged contract', async () => {
  for (const viewDelta of [1, 3]) {
    const f = await fixture([turn(0, 'First message')]);
    try {
      const event = await f.request({ type: 'request', id: 'view', path: `/api/threads/${thread}/events`, deviceId: device, viewDelta }, message => message.type === 'event' && message.event === 'state');
      assert.equal(event.data.conversation.history.complete, true);
      assert.equal(event.data.conversation.turns.length, 1);
      assert.equal(event.data.conversation.turns[0].items[0].text, 'First message');
      assert.equal(f.session().historyWindow, viewDelta === 3);
      assert.equal(f.received.some(message => message.type === 'stream-error'), false);
    } finally { await f.close(); }
  }
});


test('invalid small snapshots report a projection error instead of a size error', async () => {
  const f = await fixture([]);
  try {
    const pending = f.request({ type: 'request', id: 'view', path: `/api/threads/${thread}/events`, deviceId: device, viewDelta: 3 }, message => message.type === 'stream-error');
    // The initial snapshot is scheduled asynchronously after the mock session starts.
    while (!f.session()) await new Promise(resolve => setImmediate(resolve));
    f.session().value.turnHistory = { kind: 'canonical', history: { islands: [{}], entitiesByKey: {} } };
    f.session().emit('state', { status: 'ready', value: f.session().value, revision: 2 });
    const error = await pending;
    assert.equal(error.code, 'state-invalid');
    assert.equal(f.received.some(message => message.code === 'state-too-large'), false);
  } finally { await f.close(); }
});
