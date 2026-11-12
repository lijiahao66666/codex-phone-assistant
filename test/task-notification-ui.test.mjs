import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const hostId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const a = '33333333-3333-4333-8333-333333333333';
const b = '44444444-4444-4444-8444-444444444444';
const c = '55555555-5555-4555-8555-555555555555';
let eventNumber = 0;
const notification = (threadId, kind = 'completed', extra = {}) => ({ hostId, deviceId, threadId, kind, eventId: `fixture-event-${++eventNumber}`, ...extra });

async function fixture(options = {}) {
  const nodes = new Map(), documentListeners = new Map(), windowListeners = new Map(), settingsCalls = [], presence = [], timers = new Map();
  let document;
  class Element {
    constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.scrollHeight = 300; this.clientHeight = 500; this.scrollTop = 0; this.className = ''; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...nodes) { for (const node of nodes) { if (node.fragment) this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    get childNodes() { return this.children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    after() {} before() {} insertBefore() {}
    querySelectorAll(selector) { return this.children.flatMap(node => [...(selector.split(',').some(part => part.trim().startsWith('.') ? node.className.split(/\s+/).includes(part.trim().slice(1)) : part.trim() === 'button' && node.tagName === 'BUTTON') ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { for (let node = this; node; node = node.parent) if (node.hidden) return []; return [{}]; }
    getBoundingClientRect() { return { width: 300, height: 400, top: 0, bottom: 400, left: 0, right: 300 }; }
    cloneNode() { const result = new Element(this.tagName); result.value = this.value; return result; }
    focus() { document.activeElement = this; }
    click() { return this.listeners.click?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  document = { hidden: false, activeElement: null, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element(selector.startsWith('#open-') || selector.startsWith('#close-') ? 'button' : 'div')); return nodes.get(selector); },
    createElement: tag => new Element(tag), createDocumentFragment() { const element = new Element(); element.fragment = true; return element; },
    addEventListener(type, fn) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(fn); },
  };
  const window = { innerWidth: 390, innerHeight: 844, pairingReady: new Promise(() => {}),
    setNotificationSettingsOpen(value) { settingsCalls.push(value); },
    refreshNotificationPresence() { presence.push(window.getNotificationThreadId?.()); },
    addEventListener(type, fn) { windowListeners.set(type, fn); },
  };
  const context = vm.createContext({ document, window, crypto: webcrypto, AbortController, TextDecoder, TextEncoder, URLSearchParams, Date,
    setTimeout(fn, ms) { const key = { unref() {} }; timers.set(key, { fn, ms }); return key; }, clearTimeout(key) { timers.delete(key); },
    localStorage: options.localStorage ?? { getItem() { return null; }, removeItem() {}, setItem() {} }, sessionStorage: { removeItem() {} }, store: { read: async () => null },
    fetch: options.fetch ?? (async () => { throw new Error('This interaction fixture must not make a network request'); }),
  });
  const source = (await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8')).replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source);
  const settingsPanel = nodes.get('#settings-panel'), settingsOverlay = nodes.get('#settings-overlay');
  const enable = new Element('button'); enable.hidden = true; nodes.set('#notification-enable', enable);
  settingsPanel.append(enable); settingsOverlay.append(settingsPanel); settingsOverlay.hidden = true;
  run(`historyScope={hostId:'${hostId}',deviceId:'${deviceId}'};currentDeviceId='${deviceId}';selectedId='${a}';scheduleVisibleStatusRefresh=()=>{};scheduleThreadConnect=()=>{};clearConversation=()=>{};beginStatusHandover=()=>{};`);
  if (options.unknownDesktopRead !== true) window.setDesktopNotificationReadReady({ hostId, deviceId }, false, false);
  const data = { projects: [{ id: 'fixture-project', name: 'Fixture', expanded: false, threads: [{ id: a, title: 'Task A', status: 'idle' }, { id: b, title: 'Task B', status: 'idle' }] }], recent: [{ id: c, title: 'Task C', status: 'idle' }] };
  const render = value => { context.testData = value; run('renderThreadList(testData)'); };
  render(data);
  const row = id => nodes.get('#project-list').querySelectorAll('.task').find(node => node.dataset.id === id);
  const group = () => run("projectStatusGroups.get('project:fixture-project')");
  return { run, window, document, nodes, row, group, data, render, settingsCalls, presence,
    notify: value => window.acceptTaskNotification(value),
    key(key, extra = {}) { const event = { key, preventDefault() { this.prevented = true; }, ...extra }; for (const listener of documentListeners.get('keydown') || []) listener(event); return event; },
    visibility(hidden) { document.hidden = hidden; for (const listener of documentListeners.get('visibilitychange') || []) listener(); },
  };
}

test('only exact-pair known tasks accept valid foreground reminder events; the visible current task stays quiet', async () => {
  const f = await fixture();
  assert.equal(f.notify(notification(a)), true);
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
  for (const invalid of [notification(b, 'unknown'), notification(b, 'question', { hostId: deviceId }), notification(b, 'question', { deviceId: hostId }), notification(b, 'question', { eventId: '' }), notification(b, 'question', { eventId: 'x'.repeat(513) }), null]) assert.equal(f.notify(invalid), false);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  assert.equal(f.notify(notification(b, 'question')), true);
  const marker = f.row(b).querySelector('.task-notification');
  assert.equal(marker.hidden, false); assert.equal(marker.textContent, '待回答'); assert.equal(marker.getAttribute('aria-label'), '待回答');
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '1');
});

test('a visible task records the exact receipt before a late push can restore it, without clearing a newer event', async () => {
  const f = await fixture(), receipts = [], puts = [];
  f.window.taskReminderStore = {
    async removeEvent(pair, event) { receipts.push({ ...pair, ...event }); },
    async remove() {},
    async put(pair, event) { puts.push(event); },
  };
  const viewed = notification(a);
  assert.equal(f.notify(viewed), true);
  await Promise.resolve();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].hostId, hostId); assert.equal(receipts[0].deviceId, deviceId);
  assert.equal(receipts[0].threadId, a); assert.equal(receipts[0].eventId, viewed.eventId);
  assert.equal(puts.length, 0);

  f.visibility(true);
  f.notify(viewed);
  assert.equal(puts.length, 0, 'a delayed copy stays acknowledged after the page becomes hidden');
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
  const next = notification(a, 'approval');
  f.notify(next);
  assert.equal(puts.length, 1); assert.equal(puts[0].eventId, next.eventId);
  await f.window.clearTaskNotificationEvent(viewed);
  assert.equal(f.row(a).querySelector('.task-notification').hidden, false);
  assert.equal(f.row(a).querySelector('.task-notification').textContent, '待审批');
});

test('a task event arriving before the authoritative list waits invisibly, refreshes the list and drains after its row arrives', async () => {
  const f = await fixture(), puts = [];
  f.window.taskReminderStore = { async put(pair, event) { puts.push(event); } };
  f.run('globalThis.reminderListRefreshes=0;refreshChangedThreadList=()=>{reminderListRefreshes++}');
  const future = notification(hostId, 'question');
  assert.equal(f.notify(future), true); assert.equal(f.run('reminderListRefreshes'), 1);
  assert.equal(f.run('pendingTaskNotifications.size'), 1); assert.equal(puts.length, 0);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  f.notify(future); assert.equal(f.run('reminderListRefreshes'), 1, 'same pending event does not request repeated refreshes');
  f.render({ ...f.data, recent: [...f.data.recent, { id: hostId, title: 'New task', status: 'idle' }] });
  assert.equal(f.row(hostId).querySelector('.task-notification').textContent, '待回答'); assert.equal(f.row(hostId).querySelector('.task-notification').hidden, false);
  assert.equal(f.run('pendingTaskNotifications.size'), 0); assert.equal(puts.length, 1);
});

test('unknown task buffering is bounded and cannot refresh, drain or persist for another pairing', async () => {
  const f = await fixture();
  f.run('globalThis.reminderListRefreshes=0;refreshChangedThreadList=()=>{reminderListRefreshes++}');
  assert.equal(f.notify(notification(hostId, 'question', { deviceId: hostId })), false); assert.equal(f.run('reminderListRefreshes'), 0); assert.equal(f.run('pendingTaskNotifications.size'), 0);
  for (let index = 0; index < 40; index++) f.notify(notification(`66666666-6666-4666-8666-${index.toString().padStart(12, '0')}`));
  assert.equal(f.run('pendingTaskNotifications.size'), 32);
  f.run('invalidateDeviceState()'); assert.equal(f.run('pendingTaskNotifications.size'), 0);
  f.run(`historyScope={hostId:'${hostId}',deviceId:'${deviceId}'};currentDeviceId='${deviceId}'`);
  f.render(f.data); assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  f.notify(notification(hostId)); f.run('historyScopeGeneration++');
  f.render({ ...f.data, recent: [{ id: hostId, title: 'Late former task', status: 'idle' }] });
  assert.equal(f.row(hostId).querySelector('.task-notification').hidden, true); assert.equal(f.run('pendingTaskNotifications.size'), 0);
});

test('folded directories aggregate reminders, expanded directories show task indicators, and task selection clears all aggregates', async () => {
  const f = await fixture(); const event = notification(b, 'approval'); f.notify(event);
  assert.equal(f.group().notificationIndicator.hidden, false); assert.equal(f.group().notificationIndicator.textContent, '待审批');
  f.group().heading.click(); assert.equal(f.group().notificationIndicator.hidden, true); assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  f.group().heading.click(); assert.equal(f.group().notificationIndicator.hidden, false);
  f.row(b).click();
  assert.equal(f.window.getNotificationThreadId(), b);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true); assert.equal(f.group().notificationIndicator.hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').getAttribute('aria-label'), '打开侧栏');
  assert.equal(f.presence.at(-1), b);
  f.run(`selectedId='${a}'`); f.notify(event);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'a replay of an acknowledged notification must not create a new reminder');
});

test('reminders survive authoritative list redraws but are removed when the task leaves the list or the pairing changes', async () => {
  const f = await fixture(); f.notify(notification(b)); f.notify(notification(c, 'question'));
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '2');
  f.render(f.data); assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  f.render({ ...f.data, recent: [] });
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '1');
  f.run('invalidateDeviceState()');
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  assert.equal(f.notify(notification(b)), false, 'events from the former device cannot survive invalidation');
});

test('a new draft does not mark its previous selection as visible or suppress another task reminder', async () => {
  const f = await fixture(); f.run("newDraft={projectId:'fixture-project',attachments:[]}");
  assert.equal(f.window.getNotificationThreadId(), null);
  f.notify(notification(a)); assert.equal(f.row(a).querySelector('.task-notification').hidden, false);
});

test('local reminder persistence follows the exact pair and viewing a task clears its stored app badge reminder', async () => {
  const f = await fixture(), puts = [], removes = [];
  f.window.taskReminderStore = { async put(pair, event) { puts.push(JSON.parse(JSON.stringify({ pair, event }))); }, async remove(pair, threadId) { removes.push(JSON.parse(JSON.stringify({ pair, threadId }))); } };
  const event = notification(b, 'approval'); f.notify(event);
  assert.deepEqual(puts, [{ pair: { hostId, deviceId }, event }]);
  f.row(b).click(); assert.deepEqual(removes.at(-1), { pair: { hostId, deviceId }, threadId: b });
  f.notify(notification(b)); assert.equal(puts.length, 1, 'a visible task never creates a stored reminder');
  assert.equal(removes.at(-1).threadId, b);
  f.run(`selectedId='${a}'`); f.document.hidden = true;
  f.notify(notification(a, 'question')); assert.equal(f.row(a).querySelector('.task-notification').hidden, false);
  f.document.hidden = false; f.run('updateComposer()');
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true); assert.equal(removes.at(-1).threadId, a);
});

test('restoring persisted task reminders uses the authoritative current list and ignores a late previous-pair read', async () => {
  const f = await fixture();
  f.window.taskReminderStore = { async list() { return [notification(b), notification(hostId), notification(a, 'question')]; }, async put() {}, async remove() {} };
  await f.window.restoreTaskReminders();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '1');
  let release;
  f.window.taskReminderStore.list = () => new Promise(resolve => { release = resolve; });
  const pending = f.window.restoreTaskReminders(); f.run('invalidateDeviceState()');
  release([notification(c)]); await pending;
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
});

test('a persisted completed reminder cannot overwrite a newer live question received while hydration is pending', async () => {
  const f = await fixture(); let release;
  f.window.taskReminderStore = { list: () => new Promise(resolve => { release = resolve; }), async put() {}, async remove() {} };
  const pending = f.window.restoreTaskReminders();
  f.notify(notification(b, 'question'));
  release([notification(b, 'completed')]); await pending;
  const marker = f.row(b).querySelector('.task-notification');
  assert.equal(marker.textContent, '待回答'); assert.equal(marker.dataset.kind, 'question'); assert.equal(marker.hidden, false);
});

test('viewing a task with no current badge still invalidates an older hydration result after switching away', async () => {
  const f = await fixture(); let release;
  f.window.taskReminderStore = { list: () => new Promise(resolve => { release = resolve; }), async put() {}, async remove() {} };
  const pending = f.window.restoreTaskReminders();
  f.row(b).click(); f.row(a).click();
  release([notification(b, 'approval')]); await pending;
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
});

test('desktop event clearing removes only the matching event and cannot clear a newer question or completion', async () => {
  const f = await fixture(), removals = [];
  f.window.taskReminderStore = { async put() {}, async removeEvent(pair, event) { removals.push(JSON.parse(JSON.stringify({ pair, event }))); } };
  const old = notification(b, 'completed'), current = notification(b, 'question');
  f.notify(old); f.notify(current);
  assert.equal(await f.window.clearTaskNotificationEvent(old), true);
  assert.equal(f.row(b).querySelector('.task-notification').textContent, '待回答'); assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  assert.deepEqual(removals[0], { pair: { hostId, deviceId }, event: { threadId: b, eventId: old.eventId } });
  const fresh = notification(b); f.notify(fresh);
  await f.window.clearTaskNotificationEvent(current);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false); assert.equal(f.row(b).querySelector('.task-notification').dataset.kind, 'completed');
  await f.window.clearTaskNotificationEvent(fresh); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.notify(fresh); assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'the exact cleared event cannot return');
});

test('clear-before-notification records an exact tombstone without creating unknown task markers or refreshes', async () => {
  const f = await fixture(), removed = [];
  f.run('globalThis.clearListRefreshes=0;refreshChangedThreadList=()=>{clearListRefreshes++}');
  f.window.taskReminderStore = { async removeEvent(pair, event) { removed.push(event); }, async put() {} };
  const unknown = notification(hostId, 'approval');
  assert.equal(await f.window.clearTaskNotificationEvent(unknown), true);
  f.notify(unknown); assert.equal(f.run('pendingTaskNotifications.size'), 0); assert.equal(f.run('clearListRefreshes'), 0); assert.equal(removed.length, 1);
  const fresh = notification(hostId, 'question'); f.notify(fresh); assert.equal(f.run('pendingTaskNotifications.size'), 1);
  f.render({ ...f.data, recent: [{ id: hostId, title: 'Future task', status: 'idle' }] });
  assert.equal(f.row(hostId).querySelector('.task-notification').textContent, '待回答');
});

test('clearing an older pending event preserves a newer pending event and clearing the current pending event prevents its later render', async () => {
  const f = await fixture(); f.window.taskReminderStore = { async removeEvent() {}, async put() {}, async remove() {} };
  const old = notification(hostId), fresh = notification(hostId, 'question'); f.notify(old); f.notify(fresh);
  await f.window.clearTaskNotificationEvent(old);
  f.render({ ...f.data, recent: [{ id: hostId, title: 'Future task', status: 'idle' }] });
  assert.equal(f.row(hostId).querySelector('.task-notification').textContent, '待回答'); assert.equal(f.row(hostId).querySelector('.task-notification').hidden, false);
  const pending = notification(deviceId, 'approval'); f.notify(pending); await f.window.clearTaskNotificationEvent(pending);
  f.render({ ...f.data, recent: [{ id: deviceId, title: 'Another future task', status: 'idle' }] });
  assert.equal(f.row(deviceId).querySelector('.task-notification').hidden, true);
});

test('a desktop clear invalidates an older hydration read and late persistence completion cannot change a new pairing', async () => {
  const f = await fixture(); let releaseList, releaseRemove;
  f.window.taskReminderStore = { list: () => new Promise(resolve => { releaseList = resolve; }), async put() {}, removeEvent: () => new Promise(resolve => { releaseRemove = resolve; }) };
  const stale = notification(b, 'approval'); const hydration = f.window.restoreTaskReminders();
  const clear = f.window.clearTaskNotificationEvent(stale);
  releaseList([stale]); await hydration; assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.run('invalidateDeviceState()'); releaseRemove({ removed: true }); assert.equal(await clear, false);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
});

test('desktop clear rejects foreign pairs and malformed IDs before mutating reminders or persistence', async () => {
  const f = await fixture(), removals = [];
  f.window.taskReminderStore = { async removeEvent(pair, event) { removals.push(event); }, async put() {} };
  const active = notification(b, 'question'); f.notify(active);
  for (const invalid of [null, { ...active, hostId: deviceId }, { ...active, deviceId: hostId }, { ...active, threadId: 'bad' }, { ...active, eventId: '' }, { ...active, eventId: 'x'.repeat(513) }]) assert.equal(await f.window.clearTaskNotificationEvent(invalid), false);
  assert.equal(removals.length, 0); assert.equal(f.row(b).querySelector('.task-notification').textContent, '待回答'); assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
});

test('only a complete authoritative list removes missing persisted reminders, while truncated lists and pending new tasks preserve them', async () => {
  const complete = await fixture(), removed = [];
  complete.window.taskReminderStore = { async put() {}, async remove(pair, threadId) { removed.push({ ...pair, threadId }); }, async list() { return [notification(b)]; } };
  complete.notify(notification(b));
  const missingB = { ...complete.data, projects: [{ ...complete.data.projects[0], threads: [complete.data.projects[0].threads[0]] }] };
  complete.render(missingB); await complete.window.restoreTaskReminders();
  assert.ok(removed.some(item => item.hostId === hostId && item.deviceId === deviceId && item.threadId === b));
  assert.equal(complete.run(`taskNotifications.has('${b}')`), false);
  const truncated = await fixture(), unexpectedRemoves = [];
  truncated.window.taskReminderStore = { async put() {}, async remove(pair, id) { unexpectedRemoves.push(id); }, async list() { return [notification(b)]; } };
  truncated.notify(notification(b)); truncated.render({ ...missingB, truncated: true }); await truncated.window.restoreTaskReminders();
  assert.deepEqual(unexpectedRemoves, []); assert.equal(truncated.run(`taskNotifications.has('${b}')`), true);
  const newTask = await fixture(), newTaskRemoves = [];
  const incoming = notification(hostId);
  newTask.notify(incoming);
  newTask.window.taskReminderStore = { async list() { return [incoming]; }, async remove(pair, id) { newTaskRemoves.push(id); }, async put() {} };
  await newTask.window.restoreTaskReminders();
  assert.deepEqual(newTaskRemoves, []); assert.equal(newTask.run('pendingTaskNotifications.size'), 1);
});

test('completed task reminders render an empty labelled blue-dot marker while notification navigation expands a later authoritative task', async () => {
  const f = await fixture();
  const threads = Array.from({ length: 7 }, (_, index) => ({ id: `77777777-7777-4777-8777-${index.toString().padStart(12, '0')}`, title: `Task ${index}`, status: 'idle' }));
  const target = threads.at(-1).id;
  f.render({ projects: [{ id: 'fixture-project', name: 'Fixture', expanded: false, threads }], recent: [] });
  assert.equal(f.row(target), undefined);
  f.notify(notification(target)); assert.equal(f.group().notificationIndicator.hidden, false);
  assert.equal(f.window.openNotificationTask({ hostId, deviceId, threadId: target }), true);
  assert.equal(f.window.getNotificationThreadId(), target); assert.equal(f.group().heading.getAttribute('aria-expanded'), 'true');
  f.run(`selectedId='${a}'`); f.notify(notification(target));
  const marker = f.row(target).querySelector('.task-notification');
  assert.equal(marker.hidden, false); assert.equal(marker.textContent, ''); assert.equal(marker.dataset.kind, 'completed'); assert.equal(marker.getAttribute('aria-label'), '有新提醒，任务已完成');
  assert.equal(f.window.openNotificationTask({ hostId, deviceId, threadId: hostId }), false);
});

test('running and checking states hide a retained completed dot; observed idle restores it and viewing clears it', async () => {
  const f = await fixture(); const removes = [];
  f.window.taskReminderStore = { async put() {}, async remove(pair, id) { removes.push(id); } };
  f.notify(notification(b));
  const dot = f.row(b).querySelector('.task-notification'), spinner = f.row(b).querySelector('.task-active');
  assert.equal(dot.hidden, false);
  f.run(`updateLiveTaskStatus('${b}','active')`);
  assert.equal(dot.hidden, true); assert.equal(spinner.hidden, false); assert.equal(f.group().notificationIndicator.hidden, true); assert.equal(f.group().indicator.hidden, false);
  assert.equal(f.run(`taskNotifications.has('${b}')`), true); assert.deepEqual(removes, []);
  f.run(`updateLiveTaskStatus('${b}','idle')`);
  assert.equal(dot.hidden, false); assert.equal(spinner.hidden, true); assert.equal(f.group().notificationIndicator.hidden, false); assert.equal(f.group().indicator.hidden, true);
  f.run(`statusHandovers.set('${b}',{});applySidebarStatuses()`);
  assert.equal(dot.hidden, true); assert.equal(spinner.hidden, false); assert.equal(spinner.dataset.status, 'checking');
  f.run(`acceptSidebarStatuses({'${b}':'idle'})`);
  assert.equal(dot.hidden, false); assert.equal(spinner.hidden, true);
  f.row(b).click(); assert.equal(dot.hidden, true); assert.equal(removes.at(-1), b);
});

test('pending questions and approvals use text instead of a simultaneous spinner and folded directory status follows that priority', async () => {
  const f = await fixture();
  f.run(`updateLiveTaskStatus('${b}','active')`); f.notify(notification(b, 'question'));
  const text = f.row(b).querySelector('.task-notification'), spinner = f.row(b).querySelector('.task-active');
  assert.equal(text.hidden, false); assert.equal(text.textContent, '待回答'); assert.equal(spinner.hidden, true);
  assert.equal(f.group().notificationIndicator.textContent, '待回答'); assert.equal(f.group().notificationIndicator.hidden, false); assert.equal(f.group().indicator.hidden, true);
  f.run(`acceptSidebarStatuses({'${b}':'active'})`); assert.equal(text.textContent, '待回答'); assert.equal(spinner.hidden, true);
  f.notify(notification(b, 'approval')); assert.equal(text.textContent, '待审批'); assert.equal(spinner.hidden, true); assert.equal(f.group().notificationIndicator.textContent, '待审批');
  f.group().heading.click(); assert.equal(f.group().notificationIndicator.hidden, true); assert.equal(f.group().indicator.hidden, true); assert.equal(text.hidden, false);
  f.row(b).click(); assert.equal(text.hidden, true); assert.equal(spinner.hidden, false, 'viewing clears the local reminder and reveals the real running state');
});

test('settings open from either entry, dismiss by scrim or Escape, and retain keyboard focus', async () => {
  const f = await fixture(); const open = f.nodes.get('#open-settings'), panel = f.nodes.get('#settings-panel'), overlay = f.nodes.get('#settings-overlay');
  f.window.innerWidth = 1024;
  overlay.hidden = true;
  f.nodes.get('#summary-panel').hidden = false; f.nodes.get('#devices').open = true;
  open.focus(); open.click();
  assert.equal(f.nodes.get('#summary-panel').hidden, true); assert.equal(f.nodes.get('#devices').open, false); assert.equal(f.nodes.get('#scrim').hidden, true);
  assert.equal(overlay.hidden, false); assert.equal(open.getAttribute('aria-expanded'), 'true'); assert.equal(f.document.activeElement, panel); assert.equal(f.settingsCalls.at(-1), true);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(overlay.hidden, true); assert.equal(f.document.activeElement, open); assert.equal(f.settingsCalls.at(-1), false);
  f.window.openNotificationSettings(); f.key('Escape'); assert.equal(overlay.hidden, true);
  open.click(); f.nodes.get('#settings-scrim').click(); assert.equal(overlay.hidden, true);
  open.click(); const enable = f.nodes.get('#notification-enable'); enable.hidden = false;
  enable.focus(); assert.equal(f.key('Tab').prevented, true); assert.equal(f.document.activeElement, enable);
  assert.equal(f.key('Tab', { shiftKey: true }).prevented, true); assert.equal(f.document.activeElement, enable);
  f.key('Escape');
  const mobile = await fixture(); const mobileOpen = mobile.nodes.get('#open-settings');
  mobileOpen.focus(); mobileOpen.click(); mobile.key('Escape');
  assert.equal(mobile.document.activeElement, mobile.nodes.get('#open-sidebar'), 'closing settings on mobile must not focus its offscreen sidebar entry');
});

test('settings use a left-side drawer constrained to the mobile viewport and a fixed sidebar footer entry', async () => {
  const css = await readFile(new URL('../public/desktop.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/desktop.html', import.meta.url), 'utf8');
  const panel = css.match(/\.settings-panel\{([^}]+)\}/)?.[1];
  assert.match(panel, /position:absolute/); assert.match(panel, /inset:0 auto 0 0/); assert.match(panel, /width:min\(300px,85vw\)/); assert.match(panel, /height:100%/);
  assert.match(css, /\.sidebar-footer\{flex:none/);
  assert.equal(html.includes('id="close-settings"'), false);
  assert.ok(html.indexOf('id="project-list"') < html.indexOf('class="sidebar-footer"'));
  assert.ok(html.indexOf('class="sidebar-footer"') < html.indexOf('id="open-settings"'));
  assert.ok(html.indexOf('id="open-settings"') < html.indexOf('</aside>'));
});

test('foreground acknowledgement waits for durable storage and rejects failure, missing storage, unknown tasks and revoked scopes', async () => {
  const f = await fixture(); let release;
  f.window.taskReminderStore = { put: () => new Promise(resolve => { release = resolve; }), async removeEvent() {} };
  const event = notification(b, 'question', { createdAt: 200 });
  let acknowledged = false;
  const receipt = f.window.taskNotificationReceipt(event).then(value => { acknowledged = value; return value; });
  await Promise.resolve(); assert.equal(acknowledged, false);
  release({ stored: true }); assert.equal(await receipt, true);
  assert.equal(await f.window.taskNotificationReceipt(notification(hostId)), false, 'unknown task is not acknowledged before list acceptance');
  f.window.taskReminderStore.put = async () => { throw Error('IDB unavailable'); };
  assert.equal(await f.window.taskNotificationReceipt(notification(c)), false);
  f.window.taskReminderStore.put = () => new Promise(resolve => { release = resolve; });
  const revoked = f.window.taskNotificationReceipt(notification(c));
  f.run('invalidateDeviceState()'); release({ stored: true }); assert.equal(await revoked, false);
  const absent = await fixture(); assert.equal(await absent.window.taskNotificationReceipt(notification(b)), false);
});

test('visible-task acknowledgement waits for the exact read receipt, so an in-flight push cannot restore its badge', async () => {
  const f = await fixture(); let release;
  f.window.taskReminderStore = { removeEvent: () => new Promise(resolve => { release = resolve; }), async remove() {} };
  const event = notification(a, 'approval', { createdAt: 200 });
  let done = false;
  const work = f.window.taskNotificationReceipt(event).then(result => { done = true; return result; });
  await Promise.resolve(); assert.equal(done, false); release({ removed: false });
  assert.equal(await work, true); assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
});

test('late older or untimed events cannot overwrite or resurrect a newer reminder, including after it was read', async () => {
  const f = await fixture(), puts = [];
  f.window.taskReminderStore = { async put(pair, event) { puts.push(event); }, async remove() {}, async removeEvent() {} };
  f.notify(notification(b, 'question', { createdAt: 200 }));
  f.notify(notification(b, 'completed', { createdAt: 100 }));
  f.notify(notification(b, 'completed'));
  assert.equal(f.row(b).querySelector('.task-notification').textContent, '待回答'); assert.equal(puts.length, 1);
  f.row(b).click(); f.run(`selectedId='${a}'`);
  f.notify(notification(b, 'completed', { createdAt: 199 }));
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.notify(notification(b, 'approval', { createdAt: 200 }));
  assert.equal(f.row(b).querySelector('.task-notification').textContent, '待审批', 'equal millisecond events retain arrival semantics');
  assert.equal(puts.at(-1).createdAt, 200);
});

test('persisted newer watermarks reject stale SSE before displaying it and never acknowledge an inactive pairing', async () => {
  const f = await fixture(), receipts = [];
  f.window.taskReminderStore = { async inspectEvent() { return { status: 'stale' }; }, async removeEvent(pair, event) { receipts.push(event); } };
  assert.equal(await f.window.taskNotificationReceipt(notification(b, 'completed', { createdAt: 100 })), true);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true); assert.equal(receipts.length, 1);
  f.window.taskReminderStore.inspectEvent = async () => ({ status: 'inactive' });
  assert.equal(await f.window.taskNotificationReceipt(notification(b)), false);
});

test('an ignored read receipt cannot acknowledge foreground delivery', async () => {
  const f = await fixture();
  f.window.taskReminderStore = { async removeEvent() { return { ignored: true }; }, async remove() {} };
  assert.equal(await f.window.taskNotificationReceipt(notification(a)), false);
});

test('a durable read tombstone after page reload does not resurrect a foreground marker', async () => {
  const f = await fixture(); let puts = 0;
  f.window.taskReminderStore = { async inspectEvent() { return { status: 'seen', stored: false }; }, async removeEvent() {}, async put() { puts++; return { duplicate: true }; } };
  assert.equal(await f.window.taskNotificationReceipt(notification(b)), true);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true); assert.equal(puts, 0);
});

test('a competing worker watermark or read receipt during put removes only the suppressed exact local event', async () => {
  const f = await fixture(); let release;
  f.window.taskReminderStore = { put: () => new Promise(resolve => { release = resolve; }) };
  const event = notification(b, 'completed', { createdAt: 100 });
  const work = f.window.taskNotificationReceipt(event);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  release({ stale: true }); assert.equal(await work, true);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  const old = f.window.taskNotificationReceipt(notification(b, 'completed', { createdAt: 101 })); const releaseOld = release;
  f.notify(notification(b, 'question', { createdAt: 200 }));
  releaseOld({ stale: true }); await old;
  assert.equal(f.row(b).querySelector('.task-notification').textContent, '待回答');
});


test('opening a completed reminder clears locally before Desktop responds and persists an exact receipt', async () => {
  const requests = [], receipts = []; let finish, catchups = 0;
  const f = await fixture({ fetch: (url, request) => { requests.push({ url, ...request }); return new Promise(resolve => { finish = resolve; }); } });
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent(pair, event) { receipts.push(event); } };
  f.window.syncClearedTaskNotifications = async () => { catchups++; };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
  const event = notification(b, 'completed', { createdAt: 100 }); f.notify(event);
  f.row(b).click(); f.row(b).click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/notifications/read');
  assert.equal(requests[0].headers['x-codex-expected-device'], deviceId);
  assert.deepEqual(JSON.parse(requests[0].body), { threadId: b, eventId: event.eventId });
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'no network response is needed for local read');
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  assert.equal(receipts[0].eventId, event.eventId);
  assert.equal(Object.hasOwn(receipts[0], 'createdAt'), false, 'local read is scoped to the exact event');
  finish({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catchups, 1); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
});

test('failed Desktop sync never restores locally read reminders, and another click retries in the background', async () => {
  const requests = [];
  const f = await fixture({ fetch: async (url, request) => { requests.push(request); return { ok: false }; } });
  const event = notification(b);
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent() {}, async list() { return [event]; } };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
  f.notify(event); f.row(b).click(); await new Promise(resolve => setImmediate(resolve));
  f.row(a).click(); f.notify(event); await f.window.restoreTaskReminders();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'SSE and stored-event replay cannot restore an explicitly read event');
  f.row(b).click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests.length, 2);
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, false); f.row(b).click();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true); assert.equal(requests.length, 2);
  f.row(a).click(); f.notify(notification(b, 'question')); f.row(b).click();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'a pending background read must not block question reminders');
});

test('desktop read applies only to user-opened completed reminders and does not replace question behavior or current-task quiet', async () => {
  const requests = [], removes = [];
  const f = await fixture({ fetch: async (url, request) => { requests.push(request); return { ok: true }; } });
  f.window.taskReminderStore = { async put() {}, async remove(pair, id) { removes.push(id); }, async removeEvent() {} };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
  f.notify(notification(a)); assert.equal(f.row(a).querySelector('.task-notification').hidden, true); assert.equal(requests.length, 0);
  f.notify(notification(b, 'question')); f.row(b).click(); assert.equal(f.row(b).querySelector('.task-notification').hidden, true); assert.equal(requests.length, 0);
  f.run(`selectedId='${a}'`);
  const restored = notification(a, 'completed', { createdAt: 100 });
  f.window.taskReminderStore.list = async () => [restored]; await f.window.restoreTaskReminders();
  assert.equal(f.row(a).querySelector('.task-notification').hidden, false, 'an existing reminder hydrated in the selected task waits for a real user open');
  assert.equal(requests.length, 0); f.row(a).click(); assert.equal(requests.length, 1);
});

test('quick task and pair switches cancel pending desktop reads, and an old clear cannot consume a newer completion', async () => {
  const requests = [], completions = []; let catchups = 0;
  const f = await fixture({ fetch: (url, request) => { requests.push(request); return new Promise(resolve => { completions.push(resolve); }); } });
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent() {} };
  f.window.syncClearedTaskNotifications = async () => { catchups++; };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
  const old = notification(b, 'completed', { createdAt: 100 }); f.notify(old); f.row(b).click();
  f.row(c).click();
  const newer = notification(b, 'completed', { createdAt: 200 }); f.notify(newer);
  await f.window.clearTaskNotificationEvent(old);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  assert.equal(f.run(`taskNotifications.get('${b}').eventId`), newer.eventId);
  f.row(c).click(); assert.equal(requests[0].signal.aborted, true);
  completions[0]({ ok: true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(catchups, 0);
  f.row(b).click(); assert.equal(requests.length, 2); f.run('invalidateDeviceState()');
  assert.equal(requests[1].signal.aborted, true); completions[1]({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catchups, 0); assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
});


test('unknown or offline Desktop capability does not delay local reads', async () => {
  const requests = [];
  const f = await fixture({ unknownDesktopRead: true, fetch: async (url, request) => { requests.push(request); return { ok: true }; } });
  const event = notification(b, 'completed', { createdAt: 100 });
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent() {}, async list() { return [event]; } };
  await f.window.restoreTaskReminders(); f.row(b).click();
  assert.equal(requests.length, 0); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true); f.row(b).click();
  assert.equal(requests.length, 1, 'a later user click can retry after Desktop becomes available');
  f.row(a).click(); await f.window.restoreTaskReminders();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
});

test('old local storage receipts cannot clear an exact completed marker awaiting desktop confirmation', async () => {
  for (const inspection of [{ status: 'stale' }, { status: 'seen', stored: false }]) {
    const f = await fixture(), removals = [];
    f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
    f.window.taskReminderStore = { async put() {}, async removeEvent(pair, event) { removals.push(event); } };
    const event = notification(b, 'completed', { createdAt: 100 }); f.notify(event);
    f.window.taskReminderStore.inspectEvent = async () => inspection;
    assert.equal(await f.window.taskNotificationReceipt(event), false);
    assert.equal(f.row(b).querySelector('.task-notification').hidden, false); assert.equal(removals.length, 0);
    await f.window.clearTaskNotificationEvent(event); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  }
  const f = await fixture(); let finish;
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true);
  f.window.taskReminderStore = { put: () => new Promise(resolve => { finish = resolve; }) };
  const event = notification(b, 'completed', { createdAt: 100 });
  const receipt = f.window.taskNotificationReceipt(event);
  finish({ stale: true }); assert.equal(await receipt, false);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false, 'an older storage receipt cannot replace the desktop clear chain');
});

test('native unread displays once, clears instantly on click and only returns after a fresh read then unread transition', async () => {
  const requests = []; let finish;
  const storage = new Map(), localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const f = await fixture({ localStorage, fetch: (url, request) => { requests.push({ url, request }); return new Promise(resolve => { finish = resolve; }); } });
  const scopeKey = 'a'.repeat(64);
  const data = unread => ({ ...f.data, nativeUnread: { status: 'available', scopeKey }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => ({ ...task, ...(task.id === b && unread ? { unread: true } : {}) })) }] });
  f.render(data(true));
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  assert.equal(f.row(b).querySelector('.task-notification').getAttribute('aria-label'), '有未读消息');
  const completion = notification(b); f.notify(completion);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '1', 'native and completion reminders count one task');
  // A generic unread alone uses the native-read route.
  await f.window.clearTaskNotificationEvent(completion);
  f.row(b).click();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, `/api/threads/${b}/desktop-read`);
  assert.equal(requests[0].request.headers['x-codex-expected-device'], deviceId);
  assert.deepEqual(JSON.parse(requests[0].request.body), { scopeKey });
  f.render(data(true)); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.render(data(false)); f.render(data(true)); assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'a list started before the click cannot undo its suppression');
  f.run('listRequestGeneration++'); f.render(data(false)); f.render(data(true));
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false, 'a subsequent confirmed read followed by a new unread is visible');
  finish({ ok: false, status: 503 }); await new Promise(resolve => setImmediate(resolve));
});

test('a completion and native unread on the same task perform only one desktop navigation', async () => {
  const requests = [];
  const f = await fixture({ fetch: (url, request) => { requests.push({ url, request }); return new Promise(() => {}); } });
  const scopeKey = 'a'.repeat(64);
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent() {} };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, false, true);
  f.render({ ...f.data, nativeUnread: { status: 'available', scopeKey }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === b ? { ...task, unread: true } : task) }] });
  f.notify(notification(b)); f.row(b).click();
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, `/api/threads/${b}/desktop-read`);
});

test('native unread ignores old clients, retains state when unavailable, and isolates scope changes', async () => {
  const requests = []; const f = await fixture({ fetch: (url, request) => { requests.push({ url, request }); return new Promise(() => {}); } });
  const tasks = [{ id: a, title: 'Task A', status: 'idle' }, { id: b, title: 'Task B', status: 'idle', unread: true }];
  const list = nativeUnread => ({ ...f.data, ...(nativeUnread ? { nativeUnread } : {}), projects: [{ ...f.data.projects[0], threads: tasks }] });
  f.render(list()); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.render(list({ status: 'available', scopeKey: 'a'.repeat(64) })); assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  f.render(list({ status: 'unavailable' })); assert.equal(f.row(b).querySelector('.task-notification').hidden, true, 'unknown native identity is not displayed as the previous account');
  f.render(list({ status: 'available', scopeKey: 'a'.repeat(64) })); assert.equal(f.row(b).querySelector('.task-notification').hidden, false, 'the prior state was not cleared');
  f.row(b).click(); assert.equal(requests.length, 1); assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  f.render(list({ status: 'available', scopeKey: 'b'.repeat(64) }));
  assert.equal(requests[0].request.signal.aborted, true, 'identity change cancels old navigation');
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false, 'new identity does not inherit a local read');
  f.run('invalidateDeviceState()'); assert.equal(f.run('nativeUnread.size'), 0);
});

test('native local reads survive reload and recover after a confirmed read and later unread', async () => {
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const makeList = (f, unread) => ({ ...f.data, nativeUnread: { status: 'available', scopeKey: 'a'.repeat(64) }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === b && unread ? { ...task, unread: true } : task) }] });
  const first = await fixture({ localStorage, fetch: async () => ({ ok: false, status: 503 }) });
  first.render(makeList(first, true)); first.row(b).click();
  await new Promise(resolve => setImmediate(resolve));
  const reloaded = await fixture({ localStorage });
  reloaded.render(makeList(reloaded, true));
  assert.equal(reloaded.row(b).querySelector('.task-notification').hidden, true);
  reloaded.render(makeList(reloaded, false)); reloaded.render(makeList(reloaded, true));
  assert.equal(reloaded.row(b).querySelector('.task-notification').hidden, false);
});

test('a task being viewed stays quiet when the desktop unread bit changes', async () => {
  const requests = []; const f = await fixture({ fetch: async url => { requests.push(url); return { ok: true }; } });
  const scopeKey = 'a'.repeat(64);
  const list = unread => ({ ...f.data, nativeUnread: { status: 'available', scopeKey }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === a && unread ? { ...task, unread: true } : task) }] });
  f.run('connected=true'); f.render(list(false)); f.render(list(true));
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  assert.equal(requests.length, 0, 'a passive state update never opens Desktop');
  f.row(b).click(); f.render(list(true)); assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
});

test('a connected current task stays quiet when its first native unread snapshot arrives', async () => {
  const f = await fixture(); f.run('connected=true');
  f.render({ ...f.data, nativeUnread: { status: 'available', scopeKey: 'a'.repeat(64) }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === a ? { ...task, unread: true } : task) }] });
  assert.equal(f.row(a).querySelector('.task-notification').hidden, true);
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').hidden, true);
  f.run('connected=false;selectedId=null');
  f.render({ ...f.data, nativeUnread: { status: 'available', scopeKey: 'b'.repeat(64) }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === a ? { ...task, unread: true } : task) }] });
  assert.equal(f.row(a).querySelector('.task-notification').hidden, false, 'a new identity without an active view does not inherit a local read');
});

test('a later completed event still shows while a previous native unread bit remains locally suppressed', async () => {
  const f = await fixture({ fetch: async () => ({ ok: false, status: 503 }) });
  f.window.taskReminderStore = { async put() {}, async remove() {}, async removeEvent() {} };
  f.window.setDesktopNotificationReadReady({ hostId, deviceId }, true, true);
  f.render({ ...f.data, nativeUnread: { status: 'available', scopeKey: 'a'.repeat(64) }, projects: [{ ...f.data.projects[0], threads: f.data.projects[0].threads.map(task => task.id === b ? { ...task, unread: true } : task) }] });
  f.row(b).click(); await new Promise(resolve => setImmediate(resolve)); f.row(a).click();
  f.notify(notification(b, 'completed', { createdAt: 200 }));
  assert.equal(f.row(b).querySelector('.task-notification').hidden, false);
  assert.equal(f.row(b).querySelector('.task-notification').getAttribute('aria-label'), '有新提醒，任务已完成');
});

test('activity snapshot displays incomplete and unknown state without calling it empty', async () => {
  const f = await fixture({ fetch: async url => {
    assert.equal(url, '/api/activity');
    return { ok: true, json: async () => ({ complete: false, items: [{ id: b, title: 'Waiting', waiting: 'both', statusKnown: true }, { id: c, title: 'Unknown', statusKnown: false }] }) };
  } });
  f.nodes.get('#activity-view').hidden = false;
  f.nodes.get('#sidebar').classList.contains = name => name === 'open';
  await f.run('refreshActivityView()');
  const view = f.nodes.get('#activity-view');
  assert.equal(view.querySelector('.activity-row').textContent, 'Waiting');
  assert.equal(view.querySelector('.activity-label').textContent, '待回答 · 待审批');
  assert.match(view.querySelector('.activity-note').textContent, /检查中/);
  assert.doesNotMatch(view.querySelector('.activity-note').textContent, /没有活动/);
});

test('search ignores stale responses and paginates distinct results', async () => {
  const requests = [];
  const f = await fixture({ fetch: async (url, options) => new Promise(resolve => requests.push({ url, options, resolve })) });
  const input = f.nodes.get('#thread-search');
  input.value = 'old'; const old = f.run('searchThreads()');
  input.value = 'new'; const current = f.run('searchThreads()');
  requests[1].resolve({ ok: true, json: async () => ({ results: [{ id: b, title: 'New', snippet: 'match' }], nextCursor: 'next' }) });
  await current;
  requests[0].resolve({ ok: true, json: async () => ({ results: [{ id: a, title: 'Old' }] }) });
  await old;
  assert.deepEqual(f.nodes.get('#search-results').querySelectorAll('.search-row').map(row => row.textContent), ['New']);
  const more = f.run('searchThreads(true)');
  assert.equal(JSON.parse(requests[2].options.body).cursor, 'next');
  requests[2].resolve({ ok: true, json: async () => ({ results: [{ id: b, title: 'Duplicate' }, { id: c, title: 'Next' }], nextCursor: null }) });
  await more;
  assert.deepEqual(f.nodes.get('#search-results').querySelectorAll('.search-row').map(row => row.textContent), ['New', 'Next']);
});

test('search only navigates Desktop after opening an unread result, never while browsing or searching', async () => {
  const requests = [];
  const f = await fixture({ fetch: async (url, options) => {
    requests.push(url);
    if (url === '/api/threads/search') return { ok: true, json: async () => ({ results: [{ id: b, title: 'Unread result' }], nextCursor: null }) };
    return { ok: true, json: async () => ({}) };
  } });
  f.run(`nativeUnreadAvailable=true; nativeUnreadScope='${'a'.repeat(64)}'; nativeUnread.set('${b}',true);`);
  f.nodes.get('#view-search').click();
  f.nodes.get('#thread-search').value = 'Unread';
  await f.run('searchThreads()');
  assert.deepEqual(requests, ['/api/threads/search']);
  f.nodes.get('#search-results').querySelector('.search-row').click();
  assert.ok(requests.some(url => url === `/api/threads/${b}/desktop-read`));
});

test('activity only navigates Desktop after opening an unread task', async () => {
  const requests = [];
  const f = await fixture({ fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ complete: true, scopeKey: 'a'.repeat(64), items: [{ id: b, title: 'Unread activity', unread: true, statusKnown: true }] }) }; } });
  f.run(`nativeUnreadAvailable=true; nativeUnreadScope='${'a'.repeat(64)}'; nativeUnread.set('${b}',false);`);
  f.nodes.get('#activity-view').hidden = false;
  f.nodes.get('#sidebar').classList.contains = name => name === 'open';
  await f.run('refreshActivityView()');
  assert.deepEqual(requests, ['/api/activity']);
  f.nodes.get('#activity-view').querySelector('.activity-row').click();
  assert.ok(requests.some(url => url === `/api/threads/${b}/desktop-read`));
  f.run('renderActivityView()');
  assert.equal(f.nodes.get('#activity-view').querySelector('.activity-row'), null, 'locally read activity stays cleared while Desktop catches up');
});

test('search can locally clear and synchronize an unread result outside the sidebar list', async () => {
  const requests = [];
  const f = await fixture({ fetch: async url => {
    requests.push(url);
    return { ok: true, json: async () => url === '/api/threads/search' ? { scopeKey: 'a'.repeat(64), results: [{ id: b, title: 'Older', unread: true }], nextCursor: null } : {} };
  } });
  f.run(`nativeUnreadAvailable=true; nativeUnreadScope='${'a'.repeat(64)}';`);
  f.nodes.get('#thread-search').value = 'Older'; await f.run('searchThreads()');
  f.nodes.get('#search-results').querySelector('.search-row').click();
  assert.ok(requests.includes(`/api/threads/${b}/desktop-read`));
  assert.equal(f.run(`nativeUnreadSuppressed.has('${b}')`), true);
});

test('an old search unread snapshot cannot overwrite a newer list read or a different identity', async () => {
  let resolve; const f = await fixture({ fetch: async () => new Promise(done => { resolve = done; }) });
  f.run(`nativeUnreadAvailable=true; nativeUnreadScope='${'a'.repeat(64)}'; nativeUnread.set('${b}',false);`);
  f.nodes.get('#thread-search').value = 'Older'; const pending = f.run('searchThreads()');
  f.run('++listRequestGeneration');
  resolve({ ok: true, json: async () => ({ scopeKey: 'a'.repeat(64), results: [{ id: b, title: 'Older', unread: true }] }) });
  await pending; assert.equal(f.run(`nativeUnread.get('${b}')`), false);
});
