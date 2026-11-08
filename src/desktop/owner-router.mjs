import { isAbsolute } from 'node:path';
import { readModelCatalog } from './model-catalog.mjs';
import { createHash, randomUUID } from 'node:crypto';

function unavailable(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

// The adapters must distinguish an explicit missing owner from an unavailable bus.
export class OwnerRouter {
  constructor({ discover, verifyOwner = null, localOwner, projects, journal, hostId, confirmRecovery, recoveryTimeoutMs = 2500, recoveryPollMs = 300, recoveryLockTtlMs = 90_000, competeUnknown = false }) {
    if (typeof discover !== 'function' || !localOwner || typeof projects !== 'function') throw new TypeError('Missing owner adapters');
    this.competeUnknown = competeUnknown;
    this.discover = discover;
    this.verifyOwner = verifyOwner;
    this.localOwner = localOwner;
    this.projects = projects;
    this.journal = journal; this.hostId = hostId;
    this.confirmRecovery = confirmRecovery;
    this.recoveryTimeoutMs = recoveryTimeoutMs; this.recoveryPollMs = recoveryPollMs; this.recoveryLockTtlMs = recoveryLockTtlMs;
    this.pending = new Map();
    this.uncertainRecovery = new Map();
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
    try {
      const since = this.uncertainRecovery.get(threadId);
      if (since !== undefined) {
        if (Date.now() - since < this.recoveryLockTtlMs) return true;
        // The resume never reported back; after the TTL its in-memory guard is
        // stale too, otherwise the phone stays on 任务正在电脑上处理 for good.
        this.uncertainRecovery.delete(threadId);
      }
      return Boolean(this.journal?.recoveryPending?.(this.hostId, threadId));
    } catch { return true; }
  }

  // A live desktop owner already streams the thread: the phone only needs to
  // follow it. Resuming in that case always fails with a writer conflict, which
  // used to surface as 正在连接任务 even though the thread was perfectly usable.
  async #ownerResponds(threadId, ownerId) {
    if (typeof this.verifyOwner !== 'function') return false;
    try { return await this.verifyOwner(threadId, ownerId) === true; } catch { return false; }
  }

  async #route(threadId, isCancelled, deviceId, requestId) {
    const first = await this.discover(threadId);
    if (this.closed || isCancelled()) throw unavailable('unavailable');
    // Following never writes, so it is allowed even while an earlier takeover
    // reservation is still cooling down.
    if (first?.kind === 'owner' && first.ownerId) {
      const ownId = typeof this.localOwner.ownerId === 'function' ? await this.localOwner.ownerId() : null;
      if (ownId && first.ownerId === ownId) return first;
      if (await this.#ownerResponds(threadId, first.ownerId)) return first;
    } else if (first?.kind !== 'missing' && !(this.competeUnknown && first?.kind === 'unknown')) throw unavailable('owner-unknown');
    if (this.isRecoveryLocked(threadId)) throw unavailable('resume-unknown');
    const attemptId = requestId || randomUUID();
    if (!this.hostId || !(deviceId ? this.journal?.dispatchRecovery?.(this.hostId, deviceId, threadId, attemptId) : this.journal?.beginRecovery?.(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
    this.uncertainRecovery.set(threadId, Date.now());
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
      let current, currentOwnId;
      try { current = await this.discover(threadId); currentOwnId = typeof this.localOwner.ownerId === 'function' ? await this.localOwner.ownerId() : null; } catch { current = null; currentOwnId = null; }
      if (current?.kind === 'owner' && current.ownerId && currentOwnId && current.ownerId === currentOwnId) {
        if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'accepted') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
        this.uncertainRecovery.delete(threadId);
        if (this.closed || isCancelled()) throw unavailable('unavailable');
        return current;
      }
      // Desktop kept the writer and still answers for it. Following is the only
      // way in, so close the reservation and hand its owner back to the caller.
      if (current?.kind === 'owner' && current.ownerId && !(currentOwnId && current.ownerId === currentOwnId) && await this.#ownerResponds(threadId, current.ownerId)) {
        if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'rejected') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
        this.uncertainRecovery.delete(threadId);
        if (this.closed || isCancelled()) throw unavailable('unavailable');
        return current;
      }
      if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'rejected') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
      this.uncertainRecovery.delete(threadId);
      throw unavailable('unavailable', error);
    }
    if (this.closed) throw unavailable('unavailable');
    // resume returned this thread, so its writer is already ours. Ownership is only
    // worth re-checking when the bus can actually name an owner: a quiet bus is the
    // normal state while Desktop stays closed, and waiting on it turned successful
    // takeovers into 正在连接任务. A different named owner is the one signal that
    // someone else took the thread back.
    const identity = typeof this.localOwner.ownerId === 'function' ? await this.localOwner.ownerId() : null;
    let owner = null;
    if (identity) {
      try { owner = await this.discover(threadId); } catch { owner = null; }
      if (owner?.kind === 'owner' && owner.ownerId !== identity) {
        if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'rejected') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
        this.uncertainRecovery.delete(threadId);
        throw unavailable('owner-unknown');
      }
    }
    if (!(deviceId ? this.journal.completeRecovery(this.hostId, deviceId, threadId, attemptId, 'accepted') : this.journal.endRecovery(this.hostId, threadId, attemptId))) throw unavailable('resume-unknown');
    this.uncertainRecovery.delete(threadId);
    return owner?.kind === 'owner' ? owner : { kind: 'owner', ownerId: identity || null };
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
