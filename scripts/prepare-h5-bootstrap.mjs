import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The gateway reuses the normal pairing shell, but delays every application
// script until it has established that pairing is needed.
export function renderBootstrap(html) {
  if (typeof html !== 'string') throw new TypeError('HTML required');
  const scripts = [...html.matchAll(/^  <script defer src="[^"]+"><\/script>\n/gm)];
  if (scripts.length !== 10 || html.split('<div class="app">').length !== 2 || html.split('</head>').length !== 2 || html.split('  <link rel="stylesheet" href="/download/home-entry.css?v=20261106-2">\n').length !== 2) throw new Error('Pairing shell anchors changed');
  return html.replace(/^  <script defer src="[^"]+"><\/script>\n/gm, '')
    .replace('  <link rel="stylesheet" href="/download/home-entry.css?v=20261106-2">\n', '  <link rel="stylesheet" href="/download/home-entry.css?v=20261106-2">\n  <link rel="stylesheet" href="/h5-bootstrap.css">\n')
    .replace('</head>', '  <script type="module" src="/h5-bootstrap.mjs"></script>\n</head>')
    .replace('<div class="app">', '<div id="h5-bootstrap-status" role="status" aria-live="polite">正在连接电脑… <button id="h5-bootstrap-retry" type="button" hidden>重试</button></div>\n  <div class="app" hidden>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = await readFile(new URL('../public/desktop.html', import.meta.url), 'utf8');
  await writeFile(new URL('../public/h5-bootstrap.html', import.meta.url), renderBootstrap(source));
}
