import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Produce a guarded shell from the pinned release HTML. The original shell is
// retained separately so the adaptation and its provenance remain reviewable.
export function renderVersionEntry(html) {
  if (typeof html !== 'string') throw new TypeError('HTML required');
  const scripts = [...html.matchAll(/^  <script defer src="[^"]+"><\/script>\n/gm)];
  if (![7, 10].includes(scripts.length) || html.split('<div class="app">').length !== 2 || html.split('</head>').length !== 2) throw new Error('Pinned version shell anchors changed');
  return html.replace(/^  <script defer src="[^"]+"><\/script>\n/gm, '')
    .replace('</head>', '  <link rel="stylesheet" href="/h5-bootstrap.css">\n  <script type="module" src="/h5-version-entry.mjs"></script>\n</head>')
    .replace('<div class="app">', '<div id="h5-version-status" role="status" aria-live="polite">正在连接电脑… <button id="h5-version-retry" type="button" hidden>重试</button></div>\n  <div class="app" hidden>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const version of ['v1.0.1', 'v1.0.2']) {
    const html = renderVersionEntry(await readFile(new URL(`./h5-shells/${version}.html`, import.meta.url), 'utf8'));
    const root = new URL(`../public/h5/${version}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const bytes = Buffer.from(html);
    manifest.assets['desktop.html'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    manifest.adaptation = 'Guarded entry and version compatibility; original shell retained in scripts/h5-shells.';
    for (const path of ['/h5-bootstrap.css', '/h5-bootstrap.mjs', '/h5-version-entry.mjs']) if (!manifest.sharedRootAssets.includes(path)) manifest.sharedRootAssets.push(path);
    await writeFile(new URL('desktop.html', root), bytes);
    await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
  }
}
