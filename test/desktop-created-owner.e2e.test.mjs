import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../src/desktop/app-server-client.mjs';
import { LocalOwner } from '../src/desktop/local-owner.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { createCreatedThreadOwner } from '../src/desktop/created-thread-owner.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label) {
  const end = Date.now() + 10000;
  while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(5); }
}
const frame = value => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
};

// CLI writers and DesktopIpc framing/control are real. The native desktop IPC
// identity and opener are simulated; this does not claim to test its renderer.
test('created-thread adapter sends the first prompt only through a second real CLI writer', {
  timeout: 30000, skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN to run isolated CLI coverage',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-created-owner-'));
  const socketPath = join(directory, 'isolated-ipc.sock');
  const bodies = [], notifications = [], nativeControls = [], peers = new Set();
  let phone, desktop, nativeThread, opens = 0, bridgeSocket, delayedDiscovery, discoveries = 0, lateResponses = 0;
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; }); req.on('error', () => {}); res.on('error', () => {});
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const item = { id: 'isolated-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'isolated native reply', annotations: [] }] };
      const response = { id: 'isolated-response', object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [
        ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { output_index: 0, item }],
        ['response.output_item.done', { output_index: 0, item }],
        ['response.completed', { response }],
      ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      res.end();
    });
  });
  const ipcServer = net.createServer(socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE() + 4) {
        const length = bytes.readUInt32LE(), message = JSON.parse(bytes.subarray(4, length + 4));
        bytes = bytes.subarray(length + 4);
        if (message.type !== 'request') continue;
        const respond = (result, handledByClientId) => socket.write(frame({ type: 'response', requestId: message.requestId,
          resultType: 'success', result, ...(handledByClientId ? { handledByClientId } : {}) }));
        if (message.method === 'initialize') {
          const isBridge = message.params?.clientType !== 'codex-hub';
          if (isBridge) bridgeSocket = socket;
          respond({ clientId: isBridge ? 'isolated-bridge' : 'isolated-follower' });
        } else if (message.method === 'thread-owner-discovery') {
          discoveries++;
          if (discoveries === 1) {
            // A router request made before native registration can remain held
            // after the route has mounted. A short read probe must abandon it.
            delayedDiscovery = respond;
            continue;
          }
          if (delayedDiscovery) {
            // Deliver the old request after cancellation, ahead of the fresh
            // answer. The real framed client must ignore its stale owner.
            delayedDiscovery({ supportsUntrustedAppInput: true }, 'obsolete-owner');
            delayedDiscovery = undefined; lateResponses++;
          }
          respond({ supportsUntrustedAppInput: nativeThread === message.params.conversationId }, nativeThread ? 'isolated-native-desktop' : 'isolated-bridge');
        } else if (message.method === 'thread-follower-start-turn') {
          nativeControls.push(message);
          const { request, context } = message.params.turnStart;
          // Native Desktop inherits its collaboration mode separately from
          // top-level model/effort. App-server gives that mode precedence.
          // Deliberately conflict with the phone's first-turn selection so
          // forwarding the request unchanged cannot mask native inheritance.
          const nativeRequest = context.inheritThreadSettings === false ? request : {
            ...request, collaborationMode: { mode: 'default', settings: {
              model: 'native-default-model', reasoning_effort: 'low', developer_instructions: null,
            } },
          };
          desktop.request('turn/start', nativeRequest).then(result => respond(result, 'isolated-native-desktop'), error => {
            socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'error', error: error.message }));
          });
        }
      }
    });
  });
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => ipcServer.listen(socketPath, resolve));
    const config = ['model_provider="mock"', 'model="mock-model"', 'model_providers.mock.name="mock"',
      `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`,
      'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"',
      'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
    const common = { binary, cwd: directory, args: [...config, 'app-server'],
      env: { ...process.env, HOME: directory, CODEX_HOME: directory, PHONE_TEST_KEY: 'test' } };
    desktop = await new AppServerClient(common).initialize();
    desktop.on('outbound', (_raw, value) => { if (value.method) notifications.push(value); });
    phone = await new LocalOwner({ ...common, socketPath }).start();
    const phoneStarts = [];
    phone.client.on('inbound', (_raw, value) => { if (value.method === 'turn/start') phoneStarts.push(value); });
    const created = await phone.create({ cwd: directory, model: 'mock-model' });
    await until(() => phone.owner.isThreadOwned(created.id), 'phone initially owns empty thread');
    assert.ok(bridgeSocket);
    // A live phone viewer deliberately remains attached while prepare releases
    // the empty thread; no last-viewer departure is needed for initial handoff.
    bridgeSocket.write(frame({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'still-open-phone',
      params: { hostId: 'local', conversationId: created.id, following: true, remodexFollowerSource: 'codex-phone-assistant' } }));
    const adapter = createCreatedThreadOwner({ localOwner: phone,
      createClient: () => new DesktopIpc({ socketPath, timeout: 5000 }),
      openThread: async id => {
        opens++;
        assert.equal(phone.releasedThreads.has(id), true);
        assert.ok(!(await phone.request('thread/loaded/list', {})).data.includes(id));
        const saved = await desktop.request('thread/read', { threadId: id, includeTurns: true });
        assert.equal(await realpath(saved.thread.cwd), await realpath(directory)); assert.equal(saved.thread.turns.length, 0);
        assert.equal(saved.thread.name, 'first from an open phone', 'readable first-prompt title is persisted before native writer acquisition');
        await desktop.request('thread/resume', { threadId: id, excludeTurns: true });
        nativeThread = id;
      }, timeoutMs: 1000, pollMs: 5, discoveryProbeMs: 40 });
    await adapter.prepare(created.id, { title: 'first from an open phone' });
    assert.equal(lateResponses, 1, 'a cancelled discovery response arrived before the successful fresh answer');
    assert.equal(discoveries, 2, 'preparation retries the abandoned read without waiting for the global IPC timeout');
    await assert.rejects(phone.client.request('thread/resume', { threadId: created.id }), error => /active writer/i.test(error.message));
    await adapter.startTurn(created.id, 'first from an open phone', { model: 'mock-model', effort: 'high' });
    await until(() => notifications.some(message => message.method === 'turn/completed' && message.params?.threadId === created.id), 'native first turn completed');
    assert.equal(opens, 1, 'prepare and send open the native task only once');
    assert.equal(phoneStarts.length, 0, 'bridge never executes the first turn');
    assert.equal(nativeControls.length, 1);
    assert.equal(nativeControls[0].targetClientId, 'isolated-native-desktop');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, 'mock-model'); assert.equal(bodies[0].reasoning.effort, 'high');
    const history = await desktop.request('thread/read', { threadId: created.id, includeTurns: true });
    const users = history.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage');
    assert.equal(users.length, 1);
    assert.equal(users[0].clientId, nativeControls[0].params.turnStart.request.clientUserMessageId);
    assert.equal(phone.owner.isThreadOwned(created.id), false);
    t.diagnostic('Real bridge release and DesktopIpc guarded send target a separate real CLI writer; simulated native identity/opener, loopback model only.');
  } finally {
    await phone?.close({ force: true }); await desktop?.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => ipcServer.close(resolve));
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
