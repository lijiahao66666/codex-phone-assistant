import { TaskNotificationMonitor } from '../notifications/task-monitor.mjs';
import { projectActivitySnapshot } from './activity-snapshot.mjs';

// Viewing activity is read-only and does not enable notification delivery.
// Share the notification monitor when present; otherwise retain a bounded
// observer briefly so multiple refreshes can finish the initial scan.
export function createActivityObserver({ list, listThreads, createSession, hostId = 'local', sharedMonitor = () => null,
  createMonitor = options => new TaskNotificationMonitor(options), idleMs = 30000 } = {}) {
  if (typeof list !== 'function' || typeof listThreads !== 'function' || typeof createSession !== 'function'
      || typeof sharedMonitor !== 'function' || typeof createMonitor !== 'function'
      || !Number.isSafeInteger(idleMs) || idleMs < 1) throw new TypeError('Invalid activity observer');
  let owned = null, timer = null, closed = false;
  const closeOwned = () => { const old = owned; owned = null; if (old) void Promise.resolve(old.close()).catch(() => {}); };
  return {
    async snapshot() {
      if (closed) throw new Error('Activity observer closed');
      clearTimeout(timer);
      const shared = sharedMonitor();
      if (shared) closeOwned();
      const monitor = shared || owned || (owned = createMonitor({ hostId: 'local', listThreads, createSession,
        initialProbeLimit: 256, maxQueued: 512, onEvent() {}, onClear() {} }).start());
      if (!shared) { timer = setTimeout(closeOwned, idleMs); timer.unref?.(); }
      const data = await list();
      if (closed || (!shared && owned !== monitor) || (shared && sharedMonitor() !== shared)) throw new Error('Activity observation changed');
      return projectActivitySnapshot(data, monitor);
    },
    close() { closed = true; clearTimeout(timer); closeOwned(); },
  };
}
