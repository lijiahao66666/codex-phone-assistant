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

async function fixture() {
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
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} }, sessionStorage: { removeItem() {} }, store: { read: async () => null },
    fetch: async () => { throw new Error('This interaction fixture must not make a network request'); },
  });
  const source = (await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8')).replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source);
  const settingsPanel = nodes.get('#settings-panel'), settingsOverlay = nodes.get('#settings-overlay');
  const enable = new Element('button'); enable.hidden = true; nodes.set('#notification-enable', enable);
  settingsPanel.append(nodes.get('#close-settings'), enable); settingsOverlay.append(settingsPanel); settingsOverlay.hidden = true;
  run(`historyScope={hostId:'${hostId}',deviceId:'${deviceId}'};currentDeviceId='${deviceId}';selectedId='${a}';scheduleVisibleStatusRefresh=()=>{};scheduleThreadConnect=()=>{};clearConversation=()=>{};beginStatusHandover=()=>{};`);
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
  for (const invalid of [notification(b, 'unknown'), notification(b, 'question', { hostId: deviceId }), notification(b, 'question', { deviceId: hostId }), notification(b, 'question', { eventId: '' }), null]) assert.equal(f.notify(invalid), false);
  assert.equal(f.row(b).querySelector('.task-notification').hidden, true);
  assert.equal(f.notify(notification(b, 'question')), true);
  const marker = f.row(b).querySelector('.task-notification');
  assert.equal(marker.hidden, false); assert.equal(marker.textContent, '待回答'); assert.equal(marker.getAttribute('aria-label'), '待回答');
  assert.equal(f.nodes.get('#open-sidebar').querySelector('.sidebar-notification').textContent, '1');
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

test('settings open from a fixed entry, close by button or Escape, and return keyboard focus', async () => {
  const f = await fixture(); const open = f.nodes.get('#open-settings'), close = f.nodes.get('#close-settings'), overlay = f.nodes.get('#settings-overlay');
  f.window.innerWidth = 1024;
  overlay.hidden = true;
  f.nodes.get('#summary-panel').hidden = false; f.nodes.get('#devices').open = true;
  open.focus(); open.click();
  assert.equal(f.nodes.get('#summary-panel').hidden, true); assert.equal(f.nodes.get('#devices').open, false); assert.equal(f.nodes.get('#scrim').hidden, true);
  assert.equal(overlay.hidden, false); assert.equal(open.getAttribute('aria-expanded'), 'true'); assert.equal(f.document.activeElement, close); assert.equal(f.settingsCalls.at(-1), true);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(overlay.hidden, true); assert.equal(f.document.activeElement, open); assert.equal(f.settingsCalls.at(-1), false);
  open.click(); close.click(); assert.equal(overlay.hidden, true); assert.equal(f.document.activeElement, open);
  open.click(); f.nodes.get('#settings-scrim').click(); assert.equal(overlay.hidden, true);
  open.click(); const enable = f.nodes.get('#notification-enable'); enable.hidden = false;
  enable.focus(); assert.equal(f.key('Tab').prevented, true); assert.equal(f.document.activeElement, close);
  assert.equal(f.key('Tab', { shiftKey: true }).prevented, true); assert.equal(f.document.activeElement, enable);
  f.key('Escape');
  const mobile = await fixture(); const mobileOpen = mobile.nodes.get('#open-settings');
  mobileOpen.focus(); mobileOpen.click(); mobile.key('Escape');
  assert.equal(mobile.document.activeElement, mobile.nodes.get('#open-sidebar'), 'closing settings on mobile must not focus its offscreen sidebar entry');
});

test('settings use a right-side drawer constrained to the mobile viewport and a fixed sidebar footer entry', async () => {
  const css = await readFile(new URL('../public/desktop.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/desktop.html', import.meta.url), 'utf8');
  const panel = css.match(/\.settings-panel\{([^}]+)\}/)?.[1];
  assert.match(panel, /position:absolute/); assert.match(panel, /inset:0 0 0 auto/); assert.match(panel, /width:min\(300px,85vw\)/); assert.match(panel, /height:100%/);
  assert.match(css, /\.sidebar-footer\{flex:none/);
  assert.ok(html.indexOf('id="project-list"') < html.indexOf('class="sidebar-footer"'));
  assert.ok(html.indexOf('class="sidebar-footer"') < html.indexOf('id="open-settings"'));
  assert.ok(html.indexOf('id="open-settings"') < html.indexOf('</aside>'));
});
