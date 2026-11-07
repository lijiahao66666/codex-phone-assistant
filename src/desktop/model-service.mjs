import { changeModel, readModelCatalog } from './model-catalog.mjs';
import { randomUUID } from 'node:crypto';

// Instantiate per assistant runtime. The caller owns device authentication.
export function createModelService({ request, sessionFor, createObserver, observerTimeoutMs = 15000, maxObservers = 16, writes = new Set(), journal, hostId }) {
  if (typeof request !== 'function' || typeof sessionFor !== 'function') throw new TypeError('Dependencies required');
  const pending = new Map();
  const writeOwners = new Map();
  const clearPending = (threadId, entry) => { if (pending.get(threadId) === entry) pending.delete(threadId); };
  const releaseWrite = (threadId, entry) => { if (writeOwners.get(threadId) === entry) { writeOwners.delete(threadId); writes.delete(threadId); } };
  const closingObservers = new Set();
  let observers = 0, closed = false;
  const closeObserver = entry => {
    if (!entry.observer) return;
    const observer = entry.observer; entry.observer = null; observers--;
    entry.cancelReady?.(); entry.cancelReady = null;
    clearTimeout(entry.observerTimer); observer.removeListener('state', entry.onState);
    let closing;
    try { closing = Promise.resolve(observer.close()).catch(() => {}); }
    catch { closing = Promise.resolve(); }
    closingObservers.add(closing);
    void closing.finally(() => closingObservers.delete(closing));
  };
  // A different assistant process may cancel a prepared operation. Reconcile
  // only an exact operation ID; dispatched and unknown rows remain locked.
  const reconcileCancelled = threadId => {
    const entry = pending.get(threadId), record = journal?.get(hostId, threadId);
    if (!entry || !journal || (record && record.operationId === entry.operationId)) return false;
    if (record?.operationId === entry.operationId && record.phase !== 'prepared') return false;
    entry.cancelled = true;
    clearPending(threadId, entry);
    releaseWrite(threadId, entry);
    closeObserver(entry);
    return true;
  };
  const matchesTarget = (entry, threadId, session) => {
    const state = session?.value?.latestCollaborationMode?.settings;
    return session === entry.session && session?.status === 'ready' && session.value?.id === threadId && entry.target &&
      session.conversation?.ownerId === entry.owner && Number.isSafeInteger(session.revision) && session.revision > entry.revision &&
      session.value.latestCollaborationMode.mode === entry.target.mode && state?.model === entry.target.model && state?.reasoning_effort === entry.target.effort;
  };
  const service = {
    async list() { return readModelCatalog(request); },
    async change({ deviceId, threadId, model, effort = null, mode = null }) {
      if (![deviceId, threadId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200) || (mode === null ? typeof model !== 'string' || !model || model.length > 200 : !['plan', 'default'].includes(mode) || model !== undefined) || (effort !== null && (typeof effort !== 'string' || effort.length > 64))) return { status: 'unavailable' };
      if (closed) return { status: 'unavailable' };
      if (pending.has(threadId) || writes.has(threadId) || (journal && journal.get(hostId, threadId))) return { status: 'pending' };
      if (pending.size >= 1024) return { status: 'unavailable' };
      const entry = { deviceId, operationId: randomUUID(), target: null, status: 'checking' };
      pending.set(threadId, entry);
      writes.add(threadId);
      writeOwners.set(threadId, entry);
      let sent = false, recorded = false;
      try {
        if (journal) {
          if (!journal.begin(hostId, threadId, deviceId, entry.operationId)) { clearPending(threadId, entry); return { status: 'pending' }; }
          recorded = true;
        }
        const catalog = mode === null ? await readModelCatalog(request) : null;
        if (closed || entry.cancelled) { clearPending(threadId, entry); return { status: 'unavailable' }; }
        const phoneSession = sessionFor(deviceId, threadId);
        if (!phoneSession || phoneSession.status !== 'ready' || phoneSession.value?.threadRuntimeStatus?.type !== 'idle') { clearPending(threadId, entry); return { status: 'unavailable' }; }
        let session = phoneSession;
        if (createObserver) {
          if (observers >= maxObservers) { clearPending(threadId, entry); return { status: 'unavailable' }; }
          session = createObserver(threadId); entry.observer = session; observers++;
          const ready = await new Promise(resolve => {
            let done = false;
            const finish = result => { if (done) return; done = true; clearTimeout(entry.observerTimer); resolve(result); };
            entry.cancelReady = () => finish(false);
            entry.onState = event => {
              if (!done) { if (event.status === 'ready') finish(true); else if (event.status === 'unavailable') finish(false); return; }
              if (event.status !== 'ready' || session.conversation?.ownerId !== entry.owner) { entry.observerInvalid = true; closeObserver(entry); return; }
              if (!entry.observerInvalid) service.observe({ deviceId, threadId, session });
            };
            session.on('state', entry.onState);
            entry.observerTimer = setTimeout(() => finish(false), observerTimeoutMs);
            try { session.start(); } catch { finish(false); }
          });
          entry.cancelReady = null;
          if (!ready || closed || entry.cancelled || sessionFor(deviceId, threadId) !== phoneSession || phoneSession.status !== 'ready' || session.conversation?.ownerId !== phoneSession.conversation?.ownerId) { closeObserver(entry); clearPending(threadId, entry); return { status: 'unavailable' }; }
          entry.observerTimer = setTimeout(() => { entry.observerInvalid = true; closeObserver(entry); }, observerTimeoutMs);
        }
        if (!Number.isSafeInteger(session.revision) || !session.conversation?.ownerId) { clearPending(threadId, entry); return { status: 'unavailable' }; }
        const current = session.value?.latestCollaborationMode?.settings;
        if (mode === null ? current?.model === model && (effort === null || current.reasoning_effort === effort) : session.value?.latestCollaborationMode?.mode === mode) { clearPending(threadId, entry); return { status: 'confirmed' }; }
        const originalClient = session.client;
        if (!originalClient || typeof originalClient.setCollaborationMode !== 'function') { clearPending(threadId, entry); return { status: 'unavailable' }; }
        const client = Object.create(originalClient);
        client.setCollaborationMode = (...args) => {
          const [conversationId, mode, settings, options] = args;
          entry.target = { model: settings.model, effort: settings.reasoning_effort, mode };
          entry.revision = session.revision;
          entry.owner = session.conversation.ownerId;
          entry.session = session;
          if (journal && !journal.dispatch(hostId, threadId, deviceId, entry.operationId)) throw Object.assign(new Error('Settings reservation unavailable'), { code: 'unavailable' });
          sent = true;
          return originalClient.setCollaborationMode(conversationId, mode, settings, { ...options,
            beforeWrite: () => callerReady() && (!options?.beforeWrite || options.beforeWrite()) });
        };
        const proxy = Object.create(session);
        proxy.client = client;
        const callerReady = () => !closed && sessionFor(deviceId, threadId) === phoneSession && phoneSession.status === 'ready';
        const result = mode === null
          ? await changeModel({ catalog, session: proxy, model, effort, validateCaller: callerReady })
          : await proxy.setCollaborationMode(mode);
        if (closed) { entry.status = 'unknown'; return { status: 'unknown' }; }
        if (result?.applied !== true && result?.ok !== true) { entry.status = 'unknown'; return { status: 'unknown' }; }
        entry.status = 'awaiting-state';
        if (entry.observed && !entry.observerInvalid && matchesTarget(entry, threadId, session)) { if (recorded) journal.complete(hostId, threadId, deviceId, entry.operationId); clearPending(threadId, entry); closeObserver(entry); }
        return { status: 'accepted', target: entry.target };
      } catch (error) {
        if (!sent || (!closed && error?.code === 'unavailable')) { if (sent && recorded) { journal.complete(hostId, threadId, deviceId, entry.operationId); recorded = false; } clearPending(threadId, entry); closeObserver(entry); return { status: 'unavailable' }; }
        entry.status = 'unknown';
        closeObserver(entry);
        return { status: 'unknown' };
      } finally { releaseWrite(threadId, entry); if (!sent && recorded) journal.cancelPrepared(hostId, threadId, deviceId, entry.operationId); if (!sent || entry.status === 'unknown') closeObserver(entry); }
    },
    observe({ deviceId, threadId, session }) {
      const entry = pending.get(threadId);
      if (!entry || session !== entry.session) return false;
      if (entry.status === 'checking') entry.observed = false;
      if (!matchesTarget(entry, threadId, session)) return false;
      if (entry.status === 'checking') { entry.observed = true; return false; }
      if (entry.status !== 'awaiting-state') return false;
      if (journal) journal.complete(hostId, threadId, entry.deviceId, entry.operationId);
      clearPending(threadId, entry); closeObserver(entry); return true;
    },
    status(threadId) { reconcileCancelled(threadId); return pending.get(threadId)?.status || (journal?.get(hostId, threadId) ? 'unknown' : null); },
    prepared(threadId) {
      reconcileCancelled(threadId);
      const record = journal?.get(hostId, threadId);
      return record?.phase === 'prepared' && typeof record.operationId === 'string' ? record.operationId : null;
    },
    cancelPrepared(threadId, operationId) {
      const record = journal?.get(hostId, threadId);
      if (!record || record.phase !== 'prepared' || record.operationId !== operationId) return false;
      if (!journal.cancelPrepared(hostId, threadId, record.deviceId, operationId)) return false;
      const entry = pending.get(threadId);
      if (entry?.operationId === operationId) { entry.cancelled = true; clearPending(threadId, entry); releaseWrite(threadId, entry); closeObserver(entry); }
      return true;
    },
    isLocked(threadId) { reconcileCancelled(threadId); return pending.has(threadId) || Boolean(journal?.get(hostId, threadId)); },
    async close() { closed = true; for (const entry of pending.values()) closeObserver(entry); await Promise.all([...closingObservers]); },
  };
  return service;
}
