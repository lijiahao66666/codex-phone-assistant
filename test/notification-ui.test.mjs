import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const pairA = { hostId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' };
const pairB = { hostId: '33333333-3333-4333-8333-333333333333', deviceId: '44444444-4444-4444-8444-444444444444' };
const threadId = '55555555-5555-4555-8555-555555555555';
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await tick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = value => ({ ok: true, json: async () => value });
const makeSubscription = endpoint => ({ endpoint, toJSON() { return { endpoint, keys: { auth: 'auth', p256dh: 'key' } }; }, unsubscribe() { throw new Error('must not remove other computer subscriptions'); } });

async function fixture(options = {}) {
  const nodes = new Map(['prompt', 'message', 'enable', 'disable', 'onboarding', 'onboarding-message', 'onboarding-open', 'onboarding-dismiss'].map(name => [name, { hidden: true, disabled: false, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }]));
  const requests = [], actions = [], serviceWorkerListeners = {}, documentListeners = {}, historyCalls = [], timers = new Map(); let nextTimer = 0;
  let local = options.local ?? null, subscribed = options.subscribed ?? false;
  const notification = { permission: options.permission ?? 'default', requestPermission() { actions.push('permission'); return options.requestPermission?.() ?? Promise.resolve('granted'); } };
  const registration = { pushManager: {
    getSubscription: async () => options.getSubscription ? options.getSubscription(local) : local,
    subscribe: async settings => { actions.push({ subscribe: settings }); return options.subscribe ? options.subscribe(settings) : (local = makeSubscription('https://push.example/new')); },
  } };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    getRegistration: async () => registration,
    register: async (...args) => { actions.push({ register: args }); return registration; },
    addEventListener(type, fn) { serviceWorkerListeners[type] = fn; },
  };
  const location = { hash: options.hash ?? '', pathname: '/', search: '' };
  const window = { Notification: notification, PushManager: function () {}, location, matchMedia: () => ({ matches: options.standalone === true }) };
  const context = vm.createContext({
    window, Notification: notification, navigator: { serviceWorker, userAgent: options.iphone ? 'iPhone' : 'Desktop', platform: '', standalone: options.standalone === true },
    document: { visibilityState: 'visible', addEventListener(type, fn) { documentListeners[type] = fn; }, querySelector: selector => nodes.get(selector.replace('#notification-', '')) },
    location, history: { replaceState(...args) { historyCalls.push(args); } }, URLSearchParams, Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    fetch: async (url, request = {}) => {
      requests.push({ url, ...request });
      const override = options.fetch?.(url, request);
      if (override !== undefined) return override;
      if (url.endsWith('/status')) return json({ subscribed, desktopReady: true, monitorStatus: 'healthy' });
      if (request.method === 'POST') { subscribed = true; return json({ ok: true }); }
      if (request.method === 'DELETE') { subscribed = false; return json({ ok: true }); }
      return json({ enabled: true, publicKey: 'AQ', desktopReady: true, monitorStatus: 'healthy' });
    },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(await readFile(new URL('../public/notifications.js', import.meta.url), 'utf8'), context);
  window.setNotificationSettingsOpen(true);
  return { nodes, window, requests, actions, notification, historyCalls, timers, documentListeners,
    async refresh() { const [id, timer] = [...timers][0] ?? []; assert.ok(timer, 'a home notification status refresh is scheduled'); timers.delete(id); timer.fn(); await flush(); },
    setLocal(value) { local = value; },
    async select(pair = pairA) { window.setNotificationContext(pair); await flush(); },
    click(name) { return nodes.get(name).listeners.click(); },
    message(data) { serviceWorkerListeners.message({ data }); },
  };
}

test('notification permission is requested only in the enable gesture and before async service worker setup', async () => {
  const permission = deferred();
  const f = await fixture({ requestPermission: () => permission.promise });
  await f.select();
  assert.deepEqual(f.actions, []);
  assert.equal(f.nodes.get('prompt').hidden, false);
  assert.equal(f.nodes.get('enable').hidden, false);
  const click = f.click('enable');
  assert.deepEqual(f.actions, ['permission']);
  assert.equal(f.nodes.get('enable').disabled, true);
  f.notification.permission = 'granted'; permission.resolve('granted'); await click;
  assert.ok(f.actions[1].register);
  const save = f.requests.find(request => request.method === 'POST' && request.url === '/api/notifications');
  assert.equal(save.headers['x-codex-expected-device'], pairA.deviceId);
  assert.equal(save.credentials, 'same-origin'); assert.equal(save.cache, 'no-store');
  assert.match(f.nodes.get('message').textContent, /已开启/);
});

test('a confirmed unsubscribed pairing gets a home-only notification introduction that opens settings without requesting permission', async () => {
  const f = await fixture(); let opens = 0;
  f.window.openNotificationSettings = () => { opens++; f.window.setNotificationSettingsOpen(true); };
  f.window.setNotificationSettingsOpen(false); f.window.setNotificationHomeEligible(true);
  assert.equal(f.nodes.get('onboarding').hidden, true, 'no paired status has been confirmed');
  await f.select();
  assert.equal(f.nodes.get('onboarding').hidden, false);
  assert.match(f.nodes.get('onboarding-message').textContent, /后台.*任务完成.*待回答.*待审批/);
  assert.deepEqual(f.actions, []);
  f.window.setNotificationHomeEligible(false); assert.equal(f.nodes.get('onboarding').hidden, true);
  f.window.setNotificationHomeEligible(true); assert.equal(f.nodes.get('onboarding').hidden, false);
  f.click('onboarding-open');
  assert.equal(opens, 1); assert.equal(f.nodes.get('onboarding').hidden, true);
  assert.deepEqual(f.actions, [], 'opening the settings must not request notification permission');
});

test('home onboarding dismissal lasts for the current pairing and page but resets for another pairing', async () => {
  const f = await fixture(); f.window.setNotificationSettingsOpen(false); f.window.setNotificationHomeEligible(true);
  await f.select(); f.click('onboarding-dismiss');
  assert.equal(f.nodes.get('onboarding').hidden, true);
  f.window.setNotificationHomeEligible(false); f.window.setNotificationHomeEligible(true); await f.select();
  assert.equal(f.nodes.get('onboarding').hidden, true);
  f.window.setNotificationSettingsOpen(true); await flush(); f.window.setNotificationSettingsOpen(false);
  assert.equal(f.nodes.get('onboarding').hidden, true);
  await f.select(pairB); assert.equal(f.nodes.get('onboarding').hidden, false);
  await f.select(null); assert.equal(f.nodes.get('onboarding').hidden, true);
});

test('onboarding distinguishes iPhone installation and denied permissions and disappears after a successful enable', async () => {
  for (const options of [{ iphone: true }, { permission: 'denied' }]) {
    const f = await fixture(options); f.window.setNotificationSettingsOpen(false); f.window.setNotificationHomeEligible(true); await f.select();
    assert.equal(f.nodes.get('onboarding').hidden, false);
    assert.match(f.nodes.get('onboarding-message').textContent, options.iphone ? /添加到主屏幕/ : /系统设置.*允许通知/);
    assert.deepEqual(f.actions, []);
  }
  const enabled = await fixture({ local: makeSubscription('https://push.example/already-enabled'), permission: 'granted', subscribed: true });
  enabled.window.setNotificationSettingsOpen(false); enabled.window.setNotificationHomeEligible(true); await enabled.select();
  assert.equal(enabled.nodes.get('onboarding').hidden, true);
  const fresh = await fixture({ requestPermission() { fresh.notification.permission = 'granted'; return Promise.resolve('granted'); } });
  fresh.window.setNotificationSettingsOpen(false); fresh.window.setNotificationHomeEligible(true); await fresh.select();
  assert.equal(fresh.nodes.get('onboarding').hidden, false);
  await fresh.click('enable');
  assert.equal(fresh.nodes.get('onboarding').hidden, true);
});

test('onboarding does not infer unsubscribed status when its server query fails or an old pairing response arrives late', async () => {
  const unknown = deferred();
  const f = await fixture({ local: makeSubscription('https://push.example/unknown'), permission: 'granted', fetch: url => url.endsWith('/status') ? unknown.promise : undefined });
  f.window.setNotificationSettingsOpen(false); f.window.setNotificationHomeEligible(true); await f.select();
  assert.equal(f.nodes.get('onboarding').hidden, true);
  unknown.resolve({ ok: false }); await flush(); assert.equal(f.nodes.get('onboarding').hidden, true);
  const stale = deferred(); let requests = 0;
  const switched = await fixture({ fetch: url => url === '/api/notifications' && ++requests === 1 ? stale.promise : undefined });
  switched.window.setNotificationSettingsOpen(false); switched.window.setNotificationHomeEligible(true);
  await switched.select(); await switched.select(pairB); switched.click('onboarding-dismiss');
  stale.resolve(json({ enabled: true, desktopReady: true, monitorStatus: 'healthy' })); await flush();
  assert.equal(switched.nodes.get('onboarding').hidden, true, 'late response cannot reset current-pair dismissal');
});

test('iPhone browser explains home screen installation without prompting; standalone can opt in', async () => {
  const browser = await fixture({ iphone: true }); await browser.select();
  assert.match(browser.nodes.get('message').textContent, /添加到主屏幕/);
  assert.equal(browser.nodes.get('enable').hidden, true);
  assert.deepEqual(browser.actions, []);
  const installed = await fixture({ iphone: true, standalone: true }); await installed.select();
  assert.equal(installed.nodes.get('enable').hidden, false);
  assert.deepEqual(installed.actions, []);
});

test('denied permission and server-unregistered local subscriptions are never shown as enabled', async () => {
  for (const permission of ['default', 'denied', 'granted']) {
    const f = await fixture({ local: makeSubscription('https://push.example/local'), permission, subscribed: false }); await f.select();
    assert.doesNotMatch(f.nodes.get('message').textContent, /^已开启/);
    assert.equal(f.nodes.get('disable').hidden, true);
    assert.equal(f.nodes.get('enable').hidden, permission === 'denied');
  }
});

test('legacy or offline desktop prevents new permission requests while a saved subscription can still be removed', async () => {
  for (const monitorStatus of ['unsupported', 'offline']) {
    const readiness = { desktopReady: false, monitorStatus };
    const f = await fixture({ fetch: (url, request) => !request.method ? json({ enabled: true, publicKey: 'AQ', ...readiness }) : undefined });
    await f.select(); assert.equal(f.nodes.get('enable').hidden, true);
    assert.match(f.nodes.get('message').textContent, monitorStatus === 'offline' ? /未连接/ : /更新/);
    await f.click('enable'); assert.deepEqual(f.actions, []);
    const stored = await fixture({ local: makeSubscription('https://push.example/legacy'), permission: 'granted', subscribed: true,
      fetch: (url, request) => !request.method ? json({ enabled: true, publicKey: 'AQ', ...readiness }) : url.endsWith('/status') ? json({ subscribed: true, ...readiness }) : undefined });
    await stored.select(); assert.equal(stored.nodes.get('disable').hidden, false); assert.equal(stored.nodes.get('enable').hidden, true);
    assert.doesNotMatch(stored.nodes.get('message').textContent, /^已开启/);
    await stored.click('disable'); assert.ok(stored.requests.some(request => request.method === 'DELETE'));
  }
});

test('subscription existence alone never claims enabled while the desktop monitor is starting or degraded', async () => {
  for (const monitorStatus of ['starting', 'degraded']) {
    const f = await fixture({ local: makeSubscription('https://push.example/registered'), permission: 'granted', subscribed: true,
      fetch: url => url.endsWith('/status') ? json({ subscribed: true, desktopReady: true, monitorStatus, monitorReason: 'observe-unavailable' }) : undefined });
    await f.select(); assert.doesNotMatch(f.nodes.get('message').textContent, /^已开启/);
    assert.match(f.nodes.get('message').textContent, monitorStatus === 'starting' ? /正在连接/ : /暂不可用/);
    assert.equal(f.nodes.get('disable').hidden, false); assert.equal(f.nodes.get('enable').hidden, true);
  }
});

test('settings health polling shows genuine monitor recovery and stops when settings close or pairing clears', async () => {
  let monitorStatus = 'starting';
  const f = await fixture({ local: makeSubscription('https://push.example/registered'), permission: 'granted', subscribed: true,
    fetch: url => url.endsWith('/status') ? json({ subscribed: true, desktopReady: true, monitorStatus }) : undefined });
  await f.select(); assert.match(f.nodes.get('message').textContent, /正在连接/); assert.equal(f.timers.size, 1);
  monitorStatus = 'healthy'; await f.refresh(); assert.match(f.nodes.get('message').textContent, /^已开启/);
  monitorStatus = 'degraded'; await f.refresh(); assert.match(f.nodes.get('message').textContent, /暂不可用/);
  f.window.setNotificationSettingsOpen(false); assert.equal(f.timers.size, 0); assert.equal(f.nodes.get('prompt').hidden, true);
  f.window.setNotificationSettingsOpen(true); await flush(); assert.equal(f.timers.size, 1);
  await f.select(null); assert.equal(f.timers.size, 0); assert.equal(f.nodes.get('prompt').hidden, true);
});

test('reopening settings and health polling retain confirmed buttons while subscription lookup is pending', async () => {
  for (const subscribed of [false, true]) {
    let lookup = null;
    const f = await fixture({ local: subscribed ? makeSubscription('https://push.example/registered') : null,
      permission: subscribed ? 'granted' : 'default', subscribed,
      getSubscription: local => lookup ? lookup.promise : local });
    await f.select();
    const assertButtons = () => {
      assert.equal(f.nodes.get('enable').hidden, subscribed);
      assert.equal(f.nodes.get('disable').hidden, !subscribed);
    };
    assertButtons();
    f.window.setNotificationSettingsOpen(false);
    lookup = deferred();
    f.window.setNotificationSettingsOpen(true); await flush();
    assertButtons();
    lookup.resolve(subscribed ? makeSubscription('https://push.example/registered') : null); await flush();
    assertButtons();
    lookup = deferred(); await f.refresh();
    assertButtons();
    lookup.resolve(subscribed ? makeSubscription('https://push.example/registered') : null); await flush();
    assertButtons();
  }
});

test('a new pairing does not inherit notification buttons before its status is known', async () => {
  const next = deferred();
  const f = await fixture({ fetch: (url, request) => url === '/api/notifications' && request.headers['x-codex-expected-device'] === pairB.deviceId ? next.promise : undefined });
  await f.select(); assert.equal(f.nodes.get('enable').hidden, false);
  await f.select(pairB);
  assert.equal(f.nodes.get('enable').hidden, true);
  assert.equal(f.nodes.get('disable').hidden, true);
  next.resolve(json({ enabled: true, publicKey: 'AQ', desktopReady: true, monitorStatus: 'healthy' })); await flush();
  assert.equal(f.nodes.get('enable').hidden, false);
});

test('failed registration save does not claim enabled, and a failed removal does not claim disabled', async () => {
  const enable = await fixture({ fetch: (url, request) => url === '/api/notifications' && request.method === 'POST' ? { ok: false } : undefined });
  await enable.select(); await enable.click('enable');
  assert.match(enable.nodes.get('message').textContent, /开启失败/);
  assert.equal(enable.nodes.get('disable').hidden, true);
  assert.equal(enable.nodes.get('enable').disabled, false);
  assert.equal(enable.timers.size, 1, 'failed setup keeps health polling alive');
  const disable = await fixture({ local: makeSubscription('https://push.example/active'), permission: 'granted', subscribed: true, fetch: (url, request) => request.method === 'DELETE' ? { ok: false } : undefined });
  await disable.select(); await disable.click('disable');
  assert.match(disable.nodes.get('message').textContent, /关闭失败/);
  assert.equal(disable.nodes.get('disable').hidden, false);
  assert.equal(disable.timers.size, 1, 'failed removal keeps health polling alive');
});

test('an older same-pair status response cannot undo a completed subscription change', async () => {
  for (const initiallySubscribed of [true, false]) {
    const old = deferred(); let statusCalls = 0;
    const sessions = [];
    const f = await fixture({ local: makeSubscription('https://push.example/shared'), permission: 'granted', subscribed: initiallySubscribed,
      fetch: url => url.endsWith('/status') && ++statusCalls === 2 ? old.promise : undefined });
    f.window.setTaskNotificationSession = (pair, enabled) => sessions.push({ pair, enabled });
    await f.select();
    f.window.setNotificationSettingsOpen(true); await flush();
    assert.equal(statusCalls, 2);
    await f.click(initiallySubscribed ? 'disable' : 'enable');
    assert.equal(statusCalls, 3);
    const expected = !initiallySubscribed;
    assert.equal(f.nodes.get('disable').hidden, !expected);
    assert.equal(sessions.at(-1).enabled, expected);
    old.resolve(json({ subscribed: initiallySubscribed, desktopReady: true, monitorStatus: 'healthy' })); await flush();
    assert.equal(f.nodes.get('disable').hidden, !expected);
    assert.equal(f.nodes.get('enable').hidden, expected);
    assert.equal(sessions.at(-1).enabled, expected, 'stale read must not restart or stop foreground delivery');
    assert.equal(f.timers.size, 1);
  }
});

test('first empty notification context clears the persisted active pair exactly once', async () => {
  const f = await fixture(); const activated = [], sessions = [];
  f.window.taskReminderStore = { activate(pair) { activated.push(pair); } };
  f.window.setTaskNotificationSession = (pair, enabled) => sessions.push({ pair, enabled });
  f.window.restoreTaskReminders = () => { throw new Error('empty context must not restore reminders'); };
  await f.select(null); await f.select(null);
  assert.deepEqual(activated, [null]);
  assert.deepEqual(sessions, [{ pair: null, enabled: false }]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test('reminder activation tolerates missing, synchronous and rejected implementations and restores only the current pair', async () => {
  for (const [activate, expectedRestores] of [[undefined, 0], [() => {}, 1], [() => { throw new Error('storage unavailable'); }, 0], [() => Promise.reject(new Error('storage unavailable')), 0]]) {
    const f = await fixture(); let restored = 0;
    f.window.taskReminderStore = { activate };
    f.window.restoreTaskReminders = () => { restored++; };
    await f.select();
    assert.equal(f.nodes.get('enable').hidden, false);
    assert.equal(restored, expectedRestores);
  }
  const first = deferred(), activated = []; let restored = 0;
  const f = await fixture();
  f.window.taskReminderStore = { activate(pair) { activated.push(pair); return pair === pairA ? first.promise : undefined; } };
  f.window.restoreTaskReminders = () => { restored++; };
  await f.select(); await f.select(pairB);
  assert.equal(restored, 1);
  first.resolve(); await flush();
  assert.equal(restored, 1, 'late activation must not restore a previous pairing');
  assert.deepEqual(activated, [pairA, pairB]);
});

test('desktop clear catchup waits for local pair activation and completes before reminder hydration', async () => {
  const activation = deferred(), order = [];
  const f = await fixture({ fetch: url => url.endsWith('/cleared') ? json({ cleared: [{ threadId, eventId: 'already-handled' }, { threadId: 'bad', eventId: 'invalid' }] }) : undefined });
  f.window.taskReminderStore = { activate: () => activation.promise };
  f.window.clearTaskNotificationEvent = async event => { order.push({ clear: event }); };
  f.window.restoreTaskReminders = () => { order.push('restore'); };
  await f.select(); assert.equal(f.requests.some(request => request.url.endsWith('/cleared')), false);
  activation.resolve(); await flush();
  assert.equal(order.length, 2); assert.equal(order[0].clear.eventId, 'already-handled');
  assert.equal(order[0].clear.deviceId, pairA.deviceId); assert.equal(order[1], 'restore');
  assert.equal(f.requests.find(request => request.url.endsWith('/cleared')).headers['x-codex-expected-device'], pairA.deviceId);
});

test('late desktop clear catchup cannot clear the next pairing and foreground resume queries again', async () => {
  const old = deferred(), cleared = []; let reads = 0;
  const f = await fixture({ fetch: (url, request) => {
    if (!url.endsWith('/cleared')) return undefined;
    reads++;
    return request.headers['x-codex-expected-device'] === pairA.deviceId ? old.promise : json({ cleared: [{ threadId, eventId: 'current-only' }] });
  } });
  f.window.clearTaskNotificationEvent = async event => { cleared.push(event); };
  await f.select(pairA); await f.select(pairB);
  old.resolve(json({ cleared: [{ threadId, eventId: 'old-pair' }] })); await flush();
  assert.deepEqual(cleared.map(item => item.eventId), ['current-only']);
  assert.equal(cleared[0].deviceId, pairB.deviceId);
  f.documentListeners.visibilitychange(); await flush();
  assert.equal(reads, 3); assert.equal(cleared.at(-1).eventId, 'current-only');
});

test('disabling removes only the current paired computer registration and preserves the browser subscription', async () => {
  const local = makeSubscription('https://push.example/shared');
  const f = await fixture({ local, permission: 'granted', subscribed: true }); await f.select(pairB);
  assert.equal(f.nodes.get('disable').hidden, false);
  await f.click('disable');
  const remove = f.requests.find(request => request.method === 'DELETE');
  assert.equal(remove.headers['x-codex-expected-device'], pairB.deviceId);
  assert.deepEqual(JSON.parse(remove.body), { endpoint: local.endpoint });
  assert.equal(f.nodes.get('disable').hidden, true);
  assert.equal(f.nodes.get('enable').hidden, false);
});

test('late config from a previous pairing cannot overwrite the current notification UI', async () => {
  const old = deferred();
  const f = await fixture({ fetch: (url, request) => !request.method && request.headers['x-codex-expected-device'] === pairA.deviceId ? old.promise : undefined });
  f.window.setNotificationContext(pairA); await f.select(pairB);
  old.resolve(json({ enabled: false })); await flush();
  assert.equal(f.nodes.get('prompt').hidden, false);
  assert.equal(f.nodes.get('enable').hidden, false);
});

test('status query failure stays visible without claiming an enabled or disabled subscription', async () => {
  const f = await fixture({ local: makeSubscription('https://push.example/active'), permission: 'granted', fetch: url => url.endsWith('/status') ? { ok: false } : undefined });
  await f.select();
  assert.equal(f.nodes.get('prompt').hidden, false);
  assert.match(f.nodes.get('message').textContent, /无法查询通知状态/);
  assert.equal(f.nodes.get('enable').hidden, true);
  assert.equal(f.nodes.get('disable').hidden, true);
});

test('local subscription lookup finishing after a pair switch cannot issue an old pair status request', async () => {
  const old = deferred(); let calls = 0;
  const f = await fixture({ getSubscription: local => ++calls === 1 ? old.promise : local });
  await f.select(); await f.select(pairB);
  old.resolve(makeSubscription('https://push.example/previous')); await flush();
  assert.equal(f.requests.some(request => request.url.endsWith('/status') && request.headers['x-codex-expected-device'] === pairA.deviceId), false);
  assert.equal(f.nodes.get('enable').hidden, false);
});

test('switching pairs while permission is pending cannot register or save the previous pair', async () => {
  const permission = deferred();
  const f = await fixture({ requestPermission: () => permission.promise }); await f.select();
  const click = f.click('enable'); await f.select(pairB); permission.resolve('granted'); await click;
  assert.equal(f.actions.some(action => action.register), false);
  assert.equal(f.requests.some(request => request.method === 'POST' && request.url === '/api/notifications'), false);
  assert.equal(f.nodes.get('enable').disabled, false);
});

test('late subscription from the previous pair cannot overwrite the current pair removal endpoint', async () => {
  const old = deferred();
  const f = await fixture({ permission: 'granted', subscribed: true, subscribe: () => old.promise }); await f.select();
  const click = f.click('enable'); await flush();
  const current = makeSubscription('https://push.example/current'); f.setLocal(current); await f.select(pairB);
  assert.equal(f.nodes.get('disable').hidden, false);
  old.resolve(makeSubscription('https://push.example/previous')); await click;
  assert.equal(f.requests.some(request => request.method === 'POST' && request.url === '/api/notifications'), false);
  await f.click('disable');
  assert.equal(JSON.parse(f.requests.find(request => request.method === 'DELETE').body).endpoint, current.endpoint);
});

test('notification links are validated, stripped from browser history, and scoped to the exact pair', async () => {
  const f = await fixture({ hash: '#' + new URLSearchParams({ notificationHost: pairA.hostId, notificationDevice: pairA.deviceId, notificationThread: threadId }) });
  assert.equal(f.historyCalls.length, 1); assert.equal(f.historyCalls[0][2], '/');
  assert.equal(f.window.takeNotificationTarget(pairB), null);
  assert.equal(f.window.takeNotificationTarget(pairA), null, 'a rejected target must not reopen after a later device switch');
  f.message({ type: 'open-notification-task', ...pairA, threadId: '../private' });
  assert.equal(f.window.takeNotificationTarget(pairA), null);
  f.message({ type: 'open-notification-task', ...pairA, threadId });
  assert.deepEqual(JSON.parse(JSON.stringify(f.window.takeNotificationTarget(pairA))), { ...pairA, threadId });
});

test('desktop notification navigation requires the current exact pair, a listed task, and no unfinished new draft', async () => {
  const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  const start = source.indexOf('window.openNotificationTask = target => {');
  const end = source.indexOf('\nasync function fetchThreadList()', start);
  assert.ok(start > 0 && end > start);
  let clicked = 0;
  const context = vm.createContext({ window: {}, historyScope: pairA, newDraft: false, projectStatusGroups: new Map(),
    projectList: { querySelectorAll: () => [{ dataset: { id: threadId }, click() { clicked++; } }] },
  });
  vm.runInContext(source.slice(start, end), context);
  const target = { ...pairA, threadId };
  for (const invalid of [{ ...target, ...pairB }, { ...target, deviceId: pairB.deviceId }, { ...target, threadId: pairB.hostId }, null]) assert.equal(context.window.openNotificationTask(invalid), false);
  vm.runInContext('newDraft = true', context);
  assert.equal(context.window.openNotificationTask(target), false);
  assert.equal(clicked, 0);
  vm.runInContext('newDraft = false', context);
  assert.equal(context.window.openNotificationTask(target), true);
  assert.equal(clicked, 1);
});

async function workerFixture(pages = []) {
  const listeners = {}, shown = [], opened = [], reminders = [];
  const self = { location: { origin: 'https://assistant.example' }, async skipWaiting() {}, registration: { async showNotification(...args) { shown.push(args); } },
    taskReminderStore: { async isActive() { return true; }, async hasEvent(pair, event) {
      return reminders.some(item => item.pair.hostId === pair.hostId && item.pair.deviceId === pair.deviceId && item.event.threadId === event.threadId && item.event.eventId === event.eventId);
    }, async put(pair, event) { if (await this.hasEvent(pair, event)) return { duplicate: true }; reminders.push({ pair, event }); return { stored: true }; } },
    clients: { async claim() {}, async matchAll() { return pages; }, async openWindow(url) { opened.push(url); } },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  vm.runInNewContext(await readFile(new URL('../public/notification-worker.js', import.meta.url), 'utf8'), { self, URL, URLSearchParams,
    importScripts(path) { assert.equal(path, '/task-reminder-store.js'); },
  });
  return { listeners, shown, opened, reminders, store: self.taskReminderStore, registration: self.registration,
    async dispatch(type, data) { let completion; listeners[type]({ data: { json: () => data }, notification: { data, close() {} }, waitUntil(promise) { completion = promise; } }); await completion; },
  };
}

test('push worker accepts only scoped known events, emits generic content, and never caches chat pages', async () => {
  const f = await workerFixture();
  assert.deepEqual(Object.keys(f.listeners).sort(), ['activate', 'install', 'notificationclick', 'push']);
  for (const payload of [null, { ...pairA, threadId, kind: 'private-chat' }, { ...pairA, threadId: 'invalid', kind: 'completed' }]) await f.dispatch('push', payload);
  assert.equal(f.shown.length, 0);
  for (const kind of ['completed', 'question', 'approval']) await f.dispatch('push', { ...pairA, threadId, kind, eventId: kind, title: 'PRIVATE TITLE', body: 'PRIVATE CHAT', tag: 'x'.repeat(200) });
  assert.equal(f.shown.length, 3);
  for (const [title, settings] of f.shown) {
    assert.doesNotMatch(JSON.stringify([title, settings]), /PRIVATE/);
    assert.equal(settings.tag.length, 100);
    assert.deepEqual(JSON.parse(JSON.stringify(settings.data)), { ...pairA, threadId, eventId: settings.data.eventId });
    assert.ok(['completed', 'question', 'approval'].includes(settings.data.eventId));
  }
});

test('push worker ignores a replaced pair and persists reminders only after notification display succeeds', async () => {
  const f = await workerFixture();
  await f.dispatch('install'); await f.dispatch('activate');
  f.store.isActive = async pair => pair.hostId === pairA.hostId && pair.deviceId === pairA.deviceId;
  await f.dispatch('push', { ...pairB, threadId, kind: 'completed', eventId: 'old-pair' });
  assert.equal(f.shown.length, 0); assert.equal(f.reminders.length, 0);
  f.registration.showNotification = async () => { throw new Error('display failed'); };
  await assert.rejects(f.dispatch('push', { ...pairA, threadId, kind: 'question', eventId: 'failed-display' }), /display failed/);
  assert.equal(f.reminders.length, 0);
  f.registration.showNotification = async () => { assert.equal(f.reminders.length, 0); };
  await f.dispatch('push', { ...pairA, threadId, kind: 'question', eventId: 'actual-event' });
  assert.equal(f.reminders.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.reminders[0].event)), { threadId, kind: 'question', eventId: 'actual-event' });
});

test('notification click reuses only the actual H5 page and otherwise opens a scoped task URL', async () => {
  const messages = [];
  const unrelated = { url: 'https://assistant.example/download/', postMessage: data => messages.push(data), async focus() { throw new Error('must not consume a notification in the download page'); } };
  const f = await workerFixture([unrelated, { ...unrelated, url: 'https://unrelated.example/' }]);
  await f.dispatch('notificationclick', { ...pairA, threadId });
  assert.equal(messages.length, 0); assert.equal(f.opened.length, 1);
  const url = new URL(f.opened[0]); assert.equal(url.origin, 'https://assistant.example'); assert.equal(url.pathname, '/');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('notificationDevice'), pairA.deviceId);
  let focused = false;
  const active = await workerFixture([{ url: 'https://assistant.example/', postMessage: data => messages.push(data), async focus() { focused = true; } }]);
  await active.dispatch('notificationclick', { ...pairA, threadId });
  assert.equal(focused, true); assert.equal(active.opened.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { type: 'open-notification-task', ...pairA, threadId });
});

test('worker suppresses already-cleared and duplicate push events but displays a new event for the same task', async () => {
  const f = await workerFixture();
  const cleared = new Set(['cleared-event']);
  const existing = f.store.hasEvent;
  f.store.hasEvent = async (pair, event) => cleared.has(event.eventId) || existing(pair, event);
  const push = eventId => f.dispatch('push', { ...pairA, threadId, kind: 'completed', eventId });
  await push('cleared-event'); assert.equal(f.shown.length, 0);
  await push('first-event'); assert.equal(f.shown.length, 1);
  await push('first-event'); assert.equal(f.shown.length, 1);
  await push('new-event'); assert.equal(f.shown.length, 2);
  assert.equal(f.reminders.length, 2);
});

test('worker rejects missing or oversized event identities before displaying or persisting a reminder', async () => {
  const f = await workerFixture();
  for (const eventId of [undefined, '', 'x'.repeat(513)]) await f.dispatch('push', { ...pairA, threadId, kind: 'completed', eventId });
  assert.equal(f.shown.length, 0); assert.equal(f.reminders.length, 0);
});

test('worker rechecks the pairing after a delayed receipt read rather than displaying an old pairing', async () => {
  const f = await workerFixture(), read = deferred(); let active = true;
  f.store.isActive = async () => active; f.store.hasEvent = () => read.promise;
  const push = f.dispatch('push', { ...pairA, threadId, kind: 'completed', eventId: 'in-flight' });
  await flush(); active = false; read.resolve(false); await push;
  assert.equal(f.shown.length, 0); assert.equal(f.reminders.length, 0);
});

test('concurrent duplicate push events share one successful display and receipt sequence', async () => {
  const f = await workerFixture(), display = deferred(); let displays = 0;
  f.registration.showNotification = async () => { displays++; await display.promise; };
  const data = { ...pairA, threadId, kind: 'completed', eventId: 'same-in-flight-event' };
  const first = f.dispatch('push', data), repeated = f.dispatch('push', data);
  await flush(); assert.equal(displays, 1); assert.equal(f.reminders.length, 0);
  display.resolve(); await Promise.all([first, repeated]);
  assert.equal(displays, 1); assert.equal(f.reminders.length, 1);
});
