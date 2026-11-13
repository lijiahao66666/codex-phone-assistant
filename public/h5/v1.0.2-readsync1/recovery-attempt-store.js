const recoveryUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This store holds only an operation identifier, never message content.
export function createRecoveryAttemptStore({ indexedDB = globalThis.indexedDB, name = 'codex-phone-recovery-attempts' } = {}) {
  if (!indexedDB) throw new Error('Recovery storage unavailable');
  let opening;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('attempts');
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
      request.onerror = () => { if (!settled) { settled = true; opening = undefined; reject(request.error || new Error('Recovery storage unavailable')); } };
      request.onblocked = () => { if (!settled) { settled = true; opening = undefined; reject(new Error('Recovery storage blocked')); } };
    });
    return opening;
  }
  function validate(...values) {
    if (values.some(value => typeof value !== 'string' || !recoveryUuid.test(value))) throw new TypeError('Invalid recovery identity');
  }
  async function transact(deviceId, threadId, mode, action) {
    validate(deviceId, threadId);
    const db = await open();
    return new Promise((resolve, reject) => {
      let transaction, result;
      try {
        transaction = db.transaction('attempts', mode);
        const store = transaction.objectStore('attempts');
        const request = store.get([deviceId, threadId]);
        request.onsuccess = () => {
          try { result = action(store, [deviceId, threadId], request.result); }
          catch (error) { result = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(result instanceof Error ? result : transaction.error || new Error('Recovery storage transaction failed'));
      } catch (error) { reject(error); }
    });
  }
  return {
    read(deviceId, threadId) {
      return transact(deviceId, threadId, 'readonly', (_store, _key, value) => {
        if (value === undefined) return null;
        if (typeof value !== 'string' || !recoveryUuid.test(value)) throw new Error('Invalid recovery record');
        return value;
      });
    },
    reserve(deviceId, threadId, requestId) {
      validate(requestId);
      return transact(deviceId, threadId, 'readwrite', (store, key, value) => {
        if (value !== undefined) {
          if (typeof value !== 'string' || !recoveryUuid.test(value)) throw new Error('Invalid recovery record');
          return false;
        }
        store.add(requestId, key);
        return true;
      });
    },
    remove(deviceId, threadId, requestId) {
      validate(requestId);
      return transact(deviceId, threadId, 'readwrite', (store, key, value) => {
        if (value === undefined) return false;
        if (typeof value !== 'string' || !recoveryUuid.test(value)) throw new Error('Invalid recovery record');
        if (value !== requestId) return false;
        store.delete(key);
        return true;
      });
    },
    async close() { if (opening) { const db = await opening; db.close(); opening = undefined; } },
  };
}
