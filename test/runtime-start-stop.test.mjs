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
      return { start() {}, async close() { closed++; } };
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
