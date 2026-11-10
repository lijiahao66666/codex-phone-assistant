import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSocketSendScheduler } from '../src/transport/ws-send-scheduler.mjs';

test('draining waits for socket send callbacks and rejects on disconnect', async () => {
  const callbacks = [], socket = { readyState: 1, send(_data, callback) { callbacks.push(callback); } };
  const scheduler = createWebSocketSendScheduler({ socket });
  scheduler.enqueueControl('one'); scheduler.enqueueControl('two');
  let drained = false; const drain = scheduler.drainControls().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks.length, 1); assert.equal(drained, false);
  callbacks.shift()(); await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks.length, 1); assert.equal(drained, false);
  callbacks.shift()(); await drain; assert.equal(drained, true);
  scheduler.enqueueControl('three'); await new Promise(resolve => setImmediate(resolve));
  const aborted = scheduler.drainControls(); scheduler.close(); await assert.rejects(aborted, /closed/);
});
