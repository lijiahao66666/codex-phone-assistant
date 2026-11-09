import { EventEmitter } from 'node:events';
import { DesktopIpc } from './ipc.mjs';

const keyFor = (id, host) => JSON.stringify([host, id]);
const unavailable = () => Object.assign(new Error('IPC lease closed'), { code: 'unavailable' });

// Desktop broadcasts complete owned histories when clients join or leave its
// bus. Keep one transport across short-lived conversation observers instead.
export class DesktopIpcPool {
  constructor({ createClient = () => new DesktopIpc(), idleMs = 30000 } = {}) {
    if (typeof createClient !== 'function' || !Number.isSafeInteger(idleMs) || idleMs < 0) throw new TypeError('Invalid IPC pool options');
    this.createClient = createClient; this.idleMs = idleMs;
    this.leases = new Set(); this.entries = new Map(); this.client = null; this.connecting = null; this.closed = false;
  }
  acquire() {
    if (this.closed) throw unavailable();
    return new IpcLease(this);
  }
  async connect(lease) {
    if (this.closed || lease.state !== 'new') throw unavailable();
    clearTimeout(this.idleTimer);
    this.leases.add(lease); lease.state = 'connecting';
    try {
      const client = await this.ensureClient();
      if (lease.state !== 'connecting' || !this.leases.has(lease)) throw unavailable();
      lease.state = 'ready'; lease.transport = client;
      return lease;
    } catch (error) {
      if (this.leases.has(lease)) this.release(lease);
      throw error;
    }
  }
  async ensureClient() {
    if (this.client?.state === 'ready') return this.client;
    if (this.connecting) return this.connecting;
    const client = this.createClient();
    this.client = client;
    client.on('ownerDisconnected', owner => {
      if (this.client === client) for (const lease of this.leases) lease.emit('ownerDisconnected', owner);
    });
    client.once('disconnect', detail => this.disconnected(client, detail));
    const connecting = client.connect().then(() => {
      if (this.closed || this.client !== client) throw unavailable();
      return client;
    }).catch(error => {
      this.disconnected(client, { intentional: false, error });
      void client.close().catch(() => {});
      throw error;
    }).finally(() => { if (this.connecting === connecting) this.connecting = null; });
    this.connecting = connecting;
    return connecting;
  }
  disconnected(client, detail) {
    if (this.client !== client) return;
    this.client = null; this.connecting = null; this.entries.clear();
    const leases = [...this.leases]; this.leases.clear();
    for (const lease of leases) {
      lease.abort.abort();
      lease.state = 'closed'; lease.transport = null; lease.subscriptions.clear();
      lease.emit('disconnect', detail);
    }
  }
  async subscribe(lease, id, listener, host, { beforeFollow, beforeSnapshotRequest } = {}) {
    lease.assertReady();
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const key = keyFor(id, host);
    if (lease.subscriptions.has(key)) throw new Error('Thread already subscribed');
    const consumer = { lease, listener, key, awaitingSnapshot: true };
    lease.subscriptions.set(key, consumer);
    try {
      // Admission belongs to the consumer. A sidebar wait must not hold the
      // physical subscription queue and block another conversation observer.
      if (beforeFollow) await beforeFollow();
      lease.assertReady();
      if (lease.subscriptions.get(key) !== consumer) throw unavailable();
      const client = lease.transport;
      let entry = this.entries.get(key), existing = Boolean(entry);
      if (!entry) {
        entry = { id, host, consumers: new Set(), client, off: null, pending: null };
        this.entries.set(key, entry);
      }
      entry.consumers.add(consumer); consumer.entry = entry;
      if (!existing) {
        entry.pending = client.subscribe(id, (change, source) => {
          if (this.entries.get(key) !== entry || this.client !== client) return;
          for (const item of [...entry.consumers]) {
            if (item.lease.state !== 'ready' || item.lease.subscriptions.get(key) !== item) continue;
            if (item.awaitingSnapshot && change?.type !== 'snapshot') continue;
            if (change?.type === 'snapshot') item.awaitingSnapshot = false;
            try { item.listener(change, source); }
            catch (error) { item.lease.emit('listenerError', error); }
          }
        }, host, { beforeSnapshotRequest }).then(off => {
          if (this.entries.get(key) !== entry) off(); else entry.off = off;
        });
      }
      await entry.pending;
      lease.assertReady();
      if (this.entries.get(key) !== entry || lease.subscriptions.get(key) !== consumer) throw unavailable();
      // Do not retain another complete history in the pool. The owner sends a
      // fresh snapshot for this thread, also preserving existing listeners.
      if (existing) { beforeSnapshotRequest?.(); client.refreshSubscription(id, host); }
      return () => lease.subscriptions.get(key) === consumer && this.unsubscribe(lease, id, host);
    } catch (error) {
      if (lease.subscriptions.get(key) === consumer) this.unsubscribe(lease, id, host);
      throw error;
    }
  }
  unsubscribe(lease, id, host) {
    const key = keyFor(id, host), consumer = lease.subscriptions.get(key);
    if (!consumer) return false;
    lease.subscriptions.delete(key);
    const entry = consumer.entry;
    if (entry) {
      entry.consumers.delete(consumer);
      if (!entry.consumers.size && this.entries.get(key) === entry) {
        this.entries.delete(key);
        try { if (entry.off) entry.off(); else entry.client.unsubscribe(id, host); }
        catch { /* Local removal still completes if the socket is closing. */ }
      }
    }
    return true;
  }
  release(lease) {
    if (lease.state === 'closed') return;
    lease.abort.abort();
    for (const key of [...lease.subscriptions.keys()]) {
      const [host, id] = JSON.parse(key); this.unsubscribe(lease, id, host);
    }
    this.leases.delete(lease); lease.state = 'closed'; lease.transport = null;
    lease.emit('disconnect', { intentional: true });
    if (!this.leases.size && !this.closed) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { void this.closeIdle().catch(() => {}); }, this.idleMs);
      this.idleTimer.unref?.();
    }
  }
  async closeIdle() {
    if (this.leases.size) return;
    const client = this.client; this.client = null; this.connecting = null; this.entries.clear();
    if (client) await client.close();
  }
  async close() {
    this.closed = true; clearTimeout(this.idleTimer);
    for (const lease of [...this.leases]) this.release(lease);
    await this.closeIdle();
  }
}

class IpcLease extends EventEmitter {
  constructor(pool) { super(); this.pool = pool; this.state = 'new'; this.transport = null; this.subscriptions = new Map(); this.abort = new AbortController(); }
  assertReady() {
    if (this.state !== 'ready' || this.transport !== this.pool.client || this.transport?.state !== 'ready') throw unavailable();
  }
  connect() { return this.pool.connect(this); }
  subscribe(id, listener, host = 'local', options) { return this.pool.subscribe(this, id, listener, host, options); }
  unsubscribe(id, host = 'local') { return this.pool.unsubscribe(this, id, host); }
  async probeOwner(id, expectedOwnerId, { timeout = 2000 } = {}) {
    this.assertReady();
    if (typeof id !== 'string' || !id || typeof expectedOwnerId !== 'string' || !expectedOwnerId) throw new TypeError('conversationId and ownerId required');
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError('Positive probe timeout required');
    const probe = this.pool.acquire();
    let timer, rejectProbe, armed = false;
    const cancelled = () => rejectProbe?.(unavailable());
    const disconnectedOwner = ownerId => { if (ownerId === expectedOwnerId) cancelled(); };
    try {
      await probe.connect();
      this.assertReady();
      const result = new Promise((resolve, reject) => {
        rejectProbe = reject;
        timer = setTimeout(() => reject(new Error('Owner snapshot probe timed out')), timeout);
        this.abort.signal.addEventListener('abort', cancelled, { once: true });
        probe.on('disconnect', cancelled);
        probe.on('ownerDisconnected', disconnectedOwner);
        void probe.subscribe(id, (change, source) => {
          if (!armed || change?.type !== 'snapshot') return;
          if (source?.ownerId !== expectedOwnerId) return reject(unavailable());
          if (source.conversationId !== id || source.hostId !== 'local' || change.conversationState?.id !== id ||
              !Number.isSafeInteger(change.revision) || change.revision < 0) return;
          if (change.conversationState.remodexRemoved === true) return reject(unavailable());
          resolve({ revision: change.revision });
        }, 'local', { beforeSnapshotRequest: () => { armed = true; } }).catch(reject);
      });
      return await result;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', cancelled);
      probe.off('disconnect', cancelled);
      probe.off('ownerDisconnected', disconnectedOwner);
      await probe.close();
    }
  }
  async close() { this.pool.release(this); }
}
IpcLease.prototype.discover = async function (id, host = 'local', options = {}) {
  this.assertReady();
  const result = await this.transport.discover(id, host, {
    ...options, signal: options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal,
  });
  this.assertReady();
  return result;
};
for (const [method, optionsIndex] of Object.entries({ startTurn: 2, steerTurn: 2, interruptTurn: 2, setCollaborationMode: 3, replyCommandApproval: 3, replyFileApproval: 3, replyUserInput: 3 })) {
  IpcLease.prototype[method] = async function (...args) {
    this.assertReady();
    const options = args[optionsIndex] || {};
    args[optionsIndex] = { ...options, signal: options.signal ? AbortSignal.any([this.abort.signal, options.signal]) : this.abort.signal };
    return this.transport[method](...args);
  };
}

export const desktopIpcPool = new DesktopIpcPool();
