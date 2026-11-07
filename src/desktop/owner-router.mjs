import { isAbsolute } from 'node:path';
import { readModelCatalog } from './model-catalog.mjs';
import { createHash, randomUUID } from 'node:crypto';

function unavailable(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

// The adapters must distinguish an explicit missing owner from an unavailable bus.
export class OwnerRouter {
  constructor({ discover, localOwner, projects, journal, hostId, confirmRecovery, recoveryTimeoutMs = 10000, recoveryPollMs = 100, competeUnknown = false }) {
    if (typeof discover !== 'function' || !localOwner || typeof projects !== 'function') throw new TypeError('Missing owner adapters');
    this.competeUnknown = competeUnknown;
    this.discover = discover;
    this.localOwner = localOwner;
    this.projects = projects;
    this.journal = journal; this.hostId = hostId;
    this.confirmRecovery = confirmRecovery;
    this.recoveryTimeoutMs = recoveryTimeoutMs; this.recoveryPollMs = recoveryPollMs;
    this.pending = new Map();
    this.uncertainRecovery = new Set();
    this.lateRecoveries = new Map();
    this.closed = false;
    this.stopping = false;
    this.inFlight = 0;
    this.onLateResponse = event => this.#handleLateRecovery(event);
    this.localOwner.on?.('lateResponse', this.onLateResponse);
  }

  #handleLateRecovery(event) {
    if (this.closed || event?.method !== 'thread/resume' || event.status !== 'error' || event.errorCode !== -32600 || event.writerConflict !== true) return;
    const expected = this.lateRecoveries.get(event.threadId);
    if (!expected || expected.attemptId !== event.attemptId || expected.instanceId !== event.instanceId || expected.requestId !== event.requestId) return;
    try {
      const cleared = expected.deviceId ? this.journal.rejectLateRecovery(this.hostId, expected.deviceId, event.threadId, expected.attemptId) : this.journal.endRecovery(this.hostId, event.threadId, expected.attemptId);
      if (!cleared) return;
      this.lateRecoveries.delete(event.threadId);
      this.uncertainRecovery.delete(event.threadId);
    } catch { /* Preserve the lock if the journal cannot confirm removal. */ }
  }

  async #tracked(operation) {
    if (this.closed || this.stopping) throw unavailable('unavailable');
    this.inFlight++;
    try { return await operation(); } finally { this.inFlight--; }
  }

  beginShutdown() {
    if (this.closed || this.stopping || this.inFlight) throw unavailable('tasks-active');
    this.stopping = true;
  }
  cancelShutdown() { if (!this.closed) this.stopping = false; }
  route(threadId, options) { return this.#tracked(() => this.#routeRequest(threadId, options)); }
  create(options) { return this.#tracked(() => this.#create(options)); }
  prepare(options) { return this.#tracked(() => this.#prepare(options)); }
  submitPrepared(options) { return this.#tracked(() => this.#submitPrepared(options)); }

  async #routeRequest(threadId, { isCancelled = () => false, deviceId, requestId } = {}) {
    if (this.closed || typeof threadId !== 'string' || !threadId) throw unavailable('unavailable');
    if (typeof isCancelled !== 'function' || isCancelled()) throw unavailable('unavailable');
    if (this.pending.has(threadId)) throw unavailable('unavailable');
    const operation = this.#route(threadId, isCancelled, deviceId, requestId);
    this.pending.set(threadId, operation);
    try { return await operation; } finally { if (this.pending.get(threadId) === operation) this.pending.delete(threadId); }
  }

  isRecoveryLocked(threadId) {
    try { return this.uncertainRecovery.has(threadId) || Boolean(this.journal?.recoveryPending?.(this.hostId, threadId)); }
    catch { return true; }
  }

  async #route(threadId, isCancelled, deviceId, requestId) {
    if (this.isRecoveryLocked(threadId)) throw unavailable('resume-unknown');
    const first = await this.discover(threadId);
    if (this.closed || isCancelled()) throw unavailable('unavailable');
    if (first?.kind === 'owner' && first.ownerId) return first;
    if (first?.kind !== 'missing' && !(this.competeUnknown && first?.kind === 'unknown')) throw unavailable('owner-unknown');
    const attemptId = requestId || randomUUID();
    if (!this.hostId || !(deviceId ? this.journal?.dispatchRecovery?.(this.hostId, deviceId, threadId, attemptId) : this.journal?.beginRecovery?.(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
    this.uncertainRecovery.add(threadId);
    if (this.closed || isCancelled()) {
      const cleared = deviceId
        ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'rejected')
        : this.journal.endRecovery(this.hostId, threadId, attemptId);
      if (cleared) this.uncertainRecovery.delete(threadId);
      throw unavailable('unavailable');
    }
    try {
      await this.localOwner.resume(threadId, { attemptId });
    } catch (error) {
      if (error?.code !== 'writer-conflict') {
        if (this.lateRecoveries.size < 1024 && error?.code === 'outcome-unknown' && error.attemptId === attemptId && typeof error.instanceId === 'string' && error.instanceId && Number.isSafeInteger(error.requestId)) {
          this.lateRecoveries.set(threadId, { attemptId, instanceId: error.instanceId, requestId: error.requestId, deviceId });
        }
        throw unavailable('resume-unknown', error);
      }
      let current;
      try { current = await this.discover(threadId); } catch { current = null; }
      if (current?.kind === 'owner' && current.ownerId) {
        if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'accepted') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
        this.uncertainRecovery.delete(threadId);
        if (this.closed || isCancelled()) throw unavailable('unavailable');
        return current;
      }
      if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'rejected') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
      this.uncertainRecovery.delete(threadId);
      throw unavailable('unavailable', error);
    }
    if (this.closed) throw unavailable('unavailable');
    const deadline = Date.now() + this.recoveryTimeoutMs;
    let owner, localOwnerId;
    do {
      if (this.closed || isCancelled()) throw unavailable('owner-unknown');
      localOwnerId = await this.localOwner.ownerId();
      if (localOwnerId) {
        try { owner = await this.discover(threadId); } catch { owner = null; }
        if (owner?.kind === 'owner' && owner.ownerId === localOwnerId) break;
        if (owner?.kind === 'owner' && owner.ownerId !== localOwnerId) throw unavailable('owner-unknown');
      }
      if (Date.now() >= deadline) throw unavailable('owner-unknown');
      await new Promise(resolve => setTimeout(resolve, Math.min(this.recoveryPollMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    if (!localOwnerId || owner?.kind !== 'owner' || owner.ownerId !== localOwnerId) throw unavailable('owner-unknown');
    if (typeof this.confirmRecovery !== 'function' || !(await this.confirmRecovery(threadId, localOwnerId))) throw unavailable('owner-unknown');
    const currentOwner = await this.discover(threadId);
    if (this.closed || await this.localOwner.ownerId() !== localOwnerId || currentOwner?.kind !== 'owner' || currentOwner.ownerId !== localOwnerId) throw unavailable('owner-unknown');
    if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'accepted') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
    this.uncertainRecovery.delete(threadId);
    return owner;
  }

  creationStatus(deviceId, requestId) {
    if (!this.journal || !this.hostId) throw unavailable('unavailable');
    const record = this.journal.get(this.hostId, deviceId, requestId);
    if (!record) return { phase: 'missing' };
    return { phase: record.phase, ...(record.threadId ? { threadId: record.threadId } : {}) };
  }

  async #create({ projectId, text, model, effort, requestId, deviceId, isCancelled = () => false } = {}) {
    if (this.closed || typeof projectId !== 'string' || !projectId || typeof text !== 'string' || !text.trim()) throw unavailable('invalid-input');
    if ((model !== undefined && (typeof model !== 'string' || !model)) || (effort !== undefined && (typeof effort !== 'string' || !effort || !model))) throw unavailable('invalid-input');
    const project = (await this.projects()).find(entry => entry.id === projectId);
    if (!project || !isAbsolute(project.cwd || '')) throw unavailable('invalid-project');
    if (model) {
      const catalog = await readModelCatalog((method, params) => this.localOwner.request(method, params));
      const selected = catalog.find(entry => entry.model === model);
      if (!selected || (effort && !selected.supportedReasoningEfforts.includes(effort))) throw unavailable('model-unavailable');
    }
    if (this.closed || isCancelled()) throw unavailable('unavailable');
    if (!this.journal || !this.hostId || !deviceId || !requestId) throw unavailable('unavailable');
    const digest = createHash('sha256').update(JSON.stringify([projectId, text, model ?? null, effort ?? null])).digest('hex');
    const record = this.journal.begin(this.hostId, deviceId, requestId, projectId, digest);
    if (!record.created) {
      if (record.phase === 'submitted' && record.threadId) return { threadId: record.threadId };
      if (record.threadId) throw Object.assign(unavailable('start-unknown'), { threadId: record.threadId });
      throw unavailable('create-unknown');
    }
    // A failed start after creation has an unknown outcome and must never be retried automatically.
    const thread = await this.localOwner.create({ cwd: project.cwd, ...(project.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: project.runtimeWorkspaceRoots } : {}), ...(model ? { model } : {}) });
    if (!thread?.id) throw unavailable('create-unknown');
    this.journal.transition(this.hostId, deviceId, requestId, 'creating', 'prepared', thread.id);
    if (this.closed || isCancelled()) throw Object.assign(unavailable('start-unknown'), { threadId: thread.id });
    this.journal.transition(this.hostId, deviceId, requestId, 'prepared', 'submitting');
    try { await this.localOwner.startTurn(thread.id, text, { model, effort }); }
    catch (error) { throw Object.assign(unavailable('start-unknown', error), { threadId: thread.id }); }
    this.journal.transition(this.hostId, deviceId, requestId, 'submitting', 'submitted');
    return { threadId: thread.id };
  }

  async #prepare({ projectId, model, effort, requestId, deviceId, digest, isCancelled = () => false } = {}) {
    if (this.closed || !this.journal || !this.hostId || !deviceId || !requestId || !/^[a-f0-9]{64}$/.test(digest || '')) throw unavailable('invalid-input');
    const project = (await this.projects()).find(entry => entry.id === projectId);
    if (!project || !isAbsolute(project.cwd || '')) throw unavailable('invalid-project');
    if (model) {
      const catalog = await readModelCatalog((method, params) => this.localOwner.request(method, params));
      const selected = catalog.find(entry => entry.model === model);
      if (!selected || (effort && !selected.supportedReasoningEfforts.includes(effort))) throw unavailable('model-unavailable');
    } else if (effort) throw unavailable('invalid-input');
    if (this.closed || isCancelled()) throw unavailable('unavailable');
    const boundDigest = createHash('sha256').update(JSON.stringify([digest, model ?? null, effort ?? null])).digest('hex');
    const record = this.journal.begin(this.hostId, deviceId, requestId, projectId, boundDigest);
    if (!record.created) {
      if (record.phase === 'prepared') return { threadId: record.threadId };
      throw Object.assign(unavailable(record.threadId ? 'start-unknown' : 'create-unknown'), { threadId: record.threadId });
    }
    const thread = await this.localOwner.create({ cwd: project.cwd, ...(project.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: project.runtimeWorkspaceRoots } : {}), ...(model ? { model } : {}) });
    if (!thread?.id) throw unavailable('create-unknown');
    this.journal.transition(this.hostId, deviceId, requestId, 'creating', 'prepared', thread.id);
    if (this.closed || isCancelled()) throw Object.assign(unavailable('start-unknown'), { threadId: thread.id });
    return { threadId: thread.id };
  }

  async #submitPrepared({ deviceId, requestId, text, model, effort, attachments, digest, isCancelled = () => false, onDispatch = () => {} }) {
    const record = this.journal.get(this.hostId, deviceId, requestId);
    const boundDigest = createHash('sha256').update(JSON.stringify([digest, model ?? null, effort ?? null])).digest('hex');
    if (!record || record.phase !== 'prepared' || record.payloadDigest !== boundDigest || isCancelled()) throw unavailable('unavailable');
    this.journal.transition(this.hostId, deviceId, requestId, 'prepared', 'submitting');
    onDispatch();
    try { await this.localOwner.startTurn(record.threadId, text, { model, effort, attachments }); }
    catch (error) { throw Object.assign(unavailable('start-unknown', error), { threadId: record.threadId }); }
    this.journal.transition(this.hostId, deviceId, requestId, 'submitting', 'submitted');
    return { threadId: record.threadId };
  }

  close() { this.closed = true; this.localOwner.off?.('lateResponse', this.onLateResponse); this.lateRecoveries.clear(); }
}
