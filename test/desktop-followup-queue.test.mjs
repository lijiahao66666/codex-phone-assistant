import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalOwner } from '../src/desktop/local-owner.mjs';

const require = createRequire(import.meta.url);
const { createFrameReader, writeFrame } = require('remodex/src/desktop-ipc-shared');
const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(15); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function desktopFollower(socketPath) {
  const socket = net.createConnection(socketPath), pending = new Map(), broadcasts = [];
  socket.on('data', createFrameReader({ onFrame: frame => {
    if (frame.type === 'broadcast') broadcasts.push(frame);
    if (frame.type === 'response' && pending.has(frame.requestId)) { const callback = pending.get(frame.requestId); pending.delete(frame.requestId); callback(frame); }
  }, onOverflow: () => socket.destroy() }).push);
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let clientId = 'initializing-client';
  const request = (method, params, targetClientId) => new Promise((resolve, reject) => {
    const requestId = randomUUID(), timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timeout`)); }, 5000);
    pending.set(requestId, frame => { clearTimeout(timer); frame.resultType === 'success' ? resolve(frame) : reject(new Error(frame.error || 'IPC failure')); });
    writeFrame(socket, JSON.stringify({ type: 'request', method, params, requestId, sourceClientId: clientId, version: 1, ...(targetClientId ? { targetClientId } : {}) }));
  });
  try { clientId = (await request('initialize', { clientType: 'codex-desktop' })).result.clientId; } catch (error) { socket.destroy(); throw error; }
  return { request, broadcasts, close() { socket.destroy(); } };
}

test('desktop follow-ups run once when idle and after an active turn, and pending queues prevent normal quit', { timeout: 30000, skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN for isolated CLI integration' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-desktop-followups-')), socketPath = join(dir, 'ipc.sock');
  const prompts = [], gates = new Map(); let owner, follower;
  const mock = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('error', () => {}); res.on('error', () => {});
    req.on('end', async () => {
      const value = JSON.parse(body), last = value.input.filter(item => item?.role === 'user').at(-1);
      const text = last.content.map(item => item.text || '').join(''); prompts.push(text);
      const gate = gates.get(text); if (gate) await gate.promise;
      if (res.destroyed) return;
      const n = prompts.length, item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply ${n}`, annotations: [] }] };
      const response = { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }], ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }], ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }], ['response.completed', { type: 'response.completed', response }]]) res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  });
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const settings = ['model_provider="mock"', 'model="mock-model"', 'model_providers.mock.name="mock"', `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`, 'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"', 'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0'].flatMap(value => ['-c', value]);
    owner = await new LocalOwner({ binary, cwd: dir, socketPath, startRouterWhenMissing: true, args: [...settings, 'app-server'], env: { ...process.env, HOME: dir, CODEX_HOME: dir, PHONE_TEST_KEY: 'test' } }).start();
    const thread = await owner.create({ cwd: dir }); await owner.startTurn(thread.id, 'initial phone message');
    const idle = () => owner.runningThreads().length === 0;
    await until(idle, 'initial idle'); follower = await desktopFollower(socketPath);
    const discovery = await follower.request('thread-owner-discovery', { conversationId: thread.id, hostId: 'local' });
    const setQueue = messages => follower.request('thread-follower-set-queued-follow-ups-state', { conversationId: thread.id, state: { [thread.id]: messages } }, discovery.handledByClientId);
    const idleReply = await setQueue([{ id: 'idle-followup', context: { text: 'desktop idle followup' } }]); assert.equal(idleReply.result.ok, true);
    await until(() => prompts.includes('desktop idle followup') && idle(), 'idle follow-up completed');
    let release; const promise = new Promise(resolve => { release = resolve; }); gates.set('active phone message', { promise, release });
    await owner.startTurn(thread.id, 'active phone message'); await until(() => prompts.includes('active phone message'), 'active prompt');
    const runningReply = await setQueue([{ id: 'queued-followup', context: { text: 'desktop queued followup' } }]); assert.equal(runningReply.result.ok, true);
    assert.equal(prompts.includes('desktop queued followup'), false); assert.ok(owner.queuedThreads.has(thread.id));
    await assert.rejects(owner.close(), { code: 'tasks-active' }); assert.equal(owner.state, 'ready');
    release(); await until(() => prompts.includes('desktop queued followup') && idle(), 'queued follow-up completed');
    assert.equal(owner.queuedThreads.has(thread.id), false);
    assert.equal(prompts.filter(text => text === 'desktop idle followup').length, 1); assert.equal(prompts.filter(text => text === 'desktop queued followup').length, 1);
    const queues = follower.broadcasts.filter(frame => frame.method === 'thread-queued-followups-changed');
    assert.ok(queues.some(frame => frame.params.messages.some(item => item.id === 'queued-followup')));
    assert.equal(queues.at(-1).params.messages.length, 0);
    // A paused queue is work even while no model turn is running. It must not be lost on quit.
    await setQueue([{ id: 'paused', text: 'paused draft', pausedReason: 'user-paused' }]);
    assert.ok(owner.runningThreads().includes(thread.id)); await assert.rejects(owner.close(), { code: 'tasks-active' });
    await setQueue([]); await until(idle, 'cleared queue');
    await owner.close(); owner = null;
  } finally {
    for (const gate of gates.values()) gate.release(); follower?.close(); await owner?.close({ force: true });
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
