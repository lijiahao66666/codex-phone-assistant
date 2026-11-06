import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathKey, sameOrInside } from './path-utils.mjs';

function unreadLocalThreads(state) {
  const identity = state['electron-persisted-atom-state']?.['local-document-identity'];
  if (typeof identity?.accountId !== 'string' || !identity.accountId || typeof identity?.userId !== 'string' || !identity.userId) return null;
  const key = createHash('sha256').update(JSON.stringify(['chatgpt', identity.accountId, identity.userId])).digest('hex');
  const hosts = state['electron-thread-read-state-v1']?.unreadByIdentity?.[key];
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return null;
  const localKeys = Object.keys(hosts).filter(host => /^local:[a-f0-9]{64}$/.test(host));
  if (localKeys.length !== 1 || !Array.isArray(hosts[localKeys[0]])) return null;
  return new Set(hosts[localKeys[0]].filter(id => typeof id === 'string'));
}

// This reads desktop-owned indexes; neither file is modified or opened for writing.
export async function listDesktopThreads({ codexHome = join(homedir(), '.codex'), limit = 200, before = null, includeRecency = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('invalid limit');
  if (before !== null && (!before || !Number.isSafeInteger(before.recency) || typeof before.id !== 'string')) throw new TypeError('invalid cursor');
  const state = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'));
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let rows;
  try {
    const hasAttachedParent = db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'attached_thread_parent_id');
    rows = db.prepare(`SELECT id, title, name, cwd, recency_at_ms AS recency FROM threads
      WHERE archived = 0 AND source = 'vscode' AND thread_source IN ('user', 'agent_created_thread')
        ${hasAttachedParent ? 'AND attached_thread_parent_id IS NULL' : ''}
        AND preview <> '' AND (? IS NULL OR recency_at_ms < ? OR (recency_at_ms = ? AND id < ?))
      ORDER BY recency_at_ms DESC, id DESC LIMIT ?`).all(before?.recency ?? null, before?.recency ?? null,
        before?.recency ?? null, before?.id ?? null, limit + 1);
  } finally { db.close(); }
  const more = rows.length > limit;
  rows = rows.slice(0, limit);
  const projects = state['local-projects'] || {};
  const assignments = state['thread-project-assignments'] || {};
  const desktopUi = state['electron-persisted-atom-state'] || {};
  const unread = unreadLocalThreads(state);
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
  return { projects: ordered, recent, nextCursor: more && last ? { recency: last.recency, id: last.id } : null };
}
