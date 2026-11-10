import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('shutdown waits for startup and concurrent starts share one connector', async () => {
  const source = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('function startConnector()'), source.indexOf('const panelManager ='));
  const stop = source.slice(source.indexOf('async function stop()'), source.indexOf("for (const signal of"));
  let release, entered, starts = 0, closed = 0, runtimeClosed = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const context = { Promise, console, process: { env: {}, platform: 'darwin' }, configPath: '/tmp/test', imagePreview: null,
    createOwnerRuntime: async () => ({ router: {}, async close() { runtimeClosed++; } }),
    createPairedDesktopConnector: async options => {
      starts++; await options.createOwnerRouter('test'); entered(); await gate;
      return { start() {}, beginShutdown() {}, cancelShutdown() {}, async close() { closed++; } };
    }, panel: { async close() {} } };
  runInNewContext(`let connector, ownerRuntime, stopping = false, stopChecking = false, startPromise; ${start} ${stop} globalThis.run = { startConnector, stop };`, context);
  const first = context.run.startConnector(), second = context.run.startConnector();
  await ready;
  const closing = context.run.stop();
  assert.equal(runtimeClosed, 0);
  release();
  await Promise.all([first, second, closing]);
  assert.equal(starts, 1);
  assert.equal(runtimeClosed, 1);
  assert.equal(closed, 1);
});

test('a blocked owner shutdown reopens the connector admission gate', async () => {
  const source = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf('async function stop()'), source.indexOf('for (const signal of'));
  let gated = false, calls = 0;
  const connector = { beginShutdown() { gated = true; }, cancelShutdown() { gated = false; }, async close() { calls++; } };
  const ownerRuntime = { async close() { throw Object.assign(new Error('busy'), { code: 'tasks-active' }); } };
  const lines = [];
  const context = { connector, ownerRuntime, panel: { async close() {} }, console: { log: value => lines.push(value) } };
  runInNewContext(`let stopping = false, stopChecking = false, startPromise; ${stop} globalThis.runStop = stop;`, context);
  await context.runStop();
  assert.equal(gated, false); assert.equal(calls, 0); assert.deepEqual(lines, ['STOP_BLOCKED']);
});
