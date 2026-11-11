/* No page caching: pairing, requests and chat content always come from the server. */
importScripts('/task-reminder-store.js');
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const titles = { completed: '任务已完成', question: '任务需要回答', approval: '任务等待审批' };
    if (!data || !Object.hasOwn(titles, data.kind) || !['hostId', 'deviceId', 'threadId'].every(key => uuid.test(data[key] || ''))) return;
    if (!await self.taskReminderStore.isActive(data).catch(() => false)) return;
    const reminder = { threadId: data.threadId, kind: data.kind,
      eventId: typeof data.eventId === 'string' ? data.eventId : data.tag };
    if (await self.taskReminderStore.hasEvent(data, reminder).catch(() => false)) return;
    await self.registration.showNotification(titles[data.kind], {
      body: '打开手机助手查看任务。', icon: '/app-icon-20261106.png',
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 100) : undefined,
      data: { hostId: data.hostId, deviceId: data.deviceId, threadId: data.threadId },
    });
    await self.taskReminderStore.put(data, reminder).catch(() => {});
  })());
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
