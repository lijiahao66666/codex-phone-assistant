import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPairedDesktopConnector } from '../src/pairing/paired-connector.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { TaskNotificationMonitor } from '../src/notifications/task-monitor.mjs';
import { generateVapidKeys } from '../src/notifications/push-service.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}

test('isolated real CLI approval reaches the notification delivery sink', { timeout: 45000, skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN to run the isolated CLI integration' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-phone-approval-push-'));
  const deliveries = [], events = [];
  let releaseModel, monitor, connector, runtime, relay, created, recency = 1;
  const gate = new Promise(resolve => { releaseModel = resolve; });
  const mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => { void (async () => {
      await gate;
      if (res.destroyed) return;
      const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd', sandbox_permissions: 'require_escalated', justification: 'Isolated approval test' }), status: 'completed' };
      const response = { id: 'resp_1', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }], ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }], ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }], ['response.completed', { type: 'response.completed', response }]]) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    })().catch(() => res.destroy()); });
  });
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const base = `http://127.0.0.1:${port}`, origin = `https://127.0.0.1:${port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    relay = createPairRelay({ origin, database: join(dir, 'relay.sqlite'), notifications: { database: ':memory:',
      vapidDetails: { subject: 'mailto:push@example.test', ...await generateVapidKeys() },
      sendNotification: async (_subscription, payload) => { deliveries.push(JSON.parse(payload)); return { statusCode: 201 }; },
    } });
    await relay.listen(port);
    const host = await (await post('/api/enroll', { name: 'Isolated approval notification' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken }); assert.equal(paired.status, 200);
    const phone = await paired.clone().json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const credential = join(dir, 'host.json'); await writeFile(credential, JSON.stringify({ hostId: host.hostId, secret: host.secret, origin: base }), { mode: 0o600 });
    const socketPath = join(dir, 'ipc.sock');
    const config = ['model_provider="mock"', 'model="mock-model"', 'approval_policy="on-request"', 'sandbox_mode="workspace-write"', 'model_providers.mock.name="mock"', `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`, 'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"', 'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
    runtime = await createOwnerRuntime({ hostId: host.hostId, codexHome: dir, dataDir: join(dir, 'assistant'), ownerOptions: { binary, cwd: dir, socketPath, startRouterWhenMissing: true, args: [...config, 'app-server'], env: { ...process.env, HOME: dir, CODEX_HOME: dir, PHONE_TEST_KEY: 'test' } } });
    created = await runtime.owner.create({ cwd: dir, model: 'mock-model' });
    const createSession = ({ conversationId, hostId }) => new DesktopSession({ conversationId, hostId, retryBaseMs: 20, createClient: () => new DesktopIpc({ socketPath, timeout: 1000 }) });
    connector = await createPairedDesktopConnector({ credentialPath: credential, allowInsecureForTests: true, retryMs: 25, ownerRouter: runtime.router, createSession,
      listThreads: async () => ({ projects: [], recent: [{ id: created.id, recency }] }),
      createNotificationMonitorForTests: options => (monitor = new TaskNotificationMonitor({ ...options, pollMs: 50, coalesceMs: 20, retryMs: 50,
        readState: async () => ({ status: 'unavailable' }), createProbeClient: () => new DesktopIpc({ socketPath, timeout: 1000 }),
        onEvent: event => { events.push(event); return options.onEvent(event); },
      })),
    });
    connector.start();
    const readHeaders = { cookie, 'sec-fetch-site': 'same-origin' };
    await until(async () => (await (await fetch(base + '/api/notifications', { headers: readHeaders })).json()).desktopReady, 'notification capability');
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: `https://web.push.apple.com/${randomUUID()}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const subscribed = await post('/api/notifications', { subscription }, { cookie }); assert.equal(subscribed.status, 200, await subscribed.clone().text());
    await until(() => monitor?.records.get(created.id)?.summary, 'initial monitor baseline');
    assert.equal(events.length, 0, 'initial history does not produce an approval');
    await runtime.owner.startTurn(created.id, 'run isolated command');
    recency++;
    await until(() => monitor.records.get(created.id)?.summary?.active && monitor.entries.has(created.id), 'monitor observing the active turn');
    releaseModel();
    await until(() => deliveries.some(value => value.kind === 'approval'), 'approval notification delivery');
    assert.equal(events.filter(value => value.kind === 'approval').length, 1);
    assert.equal(deliveries.length, 1);
    const delivered = deliveries[0];
    assert.equal(delivered.title, '任务等待审批'); assert.equal(delivered.threadId, created.id);
    assert.equal(delivered.hostId, host.hostId); assert.equal(delivered.deviceId, phone.deviceId);
    assert.equal(delivered.eventId, events[0].eventId);
    assert.equal(JSON.stringify(delivered).includes('pwd'), false, 'notification must not disclose the command');
    t.diagnostic('Real isolated CLI, follower IPC, monitor, connector and relay; model response and push transport are local test doubles. No iPhone delivery is claimed.');
  } finally {
    releaseModel(); await connector?.close();
    if (runtime) await runtime.close({ force: true }).catch(() => {});
    await relay?.close(); await new Promise(resolve => mock.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
