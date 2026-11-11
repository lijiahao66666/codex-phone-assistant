import { WebSocket } from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopSession } from '../desktop/session.mjs';
import { trace } from '../desktop/diagnostics.mjs';
import { createStreamDiagnostics } from '../common/stream-diagnostics.mjs';
import { desktopView } from '../desktop/view.mjs';
import { listDesktopThreads, ThreadListChanges } from '../desktop/thread-list.mjs';
import { readRolloutHistory, isRecoverableHistoryThread } from '../desktop/rollout-history.mjs';
import { UploadStore } from '../media/upload-store.mjs';
import { ChunkUploads } from '../media/chunk-upload.mjs';
import { mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readChangedFile, readLinkedFile, changedFileReference, linkedFileReference, linkedPreviewMatches, verifyPreviewIdentity } from '../media/file-preview.mjs';
import { SidebarStatus } from '../desktop/sidebar-status.mjs';
import { StatusPriorities } from '../desktop/status-priorities.mjs';
import { createWebSocketSendScheduler } from './ws-send-scheduler.mjs';
import { makeWindow, makePage } from '../desktop/history-pagination.mjs';
import { lazyToolOutputs, toolOutputPage } from '../desktop/tool-output.mjs';
import { createRecordedHistoryPager } from '../desktop/recorded-history-page.mjs';
import { BoundedSnapshotStream } from './bounded-snapshot-stream.mjs';
import { payloadDigest } from '../media/payload-digest.mjs';
import { createModelService } from '../desktop/model-service.mjs';
import { TaskNotificationMonitor } from '../notifications/task-monitor.mjs';
import { createThreadArchive } from '../desktop/thread-archive.mjs';

export function viewUpdate(previous, conversation, seq, version = 1) {
  const snapshot = { event: 'state', data: { seq, conversation } };
  if (!previous || previous.conversation.id !== conversation.id || !Array.isArray(conversation.turns)) return snapshot;
  const valid = (turns, field = 'id') => Array.isArray(turns) && turns.every(t => t && typeof t[field] === 'string' && t[field].length > 0) && new Set(turns.map(t => t[field])).size === turns.length;
  const prior = previous.conversation.turns;
  const useKeys = version >= 3 && valid(prior, 'viewKey') && valid(conversation.turns, 'viewKey');
  const field = useKeys ? 'viewKey' : 'id';
  if (!valid(prior, field) || !valid(conversation.turns, field)) return snapshot;
  if (version >= 3 && !useKeys && (prior?.some(turn => turn?.viewKey) || conversation.turns.some(turn => turn?.viewKey))) return snapshot;
  const old = new Map(prior.map(turn => [turn[field], turn]));
  const changed = [], itemChanges = [];
  for (const turn of conversation.turns) {
    const before = old.get(turn[field]);
    if (before && JSON.stringify(before) === JSON.stringify(turn)) continue;
    if (version >= 2 && before && before.id === turn.id && valid(before.items) && valid(turn.items)) {
      const items = new Map(before.items.map(item => [item.id, JSON.stringify(item)]));
      const { items: currentItems, ...turnMetadata } = turn;
      const patch = { id: turn[field], metadata: turnMetadata, order: currentItems.map(item => item.id), changed: currentItems.filter(item => items.get(item.id) !== JSON.stringify(item)) };
      if (Buffer.byteLength(JSON.stringify(patch)) < Buffer.byteLength(JSON.stringify(turn))) { itemChanges.push(patch); continue; }
    }
    changed.push(turn);
  }
  const { turns, ...metadata } = conversation;
  const delta = { event: 'state-delta', data: { baseSeq: previous.seq, seq, metadata, ...(useKeys ? { keyField: 'viewKey' } : {}), order: turns.map(t => t[field]), changed, ...(itemChanges.length ? { itemChanges } : {}) } };
  return Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(snapshot)) ? delta : snapshot;
}

export async function listAllThreads(listThreads) {
  let cursor = null, nextCursor = null;
  const projects = new Map(), recent = [], seen = new Set();
  let bytes = 1024, truncated = false;
  const statusCandidates = [];
  const add = (items, thread) => {
    if (!thread?.id || seen.has(thread.id)) return true;
    const { recency, ...visible } = thread;
    const size = Buffer.byteLength(JSON.stringify(visible)) + 2;
    if (bytes + size > 512 * 1024) { truncated = true; return false; }
    bytes += size; seen.add(thread.id); items.push(visible);
    if (Number.isSafeInteger(recency)) statusCandidates.push({ id: thread.id, recency });
    return true;
  };
  for (let page = 0; page < 20; page++) {
    const data = await listThreads({ ...(cursor ? { before: cursor } : {}), includeRecency: true });
    if (!Array.isArray(data?.projects) || !Array.isArray(data?.recent)) throw new Error('Invalid thread list');
    for (const group of data.projects) {
      if (!group || typeof group.id !== 'string' || !Array.isArray(group.threads)) throw new Error('Invalid project');
      if (!projects.has(group.id)) {
        const project = { ...group, threads: [] };
        const size = Buffer.byteLength(JSON.stringify(project)) + 2;
        if (bytes + size > 512 * 1024) { truncated = true; break; }
        bytes += size; projects.set(group.id, project);
      }
      for (const thread of group.threads) if (!add(projects.get(group.id).threads, thread)) break;
      if (truncated) break;
    }
    if (!truncated) for (const thread of data.recent) if (!add(recent, thread)) break;
    nextCursor = data.nextCursor || null;
    if (truncated || !nextCursor) break;
    if (!Number.isSafeInteger(nextCursor.recency) || typeof nextCursor.id !== 'string' || (cursor && cursor.recency === nextCursor.recency && cursor.id === nextCursor.id)) throw new Error('Invalid cursor');
    cursor = nextCursor;
  }
  statusCandidates.sort((a, b) => b.recency - a.recency || b.id.localeCompare(a.id));
  return { projects: [...projects.values()], recent, truncated: truncated || Boolean(nextCursor), statusCandidates: statusCandidates.slice(0, 4).map(thread => thread.id) };
}

export function createThreadListCache(listThreads, { ttlMs = 2000, now = Date.now } = {}) {
  let snapshot, expires = 0, pending, generation = 0;
  return {
    async get() {
      if (snapshot && now() < expires) return structuredClone(snapshot);
      if (!pending) {
        const current = generation;
        const request = listAllThreads(listThreads).then(value => {
          if (generation === current) { snapshot = value; expires = now() + ttlMs; }
          return value;
        });
        pending = request;
        void request.finally(() => { if (pending === request) pending = undefined; }).catch(() => {});
      }
      return structuredClone(await pending);
    },
    clear() { generation++; snapshot = undefined; expires = 0; pending = undefined; },
  };
}

export async function populateThreadStatuses({ sidebarStatus, statusPriorities, deviceId, visibleThreads, handoverThread, data, statusCandidates, streams }) {
  const threads = [...data.recent, ...data.projects.flatMap(project => project.threads)];
  const allowed = new Set(threads.map(thread => thread.id));
  const observed = new Set([...streams.values()].filter(s => s.status === 'ready').map(s => s.value?.id));
  if (Array.isArray(visibleThreads) && visibleThreads.includes(handoverThread) && allowed.has(handoverThread)) observed.delete(handoverThread);
  const candidates = statusPriorities.select(deviceId, visibleThreads, allowed, statusCandidates, observed);
  await sidebarStatus.updateAndWait(candidates, 750, observed);
  for (const thread of threads) {
    const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === thread.id);
    const status = session?.value?.threadRuntimeStatus?.type ?? sidebarStatus.get(thread.id);
    thread.status = status === 'active' || status === 'idle' ? status : 'unknown';
  }
}

// Only one authenticated relay is configured; no arbitrary local HTTP proxying.
export function createPreviewConnector({ url, secret, hostId, ownerRouter, modelRequest, modelJournal, imageUpload = false, imagePreview = null, uploadRoot = join(homedir(), '.codex', 'phone-uploads'), createUploadContext, imageValidator, filePreviewHelper, sidebarStatusForTests, threadListChangesForTests, schedulerLimitForTests, onSidebarRetryForTests, yieldAfterClaimsForTests, createNotificationMonitorForTests, createSession = o => new DesktopSession(o), listThreads = listDesktopThreads, readHistory = readRolloutHistory, canRecoverHistory = readHistory === readRolloutHistory ? isRecoverableHistoryThread : async (id, options) => (await readHistory(id, options))?.id === id, recordedHistoryPager, retryMs = 2000, heartbeatTimeoutMs = 55000, allowInsecureForTests = false }) {
  const target = new URL(url);
  if ((target.protocol !== 'wss:' && !(allowInsecureForTests && target.protocol === 'ws:' && target.hostname === '127.0.0.1')) || target.pathname !== '/connector' || target.search || target.hash || target.username || target.password) throw new Error('WSS connector URL required');
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Connector secret must be at least 32 bytes');
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1) throw new Error('Invalid heartbeat timeout');
  if ((createUploadContext || imageValidator || filePreviewHelper || sidebarStatusForTests || threadListChangesForTests || schedulerLimitForTests || onSidebarRetryForTests || yieldAfterClaimsForTests || recordedHistoryPager || createNotificationMonitorForTests) && !allowInsecureForTests) throw new Error('Test overrides are unavailable');
  const streams = new Map(), writes = new Set(), sentRevisions = new Map(), modeRevisions = new Map(), answeredRequests = new Set(), imageTimers = new Map(), uploadChecks = new Set(); let ws, scheduler, timer, stopped = false, shuttingDown = false, activeMutations = 0;
  const mutationTypes = new Set(['notification-read', 'recover-chat', 'cancel-unseen-recovery', 'prepare-chat', 'submit-chat', 'create-chat', 'model-cancel', 'model', 'mode', 'thread-action', 'stop', 'user-input', 'approve', 'write', 'upload', 'cancel-upload']);
  const models = modelRequest ? createModelService({ request: modelRequest, writes, journal: modelJournal, hostId, ...(allowInsecureForTests ? {} : { createObserver: id => createSession({ conversationId: id, hostId: 'local' }) }), sessionFor: (deviceId, id) => [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === deviceId) }) : null;
  const recoveryLocked = id => {
    try { return ownerRouter ? ownerRouter.isRecoveryLocked(id) !== false : false; }
    catch { return true; }
  };
  const phoneOptions = options => typeof ownerRouter?.journal?.listThreadIds === 'function' ? { ...options, phoneThreadIds: ownerRouter.journal.listThreadIds(hostId) } : options;
  const readAuthorizedHistory = (id, options) => readHistory(id, phoneOptions(options));
  const historyPager = recordedHistoryPager || createRecordedHistoryPager();
  const readRecordedHistory = (id, deviceId, cursor = null) => historyPager.read(id, phoneOptions({
    cursor, scope: { hostId, deviceId }, maxTurns: 3, maxItems: 200, maxBytes: 256 * 1024, maxSingleItemBytes: 3 * 1024 * 1024,
  }));
  const readInitialHistory = (id, deviceId) => {
    if (recordedHistoryPager || readHistory === readRolloutHistory) {
      try { const recent = readRecordedHistory(id, deviceId); if (recent) return recent; } catch { /* Older Codex indexes may not support keyed pagination. */ }
    }
    return readAuthorizedHistory(id);
  };
  const listAuthorizedThreads = options => listThreads(phoneOptions(options));
  const sidebarStatus = allowInsecureForTests ? (sidebarStatusForTests || null) : new SidebarStatus();
  const observedOwner = ownerRouter?.localOwner;
  const onThreadReleased = threadId => {
    sidebarStatus?.invalidateThread?.(threadId);
    // A viewer can return after unsubscribe was dispatched. Rebind only that
    // conversation, including a new viewer still waiting for its first snapshot.
    for (const session of streams.values()) if (session.conversationId === threadId) session.ownershipReleased?.();
  };
  observedOwner?.on?.('threadReleased', onThreadReleased);
  const threadListChanges = allowInsecureForTests ? (threadListChangesForTests || null) : new ThreadListChanges();
  const statusPriorities = new StatusPriorities();
  function clearImageTimer(id) { clearTimeout(imageTimers.get(id)); imageTimers.delete(id); }
  function closeSession(session) { session.connectionDiagnostic?.mark('closed'); return session.close(); }
  function closeStreams() { for (const id of imageTimers.keys()) clearImageTimer(id); for (const session of streams.values()) { session.chunkStop?.(); void closeSession(session).catch(() => {}); } streams.clear(); }
  function send(msg, connection, { critical = false, request, deviceId, cancellable = false } = {}) {
    if (connection !== ws || request?.cancelled) return;
    let encoded = JSON.stringify(msg);
    if ((msg.type === 'event' || msg.type === 'flow-reset') && Buffer.byteLength(encoded) > 8 * 1024 * 1024) {
      const session = streams.get(msg.id);
      if (!session) return;
      streams.delete(msg.id); clearImageTimer(msg.id); void closeSession(session).catch(() => {});
      encoded = JSON.stringify({ type: 'stream-error', id: msg.id, code: 'state-too-large' });
    }
    const readResponse = msg.type === 'response' && !('status' in msg) && !critical;
    let queued = connection?.readyState === WebSocket.OPEN && scheduler?.enqueueControl(encoded, { reserved: !readResponse, requestId: msg.id, deviceId: request?.deviceId ?? deviceId, cancellable });
    if (!queued && readResponse && connection?.readyState === WebSocket.OPEN) queued = scheduler?.enqueueBusy(msg.id, JSON.stringify({ type: 'response', id: msg.id, ok: false, error: 'busy' }), { deviceId: request?.deviceId ?? deviceId });
    if (!queued && readResponse) return;
    if (!queued) {
      console.warn('connector send unavailable or control queue full');
      connection?.terminate();
    }
  }
  function connect() {
    if (stopped) return;
    ws = new WebSocket(target, { headers: { authorization: `Bearer ${secret}` }, handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
    const connection = ws;
    connection.on('open', () => trace('relay', 'open', {}));
    connection.on('error', error => trace('relay', 'error', { message: String(error?.message || error).slice(0, 120) }));
    const connectionScheduler = createWebSocketSendScheduler({ socket: connection, maxMessageBytes: 15 * 1024 * 1024, maxStreamMessageBytes: 8 * 1024 * 1024, maxControlBytes: 16 * 1024 * 1024, reservedControlBytes: 65536, reservedControls: 8, ...(schedulerLimitForTests ? { maxStreams: schedulerLimitForTests } : {}), onError: ({ code, key, error }) => {
      if ((code === 'message-too-large' || code === 'factory-failed') && key && streams.has(key)) {
        console.warn('stream-observation', JSON.stringify({ stage: 'projection', code, cause: error?.name || null }));
        const session = streams.get(key); streams.delete(key); clearImageTimer(key); void closeSession(session).catch(() => {});
        send({ type: 'stream-error', id: key, code: code === 'message-too-large' ? 'state-too-large' : 'state-invalid' }, connection, { deviceId: session.uploadDeviceId, cancellable: true });
      } else connection.terminate();
    } });
    scheduler = connectionScheduler;
    const deviceCleanups = new Map(), deviceTransitions = new Map(), deviceEpochs = new Map();
    const uploads = new Map(), staged = new Map(), revoked = new Set(), inflightUploads = new Map(), readRequests = new Map(), writeReplies = new Map(), pendingClaims = new Set(), sidebarStreams = new Map();
    let notificationMonitor;
    let currentUploadContext;
    const uploadsBusy = () => {
      if (!currentUploadContext) return uploads.size > 0 || staged.size > 0;
      for (const [id, scope] of uploads) if (typeof currentUploadContext.receiver.has === 'function' && !currentUploadContext.receiver.has(id, scope)) uploads.delete(id);
      for (const [id, scope] of staged) if (!currentUploadContext.store.resolve({ id, ...scope })) staged.delete(id);
      return uploads.size > 0 || staged.size > 0;
    };
    uploadChecks.add(uploadsBusy);
    const removeSidebarStream = id => { const stream = sidebarStreams.get(id); if (!stream) return; sidebarStreams.delete(id); clearTimeout(stream.timer); clearTimeout(stream.listTimer); sidebarStatus?.off('change', stream.notify); threadListChanges?.off('change', stream.listNotify); connectionScheduler.cancelStream(`sidebar:${id}`); connectionScheduler.cancelStream(`thread-list:${id}`); if (!sidebarStreams.size) threadListChanges?.stop(); };
    const addSidebarStream = (id, deviceId) => {
      const stream = { deviceId, timer: null, notify: null };
      stream.notify = () => {
        if (connection !== ws || sidebarStreams.get(id) !== stream || revoked.has(deviceId)) return;
        clearTimeout(stream.timer); stream.timer = null;
        if (!connectionScheduler.markStream(`sidebar:${id}`, () => sidebarStreams.get(id) === stream ? JSON.stringify({ type: 'event', id, event: 'sidebar-status', data: sidebarStatus.snapshot() }) : null)) {
          onSidebarRetryForTests?.();
          stream.timer = setTimeout(stream.notify, 50); stream.timer.unref?.();
        }
      };
      stream.listNotify = data => {
        if (connection !== ws || sidebarStreams.get(id) !== stream || revoked.has(deviceId)) return;
        clearTimeout(stream.listTimer); stream.listTimer = null;
        stream.listVersion = data?.version ?? stream.listVersion;
        if (!connectionScheduler.markStream(`thread-list:${id}`, () => sidebarStreams.get(id) === stream ? JSON.stringify({ type: 'event', id, event: 'thread-list-changed', data: { version: stream.listVersion } }) : null)) {
          stream.listTimer = setTimeout(() => stream.listNotify(), 50); stream.listTimer.unref?.();
        }
      };
      sidebarStreams.set(id, stream); sidebarStatus.on('change', stream.notify); stream.notify();
      threadListChanges?.on('change', stream.listNotify); threadListChanges?.start();
    };
    function beginClaims() {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      pendingClaims.add(pending);
      return () => { pendingClaims.delete(pending); finish(); };
    }
    function beginRead(msg) {
      const request = { id: msg.id, deviceId: msg.deviceId, cancelled: false };
      readRequests.set(msg.id, request);
      const cancelled = () => readRequests.get(msg.id) !== request || request.cancelled || revoked.has(request.deviceId);
      const answer = (ok, data, error) => {
        if (cancelled()) return;
        readRequests.delete(msg.id);
        send({ type: 'response', id: msg.id, ok, ...(ok ? { data } : error ? { error } : {}) }, connection, { request, cancellable: true });
      };
      answer.cancelled = cancelled;
      answer.request = request;
      return answer;
    }
    function beginWrite(msg) {
      const request = { id: msg.id, deviceId: msg.deviceId, cancelled: false };
      writeReplies.set(msg.id, request);
      const cancelled = () => writeReplies.get(msg.id) !== request || request.cancelled || revoked.has(request.deviceId) || connection !== ws || connection.readyState !== WebSocket.OPEN;
      const answer = status => {
        if (cancelled()) return;
        writeReplies.delete(msg.id);
        send({ type: 'response', id: msg.id, status }, connection, { request, cancellable: true });
      };
      answer.cancelled = cancelled;
      return answer;
    }
    let uploadContext;
    async function getUploads() {
      if (!imageUpload || !hostId) throw new Error('Uploads unavailable');
      if (!uploadContext) {
        const pending = (async () => {
        if (createUploadContext) return createUploadContext();
        await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
        const info = await lstat(uploadRoot);
        // Windows ignores POSIX create modes and reports synthetic permission
        // bits, so ownership and mode checks are only meaningful on POSIX.
        const insecurePosixMode = process.platform !== 'win32' && (info.mode & 0o077) !== 0;
        if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || insecurePosixMode) throw new Error('Invalid upload root');
        const store = await UploadStore.create({ root: uploadRoot });
        return { store, receiver: new ChunkUploads(store, { maxChunk: 512 * 1024, pipelineWindow: 2,
          helperPath: fileURLToPath(new URL('../../validate-image', import.meta.url)), ...(imageValidator ? { validator: imageValidator } : {}) }) };
        })();
        uploadContext = pending;
        void pending.then(context => { currentUploadContext = context; }).catch(() => {});
        void pending.catch(() => { if (uploadContext === pending) uploadContext = undefined; });
      }
      return uploadContext;
    }
    async function cleanupDevice(deviceId) {
      if (deviceId) revoked.add(deviceId);
      const ctx = await uploadContext?.catch(() => null);
      if (!ctx) return;
      for (const [id, scope] of uploads) if (!deviceId || scope.deviceId === deviceId) { uploads.delete(id); await ctx.receiver.cancel(id, scope).catch(() => {}); }
      for (const [id, scope] of staged) if (!deviceId || scope.deviceId === deviceId) { staged.delete(id); await ctx.store.remove({ id, ...scope }).catch(() => {}); }
    }
    let heartbeat;
    const armHeartbeat = () => { clearTimeout(heartbeat); heartbeat = setTimeout(() => { console.warn('relay heartbeat timeout'); connection.terminate(); }, heartbeatTimeoutMs); };
    connection.on('open', armHeartbeat);
    connection.on('ping', armHeartbeat);
    ws.on('error', () => {});
    ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return connection.close(1007); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return connection.close(1007);
      const mutation = mutationTypes.has(msg.type);
      if (mutation && shuttingDown) {
        if (msg.type !== 'cancel-upload') send(msg.type === 'upload' ? { type: 'response', id: msg.id, ok: false } : { type: 'response', id: msg.id, status: ['create-chat', 'prepare-chat', 'submit-chat'].includes(msg.type) ? 'not-dispatched' : 'unavailable' }, connection, { deviceId: msg.deviceId, cancellable: true });
        return;
      }
      if (mutation) activeMutations++;
      try {
      if (msg.type === 'flow-probe') { send({ type: 'capabilities', streamFlow: 2, taskNotifications: 1, desktopNotificationRead: 1, ...(imageUpload ? { uploadChunkBytes: 524288, uploadConcurrency: 2 } : {}) }, connection); return; }
      if (msg.type === 'notification-settings') {
        if (msg.enabled === true && !notificationMonitor && connection === ws && !shuttingDown) {
          notificationMonitor = (createNotificationMonitorForTests || (options => new TaskNotificationMonitor(options)))({ createSession, listThreads: listAuthorizedThreads,
            onEvent: event => { if (connection === ws && !shuttingDown) send({ type: 'task-notification', event }, connection); },
            onClear: event => { if (connection === ws && !shuttingDown) send({ type: 'task-notification-clear', event }, connection); },
            onHealth: health => { if (connection === ws) send({ type: 'notification-health', health }, connection); },
          }).start();
        } else if (msg.enabled !== true && notificationMonitor) { const old = notificationMonitor; notificationMonitor = null; await old.close(); }
        return;
      }
      if (msg.type === 'device-restored' && typeof msg.deviceId === 'string') {
        const epoch = (deviceEpochs.get(msg.deviceId) || 0) + 1; deviceEpochs.set(msg.deviceId, epoch);
        const transition = Promise.resolve(deviceCleanups.get(msg.deviceId)).then(() => { if (deviceEpochs.get(msg.deviceId) === epoch) revoked.delete(msg.deviceId); });
        deviceTransitions.set(msg.deviceId, transition); await transition;
        if (deviceTransitions.get(msg.deviceId) === transition) deviceTransitions.delete(msg.deviceId);
        return;
      }
      if (msg.type === 'device-revoked' && typeof msg.deviceId === 'string') { deviceEpochs.set(msg.deviceId, (deviceEpochs.get(msg.deviceId) || 0) + 1); revoked.add(msg.deviceId); for (const [id, stream] of sidebarStreams) if (stream.deviceId === msg.deviceId) removeSidebarStream(id); connectionScheduler.cancelDevice(msg.deviceId); for (const requests of [readRequests, writeReplies]) for (const [id, request] of requests) if (request.deviceId === msg.deviceId) { request.cancelled = true; request.chunkStop?.(); requests.delete(id); } for (const operation of inflightUploads.values()) if (operation.scope.deviceId === msg.deviceId) operation.cancelled = true; statusPriorities.remove(msg.deviceId); if (!statusPriorities.devices.size) void sidebarStatus?.close(); for (const [id, session] of streams) if (session.uploadDeviceId === msg.deviceId) { session.chunkStop?.(); connectionScheduler.cancelStream(id); clearImageTimer(id); streams.delete(id); void closeSession(session).catch(() => {}); } imagePreview?.revokeDevice(msg.deviceId); const cleanup = Promise.resolve(deviceCleanups.get(msg.deviceId)).then(() => cleanupDevice(msg.deviceId)).catch(() => {}); deviceCleanups.set(msg.deviceId, cleanup); await cleanup; if (deviceCleanups.get(msg.deviceId) === cleanup) deviceCleanups.delete(msg.deviceId); return; }
      const deviceEpoch = deviceEpochs.get(msg.deviceId);
      if (typeof msg.deviceId === 'string') await deviceTransitions.get(msg.deviceId);
      if (revoked.has(msg.deviceId) || deviceEpochs.get(msg.deviceId) !== deviceEpoch) return;
      if (connection !== ws || connection.readyState !== WebSocket.OPEN) return;
      if (msg.type === 'notification-read') {
        const id = msg.conversationId, monitor = notificationMonitor;
        const answer = beginWrite(msg);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.deviceId || '')
            || typeof msg.eventId !== 'string' || !msg.eventId || msg.eventId.length > 512
            || typeof monitor?.readOnDesktop !== 'function' || writes.has(id) || models?.isLocked(id) || recoveryLocked(id)) return answer('unavailable');
        writes.add(id);
        try {
          const data = await listAllThreads(listAuthorizedThreads);
          const allowed = new Set([...data.recent, ...data.projects.flatMap(project => project.threads)].map(thread => thread.id));
          const cancelled = () => answer.cancelled() || notificationMonitor !== monitor || shuttingDown || recoveryLocked(id) || Boolean(models?.isLocked(id));
          if (cancelled() || !allowed.has(id)) return answer('unavailable');
          const result = await monitor.readOnDesktop({ threadId: id, eventId: msg.eventId }, { isCancelled: cancelled });
          answer(result === true || result?.read === true ? 'accepted' : 'unavailable');
        } catch { answer('unavailable'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'recover-chat') {
        const recoveryStarted = performance.now();
        const request = { id: msg.id, deviceId: msg.deviceId, cancelled: false };
        writeReplies.set(msg.id, request);
        trace('recover', 'request', { thread: msg.conversationId, requestId: msg.requestId });
        const cancelled = () => request.cancelled || revoked.has(msg.deviceId) || connection !== ws || connection.readyState !== WebSocket.OPEN;
        const wakeSessions = () => {
          for (const session of streams.values()) {
            if (session.conversationId !== msg.conversationId || session.uploadDeviceId !== msg.deviceId) continue;
            try { session.recoveryAccepted?.(msg.requestId); } catch { /* Normal session retries remain available. */ }
          }
        };
        let locked = false, dispatched = false, registered = false;
        try {
          if (!ownerRouter || cancelled() || !/^[0-9a-f-]{36}$/i.test(msg.requestId || '')) throw new Error('unavailable');
          const attempt = ownerRouter.journal.beginRecoveryAttempt(hostId, msg.deviceId, msg.conversationId, msg.requestId);
          if (!attempt.inserted) {
            if (!cancelled()) {
              if (attempt.status === 'accepted') wakeSessions();
              send({ type: 'response', id: msg.id, status: attempt.status === 'accepted' ? 'accepted' : ['rejected', 'cancelled', 'released'].includes(attempt.status) ? 'unavailable' : 'unknown' }, connection, { request, cancellable: true });
            }
            return;
          }
          registered = true;
          const session = [...streams.values()].find(s => s.conversationId === msg.conversationId && s.uploadDeviceId === msg.deviceId);
          if (!session || writes.has(msg.conversationId)) throw new Error('unavailable');
          writes.add(msg.conversationId); locked = true;
          const permitted = await canRecoverHistory(msg.conversationId, phoneOptions());
          if (cancelled() || ![...streams.values()].includes(session) || permitted !== true) throw new Error('unavailable');
          trace('recover', 'authorized', { thread: msg.conversationId, elapsedMs: Math.round(performance.now() - recoveryStarted) });
          dispatched = true;
          await ownerRouter.route(msg.conversationId, { isCancelled: cancelled, deviceId: msg.deviceId, requestId: msg.requestId });
          trace('recover', 'accepted', { thread: msg.conversationId, elapsedMs: Math.round(performance.now() - recoveryStarted) });
          if (!ownerRouter.journal.finishRecoveryAttempt(hostId, msg.deviceId, msg.conversationId, msg.requestId, 'accepted') && ownerRouter.journal.recoveryAttempt(hostId, msg.deviceId, msg.conversationId, msg.requestId) !== 'accepted') throw new Error('recovery outcome unknown');
          if (!cancelled()) {
            wakeSessions();
            send({ type: 'response', id: msg.id, status: 'accepted' }, connection, { request, cancellable: true });
          }
        } catch (error) {
          trace('recover', 'failed', { thread: msg.conversationId, code: error?.code || null, message: String(error?.message || error).slice(0, 160), dispatched });
          let noRecoveryWrite = false;
          if (dispatched && ['owner-unknown', 'unavailable'].includes(error?.code)) {
            try { noRecoveryWrite = ownerRouter.isRecoveryLocked(msg.conversationId) === false; } catch {}
          }
          if (registered && (!dispatched || noRecoveryWrite)) {
            try {
              if (!ownerRouter.journal.finishRecoveryAttempt(hostId, msg.deviceId, msg.conversationId, msg.requestId, 'rejected') && ownerRouter.journal.recoveryAttempt(hostId, msg.deviceId, msg.conversationId, msg.requestId) !== 'rejected') throw new Error('unknown');
            } catch { noRecoveryWrite = false; dispatched = true; }
          }
          if (!cancelled()) send({ type: 'response', id: msg.id, status: !dispatched || noRecoveryWrite ? 'unavailable' : 'unknown' }, connection, { request, cancellable: true });
        } finally { if (locked) writes.delete(msg.conversationId); writeReplies.delete(msg.id); }
        return;
      }
      if (msg.type === 'cancel-unseen-recovery') {
        const answer = beginWrite(msg);
        try {
          if (answer.cancelled() || !ownerRouter || ownerRouter.isRecoveryLocked(msg.conversationId) !== false || ![...streams.values()].some(s => s.conversationId === msg.conversationId && s.uploadDeviceId === msg.deviceId)) return answer('unavailable');
          answer(ownerRouter.journal.cancelUnseenRecovery(hostId, msg.deviceId, msg.conversationId, msg.requestId) ? 'accepted' : 'unavailable');
        } catch { answer('unknown'); }
        return;
      }
      if (msg.type === 'prepare-chat' || msg.type === 'submit-chat') {
        const request = { id: msg.id, deviceId: msg.deviceId, cancelled: false }, claimed = [];
        let dispatched = false, finishClaims;
        writeReplies.set(msg.id, request);
        const cancelled = () => request.cancelled || revoked.has(msg.deviceId) || connection !== ws || connection.readyState !== WebSocket.OPEN;
        try {
          if (!ownerRouter || cancelled()) throw new Error('unavailable');
          let result;
          if (msg.type === 'prepare-chat') result = await ownerRouter.prepare({ ...msg, isCancelled: cancelled });
          else {
            const record = ownerRouter.journal.get(hostId, msg.deviceId, msg.requestId);
            if (!record || record.phase !== 'prepared' || !Array.isArray(msg.attachmentIds)) throw new Error('unavailable');
            const ctx = await getUploads(), scope = { hostId, deviceId: msg.deviceId, threadId: record.threadId };
            if (cancelled()) throw new Error('unavailable');
            finishClaims = beginClaims();
            for (const id of msg.attachmentIds) {
              const saved = staged.get(id);
              if (!saved || saved.creationId !== msg.requestId || saved.deviceId !== msg.deviceId || saved.threadId !== record.threadId) throw new Error('unavailable');
              const file = ctx.store.claim({ ...scope, id });
              if (!file) throw new Error('unavailable');
              claimed.push({ ctx, scope: { ...scope, id }, file }); staged.delete(id);
            }
            if (yieldAfterClaimsForTests) await yieldAfterClaimsForTests();
            const digest = await payloadDigest(msg.text, claimed.map(entry => entry.file), { model: msg.model ?? null, effort: msg.effort ?? null });
            if (cancelled()) throw new Error('unavailable');
            finishClaims(); finishClaims = undefined;
            result = await ownerRouter.submitPrepared({ ...msg, attachments: claimed.map(entry => entry.file), digest, isCancelled: cancelled, onDispatch: () => { dispatched = true; } });
          }
          if (!cancelled()) send({ type: 'response', id: msg.id, status: 'accepted', threadId: result.threadId }, connection, { request, cancellable: true });
        } catch (error) {
          if (!dispatched) for (const entry of claimed) await entry.ctx.store.discardRejected(entry.scope).catch(() => {});
          if (!cancelled()) send({ type: 'response', id: msg.id, status: error.code === 'start-unknown' ? 'start-unknown' : error.code === 'invalid-project' ? 'invalid-project' : 'outcome-unknown', ...(error.threadId ? { threadId: error.threadId } : {}) }, connection, { request, cancellable: true });
        } finally { finishClaims?.(); writeReplies.delete(msg.id); }
        return;
      }
      if (msg.type === 'creation-status') {
        const answer = beginRead(msg);
        try { if (!ownerRouter) throw new Error('unavailable'); answer(true, ownerRouter.creationStatus(msg.deviceId, msg.requestId)); } catch { answer(false); }
        return;
      }
      if (msg.type === 'create-chat') {
        const request = { id: msg.id, deviceId: msg.deviceId, cancelled: false };
        writeReplies.set(msg.id, request);
        const cancelled = () => request.cancelled || revoked.has(msg.deviceId) || connection !== ws || connection.readyState !== WebSocket.OPEN;
        try {
          if (!ownerRouter || cancelled()) throw new Error('unavailable');
          const result = await ownerRouter.create({ projectId: msg.projectId, text: msg.text, requestId: msg.requestId, deviceId: msg.deviceId, model: msg.model, effort: msg.effort, isCancelled: cancelled });
          if (!cancelled()) send({ type: 'response', id: msg.id, status: 'accepted', threadId: result.threadId }, connection, { request, cancellable: true });
        } catch (error) {
          if (!cancelled()) send({ type: 'response', id: msg.id, status: error.code === 'start-unknown' ? 'start-unknown' : error.code === 'invalid-project' ? 'invalid-project' : 'outcome-unknown', ...(error.threadId ? { threadId: error.threadId } : {}) }, connection, { request, cancellable: true });
        } finally { writeReplies.delete(msg.id); }
        return;
      }
      if (typeof msg.id !== 'string' || msg.id.length > 100) return;
      if (msg.type === 'cancel-reply') { const request = writeReplies.get(msg.id); if (request) { request.cancelled = true; writeReplies.delete(msg.id); } connectionScheduler.cancelRequest(msg.id); return; }
      if (msg.type === 'tool-output') {
        const answer = beginRead(msg);
        try {
          const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === msg.conversationId && s.uploadDeviceId === msg.deviceId && s.historyWindow === true && s.lazyOutput === true);
          if (!session || revoked.has(msg.deviceId)) return answer(false);
          const value = session.value, revision = session.revision, owner = session.conversation?.ownerId;
          const result = toolOutputPage(session.projectFull(value), msg);
          if (answer.cancelled() || revoked.has(msg.deviceId) || ![...streams.values()].includes(session) || session.status !== 'ready' || session.value !== value || session.revision !== revision || session.conversation?.ownerId !== owner) return answer(false);
          answer(true, result);
        } catch { answer(false); }
        return;
      }
      if (msg.type === 'history-page') {
        const answer = beginRead(msg);
        try {
          const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === msg.conversationId && s.uploadDeviceId === msg.deviceId && s.historyWindow === true);
          if (!session || revoked.has(msg.deviceId)) return answer(false);
          const value = session.value, revision = session.revision;
          const result = makePage(session.projectFull(value), { historicalHash: msg.historicalHash, before: msg.before, ...(msg.chunks === true ? { maxSingleTurnBytes: 31 * 1024 * 1024 } : {}) });
          if (revoked.has(msg.deviceId) || ![...streams.values()].includes(session) || session.status !== 'ready' || session.value !== value || session.revision !== revision) return answer(false);
          if (msg.validatePageHash) {
            if (result.pageHash !== msg.validatePageHash) return answer(false);
            return answer(true, { authorized: true, historicalHash: result.historicalHash, pageHash: result.pageHash, metadata: { threadId: result.threadId, before: result.before, keyField: result.keyField, nextBefore: result.nextBefore, complete: result.complete } });
          }
          if (msg.chunks !== true) return answer(true, result);
          const request = answer.request;
          let awaiting = null;
          const valid = () => !answer.cancelled() && !revoked.has(msg.deviceId) && session.status === 'ready' && [...streams.values()].includes(session) && connection === ws && connection.readyState === WebSocket.OPEN;
          const chunker = new BoundedSnapshotStream(frame => new Promise((resolve, reject) => {
            if (!valid()) return reject(new Error('history changed'));
            if (frame.type === 'end') {
              try {
                const current = makePage(session.projectFull(session.value), { historicalHash: msg.historicalHash, before: msg.before, maxSingleTurnBytes: 31 * 1024 * 1024 });
                if (current.pageHash !== result.pageHash || current.keyField !== result.keyField || current.nextBefore !== result.nextBefore || current.complete !== result.complete || JSON.stringify(current.turns) !== JSON.stringify(result.turns)) throw new Error('history changed');
              } catch { return reject(new Error('history changed')); }
            }
            const index = frame.type === 'chunk' ? frame.index : frame.type;
            const timer = setTimeout(() => { awaiting = null; reject(new Error('chunk ack timeout')); }, 30000);
            awaiting = { transferId: frame.transferId, generation: frame.generation, index, timer, resolve, reject };
            if (!connectionScheduler.enqueueControl(JSON.stringify({ type: 'history-chunk', id: msg.id, frame }), { reserved: false, requestId: msg.id, deviceId: msg.deviceId, cancellable: true })) { clearTimeout(timer); awaiting = null; reject(new Error('chunk send unavailable')); }
          }));
          request.chunkAck = ack => { if (!awaiting || ack.transferId !== awaiting.transferId || ack.generation !== awaiting.generation || ack.index !== awaiting.index) return; const current = awaiting; awaiting = null; clearTimeout(current.timer); current.resolve(); };
          request.chunkStop = () => { chunker.close(); if (awaiting) { const current = awaiting; awaiting = null; clearTimeout(current.timer); current.reject(new Error('cancelled')); } };
          try { await chunker.send(result, 1); if (readRequests.get(msg.id) === request) readRequests.delete(msg.id); }
          catch { if (!answer.cancelled()) answer(false); }
          finally { request.chunkStop(); }
          return;
        } catch { return answer(false); }
      }
      if (msg.type === 'recorded-history') {
        const answer = beginRead(msg), request = answer.request;
        try {
          const page = readRecordedHistory(msg.conversationId, msg.deviceId, msg.cursor || null);
          if (!page || answer.cancelled()) return answer(false);
          let awaiting = null;
          const valid = () => !answer.cancelled() && !revoked.has(msg.deviceId) && connection === ws && connection.readyState === WebSocket.OPEN;
          const chunker = new BoundedSnapshotStream(frame => new Promise((resolve, reject) => {
            if (!valid()) return reject(new Error('cancelled'));
            const index = frame.type === 'chunk' ? frame.index : frame.type;
            const timer = setTimeout(() => { awaiting = null; reject(new Error('chunk ack timeout')); }, 30000);
            awaiting = { transferId: frame.transferId, generation: frame.generation, index, timer, resolve, reject };
            if (!connectionScheduler.enqueueControl(JSON.stringify({ type: 'history-chunk', id: msg.id, frame }), { reserved: false, requestId: msg.id, deviceId: msg.deviceId, cancellable: true })) { clearTimeout(timer); awaiting = null; reject(new Error('chunk send unavailable')); }
          }), { maxBytes: 4 * 1024 * 1024 });
          request.chunkAck = ack => { if (!awaiting || ack.transferId !== awaiting.transferId || ack.generation !== awaiting.generation || ack.index !== awaiting.index) return; const current = awaiting; awaiting = null; clearTimeout(current.timer); current.resolve(); };
          request.chunkStop = () => { chunker.close(); if (awaiting) { const current = awaiting; awaiting = null; clearTimeout(current.timer); current.reject(new Error('cancelled')); } };
          try { await chunker.send(page, 1); if (readRequests.get(msg.id) === request) readRequests.delete(msg.id); }
          catch { if (!answer.cancelled()) answer(false); }
          finally { request.chunkStop(); }
        } catch (error) { if (!answer.cancelled()) answer(false, undefined, ['invalid-cursor', 'history-changed'].includes(error?.code) ? 'history-changed' : error?.code === 'item-too-large' ? 'history-item-too-large' : undefined); }
        return;
      }
      if (msg.type === 'flow') {
        const session = streams.get(msg.id);
        if (Number.isSafeInteger(msg.generation) && msg.generation > 0) session?.handleFlow?.(msg.action, msg.generation, msg.afterReset === true);
        return;
      }
      if (msg.type === 'agent-history') {
        const answer = beginRead(msg);
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === msg.conversationId && s.uploadDeviceId === msg.deviceId);
        if (!session || revoked.has(msg.deviceId) || typeof msg.agentThreadId !== 'string') return answer(false);
        const referenced = () => {
          const state = session.value;
          const turns = [...(Array.isArray(state?.turns) ? state.turns : []), ...Object.values(state?.turnHistory?.history?.entitiesByKey || {})];
          return turns.some(turn => Array.isArray(turn?.items) && turn.items.some(item => item?.type === 'subAgentActivity' && item.agentThreadId === msg.agentThreadId));
        };
        if (!referenced()) return answer(false);
        try {
          const history = await readAuthorizedHistory(msg.agentThreadId, { parentThreadId: msg.conversationId });
          if (!history || history.id !== msg.agentThreadId || session.status !== 'ready' || !referenced() || ![...streams.values()].includes(session) || revoked.has(msg.deviceId)) throw new Error('unavailable');
          return answer(true, history);
        } catch { return answer(false); }
      }
      if (msg.type === 'file-preview') {
        const answer = beginRead(msg);
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === msg.conversationId && s.uploadDeviceId === msg.deviceId);
        if (!session || revoked.has(msg.deviceId)) return answer(false);
        const owner = session.conversation?.ownerId;
        try {
          const result = await (typeof msg.path === 'string' ? readLinkedFile : readChangedFile)({ state: session.value, threadId: msg.conversationId, turnId: msg.turnId, itemId: msg.itemId, index: msg.index, path: msg.path,
            roots: [homedir(), tmpdir(), '/private/tmp'], helperPath: filePreviewHelper || fileURLToPath(new URL('../../safe-media-open', import.meta.url)) });
          if (!result || !await verifyPreviewIdentity(result)) return answer(false);
          const reference = (typeof msg.path === 'string' ? linkedFileReference : changedFileReference)({ state: session.value, threadId: msg.conversationId, turnId: msg.turnId, itemId: msg.itemId, index: msg.index, path: msg.path });
          const matches = typeof msg.path === 'string' ? linkedPreviewMatches(reference, result.previewIdentity.path) : reference === result.previewIdentity.path;
          if (!matches || session.status !== 'ready' || session.conversation?.ownerId !== owner || revoked.has(msg.deviceId) || answer.cancelled() || ![...streams.values()].includes(session)) return answer(false);
          return answer(true, result);
        } catch { return answer(false); }
      }
      if (msg.type === 'image-chunk') {
        const answer = beginRead(msg);
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === msg.conversationId && s.uploadDeviceId === msg.deviceId);
        if (!imagePreview || !session || revoked.has(msg.deviceId)) return answer(false);
        try {
          const revision = session.revision, owner = session.conversation?.ownerId;
          const result = await imagePreview.readChunk({ id: msg.handle, state: session.value, hostId, deviceId: msg.deviceId, threadId: msg.conversationId, offset: msg.offset });
          if (!result || (typeof imagePreview.validateHandle === 'function' ? !await imagePreview.validateHandle({ id: msg.handle, getState: () => session.value, hostId, deviceId: msg.deviceId, threadId: msg.conversationId }) : session.revision !== revision) || session.status !== 'ready' || session.conversation?.ownerId !== owner || revoked.has(msg.deviceId) || answer.cancelled() || ![...streams.values()].includes(session)) return answer(false);
          return answer(true, { mime: result.mime, size: result.size, offset: result.offset, data: result.bytes.toString('base64') });
        } catch { return answer(false); }
      }
      if (msg.type === 'cancel-upload') {
        connectionScheduler.cancelRequest(msg.id);
        const operation = inflightUploads.get(msg.id);
        if (operation) {
          operation.cancelled = true;
          clearTimeout(operation.timer);
          if (operation.uploadId) {
            const ctx = await uploadContext?.catch(() => null);
            await ctx?.receiver.cancel(operation.uploadId, operation.scope).catch(() => {});
            uploads.delete(operation.uploadId);
          }
          if (operation.attachmentId) {
            const ctx = await uploadContext?.catch(() => null);
            await ctx?.store.remove({ id: operation.attachmentId, ...operation.scope }).catch(() => {});
            staged.delete(operation.attachmentId);
          }
          inflightUploads.delete(msg.id);
        }
        return;
      }
      if (msg.type === 'upload') {
        let operation;
        const answer = (ok, data) => { if (!operation?.cancelled && !revoked.has(msg.deviceId)) send({ type: 'response', id: msg.id, ok, data }, connection, { critical: true, deviceId: msg.deviceId, cancellable: true }); };
        const scope = { hostId, deviceId: msg.deviceId, threadId: msg.conversationId };
        if (![scope.hostId, scope.deviceId, scope.threadId].every(v => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) || revoked.has(scope.deviceId)) return answer(false);
        if (msg.creationId) {
          const record = ownerRouter?.journal?.get(hostId, msg.deviceId, msg.creationId);
          if (!record || record.phase !== 'prepared' || record.threadId !== scope.threadId) return answer(false);
          scope.creationId = msg.creationId;
        }
        if (msg.action !== 'start') {
          const saved = uploads.get(msg.uploadId) || staged.get(msg.uploadId);
          if (!saved || saved.creationId !== scope.creationId) return answer(false);
        }
        operation = { scope, uploadId: msg.uploadId, cancelled: false };
        inflightUploads.set(msg.id, operation);
        try {
          const ctx = await getUploads();
          for (const [id, savedScope] of staged) if (!ctx.store.resolve({ id, ...savedScope })) staged.delete(id);
          if (operation.cancelled || connection !== ws || connection.readyState !== WebSocket.OPEN || revoked.has(scope.deviceId)) return;
          if (msg.action === 'start') { const uploadId = ctx.receiver.start({ ...scope, name: msg.name, size: msg.size, kind: msg.kind ?? 'image' }); operation.uploadId = uploadId; operation.retain = true; uploads.set(uploadId, scope); return answer(true, { uploadId }); }
          if (msg.action === 'chunk') { if (typeof msg.data !== 'string' || msg.data.length > 699052 || !/^[A-Za-z0-9+/]*={0,2}$/.test(msg.data)) throw new Error('Invalid chunk'); await ctx.receiver.chunk(msg.uploadId, scope, msg.seq, Buffer.from(msg.data, 'base64')); if (operation.cancelled) { uploads.delete(msg.uploadId); await ctx.receiver.cancel(msg.uploadId, scope).catch(() => {}); return; } return answer(true, { ok: true }); }
          if (msg.action === 'finish') { const result = await ctx.receiver.finish(msg.uploadId, scope); uploads.delete(msg.uploadId); if (operation.cancelled || revoked.has(scope.deviceId) || connection !== ws || connection.readyState !== WebSocket.OPEN) { await ctx.store.remove({ id: result.id, ...scope }); return; } operation.attachmentId = result.id; operation.retain = true; staged.set(result.id, scope); return answer(true, { attachmentId: result.id }); }
          if (msg.action === 'delete') { if (uploads.has(msg.uploadId)) { await ctx.receiver.cancel(msg.uploadId, scope); uploads.delete(msg.uploadId); return answer(true, { ok: true }); } const removed = await ctx.store.remove({ id: msg.uploadId, ...scope }); if (removed) staged.delete(msg.uploadId); return answer(removed, { ok: removed }); }
        } catch { if (!operation.cancelled) return answer(false); }
        finally { if (operation.retain && !operation.cancelled) { operation.timer = setTimeout(() => inflightUploads.delete(msg.id), 30000); operation.timer.unref(); } else inflightUploads.delete(msg.id); }
        return answer(false);
      }
      if (msg.type === 'state-chunk-ack') { streams.get(msg.id)?.chunkAck?.(msg); return; }
      if (msg.type === 'history-chunk-ack') { readRequests.get(msg.id)?.chunkAck?.(msg); return; }
      if (msg.type === 'chunk-reset-ready') { streams.get(msg.id)?.chunkResetReady?.(msg); return; }
      if (msg.type === 'cancel') { removeSidebarStream(msg.id); const request = readRequests.get(msg.id); if (request) { request.cancelled = true; request.chunkStop?.(); readRequests.delete(msg.id); } connectionScheduler.cancelRequest(msg.id); connectionScheduler.cancelStream(msg.id); clearImageTimer(msg.id); const session = streams.get(msg.id); session?.chunkStop?.(); streams.delete(msg.id); if (session) await closeSession(session); return; }
      if (msg.type === 'model-cancel') {
        const answer = beginWrite(msg), id = msg.conversationId;
        if (!models || !modelJournal || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || typeof msg.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(msg.operationId) || revoked.has(msg.deviceId) || ![...streams.values()].some(s => s.conversationId === id && s.uploadDeviceId === msg.deviceId)) return answer('unavailable');
        try { return answer(models.cancelPrepared(id, msg.operationId) ? 'accepted' : 'unavailable'); } catch { return answer('unavailable'); }
      }
      if (msg.type === 'model') {
        const answer = beginWrite(msg), id = msg.conversationId;
        if (!models || !modelJournal || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || recoveryLocked(id)) return answer('unavailable');
        const result = await models.change({ deviceId: msg.deviceId, threadId: id, model: msg.model, effort: msg.effort ?? null });
        answer(result.status === 'accepted' || result.status === 'confirmed' ? 'accepted' : result.status === 'unknown' ? 'unknown' : 'unavailable');
        return;
      }
      if (msg.type === 'mode') {
        const id = msg.conversationId;
        const answer = beginWrite(msg);
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !['default', 'plan'].includes(msg.mode)) return answer('unavailable');
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === msg.deviceId);
        const ownerId = session?.conversation?.ownerId, revision = session?.revision;
        if (!session || typeof ownerId !== 'string' || !Number.isSafeInteger(revision) || writes.has(id) || models?.isLocked(id) || recoveryLocked(id)) return answer('unavailable');
        const previous = modeRevisions.get(id);
        if ((previous && previous.ownerId === ownerId &&
            ((previous.session.deref() === session && previous.revision >= revision) || session.value?.latestCollaborationMode?.mode !== previous.target)) ||
            (!previous && modeRevisions.size >= 1024)) return answer('unavailable');
        modeRevisions.set(id, { ownerId, revision, session: new WeakRef(session), target: msg.mode });
        writes.add(id);
        try { const result = await session.setCollaborationMode(msg.mode); if (result?.applied === true) answer('accepted'); else { modeRevisions.delete(id); answer('unavailable'); } }
        catch (error) { if (['unavailable', 'unsupported-state'].includes(error?.code)) { modeRevisions.delete(id); answer('unavailable'); } else answer('unknown'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'thread-action') {
        const id = msg.conversationId, action = msg.action;
        const answer = beginWrite(msg);
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !['archive', 'delete'].includes(action)) return answer('unavailable');
        const owner = ownerRouter?.localOwner;
        if (typeof owner?.threadAction !== 'function' || writes.has(id) || models?.isLocked(id)) return answer('unavailable');
        writes.add(id);
        try {
          const data = await listAllThreads(listAuthorizedThreads);
          const allowed = new Set([...data.recent, ...data.projects.flatMap(project => project.threads)].map(thread => thread.id));
          if (answer.cancelled() || !allowed.has(id) || recoveryLocked(id) || models?.isLocked(id) || ownerRouter.journal?.threadWritePending?.(hostId, id) !== false) return answer('unavailable');
          if (action === 'archive') {
            const archive = createThreadArchive({ localOwner: owner, discover: threadId => ownerRouter.discover(threadId),
              isAuthorized: threadId => !answer.cancelled() && allowed.has(threadId),
              isLocked: threadId => recoveryLocked(threadId) || Boolean(models?.isLocked(threadId)) || ownerRouter.journal?.threadWritePending?.(hostId, threadId) !== false,
            });
            await archive.archive(id);
          } else await owner.threadAction(id, action);
          answer('accepted');
        } catch (error) { answer(error?.code === 'not-supported-desktop-owner' ? error.code : ['unavailable', 'unsupported-state'].includes(error?.code) ? 'unavailable' : 'unknown'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'stop') {
        const id = msg.conversationId;
        const answer = beginWrite(msg);
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || typeof msg.turnId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.turnId)) return answer('unavailable');
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === msg.deviceId);
        if (!session || writes.has(id)) return answer('unavailable');
        writes.add(id);
        try { const result = await session.stopTurn(msg.turnId); answer(typeof result?.goalPauseError === 'string' && result.goalPauseError ? 'stopped-goal-pause-failed' : 'accepted'); }
        catch (error) { answer(['unavailable', 'unsupported-state'].includes(error?.code) ? 'unavailable' : 'unknown'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'user-input') {
        const id = msg.conversationId;
        const answer = beginWrite(msg);
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !['string', 'number'].includes(typeof msg.requestId)) return answer('unavailable');
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === msg.deviceId);
        if (!session || writes.has(id)) return answer('unavailable');
        const requestKey = JSON.stringify([id, session.conversation?.ownerId, msg.requestId]);
        if (answeredRequests.has(requestKey) || answeredRequests.size >= 4096) return answer('unavailable');
        answeredRequests.add(requestKey);
        writes.add(id);
        try { if (msg.asyncQuestion === true) await session.replyAsyncQuestions(msg.requestId, msg.answers); else await session.replyUserInput(msg.requestId, msg.answers); answer('accepted'); }
        catch (error) { if (['unavailable', 'unsupported-state'].includes(error?.code)) { answeredRequests.delete(requestKey); answer('unavailable'); } else answer('unknown'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'approve') {
        const id = msg.conversationId;
        const answer = beginWrite(msg);
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !['command', 'file'].includes(msg.kind) || !['accept', 'decline', 'cancel'].includes(msg.decision) || !['string', 'number'].includes(typeof msg.requestId)) return answer('unavailable');
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === msg.deviceId);
        if (!session || writes.has(id)) return answer('unavailable');
        writes.add(id);
        try { await session.replyApproval(msg.requestId, msg.kind, msg.decision); answer('accepted'); }
        catch (error) { answer(['unavailable', 'unsupported-state'].includes(error?.code) ? 'unavailable' : 'unknown'); }
        finally { writes.delete(id); }
        return;
      }
      if (msg.type === 'write') {
        const id = msg.conversationId;
        const answer = beginWrite(msg);
        const rejectWrite = reason => { trace('write', 'rejected', { ...(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? { thread: id } : {}), reason }); return answer('unavailable'); };
        const attachmentIds = msg.attachmentIds ?? (msg.attachmentId ? [msg.attachmentId] : []);
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || typeof msg.text !== 'string' || !Array.isArray(attachmentIds) || attachmentIds.length > 4 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(value => typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) || (!msg.text.trim() && !attachmentIds.length) || Buffer.byteLength(msg.text) > 32768) return rejectWrite('invalid');
        const session = [...streams.values()].find(s => s.status === 'ready' && s.value?.id === id && s.uploadDeviceId === msg.deviceId);
        const ownerId = session?.conversation?.ownerId, revision = session?.revision;
        if (!session) return rejectWrite('session-unavailable');
        if (typeof ownerId !== 'string' || !Number.isSafeInteger(revision)) return rejectWrite('invalid-session');
        if (writes.has(id)) return rejectWrite('write-pending');
        if (models?.isLocked(id)) return rejectWrite('model-locked');
        if (recoveryLocked(id)) return rejectWrite('recovery-locked');
        const previous = sentRevisions.get(id);
        if (previous && previous.ownerId === ownerId && previous.revision >= revision) return rejectWrite('revision-guard');
        if (!previous && sentRevisions.size >= 1024) return rejectWrite('guard-capacity');
        writes.add(id); sentRevisions.set(id, { ownerId, revision });
        const claimed = []; let submitted = false, finishClaims;
        try {
          if (attachmentIds.length) {
            const ctx = await getUploads();
            const scope = { hostId, deviceId: msg.deviceId, threadId: id };
            if (answer.cancelled()) { sentRevisions.delete(id); return; }
            finishClaims = beginClaims();
            const files = [];
            for (const attachmentId of attachmentIds) {
              const claimScope = { id: attachmentId, ...scope };
              const file = ctx.store.claim(claimScope);
              if (!file) throw Object.assign(new Error('Attachment unavailable'), { code: 'unavailable' });
              claimed.push({ store: ctx.store, scope: claimScope });
              staged.delete(attachmentId); files.push(file);
            }
            if (yieldAfterClaimsForTests) await yieldAfterClaimsForTests();
            else await new Promise(resolve => setTimeout(resolve, 0));
            if (answer.cancelled()) {
              for (const item of claimed) await item.store.discardRejected(item.scope).catch(() => {});
              sentRevisions.delete(id); return;
            }
            submitted = true; finishClaims(); finishClaims = undefined; await session.sendAttachments(msg.text, files);
          } else { submitted = true; await session.sendText(msg.text); }
          answer('accepted');
        }
        catch (error) { if (!submitted || ['unavailable', 'unsupported-state'].includes(error?.code)) { for (const item of claimed) await item.store.discardRejected(item.scope).catch(() => {}); sentRevisions.delete(id); rejectWrite(submitted ? 'session-rejected' : 'pre-dispatch'); } else answer('unknown'); }
        finally { finishClaims?.(); writes.delete(id); }
        return;
      }
      if (msg.type !== 'request') return;
      if (msg.path === '/api/models') {
        const answer = beginRead(msg);
        try {
          if (!models) { trace('models', 'unavailable', { reason: 'no-service' }); return answer(false); }
          const list = await models.list();
          trace('models', 'listed', { count: list.length });
          answer(true, { models: list });
        } catch (error) {
          trace('models', 'failed', { code: error?.code || null, message: String(error?.message || error).slice(0, 160) });
          answer(false);
        }
        return;
      }
      const modelStatus = /^\/api\/threads\/([0-9a-f-]{36})\/model-status$/i.exec(msg.path || '');
      if (modelStatus) {
        const answer = beginRead(msg);
        try {
          if (!models || revoked.has(msg.deviceId) || ![...streams.values()].some(s => s.conversationId === modelStatus[1] && s.uploadDeviceId === msg.deviceId)) return answer(false);
          const preparedOperationId = models.prepared(modelStatus[1]);
          answer(true, { locked: models.isLocked(modelStatus[1]), ...(preparedOperationId ? { preparedOperationId } : {}) });
        } catch { answer(false); }
        return;
      }
      const recoveryAttempt = /^\/api\/threads\/([0-9a-f-]{36})\/recovery-attempt\/([0-9a-f-]{36})$/i.exec(msg.path || '');
      if (recoveryAttempt) {
        const answer = beginRead(msg);
        try {
          if (!ownerRouter || revoked.has(msg.deviceId) || ![...streams.values()].some(s => s.conversationId === recoveryAttempt[1] && s.uploadDeviceId === msg.deviceId)) return answer(false);
          answer(true, { status: ownerRouter.journal.recoveryAttempt(hostId, msg.deviceId, recoveryAttempt[1], recoveryAttempt[2]), locked: ownerRouter.isRecoveryLocked(recoveryAttempt[1]), executionTracked: ownerRouter.journal.recoveryAttemptExecutionTracked(hostId, msg.deviceId, recoveryAttempt[1], recoveryAttempt[2]) });
        } catch { answer(false); }
        return;
      }
      const recoveryStatus = /^\/api\/threads\/([0-9a-f-]{36})\/recovery-status$/i.exec(msg.path || '');
      if (recoveryStatus) {
        const answer = beginRead(msg);
        try {
          if (revoked.has(msg.deviceId) || ![...streams.values()].some(s => s.conversationId === recoveryStatus[1] && s.uploadDeviceId === msg.deviceId)) return answer(false);
          answer(true, { locked: recoveryLocked(recoveryStatus[1]) });
        } catch { answer(false); }
        return;
      }
      if (msg.path === '/api/sidebar/events') {
        if (!sidebarStatus || revoked.has(msg.deviceId) || sidebarStreams.has(msg.id) || sidebarStreams.size >= 32) return send({ type: 'end', id: msg.id }, connection);
        addSidebarStream(msg.id, msg.deviceId); return;
      }
      if (msg.path === '/api/threads') { const answer = beginRead(msg); try {
        const { statusCandidates, ...data } = await listAllThreads(listAuthorizedThreads);
        if (answer.cancelled()) return;
        if (sidebarStatus) {
          await populateThreadStatuses({ sidebarStatus, statusPriorities, deviceId: msg.deviceId, visibleThreads: msg.visibleThreads, handoverThread: msg.handoverThread, data, statusCandidates, streams });
        }
        answer(true, data);
      } catch { answer(false); } return; }
      const m = /^\/api\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events$/i.exec(msg.path || '');
      if (!m || streams.has(msg.id) || streams.size >= 16) return send({ type: 'end', id: msg.id }, connection);
      // Version 3 clients understand keyed history windows; never stream their
      // entire loaded desktop history when a request omits the optional flag.
      const historyWindow = msg.historyWindow === true || msg.viewDelta === 3;
      const session = createSession({ conversationId: m[1], hostId: 'local' }); session.uploadDeviceId = msg.deviceId; session.historyWindow = historyWindow; session.lazyOutput = msg.lazyOutput === true && historyWindow; streams.set(msg.id, session);
      const connectionDiagnostic = session.connectionDiagnostic = createStreamDiagnostics(msg.id, entry => trace('stream', 'timing', entry));
      connectionDiagnostic.mark('open');
      if (sidebarStatus && msg.sidebarStatus === true && !revoked.has(msg.deviceId)) addSidebarStream(msg.id, msg.deviceId);
      let historyGeneration = 0, historyLoading = null, pendingHistory = null, previousView = null, viewSeq = 0, lastIssued = [], flowGeneration = 0, flowPaused = false, changedSinceReset = true, skipReset = false;
      let latest = null, lastHistory = null, pendingStatus = false, pendingReset = null, pendingPreview = msg.stagedPreview === true;
      let sendingChunks = false, chunkDirty = false, awaitingAck = null, awaitingReset = null, chunkEpoch = 0;
      const chunker = new BoundedSnapshotStream(frame => new Promise((resolve, reject) => {
        const index = frame.type === 'chunk' ? frame.index : frame.type;
        const timer = setTimeout(() => { if (awaitingAck?.timer === timer) awaitingAck = null; reject(new Error('chunk ack timeout')); }, 30000);
        awaitingAck = { transferId: frame.transferId, generation: frame.generation, index, resolve, reject, timer };
        if (!connectionScheduler.enqueueControl(JSON.stringify({ type: 'state-chunk', id: msg.id, frame }), { reserved: false, requestId: msg.id, deviceId: msg.deviceId, cancellable: true })) { clearTimeout(timer); awaitingAck = null; reject(new Error('chunk send unavailable')); }
      }));
      session.chunkAck = ack => { if (!awaitingAck || ack.transferId !== awaitingAck.transferId || ack.generation !== awaitingAck.generation || ack.index !== awaitingAck.index) return; const current = awaitingAck; awaitingAck = null; clearTimeout(current.timer); current.resolve(); };
      session.chunkResetReady = ack => { if (awaitingReset !== ack.generation) return; awaitingReset = null; schedule(); };
      session.chunkStop = () => { chunker.close(); if (awaitingAck) { clearTimeout(awaitingAck.timer); awaitingAck.reject(new Error('cancelled')); awaitingAck = null; } };
      session.projectFull = (value, issued = lastIssued) => desktopView(value, {
        imageHandles: new Map(issued.filter(item => !item.mime || !item.mime.startsWith('video/')).map(item => [item.path, item.id])),
        mediaHandles: new Map(issued.filter(item => item.mime?.startsWith('video/')).map(item => [item.path, { id: item.id, mime: item.mime }])),
      });
      const project = (value, issued = lastIssued) => {
        const view = session.projectFull(value, issued);
        if (!historyWindow) return view;
        try { const window = makeWindow(view); return session.lazyOutput ? lazyToolOutputs(window, view) : window; }
        catch (error) { if (error.message !== 'unstable turn keys') throw error; return view; }
      };
      // Any oversized state must go through the chunked transfer, not the 8 MiB
      // single-frame cap. The relay and the phone H5 already understand state-chunk.
      const sendChunkedState = (seq, conversation) => {
        connectionDiagnostic.mark('first-encoded', { chunked: true });
        const diagnosticTransfer = connectionDiagnostic.mark('chunk-begin');
        const epoch = ++chunkEpoch; sendingChunks = true;
        void chunker.send({ event: 'state', data: { seq, revision: latest.revision, conversation } }, seq).then(() => {
          if (epoch !== chunkEpoch || streams.get(msg.id) !== session || connection !== ws) return;
          previousView = msg.viewDelta ? { seq, conversation } : null; sendingChunks = false;
          if (diagnosticTransfer) connectionDiagnostic.mark('chunk-end');
          if (chunkDirty) { chunkDirty = false; schedule(); }
        }).catch(error => {
          if (epoch !== chunkEpoch) return; sendingChunks = false;
          if (streams.get(msg.id) === session) {
            const code = error instanceof RangeError && error.message === 'state too large' ? 'state-too-large' : 'state-invalid';
            console.warn('stream-observation', JSON.stringify({ stage: 'chunk-transfer', code, cause: error?.name || null }));
            streams.delete(msg.id); void closeSession(session);
            send({ type: 'stream-error', id: msg.id, code }, connection, { deviceId: msg.deviceId, cancellable: true });
          }
        });
        return null;
      };
      const schedule = () => {
        if (connection !== ws || streams.get(msg.id) !== session || (flowPaused && pendingReset === null)) return;
        if (awaitingReset !== null) return;
        if (sendingChunks) { chunkDirty = true; return; }
        if (!connectionScheduler.markStream(msg.id, () => {
          if (streams.get(msg.id) !== session || connection !== ws || revoked.has(msg.deviceId)) return null;
          if (pendingReset !== null) {
            pendingPreview = false;
            const generation = pendingReset; pendingReset = null;
            let event = 'status', data = { status: 'unavailable' }, projectMs;
            if (skipReset && !changedSinceReset && !pendingHistory) { event = 'unchanged'; data = undefined; }
            else if (latest?.status === 'ready') {
              const projectionStarted = connectionDiagnostic.pending('first-encoded') ? performance.now() : null;
              const conversation = project(latest.value);
              projectMs = projectionStarted === null ? undefined : performance.now() - projectionStarted;
              const resetSize = Buffer.byteLength(JSON.stringify(conversation));
              if (historyWindow && resetSize > 8 * 1024 * 1024) {
                previousView = null; changedSinceReset = false; flowPaused = false; pendingStatus = false; awaitingReset = generation;
                return JSON.stringify({ type: 'flow-reset', id: msg.id, generation, event: 'status', data: { status: 'unavailable' }, chunkReset: true });
              }
              event = 'state'; data = msg.viewDelta ? { seq: ++viewSeq, revision: latest.revision, conversation } : { revision: latest.revision, conversation };
              previousView = msg.viewDelta ? { seq: viewSeq, conversation } : null;
            } else { previousView = null; if (event !== 'unchanged') pendingHistory = lastHistory; }
            changedSinceReset = false; flowPaused = false; pendingStatus = false;
            if (pendingHistory && latest?.status !== 'ready') schedule();
            const encodingStarted = connectionDiagnostic.pending('first-encoded') ? performance.now() : null;
            const encoded = JSON.stringify({ type: 'flow-reset', id: msg.id, generation, event, ...(data ? { data } : {}) });
            if (event === 'state' && encodingStarted !== null) connectionDiagnostic.mark('first-encoded', { projectMs, encodeMs: performance.now() - encodingStarted, bytes: Buffer.byteLength(encoded), chunked: false });
            return encoded;
          }
          if (flowPaused) return null;
          if (latest?.status !== 'ready') {
            previousView = null;
            if (pendingStatus) { pendingStatus = false; if (pendingHistory) schedule(); return JSON.stringify({ type: 'event', id: msg.id, event: 'status', data: { status: 'unavailable' } }); }
            if (pendingHistory) { const conversation = pendingHistory; pendingHistory = null; changedSinceReset = true; return JSON.stringify({ type: 'event', id: msg.id, event: 'history', data: { conversation } }); }
            return null;
          }
          const projectionStarted = connectionDiagnostic.pending('first-encoded') ? performance.now() : null;
          const conversation = project(latest.value);
          const projectMs = projectionStarted === null ? undefined : performance.now() - projectionStarted;
          if (conversation.id !== m[1]) throw new Error('mismatch');
          if (pendingPreview) {
            pendingPreview = false;
            const preview = { ...conversation, turns: conversation.turns.slice(-3), history: { complete: false, reason: 'loading-live' } };
            const result = JSON.stringify({ type: 'event', id: msg.id, event: 'preview', data: { conversation: preview } });
            if (Buffer.byteLength(result) <= 512 * 1024) { schedule(); return result; }
          }
          if (!msg.viewDelta) {
            const encodingStarted = connectionDiagnostic.pending('first-encoded') ? performance.now() : null;
            const full = JSON.stringify({ type: 'event', id: msg.id, event: 'state', data: { revision: latest.revision, conversation } });
            const bytes = Buffer.byteLength(full);
            if (encodingStarted !== null) connectionDiagnostic.mark('first-encoded', { projectMs, encodeMs: performance.now() - encodingStarted, bytes, chunked: bytes > 8 * 1024 * 1024 });
            if (bytes > 8 * 1024 * 1024) return sendChunkedState(++viewSeq, conversation);
            return full;
          }
          const update = viewUpdate(previousView, conversation, ++viewSeq, msg.viewDelta === 3 ? 3 : msg.viewDelta === 2 ? 2 : 1);
          const encodingStarted = connectionDiagnostic.pending('first-encoded') ? performance.now() : null;
          const encoded = JSON.stringify({ type: 'event', id: msg.id, event: update.event, data: { ...update.data, revision: latest.revision } });
          const bytes = Buffer.byteLength(encoded);
          if (encodingStarted !== null) connectionDiagnostic.mark('first-encoded', { projectMs, encodeMs: performance.now() - encodingStarted, bytes, chunked: bytes > 8 * 1024 * 1024 });
          if (bytes > 8 * 1024 * 1024) return sendChunkedState(viewSeq, conversation);
          previousView = { seq: viewSeq, conversation };
          return encoded;
        })) connection.terminate();
      };
      session.handleFlow = (action, generation, afterReset) => {
        if (action === 'pause' && generation > flowGeneration) {
          connectionScheduler.cancelStream(msg.id); connectionScheduler.cancelRequest(msg.id);
          flowGeneration = generation; flowPaused = true; pendingReset = null; skipReset = afterReset;
          if (sendingChunks) {
            ++chunkEpoch; chunker.cancel(); sendingChunks = false; chunkDirty = false; previousView = null; changedSinceReset = true;
            if (awaitingAck) { const current = awaitingAck; awaitingAck = null; clearTimeout(current.timer); current.reject(new Error('flow paused')); }
          }
          return;
        }
        if (action !== 'resume' || !flowPaused || generation !== flowGeneration) return;
        pendingReset = generation; schedule();
      };
      const loadInitialHistory = () => {
        if (historyLoading || latest?.status === 'ready') return;
        const generation = historyGeneration;
        const current = () => connection === ws && streams.get(msg.id) === session && generation === historyGeneration && !revoked.has(msg.deviceId) && session.status !== 'ready';
        const reading = Promise.resolve().then(() => current() ? readInitialHistory(m[1], msg.deviceId) : null).then(conversation => {
          if (conversation && conversation.id === m[1] && current()) {
            if (lastHistory && JSON.stringify(lastHistory) === JSON.stringify(conversation)) return;
            changedSinceReset = true;
            lastHistory = conversation; pendingHistory = conversation; schedule();
          }
        }).catch(() => {}).finally(() => { if (historyLoading === reading) historyLoading = null; });
        historyLoading = reading;
      };
      session.on('state', event => {
        if (!streams.has(msg.id)) return;
        if (event.status === 'ready') connectionDiagnostic.mark('first-ready');
        if (event.status === 'ready') models?.observe({ deviceId: msg.deviceId, threadId: m[1], session });
        const wasUnavailable = latest?.status === 'unavailable';
        if (event.status !== 'ready' && wasUnavailable && historyLoading) return;
        clearImageTimer(msg.id);
        const generation = ++historyGeneration;
        if (event.status !== 'ready') {
          latest = { status: 'unavailable' };
          if (!wasUnavailable) { changedSinceReset = true; pendingStatus = true; pendingHistory = null; lastHistory = null; schedule(); }
          lastIssued = [];
          loadInitialHistory();
          return;
        }
        historyLoading = null;
        changedSinceReset = true;
        pendingHistory = null; lastHistory = null;
        latest = { status: 'ready', value: event.value, revision: event.revision }; pendingStatus = false; schedule();
        if (!imagePreview) return;
        const refreshImages = async () => {
          try {
            if (revoked.has(msg.deviceId)) return;
            const issued = await imagePreview.issue({ state: event.value, hostId, deviceId: msg.deviceId, threadId: m[1] });
            if (revoked.has(msg.deviceId)) { imagePreview.revokeDevice(msg.deviceId); return; }
            if (connection !== ws || connection.readyState !== WebSocket.OPEN) return;
            if (streams.get(msg.id) !== session || generation !== historyGeneration || session.status !== 'ready') return;
            if (JSON.stringify(issued) !== JSON.stringify(lastIssued)) {
              lastIssued = issued;
              changedSinceReset = true; schedule();
            }
          } catch { /* The text state has already been sent; images may be unavailable. */ }
          if (connection === ws && connection.readyState === WebSocket.OPEN && streams.get(msg.id) === session && generation === historyGeneration && session.status === 'ready' && !revoked.has(msg.deviceId)) {
            const timeout = setTimeout(refreshImages, Math.max(1, Math.floor((imagePreview.ttlMs || 60000) / 2)));
            timeout.unref(); imageTimers.set(msg.id, timeout);
          }
        };
        void refreshImages();
      });
      try {
        session.start();
        // Read-only history does not depend on owner discovery. A live snapshot
        // still wins, and recovery/write authorization remains a separate step.
        if (latest?.status !== 'ready') { latest ??= { status: 'unavailable' }; loadInitialHistory(); }
      } catch { streams.delete(msg.id); void closeSession(session); send({ type: 'end', id: msg.id }, connection); }
      } finally { if (mutation) activeMutations--; }
    });
    ws.on('close', () => { void notificationMonitor?.close(); notificationMonitor = null; trace('relay', 'close', {}); for (const id of sidebarStreams.keys()) removeSidebarStream(id); connectionScheduler.close(); for (const requests of [readRequests, writeReplies]) { for (const request of requests.values()) { request.cancelled = true; request.chunkStop?.(); } requests.clear(); } clearTimeout(heartbeat); statusPriorities.clear(); void sidebarStatus?.close(); imagePreview?.clear(); for (const operation of inflightUploads.values()) { operation.cancelled = true; clearTimeout(operation.timer); } inflightUploads.clear(); closeStreams(); void cleanupDevice().then(async () => { await Promise.all([...pendingClaims]); const ctx = await uploadContext?.catch(() => null); await ctx?.receiver.close(); await ctx?.store.close(); }).finally(() => uploadChecks.delete(uploadsBusy)); if (!stopped) timer = setTimeout(connect, retryMs); });
  }
  return { start() { if (ws || stopped) throw new Error('Connector already started'); connect(); }, async beginShutdown() { if (shuttingDown || activeMutations || [...uploadChecks].some(check => check())) throw Object.assign(new Error('Connector writes are active'), { code: 'tasks-active' }); shuttingDown = true; try { if (ws?.readyState === WebSocket.OPEN) await scheduler?.drainControls(); } catch { shuttingDown = false; throw Object.assign(new Error('Connector replies could not be flushed'), { code: 'tasks-active' }); } }, cancelShutdown() { shuttingDown = false; }, async close() { stopped = true; observedOwner?.off?.('threadReleased', onThreadReleased); clearTimeout(timer); closeStreams(); await models?.close(); if (ws?.readyState === WebSocket.OPEN) await scheduler?.drainControls().catch(() => {}); if (ws && ws.readyState !== WebSocket.CLOSED) { await new Promise(resolve => { ws.once('close', resolve); ws.terminate(); }); } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connector = createPreviewConnector({ url: process.env.HUB_RELAY_URL, secret: process.env.HUB_CONNECTOR_SECRET }); connector.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void connector.close().then(() => process.exit(0)); });
}
