import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopView } from './view.mjs';
import { insidePath } from '../common/path-utils.mjs';

// Recovery needs permission to attach, not a second projection of the messages.
// Recheck the same index policy on every request; cached history is not proof
// that the thread is still visible or that a phone-created id is authorized.
export function isRecoverableHistoryThread(threadId, { codexHome = join(homedir(), '.codex'), phoneThreadIds = [] } = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new TypeError('Invalid thread');
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  try { return permittedRow(db, threadId, null, phoneThreadIds) !== null; }
  finally { db.close(); }
}

// Rollout data is historical and must never authorize live control operations.
export async function readRolloutHistory(threadId, { codexHome = join(homedir(), '.codex'), maxBytes = 16 * 1024 * 1024, parentThreadId = null, phoneThreadIds = [] } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new TypeError('Invalid thread');
  if (parentThreadId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentThreadId)) throw new TypeError('Invalid parent');
  try {
    const history = await readRolloutFile(threadId, codexHome, maxBytes, parentThreadId, phoneThreadIds);
    if (history) return history;
  } catch (error) {
    if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
  }
  return readProjectedHistory(threadId, codexHome, parentThreadId, phoneThreadIds);
}

function permittedRow(db, threadId, parentThreadId, phoneThreadIds) {
  const row = db.prepare('SELECT rollout_path, title, name, source, thread_source, archived FROM threads WHERE id = ?').get(threadId);
  if (!row || row.archived !== 0) return null;
  if (parentThreadId === null) return row.source === 'vscode' && (['user', 'agent_created_thread'].includes(row.thread_source) || (row.thread_source === null && phoneThreadIds.includes(threadId))) ? row : null;
  if (row.thread_source !== 'subagent') return null;
  try { return JSON.parse(row.source)?.subagent?.thread_spawn?.parent_thread_id === parentThreadId ? row : null; }
  catch { return null; }
}

async function readRolloutFile(threadId, codexHome, maxBytes, parentThreadId, phoneThreadIds) {
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let row;
  try { row = permittedRow(db, threadId, parentThreadId, phoneThreadIds); }
  finally { db.close(); }
  if (!row || typeof row.rollout_path !== 'string') return null;
  const root = await realpath(join(codexHome, 'sessions'));
  const path = await realpath(row.rollout_path);
  if (!insidePath(root, path) || !path.toLowerCase().endsWith('.jsonl')) return null;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) return null;
    const readAt = async (position, size) => {
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    };
    const prefix = await readAt(0, Math.min(info.size, 64 * 1024));
    const firstNewline = prefix.indexOf(10);
    if (firstNewline < 0) return null;
    let meta;
    try { meta = JSON.parse(prefix.subarray(0, firstNewline).toString('utf8')); } catch { return null; }
    if (meta?.type !== 'session_meta' || meta?.payload?.id !== threadId) return null;
    const start = Math.max(0, info.size - maxBytes);
    const buffer = await readAt(start, info.size - start);
    if (buffer.length !== info.size - start) return null;
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) return null;
    let content = buffer.toString('utf8');
    if (start > 0) {
      const newline = content.indexOf('\n');
      if (newline < 0) return null;
      content = content.slice(newline + 1);
    }
    const records = [];
    const lines = content.split('\n');
    lines.pop(); // A record is complete only after its terminating newline.
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { return null; }
    }
    const view = projectRolloutHistory(records, threadId, row.name || row.title || '');
    return limitHistory(view);
  } finally { await file.close(); }
}

function readProjectedHistory(threadId, codexHome, parentThreadId, phoneThreadIds) {
  const state = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let row;
  try { row = permittedRow(state, threadId, parentThreadId, phoneThreadIds); }
  finally { state.close(); }
  if (!row) return null;
  let db;
  try {
    db = new DatabaseSync(join(codexHome, 'thread_history_1.sqlite'), { readOnly: true });
    db.exec('BEGIN');
    const turns = db.prepare('SELECT turn_id, status, started_at FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 12').all(threadId).reverse();
    const query = db.prepare('SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND length(item_json) <= 131072 ORDER BY rollout_ordinal DESC LIMIT 200');
    const mapped = turns.map(turn => ({ turnId: turn.turn_id, status: turn.status === 'inProgress' ? 'unknown' : turn.status,
      turnStartedAtMs: turn.started_at, items: query.all(threadId, turn.turn_id).reverse().map(item => {
        try { return JSON.parse(item.item_json); } catch { return null; }
      }).filter(Boolean) }));
    const view = desktopView({ id: threadId, title: row.name || row.title || '', turns: mapped });
    view.history = { complete: false, reason: 'recorded-history' };
    db.exec('COMMIT');
    return limitHistory(view);
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' || error.code === 'ENOENT') return null;
    throw error;
  } finally { db?.close(); }
}

function limitHistory(view) {
  const tooLarge = () => Buffer.byteLength(JSON.stringify(view)) > 512 * 1024;
  while (view.turns.length > 1 && tooLarge()) view.turns.shift();
  while (view.turns[0]?.items?.length && tooLarge()) view.turns[0].items.shift();
  return view.turns.length && !tooLarge() ? view : null;
}

export function projectRolloutHistory(records, threadId, title = '') {
  if (!Array.isArray(records) || typeof threadId !== 'string' || !threadId) throw new TypeError('Invalid history');
  const turns = [], byId = new Map();
  for (const record of records) {
    if (record?.type !== 'event_msg' || !record.payload || typeof record.payload !== 'object') continue;
    const event = record.payload;
    const id = event.turn_id;
    if (typeof id !== 'string' || !id) continue;
    if (event.thread_id && event.thread_id !== threadId) continue;
    if (event.type === 'task_started') {
      if (!byId.has(id)) {
        const turn = { id, status: 'unknown', items: [], startedAt: event.started_at ?? null };
        turns.push(turn); byId.set(id, { turn, items: new Set() });
      }
      continue;
    }
    const entry = byId.get(id);
    if (!entry) continue;
    if (event.type === 'task_complete') entry.turn.status = 'completed';
    else if (event.type === 'turn_aborted') entry.turn.status = 'interrupted';
    else if (event.type === 'item_completed') {
      const item = projectItem(event.item);
      if (!item || entry.items.has(item.id)) continue;
      entry.items.add(item.id); entry.turn.items.push(item);
    }
  }
  return { id: threadId, title, turns, history: { complete: false, reason: 'recorded-history' }, requests: [] };
}

function projectItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  const base = { id: item.id };
  const status = ['inProgress', 'completed', 'failed', 'declined', 'interrupted'].includes(item.status) ? item.status : '';
  const textParts = value => Array.isArray(value) ? value.filter(part => (part?.type === 'text' || part?.type === 'Text') && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
    const phase = item.type === 'AgentMessage' && ['commentary', 'final_answer'].includes(item.phase) ? item.phase : null;
    return { ...base, type: item.type === 'UserMessage' ? 'userMessage' : 'agentMessage', text: textParts(item.content), ...(phase ? { phase } : {}) };
  }
  if (item.type === 'Reasoning') return { id: item.id, type: 'reasoning', summary: Array.isArray(item.summary_text) ? item.summary_text.filter(text => typeof text === 'string') : [] };
  if (item.type === 'CommandExecution') return { id: item.id, type: 'commandExecution', command: typeof item.command === 'string' ? item.command : '', output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '', status: typeof item.status === 'string' ? item.status : '' };
  if (item.type === 'FileChange') {
    const changes = item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes)
      ? Object.entries(item.changes).filter(([path, change]) => path && change && typeof change === 'object' && !Array.isArray(change))
        .map(([path, change]) => ({ path, ...(typeof change.unified_diff === 'string' ? { diff: change.unified_diff } : {}) })) : [];
    return { ...base, type: 'fileChange', status, changes };
  }
  if (item.type === 'McpToolCall') return { ...base, type: 'mcpToolCall', status, server: typeof item.server === 'string' ? item.server : '', tool: typeof item.tool === 'string' ? item.tool : '' };
  if (item.type === 'SubAgentActivity') {
    if (!['started', 'interacted', 'interrupted', 'completed'].includes(item.kind)) return null;
    const agentThreadId = typeof item.agent_thread_id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.agent_thread_id) ? item.agent_thread_id : null;
    return { ...base, type: 'subAgentActivity', kind: item.kind, agentPath: typeof item.agent_path === 'string' ? item.agent_path : '', ...(agentThreadId ? { agentThreadId } : {}) };
  }
  if (item.type === 'CollabAgentToolCall') {
    const states = item.agents_states;
    const agents = states && typeof states === 'object' && !Array.isArray(states)
      ? Object.entries(states).filter(([id, state]) => id && state && typeof state === 'object' && !Array.isArray(state))
        .map(([id, state]) => ({ id, status: ['inProgress', 'completed', 'failed', 'interrupted'].includes(state.status) ? state.status : '' })) : [];
    return { ...base, type: 'collabAgentToolCall', tool: typeof item.tool === 'string' ? item.tool : '', status, agents };
  }
  return null;
}
