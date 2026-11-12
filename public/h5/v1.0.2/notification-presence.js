(() => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let context = null, eligible = false, current = null, retry = null;
  const visible = () => document.visibilityState === 'visible';
  const threadId = () => { const id = window.getNotificationThreadId?.(); return uuid.test(id || '') ? id : null; };
  function presence(session, active, keepalive = false) {
    const controller = active ? new AbortController() : null;
    const abort = () => controller?.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = active ? setTimeout(abort, 4000) : null;
    return fetch('/api/notifications/presence', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      ...(controller ? { signal: controller.signal } : {}),
      headers: { 'content-type': 'application/json', 'x-codex-expected-device': session.pair.deviceId },
      body: JSON.stringify({ sessionId: session.id, threadId: threadId(), visible: active }),
    }).then(response => { if (!response.ok) throw new Error('Presence unavailable'); }).finally(() => {
      clearTimeout(timeout); session.controller.signal.removeEventListener('abort', abort);
    });
  }
  async function acknowledge(session, event, scoped, isCurrent) {
    try {
      if (!uuid.test(event.ackId || '') || typeof window.taskNotificationReceipt !== 'function') {
        window.acceptTaskNotification?.(scoped); return;
      }
      // A UI callback alone does not prove the worker can suppress a fallback.
      // Wait for this exact event's durable receipt (or current-reading receipt).
      if (await window.taskNotificationReceipt(scoped) !== true || !isCurrent()) return;
      const controller = new AbortController(), abort = () => controller.abort();
      session.controller.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 4000);
      try {
        await fetch('/api/notifications/ack', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-codex-expected-device': session.pair.deviceId },
          body: JSON.stringify({ sessionId: session.id, ackId: event.ackId, threadId: event.threadId, eventId: event.eventId }),
        });
      } finally { clearTimeout(timeout); session.controller.signal.removeEventListener('abort', abort); }
    } catch { /* No ACK makes the server fall back to system push. */ }
  }
  function stop() {
    clearTimeout(retry); retry = null;
    const session = current; current = null;
    if (!session) return;
    clearTimeout(session.heartbeat); session.controller.abort();
    void presence(session, false, true).catch(() => {});
  }
  function heartbeat(session) {
    clearTimeout(session.heartbeat);
    if (current !== session || !visible() || session.presencePending) return;
    session.threadId = threadId();
    session.presencePending = true;
    void presence(session, true).catch(() => { if (current === session) reconnect(session); }).finally(() => {
      session.presencePending = false;
      if (current === session && visible()) session.heartbeat = setTimeout(() => heartbeat(session), session.threadId === threadId() ? 5000 : 0);
    });
  }
  function reconnect(session) {
    if (current !== session) return;
    stop();
    if (context && eligible && visible()) retry = setTimeout(start, 2000);
  }
  function start() {
    clearTimeout(retry); retry = null;
    if (current || !context || !eligible || !visible()) return;
    const session = current = { id: crypto.randomUUID(), pair: context, controller: new AbortController(), heartbeat: null, connected: false };
    const isCurrent = () => current === session && !session.controller.signal.aborted && visible();
    void (async () => {
      let reader;
      try {
        const params = new URLSearchParams({ sessionId: session.id, threadId: threadId() || '' });
        const response = await fetch('/api/notifications/events?' + params, { credentials: 'same-origin', cache: 'no-store', signal: session.controller.signal, headers: { 'x-codex-expected-device': session.pair.deviceId } });
        if (!isCurrent()) { void response.body?.cancel(); return; }
        if (!response.ok || !response.body) throw new Error('Notification stream unavailable');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = '';
        while (isCurrent()) {
          const { value, done } = await reader.read();
          if (!isCurrent()) return;
          if (done) throw new Error('Notification stream closed');
          pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          if (pending.length > 65536) throw new Error('Oversized notification stream');
          let end;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            let type = '', lines = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
            }
            if (type === 'connected' && !session.connected) {
              session.connected = true; heartbeat(session);
              void Promise.resolve(window.syncClearedTaskNotifications?.()).catch(() => {});
            }
            if (!['task-notification', 'task-notification-clear'].includes(type)) continue;
            let event; try { event = JSON.parse(lines.join('\n')); } catch { continue; }
            if (!uuid.test(event?.threadId || '') || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 512) continue;
            const scoped = { ...event, hostId: session.pair.hostId, deviceId: session.pair.deviceId };
            if (type === 'task-notification-clear') {
              await window.clearTaskNotificationEvent?.(scoped);
              if (!isCurrent()) return;
            } else if (['completed', 'question', 'approval'].includes(event.kind)) void acknowledge(session, event, scoped, isCurrent);
          }
        }
      } catch { if (isCurrent()) reconnect(session); }
      finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock?.(); } }
    })();
  }
  window.setTaskNotificationSession = (pair, enabled) => {
    if (pair && !['hostId', 'deviceId'].every(key => uuid.test(pair[key] || ''))) pair = null;
    const changed = context?.hostId !== pair?.hostId || context?.deviceId !== pair?.deviceId || eligible !== (enabled === true);
    if (changed) stop();
    context = pair; eligible = enabled === true;
    start();
  };
  window.refreshNotificationPresence = () => {
    if (current?.connected && visible()) { if (current.threadId !== threadId()) heartbeat(current); }
    else start();
  };
  document.addEventListener('visibilitychange', () => { if (visible()) start(); else stop(); });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', start);
})();
