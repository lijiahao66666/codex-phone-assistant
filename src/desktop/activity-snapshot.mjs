const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only authorize through the same bounded list as the rest of the phone UI.
// A missing or stale observation is unknown, never proof of an idle task.
export function projectActivitySnapshot(list, monitor, { limit = 500, now = Date.now(), maxAge = Infinity } = {}) {
  if (!list || !Array.isArray(list.projects) || !Array.isArray(list.recent)
      || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid activity list');
  const tasks = [...list.recent, ...list.projects.flatMap(group => Array.isArray(group?.threads) ? group.threads : [])];
  const seen = new Set(), items = [];
  const scope = list.nativeUnread?.status === 'available' && /^[a-f0-9]{64}$/.test(list.nativeUnread.scopeKey || '') ? list.nativeUnread.scopeKey : null;
  for (const task of tasks) {
    if (!uuid.test(task?.id || '') || seen.has(task.id)) continue;
    seen.add(task.id);
    const record = monitor?.records?.get(task.id);
    const ageLimit = record?.summary?.active ? Math.min(maxAge, 30000) : maxAge;
    const current = monitor?.entries?.has(task.id) || Number.isSafeInteger(record?.observedAt) && now - record.observedAt >= 0 && now - record.observedAt <= ageLimit;
    const known = Boolean(scope && record?.readScopeKey === scope && record.summary && !record.failed && (maxAge === Infinity || current));
    const kinds = known ? new Set((record.summary.controls || []).map(item => item?.kind)) : new Set();
    const waiting = kinds.has('question') && kinds.has('approval') ? 'both' : kinds.has('question') ? 'question' : kinds.has('approval') ? 'approval' : null;
    items.push({ id: task.id, title: typeof task.title === 'string' ? task.title.slice(0, 512) : '',
      recency: Number.isSafeInteger(record?.recency) ? record.recency : null,
      unread: scope ? task.unread === true : null,
      active: known ? record.summary.active === true : null, waiting, statusKnown: known });
  }
  items.sort((a, b) => (b.recency ?? -1) - (a.recency ?? -1) || a.id.localeCompare(b.id));
  const truncated = list.truncated === true || items.length > limit;
  const visible = items.slice(0, limit);
  return { items: visible, scopeKey: scope, complete: !truncated && Boolean(monitor?.hasListed && monitor?.listConfirmed) && visible.every(item => item.statusKnown && item.unread !== null), truncated };
}
