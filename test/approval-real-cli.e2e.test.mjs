import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPairedDesktopConnector } from '../src/pairing/paired-connector.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { desktopView } from '../src/desktop/view.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}

for (const decision of ['accept', 'cancel']) test(`isolated real CLI approval via relay: ${decision}`, { timeout: 45000, skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN to run the isolated CLI integration' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-phone-approval-'));
  let calls = 0, commandFinished, terminal, nativeResponse, session, stream, reader, readLoop, connector, runtime, relay;
  const mock = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls++; const item = calls === 1
        ? { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd', sandbox_permissions: 'require_escalated', justification: 'Verify isolated approval' }), status: 'completed' }
        : { id: 'msg_2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
      const response = { id: `resp_${calls}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }], ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }], ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }], ['response.completed', { type: 'response.completed', response }]]) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  });
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const base = `http://127.0.0.1:${port}`, origin = `https://127.0.0.1:${port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    relay = createPairRelay({ origin, database: join(dir, 'relay.sqlite') }); await relay.listen(port);
    const host = await (await post('/api/enroll', { name: 'Isolated' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken }); assert.equal(paired.status, 200);
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const credential = join(dir, 'host.json'); await writeFile(credential, JSON.stringify({ hostId: host.hostId, secret: host.secret, origin: base }), { mode: 0o600 });
    const socketPath = join(dir, 'ipc.sock');
    const config = ['model_provider="mock"', 'model="mock-model"', 'approval_policy="on-request"', 'sandbox_mode="workspace-write"', 'model_providers.mock.name="mock"', `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`, 'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"', 'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
    runtime = await createOwnerRuntime({ hostId: host.hostId, codexHome: dir, dataDir: join(dir, 'assistant'), ownerOptions: { binary, cwd: dir, socketPath, startRouterWhenMissing: true, args: [...config, 'app-server'], env: { ...process.env, HOME: dir, CODEX_HOME: dir, PHONE_TEST_KEY: 'test' } } });
    runtime.owner.client.on('outbound', (_raw, message) => {
      if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') commandFinished = message.params.item;
      if (message.method === 'turn/completed') terminal = message.params.turn;
    });
    const sendRaw = runtime.owner.client.sendRaw.bind(runtime.owner.client);
    runtime.owner.client.sendRaw = raw => { const message = JSON.parse(raw); if (message.result?.decision) nativeResponse = message.result; return sendRaw(raw); };
    connector = await createPairedDesktopConnector({ credentialPath: credential, allowInsecureForTests: true, retryMs: 25, ownerRouter: runtime.router, createSession: ({ conversationId }) => (session = new DesktopSession({ conversationId, retryBaseMs: 20, createClient: () => new DesktopIpc({ socketPath, timeout: 1000 }) })) }); connector.start();
    const created = await runtime.owner.create({ cwd: dir, model: 'mock-model' });
    const readHeaders = { cookie, 'sec-fetch-site': 'same-origin' };
    await until(async () => (await (await fetch(base + '/api/host-status', { headers: readHeaders })).json()).online, 'host online');
    stream = await fetch(`${base}/api/threads/${created.id}/events`, { headers: readHeaders, signal: AbortSignal.timeout(30000) });
    assert.equal(stream.status, 200); reader = stream.body.getReader();
    readLoop = (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
    await until(() => session?.status === 'ready', 'session ready');
    await runtime.owner.startTurn(created.id, 'run command');
    const approval = await until(() => desktopView(session.value).requests.find(item => item.kind === 'command'), 'projected approval');
    assert.deepEqual(approval.decisions, ['accept', 'cancel']);
    const sent = await post(`/api/threads/${created.id}/approvals`, { requestId: approval.id, kind: 'command', decision }, { cookie });
    assert.equal(sent.status, 202, await sent.clone().text());
    await until(() => terminal, 'turn completed');
    assert.equal(terminal.status, decision === 'cancel' ? 'interrupted' : 'completed');
    if (decision === 'accept') { assert.equal(calls, 2); assert.equal(commandFinished?.exitCode, 0); }
    else assert.equal(calls, 1);
    assert.deepEqual(nativeResponse, { decision });
    t.diagnostic('Real isolated CLI, relay and IPC; model responses are simulated.');
  } finally {
    await reader?.cancel().catch(() => {}); await readLoop; await connector?.close();
    if (runtime) await runtime.close({ force: true }).catch(() => {});
    await relay?.close(); await new Promise(resolve => mock.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
