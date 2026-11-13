import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

for (const [version, commit] of [['v1.0.1','20004578bb2dc79ef2bdd944ee36ad2d50a1bd7f'], ['v1.0.2','fd0e549f6096ed31e936946ba69fc8222ece2fad'], ['v1.0.2-activity1','fd0e549f6096ed31e936946ba69fc8222ece2fad'], ['v1.0.2-unread1','fd0e549f6096ed31e936946ba69fc8222ece2fad'], ['v1.0.2-readsync1','fd0e549f6096ed31e936946ba69fc8222ece2fad'], ['v1.0.2-readsync2','fd0e549f6096ed31e936946ba69fc8222ece2fad']]) {
  test(`${version} immutable H5 snapshot matches manifest and keeps application assets in its version`, async () => {
    const dir = new URL(`../public/h5/${version}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
    assert.equal(manifest.version, version); assert.equal(manifest.sourceCommit, commit);
    const files = (await readdir(dir)).filter(x => x !== 'manifest.json').sort();
    assert.deepEqual(files, Object.keys(manifest.assets).sort());
    for (const file of files) { const data = await readFile(new URL(file, dir)); assert.equal(data.length, manifest.assets[file].bytes); assert.equal(createHash('sha256').update(data).digest('hex'), manifest.assets[file].sha256); }
    const html = await readFile(new URL('desktop.html', dir), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)].map(x => x[1]);
    for (const url of assets) assert.ok(url === '/download/' || url.startsWith(`/h5/${version}/`) || manifest.sharedRootAssets.some(shared => url === shared || url.startsWith(shared+'?')), `unexpected root asset ${url}`);
    const js = await readFile(new URL('desktop.js', dir), 'utf8');
    for (const file of ['recovery-attempt-store.js', 'attachment-preview.mjs', 'state-chunks.mjs']) assert.ok(js.includes(`/h5/${version}/${file}`));
    const attachment = await readFile(new URL('attachment-preview.mjs', dir), 'utf8');
    assert.match(attachment, /\.\/pdf-parser\.mjs/); assert.match(attachment, /\.\/pdf-worker\.mjs/);
  });
}
