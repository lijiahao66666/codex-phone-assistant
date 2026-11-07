import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

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
  f.run(`connected=true;streamView={id:selectedId,runtimeStatus:'idle',turns:[{id:'latest',status:'completed',items:[{id:'recent',type:'userMessage',text:'recent'}]}],requests:[],history:{historicalHash:'hash',keyField:'id',cursor:null,complete:false}};loadedHistory={hash:'hash',turns:[],nextBefore:null,complete:false};showState(streamView)`);
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
