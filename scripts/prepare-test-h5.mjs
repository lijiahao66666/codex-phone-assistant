#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'node scripts/prepare-test-h5.mjs --output /tmp/codex-test-h5 --origin https://test.example.com';
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--output', '--origin'].includes(key) || !value || values.has(key)) throw new Error(usage);
  values.set(key, value);
}
if (values.size !== 2) throw new Error(usage);
const origin = new URL(values.get('--origin'));
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Use a dedicated HTTPS test origin without a path.');
if (origin.hostname === 'codex.air-inc.top') throw new Error('The production origin cannot be used for test assets.');

const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(values.get('--output'));
await mkdir(output, { recursive: true });
const outputRoot = await realpath(output);
if (outputRoot === sourceRoot || outputRoot.startsWith(sourceRoot + sep)) throw new Error('Output must be outside this source checkout; copy the generated files only into a separate test deployment.');
const readPublic = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, css, rawManifest] = await Promise.all([readPublic('desktop.html'), readPublic('desktop.css'), readPublic('manifest.webmanifest')]);
const replaceOnce = (value, before, after) => {
  if (value.split(before).length !== 2) throw new Error(`Expected exactly one test overlay anchor: ${before}`);
  return value.replace(before, after);
};
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let testHtml = replaceOnce(html, '<title>Codex 手机助手</title>', '<title>Codex 手机助手 · 测试版</title>');
testHtml = replaceOnce(testHtml, 'name="apple-mobile-web-app-title" content="Codex 手机助手"', 'name="apple-mobile-web-app-title" content="手机助手测试版"');
testHtml = replaceOnce(testHtml, '<strong>Codex 手机助手</strong>', '<strong>Codex 手机助手 · 测试版</strong>');
testHtml = replaceOnce(testHtml, '<div class="device-bar">', `<div class="device-bar"><strong class="test-environment-badge" title="${escapeHtml(origin.origin)}">测试环境</strong>`);
const manifest = JSON.parse(rawManifest);
Object.assign(manifest, { id: origin.origin + '/', name: 'Codex 手机助手 · 测试版', short_name: '手机助手测试版', start_url: '/', scope: '/', theme_color: '#fff7ed' });
await Promise.all([
  writeFile(resolve(outputRoot, 'desktop.html'), testHtml),
  writeFile(resolve(outputRoot, 'desktop.css'), css + '\n/* Test deployment identity; production assets are not changed. */\n.test-environment-badge{flex:none;align-self:center;padding:2px 6px;border:1px solid #fdba74;border-radius:5px;background:#fff7ed;color:#9a3412;font-size:11px;line-height:18px;white-space:nowrap}\n'),
  writeFile(resolve(outputRoot, 'manifest.webmanifest'), JSON.stringify(manifest) + '\n'),
]);
console.log(`Prepared test-only desktop.html, desktop.css and manifest.webmanifest in ${outputRoot} for ${origin.origin}.`);
