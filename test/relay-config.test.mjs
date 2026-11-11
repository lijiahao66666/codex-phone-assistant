import test from 'node:test';
import assert from 'node:assert/strict';
import { relayConfig } from '../src/relay/cli.mjs';

test('push diagnostics are explicitly opt-in and emit a single JSON line', t => {
  const env = { HUB_ORIGIN: 'https://relay.example.test', HUB_NOTIFICATIONS: '1', HUB_PUSH_SUBJECT: 'mailto:push@example.test', HUB_PUSH_PUBLIC_KEY: 'public-key', HUB_PUSH_PRIVATE_KEY: 'private-key' };
  assert.equal(relayConfig(env).notifications.onDelivery, undefined);
  assert.equal(relayConfig({ ...env, HUB_PUSH_DIAGNOSTICS: '0' }).notifications.onDelivery, undefined);
  assert.equal(relayConfig({ HUB_ORIGIN: env.HUB_ORIGIN, HUB_PUSH_DIAGNOSTICS: '1' }).notifications, undefined);
  assert.throws(() => relayConfig({ ...env, HUB_PUSH_DIAGNOSTICS: 'yes' }), /HUB_PUSH_DIAGNOSTICS/);
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  const result = { type: 'push-delivery', sent: 1, failed: 0, foreground: 0, skip: null };
  relayConfig({ ...env, HUB_PUSH_DIAGNOSTICS: '1' }).notifications.onDelivery(result);
  assert.deepEqual(output, [JSON.stringify(result)]);
  assert.equal(output[0].includes('\n'), false);
});
