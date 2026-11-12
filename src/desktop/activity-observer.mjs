import { TaskNotificationMonitor } from '../notifications/task-monitor.mjs';
import { projectActivitySnapshot } from './activity-snapshot.mjs';

// Viewing activity is read-only and does not enable notification delivery.
// Supplement the notification monitor with a short-lived, non-notifying scan.
// Probe oldest or unseen records first, with a fixed budget per refresh.
export function createActivityObserver({ list, listThreads, createSession, hostId = 'local', sharedMonitor = () => null,
  createMonitor = options => new TaskNotificationMonitor(options), idleMs = 30000, maxAgeMs = 300000, now = Date.now } = {}) {
  if (typeof list !== 'function' || typeof listThreads !== 'function' || typeof createSession !== 'function'
      || typeof sharedMonitor !== 'function' || typeof createMonitor !== 'function'
      || !Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || typeof now !== 'function') throw new TypeError('Invalid activity observer');
  let owned = null, timer = null, closed = false;
  const closeOwned = () => { const old = owned; owned = null; if (old) void Promise.resolve(old.close()).catch(() => {}); };
  return {
    async snapshot() {
      if (closed) throw new Error('Activity observer closed');
      clearTimeout(timer);
      const shared = sharedMonitor();
      const monitor = owned || (owned = createMonitor({ hostId: 'local', listThreads, createSession,
        initialProbeLimit: 1, maxActive: 8, concurrency: 2, discoveryConcurrency: 4, probesPerPoll: 32, maxQueued: 64,
        activityProbes: true, onEvent() {}, onClear() {} }).start());
      timer = setTimeout(closeOwned, idleMs); timer.unref?.();
      const data = await list();
      if (closed || owned !== monitor || sharedMonitor() !== shared) throw new Error('Activity observation changed');
      const timestamp = now();
      const scope = data.nativeUnread?.status === 'available' ? data.nativeUnread.scopeKey : null;
      const ids = [...data.recent, ...data.projects.flatMap(group => group.threads || [])].map(task => task.id).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || ''));
      const records = new Map(), entries = new Map();
      for (const id of ids) {
        const candidates = [shared, monitor].filter(Boolean).map(source => ({ source, record: source.records?.get(id) })).filter(value => value.record);
        const usable = value => Boolean(scope && value.record.readScopeKey === scope && value.record.summary && !value.record.failed);
        const live = value => Boolean(value.source.entries?.get(id)?.initialized);
        candidates.sort((a, b) => Number(usable(b)) - Number(usable(a)) || Number(live(b)) - Number(live(a)) || (b.record.observedAt || 0) - (a.record.observedAt || 0));
        const chosen = candidates[0];
        if (chosen) { records.set(id, chosen.record); if (live(chosen)) entries.set(id, true); }
      }
      const candidates = [...new Set(ids)].sort((a, b) => (records.get(b)?.recency ?? -1) - (records.get(a)?.recency ?? -1) || a.localeCompare(b)).slice(0, 500).filter(id => {
        const record = records.get(id), local = monitor.records?.get(id);
        const ageLimit = record?.summary?.active ? Math.min(maxAgeMs, 30000) : maxAgeMs;
        return local && !entries.has(id) && (!record?.summary || record.failed || record.readScopeKey !== scope || !record.observedAt || timestamp < record.observedAt || timestamp - record.observedAt > ageLimit) && !(local.retryAt > timestamp);
      }).sort((a, b) => (records.get(a)?.observedAt || 0) - (records.get(b)?.observedAt || 0)).slice(0, 32);
      monitor.requestActivityProbes?.(candidates);
      return projectActivitySnapshot(data, { records, entries, hasListed: monitor.hasListed || shared?.hasListed, listConfirmed: monitor.listConfirmed || shared?.listConfirmed }, { now: timestamp, maxAge: maxAgeMs });
    },
    close() { closed = true; clearTimeout(timer); closeOwned(); },
  };
}
