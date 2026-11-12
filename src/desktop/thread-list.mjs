import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathKey, sameOrInside } from '../common/path-utils.mjs';
import { projectDesktopReadState } from './read-state.mjs';

// Check the index version, not the complete list. Keep the same read-only
// connection: SQLite data_version is only comparable on one connection.
export class ThreadListChanges extends EventEmitter {
  constructor({ codexHome = join(homedir(), '.codex'), intervalMs = 500 } = {}) {
    super();
    this.codexHome = codexHome; this.intervalMs = intervalMs; this.version = 0;
    this.generation = 0;
  }
  start() {
    if (this.timer) return;
    const generation = ++this.generation;
    const poll = async () => {
      if (this.polling || generation !== this.generation) return;
      this.polling = true;
      try {
        const databasePath = join(this.codexHome, 'state_5.sqlite');
        const info = await stat(databasePath);
        if (generation !== this.generation) return;
        const identity = `${info.dev}:${info.ino}`;
        let changed = false;
        if (!this.database || identity !== this.databaseIdentity) {
          changed = this.databaseIdentity !== undefined;
          this.database?.close();
          this.database = new DatabaseSync(databasePath, { readOnly: true });
          this.databaseIdentity = identity; this.databaseVersion = undefined;
        }
        const version = this.database.prepare('PRAGMA data_version').get().data_version;
        if (this.databaseVersion !== undefined && version !== this.databaseVersion) changed = true;
        this.databaseVersion = version;
        this.dirty ||= changed;
        const statePath = join(this.codexHome, '.codex-global-state.json');
        const stateInfo = await stat(statePath);
        if (generation !== this.generation) return;
        const stamp = `${stateInfo.ino}:${stateInfo.mtimeMs}:${stateInfo.size}`;
        if (stamp !== this.stateStamp) {
          const state = JSON.parse(await readFile(statePath, 'utf8'));
          if (generation !== this.generation) return;
          const ui = state['electron-persisted-atom-state'] || {};
          const signature = JSON.stringify([state['local-projects'], state['thread-project-assignments'], state['project-order'],
            state['projectless-thread-ids'], state['electron-thread-read-state-v1'], ui['local-document-identity'],
            Object.entries(ui).filter(([key]) => key.startsWith('sidebar-project-expanded-v1-codex:'))]);
          if (this.stateSignature !== undefined && signature !== this.stateSignature) this.dirty = true;
          this.stateSignature = signature; this.stateStamp = stamp;
        }
        if (this.dirty) { this.dirty = false; this.emit('change', { version: ++this.version }); }
      } catch { /* Missing/replaced files and incomplete JSON are retried on the next tick. */ }
      finally { this.polling = false; }
    };
    this.timer = setInterval(() => { void poll(); }, this.intervalMs);
    this.timer.unref?.(); void poll();
  }
  stop() {
    ++this.generation; clearInterval(this.timer); this.timer = null;
    this.database?.close(); this.database = null;
  }
}

// This reads desktop-owned indexes; neither file is modified or opened for writing.
export async function listDesktopThreads({ codexHome = join(homedir(), '.codex'), limit = 200, before = null, includeRecency = false, phoneThreadIds = [] } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('invalid limit');
  if (before !== null && (!before || !Number.isSafeInteger(before.recency) || typeof before.id !== 'string')) throw new TypeError('invalid cursor');
  const state = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'));
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let rows;
  try {
    const hasAttachedParent = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'attached_thread_parent_id');
    rows = db.prepare(`SELECT id, title, name, cwd, recency_at_ms AS recency FROM threads
      WHERE archived = 0 AND source = 'vscode' AND (thread_source IN ('user', 'agent_created_thread') OR (thread_source IS NULL AND id IN (SELECT value FROM json_each(?))))
        ${hasAttachedParent ? 'AND attached_thread_parent_id IS NULL' : ''}
        AND preview <> '' AND (? IS NULL OR recency_at_ms < ? OR (recency_at_ms = ? AND id < ?))
      ORDER BY recency_at_ms DESC, id DESC LIMIT ?`).all(JSON.stringify(phoneThreadIds), before?.recency ?? null, before?.recency ?? null,
        before?.recency ?? null, before?.id ?? null, limit + 1);
  } finally { db.close(); }
  const more = rows.length > limit;
  rows = rows.slice(0, limit);
  const projects = state['local-projects'] || {};
  const assignments = state['thread-project-assignments'] || {};
  const desktopUi = state['electron-persisted-atom-state'] || {};
  const readState = projectDesktopReadState(state);
  const unread = readState.status === 'available' ? readState.unreadThreadIds : null;
  // Pagination reads the Desktop file afresh for each page. A digest of the
  // entire native set lets the aggregator reject a mixed snapshot, even if
  // its identity scope stayed the same. It is internal to the connector and
  // is never included in the public aggregate.
  const nativeUnread = unread
    ? { status: 'available', scopeKey: readState.scopeKey,
        snapshotKey: createHash('sha256').update(JSON.stringify([...unread].sort())).digest('hex') }
    : { status: 'unavailable' };
  const grouped = new Map();
  const recent = [];
  const projectless = new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []);
  const roots = new Map();
  for (const project of Object.values(projects)) {
    if (!project || typeof project.id !== 'string' || typeof project.name !== 'string') continue;
    const expanded = desktopUi[`sidebar-project-expanded-v1-codex:${project.id}`];
    grouped.set(project.id, { id: project.id, name: project.name, expanded: typeof expanded === 'boolean' ? expanded : false, threads: [] });
    for (const root of Array.isArray(project.rootPaths) ? project.rootPaths : []) {
      const key = pathKey(root);
      if (key === null) continue;
      roots.set(key, roots.has(key) ? null : project.id);
    }
  }
  for (const row of rows) {
    const thread = { id: row.id, title: row.name || row.title, status: 'unknown', ...(unread?.has(row.id) ? { unread: true } : {}), ...(includeRecency && Number.isSafeInteger(row.recency) ? { recency: row.recency } : {}) };
    const assignment = assignments[row.id];
    let project = assignment?.projectKind === 'local' && projects[assignment.projectId];
    const root = pathKey(row.cwd);
    if (!assignment && !projectless.has(row.id) && root !== null) {
      if (roots.has(root)) project = projects[roots.get(root)];
      else {
        const matches = new Set();
        for (const [candidate, projectId] of roots) {
          if (sameOrInside(candidate, root)) matches.add(projectId);
        }
        if (matches.size === 1 && !matches.has(null)) project = projects[[...matches][0]];
      }
    }
    if (project && typeof project.name === 'string') {
      const group = grouped.get(project.id);
      if (group) group.threads.push(thread);
      else recent.push(thread);
    } else recent.push(thread);
  }
  const order = state['project-order'] || [];
  const ordered = [...grouped.values()].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
  const last = rows.at(-1);
  return { projects: ordered, recent, nextCursor: more && last ? { recency: last.recency, id: last.id } : null, nativeUnread };
}
