import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('test deployment brands the bootstrap and both pinned versions without touching production assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phone-h5-overlay-'));
  const script = new URL('../scripts/prepare-test-h5.mjs', import.meta.url);
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--output', root, '--origin', 'https://test.example.com'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const path of ['desktop.html', 'h5-bootstrap.html', 'h5/v1.0.1/desktop.html', 'h5/v1.0.2/desktop.html']) {
      const html = await readFile(join(root, path), 'utf8');
      assert.match(html, /Codex 手机助手 · 测试版/); assert.match(html, /测试环境/); assert.match(html, /title="https:\/\/test\.example\.com"/);
      if (path.includes('/')) assert.match(html, /h5-version-entry\.mjs/);
      if (path === 'h5-bootstrap.html') assert.match(html, /h5-bootstrap\.mjs/);
    }
    for (const version of ['v1.0.1', 'v1.0.2']) {
      const dir = join(root, 'h5', version), manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.testOverlayOrigin, 'https://test.example.com');
      for (const name of ['desktop.html', 'desktop.css']) { const bytes = await readFile(join(dir, name)); assert.deepEqual(manifest.assets[name], { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }); }
      assert.match(await readFile(join(dir, 'desktop.css'), 'utf8'), /test-environment-badge/);
    }
    const web = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'));
    assert.equal(web.id, 'https://test.example.com/'); assert.equal(web.short_name, '手机助手测试版');
    assert.doesNotMatch(await readFile(new URL('../public/h5/v1.0.2/desktop.html', import.meta.url), 'utf8'), /测试环境/);
    assert.notEqual(spawnSync(process.execPath, [fileURLToPath(script), '--output', root, '--origin', 'https://codex.air-inc.top'], { encoding: 'utf8' }).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
