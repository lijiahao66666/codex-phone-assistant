import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopView } from './view.mjs';
import { absolutePath, sameOrInside } from '../common/path-utils.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const supported = new Set(['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'subAgentActivity', 'collabAgentToolCall', 'imageView', 'imageGeneration', 'error']);
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function identity(threadId, parentThreadId, scope, projectPath) {
  if (!uuid.test(threadId) || (parentThreadId !== null && !uuid.test(parentThreadId))) throw new TypeError('Invalid thread identity');
  if (projectPath !== null && !absolutePath(projectPath)) throw new TypeError('Absolute project path required');
  if (scope !== null && (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).sort().join(',') !== 'deviceId,hostId' || ![scope.hostId, scope.deviceId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128))) throw new TypeError('Invalid history scope');
  return { threadId, parentThreadId, scope: scope === null ? null : { hostId: scope.hostId, deviceId: scope.deviceId }, projectPath };
}

function permittedRow(db, id, phoneThreadIds) {
  const row = db.prepare('SELECT title, name, source, thread_source, archived, cwd FROM threads WHERE id = ?').get(id.threadId);
  if (!row || row.archived !== 0) return null;
  if (id.projectPath !== null && (typeof row.cwd !== 'string' || !sameOrInside(id.projectPath, row.cwd))) return null;
  if (id.parentThreadId === null) return row.source === 'vscode' && (['user', 'agent_created_thread'].includes(row.thread_source) || (row.thread_source === null && phoneThreadIds.includes(id.threadId))) ? row : null;
  if (row.thread_source !== 'subagent') return null;
  try { return JSON.parse(row.source)?.subagent?.thread_spawn?.parent_thread_id === id.parentThreadId ? row : null; }
  catch { return null; }
}

/**
 * Read-only, indexed history. This API never discovers an owner, resumes a thread,
 * or returns control requests. Callers must still authorize the host/device before
 * calling it. Scope binding prevents replay across already-authorized contexts.
 * A page can contain an older fragment of the same turn as the previous page;
 * merge it by turn id and item id instead of rejecting duplicate turn ids.
 */
export function createRecordedHistoryPager({ codexHome = join(homedir(), '.codex'), cursorSecret = randomBytes(32), ttlMs = 300000, now = Date.now } = {}) {
  if (!absolutePath(codexHome) || !Buffer.isBuffer(cursorSecret) || cursorSecret.length < 32 || !integer(ttlMs, 1000, 3600000) || typeof now !== 'function') throw new TypeError('Invalid history pager options');
  const key = Buffer.from(cursorSecret);
  const sign = body => createHmac('sha256', key).update(body).digest();
  function encode(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  }
  function decode(token) {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw fail('invalid-cursor');
    const [body, mac] = token.split('.');
    if (!timingSafeEqual(sign(body), Buffer.from(mac, 'base64url'))) throw fail('invalid-cursor');
    let value;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw fail('invalid-cursor'); }
    if (value?.v !== 1 || !integer(value.expires, 0, Number.MAX_SAFE_INTEGER) || value.expires <= now()) throw fail('invalid-cursor');
    if (![value.snapshotOrdinal, value.snapshotOffset, value.turnBefore].every(v => integer(v, 0, Number.MAX_SAFE_INTEGER))) throw fail('invalid-cursor');
    if (value.current !== null && (!value.current || typeof value.current.id !== 'string' || !integer(value.current.ordinal, 0, value.snapshotOrdinal) || !integer(value.current.itemBefore, 0, value.snapshotOrdinal))) throw fail('invalid-cursor');
    return value;
  }

  return {
    read(threadId, { cursor = null, parentThreadId = null, scope = null, projectPath = null, phoneThreadIds = [], maxTurns = 3, maxItems = 100, maxBytes = 256 * 1024, maxSingleItemBytes = 4 * 1024 * 1024 } = {}) {
      const id = identity(threadId, parentThreadId, scope, projectPath);
      if (!Array.isArray(phoneThreadIds) || !phoneThreadIds.every(value => typeof value === 'string' && uuid.test(value))) throw new TypeError('Invalid phone thread authorization');
      if (!integer(maxTurns, 1, 50) || !integer(maxItems, 1, 1000) || !integer(maxBytes, 1024, 4 * 1024 * 1024) || !integer(maxSingleItemBytes, 1024, 8 * 1024 * 1024)) throw new TypeError('Invalid history page limits');
      let state, history;
      try {
        state = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
        const row = permittedRow(state, id, phoneThreadIds);
        if (!row) return null;
        const file = join(codexHome, 'thread_history_1.sqlite');
        const info = statSync(file), database = `${info.dev}:${info.ino}`;
        history = new DatabaseSync(file, { readOnly: true });
        history.exec('BEGIN');
        const projection = history.prepare('SELECT next_rollout_ordinal AS ordinal, next_rollout_byte_offset AS offset FROM thread_history_projection_state WHERE thread_id = ?').get(threadId);
        if (!projection || ![projection.ordinal, projection.offset].every(v => integer(v, 0, Number.MAX_SAFE_INTEGER))) throw fail('history-unavailable');
        let page = cursor === null ? { v: 1, identity: id, database, expires: now() + ttlMs, snapshotOrdinal: projection.ordinal, snapshotOffset: projection.offset, turnBefore: projection.ordinal, current: null } : decode(cursor);
        if (JSON.stringify(page.identity) !== JSON.stringify(id) || page.database !== database) throw fail('invalid-cursor');
        if (projection.ordinal < page.snapshotOrdinal || projection.offset < page.snapshotOffset) throw fail('history-changed');
        // Appends use new ordinals. Updates to already indexed records invalidate
        // the snapshot without hashing every historical item on each live event.
        const changed = history.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? AND updated_at_ordinal >= ? AND rollout_ordinal < ? LIMIT 1').get(threadId, page.snapshotOrdinal, page.snapshotOrdinal);
        if (cursor !== null && changed) throw fail('history-changed');
        const turnQuery = history.prepare('SELECT turn_id, rollout_ordinal, status, started_at FROM thread_turns WHERE thread_id = ? AND rollout_ordinal < ? ORDER BY rollout_ordinal DESC LIMIT 1');
        const currentQuery = history.prepare('SELECT turn_id, rollout_ordinal, status, started_at FROM thread_turns WHERE thread_id = ? AND turn_id = ? AND rollout_ordinal = ?');
        const itemQuery = history.prepare(`SELECT item_id, rollout_ordinal, length(CAST(item_json AS BLOB)) AS bytes
          FROM thread_items WHERE thread_id = ? AND turn_id = ? AND rollout_ordinal < ? ORDER BY rollout_ordinal DESC LIMIT ?`);
        const itemContent = history.prepare('SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ? AND rollout_ordinal = ?');
        const rawTurns = [], metadata = new Map();
        let itemCount = 0, bytes = 0, exhausted = false, stop = false;
        while (!stop && rawTurns.length < maxTurns && itemCount < maxItems) {
          const turn = page.current === null ? turnQuery.get(threadId, page.turnBefore) : currentQuery.get(threadId, page.current.id, page.current.ordinal);
          if (!turn) {
            if (page.current !== null) throw fail('history-changed');
            exhausted = true; break;
          }
          if (typeof turn.turn_id !== 'string' || !turn.turn_id || !integer(turn.rollout_ordinal, 0, page.snapshotOrdinal)) throw fail('history-invalid');
          const beganAtNewest = page.current === null;
          const itemBefore = page.current?.itemBefore ?? page.snapshotOrdinal;
          const remaining = maxItems - itemCount;
          // Fetch metadata first; loading up to 1000 maximum-sized JSON values
          // at once would defeat the byte budget before we could enforce it.
          const items = itemQuery.all(threadId, turn.turn_id, itemBefore, remaining + 1);
          const accepted = [];
          let nextItemBefore = itemBefore;
          for (const item of items.slice(0, remaining)) {
            if (!integer(item.rollout_ordinal, 0, itemBefore - 1) || !integer(item.bytes, 1, Number.MAX_SAFE_INTEGER)) throw fail('history-invalid');
            if (item.bytes > maxSingleItemBytes) {
              if (itemCount > 0) { stop = true; break; }
              throw Object.assign(fail('item-too-large', 'Recorded item exceeds the explicit history limit'), { itemId: item.item_id, itemBytes: item.bytes, maxSingleItemBytes });
            }
            if (itemCount > 0 && bytes + item.bytes > maxBytes) { stop = true; break; }
            let parsed;
            try { parsed = JSON.parse(itemContent.get(threadId, turn.turn_id, item.item_id, item.rollout_ordinal)?.item_json); } catch { throw fail('history-invalid'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.id !== item.item_id || typeof parsed.type !== 'string') throw fail('history-invalid');
            accepted.push(supported.has(parsed.type) ? parsed : { id: parsed.id, type: 'error', message: '这条历史活动的类型暂不支持显示' });
            itemCount++; bytes += item.bytes; nextItemBefore = item.rollout_ordinal;
            if (bytes >= maxBytes) { stop = true; break; }
          }
          const hasOlderItems = accepted.length < items.length;
          if (!accepted.length && items.length) {
            // A previous turn already used the byte budget; leave this turn at
            // its exact boundary for the next request rather than losing it.
            page.current = { id: turn.turn_id, ordinal: turn.rollout_ordinal, itemBefore };
            break;
          }
          rawTurns.unshift({ turnId: turn.turn_id, status: turn.status === 'inProgress' ? 'unknown' : turn.status, turnStartedAtMs: turn.started_at, items: accepted.reverse() });
          metadata.set(turn.turn_id, { hasLoadedNewest: beganAtNewest, hasLoadedOldest: !hasOlderItems, source: 'recorded-history' });
          if (hasOlderItems) {
            page.current = { id: turn.turn_id, ordinal: turn.rollout_ordinal, itemBefore: nextItemBefore };
            stop = true;
          } else { page.current = null; page.turnBefore = turn.rollout_ordinal; }
        }
        if (page.current === null && !turnQuery.get(threadId, page.turnBefore)) exhausted = true;
        const view = desktopView({ id: threadId, title: row.name || row.title || '', turns: rawTurns });
        for (const turn of view.turns) turn.itemsPagination = metadata.get(turn.id);
        const nextCursor = exhausted ? null : encode(page);
        history.exec('COMMIT');
        return { id: threadId, title: view.title, turns: view.turns, requests: [], runtimeStatus: 'unknown',
          history: { complete: false, reason: 'recorded-history', readOnly: true, olderComplete: exhausted, indexedThroughOrdinal: page.snapshotOrdinal, indexedThroughByteOffset: page.snapshotOffset },
          nextCursor, page: { items: itemCount, bytes, turns: rawTurns.length } };
      } finally { history?.close(); state?.close(); }
    },
  };
}

const defaultPager = createRecordedHistoryPager();
export const readRecordedHistoryPage = (threadId, options) => defaultPager.read(threadId, options);
