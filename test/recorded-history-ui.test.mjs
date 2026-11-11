import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { desktopView } from '../src/desktop/view.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (n, text = `message ${n}`) => ({ id: `item-${n}`, type: 'userMessage', text });
const turn = (id, items) => ({ id, status: 'completed', items });
const page = (turns, nextCursor = null) => ({ id, title: 'History', turns, requests: [], runtimeStatus: 'unknown', history: { readOnly: true, complete: false, olderComplete: nextCursor === null }, nextCursor, page: { items: turns.reduce((n,t) => n+t.items.length,0), turns: turns.length, bytes: 100 } });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value, clone: () => ({json: async () => value}) });
async function fixture(handler) {
  class Element {
    constructor() { this.children=[];this.dataset={};this.listeners={};this.value='';this.style={};this.classList={toggle(){},contains(){return false;}};this.scrollHeight=1000;this.clientHeight=500;this.scrollTop=120; }
    addEventListener(type, fn) { this.listeners[type] = fn; } setAttribute() {} append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children=nodes; } get childNodes() { return this.children; } querySelectorAll() { return []; } after() {} before() {}
  }
  const nodes=new Map(),requests=[];
  const document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const context=vm.createContext({document,AbortController,URLSearchParams,TextDecoder,TextEncoder,Date,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async (url, options={}) => {
    requests.push({url,options});
    if (url.includes('/recorded-history')) return handler(url,options);
    return response({projects:[],recent:[]});
  }});
  const run=code=>vm.runInContext(code,context);
  run(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'));await tick();
  run(`selectedId='${id}';historyScope={hostId:'host',deviceId:'device'};currentDeviceId='device';connected=false;streamView=null;recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});`);
  return {nodes,requests,run,show:value=>run(`showState(${JSON.stringify(value)},false)`),load:()=>run('loadEarlierPage()')};
}
const flat=node=>[node,...node.children.flatMap(flat)];
const rendered=f=>flat(f.nodes.get('#turns')).map(node=>node.textContent||'').filter(Boolean);

test('ownerless history pages the same large turn without duplicate items while controls stay read-only',async()=>{
  const chunks=[page([turn('long',Array.from({length:200},(_,n)=>item(n+202)))],'older-1'),page([turn('long',Array.from({length:200},(_,n)=>item(n+3)))],'older-2'),page([turn('long',[item(1),item(2),item(3)])])];
  const f=await fixture(url=>response(url.includes('older-1')?chunks[1]:chunks[2]));
  f.show(chunks[0]);assert.equal(f.run('historyCanLoad'),true);assert.equal(f.run('connected'),false);
  await f.load();await f.load();
  assert.equal(f.requests.filter(r=>r.url.includes('/recorded-history')).length,2);
  assert.equal(f.run('recordedHistory.turns.length'),1);assert.equal(f.run('recordedHistory.turns[0].items.length'),401);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(recordedHistory.turns[0].items.map(item=>item.id))')),Array.from({length:401},(_,n)=>`item-${n+1}`));
  assert.equal(f.run('historyCanLoad'),false);assert.equal(f.run('activeTurnId'),null);assert.equal(f.nodes.get('#message').disabled,true);
  assert.ok(rendered(f).includes('message 1'));assert.ok(rendered(f).includes('message 401'));
});

test('live state keeps loaded old items but exclusively supplies controls, pending questions and current item values',async()=>{
  const f=await fixture(()=>response(page([])));
  f.show(page([{id:'recorded-only',status:'inProgress',items:[{id:'old-question',type:'agentMessage',text:'old?',questions:[{id:'q',question:'old?',options:[]}]}]},turn('shared',[item(1,'old value'),item(2)])],'more'));
  const live={id,title:'Live',runtimeStatus:'active',model:'live-model',reasoningEffort:'high',collaborationMode:'plan',requests:[],history:{complete:false},turns:[{id:other,status:'inProgress',items:[item(3)]},turn('shared',[item(2,'live value')])]};
  f.run(`streamView=${JSON.stringify(live)};showState(streamView)`);
  assert.equal(f.run('activeTurnId'),other);assert.equal(f.run('liveModel.model'),'live-model');assert.equal(f.run('liveRuntimeStatus'),'active');
  assert.equal(f.run('questionPanel.hidden'),true);assert.equal(f.run('streamView.turns.length'),2);assert.equal(f.run('streamView.requests.length'),0);
  assert.ok(rendered(f).includes('old value'));assert.ok(rendered(f).includes('live value'));assert.equal(rendered(f).filter(value=>value==='message 2').length,0);
  // No live turn can be invented from a recorded in-progress status.
  f.run(`streamView={id:selectedId,runtimeStatus:'idle',turns:[],requests:[],history:{complete:false}};showState(streamView)`);
  assert.equal(f.run('activeTurnId'),null);assert.equal(f.run('questionPanel.hidden'),true);
});

test('exhausted IPC history continues with indexed history without changing its control source',async()=>{
  const f=await fixture(()=>response(page([turn('older',[item(1)])])));
  f.run(`connected=true;streamView={id:selectedId,runtimeStatus:'idle',turns:[{id:'latest',status:'completed',items:[{id:'recent',type:'userMessage',text:'recent'}]}],requests:[],history:{historicalHash:'hash',keyField:'id',cursor:null,complete:false,reason:'history-paginated'}};loadedHistory={hash:'hash',turns:[],nextBefore:null,complete:false};showState(streamView)`);
  f.run('loadedHistory.complete=true;showState(streamView)');assert.equal(f.run('historyCanLoad'),false);
  f.run('loadedHistory.complete=false;showState(streamView)');assert.equal(f.run('historyCanLoad'),true);await f.load();
  assert.equal(f.requests.filter(r=>r.url.includes('/history-page?')).length,0);assert.equal(f.requests.filter(r=>r.url.includes('/recorded-history')).length,1);
  assert.ok(rendered(f).includes('message 1'));assert.ok(rendered(f).includes('recent'));assert.equal(f.run('streamView.turns.length'),1);assert.equal(f.run('liveRuntimeStatus'),'idle');
});

test('a late recorded page merges into the latest live state instead of replacing runtime or messages',async()=>{
  let release;
  const f=await fixture(()=>new Promise(resolve=>{release=resolve;}));
  f.show(page([turn('old',[item(2)])],'cursor'));
  const work=f.load();await tick();
  f.run(`streamView={id:selectedId,title:'Live now',runtimeStatus:'active',model:'new-model',requests:[],turns:[{id:'new',status:'completed',items:[{id:'new-message',type:'userMessage',text:'live latest'}]}],history:{complete:false}};showState(streamView)`);
  release(response(page([turn('old',[item(1)])])));await work;
  assert.ok(rendered(f).includes('live latest'));assert.ok(rendered(f).includes('message 1'));assert.equal(f.run('liveModel.model'),'new-model');assert.equal(f.run('liveRuntimeStatus'),'active');
});

test('task and device changes abort a recorded page and ignore its late result',async()=>{
  for(const device of [false,true]) {
    let release,signal;
    const f=await fixture((url,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});});
    f.show(page([turn('old',[item(2)])],'cursor'));const work=f.load();await tick();
    if(device) f.run("resetHistoryScope();historyScope={hostId:'new-host',deviceId:'new-device'}");
    else f.run(`selectedId='${other}';clearConversation()`);
    assert.equal(signal.aborted,true);release(response(page([turn('old',[item(1)])])));await work;
    assert.equal(f.run('recordedHistory'),null);assert.equal(f.run('historyRequest'),null);
  }
});

test('expired cursors keep loaded history until explicit refresh and refresh replaces stale items',async()=>{
  let calls=0;
  const f=await fixture(url=>{calls++;return calls===1?response({error:'history-changed'},409):response(page([turn('fresh',[item(9,'fresh current')])]));});
  f.show(page([turn('old',[item(1,'stale text')])],'expired'));await f.load();
  assert.equal(f.run('recordedHistory.stale'),true);assert.equal(f.run('loadEarlier.hidden'),false);assert.equal(f.run('loadEarlier.textContent'),'历史已变化，刷新');assert.ok(rendered(f).includes('stale text'));
  await f.load();assert.equal(f.requests.filter(r=>r.url.includes('/recorded-history'))[1].url,`/api/threads/${id}/recorded-history`);
  assert.ok(rendered(f).includes('fresh current'));assert.equal(rendered(f).includes('stale text'),false);assert.equal(f.run('recordedHistory.stale'),false);
});

test('recorded history and a live prompt share native identity without collapsing genuine repeated input', async () => {
  const content = [{ type: 'text', text: 'repeat' }];
  const initial = { type: 'userMessage', id: 'server-initial', text: 'repeat' };
  const followup = { type: 'userMessage', id: 'server-followup', text: 'repeat' };
  const answer = { type: 'agentMessage', id: 'answer', text: 'done' };
  const recorded = page([turn('shared', [initial, followup, answer])]);
  const liveTurn = { turnId: 'shared', status: 'completed', remodexInitialUserMessageId: initial.id,
    params: { input: content }, items: [{ ...followup, content }, answer] };
  const live = desktopView({ id, turns: [liveTurn] });
  const f = await fixture(() => response(recorded));
  const showLive = value => f.run(`streamView=${JSON.stringify(value)};showState(streamView)`);
  f.show(recorded); showLive(live);
  assert.deepEqual(rendered(f).filter(value => value === 'repeat'), ['repeat', 'repeat']);
  assert.equal(f.run('streamView.turns[0].items[0].id'), initial.id);
  // Retained canonical history and a fresh recorded page must keep the same
  // identity, rather than reintroducing a synthetic copy during refresh.
  const canonical = desktopView({ id, turnHistory: { kind: 'canonical', history: { isComplete: true,
    islands: [{ entries: [{ value: 'turn' }] }], entitiesByKey: { turn: liveTurn } } } });
  f.show(recorded); showLive(canonical); showLive(canonical);
  assert.deepEqual(rendered(f).filter(value => value === 'repeat'), ['repeat', 'repeat']);
});

test('canonical native prompt and recorded history render one row using their confirmed client correlation', async () => {
  const content = [{ type: 'text', text: 'current user sentence' }];
  const nativeTurn = { turnId: 'shared', params: { input: content, clientUserMessageId: 'client' }, items: [
    { type: 'userMessage', id: 'server-initial', clientId: 'client', content },
    { type: 'userMessage', id: 'real-repeat', clientId: 'another-client', content },
    { type: 'agentMessage', id: 'answer', text: 'done' },
  ] };
  const recorded = page([turn('shared', nativeTurn.items.map(item => ({ ...item, text: item.text || 'current user sentence' })))]);
  const live = desktopView({ id, turnHistory: { kind: 'canonical', history: { isComplete: true,
    islands: [{ entries: [{ value: 'native' }] }], entitiesByKey: { native: nativeTurn } } } });
  const f = await fixture(() => response(recorded));
  f.show(recorded);
  f.run(`streamView=${JSON.stringify(live)};showState(streamView);showState(streamView)`);
  assert.deepEqual(rendered(f).filter(text => text === 'current user sentence'), ['current user sentence', 'current user sentence']);
  assert.equal(f.run("streamView.turns[0].items.filter(item=>item.id==='server-initial').length"), 1);
  assert.equal(f.run("streamView.turns[0].items.filter(item=>item.id==='initial-user:shared').length"), 0);
});

test('acknowledged prompt replaces its retained synthetic placeholder and late recorded pages stay deduplicated', async () => {
  const f = await fixture(() => response(page([])));
  const live = desktopView({ id, turns: [{ turnId: 'shared', params: {
    input: [{ type: 'text', text: 'hello' }], clientUserMessageId: 'client' }, items: [
      { type: 'userMessage', id: 'server', clientId: 'client', content: [{ type: 'text', text: 'hello' }] },
      { type: 'agentMessage', id: 'answer', text: 'done' },
    ] }] });
  f.run(`const stale=[{id:'shared',items:[{id:'initial-user:shared',type:'userMessage',text:'hello'},{id:'answer',type:'agentMessage',text:'working'}]}];const accepted=${JSON.stringify(live.turns)};const acceptedMerge=mergeHistoryTurns(stale,accepted);const recordedMerge=mergeHistoryTurns([{id:'shared',items:[{id:'server',type:'userMessage',text:'hello'}]}],acceptedMerge);const repeatedMerge=mergeHistoryTurns(recordedMerge,accepted)`);
  for (const name of ['acceptedMerge', 'recordedMerge', 'repeatedMerge']) {
    assert.equal(f.run(`${name}[0].items.filter(item=>item.type==='userMessage').length`), 1);
    assert.equal(f.run(`${name}[0].items.find(item=>item.type==='userMessage').id`), 'server');
    assert.equal(f.run(`${name}[0].items.find(item=>item.type==='userMessage').initialPromptId`), 'initial-user:shared');
  }
});

test('recorded and live steering identities reconcile without collapsing genuinely repeated user messages', async () => {
  const f = await fixture(() => response(page([])));
  const content = [{ type: 'text', text: 'repeat' }];
  const live = desktopView({ id, turns: [{ turnId: 'shared', items: [
    { type: 'steeringUserMessage', id: 'local-steer', serverUserMessageId: 'server-steer', input: content },
    { type: 'agentMessage', id: 'answer', text: 'working' },
    { type: 'userMessage', id: 'different-real-message', content },
  ] }] });
  const recorded = page([turn('shared', [
    { type: 'userMessage', id: 'server-steer', text: 'repeat' },
    { type: 'agentMessage', id: 'answer', text: 'old answer' },
  ])]);
  f.show(recorded);
  f.run(`streamView=${JSON.stringify(live)};showState(streamView);showState(streamView)`);
  assert.deepEqual(rendered(f).filter(value => value === 'repeat'), ['repeat', 'repeat']);
  // Also reconcile an unacknowledged local row captured before the server ID
  // arrived, and an older page arriving after the live acknowledgement.
  f.run(`const pending=[{id:'shared',items:[{id:'local-steer',type:'userMessage',text:'repeat'}]}];const accepted=${JSON.stringify(live.turns)};const pendingMerged=mergeHistoryTurns(pending,accepted);const lateRecorded=mergeHistoryTurns(${JSON.stringify(recorded.turns)},pendingMerged)`);
  assert.equal(f.run("pendingMerged[0].items.filter(item=>item.type==='userMessage').length"), 2);
  assert.equal(f.run("lateRecorded[0].items.filter(item=>item.type==='userMessage').length"), 2);
  assert.equal(f.run("lateRecorded[0].items.filter(item=>item.id==='local-steer').length"), 1);
});

test('existing recorded alias duplicates collapse at the recorded position while late pages preserve neighboring items', async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const serverRow={id:'server',type:'userMessage',text:'repeat'};const acknowledged={id:'local',serverUserMessageId:'server',type:'userMessage',text:'repeat',images:['live-image']};const realRepeat={id:'real-repeat',type:'userMessage',text:'repeat'};const stale=[{id:'shared',items:[{id:'before'},serverRow,{id:'between'},acknowledged,realRepeat,{id:'after'}]}];const cleaned=mergeHistoryTurns(stale,[{id:'shared',items:[acknowledged,{id:'after'}]}]);const paged=mergeHistoryTurns([{id:'shared',items:[{id:'older'},serverRow,{id:'between'}]}],cleaned);const repeatCleaned=mergeHistoryTurns(paged,cleaned)`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(cleaned[0].items.map(item=>item.id))')), ['before','local','between','real-repeat','after']);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(paged[0].items.map(item=>item.id))')), ['older','before','local','between','real-repeat','after']);
  assert.equal(f.run("paged[0].items.filter(item=>item.text==='repeat').length"), 2);
  assert.deepEqual(JSON.parse(f.run("JSON.stringify(paged[0].items.find(item=>item.id==='local').images)")), ['live-image']);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(repeatCleaned)')), JSON.parse(f.run('JSON.stringify(paged)')));
});

test('live summaries update shared messages in recorded order and retain distinct repeated text and live image data', async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const recordedMessages=[{id:'first',type:'userMessage',text:'repeat',images:['stale-image']},{id:'second',type:'userMessage',text:'repeat'},{id:'reasoning',type:'reasoning',text:'thinking'},{id:'answer',type:'agentMessage',text:'old answer'}];const liveFirst={id:'first',type:'userMessage',text:'repeat',images:['live-image'],attachments:[{name:'photo.png'}]};const liveAnswer={id:'answer',type:'agentMessage',text:'updated answer'};const orderedMerge=mergeHistoryTurns([{id:'shared',items:recordedMessages}],[{id:'shared',items:[liveFirst,liveAnswer]}])`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(orderedMerge[0].items.map(item=>item.id))')), ['first','second','reasoning','answer']);
  assert.equal(f.run('orderedMerge[0].items[0]===liveFirst'), true);
  assert.equal(f.run('orderedMerge[0].items[3]===liveAnswer'), true);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(orderedMerge[0].items[0].images)')), ['live-image']);
  assert.equal(f.run("orderedMerge[0].items.filter(item=>item.text==='repeat').length"), 2);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(recordedMessages.map(item=>item.id))')), ['first','second','reasoning','answer']);
});

test('turn and item merges insert live-only entries beside anchors while preserving all recorded positions', async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const baseTurns=['first','queued','repeat','pictures'].map(id=>({id,items:[{id:id+'-old',text:id}]}));const summaryTurns=[{id:'first',items:[{id:'first-old',text:'live first'}]},{id:'between',items:[]},{id:'repeat',items:[]},{id:'newest',items:[]}];const turnMerge=mergeHistoryTurns(baseTurns,summaryTurns);const itemMerge=mergeHistoryTurns([{id:'shared',items:['a','recorded-b','c','recorded-tail'].map(id=>({id}))}],[{id:'shared',items:['prefix','a','between','c','suffix'].map(id=>({id}))}])`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(turnMerge.map(turn=>turn.id))')), ['first','queued','between','repeat','pictures','newest']);
  assert.equal(f.run('turnMerge[0].items[0].text'), 'live first');
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(itemMerge[0].items.map(item=>item.id))')), ['prefix','a','recorded-b','between','c','recorded-tail','suffix']);
  assert.deepEqual(JSON.parse(f.run(`JSON.stringify(mergeHistoryTurns([{id:'older',items:[]}],[{id:'newer',items:[]}]).map(turn=>turn.id))`)), ['older','newer']);
});

test('a live summary keeps recorded-only turns at their chronological positions and older pages prepend without reordering', async () => {
  const older = page([turn('before',[item(0)])]);
  const f = await fixture(() => response(older));
  f.show(page([turn('first',[item(1)]),turn('second',[item(2)]),turn('pictures',[item(3)])], 'earlier'));
  f.run(`streamView={id:selectedId,title:'Live',runtimeStatus:'idle',requests:[],history:{complete:false},turns:[{id:'first',items:[{id:'item-1',type:'userMessage',text:'live first'}]},{id:'second',items:[{id:'item-2',type:'userMessage',text:'live second'}]}]};showState(streamView)`);
  assert.deepEqual(rendered(f).filter(text=>['live first','live second','message 3'].includes(text)), ['live first','live second','message 3']);
  await f.load();
  assert.deepEqual(rendered(f).filter(text=>['message 0','live first','live second','message 3'].includes(text)), ['message 0','live first','live second','message 3']);
});

test('large overlapping histories retain ordered identity and pagination flags without quadratic scans', {timeout:2000}, async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const largeItems=Array.from({length:30000},(_,n)=>({id:'large-'+n,text:'recorded'}));const largeLive=largeItems.filter((_,n)=>n%2===0).map(item=>({...item,text:'live'}));const largeMerge=mergeHistoryTurns([{id:'large',items:largeItems,itemsPagination:{hasLoadedOldest:true,hasLoadedNewest:false}}],[{id:'large',items:largeLive,itemsPagination:{hasLoadedOldest:false,hasLoadedNewest:true}}])`);
  assert.equal(f.run('largeMerge[0].items.length'), 30000);
  assert.equal(f.run("largeMerge[0].items.every((item,index)=>item.id==='large-'+index && item.text===(index%2===0?'live':'recorded'))"), true);
  assert.equal(f.run('largeMerge[0].itemsPagination.hasLoadedOldest'), true);
  assert.equal(f.run('largeMerge[0].itemsPagination.hasLoadedNewest'), true);
});

test('recorded anchors win conflicting summary order and repeated merges keep stable IDs without text-based inference', async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const anchorBase=[{id:'a',items:[{id:'first',text:'repeat'},{id:'steer',text:'repeat'},{id:'reasoning',type:'reasoning',text:'reason'},{id:'answer',text:'answer'}]},{id:'b',items:[]},{id:'c',items:[]}];const anchorLive=[{id:'c',items:[]},{id:'live-between-conflicting',items:[]},{id:'a',items:[{id:'first',text:'repeat'},{id:'steer',text:'repeat'},{id:'answer',text:'live answer'}]}];const anchorMerged=mergeHistoryTurns(anchorBase,anchorLive);const anchorAgain=mergeHistoryTurns(anchorMerged,anchorLive)`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(anchorMerged.map(turn=>turn.id))')), ['live-between-conflicting','a','b','c']);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(anchorAgain)')), JSON.parse(f.run('JSON.stringify(anchorMerged)')));
  assert.deepEqual(JSON.parse(f.run("JSON.stringify(anchorMerged.find(turn=>turn.id==='a').items.map(item=>item.id))")), ['first','steer','reasoning','answer']);
  f.run(`const anonymousMerge=mergeHistoryTurns([{items:[{text:'same'}]},{id:'shared',items:[{text:'same'}]}],[{items:[{text:'same'}]},{id:'shared',items:[{text:'same'}]}])`);
  assert.equal(f.run('anonymousMerge.length'), 3);
  assert.equal(f.run("anonymousMerge.find(turn=>turn.id==='shared').items.length"), 2);
});

test('duplicate shared anchors retain every live-only segment once and use the latest live object', async () => {
  const f = await fixture(() => response(page([])));
  f.run(`const duplicateOld=[{id:'a'},{id:'b'}];const latestA={id:'a',text:'latest'};const duplicateLive=[{id:'x'},{id:'a',text:'earlier'},{id:'y'},latestA,{id:'b'}];const duplicateMerge=mergeHistoryTurns([{id:'shared',items:duplicateOld}],[{id:'shared',items:duplicateLive}]);const repeatedOld=mergeHistoryTurns([{id:'shared',items:[{id:'a'},{text:'anonymous old'},{id:'b'},{id:'a'}]}],[{id:'shared',items:[{id:'x'},{text:'anonymous live'},{id:'a',text:'latest'},{id:'b'}]}])`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(duplicateMerge[0].items.map(item=>item.id))')), ['x','y','a','b']);
  assert.equal(f.run('duplicateMerge[0].items[2]===latestA'), true);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(repeatedOld[0].items.map(item=>item.id||item.text))')), ['x','anonymous live','a','anonymous old','b','a']);
  assert.equal(f.run("repeatedOld[0].items.filter(item=>item.id==='x').length"), 1);
  assert.equal(f.run("repeatedOld[0].items.filter(item=>item.id==='a' && item.text==='latest').length"), 2);
  f.run(`const duplicateTurns=mergeHistoryTurns([{id:'a',items:[]},{id:'b',items:[]}],[{id:'x',items:[]},{id:'a',items:[]},{id:'y',items:[]},{id:'a',items:[]},{id:'b',items:[]}])`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(duplicateTurns.map(turn=>turn.id))')), ['x','y','a','b']);
});
