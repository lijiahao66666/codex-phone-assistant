// Loopback-only manual acceptance fixture. All Codex data and credentials are
// temporary; the model is simulated, while app-server, IPC and relay are real.
import { createServer, request as httpRequest } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { createPairedDesktopConnector } from '../src/pairing/paired-connector.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { listDesktopThreads, ThreadListChanges } from '../src/desktop/thread-list.mjs';
import { SidebarStatus } from '../src/desktop/sidebar-status.mjs';
import { readRolloutHistory } from '../src/desktop/rollout-history.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
if (!existsSync(binary)) throw new Error('Set CODEX_PHONE_TEST_BIN to an installed Codex CLI');
const dir = await mkdtemp(join(tmpdir(), 'codex-phone-browser-'));
const socketPath = join(dir, 'ipc.sock');
const modelRequests = [];
let runtime, relay, connector, proxy, closed = false;
const model = createServer((req, res) => {
  req.on('error', () => {}); res.on('error', () => {});
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    const value = JSON.parse(body), n = modelRequests.length + 1;
    modelRequests.push({ number: n, model: value.model, effort: value.reasoning?.effort });
    await delay(200);
    if (res.destroyed) return;
    const item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `隔离模型回复 ${n}：流程测试通过。`, annotations: [] }] };
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

async function waitIdle(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const thread = (await runtime.owner.request('thread/read', { threadId: id, includeTurns: true })).thread;
    if (thread?.status?.type === 'idle' && thread.turns.some(turn => turn.status === 'completed') && runtime.owner.runningThreads().length === 0) return;
    await delay(30);
  }
  throw new Error('Isolated seed chat did not become idle');
}

async function stop() {
  if (closed) return;
  closed = true;
  proxy?.closeAllConnections();
  if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
  await connector?.close();
  if (runtime) {
    try { await runtime.close(); }
    catch { await runtime.owner.close({ force: true }); runtime.router.close(); runtime.modelJournal.close(); runtime.router.journal.close(); }
  }
  await relay?.close(); model.closeAllConnections();
  if (model.listening) await new Promise(resolve => model.close(resolve));
  await rm(dir, { recursive: true, force: true });
  console.log('FIXTURE_STOPPED');
}

try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await writeFile(join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { project: { id: 'project', name: '手机助手隔离测试项目', rootPaths: [dir] } } }));
  const reserve = reserveServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const relayPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${relayPort}`, origin = `https://127.0.0.1:${relayPort}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  relay = createPairRelay({ origin, database: join(dir, 'relay.sqlite'), requestTimeoutMs: 20000 });
  await relay.listen(relayPort);
  const host = await (await post('/api/enroll', { name: '隔离 Mac（模拟模型）' })).json();
  const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
  const pairedResponse = await post('/api/pair', { qrToken: code.qrToken });
  if (pairedResponse.status !== 200) throw new Error('Fixture pairing failed');
  const paired = await pairedResponse.json();
  const cookie = pairedResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const credential = join(dir, 'host.json');
  await writeFile(credential, JSON.stringify({ hostId: host.hostId, secret: host.secret, origin: base }), { mode: 0o600 });
  const settings = ['model_provider="mock"', 'model="mock-model"', 'model_providers.mock.name="mock"', `model_providers.mock.base_url="http://127.0.0.1:${model.address().port}/v1"`, 'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"', 'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
  const startRuntime = async () => {
    runtime = await createOwnerRuntime({ hostId: host.hostId, codexHome: dir, dataDir: join(dir, 'assistant'), ownerOptions: {
      binary, cwd: dir, socketPath, startRouterWhenMissing: true, args: [...settings, 'app-server'],
      env: { ...process.env, HOME: dir, CODEX_HOME: dir, PHONE_TEST_KEY: 'test' },
    } });
  };
  await startRuntime();
  const historical = await runtime.router.create({ projectId: 'project', text: '隔离历史聊天：用于验证恢复后继续发送', requestId: randomUUID(), deviceId: paired.deviceId });
  await waitIdle(historical.threadId);
  await runtime.close(); runtime = null;
  await startRuntime();
  const live = await runtime.router.create({ projectId: 'project', text: '隔离实时聊天：用于验证模型切换和发送', requestId: randomUUID(), deviceId: paired.deviceId });
  await waitIdle(live.threadId);
  connector = await createPairedDesktopConnector({ credentialPath: credential, allowInsecureForTests: true, retryMs: 100,
    sidebarStatusForTests: new SidebarStatus({ createClient: () => new DesktopIpc({ socketPath }) }),
    threadListChangesForTests: new ThreadListChanges({ codexHome: dir }),
    ownerRouter: runtime.router, modelJournal: runtime.modelJournal, modelRequest: (method, params) => runtime.owner.request(method, params),
    listThreads: options => listDesktopThreads({ ...options, codexHome: dir }),
    readHistory: (id, options) => readRolloutHistory(id, { ...options, codexHome: dir }),
    createSession: ({ conversationId }) => new DesktopSession({ conversationId, retryBaseMs: 100, retryMaxMs: 500, createClient: () => new DesktopIpc({ socketPath }) }),
  });
  connector.start();
  // The acceptance browser uses plain loopback HTTP. Only this temporary proxy
  // supplies the already paired fixture's cookie and upstream origin headers.
  proxy = createServer((req, res) => {
    const ownPort = proxy.address().port;
    if (![`127.0.0.1:${ownPort}`, `localhost:${ownPort}`].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
    if (req.url === '/__fixture/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ historical: historical.threadId, live: live.threadId, modelRequests })); return;
    }
    if (req.url === '/__fixture/create-local-chat' && req.method === 'POST') {
      void runtime.router.create({ projectId: 'project', text: '电脑侧新增任务通知验收', requestId: randomUUID(), deviceId: paired.deviceId }).then(result => {
        res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      }).catch(() => { res.writeHead(500); res.end(); });
      return;
    }
    const forward = httpRequest({ hostname: '127.0.0.1', port: relayPort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${relayPort}`, origin, cookie, 'sec-fetch-site': 'same-origin' } }, upstream => {
      const outputHeaders = { ...upstream.headers }; delete outputHeaders['set-cookie'];
      res.writeHead(upstream.statusCode, outputHeaders); upstream.pipe(res);
      res.once('close', () => upstream.destroy());
    });
    forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(forward); res.once('close', () => forward.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  console.log(JSON.stringify({ fixtureUrl: `http://127.0.0.1:${proxy.address().port}/`, localhostUrl: `http://localhost:${proxy.address().port}/`, historicalThread: historical.threadId, liveThread: live.threadId, temporaryData: dir, model: 'loopback simulation', stop: 'Ctrl-C or SIGTERM to this fixture process' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
} catch (error) { await stop(); throw error; }
