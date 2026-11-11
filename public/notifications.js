(() => {
  const panel = document.querySelector('#notification-prompt');
  if (!panel) return;
  const message = document.querySelector('#notification-message');
  const enable = document.querySelector('#notification-enable');
  const disable = document.querySelector('#notification-disable');
  const onboarding = document.querySelector('#notification-onboarding');
  const onboardingMessage = document.querySelector('#notification-onboarding-message');
  const onboardingOpen = document.querySelector('#notification-onboarding-open');
  const onboardingDismiss = document.querySelector('#notification-onboarding-dismiss');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let context = null, contextInitialized = false, generation = 0, refreshRevision = 0, settingsOpen = false, available = false, busy = false, subscription = null, config = null, refreshTimer = null, workerUpdateChecked = false, clearSync = null, contextActivation = Promise.resolve();
  let homeEligible = false, onboardingDismissed = false, onboardingText = null;
  const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
  const iphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function render() {
    panel.hidden = !context || !settingsOpen || !available;
    enable.disabled = disable.disabled = busy;
    if (onboarding) onboarding.hidden = !context || !homeEligible || settingsOpen || !available || onboardingDismissed || !onboardingText;
    if (onboardingMessage) onboardingMessage.textContent = onboardingText || '';
  }
  const current = (pair, epoch) => context?.hostId === pair.hostId && context?.deviceId === pair.deviceId && generation === epoch;
  function queueRefresh() {
    clearTimeout(refreshTimer); refreshTimer = null;
    if (!context || !settingsOpen || !available) return;
    const pair = context, epoch = generation;
    refreshTimer = setTimeout(() => { refreshTimer = null; if (current(pair, epoch) && !busy) void refresh(pair, epoch); else queueRefresh(); }, 15000);
  }
  async function request(pair, path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', ...options.headers, 'x-codex-expected-device': pair.deviceId } });
    if (!response.ok) throw new Error('通知设置未保存，请稍后重试');
    return response.json();
  }
  async function syncCleared(pair, epoch) {
    if (clearSync?.epoch === epoch) return clearSync.pending;
    const sync = { epoch, pending: null };
    clearSync = sync;
    sync.pending = (async () => {
      await contextActivation;
      if (!current(pair, epoch)) return;
      const data = await request(pair, '/api/notifications/cleared');
      if (!current(pair, epoch) || !Array.isArray(data.cleared)) return;
      for (const item of data.cleared.slice(0, 1024)) {
        if (!current(pair, epoch)) return;
        if (!uuid.test(item?.threadId || '') || typeof item.eventId !== 'string' || !item.eventId || item.eventId.length > 512) continue;
        await window.clearTaskNotificationEvent?.({ ...pair, threadId: item.threadId, eventId: item.eventId });
      }
    })().finally(() => { if (clearSync === sync) clearSync = null; });
    return sync.pending;
  }
  window.syncClearedTaskNotifications = () => context ? syncCleared(context, generation).catch(() => {}) : Promise.resolve();
  async function refresh(pair, epoch) {
    const revision = ++refreshRevision;
    const fresh = () => current(pair, epoch) && refreshRevision === revision;
    try {
      const data = await request(pair, '/api/notifications');
      if (!fresh()) return;
      config = data; available = data.enabled === true;
      // Keep the current pair's confirmed controls visible while async checks run.
      if (!available) { enable.hidden = disable.hidden = true; window.setTaskNotificationSession?.(pair, false); return render(); }
      await syncCleared(pair, epoch);
      if (!fresh()) return;
      if (iphone() && !standalone()) {
        enable.hidden = disable.hidden = true;
        onboardingText = '想在后台收到任务提醒？先在 Safari 中添加到主屏幕，再打开并开启通知。';
        message.textContent = '先在 Safari 中添加到主屏幕，再从主屏幕打开并开启通知。'; return render();
      }
      if (!supported()) { enable.hidden = disable.hidden = true; onboardingText = null; message.textContent = '当前浏览器不支持任务通知。'; return render(); }
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (registration?.update && !workerUpdateChecked) {
        workerUpdateChecked = true;
        void registration.update().catch(() => {});
      }
      const local = await registration?.pushManager.getSubscription();
      if (!fresh()) return;
      const status = local ? await request(pair, '/api/notifications/status', { method: 'POST', body: JSON.stringify({ endpoint: local.endpoint }) }) : null;
      if (!fresh()) return;
      subscription = local;
      const registered = Boolean(local && status?.subscribed);
      onboardingText = Notification.permission === 'denied'
        ? '通知已被系统关闭。可在系统设置中允许通知，再回来开启任务提醒。'
        : registered && Notification.permission === 'granted' ? null
        : '开启任务通知，后台也能收到任务完成、待回答和待审批提醒。';
      window.setTaskNotificationSession?.(pair, registered && Notification.permission === 'granted');
      const readiness = status ?? data;
      config = { ...data, ...readiness };
      const active = registered && Notification.permission === 'granted' && readiness.desktopReady === true && readiness.monitorStatus === 'healthy';
      message.textContent = readiness.desktopReady !== true
        ? readiness.monitorStatus === 'offline' ? '电脑上的桌面助手未连接，连接后才能接收任务通知。' : '请更新电脑上的桌面助手后开启任务通知。'
        : registered && readiness.monitorStatus === 'degraded' ? readiness.monitorReason === 'delivery-unavailable' ? '通知已登记，但推送暂时发送失败，请稍后检查通知状态。' : '通知已登记，但后台任务观察暂不可用，请检查电脑上的桌面助手。'
        : registered && readiness.monitorStatus !== 'healthy' ? '通知已登记，正在连接后台任务观察，请稍候。'
        : active ? '已开启：任务完成、待回答、待审批时提醒。电脑和桌面助手需保持运行。'
        : Notification.permission === 'denied' ? '通知已被系统关闭，请在系统设置中允许通知后重试。'
        : '开启后，任务完成、待回答或待审批时会提醒你。电脑和桌面助手需保持运行。';
      enable.hidden = registered || Notification.permission === 'denied' || readiness.desktopReady !== true; disable.hidden = !registered;
      render();
    } catch { if (fresh()) { enable.hidden = disable.hidden = true; onboardingText = null; if (available) message.textContent = '暂时无法查询通知状态，请检查网络后重新打开页面。'; render(); } }
    finally { if (fresh()) queueRefresh(); }
  }
  window.setNotificationContext = pair => {
    if (pair && !['hostId', 'deviceId'].every(key => uuid.test(pair[key] || ''))) pair = null;
    if (contextInitialized && context?.hostId === pair?.hostId && context?.deviceId === pair?.deviceId) return;
    contextInitialized = true; ++refreshRevision;
    clearTimeout(refreshTimer); refreshTimer = null;
    enable.hidden = disable.hidden = true;
    context = pair; window.setTaskNotificationSession?.(pair, false); ++generation; available = false; subscription = null; config = null; busy = false; onboardingDismissed = false; onboardingText = null; render();
    contextActivation = Promise.resolve();
    if (typeof window.taskReminderStore?.activate === 'function') {
      const epoch = generation;
      contextActivation = Promise.resolve().then(() => window.taskReminderStore.activate(pair)).then(() => true, () => false);
      void contextActivation.then(activated => {
        if (activated && pair && current(pair, epoch)) return syncCleared(pair, epoch).catch(() => {}).then(() => {
          if (current(pair, epoch)) return window.restoreTaskReminders?.();
        });
      }).catch(() => {});
    }
    if (pair) void refresh(pair, generation);
  };
  window.setNotificationHomeEligible = value => { homeEligible = value === true; render(); };
  onboardingOpen?.addEventListener('click', () => window.openNotificationSettings?.());
  onboardingDismiss?.addEventListener('click', () => { onboardingDismissed = true; render(); });
  window.setNotificationSettingsOpen = value => {
    settingsOpen = value === true; render();
    if (settingsOpen && context && !busy) void refresh(context, generation);
    else { clearTimeout(refreshTimer); refreshTimer = null; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && context) void window.syncClearedTaskNotifications();
  });
  enable.addEventListener('click', async () => {
    if (!context || busy || !available || config?.desktopReady !== true || !supported()) return;
    const pair = context, epoch = generation;
    ++refreshRevision; clearTimeout(refreshTimer); refreshTimer = null;
    busy = true; render();
    try {
      // Request permission directly in the user's click, before async setup.
      const permission = await Notification.requestPermission();
      if (!current(pair, epoch)) return;
      if (permission !== 'granted') { message.textContent = '尚未开启通知。你可以稍后再开启。'; return; }
      const registration = await navigator.serviceWorker.register('/notification-worker.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      if (!current(pair, epoch)) return;
      const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const local = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (!current(pair, epoch)) return;
      subscription = local;
      await request(pair, '/api/notifications', { method: 'POST', body: JSON.stringify({ subscription: local.toJSON() }) });
      if (current(pair, epoch)) await refresh(pair, epoch);
    } catch { if (current(pair, epoch)) message.textContent = '开启失败，请检查网络和通知权限后重试。'; }
    finally { if (current(pair, epoch)) { busy = false; render(); queueRefresh(); } }
  });
  disable.addEventListener('click', async () => {
    if (!context || !subscription || busy) return;
    const pair = context, epoch = generation, endpoint = subscription.endpoint;
    ++refreshRevision; clearTimeout(refreshTimer); refreshTimer = null;
    busy = true; render();
    try {
      // Remove only this computer pairing. A shared browser subscription may
      // still be used for notifications from another paired computer.
      await request(pair, '/api/notifications', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
      if (current(pair, epoch)) await refresh(pair, epoch);
    } catch { if (current(pair, epoch)) message.textContent = '关闭失败，请稍后重试。'; }
    finally { if (current(pair, epoch)) { busy = false; render(); queueRefresh(); } }
  });
  let target = null;
  function acceptTarget(data) {
    if (!data || !['hostId', 'deviceId', 'threadId'].every(key => uuid.test(data[key] || ''))) return;
    target = { hostId: data.hostId, deviceId: data.deviceId, threadId: data.threadId };
    if (window.openNotificationTask?.(target)) target = null;
  }
  window.takeNotificationTarget = pair => {
    if (!target || !pair) return null;
    const result = target; target = null;
    return result.hostId === pair.hostId && result.deviceId === pair.deviceId ? result : null;
  };
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'open-notification-task') acceptTarget(event.data);
  });
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (hash.has('notificationThread')) {
    acceptTarget({ hostId: hash.get('notificationHost'), deviceId: hash.get('notificationDevice'), threadId: hash.get('notificationThread') });
    history.replaceState(null, '', location.pathname + location.search);
  }
})();
