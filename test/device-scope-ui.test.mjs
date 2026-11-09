import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
const hostA = '11111111-1111-4111-8111-111111111111';
const hostB = '22222222-2222-4222-8222-222222222222';
const deviceA = '33333333-3333-4333-8333-333333333333';
const deviceB = '44444444-4444-4444-8444-444444444444';
const thread = '55555555-5555-4555-8555-555555555555';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ sidebar = false, deferSidebarHeaders = false } = {}) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } get childNodes() { return this.children; }
    addEventListener(type, fn) { this.listeners[type] = fn; } setAttribute() {} getBoundingClientRect() { return {top:0,bottom:100}; } querySelector() { return null; } querySelectorAll() { return []; }
  }
  const nodes = new Map(), requests = [], broadcasts = [], listeners = new Map(), revoked = [], timers = new Set(), streams = [], sidebarHeaders = [];
  const devices = [{ hostId: hostA, deviceId: deviceA, name: 'A' }, { hostId: hostB, deviceId: deviceB, name: 'B' }];
  let currentDeviceId = deviceA, pendingFetch = [], hold = false, mutationStatus = 200, deviceReadFailures = 0, hostOnline = null;
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  const context = vm.createContext({ document, AbortController, TextDecoder, TextEncoder, Response, Blob, URL: {revokeObjectURL(url) {revoked.push(url);}}, sessionStorage: { removeItem() {} }, window: { addEventListener(type, fn) { listeners.set(type, fn); } },
    setTimeout(fn, ms) { const timer = {fn, ms, unref() {}}; timers.add(timer); return timer; }, clearTimeout(timer) {timers.delete(timer);}, location: { reload() { throw new Error('must not reload pending state'); } },
    BroadcastChannel: class { postMessage(message) { broadcasts.push(message); } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (sidebar && url === '/api/sidebar/events') {
        let controller; const entry = {cancelled:false, signal:options.signal};
        const body = new ReadableStream({start(value) {controller=value;},cancel(){entry.cancelled=true;}});
        entry.send = value => controller.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
        entry.close = () => controller.close(); entry.error = () => controller.error(new Error('network'));
        streams.push(entry);
        const response = new Response(body, {headers:{'content-type':'text/event-stream'}});
        if (deferSidebarHeaders) return new Promise(resolve => sidebarHeaders.push(status => resolve(status === 200 ? response : Response.json({error:'device-changed'},{status}))));
        return response;
      }
      if (url === '/api/devices') { if(deviceReadFailures-- > 0) return Response.json({error:'unavailable'},{status:503}); return Response.json({ devices, currentDeviceId }); }
      if (url === '/api/devices/select') { if (mutationStatus === 200) currentDeviceId = JSON.parse(options.body).deviceId; return Response.json({}, {status:mutationStatus}); }
      if (url === '/api/devices/remove') return Response.json({}, {status:mutationStatus});
      if (hold && (['/api/delayed','/api/chats','/api/host-status'].includes(url) || ['/messages','/model','/mode','/stop'].some(suffix => url.endsWith(suffix)))) return new Promise(resolve => { pendingFetch.push(resolve); });
      if (url === '/api/host-status' && hostOnline !== null) return Response.json({online:hostOnline});
      return Response.json({ projects: [], recent: [] });
    } });
  vm.runInContext(source, context); await tick();
  return { nodes, requests, broadcasts, listeners, revoked, timers, streams, sidebarHeaders, run: code => vm.runInContext(code, context), setDevice(id) { currentDeviceId = id; }, removeAllDevices() {devices.length=0;currentDeviceId=null;},
    failMutations() { mutationStatus = 500; }, failNextDeviceRead() {deviceReadFailures=1;}, setHostOnline(value) {hostOnline=value;}, hold() { hold = true; }, release(value) { pendingFetch.shift()(value); } };
}
function seed(f) {
  f.run(`selectedId='${thread}';connected=true;active=new AbortController();let oldActive=active;recentViews.set(selectedId,{});modelCatalog=[{}];recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});drafts.set(selectedId,'private A');messageInput.value='private A';`);
}

test('device discovery invalidates old stream, selection, model, draft and cached chat before changing scope', async () => {
  const f = await fixture(); seed(f); f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('oldActive.signal.aborted'), true);
  assert.equal(f.run('selectedId'), null);
  assert.equal(f.run('recentViews.size'), 0);
  assert.equal(f.run('modelCatalog.length'), 0);
  assert.equal(f.nodes.get('#message').value, '');
  assert.equal(f.run('historyScope.deviceId'), deviceB);
});

test('successful selection broadcasts once; receiving it does not broadcast or reload', async () => {
  const f = await fixture(); seed(f);
  await f.nodes.get('#device-list').children[1].children[0].listeners.click();
  assert.deepEqual(f.broadcasts.map(x => x.type), ['device-changed']);
  f.run(`deviceChannel.onmessage({data:{type:'device-changed'}})`); await tick();
  assert.equal(f.broadcasts.length, 1);
  assert.equal(f.run('historyScope.deviceId'), deviceB);
});

test('old scope response is rejected and cannot reset the new device', async () => {
  const f = await fixture(); f.hold();
  const response = f.run(`scopedFetch('/api/delayed').then(()=> 'accepted', error=>error.name)`);
  await tick(); f.setDevice(deviceB); await f.run('loadDevices()');
  f.release(Response.json({ error: 'device-changed' }, { status: 409 }));
  assert.equal(await response, 'AbortError');
  assert.equal(f.run('historyScope.deviceId'), deviceB);
});

test('external switch retains unknown creation and existing-send protection without exposing old draft', async () => {
  const f = await fixture(); seed(f);
  f.run(`newDraft={projectId:'projectA',text:'private creation',attachments:[],uncertain:true,requestId:'original-request'};messageInput.value=newDraft.text;submissions.set('${thread}',{uncertain:true});`);
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('newDraft'), null);
  assert.equal(f.nodes.get('#message').value, '');
  assert.equal(f.run('submissions.size'), 0);
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.equal(f.run(`submissions.get('${thread}').uncertain`), true);
  assert.equal(f.run('newDraft.uncertain'), true);
  assert.equal(f.run('newDraft.requestId'), 'original-request');
  assert.equal(f.nodes.get('#message').value, 'private creation');
  assert.equal(f.requests.some(r => r.options.method === 'POST' && r.url !== '/api/threads'), false);
});


test('successful removal notifies siblings; failed changes and choosing current device do not', async () => {
  const f = await fixture();
  await f.nodes.get('#device-list').children[0].children[0].listeners.click();
  assert.equal(f.broadcasts.length, 0);
  f.failMutations();
  await f.nodes.get('#device-list').children[1].children[0].listeners.click();
  await f.nodes.get('#device-list').children[1].children[1].listeners.click();
  assert.equal(f.broadcasts.length, 0);
  const g = await fixture();
  await g.nodes.get('#device-list').children[1].children[1].listeners.click();
  assert.deepEqual(g.broadcasts.map(x => x.type), ['device-changed']);
});

test('in-flight creation cannot reopen the old chat after external switch and never resubmits', async () => {
  const f = await fixture(); f.hold();
  f.run(`connected=true;newDraft={projectId:'projectA',text:'private creation',attachments:[],pending:false,requestId:'original-request'};messageInput.value=newDraft.text;`);
  const send = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}});
  await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  f.release(Response.json({threadId:'${thread}'})); await send;
  assert.equal(f.run('selectedId'), null);
  assert.equal(f.run('newDraft'), null);
  assert.equal(f.run('historyScope.deviceId'), deviceB);
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.equal(f.run('newDraft.pending'), false);
  assert.equal(f.run('newDraft.uncertain'), true);
  assert.equal(f.run('newDraft.requestId'), 'original-request');
  assert.equal(f.requests.filter(r => r.url === '/api/chats').length, 1);
  assert.equal(f.requests.some(r => r.url.endsWith('/messages')), false);
});


test('restored page reads the device before reconnecting and refreshing its task list', async () => {
  const f = await fixture(); seed(f); f.setDevice(deviceB);
  await f.listeners.get('pageshow')({persisted:true}); await tick();
  assert.equal(f.run('oldActive.signal.aborted'), true);
  assert.equal(f.run('selectedId'), null);
  assert.equal(f.run('historyScope.deviceId'), deviceB);
  const lastDevices = f.requests.findLastIndex(r => r.url === '/api/devices');
  const refreshed = f.requests.slice(lastDevices + 1).filter(r => r.url.startsWith('/api/') && !r.url.startsWith('/api/devices'));
  assert.ok(refreshed.length > 0);
  assert.ok(refreshed.every(r => r.options.headers?.['x-codex-expected-device'] === deviceB));
});

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function restoreFirst(f) {
  const button = descendants(f.run('outgoingList')).find(node => node.className === 'outgoing-edit');
  assert.ok(button, 'retained message has a manual draft recovery action');
  button.listeners.click();
}

test('external round trip retains unknown and queued messages with attachments for manual recovery only', async () => {
  const f = await fixture(); seed(f); f.hold();
  f.run(`messageInput.value='first dispatched'`);
  const pending = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}}); await tick();
  f.run(`imageUploadAvailable=true;messageInput.value='second queued';imageDrafts.set(selectedId,[{kind:'image',url:'blob:queued',file:Object.assign(new Blob(['image']),{name:'queued.png'})}])`);
  const queued = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}}); await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('outgoingList.hidden'), true);
  f.setDevice(deviceA); await f.run('loadDevices()');
  f.run(`selectedId='${thread}';connected=true;renderOutgoingMessages();syncOutgoingWithView({id:selectedId,turns:[]})`); await tick();
  assert.equal(f.run('outgoingMessages.get(outgoingScopeKey()).length'), 2);
  assert.equal(f.run('outgoingMessages.get(outgoingScopeKey())[0].state'), 'unknown');
  assert.equal(f.run('outgoingMessages.get(outgoingScopeKey())[1].images[0].url'), 'blob:queued');
  assert.equal(f.requests.filter(r => r.url.endsWith('/messages')).length, 1);
  assert.deepEqual(f.revoked, []);
  restoreFirst(f); restoreFirst(f);
  assert.equal(f.nodes.get('#message').value, 'first dispatched\nsecond queued');
  assert.equal(f.run('imageDrafts.get(selectedId)[0].url'), 'blob:queued');
  assert.equal(f.run('outgoingMessages.has(outgoingScopeKey())'), false);
  f.release(Response.json({}, {status:202})); await pending; await queued; await tick();
  assert.equal(f.requests.filter(r => r.url.endsWith('/messages')).length, 1);
  assert.deepEqual(f.revoked, []);
});

test('external device round trip preserves ordinary text and attachment drafts without exposing them on another device', async () => {
  const f = await fixture(); seed(f);
  f.run(`imageDrafts.set(selectedId,[{kind:'image',url:'blob:draft',file:Object.assign(new Blob(['draft']),{name:'draft.png'})}])`);
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('drafts.size'), 0); assert.equal(f.run('imageDrafts.size'), 0);
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.equal(f.run(`drafts.get('${thread}')`), 'private A');
  assert.equal(f.run(`imageDrafts.get('${thread}')[0].url`), 'blob:draft');
  assert.deepEqual(f.revoked, []);
});

test('business requests bind to the displayed device while another tab has changed the shared cookie', async () => {
  const f = await fixture(); seed(f);
  f.setDevice(deviceB); // Cookie changed, but the sibling broadcast has not arrived.
  await f.run('loadThreads()');
  const list = f.requests.filter(r => r.url === '/api/threads').at(-1);
  assert.equal(list.options.headers['x-codex-expected-device'], deviceA);
  await f.run(`connect('${thread}')`);
  const events = f.requests.filter(r => r.url.endsWith('/events')).at(-1);
  assert.equal(events.options.headers['x-codex-expected-device'], deviceA);
  f.run(`connected=true;activeTurnId='turn-A';recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});`);
  await f.nodes.get('#stop-turn').listeners.click();
  const stop = f.requests.filter(r => r.url.endsWith('/stop')).at(-1);
  assert.ok(stop);
  assert.equal(stop.options.headers['x-codex-expected-device'], deviceA);
});

test('a response body finishing after a device switch is rejected before its payload reaches the caller', async () => {
  const f = await fixture(); f.hold();
  const pending = f.run(`scopedFetch('/api/delayed')`); await tick();
  let finishBody;
  const body = new ReadableStream({start(controller) { finishBody = () => {controller.enqueue(new TextEncoder().encode('{"private":"A"}'));controller.close();}; }});
  f.release(new Response(body, {headers:{'content-type':'application/json'}}));
  const response = await pending;
  const reading = response.json().then(() => 'accepted', error => error.name);
  f.setDevice(deviceB); await f.run('loadDevices()'); finishBody();
  assert.equal(await reading, 'AbortError');
});

test('a late old worker cannot remove the worker created by an explicit send after returning to the device', async () => {
  const f = await fixture(); seed(f); f.hold(); f.run(`messageInput.value='first dispatched'`);
  const old = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}}); await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  f.setDevice(deviceA); await f.run('loadDevices()');
  f.run(`selectedId='${thread}';connected=true;renderOutgoingMessages()`);
  restoreFirst(f);
  const fresh = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}}); await tick();
  assert.equal(f.requests.filter(r => r.url.endsWith('/messages')).length, 2);
  f.run(`let freshWorker=outgoingWorkers.get(outgoingScopeKey())`);
  f.release(Response.json({}, {status:202})); await old; await tick();
  assert.equal(f.run('outgoingWorkers.get(outgoingScopeKey())===freshWorker'), true);
  assert.equal(f.run('outgoingMessages.get(outgoingScopeKey()).length'), 1);
  f.release(Response.json({}, {status:202})); await fresh;
  assert.equal(f.run('outgoingMessages.has(outgoingScopeKey())'), false);
});


for (const kind of ['model', 'mode']) test(`external device change preserves an uncertain ${kind} write guard and ignores its old completion`, async () => {
  const f = await fixture(); seed(f); f.hold();
  f.run(`liveRuntimeStatus='idle';modelCatalog=[{model:'target-model',supportedReasoningEfforts:['high']}];pendingModelChanges.set(selectedId,{model:'queued-model',effort:'low'});pendingModeChanges.set(selectedId,'plan');`);
  const operation = f.run(kind === 'model' ? "requestModelChange('target-model','high')" : "applyModeChange(selectedId,'plan')"); await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('modelChanges.size+modeChanges.size+pendingModelChanges.size+pendingModeChanges.size'), 0);
  f.setDevice(deviceA); await f.run('loadDevices()');
  f.run(`selectedId='${thread}';connected=true`);
  assert.equal(f.run('outgoingWriteBlocked(selectedId)'), true);
  const map = kind === 'model' ? 'modelChanges' : 'modeChanges';
  assert.match(f.run(`${map}.get(selectedId).message`), /未知/);
  f.release(Response.json({}, {status:202})); await operation;
  assert.match(f.run(`${map}.get(selectedId).message`), /未知/);
  assert.equal(f.run('pendingModelChanges.get(selectedId).model'), 'queued-model');
  assert.equal(f.run('pendingModeChanges.get(selectedId)'), 'plan');
});


test('sidebar fetch binds device and decodes split UTF8, CRLF and multiple SSE events while renewing heartbeat', async () => {
  const f = await fixture({sidebar:true});
  const request = f.requests.find(r => r.url === '/api/sidebar/events');
  assert.equal(request.options.headers['x-codex-expected-device'], deviceA);
  const originalWatchdog = f.run('sidebarWatchdog');
  const bytes = new TextEncoder().encode(`: 中文注释\r\nevent: sidebar-status\r\ndata: {"${thread}":"active"}\r\n\r\nevent: sidebar-heartbeat\ndata: {}\n\nevent: thread-list-changed\ndata: {}\n\n`);
  for (const byte of bytes) f.streams[0].send(Uint8Array.of(byte));
  await tick(); await tick();
  assert.equal(f.run(`sidebarStatusSnapshot.get('${thread}')`), 'active');
  assert.notEqual(f.run('sidebarWatchdog'), originalWatchdog);
  assert.equal(f.timers.has(originalWatchdog), false);
  assert.equal(f.run('sidebarWatchdog.ms'), 45000);
  const listTimer = f.run('listChangeTimer'); assert.equal(listTimer.ms, 100);
  const before = f.requests.filter(r => r.url === '/api/threads').length;
  listTimer.fn(); await tick(); assert.equal(f.requests.filter(r => r.url === '/api/threads').length, before + 1);
  f.run('stopSidebarStatuses()'); await tick();
  assert.equal(f.streams[0].cancelled, true);
});

test('sidebar disconnect reconnects with bounded backoff, and valid heartbeat resets the delay', async () => {
  const f = await fixture({sidebar:true});
  f.streams[0].close(); await tick();
  assert.equal(f.run('sidebarWatchdog.ms'), 1000);
  f.run('sidebarWatchdog.fn()'); await tick();
  assert.equal(f.streams.length, 2);
  f.streams[1].error(); await tick();
  assert.equal(f.run('sidebarWatchdog.ms'), 2000);
  f.run('sidebarWatchdog.fn()'); await tick();
  f.streams[2].send('event: sidebar-heartbeat\ndata: {}\n\n'); await tick();
  f.streams[2].close(); await tick();
  assert.equal(f.run('sidebarWatchdog.ms'), 1000);
  f.run('stopSidebarStatuses()');
});

test('sidebar watchdog replaces a silent stream and device switch discards queued old events', async () => {
  const f = await fixture({sidebar:true});
  f.run('sidebarWatchdog.fn()'); await tick();
  assert.equal(f.streams.length, 2); assert.equal(f.streams[0].signal.aborted, true);
  f.streams[1].send(`event: sidebar-status\ndata: {"${thread}":"active"}\n\n`);
  f.setDevice(deviceB); f.run('deviceChanged()'); await tick(); await tick();
  assert.equal(f.streams[1].signal.aborted, true);
  assert.equal(f.run(`sidebarStatusSnapshot.has('${thread}')`), false);
  assert.equal(f.requests.filter(r => r.url === '/api/sidebar/events').at(-1).options.headers['x-codex-expected-device'], deviceB);
  f.run('stopSidebarStatuses()');
});

test('a stale sidebar 409 cannot invalidate a newer device subscription', async () => {
  const f = await fixture({sidebar:true,deferSidebarHeaders:true});
  f.setDevice(deviceB); f.run('deviceChanged()'); await tick();
  assert.equal(f.streams.length, 2);
  f.sidebarHeaders[1](200); await tick();
  f.streams[1].send(`event: sidebar-status\ndata: {"${thread}":"idle"}\n\n`); await tick();
  f.sidebarHeaders[0](409); await tick();
  assert.equal(f.run('historyScope.deviceId'), deviceB);
  assert.equal(f.streams[1].signal.aborted, false);
  assert.equal(f.run(`sidebarStatusSnapshot.get('${thread}')`), 'idle');
  assert.equal(f.streams.length, 2);
  f.run('stopSidebarStatuses()');
});

test('a current sidebar device conflict refreshes identity without reconnecting the old scope', async () => {
  const f = await fixture({sidebar:true,deferSidebarHeaders:true});
  f.setDevice(deviceB); f.sidebarHeaders[0](409); await tick(); await tick();
  assert.equal(f.run('historyScope.deviceId'), deviceB);
  assert.equal(f.streams.length, 2);
  assert.equal(f.requests.filter(r => r.url === '/api/sidebar/events').at(-1).options.headers['x-codex-expected-device'], deviceB);
  f.sidebarHeaders[1](200); await tick(); f.run('stopSidebarStatuses()');
});

test('ordinary new-chat drafts on two devices retain independent text and attachments', async () => {
  const f = await fixture();
  f.run(`newDraft={projectId:'A-project',text:'A draft',attachments:[{url:'blob:A',file:Object.assign(new Blob(['A']),{name:'A.png'})}]};messageInput.value=newDraft.text`);
  f.setDevice(deviceB); await f.run('loadDevices()');
  f.run(`newDraft={projectId:'B-project',text:'B draft',attachments:[{url:'blob:B',file:Object.assign(new Blob(['B']),{name:'B.png'})}]};messageInput.value=newDraft.text`);
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.equal(f.run('newDraft.text'), 'A draft'); assert.equal(f.run('newDraft.attachments[0].url'), 'blob:A');
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('newDraft.text'), 'B draft'); assert.equal(f.run('newDraft.attachments[0].url'), 'blob:B');
  assert.deepEqual(f.revoked, []);
});

test('mode unlock requires a live current unknown guard and leaves other protections and pending choices untouched', async () => {
  const f = await fixture(); seed(f);
  f.run(`modeChanges.set(selectedId,{target:'plan',uncertain:true,message:'切换结果未知'});submissions.set(selectedId,{uncertain:true});modelChanges.set(selectedId,{message:'模型未知'});pendingModeChanges.set(selectedId,'plan');updateComposer()`);
  assert.equal(f.run('unlockModeChange.hidden'), false);
  f.run('unlockModeChange.listeners.click()');
  assert.equal(f.run('modeChanges.has(selectedId)'), false);
  assert.equal(f.run('submissions.get(selectedId).uncertain'), true);
  assert.equal(f.run('modelChanges.has(selectedId)'), true);
  assert.equal(f.run('pendingModeChanges.get(selectedId)'), 'plan');
  assert.equal(f.requests.some(r => r.url.endsWith('/mode')), false);
  for (const setup of ["connected=false;modeChanges.set(selectedId,{uncertain:true,message:'未知'})", "connected=true;modeChanges.set(selectedId,{message:'正在切换'})"]) {
    f.run(`${setup};updateComposer();unlockModeChange.listeners.click()`);
    assert.equal(f.run('unlockModeChange.hidden'), true);
    assert.equal(f.run('modeChanges.has(selectedId)'), true);
  }
});

test('an old mode unlock target and a late old response cannot clear a new device mode guard', async () => {
  const f = await fixture(); seed(f); f.hold();
  const old = f.run("applyModeChange(selectedId,'plan')"); await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  f.run(`selectedId='${thread}';connected=true;modeChanges.set(selectedId,{target:'plan',uncertain:true,message:'B 模式未知'});updateComposer();let savedUnlock=modeUnlockTarget`);
  f.setDevice(deviceA); await f.run('loadDevices()');
  f.run(`selectedId='${thread}';connected=true;updateComposer();modeUnlockTarget=savedUnlock;unlockModeChange.listeners.click()`);
  assert.equal(f.run('modeChanges.has(selectedId)'), true);
  f.release(Response.json({}, {status:202})); await old;
  assert.equal(f.run('modeChanges.get(selectedId).uncertain'), true);
  f.run('updateComposer();unlockModeChange.listeners.click()');
  assert.equal(f.run('modeChanges.has(selectedId)'), false);
  assert.equal(f.requests.filter(r => r.url.endsWith('/mode')).length, 1);
});


test('new-chat drafts saved by opening an existing chat remain separate across devices', async () => {
  const f = await fixture();
  for (const device of [deviceA, deviceB]) {
    f.setDevice(device); await f.run('loadDevices()');
    f.run(`newDraft={projectId:'project',text:'draft-${device}',attachments:[{url:'blob:${device}',file:Object.assign(new Blob(['x']),{name:'x.png'})}]};messageInput.value=newDraft.text;renderTask({id:'${thread}',title:'existing'}).listeners.click()`);
    assert.equal(f.run('newDraft'), null);
  }
  f.setDevice(deviceA); await f.run('loadDevices()');
  f.nodes.get('#new-chat').listeners.click();
  assert.equal(f.nodes.get('#message').value, `draft-${deviceA}`);
  assert.equal(f.run('newDraft.attachments[0].url'), `blob:${deviceA}`);
  assert.deepEqual(f.revoked, []);
});


test('removing the last pairing in another tab clears the old chat and exposes pairing entry', async () => {
  const f = await fixture(); seed(f); f.removeAllDevices();
  f.run(`deviceChannel.onmessage({data:{type:'device-changed'}})`); await tick(); await tick();
  assert.equal(f.run('historyScope'), null); assert.equal(f.run('selectedId'), null);
  assert.equal(f.run('pairingAvailable'), false);
  assert.equal(f.nodes.get('#unpaired-control').hidden, false);
  assert.match(f.nodes.get('#unpaired-control').textContent, /去配对/);
});

test('an old stop completion cannot replace another device stop state for the same thread and turn', async () => {
  const f = await fixture(); seed(f); f.hold(); f.run("activeTurnId='same-turn'");
  const stopping = f.nodes.get('#stop-turn').listeners.click(); await tick();
  f.setDevice(deviceB); await f.run('loadDevices()');
  assert.equal(f.run('stops.size'), 0);
  f.run(`selectedId='${thread}';activeTurnId='same-turn';stops.set(selectedId,{turnId:activeTurnId,pending:true,message:'B stop'})`);
  f.release(Response.json({}, {status:202})); await stopping;
  assert.equal(f.run('stops.get(selectedId).message'), 'B stop');
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.match(f.run(`stops.get('${thread}').message`), /未知/);
});


test('a transient device lookup failure after a sibling switch retries without losing old unknown state', async () => {
  const f = await fixture(); seed(f);
  f.run(`newDraft={projectId:'A-project',text:'A unknown',attachments:[],uncertain:true,requestId:'original'};messageInput.value=newDraft.text`);
  f.setDevice(deviceB); f.failNextDeviceRead(); f.run('deviceChanged()'); await tick();
  assert.equal(f.run('historyScope'), null);
  assert.equal(f.run('pairingAvailable'), true);
  assert.equal(f.run('deviceIdentityRetryTimer.ms'), 5000);
  f.run('deviceIdentityRetryTimer.fn()'); await tick(); await tick();
  assert.equal(f.run('historyScope.deviceId'), deviceB);
  assert.equal(f.run('newDraft'), null);
  f.setDevice(deviceA); await f.run('loadDevices()');
  assert.equal(f.run('newDraft.requestId'), 'original');
  assert.equal(f.run('newDraft.uncertain'), true);
});

test('a sibling notification with unchanged current device leaves an in-flight send and draft intact', async () => {
  const f = await fixture(); seed(f); f.hold(); f.run("messageInput.value='A active send'");
  const send = f.nodes.get('#composer-form').listeners.submit({preventDefault(){}}); await tick();
  f.run(`messageInput.value='A next draft';drafts.set(selectedId,messageInput.value);let sendingEntry=outgoingMessages.get(outgoingScopeKey())[0];let sendingController=sendingEntry.controller`);
  f.run(`deviceChannel.onmessage({data:{type:'device-changed'}})`); await tick(); await tick();
  assert.equal(f.run('oldActive.signal.aborted'), false);
  assert.equal(f.run('sendingController.signal.aborted'), false);
  assert.equal(f.run('sendingEntry.state'), 'sending');
  assert.equal(f.nodes.get('#message').value, 'A next draft');
  assert.equal(f.run('selectedId'), thread);
  f.release(Response.json({}, {status:202})); await send;
});

for (const action of ['select','remove']) test(`successful ${action} retries a temporary post-action device lookup failure`, async () => {
  const f = await fixture(); seed(f); f.failNextDeviceRead();
  const button = f.nodes.get('#device-list').children[1].children[action === 'select' ? 0 : 1];
  await button.listeners.click(); await tick();
  assert.equal(f.run('pairingAvailable'), true);
  assert.equal(f.run('deviceIdentityRetryTimer.ms'), 5000);
  f.run('deviceIdentityRetryTimer.fn()'); await tick(); await tick();
  assert.equal(f.run('historyScope.deviceId'), action === 'select' ? deviceB : deviceA);
  assert.equal(f.broadcasts.length, 1);
});


test('same-device identity retry preserves host polling and later detects the computer going offline', async () => {
  const f = await fixture(); f.setHostOnline(true); await f.run('refreshHostStatus()');
  const poll = f.run('hostStatusTimer'); assert.equal(poll.ms, 20000);
  f.failNextDeviceRead(); f.run(`deviceChannel.onmessage({data:{type:'device-changed'}})`); await tick();
  assert.equal(f.run('hostStatusTimer'), poll);
  assert.equal(f.timers.has(poll), true);
  assert.equal(f.run('deviceIdentityRetryTimer.ms'), 5000);
  f.run('deviceIdentityRetryTimer.fn()'); await tick(); await tick();
  assert.equal(f.run('deviceIdentityRetryTimer'), undefined);
  assert.equal(f.run('hostStatusTimer'), poll);
  f.setHostOnline(false); poll.fn(); await tick();
  assert.equal(f.nodes.get('#connection').textContent, '电脑未连接');
  assert.equal(f.run('hostStatusTimer.ms'), 20000);
});

test('an in-flight host status response cannot replace a pending device identity retry', async () => {
  const f = await fixture(); f.hold();
  const host = f.run('refreshHostStatus()'); await tick();
  f.failNextDeviceRead(); f.run(`deviceChannel.onmessage({data:{type:'device-changed'}})`); await tick();
  const retry = f.run('deviceIdentityRetryTimer'); assert.equal(retry.ms, 5000);
  f.release(Response.json({online:true})); await host;
  assert.equal(f.run('deviceIdentityRetryTimer'), retry);
  assert.equal(f.run('hostStatusTimer.ms'), 20000);
  retry.fn(); await tick(); await tick();
  assert.equal(f.run('deviceIdentityRetryTimer'), undefined);
  assert.equal(f.run('historyScope.deviceId'), deviceA);
});
