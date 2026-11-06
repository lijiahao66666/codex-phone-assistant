import { DesktopIpc } from './desktop-ipc.mjs';
import { SidebarProjection } from './sidebar-projection.mjs';
import { EventEmitter } from 'node:events';

// One shared, bounded observer for the visible recent list; it never writes.
export class SidebarStatus extends EventEmitter {
  constructor({ createClient = () => new DesktopIpc({ timeout: 3000 }), concurrency = 2, discoveryConcurrency = 8, idleMs = 30000, retryMs = 5000, sizeRetryMs = 60000, snapshotMs = 5000, ownerCheckMs = 30000, retainActiveMs = 30000, maxRetained = 8 } = {}) {
    super();
    this.createClient = createClient; this.concurrency = concurrency; this.idleMs = idleMs; this.retryMs = retryMs; this.sizeRetryMs = sizeRetryMs; this.snapshotMs = snapshotMs; this.ownerCheckMs = ownerCheckMs;
    this.entries = new Map(); this.generation = 0; this.client = null; this.connecting = null; this.retryAt = 0;
    this.retainActiveMs = retainActiveMs; this.maxRetained = maxRetained; this.retained = new Map();
    this.discoveryConcurrency = discoveryConcurrency;
  }
  async update(ids, excluded = new Set(), { renewIdle = true } = {}) {
    if (renewIdle) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { void this.close(); }, this.idleMs);
      this.idleTimer.unref?.();
    }
    this.requested = ids.filter(id => typeof id === 'string'); this.excluded = excluded;
    const desired = new Set(this.requested);
    for (const [id, timer] of this.retained) if (desired.has(id) || excluded.has(id)) { clearTimeout(timer); this.retained.delete(id); }
    for (const [id, entry] of this.entries) if (!desired.has(id) && !excluded.has(id) && entry.status === 'active' && !this.retained.has(id) && id !== this.expiredRetained && this.retained.size < this.maxRetained) {
      const timer = setTimeout(() => { this.retained.delete(id); this.expiredRetained = id; void this.update(this.requested, this.excluded); }, this.retainActiveMs);
      timer.unref?.(); this.retained.set(id, timer);
    }
    this.expiredRetained = null;
    for (const id of this.retained.keys()) desired.add(id);
    this.desired = desired;
    for (const [id, entry] of this.entries) if (!desired.has(id)) { this.entries.delete(id); entry.cancelWait?.(); entry.settleInitial(); clearTimeout(entry.timer); clearTimeout(entry.ownerTimer); clearTimeout(entry.retryTimer); if (entry.off) entry.off(); else this.client?.unsubscribe?.(id); this.emit('change'); }
    if (!desired.size || Date.now() < this.retryAt) return;
    const generation = this.generation;
    if (!this.client) {
      if (!this.connecting) {
        const client = this.createClient();
        const connecting = client.connect().then(() => {
          if (this.generation !== generation) { void client.close(); return null; }
          this.client = client;
          client.once('disconnect', () => { if (this.client === client) { this.client = null; this.clearEntries(); this.scheduleReconnect(); } });
          client.on('ownerDisconnected', owner => { for (const [id, entry] of this.entries) if (entry.ownerId === owner) this.fail(id, entry, 0); });
          return client;
        }).catch(() => { if (this.generation === generation) this.scheduleReconnect(); void client.close().catch(() => {}); return null; }).finally(() => { if (this.connecting === connecting) this.connecting = null; });
        this.connecting = connecting;
      }
      await this.connecting;
    }
    const client = this.client;
    if (!client || generation !== this.generation) return;
    for (const [id, entry] of this.entries) if (entry.status === 'unavailable' && Date.now() >= entry.retryAt) this.entries.delete(id);
    this.pump(client);
  }
  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.retryAt = Date.now() + this.retryMs;
    const generation = this.generation;
    this.reconnectTimer = setTimeout(() => {
      if (generation === this.generation && this.desired?.size && !this.client) void this.update(this.requested, this.excluded, { renewIdle: false });
    }, this.retryMs);
    this.reconnectTimer.unref?.();
  }
  pump(client) {
    if (client !== this.client) return;
    let pending = [...this.entries.values()].filter(entry => entry.status === 'discovering').length;
    for (const id of this.desired) {
      const existing = this.entries.get(id);
      if (existing) continue;
      if (pending >= this.discoveryConcurrency) break;
      const entry = { state: new SidebarProjection(), status: 'discovering', off: null };
      entry.initial = new Promise(resolve => { entry.settleInitial = () => { resolve(); queueMicrotask(() => this.pump(client)); }; });
      this.entries.set(id, entry);
      pending++;
      void client.subscribe(id, (change, source) => {
        if (this.entries.get(id) !== entry || entry.status === 'unavailable') return;
        const result = entry.state.accept(source?.ownerId, change);
        if (result.status !== 'ready') return this.fail(id, entry, result.reason === 'status-too-large' ? this.sizeRetryMs : 1000);
        clearTimeout(entry.timer);
        const type = result.value?.threadRuntimeStatus?.type;
        const status = type === 'active' || type === 'idle' ? type : 'unknown';
        const changed = entry.status !== status;
        entry.status = status;
        if (status !== 'active' && this.retained.has(id)) { clearTimeout(this.retained.get(id)); this.retained.delete(id); queueMicrotask(() => { void this.update(this.requested, this.excluded); }); }
        entry.ownerId = source.ownerId;
        if (changed) this.emit('change');
        entry.settleInitial();
        if (!entry.ownerTimer) this.scheduleOwnerCheck(id, entry, client);
      }, 'local', { beforeFollow: () => new Promise((resolve, reject) => {
        if (this.entries.get(id) !== entry) return reject(new Error('cancelled'));
        entry.status = 'waiting'; entry.grant = resolve; entry.cancelWait = reject;
        this.pump(client);
      }) }).then(off => {
        if (this.entries.get(id) !== entry || entry.status === 'unavailable') off();
        else entry.off = off;
      }).catch(() => this.fail(id, entry));
    }
    let receiving = [...this.entries.values()].filter(entry => entry.status === 'connecting').length;
    for (const [id, entry] of this.entries) {
      if (receiving >= this.concurrency) break;
      if (entry.status !== 'waiting') continue;
      receiving++; entry.status = 'connecting'; entry.cancelWait = null;
      entry.timer = setTimeout(() => this.fail(id, entry), this.snapshotMs); entry.timer.unref?.();
      entry.grant(); entry.grant = null;
    }
  }
  async updateAndWait(ids, maxWaitMs = 750, excluded = new Set()) {
    let timer;
    const work = this.update(ids, excluded).then(() => Promise.all(ids.map(id => this.entries.get(id)?.initial))).catch(() => {});
    try { await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, maxWaitMs); })]); }
    finally { clearTimeout(timer); }
  }
  scheduleOwnerCheck(id, entry, client) {
    entry.ownerTimer = setTimeout(async () => {
      entry.ownerTimer = null;
      if (this.entries.get(id) !== entry || this.client !== client) return;
      try {
        const { ownerId } = await client.discover(id);
        if (this.entries.get(id) !== entry || this.client !== client) return;
        if (ownerId !== entry.ownerId) return this.fail(id, entry, 0);
        this.scheduleOwnerCheck(id, entry, client);
      } catch { this.fail(id, entry, 0); }
    }, this.ownerCheckMs);
    entry.ownerTimer.unref?.();
  }
  fail(id, entry, delay = this.retryMs) {
    if (this.entries.get(id) !== entry) return;
    entry.settleInitial();
    clearTimeout(entry.timer); clearTimeout(entry.ownerTimer); if (entry.off) entry.off(); else this.client?.unsubscribe?.(id); entry.off = null; entry.state.invalidate('unavailable');
    entry.status = 'unavailable'; entry.retryAt = Date.now() + delay; this.emit('change');
    entry.retryTimer = setTimeout(() => {
      if (this.entries.get(id) !== entry || !this.desired.has(id)) return;
      this.entries.delete(id); this.pump(this.client);
    }, Math.max(1000, delay));
    entry.retryTimer.unref?.();
  }
  get(id) { const status = this.entries.get(id)?.status; return status === 'active' || status === 'idle' ? status : 'unknown'; }
  snapshot() { return Object.fromEntries([...(this.desired ?? [])].map(id => [id, this.get(id)])); }
  clearEntries() { const hadEntries = this.entries.size > 0; for (const timer of this.retained.values()) clearTimeout(timer); this.retained.clear(); for (const entry of this.entries.values()) { entry.cancelWait?.(new Error('cancelled')); entry.settleInitial(); clearTimeout(entry.timer); clearTimeout(entry.ownerTimer); clearTimeout(entry.retryTimer); entry.off?.(); } this.entries.clear(); if (hadEntries) this.emit('change'); }
  async close() {
    for (const timer of this.retained.values()) clearTimeout(timer); this.retained.clear();
    ++this.generation; clearTimeout(this.idleTimer); clearTimeout(this.reconnectTimer); this.connecting = null; this.clearEntries(); this.desired = new Set(); this.retryAt = 0;
    const client = this.client; this.client = null; if (client) await client.close();
  }
}
