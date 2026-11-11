/* No page caching: pairing, requests and chat content always come from the server. */
importScripts('/task-reminder-store.js');
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
let notificationWork = Promise.resolve();
async function closeDisplayedNotification(data, eventId, tag) {
  try {
    const notifications = await self.registration.getNotifications?.(tag ? { tag } : {}) || [];
    for (const notification of notifications) {
      const target = notification.data;
      if (target?.hostId === data.hostId && target.deviceId === data.deviceId && target.threadId === data.threadId && target.eventId === eventId) notification.close();
    }
  } catch { /* A stale display must not prevent the badge from converging. */ }
}
self.addEventListener('push', event => {
  // A repeated push can arrive while showNotification is still pending. Keep
  // one display/receipt sequence in flight so it cannot show the same event twice.
  const work = notificationWork.then(async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const titles = { completed: '任务已完成', question: '任务需要回答', approval: '任务等待审批' };
    if (!data || !Object.hasOwn(titles, data.kind) || !['hostId', 'deviceId', 'threadId'].every(key => uuid.test(data[key] || ''))) return;
    if (!await self.taskReminderStore.isActive(data).catch(() => false)) return;
    const reminder = { threadId: data.threadId, kind: data.kind,
      eventId: typeof data.eventId === 'string' ? data.eventId : data.tag,
      ...(Number.isSafeInteger(data.createdAt) && data.createdAt >= 0 ? { createdAt: data.createdAt } : {}) };
    if (typeof reminder.eventId !== 'string' || !reminder.eventId || reminder.eventId.length > 512) return;
    const inspection = await (self.taskReminderStore.inspectEvent
      ? self.taskReminderStore.inspectEvent(data, reminder)
      : self.taskReminderStore.hasEvent(data, reminder).then(seen => ({ status: seen ? 'seen' : 'new' }))).catch(() => ({ status: 'new' }));
    if (inspection.status !== 'new') {
      // An old receipt may predate timestamp support. Learn its verified time
      // without restoring its row, then reject later out-of-order events too.
      if (inspection.status !== 'inactive') await self.taskReminderStore.put(data, reminder).catch(() => {});
      return;
    }
    // The pairing may have changed while IndexedDB was checking the receipt.
    if (!await self.taskReminderStore.isActive(data).catch(() => false)) return;
    const tag = typeof data.tag === 'string' ? data.tag.slice(0, 100) : undefined;
    await self.registration.showNotification(titles[data.kind], {
      body: '打开手机助手查看任务。', icon: '/app-icon-20261106.png',
      tag,
      data: { hostId: data.hostId, deviceId: data.deviceId, threadId: data.threadId, eventId: reminder.eventId },
    });
    const saved = await self.taskReminderStore.put(data, reminder).catch(() => null);
    // Viewing the task or revoking its pairing may race the OS display call.
    // The transactional receipt decides whether that delayed display survives.
    if (saved?.duplicate || saved?.ignored || saved?.stale || !await self.taskReminderStore.isActive(data).catch(() => false)) await closeDisplayedNotification(data, reminder.eventId, tag);
  });
  notificationWork = work.catch(() => {});
  event.waitUntil(work);
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (!data) return;
    const url = new URL('/', self.location.origin);
    url.hash = new URLSearchParams({ notificationHost: data.hostId, notificationDevice: data.deviceId, notificationThread: data.threadId }).toString();
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find(client => { const current = new URL(client.url); return current.origin === url.origin && current.pathname === '/'; });
    if (page) {
      // Preserve the current draft and connection. The page checks the pair
      // identity and opens only a task from its current authoritative list.
      page.postMessage({ type: 'open-notification-task', ...data });
      await page.focus();
    } else await self.clients.openWindow(url.href);
  })());
});
