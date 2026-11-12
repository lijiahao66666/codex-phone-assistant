import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPairRelay } from '../src/relay/server.mjs';

test('versioned H5 serves only manifest-pinned fixed assets with the existing CSP', async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, relay = createPairRelay({ origin }); await relay.listen(port);
  const get = path => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  try {
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(root.body.toString(), /src="\/h5-bootstrap\.mjs"/);
    assert.match((await get('/pair')).body.toString(), /src="\/h5-bootstrap\.mjs"/);
    for (const path of ['/h5-bootstrap.mjs', '/h5-version-entry.mjs', '/h5-bootstrap.css']) {
      const asset = await get(path); assert.equal(asset.status, 200, path); assert.equal(asset.headers['content-security-policy'], root.headers['content-security-policy']);
    }
    for (const version of ['v1.0.1', 'v1.0.2', 'v1.0.2-activity1']) {
      const manifest = JSON.parse(await readFile(new URL(`../public/h5/${version}/manifest.json`, import.meta.url), 'utf8'));
      for (const name of Object.keys(manifest.assets)) {
        const res = await get(`/h5/${version}/${name}`);
        assert.equal(res.status, 200, `${version}/${name}`);
        assert.equal(res.body.length, manifest.assets[name].bytes);
        assert.equal(res.headers['content-security-policy'], root.headers['content-security-policy']);
        assert.equal(res.headers['cache-control'], 'no-store');
      }
    }
    for (const path of ['/h5/v1.0.1/manifest.json', '/h5/v1.0.3/desktop.js', '/h5/v1.0.1/../v1.0.2/desktop.js', '/h5/v1.0.1/%2e%2e/desktop.js', '/h5/v1.0.1/desktop.js?x=1', '/h5/v1.0.1/%64esktop.js']) {
      assert.notEqual((await get(path)).status, 200, path);
    }
  } finally { await relay.close(); }
});
