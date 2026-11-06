// Per-device hints only influence which verified desktop threads are observed.
export class StatusPriorities {
  constructor({ maxDevices = 32, ttlMs = 30000, now = Date.now } = {}) {
    this.maxDevices = maxDevices; this.ttlMs = ttlMs; this.now = now; this.devices = new Map();
  }
  select(deviceId, visible, allowed, fallback, alreadyObserved = new Set()) {
    const now = this.now();
    for (const [id, state] of this.devices) if (state.until <= now) this.devices.delete(id);
    if (Array.isArray(visible)) {
      const ids = [...new Set(visible.filter(id => allowed.has(id)))];
      if (!ids.length) this.devices.delete(deviceId);
      else if (this.devices.has(deviceId) || this.devices.size < this.maxDevices) this.devices.set(deviceId, { ids, until: now + this.ttlMs });
    }
    const selected = [], seen = new Set(alreadyObserved);
    const add = id => { if (allowed.has(id) && !seen.has(id)) { seen.add(id); selected.push(id); } };
    const groups = [...this.devices.values()].map(state => state.ids);
    const longest = Math.max(0, ...groups.map(group => group.length));
    for (let i = 0; i < longest; i++) for (const group of groups) if (group[i]) add(group[i]);
    return selected;
  }
  remove(deviceId) { this.devices.delete(deviceId); }
  clear() { this.devices.clear(); }
}
