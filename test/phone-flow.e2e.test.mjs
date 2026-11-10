import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { createPairedDesktopConnector } from '../src/pairing/paired-connector.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { desktopView } from '../src/desktop/view.mjs';
import { listDesktopThreads } from '../src/desktop/thread-list.mjs';
import { readRolloutHistory } from '../src/desktop/rollout-history.mjs';
import { createModelService } from '../src/desktop/model-service.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}

// Uses a real CLI process with an isolated home and a loopback model simulator.
// It never reads or resumes a task from the user's Codex home.
test('paired phone creates, switches model, sends and recovers a completed chat', { timeout: 60000, skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN to run the isolated CLI integration' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-phone-flow-'));
  const requestBodies = [];
  const nativeUserMessages = [], nativeStarts = [];
  let releaseFirstModel, enteredFirstModel;
  const firstModelEntered = new Promise(resolve => { enteredFirstModel = resolve; });
  const firstModelGate = new Promise(resolve => { releaseFirstModel = resolve; });
  const mock = createServer((req, res) => {
    let body = '';
    req.on('error', () => {}); res.on('error', () => {});
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      requestBodies.push(JSON.parse(body));
      const n = requestBodies.length;
      if (n === 1) { enteredFirstModel(); await firstModelGate; }
      if (res.destroyed) return;
      const item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `isolated reply ${n}`, annotations: [] }] };
      const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response }],
      ]) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  });
  let runtime, connector, relay, reader, reading;
  let latestSession, events = '';
  const socketPath = join(dir, 'ipc.sock');
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    await writeFile(join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { project: { id: 'project', name: 'Isolated project', rootPaths: [dir] } } }));
    const reserve = reserveServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const base = `http://127.0.0.1:${port}`, origin = `https://127.0.0.1:${port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    relay = createPairRelay({ origin, database: join(dir, 'relay.sqlite'), requestTimeoutMs: 15000 });
    await relay.listen(port);
    const enrolled = await post('/api/enroll', { name: 'Isolated Mac' }); assert.equal(enrolled.status, 201);
    const host = await enrolled.json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const pairing = await post('/api/pair', { qrToken: code.qrToken }); assert.equal(pairing.status, 200);
    const device = await pairing.json();
    const cookie = pairing.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const readHeaders = { cookie, 'sec-fetch-site': 'same-origin' };
    const credential = join(dir, 'host.json');
    await writeFile(credential, JSON.stringify({ hostId: host.hostId, secret: host.secret, origin: base }), { mode: 0o600 });
    const config = ['model_provider="mock"', 'model="mock-model"', 'model_providers.mock.name="mock"',
      `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`, 'model_providers.mock.wire_api="responses"',
      'model_providers.mock.env_key="PHONE_TEST_KEY"', 'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
    const start = async () => {
      runtime = await createOwnerRuntime({ hostId: host.hostId, codexHome: dir, dataDir: join(dir, 'assistant'),
        ownerOptions: { binary, cwd: dir, socketPath, startRouterWhenMissing: true, args: [...config, 'app-server'], env: { ...process.env, HOME: dir, CODEX_HOME: dir, PHONE_TEST_KEY: 'test' } } });
      runtime.owner.client.on('inbound', (_raw, message) => { if (message.method === 'turn/start') nativeStarts.push(message.params); });
      runtime.owner.client.on('outbound', (_raw, message) => { if (message.method === 'item/completed' && message.params?.item?.type === 'userMessage') nativeUserMessages.push(message.params.item); });
      connector = await createPairedDesktopConnector({ credentialPath: credential, allowInsecureForTests: true, retryMs: 25,
        ownerRouter: runtime.router, modelJournal: runtime.modelJournal, modelRequest: (method, params) => runtime.owner.request(method, params),
        listThreads: options => listDesktopThreads({ ...options, codexHome: dir }), readHistory: (id, options) => readRolloutHistory(id, { ...options, codexHome: dir }),
        createSession: ({ conversationId }) => (latestSession = new DesktopSession({ conversationId, retryBaseMs: 50, retryMaxMs: 100, createClient: () => new DesktopIpc({ socketPath, timeout: 1000 }) })) });
      connector.start();
      await until(async () => (await (await fetch(base + '/api/host-status', { headers: readHeaders })).json()).online, 'connector online');
    };
    const subscribe = async id => {
      events = '';
      const response = await fetch(`${base}/api/threads/${id}/events`, { headers: readHeaders, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      reader = response.body.getReader();
      reading = (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; events += new TextDecoder().decode(chunk.value); } } catch {} })();
    };
    const unsubscribe = async () => { await reader?.cancel().catch(() => {}); await reading; reader = null; };
    const completed = async (id, marker) => until(async () => {
      const thread = (await runtime.owner.request('thread/read', { threadId: id, includeTurns: true })).thread;
      return thread?.turns?.some(turn => turn.status === 'completed' && turn.items?.some(item => item.type === 'userMessage' && JSON.stringify(item).includes(marker)) && turn.items?.some(item => item.type === 'agentMessage' && JSON.stringify(item).includes('isolated reply')));
    }, `completed turn ${marker}`);

    await start();
    const modelsResponse = await fetch(base + '/api/models', { headers: readHeaders }); assert.equal(modelsResponse.status, 200);
    const catalog = (await modelsResponse.json()).models;
    const initial = catalog.find(item => item.supportedReasoningEfforts.length > 1); assert.ok(initial);
    const createdResponse = await post('/api/chats', { projectId: 'project', text: 'first isolated prompt', requestId: randomUUID(), model: initial.model, effort: initial.defaultReasoningEffort }, { cookie });
    assert.equal(createdResponse.status, 202, await createdResponse.clone().text());
    const { threadId } = await createdResponse.json();
    await firstModelEntered;
    assert.match(nativeStarts[0].clientUserMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(nativeUserMessages.find(item => JSON.stringify(item.content).includes('first isolated prompt'))?.clientId,
      nativeStarts[0].clientUserMessageId, 'real CLI preserves the initial client identity in its completed user item');
    await assert.rejects(runtime.close(), { code: 'tasks-active' });
    assert.equal(runtime.owner.state, 'ready', 'normal quit preserves an active phone-owned task');
    assert.equal(runtime.router.stopping, false, 'blocked quit restores normal routing');
    releaseFirstModel();
    await completed(threadId, 'first isolated prompt');
    const listed = await (await fetch(base + '/api/threads', { headers: readHeaders })).json();
    assert.ok([...listed.recent, ...listed.projects.flatMap(project => project.threads)].some(thread => thread.id === threadId), 'phone-created chat is listed');
    await subscribe(threadId);
    await until(() => events.includes('event: state') && latestSession?.value?.threadRuntimeStatus?.type === 'idle', 'live idle snapshot');
    assert.equal(desktopView(latestSession.value).turns[0].items.filter(item => item.type === 'userMessage' && item.text === 'first isolated prompt').length, 1, 'phone view retains the initial user bubble exactly once');
    const selected = catalog.find(item => item.model !== initial.model && item.supportedReasoningEfforts.length > 1); assert.ok(selected);
    const effort = selected.supportedReasoningEfforts.find(item => item !== selected.defaultReasoningEffort);
    const change = await post(`/api/threads/${threadId}/model`, { model: selected.model, effort }, { cookie });
    assert.equal(change.status, 202, await change.clone().text());
    await until(() => latestSession?.value?.latestCollaborationMode?.settings?.model === selected.model && latestSession.value.latestCollaborationMode.settings.reasoning_effort === effort, 'selected model snapshot');
    await until(async () => (await (await fetch(`${base}/api/threads/${threadId}/model-status`, { headers: readHeaders })).json()).locked === false, 'model confirmation unlock');
    const sent = await post(`/api/threads/${threadId}/messages`, { text: 'second isolated prompt' }, { cookie });
    assert.equal(sent.status, 202, await sent.clone().text());
    await completed(threadId, 'second isolated prompt');
    assert.equal(requestBodies[1].model, selected.model);
    assert.equal(requestBodies[1].reasoning.effort, effort);
    await until(() => latestSession?.value?.threadRuntimeStatus?.type === 'idle' && runtime.owner.runningThreads().length === 0, 'owner and IPC become idle before shutdown');
    // Exercise the production fresh-observer confirmation path with real IPC.
    // The loopback connector above allows HTTP, so its own test-mode service
    // deliberately omits this observer; this service does not omit it.
    const observers = [];
    const freshModels = createModelService({ hostId: host.hostId, journal: runtime.modelJournal,
      request: (method, params) => runtime.owner.request(method, params),
      sessionFor: (deviceId, id) => deviceId === device.deviceId && id === threadId ? latestSession : null,
      createObserver: id => {
        const observer = new DesktopSession({ conversationId: id, retryBaseMs: 50, retryMaxMs: 100,
          createClient: () => new DesktopIpc({ socketPath }) });
        observers.push(observer); return observer;
      } });
    try {
      const changed = await freshModels.change({ deviceId: device.deviceId, threadId, model: initial.model, effort: initial.defaultReasoningEffort });
      assert.equal(changed.status, 'accepted');
      assert.equal(observers.length, 1);
      assert.notEqual(observers[0], latestSession, 'confirmation uses its own fresh IPC subscription');
      await until(() => !freshModels.isLocked(threadId) && latestSession.value.latestCollaborationMode.settings.model === initial.model, 'fresh observer confirms and unlocks settings');
      assert.equal(observers[0].status, 'closed');
      assert.equal(runtime.modelJournal.get(host.hostId, threadId), null);
    } finally { await freshModels.close(); }
    await unsubscribe(); await connector.close(); connector = null;
    await runtime.close(); runtime = null;
    await start();
    await subscribe(threadId);
    await until(() => events.includes('event: history'), 'persisted history before recovery');
    const recovered = await post(`/api/threads/${threadId}/recover`, { requestId: randomUUID() }, { cookie });
    assert.equal(recovered.status, 202, await recovered.clone().text());
    await until(() => latestSession?.status === 'ready' && latestSession.value?.id === threadId && events.includes('event: state'), 'recovered live state');
    assert.equal(desktopView(latestSession.value).turns[0].items.filter(item => item.type === 'userMessage' && item.text === 'first isolated prompt').length, 1, 'restored history retains the original user bubble exactly once');
    const afterRecovery = await post(`/api/threads/${threadId}/messages`, { text: 'third isolated prompt after recovery' }, { cookie });
    assert.equal(afterRecovery.status, 202, await afterRecovery.clone().text());
    await completed(threadId, 'third isolated prompt after recovery');
    assert.equal(requestBodies[2].model, initial.model, 'fresh-observer model selection survives owner restart');
    assert.equal(requestBodies[2].reasoning.effort, initial.defaultReasoningEffort);
    await unsubscribe(); await subscribe(threadId);
    await until(() => events.includes('event: state') && events.includes('third isolated prompt after recovery'), 'reconnected message');
    const nativeFollower = new DesktopIpc({ socketPath });
    try {
      await nativeFollower.connect();
      await nativeFollower.startTurn(threadId, { request: { threadId, input: [{ type: 'text', text: 'native follower prompt without client identity', text_elements: [] }] }, context: { inheritThreadSettings: true } }, { expectedOwnerId: runtime.owner.ownerId() });
      await completed(threadId, 'native follower prompt without client identity');
      await until(() => latestSession?.value?.turns?.some(turn => turn.params?.input?.some(part => part.text === 'native follower prompt without client identity')), 'native follower prompt snapshot');
      const nativeStart = latestSession.value.turns.find(turn => turn.params?.input?.some(part => part.text === 'native follower prompt without client identity')).params;
      assert.match(nativeStart.clientUserMessageId, /^[a-f0-9-]{36}$/);
      assert.equal(nativeUserMessages.find(item => JSON.stringify(item.content).includes('native follower prompt without client identity'))?.clientId,
        nativeStart.clientUserMessageId, 'real CLI echoes the identity assigned to a native follower start');
      await until(() => latestSession?.value?.threadRuntimeStatus?.type === 'idle'
        && desktopView(latestSession.value).turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && item.text?.includes('isolated reply 4'))), 'native follower completion snapshot');
      assert.equal(desktopView(latestSession.value).turns.flatMap(turn => turn.items)
        .filter(item => item.type === 'userMessage' && item.text === 'native follower prompt without client identity').length, 1,
      'native follower prompt appears exactly once in the completed projection');
    } finally { await nativeFollower.close(); }
    t.diagnostic('Real isolated CLI, local relay and current connector exercised; model output is simulated.');
  } finally {
    releaseFirstModel();
    await reader?.cancel().catch(() => {}); await reading;
    await connector?.close();
    if (runtime) { try { await runtime.close(); } catch { await runtime.owner.close({ force: true }); runtime.router.close(); runtime.modelJournal.close(); runtime.router.journal.close(); } }
    await relay?.close(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
