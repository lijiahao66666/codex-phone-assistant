import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const before = "if (location.hash || location.pathname === '/pair') window.history.replaceState(null, '', '/');";
const after = "if (scanned || addingComputer || location.pathname === '/pair') window.history.replaceState(null, '', location.pathname === '/pair' ? '/' : location.pathname + location.search);";
export function renderVersionPair(source) {
  if (typeof source !== 'string' || source.split(before).length !== 2) throw new Error('Pinned pairing source changed');
  const replaceOnce = (value, needle, replacement) => {
    if (value.split(needle).length !== 2) throw new Error('Pinned pairing guard anchor changed');
    return value.replace(needle, replacement);
  };
  let result = source.replace(before, after);
  result = replaceOnce(result, 'let pageActive = true;', `let pageActive = true, pairRequestActive = false, pairNavigating = false;
function pairGuard() { return window.versionPairGuard; }
function pairGuardFailure() { const status = document.querySelector('#send-status'); if (status) status.textContent = '请先处理草稿、附件或未确认的操作，再配对其他电脑'; }
function pairNavigate() {
  const guard = pairGuard();
  if (!guard || !guard.isActive()) { showError('电脑状态已变化，请先确认当前页面内容'); return false; }
  pairNavigating = true; location.assign('/'); return true;
}`);
  result = replaceOnce(result, "function openPairing() { if (window.showPairingRecovery?.()) return; overlay.hidden = false; showError(''); }", "function openPairing() { if (window.showPairingRecovery?.()) return; const guard = pairGuard(); if (!guard || !guard.begin()) { pairGuardFailure(); return; } overlay.hidden = false; showError(''); }");
  result = replaceOnce(result, "function closePairing() { stopScan(); pairGeneration++; overlay.hidden = true; cancelPair.hidden = true; submitButton.disabled = false; selectedQrToken = null; }", "function closePairing() { stopScan(); pairGeneration++; overlay.hidden = true; cancelPair.hidden = true; submitButton.disabled = false; selectedQrToken = null; if (!pairRequestActive && !pairNavigating) pairGuard()?.end(); }");
  result = replaceOnce(result, "  if (submitButton.disabled) return;\n  const qrToken", "  if (submitButton.disabled || pairRequestActive) return;\n  if (!pairGuard()?.isActive()) { pairGuardFailure(); return; }\n  const qrToken");
  result = replaceOnce(result, '  submitButton.disabled = true;\n  try {\n    const response = await fetch', '  submitButton.disabled = true; pairRequestActive = true;\n  try {\n    const response = await fetch');
  // All successful pair responses can change the selected cookie. Do not
  // navigate if another tab revoked the guard while the request was in flight.
  result = result.replaceAll("location.assign('/')", 'pairNavigate()');
  // Restore the single navigation implementation replaced above.
  result = replaceOnce(result, 'pairNavigating = true; pairNavigate(); return true;', "pairNavigating = true; location.assign('/'); return true;");
  result = replaceOnce(result, "    if (generation === pairGeneration) { submitButton.disabled = false; cancelPair.hidden = true; }\n  }\n}", "    pairRequestActive = false;\n    if (generation === pairGeneration) { submitButton.disabled = false; cancelPair.hidden = true; }\n    if (overlay.hidden && !pairNavigating) pairGuard()?.end();\n  }\n}");
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const version of ['v1.0.1', 'v1.0.2']) {
    const source = await readFile(new URL(`./h5-shells/${version}-pair.js`, import.meta.url), 'utf8');
    const bytes = Buffer.from(renderVersionPair(source));
    const root = new URL(`../public/h5/${version}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    manifest.assets['pair.js'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    await writeFile(new URL('pair.js', root), bytes);
    await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
  }
}
