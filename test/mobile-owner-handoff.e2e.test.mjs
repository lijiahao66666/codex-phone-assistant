import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../src/desktop/app-server-client.mjs';

const binary = process.env.CODEX_PHONE_TEST_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}

// Both real app-servers use a disposable home and a loopback model simulator.
// This never connects to the user's desktop IPC, reads a personal conversation,
// or restarts the installed assistant.
test('real CLI releases a phone writer before desktop resume, send and archive', {
  timeout: 60000,
  skip: !existsSync(binary) && 'Set CODEX_PHONE_TEST_BIN to run the isolated CLI integration',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-owner-handoff-'));
  const bodies = [], notifications = [], heldResponses = [];
  let holdNextResponse = false;
  const mock = createServer((req, res) => {
    let body = '';
    req.on('error', () => {}); res.on('error', () => {});
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const n = bodies.length;
      const item = { id: `message_${n}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: `isolated handoff reply ${n}`, annotations: [] }] };
      const response = { id: `response_${n}`, object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      const finish = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [type, payload] of [
          ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
          ['response.output_item.added', { output_index: 0, item }],
          ['response.output_item.done', { output_index: 0, item }],
          ['response.completed', { response }],
        ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
        res.end();
      };
      if (holdNextResponse) { holdNextResponse = false; heldResponses.push(finish); } else finish();
    });
  });
  let phone, desktop;
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const config = ['model_provider="mock"', 'model="mock-model"', 'model_providers.mock.name="mock"',
      `model_providers.mock.base_url="http://127.0.0.1:${mock.address().port}/v1"`,
      'model_providers.mock.wire_api="responses"', 'model_providers.mock.env_key="PHONE_TEST_KEY"',
      'model_providers.mock.request_max_retries=0', 'model_providers.mock.stream_max_retries=0']
      .flatMap(value => ['-c', value]);
    const createClient = async name => {
      const client = new AppServerClient({ binary, cwd: directory, args: [...config, 'app-server'],
        env: { ...process.env, HOME: directory, CODEX_HOME: directory, PHONE_TEST_KEY: 'test' } });
      client.on('outbound', (_raw, message) => { if (message.method) notifications.push({ name, ...message }); });
      await client.initialize(); return client;
    };
    phone = await createClient('phone');
    desktop = await createClient('desktop');
    const created = await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } });
    const threadId = created.thread.id;
    const input = text => [{ type: 'text', text, text_elements: [] }];
    const first = await phone.request('turn/start', { threadId, input: input('isolated phone prompt'), clientUserMessageId: randomUUID() });
    await until(() => notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
      && message.params?.threadId === threadId && message.params?.turn?.id === first.turn.id), 'phone turn completion');

    for (const method of ['thread/resume', 'thread/archive']) {
      await assert.rejects(desktop.request(method, { threadId }), error => {
        t.diagnostic(`${method} before release: ${JSON.stringify(error.rpcError)}`);
        return error.rpcError?.code === -32600 && /active writer/i.test(error.message);
      });
    }
    const released = await phone.request('thread/unsubscribe', { threadId });
    t.diagnostic(`thread/unsubscribe: ${JSON.stringify(released)}`);
    assert.ok(['unsubscribed', 'notSubscribed', 'notLoaded'].includes(released.status));
    await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
      && message.params?.threadId === threadId), 'idle phone writer closed');
    let resumed, conflictsAfterRelease = 0;
    const releaseStarted = Date.now();
    await until(async () => {
      try {
        resumed = await desktop.request('thread/resume', { threadId, excludeTurns: true,
          initialTurnsPage: { limit: 3, itemsView: 'summary', sortDirection: 'desc' } });
        return true;
      } catch (error) {
        if (error.rpcError?.code !== -32600 || !/active writer/i.test(error.message)) throw error;
        conflictsAfterRelease++; return false;
      }
    }, 'desktop writer after unsubscribe');
    t.diagnostic(`Writer acquired ${Date.now() - releaseStarted} ms after unsubscribe ACK, conflicts=${conflictsAfterRelease}`);
    assert.equal(resumed.thread.id, threadId);
    const second = await desktop.request('turn/start', { threadId, input: input('isolated desktop prompt'), clientUserMessageId: randomUUID() });
    await until(() => notifications.some(message => message.name === 'desktop' && message.method === 'turn/completed'
      && message.params?.threadId === threadId && message.params?.turn?.id === second.turn.id), 'desktop turn completion');
    assert.equal(bodies.length, 2, 'only one model turn runs per submitted prompt');
    const history = await desktop.request('thread/read', { threadId, includeTurns: true });
    const userText = history.thread.turns.flatMap(turn => turn.items)
      .filter(item => item.type === 'userMessage').map(item => item.content.filter(part => part.type === 'text').map(part => part.text).join(''));
    assert.deepEqual(userText, ['isolated phone prompt', 'isolated desktop prompt']);
    await desktop.request('thread/archive', { threadId });
    const archived = await desktop.request('thread/list', { archived: true });
    assert.ok(archived.data.some(thread => thread.id === threadId), 'desktop can archive the resumed phone-created thread');
    await t.test('legacy thread adopts zero-delay unload through resume and can be archived directly', async () => {
      const legacy = await desktop.request('thread/start', { cwd: directory, model: 'mock-model' });
      const legacyId = legacy.thread.id;
      const turn = await desktop.request('turn/start', { threadId: legacyId, input: input('legacy seed') });
      await until(() => notifications.some(message => message.name === 'desktop' && message.method === 'turn/completed'
        && message.params?.threadId === legacyId && message.params?.turn?.id === turn.turn.id), 'legacy persisted turn');
      await desktop.close(); desktop = await createClient('desktop');
      await phone.request('thread/resume', { threadId: legacyId, config: { thread_unload_delay_secs: 0 } });
      await phone.request('thread/unsubscribe', { threadId: legacyId });
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
        && message.params?.threadId === legacyId), 'legacy thread closed');
      await desktop.request('thread/archive', { threadId: legacyId });
      const listing = await desktop.request('thread/list', { archived: true });
      assert.ok(listing.data.some(thread => thread.id === legacyId));
      t.diagnostic('Legacy resume config releases writer; a separate desktop app-server archives without first resuming.');
    });

    await t.test('releasing idle A preserves another running phone thread B', async () => {
      const a = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      const seed = await phone.request('turn/start', { threadId: a, input: input('idle A seed') });
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
        && message.params?.threadId === a && message.params?.turn?.id === seed.turn.id), 'idle A seed');
      const b = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      holdNextResponse = true;
      const running = await phone.request('turn/start', { threadId: b, input: input('running B seed') });
      await until(() => heldResponses.length === 1, 'B model request held');
      await phone.request('thread/unsubscribe', { threadId: a });
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
        && message.params?.threadId === a), 'only A closes');
      await desktop.request('thread/archive', { threadId: a });
      await assert.rejects(desktop.request('thread/resume', { threadId: b }), error => /active writer/i.test(error.message));
      await assert.rejects(desktop.request('thread/archive', { threadId: b }), error =>
        error.rpcError?.code === -32600 && /active writer/i.test(error.message),
      'another app-server cannot archive the active writer thread');
      await assert.rejects(desktop.request('thread/delete', { threadId: b }), error =>
        error.rpcError?.code === -32600 && /active writer/i.test(error.message),
      'another app-server cannot delete the active writer thread');
      await desktop.request('thread/name/set', { threadId: b, name: 'readable first prompt title' });
      assert.equal((await desktop.request('thread/read', { threadId: b, includeTurns: true })).thread.name, 'readable first prompt title',
        'another frontend can update only the name while the original writer keeps running');
      assert.ok(!notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
        && message.params?.threadId === b && message.params?.turn?.id === running.turn.id));
      heldResponses.shift()();
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
        && message.params?.threadId === b && message.params?.turn?.id === running.turn.id), 'B continues to completion');
      const historyB = await phone.request('thread/read', { threadId: b, includeTurns: true });
      assert.equal(historyB.thread.turns.at(-1).status, 'completed');
      t.diagnostic('Idle A release/archive leaves B writer and active model request intact; B completes normally.');
    });

    await t.test('active unsubscribe defers actual release until turn completes', async () => {
      const activeId = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      holdNextResponse = true;
      await phone.request('turn/start', { threadId: activeId, input: input('direct active unsubscribe') });
      await until(() => heldResponses.length === 1, 'active model request held');
      const result = await phone.request('thread/unsubscribe', { threadId: activeId });
      assert.equal(result.status, 'unsubscribed');
      await assert.rejects(desktop.request('thread/resume', { threadId: activeId }), error => /active writer/i.test(error.message));
      assert.ok(!notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
        && message.params?.threadId === activeId), 'ACK alone is not a writer release while the turn runs');
      heldResponses.shift()();
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
        && message.params?.threadId === activeId), 'active thread closes after model completion');
      await desktop.request('thread/resume', { threadId: activeId, excludeTurns: true });
      const history = await desktop.request('thread/read', { threadId: activeId, includeTurns: true });
      assert.equal(history.thread.turns.at(-1).status, 'completed', 'unsubscribe does not cancel the active turn');
      t.diagnostic('Active unsubscribe ACK retains writer; thread/closed arrives only after the turn completes, then desktop acquires it.');
    });
    await t.test('direct own archive releases an idle default-config writer', async () => {
      const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model' })).thread.id;
      const seed = await phone.request('turn/start', { threadId: id, input: input('own idle archive') });
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
        && message.params?.threadId === id && message.params?.turn?.id === seed.turn.id), 'archive idle seed complete');
      const result = await phone.request('thread/archive', { threadId: id });
      t.diagnostic(`Own loaded idle archive result ${JSON.stringify(result)}`);
      await desktop.request('thread/unarchive', { threadId: id });
      const resumed = await desktop.request('thread/resume', { threadId: id, excludeTurns: true });
      assert.equal(resumed.thread.id, id);
      t.diagnostic('Own direct idle archive releases default-config writer; desktop unarchives and resumes.');
    });

    await t.test('direct own archive interrupts a running turn and releases its writer', async () => {
      const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      holdNextResponse = true;
      await phone.request('turn/start', { threadId: id, input: input('own running archive') });
      await until(() => heldResponses.length === 1, 'archive running model request');
      await phone.request('thread/archive', { threadId: id });
      const history = await desktop.request('thread/read', { threadId: id, includeTurns: true });
      assert.equal(history.thread.turns.at(-1).status, 'interrupted', 'archiving active work cancels it even before the model responds');
      heldResponses.shift()();
      await desktop.request('thread/unarchive', { threadId: id });
      const resumed = await desktop.request('thread/resume', { threadId: id, excludeTurns: true });
      assert.equal(resumed.thread.id, id);
      t.diagnostic('Direct running archive succeeds but interrupts the turn; desktop can unarchive and take its writer.');
    });
    await t.test('empty thread handoff persistence boundaries', async () => {
      for (const variant of ['default', 'explicit-durable', 'named', 'settings']) {
        const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 },
          ...(variant === 'explicit-durable' ? { ephemeral: false, historyMode: 'paginated' } : {}) })).thread.id;
        const beforeBodies = bodies.length;
        if (variant === 'named') await phone.request('thread/name/set', { threadId: id, name: 'isolated empty handoff' });
        if (variant === 'settings') await phone.request('thread/settings/update', { threadId: id, model: 'mock-model' });
        const listedBefore = await phone.request('thread/list', {});
        t.diagnostic(`${variant} empty listed=${listedBefore.data.some(thread => thread.id === id)}`);
        const result = await phone.request('thread/unsubscribe', { threadId: id });
        await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
          && message.params?.threadId === id), 'empty thread closed');
        assert.equal(result.status, 'unsubscribed');
        if (variant !== 'named') {
          await assert.rejects(desktop.request('thread/resume', { threadId: id, excludeTurns: true }), error =>
            error.rpcError?.code === -32600 && /no rollout found/.test(error.message));
          assert.equal(bodies.length, beforeBodies, 'unpersisted empty handoff never invokes the model');
          continue;
        }
        const resumed = await desktop.request('thread/resume', { threadId: id, excludeTurns: true });
        assert.equal(resumed.thread.id, id);
        const first = await desktop.request('turn/start', { threadId: id, input: input('desktop first prompt after empty handoff'), clientUserMessageId: randomUUID() });
        await until(() => notifications.some(message => message.name === 'desktop' && message.method === 'turn/completed'
          && message.params?.threadId === id && message.params?.turn?.id === first.turn.id), 'desktop first turn after empty handoff');
        assert.equal(bodies.length, beforeBodies + 1);
        const history = await desktop.request('thread/read', { threadId: id, includeTurns: true });
        const users = history.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage');
        assert.equal(users.length, 1);
        t.diagnostic(`${variant} empty thread transferred before any turn; desktop sent the sole first user message.`);
      }
    });
    await t.test('queue add on a loaded idle phone thread automatically starts the prompt', async () => {
      const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      await phone.request('thread/name/set', { threadId: id, name: 'isolated queued first prompt' });
      const messageId = randomUUID();
      holdNextResponse = true;
      await phone.request('thread/queue/add', { threadId: id, input: input('sole real queued first prompt'), clientUserMessageId: messageId });
      await until(() => heldResponses.length === 1, 'phone queue auto-start reaches simulated model');
      const ownQueue = await phone.request('thread/queue/list', { threadId: id });
      assert.equal(ownQueue.data.length, 0);
      const started = notifications.find(message => message.name === 'phone' && message.method === 'turn/started' && message.params?.threadId === id);
      assert.ok(started, 'loaded idle queue auto-starts on phone');
      heldResponses.shift()();
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'turn/completed'
        && message.params?.threadId === id && message.params?.turn?.id === started.params.turn.id), 'phone auto-started queue completes');
      t.diagnostic('Adding the first prompt while phone owns an idle loaded thread auto-starts it on phone.');
    });

    await t.test('unloaded phone queues the sole first prompt for another writer to auto-start', async () => {
      const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      await phone.request('thread/name/set', { threadId: id, name: 'isolated unloaded queue handoff' });
      await phone.request('thread/unsubscribe', { threadId: id });
      await until(() => notifications.some(message => message.name === 'phone' && message.method === 'thread/closed'
        && message.params?.threadId === id), 'empty writer released before queue');
      const beforeBodies = bodies.length;
      const messageId = randomUUID();
      const added = await phone.request('thread/queue/add', { threadId: id, input: input('native queued first prompt'), clientUserMessageId: messageId });
      assert.equal(added.queuedSubmission.clientUserMessageId, messageId);
      const loadedPhone = await phone.request('thread/loaded/list', {});
      assert.ok(!loadedPhone.data.includes(id), 'queue add does not reload the phone writer');
      const observer = await createClient('observer');
      try {
        const nativeQueue = await observer.request('thread/queue/list', { threadId: id, limit: 1 });
        assert.deepEqual(nativeQueue.data, [added.queuedSubmission], 'independent third app-server can read the queued input without acquiring its writer');
        assert.ok(!(await observer.request('thread/loaded/list', {})).data.includes(id));
      } finally { await observer.close(); }
      assert.equal(bodies.length, beforeBodies, 'queue add and independent queue read do not invoke the model');
      assert.ok(!notifications.some(message => message.name === 'phone' && message.method === 'turn/started'
        && message.params?.threadId === id));
      holdNextResponse = true;
      await desktop.request('thread/resume', { threadId: id, excludeTurns: true });
      await until(() => heldResponses.length === 1, 'desktop resume auto-start reaches simulated model');
      const started = notifications.find(message => message.name === 'desktop' && message.method === 'turn/started' && message.params?.threadId === id);
      assert.ok(started);
      heldResponses.shift()();
      await until(() => notifications.some(message => message.name === 'desktop' && message.method === 'turn/completed'
        && message.params?.threadId === id && message.params?.turn?.id === started.params.turn.id), 'desktop auto-started first turn completes');
      assert.equal(bodies.length, beforeBodies + 1, 'the first prompt executes exactly once');
      const history = await desktop.request('thread/read', { threadId: id, includeTurns: true });
      const users = history.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage');
      assert.equal(users.length, 1);
      assert.equal(users[0].clientId, messageId);
      assert.deepEqual(users[0].content.filter(part => part.type === 'text').map(part => part.text), ['native queued first prompt']);
      assert.equal((await desktop.request('thread/queue/list', { threadId: id })).data.length, 0);
      t.diagnostic('Name persists empty thread; unloaded phone queues sole real input without taking writer; third client reads queue; desktop resume auto-starts exactly one turn with exactly one user message.');
    });
    await t.test('an empty thread name cannot replace the persistence name', async () => {
      const id = (await phone.request('thread/start', { cwd: directory, model: 'mock-model', config: { thread_unload_delay_secs: 0 } })).thread.id;
      await assert.rejects(phone.request('thread/name/set', { threadId: id, name: '' }), error =>
        error.rpcError?.code === -32600 && /thread name must not be empty/.test(error.message));
    });
    t.diagnostic('Real isolated CLI writer lock, unsubscribe ACK, desktop continuation and archive exercised; model output simulated.');
  } finally {
    await phone?.close(); await desktop?.close();
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
