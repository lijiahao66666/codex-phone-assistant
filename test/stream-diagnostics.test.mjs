import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamDiagnostics } from '../src/common/stream-diagnostics.mjs';

const streamId = '11111111-1111-4111-8111-111111111111';
test('stream milestones are bounded, sanitized and closed against late callbacks', () => {
  const rows = []; let time = 100;
  const diagnostic = createStreamDiagnostics(streamId, row => rows.push(row), { now: () => time });
  diagnostic.mark('open'); time += 12.345;
  assert.equal(diagnostic.mark('first-ready', { bytes: 12, projectMs: -1, encodeMs: Infinity, payload: 'private message', threadId: streamId, path: '/private/path', chunked: true }), true);
  for (let i = 0; i < 1000; i++) diagnostic.mark('first-ready');
  assert.deepEqual(rows[1], { streamId, stage: 'first-ready', elapsedMs: 12.35, bytes: 12, chunked: true });
  assert.equal(diagnostic.mark('arbitrary-stage'), false);
  assert.equal(diagnostic.mark('closed'), true);
  assert.equal(diagnostic.pending('first-encoded'), false);
  assert.equal(diagnostic.mark('first-encoded'), false);
  assert.equal(rows.length, 3);
  for (const id of ['legacy-id', 'private title', null]) {
    createStreamDiagnostics(id, () => assert.fail('legacy IDs must not be logged')).mark('open');
  }
  const brokenSink = createStreamDiagnostics(streamId, () => { throw new Error('disk unavailable'); });
  assert.doesNotThrow(() => brokenSink.mark('open'));
  assert.equal(brokenSink.mark('open'), false);
});
