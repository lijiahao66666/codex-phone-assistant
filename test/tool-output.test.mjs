import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lazyToolOutputs, toolOutputPage } from '../src/desktop/tool-output.mjs';

const command = output => ({ type: 'commandExecution', id: 'item', command: 'true', output });
const view = output => ({ id: 'thread', turns: [{ id: 'turn', items: [command(output)] }] });

test('inline byte threshold preserves source and all tool metadata', () => {
  const small = view('x'.repeat(4096));
  assert.deepEqual(lazyToolOutputs(small), small);
  const full = view('中'.repeat(1366)), before = structuredClone(full), lazy = lazyToolOutputs(full);
  assert.deepEqual(full, before);
  assert.equal(lazy.turns[0].items[0].outputRef.bytes, 4098);
  assert.equal(lazy.turns[0].items[0].command, 'true');
  assert.equal('output' in lazy.turns[0].items[0], false);
});

test('mixed coalesced turn keys must be globally unique even outside the recent window', () => {
  const full = view('x'.repeat(5000));
  full.turns.unshift({ id: 'older', viewKey: 'turn', items: [] });
  const recent = { ...full, turns: full.turns.slice(1) };
  assert.equal(lazyToolOutputs(recent, full), recent);
  assert.throws(() => toolOutputPage(full, { conversationId: 'thread', turnKey: 'turn', itemId: 'item', hash: createHash('sha256').update('x'.repeat(5000)).digest('hex'), offset: 0 }));
  full.turns[0] = { id: null, items: [] };
  assert.equal(lazyToolOutputs(recent, full), recent);
});
