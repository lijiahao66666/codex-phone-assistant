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
  const context = { Promise, console, setTimeout, clearTimeout, process: { env: {}, platform: 'darwin' }, configPath: '/tmp/test', imagePreview: null,
    createOwnerRuntime: async () => ({ router: {}, async close() { runtimeClosed++; } }),
    createPairedDesktopConnector: async options => {
      starts++; await options.createOwnerRouter('test'); entered(); await gate;
      return { start() {}, beginShutdown() {}, cancelShutdown() {}, async close() { closed++; } };
    }, panel: { async close() {} } };
  runInNewContext(`let connector, ownerRuntime, stopping = false, stopChecking = false, startPromise, stopPromise; ${start} ${stop} globalThis.run = { startConnector, stop };`, context);
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

test('explicit exit bypasses task guards, closes connector first, and shares one shutdown', async () => {
  const source = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf('async function stop()'), source.indexOf('for (const signal of'));
  const calls = [];
  const connector = { beginShutdown() { assert.fail('explicit exit cannot use the busy-task guard'); }, async close() { calls.push('connector'); } };
  const ownerRuntime = { async close(options) { assert.equal(options.force, true); assert.deepEqual(calls, ['connector']); calls.push('owner'); } };
  const lines = [];
  const context = { connector, ownerRuntime, setTimeout, clearTimeout, panel: { async close() {} }, console: { log: value => lines.push(value), error: value => lines.push(value) } };
  runInNewContext(`let stopping = false, stopChecking = false, startPromise, stopPromise; ${stop} globalThis.runStop = stop;`, context);
  await Promise.all([context.runStop(), context.runStop()]);
  assert.deepEqual(calls, ['connector', 'owner']); assert.deepEqual(lines, []);
});

test('connector cleanup failure still force-closes the owner and panel', async () => {
  const source = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf('async function stop()'), source.indexOf('for (const signal of'));
  let ownerClosed = false, panelClosed = false;
  const context = { setTimeout, clearTimeout, connector: { async close() { throw new Error('drain failed'); } },
    ownerRuntime: { async close({ force }) { assert.equal(force, true); ownerClosed = true; } },
    panel: { async close() { panelClosed = true; } }, console: { error() {} } };
  runInNewContext(`let stopping = false, stopChecking = false, startPromise, stopPromise; ${stop} globalThis.runStop = stop;`, context);
  await context.runStop();
  assert.equal(ownerClosed, true); assert.equal(panelClosed, true);
});
