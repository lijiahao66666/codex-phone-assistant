// Factories must read current stream state when invoked, not capture snapshots.
export function createWebSocketSendScheduler({ socket, maxMessageBytes = 8 * 1024 * 1024, maxStreamMessageBytes = maxMessageBytes, maxControlBytes = 1024 * 1024, maxControls = 128, reservedControlBytes = 0, reservedControls = 0, maxBusy = 8, busyTtlMs = 8000, maxStreams = 16, controlBurst = 4, sendTimeoutMs = 45000, now = Date.now, onError = () => {} }) {
  for (const value of [maxMessageBytes, maxStreamMessageBytes, maxControlBytes, maxControls, maxBusy, busyTtlMs, maxStreams, controlBurst, sendTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid scheduler limit');
  }
  if (!Number.isSafeInteger(reservedControlBytes) || reservedControlBytes < 0 || reservedControlBytes >= maxControlBytes || !Number.isSafeInteger(reservedControls) || reservedControls < 0 || reservedControls >= maxControls) throw new Error('Invalid scheduler reserve');
  if (!socket || typeof socket.send !== 'function' || typeof onError !== 'function' || typeof now !== 'function') throw new Error('Invalid scheduler');
  const controls = [], busy = new Map(), streams = new Map();
  let controlBytes = 0, running = false, scheduled = false, closed = false, controlsSent = 0, flightTimer;
  const drainWaiters = new Set();
  function settleDrain(error) {
    if (!error && (running || controls.length || busy.size)) return;
    for (const waiter of drainWaiters) error ? waiter.reject(error) : waiter.resolve();
    drainWaiters.clear();
  }
  const report = (code, key, error) => { try { onError({ code, key, error }); } catch {} };
  function schedule() {
    if (closed || running || scheduled) return;
    scheduled = true;
    queueMicrotask(pump);
  }
  function close() { closed = true; clearTimeout(flightTimer); controls.length = 0; controlBytes = 0; busy.clear(); streams.clear(); settleDrain(new Error('scheduler closed')); }
  function clearExpiredBusy() { for (const [key, item] of busy) if (item.expires <= now()) busy.delete(key); }
  function pump() {
    scheduled = false;
    if (closed || running) return;
    if (socket.readyState !== 1) { close(); report('socket-unavailable'); return; }
    clearExpiredBusy();
    let item;
    if ((controls.length || busy.size) && (controlsSent < controlBurst || !streams.size)) {
      const critical = controls.findIndex(entry => entry.reserved);
      if (critical >= 0) { item = controls.splice(critical, 1)[0]; controlBytes -= item.bytes; }
      else if (busy.size) { const key = busy.keys().next().value; item = busy.get(key); busy.delete(key); }
      else { item = controls.shift(); controlBytes -= item.bytes; }
      controlsSent++;
    } else if (streams.size) {
      const [key, factory] = streams.entries().next().value;
      streams.delete(key); controlsSent = 0;
      try {
        const data = factory();
        if (data === null || data === undefined) { schedule(); return; }
        if (typeof data !== 'string') throw new TypeError('Stream factory must return a string');
        const bytes = Buffer.byteLength(data);
        if (bytes > maxStreamMessageBytes) { report('message-too-large', key); schedule(); return; }
        item = { data, key };
      } catch (error) { report('factory-failed', key, error); schedule(); return; }
    } else { settleDrain(); return; }
    running = true;
    flightTimer = setTimeout(() => { if (closed) return; close(); report('send-timeout', item.key); }, sendTimeoutMs);
    flightTimer.unref?.();
    try {
      socket.send(item.data, error => {
        if (closed) return;
        clearTimeout(flightTimer);
        running = false;
        if (error) { close(); report('send-failed', item.key, error); return; }
        settleDrain();
        schedule();
      });
    } catch (error) { running = false; close(); report('send-failed', item.key, error); }
  }
  return {
    enqueueControl(data, { reserved = true, requestId, deviceId, cancellable = false } = {}) {
      if (closed || typeof data !== 'string') return false;
      const bytes = Buffer.byteLength(data);
      const countLimit = maxControls - (reserved ? 0 : reservedControls);
      const byteLimit = maxControlBytes - (reserved ? 0 : reservedControlBytes);
      if (bytes > maxMessageBytes || controls.length >= countLimit || controlBytes + bytes > byteLimit) return false;
      controls.push({ data, bytes, reserved, requestId, deviceId, cancellable }); controlBytes += bytes; schedule(); return true;
    },
    enqueueBusy(key, data, { deviceId } = {}) {
      if (closed || typeof key !== 'string' || !key || typeof data !== 'string' || Buffer.byteLength(data) > 1024) return false;
      clearExpiredBusy();
      if (!busy.has(key) && busy.size >= maxBusy) return false;
      busy.set(key, { data, deviceId, expires: now() + busyTtlMs }); schedule(); return true;
    },
    cancelBusy(key) { return busy.delete(key); },
    cancelRequest(key) {
      busy.delete(key);
      for (let i = controls.length - 1; i >= 0; i--) if (controls[i].cancellable && controls[i].requestId === key) { controlBytes -= controls[i].bytes; controls.splice(i, 1); }
    },
    cancelDevice(deviceId) {
      for (const [key, item] of busy) if (item.deviceId === deviceId) busy.delete(key);
      for (let i = controls.length - 1; i >= 0; i--) if (controls[i].cancellable && controls[i].deviceId === deviceId) { controlBytes -= controls[i].bytes; controls.splice(i, 1); }
    },
    markStream(key, factory) {
      if (closed || typeof key !== 'string' || !key || typeof factory !== 'function' || (!streams.has(key) && streams.size >= maxStreams)) return false;
      streams.set(key, factory); schedule(); return true;
    },
    cancelStream(key) { return streams.delete(key); },
    drainControls() {
      if (closed) return Promise.reject(new Error('scheduler closed'));
      if (!running && !controls.length && !busy.size) return Promise.resolve();
      return new Promise((resolve, reject) => drainWaiters.add({ resolve, reject }));
    },
    close,
  };
}
