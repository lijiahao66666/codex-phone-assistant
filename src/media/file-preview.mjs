import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { marked } from 'marked';

export function changedFileReference({ state, threadId, turnId, itemId, index }) {
  if (state?.id !== threadId || !Number.isSafeInteger(index) || index < 0 || index > 1000) return null;
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  const turns = [...(Array.isArray(state.turns) ? state.turns : []), ...(history?.islands || []).flatMap(island => (island.entries || []).map(entry => history.entitiesByKey?.[entry.value]).filter(Boolean))];
  const matches = turns.filter(turn => turn?.turnId === turnId).flatMap(turn => (turn.items || []).filter(item => item?.id === itemId && item.type === 'fileChange'));
  if (!matches.length) return null;
  const paths = new Set(matches.map(item => item.changes?.[index]?.path).filter(path => typeof path === 'string' && isAbsolute(path)));
  if (paths.size !== 1) return null;
  return [...paths][0];
}

export function linkedFileReference({ state, threadId, turnId, itemId, path }) {
  if (state?.id !== threadId || !isAbsolute(path || '') || path.includes('\0')) return null;
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  const turns = [...(Array.isArray(state.turns) ? state.turns : []), ...(history?.islands || []).flatMap(island => (island.entries || []).map(entry => history.entitiesByKey?.[entry.value]).filter(Boolean))];
  const messages = turns.filter(turn => turn?.turnId === turnId).flatMap(turn => (turn.items || []).filter(item => item?.id === itemId && item.type === 'agentMessage' && typeof item.text === 'string'));
  if (!messages.length || messages.some(item => item.text !== messages[0].text)) return null;
  let found = false;
  try { marked.walkTokens(marked.lexer(messages[0].text), token => { if (token.type === 'link' && decodeURIComponent(token.href) === path) found = true; }); } catch { return null; }
  return found ? path : null;
}

export async function readChangedFile(options) {
  const path = changedFileReference(options);
  return path ? readFileWithinRoots(path, options) : null;
}

export async function readLinkedFile(options) {
  const path = linkedFileReference(options);
  if (!path) return null;
  const exact = await readFileWithinRoots(path, options);
  if (exact) return exact;
  const withoutLine = path.replace(/:\d+(?::\d+)?$/, '');
  if (withoutLine === path) return null;
  try { await lstat(path); return null; }
  catch (error) { if (error?.code !== 'ENOENT') return null; }
  return readFileWithinRoots(withoutLine, options);
}

export function linkedPreviewMatches(reference, actualPath) {
  return typeof reference === 'string' && (actualPath === reference || actualPath === reference.replace(/:\d+(?::\d+)?$/, ''));
}

export async function verifyPreviewIdentity(result) {
  const identity = result?.previewIdentity;
  if (!identity) return false;
  try {
    if (await realpath(identity.path) !== identity.canonical) return false;
    const info = await stat(identity.canonical, { bigint: true });
    const now = [info.dev, info.ino, info.size, info.mtimeNs / 1000000000n, info.mtimeNs % 1000000000n, info.ctimeNs].map(String);
    return info.isFile() && identity.values.every((value, index) => value === now[index]);
  } catch { return false; }
}

async function readFileWithinRoots(path, { helperPath, roots, maxBytes = 512 * 1024 }) {
  if (!isAbsolute(helperPath || '') || !Array.isArray(roots)) return null;
  try {
    const canonical = await realpath(path);
    const resolvedRoots = await Promise.all(roots.map(root => realpath(root)));
    const root = resolvedRoots.find(value => { const rel = relative(value, canonical); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); });
    if (!root) return null;
    const info = await stat(canonical, { bigint: true });
    if (!info.isFile() || info.size > BigInt(maxBytes)) return null;
    const identity = [info.dev, info.ino, info.size, info.mtimeNs / 1000000000n, info.mtimeNs % 1000000000n, info.ctimeNs].map(String);
    const bytes = await new Promise((resolve, reject) => {
      const child = spawn(helperPath, [root, relative(root, canonical), String(maxBytes), ...identity], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 8000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { failed = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error('File unavailable')); else resolve(Buffer.concat(chunks)); });
    });
    if (bytes.includes(0)) return null;
    const result = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    Object.defineProperty(result, 'previewIdentity', { value: { path, canonical, values: identity } });
    return result;
  } catch { return null; }
}
