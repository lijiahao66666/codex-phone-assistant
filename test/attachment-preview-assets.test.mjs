import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { serveAttachmentPreviewAsset } from '../src/transport/attachment-preview-assets.mjs';

test('preview asset handler serves compressed pinned modules with JavaScript MIME types', async () => {
  for (const url of ['/attachment-preview.mjs', '/pdf-parser.mjs?v=6.4.299', '/pdf-worker.mjs?v=6.4.299']) {
    let status, headers, body;
    const res = { writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } };
    assert.equal(await serveAttachmentPreviewAsset({ method: 'GET', url, headers: { 'accept-encoding': 'gzip' } }, res), true);
    assert.equal(status, 200);
    assert.equal(headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(headers['content-encoding'], 'gzip');
    assert.ok(gunzipSync(body).toString().includes('export'));
    assert.ok(body.length < 500000);
    assert.equal(headers['cache-control'], url.includes('?v=') ? 'private, max-age=86400' : 'no-store');
  }
});

test('preview asset handler never resolves arbitrary filesystem paths or accepts writes', async () => {
  const res = { writeHead() { assert.fail('Must not handle unknown assets'); }, end() { assert.fail('Must not handle unknown assets'); } };
  for (const url of ['/../package.json', '/pdf-worker.mjs?v=wrong', '/attachment-preview.mjs/../../package.json']) {
    assert.equal(await serveAttachmentPreviewAsset({ method: 'GET', url }, res), false);
  }
  assert.equal(await serveAttachmentPreviewAsset({ method: 'POST', url: '/attachment-preview.mjs' }, res), false);
});
