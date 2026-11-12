import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = code => Object.assign(new Error('Thread search unavailable'), { code });
const tidy = (text, max) => typeof text === 'string'
  ? Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/gu, ' ').trim()).slice(0, max).join('') : '';

// Match the desktop sidebar's authorization policy, without its 20-page or
// 512 KiB display cap. Never trust the app-server's source filters alone.
export function authorizedSearchThreads(ids, { codexHome = join(homedir(), '.codex'), phoneThreadIds = [] } = {}) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => !uuid.test(id)) || !Array.isArray(phoneThreadIds) || phoneThreadIds.some(id => !uuid.test(id))) throw fail('invalid');
  if (!ids.length) return new Map();
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  try {
    const hasParent = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'attached_thread_parent_id');
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, title, name FROM threads WHERE id IN (${placeholders}) AND archived = 0 AND source = 'vscode'
      AND (thread_source IN ('user', 'agent_created_thread') OR (thread_source IS NULL AND id IN (SELECT value FROM json_each(?))))
      AND preview <> '' ${hasParent ? 'AND attached_thread_parent_id IS NULL' : ''}`).all(...ids, JSON.stringify(phoneThreadIds));
    return new Map(rows.map(row => [row.id, tidy(row.name || row.title, 200) || '未命名任务']));
  } finally { db.close(); }
}

// Native thread/search indexes message text but can omit a renamed thread's
// display name. Query the same authorized desktop index directly for names.
// Keyset pagination avoids an arbitrary sidebar page cap or offset drift.
export function searchAuthorizedTitles(query, { codexHome = join(homedir(), '.codex'), phoneThreadIds = [], after = null } = {}) {
  if (typeof query !== 'string' || !query || !Array.isArray(phoneThreadIds) || phoneThreadIds.some(id => !uuid.test(id)) || (after !== null && (typeof after !== 'string' || !after || after.length > 128))) throw fail('invalid');
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  try {
    const hasParent = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'attached_thread_parent_id');
    const rows = db.prepare(`SELECT id, title, name FROM threads WHERE archived = 0 AND source = 'vscode'
      AND (thread_source IN ('user', 'agent_created_thread') OR (thread_source IS NULL AND id IN (SELECT value FROM json_each(?))))
      AND preview <> '' ${hasParent ? 'AND attached_thread_parent_id IS NULL' : ''}
      AND instr(lower(coalesce(nullif(name, ''), title, '')), lower(?)) > 0
      AND (? IS NULL OR id > ?) ORDER BY id LIMIT 21`).all(JSON.stringify(phoneThreadIds), query, after, after);
    const page = rows.slice(0, 20);
    return { results: page.filter(row => uuid.test(row.id || '')).map(row => ({ id: row.id, title: tidy(row.name || row.title, 200) || '未命名任务', snippet: '' })), nextCursor: rows.length > 20 ? page.at(-1).id : null };
  } finally { db.close(); }
}

export function createThreadSearch({ hostId, request, authorize = authorizedSearchThreads, searchTitles = authorize === authorizedSearchThreads ? searchAuthorizedTitles : async () => ({ results: [], nextCursor: null }), cursorKey = randomBytes(32), now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  if (!uuid.test(hostId || '') || typeof request !== 'function' || typeof authorize !== 'function' || typeof searchTitles !== 'function' || !Buffer.isBuffer(cursorKey) || cursorKey.length < 32 || typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new TypeError('Invalid search configuration');
  const sign = body => createHmac('sha256', cursorKey).update(body).digest();
  const queryDigest = query => createHash('sha256').update(query).digest('hex');
  const encode = value => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body).toString('base64url')}`; };
  const decode = (token, deviceId, query) => {
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw fail('invalid-cursor');
    const [body, mac] = token.split('.'), actual = Buffer.from(mac, 'base64url'), expected = sign(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail('invalid-cursor');
    let value; try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw fail('invalid-cursor'); }
    if (value?.v !== 2 || value.hostId !== hostId || value.deviceId !== deviceId || value.queryDigest !== queryDigest(query) || !Number.isSafeInteger(value.expires) || value.expires <= now() || !['title', 'native'].includes(value.phase) || !(value.cursor === null || typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= (value.phase === 'title' ? 128 : 2048))) throw fail('invalid-cursor');
    return { phase: value.phase, cursor: value.cursor };
  };
  return {
    async search({ query, cursor, deviceId, phoneThreadIds = [], isCancelled = () => false } = {}) {
      if (!uuid.test(deviceId || '') || typeof query !== 'string' || typeof isCancelled !== 'function' || !query.trim() || Buffer.byteLength(query) > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) throw fail('invalid');
      const term = query.trim();
      let state = cursor === undefined || cursor === null ? { phase: 'title', cursor: null } : decode(cursor, deviceId, term);
      if (isCancelled()) throw fail('unavailable');
      const makeCursor = (phase, position) => encode({ v: 2, hostId, deviceId, queryDigest: queryDigest(term), expires: now() + ttlMs, phase, cursor: position });
      let titleResults = [];
      if (state.phase === 'title') {
        const page = await searchTitles(term, { phoneThreadIds, after: state.cursor });
        if (isCancelled() || !page || !Array.isArray(page.results) || page.results.length > 20 || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 128)) throw fail('unavailable');
        if (page.results.some(item => !uuid.test(item?.id || '') || typeof item.title !== 'string')) throw fail('unavailable');
        titleResults = page.results.map(item => ({ id: item.id, title: tidy(item.title, 200) || '未命名任务', snippet: '' }));
        if (page.nextCursor) return { results: titleResults, nextCursor: makeCursor('title', page.nextCursor) };
        state = { phase: 'native', cursor: null };
      }
      const nativeCursor = state.cursor;
      const result = await request('thread/search', { searchTerm: term, sourceKinds: ['vscode'], archived: false, sortKey: 'recency_at', sortDirection: 'desc', limit: 20, ...(nativeCursor ? { cursor: nativeCursor } : {}) });
      if (isCancelled()) throw fail('unavailable');
      if (!result || !Array.isArray(result.data) || result.data.length > 20 || !(result.nextCursor == null || typeof result.nextCursor === 'string' && result.nextCursor.length > 0 && result.nextCursor.length <= 2048)) throw fail('unavailable');
      const ids = [...new Set(result.data.map(hit => hit?.thread?.id).filter(id => typeof id === 'string' && uuid.test(id)))];
      const allowed = await authorize(ids, { phoneThreadIds });
      if (isCancelled() || !(allowed instanceof Map)) throw fail('unavailable');
      const seen = new Set(titleResults.map(item => item.id)), results = [...titleResults];
      for (const hit of result.data) {
        const id = hit?.thread?.id;
        if (typeof id !== 'string' || !allowed.has(id) || seen.has(id) || typeof hit.snippet !== 'string') continue;
        seen.add(id); results.push({ id, title: allowed.get(id), snippet: tidy(hit.snippet, 240) });
      }
      const nextCursor = result.nextCursor ? makeCursor('native', result.nextCursor) : null;
      return { results, nextCursor };
    },
  };
}
