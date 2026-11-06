import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('malformed history stream is cancelled rather than left downloading', async () => {
  const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function readHistoryPage('), source.indexOf("loadEarlier.addEventListener('click'"));
  const factory = new Function('StateChunkAssembler', `${code.replace("const { StateChunkAssembler } = await import('/state-chunks.mjs');", '')}; return readHistoryPage;`);
  const read = factory(class { cancel() {} });
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('not-json\n')); }, cancel() { cancelled = true; } });
  const response = { ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body };
  await assert.rejects(read(response, new AbortController().signal));
  assert.equal(cancelled, true);
});

test('invalid streaming response closes the actual HTTP request', async () => {
  const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function readHistoryPage('), source.indexOf("loadEarlier.addEventListener('click'"));
  const read = new Function('StateChunkAssembler', `${code.replace("const { StateChunkAssembler } = await import('/state-chunks.mjs');", '')}; return readHistoryPage;`)(class { cancel() {} });
  let markClosed;
  const closed = new Promise(resolve => { markClosed = resolve; });
  const server = createServer((req, res) => { res.on('close', markClosed); res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write('invalid\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/history`);
    await assert.rejects(read(response, new AbortController().signal));
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('request not closed')), 1000))]);
  } finally { server.closeAllConnections(); server.close(); }
});
