(() => {
  const root = typeof window === 'object' ? window : self;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const kinds = new Set(['completed', 'question', 'approval']);
  const scope = pair => pair && uuid.test(pair.hostId || '') && uuid.test(pair.deviceId || '')
    ? JSON.stringify([pair.hostId, pair.deviceId]) : null;
  let database, badgeWork, badgeRequested = false;

  function open() {
    if (database) return database;
    const opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('Reminder storage unavailable'));
      let failed = false;
      const request = root.indexedDB.open('codex-task-reminders', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('state'); };
      request.onerror = request.onblocked = () => { failed = true; reject(new Error('Reminder storage unavailable')); };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); if (database === opening) database = null; };
        resolve(db);
      };
    }).catch(error => { if (database === opening) database = null; throw error; });
    database = opening; return opening;
  }

  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction('state', mode), store = tx.objectStore('state');
      const run = fn => { try { fn(); } catch { tx.abort(); } };
      const get = (key, next) => {
        const request = store.get(key);
        request.onsuccess = () => run(() => next(request.result));
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('Reminder storage unavailable'));
      run(() => action({ get, store, done: value => { result = value; } }));
    });
  }

  const metadata = value => value && typeof value.revision === 'number' ? value : { key: null, revision: 0 };
  const rows = value => Array.isArray(value) ? value : [];
  const active = () => transaction('readonly', ({ get, done }) => get('active', value => done(metadata(value))));
  async function badgeSnapshot() {
    return transaction('readonly', ({ get, done }) => get('active', value => {
      const current = metadata(value);
      if (!current.key) return done({ ...current, count: 0 });
      get('scope:' + current.key, value => done({ ...current, count: rows(value).length }));
    }));
  }
  function syncBadge() {
    const navigator = root.navigator;
    if (typeof navigator?.setAppBadge !== 'function' && typeof navigator?.clearAppBadge !== 'function') return Promise.resolve();
    badgeRequested = true;
    if (badgeWork) return badgeWork;
    badgeWork = (async () => {
      while (badgeRequested) {
        badgeRequested = false;
        const snapshot = await badgeSnapshot();
        try {
          if (snapshot.count) await navigator.setAppBadge?.(snapshot.count);
          else if (navigator.clearAppBadge) await navigator.clearAppBadge();
          else await navigator.setAppBadge(0);
        } catch { /* Badge support or permission must not break reminders. */ }
        // Window and service worker have separate execution queues. If another
        // context commits while a badge call is pending, apply its fresh count.
        if ((await active()).revision !== snapshot.revision) badgeRequested = true;
      }
    })().finally(() => { badgeWork = null; if (badgeRequested) return syncBadge(); });
    return badgeWork;
  }
  async function finish(operation) {
    const result = await operation;
    await syncBadge().catch(() => {});
    return result;
  }
  function requireScope(pair) {
    const key = scope(pair);
    if (!key) throw new TypeError('Invalid reminder pair');
    return key;
  }
  function mutate(pair, change) {
    const key = requireScope(pair);
    return finish(transaction('readwrite', ({ get, store, done }) => get('active', value => {
      const current = metadata(value);
      if (current.key !== key) return done({ ignored: true });
      get('scope:' + key, value => {
        const existing = rows(value);
        get('seen:' + key, value => {
          const result = change(existing, rows(value));
          if (result.rows) {
            store.put(result.rows, 'scope:' + key);
            store.put({ key, revision: current.revision + 1 }, 'active');
          }
          if (result.seen) store.put(result.seen, 'seen:' + key);
          done(result.value);
        });
      });
    })));
  }

  root.taskReminderStore = {
    async activate(pair) {
      const key = pair == null ? null : requireScope(pair);
      return finish(transaction('readwrite', ({ get, store, done }) => get('active', value => {
        store.put({ key, revision: metadata(value).revision + 1 }, 'active');
        done({ active: key !== null });
      })));
    },
    async isActive(pair) { const key = scope(pair); return Boolean(key && (await active()).key === key); },
    async hasEvent(pair, event) {
      const key = requireScope(pair);
      if (!event || !uuid.test(event.threadId || '') || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 512) throw new TypeError('Invalid reminder event');
      return transaction('readonly', ({ get, done }) => get('active', value => {
        if (metadata(value).key !== key) return done(false);
        const identity = JSON.stringify([event.threadId, event.eventId]);
        get('seen:' + key, value => {
          if (rows(value).includes(identity)) return done(true);
          get('scope:' + key, value => done(rows(value).some(item => item.threadId === event.threadId && item.eventId === event.eventId)));
        });
      }));
    },
    async list(pair) {
      const key = requireScope(pair);
      return finish(transaction('readonly', ({ get, done }) => get('scope:' + key, value => done(rows(value)))));
    },
    async put(pair, event) {
      if (!event || !uuid.test(event.threadId || '') || !kinds.has(event.kind) || typeof event.eventId !== 'string'
          || !event.eventId || event.eventId.length > 512) return Promise.reject(new TypeError('Invalid reminder event'));
      return mutate(pair, (existing, seen) => {
        const identity = JSON.stringify([event.threadId, event.eventId]);
        if (seen.includes(identity) || existing.some(item => item.threadId === event.threadId && item.eventId === event.eventId)) return { value: { duplicate: true } };
        const next = existing.filter(item => item.threadId !== event.threadId);
        next.push({ threadId: event.threadId, kind: event.kind, eventId: event.eventId });
        // Keep a bounded receipt window after a task is read. A duplicate push
        // arriving just after removal must not restore its unread badge.
        return { rows: next.slice(-256), seen: [...seen, identity].slice(-512), value: { stored: true, duplicate: false } };
      });
    },
    async remove(pair, threadId) {
      if (!uuid.test(threadId || '')) return Promise.reject(new TypeError('Invalid reminder thread'));
      return mutate(pair, existing => {
        const next = existing.filter(item => item.threadId !== threadId);
        return { rows: next, value: { removed: next.length !== existing.length } };
      });
    },
    async removeEvent(pair, event) {
      if (!event || !uuid.test(event.threadId || '') || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 512) throw new TypeError('Invalid reminder event');
      return mutate(pair, (existing, seen) => {
        const identity = JSON.stringify([event.threadId, event.eventId]);
        const next = existing.filter(item => item.threadId !== event.threadId || item.eventId !== event.eventId);
        return { rows: next, seen: seen.includes(identity) ? seen : [...seen, identity].slice(-512), value: { removed: next.length !== existing.length } };
      });
    },
    async clear(pair) { return mutate(pair, () => ({ rows: [], value: { cleared: true } })); },
  };
})();
