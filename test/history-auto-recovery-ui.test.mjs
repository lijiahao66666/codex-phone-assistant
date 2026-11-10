import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const id='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(value={},status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,clone:()=>({json:async()=>value})});
async function fixture(handler, { stubLoadThreads = true, manualRecoveryTimers = false, manualHandoverTimers = false, manualRequestTimers = false } = {}) {
  class Element {
    constructor(){this.children=[];this.listeners={};this.dataset={};this.value='';this.style={};this.classList={toggle(){},contains(){return false;}};this.scrollHeight=300;this.clientHeight=500;this.scrollTop=0;}
    getBoundingClientRect(){return this.rect||{top:0,bottom:500,left:0,right:250,width:250,height:500};}
    addEventListener(type,fn){this.listeners[type]=fn;}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}get childNodes(){return this.children;}setAttribute(){}after(){}before(){}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.startsWith('.')&&String(node.className||'').split(/\s+/).includes(selector.slice(1))?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    cloneNode(){const copy=new Element();copy.value=this.value;copy.textContent=this.textContent;return copy;}
  }
  const nodes=new Map(),requests=[],reserves=[],removes=[];
  const recoveryTimers=new Map(),handoverTimers=new Map(),requestTimers=new Map();
  let requestClock=0;
  const fixtureTimeout=(fn,ms,...args)=>{
    if(manualRequestTimers&&ms>=10000){const timer={unref(){}};requestTimers.set(timer,{at:requestClock+ms,run:()=>fn(...args)});return timer;}
    if(manualHandoverTimers&&ms===30000){const timer={unref(){}};handoverTimers.set(timer,()=>fn(...args));return timer;}
    if(!manualRecoveryTimers||ms!==500)return setTimeout(fn,ms,...args);
    const timer={unref(){}};recoveryTimers.set(timer,()=>fn(...args));return timer;
  };
  const fixtureClearTimeout=timer=>{if(!recoveryTimers.delete(timer)&&!handoverTimers.delete(timer)&&!requestTimers.delete(timer))clearTimeout(timer);};
  const document={listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const store={read:async()=>null,reserve:async(...args)=>{reserves.push(args);return true;},remove:async(...args)=>{removes.push(args);return true;}};
  const context=vm.createContext({document,store,crypto:webcrypto,AbortController,URLSearchParams,TextDecoder,TextEncoder,Date,setTimeout:fixtureTimeout,clearTimeout:fixtureClearTimeout,localStorage:{getItem(){return null;},removeItem(){}},sessionStorage:{removeItem(){}},window:{innerWidth:1300,innerHeight:800,addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});return await handler?.(url,options)||response({projects:[],recent:[]});
  }});
  let source=await readFile(new URL('../public/desktop.js',import.meta.url),'utf8');
  source=source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())",'Promise.resolve(store)');
  const run=code=>vm.runInContext(code,context);run(source);run('const fixtureConnect=connect');await tick();
  run(`selectedId='${id}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=false;recoverableHistoryId=selectedId;recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});${stubLoadThreads ? 'loadThreads=async()=>{};' : ''}connect=async()=>{};updateComposer();`);
  return {run,nodes,requests,reserves,removes,store,recoveryTimers,handoverTimers,advanceRequestTime(ms){requestClock+=ms;for(const [timer,entry] of requestTimers)if(entry.at<=requestClock){requestTimers.delete(timer);entry.run();}},fireRecoveryTimer(){const entry=recoveryTimers.entries().next().value;if(!entry)return false;recoveryTimers.delete(entry[0]);entry[1]();return true;},submit:()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}})};
}

test('recovery waits through the relay 60 s budget and accepts a result after the old 30 s deadline',async()=>{
  let release,signal;
  const f=await fixture((url,options)=>url.endsWith('/recover')?new Promise((resolve,reject)=>{
    signal=options.signal;release=()=>resolve(response({status:'accepted'},202));
    signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  }):undefined,{manualRequestTimers:true});
  const work=f.run('recoverSelectedChat()');await tick();
  for(const elapsed of [31000,29000]){
    f.advanceRequestTime(elapsed);await tick();
    assert.equal(signal.aborted,false);assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'pending');
    assert.equal(f.removes.length,0);assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,1);
  }
  release();await work;
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');
  f.advanceRequestTime(10000);assert.equal(signal.aborted,false,'settled request clears its timeout');
});

test('accepted recovery retains an active attachment and does not disturb a newer one',async()=>{
  for (const replacement of [false,true]) {
    let release;
    const f=await fixture(url=>url.endsWith('/recover')?new Promise(resolve=>{release=()=>resolve(response({status:'accepted'},202));}):undefined);
    f.run("let reconnects=0;connect=async()=>{reconnects++};recoveryStream={threadId:selectedId,controller:new AbortController()}");
    const original=f.run('recoveryStream'), work=f.run('recoverSelectedChat()');await tick();
    if(replacement) f.run('recoveryStream={threadId:selectedId,controller:new AbortController()}');
    const current=f.run('recoveryStream');release();await work;
    assert.equal(f.run('reconnects'),0);assert.equal(f.run('recoveryStream'),current);
    assert.equal(original.controller.signal.aborted,false);assert.equal(current.controller.signal.aborted,false);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);
  }
});

test('automatic recovery reaches live state on the original history event stream',async()=>{
  let releaseRecovery,deliver;
  const f=await fixture(url=>{
    if(url.endsWith('/events'))return {ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(resolve=>{deliver=resolve;})})}};
    if(url.endsWith('/recover'))return new Promise(resolve=>{releaseRecovery=()=>resolve(response({status:'accepted'},202));});
    return response({locked:false});
  },{manualRecoveryTimers:true});
  const emit=(type,conversation)=>deliver({value:new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({conversation})}\n\n`),done:false});
  f.run('connect=fixtureConnect;void connect(selectedId)');await tick();await tick();
  try {
    const session=f.run('active'),stream=f.run('recoveryStream');
    emit('history',{id,title:'history',turns:[],requests:[],history:{complete:true}});
    await tick();await tick();
    assert.equal(f.fireRecoveryTimer(),true);
    await tick();await tick();
    assert.equal(typeof releaseRecovery,'function');
    releaseRecovery();await tick();await tick();
    assert.equal(f.run('recoveryStream'),stream);
    assert.equal(f.run('active'),session);assert.equal(session.signal.aborted,false);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/events')).length,1);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);
    assert.equal(f.run('recoveryBlocksWrite()'),true);
    assert.equal(f.removes.length,0);
    emit('state',{id,title:'live',runtimeStatus:'idle',turns:[],requests:[],history:{complete:true}});
    await tick();await tick();
    assert.equal(f.run('connected'),true);
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),null);
    assert.equal(f.removes.length,1);
    assert.equal(f.run('recoveryBlocksWrite()'),false);
    assert.equal(f.nodes.get('#message').disabled,false);
  } finally { f.run('active?.abort()'); }
});

test('a live snapshot arriving before IndexedDB finishes reconciles the stored recovery without another message', async () => {
  const f = await fixture();
  let releaseRead, reads = 0;
  f.store.read = async () => ++reads === 1 ? new Promise(resolve => { releaseRead = resolve; }) : null;
  f.run("recoveries.delete(recoveryKey(currentDeviceId,selectedId));recoveryStream={threadId:selectedId,controller:new AbortController()};recoveryState(currentDeviceId,selectedId)");
  await tick();
  f.run("handleEvent('event: state\\ndata: '+JSON.stringify({seq:1,conversation:{id:selectedId,title:'live',turns:[],requests:[],history:{complete:true}}}))");
  assert.equal(f.nodes.get('#message').disabled, true);
  assert.equal(f.nodes.get('#connection').textContent, '已连接，待确认');
  releaseRead('22222222-2222-4222-8222-222222222222');
  await tick(); await tick(); await tick();
  assert.equal(f.nodes.get('#message').disabled, false);
  assert.equal(f.nodes.get('#connection').textContent, '已连接');
  assert.equal(f.removes.length, 1);
  assert.equal(f.reserves.length, 0);
  assert.equal(f.requests.some(request => request.options.method === 'POST'), false);
});

test('a delayed stored recovery cannot clear the currently selected task or device', async () => {
  for (const changeDevice of [false, true]) {
    const f = await fixture();
    let releaseRead;
    f.store.read = () => new Promise(resolve => { releaseRead = resolve; });
    f.run("recoveries.delete(recoveryKey(currentDeviceId,selectedId));recoveryStream={threadId:selectedId,controller:new AbortController()};recoveryState(currentDeviceId,selectedId)");
    await tick();
    f.run("handleEvent('event: state\\ndata: '+JSON.stringify({seq:1,conversation:{id:selectedId,turns:[],requests:[]}}))");
    f.run(`${changeDevice ? "currentDeviceId='other-device'" : "selectedId='33333333-3333-4333-8333-333333333333'"};historyScopeGeneration++;recoveryStream={threadId:selectedId,controller:new AbortController(),liveState:true};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'44444444-4444-4444-8444-444444444444'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});updateComposer()`);
    releaseRead('22222222-2222-4222-8222-222222222222'); await tick(); await tick();
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'), '44444444-4444-4444-8444-444444444444');
    assert.equal(f.nodes.get('#message').disabled, true);
    assert.equal(f.removes.length, 0);
  }
});

test('failed readiness checks recover through bounded read-only checks while the live stream stays attached', async () => {
  let checks = 0;
  const f = await fixture(url => url.endsWith('/recovery-status')
    ? (++checks < 3 ? response({}, 503) : response({ locked: false })) : undefined);
  f.run("connected=true;recoverableHistoryId=null;recoveryStream={threadId:selectedId,controller:new AbortController(),liveState:true}");
  const stream = f.run('recoveryStream');
  await f.run('checkRecoveryStatus(selectedId,currentDeviceId,recoveryStream)');
  assert.equal(f.nodes.get('#message').disabled, true);
  assert.equal(f.nodes.get('#connection').textContent, '已连接，待确认');
  assert.ok(f.nodes.get('#recovery-status').textContent.includes('核对失败'));
  for (let attempt = 0; attempt < 2; attempt++) {
    f.run('if(recoveryLockWatches.has(recoveryKey(currentDeviceId,selectedId)))recoveryLockWatches.get(recoveryKey(currentDeviceId,selectedId)).at=Date.now()-4000;recoveryNoticeTick()');
    await tick();
  }
  assert.equal(checks, 3);
  assert.equal(f.nodes.get('#message').disabled, false);
  assert.equal(f.run('recoveryStream'), stream);
  assert.equal(stream.controller.signal.aborted, false);
  assert.equal(f.requests.some(request => request.options.method === 'POST'), false);
});

test('readiness failures stop automatic retries and the retry button never reissues recovery or input', async () => {
  let unlocked = false, checks = 0;
  const f = await fixture(url => url.endsWith('/recovery-status')
    ? (checks++, unlocked ? response({ locked: false }) : response({}, 503)) : undefined);
  f.run("connected=true;recoverableHistoryId=null;recoveryStream={threadId:selectedId,controller:new AbortController(),liveState:true}");
  await f.run('checkRecoveryStatus(selectedId,currentDeviceId,recoveryStream)');
  for (let attempt = 0; attempt < 6; attempt++) {
    f.run('if(recoveryLockWatches.has(recoveryKey(currentDeviceId,selectedId)))recoveryLockWatches.get(recoveryKey(currentDeviceId,selectedId)).at=Date.now()-4000;recoveryNoticeTick()');
    await tick();
  }
  assert.equal(checks, 4, 'one initial check and at most three automatic retries');
  assert.equal(f.nodes.get('#recover-chat').hidden, false);
  assert.equal(f.nodes.get('#message').disabled, true);
  unlocked = true;
  f.run('connected=false;recoverableHistoryId=selectedId;recoveryStream.liveState=false');
  f.nodes.get('#recover-chat').listeners.click(); await tick();
  assert.equal(checks, 5);
  assert.equal(f.run('recoveryChecks.get(recoveryKey(currentDeviceId,selectedId)).status'), 'ready');
  assert.equal(f.requests.some(request => request.options.method === 'POST'), false);
  assert.equal(f.reserves.length, 0);
});

test('a read-only readiness retry preserves a real recovery lock and unknown operation without live state', async () => {
  const f = await fixture(url => url.endsWith('/recovery-status') ? response({ locked: true }) : undefined);
  f.run("connected=true;recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',message:'恢复结果未知'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'failed'});updateComposer()");
  f.nodes.get('#recover-chat').listeners.click(); await tick();
  assert.equal(f.run('recoveryBlocksWrite()'), true);
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'), '22222222-2222-4222-8222-222222222222');
  assert.equal(f.nodes.get('#message').disabled, true);
  assert.ok(f.nodes.get('#recovery-status').textContent.includes('暂时不能发送'));
  assert.equal(f.removes.length, 0);
  assert.equal(f.requests.some(request => request.options.method === 'POST'), false);
});

test('a late unlocked readiness response cannot authorize another selection or device', async () => {
  for (const changeDevice of [false, true]) {
    let release;
    const f = await fixture(url => url.endsWith('/recovery-status') ? new Promise(resolve => { release = resolve; }) : undefined);
    f.run("connected=true;recoveryStream={threadId:selectedId,controller:new AbortController(),liveState:true}");
    const checking = f.run('checkRecoveryStatus(selectedId,currentDeviceId,recoveryStream,{readOnly:true})');
    await tick();
    f.run(`${changeDevice ? "currentDeviceId='other-device'" : "selectedId='33333333-3333-4333-8333-333333333333'"};historyScopeGeneration++;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'44444444-4444-4444-8444-444444444444'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'locked'});updateComposer()`);
    release(response({ locked: false })); await checking; await tick();
    assert.equal(f.run('recoveryChecks.get(recoveryKey(currentDeviceId,selectedId)).status'), 'locked');
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'), '44444444-4444-4444-8444-444444444444');
    assert.equal(f.nodes.get('#message').disabled, true);
    assert.equal(f.removes.length, 0);
    assert.equal(f.requests.some(request => request.options.method === 'POST'), false);
  }
});

test('accepted recovery reconnects only a still-current disconnected scope with no valid stream',async()=>{
  for (const scenario of ['missing','aborted','connected','scope','selection','cancelled']) {
    let release;
    const f=await fixture(url=>url.endsWith('/recover')?new Promise(resolve=>{release=()=>resolve(response({status:'accepted'},202));}):undefined);
    f.run("let reconnects=0;connect=async()=>{reconnects++};recoveryStream={threadId:selectedId,controller:new AbortController()}");
    const work=f.run('recoverSelectedChat()');await tick();
    if(scenario==='missing') f.run('recoveryStream=null');
    if(scenario==='aborted') f.run('recoveryStream.controller.abort()');
    if(scenario==='connected') f.run('connected=true;recoveryStream=null');
    if(scenario==='scope') f.run('historyScopeGeneration++;recoveryStream=null');
    if(scenario==='selection') f.run("selectedId='22222222-2222-4222-8222-222222222222';recoveryStream=null");
    if(scenario==='cancelled') f.run('activeRecoveryAborts.get(recoveryKey(currentDeviceId,selectedId)).abort();recoveryStream=null');
    release();await work;
    assert.equal(f.run('reconnects'),['missing','aborted'].includes(scenario)?1:0,scenario);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);
  }
});

test('the 70 s recovery client deadline retains the unknown attempt and never redispatches it',async()=>{
  let signal;
  const f=await fixture((url,options)=>url.endsWith('/recover')?new Promise((resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  }):url.includes('/recovery-attempt/')?response({status:'pending',locked:true}):undefined,{manualRequestTimers:true});
  const work=f.run('recoverSelectedChat()');await tick();
  f.advanceRequestTime(69999);assert.equal(signal.aborted,false);
  f.advanceRequestTime(1);await work;
  assert.equal(signal.aborted,true);assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unknown');
  await f.run('runHistoryRecovery(selectedId,currentDeviceId)');
  assert.equal(f.removes.length,0);assert.equal(f.reserves.length,1);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,1);
});

test('live attachment renews the history recovery budget across helper restarts',async()=>{
  const f=await fixture(url=>url.endsWith('/recover')?response({status:'accepted'},202):undefined,{manualRecoveryTimers:true});
  for(let attempt=1;attempt<=7;attempt++){
    f.run("connected=false;recoverableHistoryId=selectedId;recoveryStream={threadId:selectedId,controller:new AbortController()};scheduleHistoryRecovery(selectedId,currentDeviceId)");
    assert.equal(f.fireRecoveryTimer(),true,`recovery ${attempt} remains available after previous live attachment`);
    await tick();await tick();
    assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,attempt);
    f.run("handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',model:'model',reasoningEffort:'high',runtimeStatus:'idle',turns:[],requests:[],history:{complete:true}}}))");
    await tick();await tick();
    assert.equal(f.run('historyRecoveryAttempts.has(recoveryKey(currentDeviceId,selectedId))'),false);
    assert.equal(f.run('connected'),true);
  }
});

test('history recovery budgets are device scoped and history is not proof of attachment',async()=>{
  const f=await fixture(url=>url.endsWith('/recover')?response({status:'accepted'},202):undefined,{manualRecoveryTimers:true});
  f.run("historyRecoveryAttempts.set(recoveryKey(currentDeviceId,selectedId),5);handleEvent('event: history\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'history',turns:[],requests:[],history:{complete:true}}}))");
  assert.equal(f.fireRecoveryTimer(),false);
  assert.equal(f.run('historyRecoveryAttempts.get(recoveryKey(currentDeviceId,selectedId))'),5);
  assert.throws(()=>f.run("handleEvent('event: state\\ndata: '+JSON.stringify({seq:0,conversation:{id:selectedId,turns:[]}}))"));
  assert.equal(f.run('historyRecoveryAttempts.get(recoveryKey(currentDeviceId,selectedId))'),5);
  f.run("currentDeviceId='other';historyScope.deviceId='other';recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});scheduleHistoryRecovery(selectedId,currentDeviceId)");
  assert.equal(f.fireRecoveryTimer(),true);await tick();await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);
  assert.equal(f.requests.find(r=>r.url.endsWith('/recover')).options.headers['x-codex-expected-device'],'other');
  assert.equal(f.run("historyRecoveryAttempts.get(recoveryKey('device',selectedId))"),5);
});

test('delayed automatic recovery cannot target a different selected device',async()=>{
  const f=await fixture(undefined,{manualRecoveryTimers:true});
  f.run("scheduleHistoryRecovery(selectedId,currentDeviceId);currentDeviceId='other'");
  assert.equal(f.fireRecoveryTimer(),true);await tick();
  assert.equal(f.reserves.length,0);assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);
});

test('unknown attempts survive deadlines and repeated history recovery while checks continue',async()=>{
  let result={status:'pending',locked:true};
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response(result):undefined,{manualRecoveryTimers:true});
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-21000});historyRecoveryAttempts.set(recoveryKey(currentDeviceId,selectedId),5)");
  for(let attempt=0;attempt<3;attempt++){
    const checks=f.requests.filter(r=>r.url.includes('/recovery-attempt/')).length;
    f.run('recoveryState(currentDeviceId,selectedId).lastCheckedAt=Date.now()-6000;recoveryNoticeTick()');await tick();
    assert.equal(f.requests.filter(r=>r.url.includes('/recovery-attempt/')).length,checks+1);
    await f.run('runHistoryRecovery(selectedId,currentDeviceId)');
  }
  result={status:'missing',locked:false};
  await f.run('runHistoryRecovery(selectedId,currentDeviceId)');
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unknown');
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),'22222222-2222-4222-8222-222222222222');
  assert.ok(f.requests.filter(r=>r.url.includes('/recovery-attempt/')).length>=4);
  assert.equal(f.removes.length,0);assert.equal(f.reserves.length,0);
  assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);
  result={status:'rejected',locked:false};
  await f.run('runHistoryRecovery(selectedId,currentDeviceId)');
  assert.equal(f.removes.length,1);assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unavailable');
});

test('the recovery deadline preserves an in-flight POST until its outcome can be checked',async()=>{
  let release;
  const f=await fixture(url=>url.endsWith('/recover')?new Promise(resolve=>{release=()=>resolve(response({error:'outcome-unknown'},504));}):url.includes('/recovery-attempt/')?response({status:'pending',locked:true}):undefined);
  const work=f.run('recoverSelectedChat()');await tick();
  f.run('recoveryState(currentDeviceId,selectedId).since=Date.now()-21000;recoveryNoticeTick()');await tick();
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'pending');
  assert.equal(f.removes.length,0);assert.equal(f.requests.some(r=>r.url.includes('/recovery-attempt/')),false);
  release();await work;
  f.run('recoveryState(currentDeviceId,selectedId).since=Date.now()-21000;recoveryNoticeTick()');await tick();
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unknown');
  assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);
  assert.equal(f.requests.filter(r=>r.url.includes('/recovery-attempt/')).length,1);assert.equal(f.removes.length,0);
});

test('accepted attempts wait for live state and a status query cannot release an unknown write',async()=>{
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response({status:'accepted',locked:false}):response({locked:false}),{manualRecoveryTimers:true});
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-21000});recoveryStream={threadId:selectedId,controller:new AbortController()}");
  await f.run('checkRecoveryStatus(selectedId,currentDeviceId,recoveryStream)');await tick();
  assert.equal(f.removes.length,0);
  assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);
  for(let attempt=0;attempt<4;attempt++)await f.run('runHistoryRecovery(selectedId,currentDeviceId)');
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');
  assert.equal(f.removes.length,0);
  f.run("handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))");await tick();await tick();
  assert.equal(f.removes.length,1);assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),null);
});

test('accepted polling preserves the attachment session until live state clears the attempt',async()=>{
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response({status:'accepted',locked:false}):url.endsWith('/events')?{ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(()=>{})})}}:response({locked:false}),{manualRecoveryTimers:true});
  f.run("connect=fixtureConnect;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-21000});recoveryStream={threadId:selectedId,controller:new AbortController()}");
  try {
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    const session=f.run('active');
    assert.equal(f.requests.filter(r=>r.url.endsWith('/events')).length,1);
    for(let poll=0;poll<3;poll++){
      f.run('recoveryState(currentDeviceId,selectedId).lastCheckedAt=Date.now()-6000;recoveryNoticeTick()');await tick();
      assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');
      assert.equal(f.run('active'),session);assert.equal(session.signal.aborted,false);
      assert.equal(f.requests.filter(r=>r.url.endsWith('/events')).length,1);
      assert.equal(f.removes.length,0);assert.equal(f.run('recoveryBlocksWrite()'),true);
    }
    assert.equal(f.requests.filter(r=>r.url.includes('/recovery-attempt/')).length,4);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,0);
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),'22222222-2222-4222-8222-222222222222');
    f.run("handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))");await tick();await tick();
    assert.equal(f.removes.length,1);assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),null);
  } finally { f.run('active?.abort()'); }
});

test('the first accepted confirmation retains an existing non-history attachment stream',async()=>{
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response({status:'accepted',locked:false}):url.endsWith('/events')?{ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(()=>{})})}}:response({locked:false}),{manualRecoveryTimers:true});
  f.run("connect=fixtureConnect;recoverableHistoryId=null;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-21000});void connect(selectedId)");await tick();
  try {
    const session=f.run('active');
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(f.requests.filter(r=>r.url.endsWith('/events')).length,1);
    assert.equal(f.run('active'),session);assert.equal(session.signal.aborted,false);
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');assert.equal(f.removes.length,0);
  } finally { f.run('active?.abort()'); }
});

test('an explicitly unlocked released attempt permits a fresh recovery after checking readiness',async()=>{
  for(const status of ['unknown','awaiting-state']){
    const f=await fixture(url=>url.includes('/recovery-attempt/')?response({status:'released',locked:false}):url.endsWith('/recover')?response({status:'accepted'},202):response({locked:false}),{manualRecoveryTimers:true});
    const oldRequestId='22222222-2222-4222-8222-222222222222';
    f.run(`recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'${status}',requestId:'${oldRequestId}',since:Date.now()-21000})`);
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(f.removes.length,1);assert.equal(f.removes[0][2],oldRequestId);
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unavailable');
    assert.equal(f.run('recoveryChecks.has(recoveryKey(currentDeviceId,selectedId))'),false);
    assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);
    f.run('recoveryStream={threadId:selectedId,controller:new AbortController()}');
    await f.run('checkRecoveryStatus(selectedId,currentDeviceId,recoveryStream)');await tick();await tick();
    const recover=f.requests.filter(r=>r.url.endsWith('/recover'));
    assert.equal(recover.length,1);assert.equal(f.reserves.length,1);
    assert.notEqual(JSON.parse(recover[0].options.body).requestId,oldRequestId);
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');
  }
});

test('a lock or an inconclusive attempt status cannot release a browser recovery record',async()=>{
  let result;
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response(result):undefined,{manualRecoveryTimers:true});
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'awaiting-state',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-21000})");
  for(result of [{status:'released',locked:true},{status:'released'},{status:'unknown',locked:false},{status:'missing',locked:false},{status:'pending',locked:false}]){
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'awaiting-state');
    assert.equal(f.run('recoveryState(currentDeviceId,selectedId).requestId'),'22222222-2222-4222-8222-222222222222');
    assert.equal(f.run('recoveryBlocksWrite()'),true);assert.equal(f.removes.length,0);
    assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);
  }
});

test('a confirmed unbound route retries once after readiness without replacing its attachment',async()=>{
  const f=await fixture(url=>url.includes('/recovery-attempt/')?response({status:'accepted',locked:false,executionTracked:false}):url.endsWith('/recover')?response({status:'accepted'},202):response({locked:false}),{manualRecoveryTimers:true});
  f.run("let recoveryConnectCalls=0;connect=async()=>{recoveryConnectCalls++};recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'awaiting-state',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
  const stream=f.run('recoveryStream');
  await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
  const statusIndex=f.requests.findIndex(request=>request.url.endsWith('/recovery-status'));
  const recoverIndex=f.requests.findIndex(request=>request.url.endsWith('/recover'));
  assert.ok(statusIndex>=0&&recoverIndex>statusIndex);
  assert.equal(f.removes.length,1);assert.equal(f.reserves.length,1);
  assert.notEqual(JSON.parse(f.requests[recoverIndex].options.body).requestId,'22222222-2222-4222-8222-222222222222');
  assert.equal(f.run('recoveryConnectCalls'),0);assert.equal(f.run('recoveryStream'),stream);assert.equal(stream.controller.signal.aborted,false);
  for(let poll=0;poll<3;poll++){
    f.run('recoveryState(currentDeviceId,selectedId).since=Date.now()-31000');
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
  }
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,1);assert.equal(f.removes.length,1);
  assert.equal(f.requests.some(request=>request.url.endsWith('/messages')),false);
  f.run("handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))");await tick();await tick();
  assert.equal(f.run('unboundAcceptedRetries.has(recoveryKey(currentDeviceId,selectedId))'),false);
  f.run("connected=false;recoverableHistoryId=selectedId;recoveryStream.liveState=false;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'awaiting-state',requestId:'33333333-3333-4333-8333-333333333333',since:Date.now()-31000})");
  await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,2);assert.equal(f.run('recoveryConnectCalls'),0);
});

test('only an explicit old unbound accepted and unlocked result can use the once-only route retry',async()=>{
  const cases=[
    {status:'accepted',locked:false,executionTracked:true},
    {status:'accepted',locked:false},
    {status:'accepted',locked:false,executionTracked:null},
    {status:'accepted',locked:true,executionTracked:false},
    {status:'accepted',executionTracked:false},
    ...['pending','unknown','missing'].map(status=>({status,locked:false,executionTracked:false})),
    {status:'accepted',locked:false,executionTracked:false,age:15000},
  ];
  for(const result of cases){
    const f=await fixture(url=>url.includes('/recovery-attempt/')?response(result):response({locked:false}),{manualRecoveryTimers:true});
    f.run(`recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'awaiting-state',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-${result.age||31000}})`);
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(f.removes.length,0,JSON.stringify(result));assert.equal(f.reserves.length,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/recover')),false);
  }
});

test('late confirmed-route cleanup or readiness cannot recover after live attachment or scope changes',async()=>{
  const mutations=[
    "selectedId='44444444-4444-4444-8444-444444444444'",
    "currentDeviceId='other-device'",
    'historyScopeGeneration++',
    'recoveryStream={threadId:selectedId,controller:new AbortController()}',
    "handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))",
  ];
  for(const stage of ['query','cleanup','readiness','reservation'])for(const mutation of mutations){
    let release;
    const accepted={status:'accepted',locked:false,executionTracked:false};
    const f=await fixture(url=>url.includes('/recovery-attempt/')?(stage==='query'?new Promise(resolve=>{release=()=>resolve(response(accepted));}):response(accepted)):url.endsWith('/recovery-status')&&stage==='readiness'?new Promise(resolve=>{release=()=>resolve(response({locked:false}));}):response({locked:false}),{manualRecoveryTimers:true});
    if(stage==='cleanup'){
      const remove=f.store.remove;let first=true;
      f.store.remove=async(...args)=>{if(first){first=false;await new Promise(resolve=>{release=resolve;});}return remove(...args);};
    }
    if(stage==='reservation'){
      const reserve=f.store.reserve;
      f.store.reserve=async(...args)=>{await new Promise(resolve=>{release=resolve;});return reserve(...args);};
    }
    f.run("recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'awaiting-state',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
    const stream=f.run('recoveryStream');
    const work=f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(typeof release,'function',stage);f.run(mutation);await tick();release();await work;await tick();
    assert.equal(f.requests.some(request=>request.url.endsWith('/recover')),false,`${stage}: ${mutation}`);
    assert.equal(f.reserves.length,stage==='reservation'?1:0);assert.equal(stream.controller.signal.aborted,false);
  }
});

test('missing recovery is tombstoned and confirmed before one fresh route on the same stream',async()=>{
  let cancelled=false;
  const f=await fixture(url=>url.endsWith('/recovery-cancel')?(cancelled=true,response({status:'accepted'},202)):url.includes('/recovery-attempt/')?response({status:cancelled?'cancelled':'missing',locked:false}):url.endsWith('/recover')?response({status:'accepted'},202):response({locked:false}),{manualRecoveryTimers:true});
  f.run("let missingConnectCalls=0;connect=async()=>{missingConnectCalls++};recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
  const stream=f.run('recoveryStream');
  await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
  const relevant=f.requests.filter(request=>/recovery-attempt|recovery-cancel|recovery-status|\/recover$/.test(request.url));
  assert.equal(relevant.length,5);
  assert.match(relevant[0].url,/recovery-attempt/);assert.match(relevant[1].url,/recovery-cancel/);assert.match(relevant[2].url,/recovery-attempt/);assert.match(relevant[3].url,/recovery-status/);assert.match(relevant[4].url,/\/recover$/);
  assert.deepEqual(JSON.parse(relevant[1].options.body),{requestId:'22222222-2222-4222-8222-222222222222'});
  assert.notEqual(JSON.parse(relevant[4].options.body).requestId,'22222222-2222-4222-8222-222222222222');
  assert.equal(f.removes.length,1);assert.equal(f.reserves.length,1);assert.equal(f.run('missingConnectCalls'),0);
  assert.equal(f.run('recoveryStream'),stream);assert.equal(stream.controller.signal.aborted,false);
  cancelled=false;
  for(let poll=0;poll<3;poll++)await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recovery-cancel')).length,1);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,1);
  assert.equal(f.requests.some(request=>request.url.endsWith('/messages')),false);
  f.run("handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))");await tick();await tick();
  assert.equal(f.run('missingAttemptCancellations.has(recoveryKey(currentDeviceId,selectedId))'),false);
});

test('an acknowledged missing cancellation can finish on later read-only confirmation without cancelling again',async()=>{
  let checks=0,result={status:'cancelled',locked:false},failReadiness=true;
  const f=await fixture(url=>{
    if(url.endsWith('/recovery-cancel'))return response({status:'accepted'},202);
    if(url.includes('/recovery-attempt/')){
      if(++checks===1)return response({status:'missing',locked:false});
      if(checks===2)throw new Error('confirmation offline');
      return response(result);
    }
    if(url.endsWith('/recovery-status')&&failReadiness)throw new Error('readiness offline');
    return url.endsWith('/recover')?response({status:'accepted'},202):response({locked:false});
  },{manualRecoveryTimers:true});
  f.run("let retriedCancelConnects=0;connect=async()=>{retriedCancelConnects++};recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
  const stream=f.run('recoveryStream');
  const check=()=>f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
  await check();assert.equal(f.removes.length,0);assert.equal(f.reserves.length,0);
  for(result of [{status:'pending',locked:false},{status:'unknown',locked:false},{status:'missing',locked:false},{status:'cancelled',locked:true}]){
    await check();assert.equal(f.removes.length,0);assert.equal(f.reserves.length,0);
  }
  result={status:'cancelled',locked:false};await check();
  assert.equal(f.removes.length,1);assert.equal(f.reserves.length,0);
  failReadiness=false;await check();
  assert.equal(f.removes.length,1);assert.equal(f.reserves.length,1);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recovery-cancel')).length,1);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/recover')).length,1);
  assert.equal(f.run('retriedCancelConnects'),0);assert.equal(f.run('recoveryStream'),stream);assert.equal(stream.controller.signal.aborted,false);
});

test('missing cancellation requires both an accepted cancel and an explicit unlocked cancelled confirmation',async()=>{
  for(const invalid of ['cancel-network','cancel-unknown','confirm-network','confirm-missing','confirm-pending','confirm-locked','initial-locked']){
    let checks=0;
    const f=await fixture(url=>{
      if(url.endsWith('/recovery-cancel'))return invalid==='cancel-network'?Promise.reject(new Error('offline')):response({status:invalid==='cancel-unknown'?'unknown':'accepted'},202);
      if(url.includes('/recovery-attempt/')){
        if(++checks===1)return response({status:'missing',locked:invalid==='initial-locked'});
        if(invalid==='confirm-network')throw new Error('offline');
        return response({status:invalid==='confirm-missing'?'missing':invalid==='confirm-pending'?'pending':'cancelled',locked:invalid==='confirm-locked'});
      }
      return response({locked:false});
    },{manualRecoveryTimers:true});
    f.run("recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
    await f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');
    assert.equal(f.removes.length,0,invalid);assert.equal(f.reserves.length,0);
    assert.equal(f.requests.some(request=>request.url.endsWith('/recover')),false);
    assert.equal(f.run('recoveryBlocksWrite()'),true);
  }
});

test('missing cancellation ignores stale query, cancel, confirmation, cleanup, readiness and reservation results',async()=>{
  const mutations=["selectedId='44444444-4444-4444-8444-444444444444'","currentDeviceId='other'",'historyScopeGeneration++','recoveryStream={threadId:selectedId,controller:new AbortController()}',"handleEvent('event: state\\ndata: '+JSON.stringify({conversation:{id:selectedId,title:'ready',turns:[],requests:[],history:{complete:true}}}))"];
  for(const stage of ['query','cancel','confirmation','cleanup','readiness','reservation'])for(const mutation of mutations){
    let release,checks=0;
    const defer=value=>new Promise(resolve=>{release=()=>resolve(value);});
    const f=await fixture(url=>{
      if(url.includes('/recovery-attempt/')){const value=response({status:++checks===1?'missing':'cancelled',locked:false});return stage===(checks===1?'query':'confirmation')?defer(value):value;}
      if(url.endsWith('/recovery-cancel'))return stage==='cancel'?defer(response({status:'accepted'},202)):response({status:'accepted'},202);
      if(url.endsWith('/recovery-status'))return stage==='readiness'?defer(response({locked:false})):response({locked:false});
      return response({locked:false});
    },{manualRecoveryTimers:true});
    if(stage==='cleanup'){const remove=f.store.remove;let first=true;f.store.remove=async(...args)=>{if(first){first=false;await defer();}return remove(...args);};}
    if(stage==='reservation'){const reserve=f.store.reserve;f.store.reserve=async(...args)=>{await defer();return reserve(...args);};}
    f.run("recoveryStream={threadId:selectedId,controller:new AbortController()};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'22222222-2222-4222-8222-222222222222',since:Date.now()-31000})");
    const stream=f.run('recoveryStream'),work=f.run('checkRecoveryAttempt(selectedId,currentDeviceId,recoveryState(currentDeviceId,selectedId))');await tick();
    assert.equal(typeof release,'function',stage);f.run(mutation);await tick();release();await work;await tick();
    assert.equal(f.requests.some(request=>request.url.endsWith('/recover')),false,`${stage}: ${mutation}`);
    assert.equal(stream.controller.signal.aborted,false);
  }
});

test('history is editable without takeover and only the explicit send recovers before dispatch',async()=>{
  const f=await fixture((url)=>url.endsWith('/recover')?response({status:'accepted'},202):url.endsWith('/messages')?response({status:'accepted'},202):undefined);
  assert.equal(f.nodes.get('#message').disabled,false);assert.equal(f.nodes.get('#recover-chat').hidden,true);
  assert.equal(f.nodes.get('#message').placeholder,'输入消息');
  f.run("messageInput.value='continue history';updateComposer()");await tick();
  assert.equal(f.requests.some(r=>r.url.endsWith('/recover')),false);assert.equal(f.reserves.length,0);
  await f.submit();await tick();
  assert.equal(f.nodes.get('#message').value,'');assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);assert.equal(f.reserves.length,1);
  assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);assert.equal(f.run('outgoingMessages.get(outgoingScopeKey())[0].state'),'queued');
  f.run("connected=true;recoverableHistoryId=null;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});updateComposer()");await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,1);assert.equal(JSON.parse(f.requests.find(r=>r.url.endsWith('/messages')).options.body).text,'continue history');
});

test('uncertain recovery keeps the queued message unsent and cannot silently retry takeover',async()=>{
  const f=await fixture(url=>url.endsWith('/recover')?response({error:'outcome-unknown'},504):undefined);
  f.run("messageInput.value='continue'");await f.submit();await tick();
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unknown');assert.equal(f.nodes.get('#recover-chat').hidden,true);
  assert.equal(f.nodes.get('#message').disabled,true);assert.equal(f.nodes.get('#message').placeholder,'等待连接');
  f.run('updateComposer()');await f.run('runOutgoingQueue(selectedId)');await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);assert.equal(f.nodes.get('#message').disabled,true);
});

test('rejected recovery unlocks the history draft without waiting for another stream event',async()=>{
  let release;
  const f=await fixture(url=>url.endsWith('/recover')?new Promise(resolve=>{release=()=>resolve(response({error:'unavailable'},409));}):undefined);
  const work=f.run('recoverSelectedChat()');await tick();
  assert.equal(f.nodes.get('#message').disabled,true);assert.equal(f.nodes.get('#message').placeholder,'等待连接');
  release();await work;
  assert.equal(f.nodes.get('#message').disabled,false);assert.equal(f.nodes.get('#message').placeholder,'输入消息');
  assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);
});

test('new chat model and effort use the same composer controls and preserve prepared locks',async()=>{
  const f=await fixture();
  f.run("connected=true;selectedId=null;newModels=[{model:'a',displayName:'A',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'high'}];newDraft={projectId:'p',attachments:[],model:null,effort:null,pending:false,uncertain:false};updateComposer()");
  assert.equal(f.run('modelControls.hidden'),false);assert.equal(f.nodes.get('#new-model').hidden,true);assert.equal(f.nodes.get('#new-effort').hidden,true);
  f.run("modelControl.value='a';modelControl.listeners.change()");assert.equal(f.run('newDraft.model'),'a');assert.equal(f.run('newDraft.effort'),'high');
  f.run("effortControl.value='low';effortControl.listeners.change()");assert.equal(f.run('newDraft.effort'),'low');
  f.run("newDraft.prepared={threadId:'prepared'};updateComposer()");assert.equal(f.run('modelControl.disabled'),true);assert.equal(f.run('effortControl.disabled'),true);
  f.run("effortControl.value='high';effortControl.listeners.change()");assert.equal(f.run('newDraft.effort'),'low');
  assert.equal(f.requests.some(r=>r.url.endsWith('/model')),false);
});

test('running tasks keep model and effort pickers usable and apply the choice when idle',async()=>{
  const f=await fixture();
  f.run("connected=true;modelCatalog=[{model:'a',displayName:'A',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'high'}];liveModel={model:'a',effort:'low'};liveMode='default';liveRuntimeStatus='active';updateComposer()");
  assert.equal(f.run('modelControl.disabled'),false);assert.equal(f.run('effortControl.disabled'),false);
  f.run("effortControl.value='high';effortControl.listeners.change()");
  assert.equal(f.run("pendingModelChanges.get(selectedId).effort"),'high');
  assert.equal(f.requests.some(r=>r.url.endsWith('/model')),false);
  f.run("showState({id:selectedId,title:'t',runtimeStatus:'idle',model:'a',reasoningEffort:'low',collaborationMode:'default',turns:[],requests:[],history:{complete:true}},true)");
  assert.equal(f.requests.some(r=>r.url.endsWith('/model')),true);
  assert.equal(f.run('pendingModelChanges.has(selectedId)'),false);
});

test('running tasks keep plan mode usable and apply the choice when idle',async()=>{
  const f=await fixture();
  f.run("connected=true;modelCatalog=[{model:'a',displayName:'A',supportedReasoningEfforts:['low'],defaultReasoningEffort:'low'}];liveModel={model:'a',effort:'low'};liveMode='default';liveRuntimeStatus='active';updateComposer()");
  assert.equal(f.nodes.get('#mode-choose').disabled,false);
  f.nodes.get('#mode-choose').listeners.click();
  assert.equal(f.run("pendingModeChanges.get(selectedId)"),'plan');
  assert.equal(f.requests.some(r=>r.url.endsWith('/mode')),false);
  f.run("showState({id:selectedId,title:'t',runtimeStatus:'idle',model:'a',reasoningEffort:'low',collaborationMode:'default',turns:[],requests:[],history:{complete:true}},true)");
  assert.equal(f.requests.some(r=>r.url.endsWith('/mode')),true);
  assert.equal(f.run('pendingModeChanges.has(selectedId)'),false);
});

test('new chat defaults to a concrete model and effort and the in-app pickers drive them',async()=>{
  const f=await fixture();
  f.run("connected=true;selectedId=null;newModels=[{model:'a',displayName:'A',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'high',isDefault:true},{model:'b',displayName:'B',supportedReasoningEfforts:['medium'],defaultReasoningEffort:'medium'}];newDraft={projectId:'p',attachments:[],model:null,effort:null,pending:false,uncertain:false};updateComposer()");
  assert.equal(f.run('newDraft.model'),'a');assert.equal(f.run('newDraft.effort'),'high');
  assert.equal(f.run('newEffort.disabled'),false);
  assert.equal(f.run("[...modelControl.children].some(o=>o.value==='')"),false);
  assert.equal(f.run("[...effortControl.children].some(o=>o.value==='')"),false);
  assert.equal(f.run('modelPicker.label.textContent'),'A · high');
  f.run('openPicker(modelPicker)');assert.equal(f.run('modelPicker.panel.hidden'),false);assert.equal(f.run('modelPicker.view'),null);
  f.run('modelPicker.panel.children[2].listeners.click()');
  assert.equal(f.run('modelPicker.view !== null'),true);assert.equal(f.run('modelPicker.panel.children[1].textContent'),'思考等级');
  f.run('modelPicker.panel.children[2].listeners.click()');
  assert.equal(f.run('newDraft.model'),'b');assert.equal(f.run('newDraft.effort'),'medium');
  assert.equal(f.run('modelPicker.label.textContent'),'B · medium');assert.equal(f.run('modelPicker.panel.hidden'),true);
});

test('new chat hides the load-earlier action and never writes a history notice',async()=>{
  const f=await fixture();
  f.run("newDraft={projectId:'p',attachments:[],model:null,effort:null,pending:false,uncertain:false};historyCanLoad=true;updateHistoryControl()");
  assert.equal(f.run('loadEarlier.hidden'),true);
  f.run('newDraft=null;updateHistoryControl()');assert.equal(f.run('loadEarlier.hidden'),true);
  f.run("streamView={id:selectedId,turns:[],history:{cursor:'older'}};updateHistoryControl()");assert.equal(f.run('loadEarlier.hidden'),false);
  f.run("history.textContent='部分历史未加载';selectedId='11111111-1111-4111-8111-111111111111';streamView={id:selectedId,title:'t',turns:[],requests:[],history:{complete:false}};showState(streamView,true)");
  assert.equal(f.nodes.get('#history').textContent,'');
});

test('new chats without older history do not show a paging button or partial-history notice',async()=>{
  const f=await fixture();
  f.run("connected=true;streamView={id:selectedId,title:'new',runtimeStatus:'idle',turns:[{id:'turn',status:'completed',items:[{id:'m',type:'userMessage',text:'first'}]}],requests:[],history:{complete:false,reason:'history-not-confirmed'}};showState(streamView)");
  assert.equal(f.run('historyCanLoad'),false);assert.equal(f.run('loadEarlier.hidden'),true);assert.equal(f.nodes.get('#history').textContent,'');
});

test('connecting negotiates recent history windows without an unconsumed staged preview',async()=>{
  const f=await fixture(url=>url.endsWith('/events')?new Promise(()=>{}):undefined);
  f.run('connect=fixtureConnect');
  f.run('void connect(selectedId)');await tick();
  const request=f.requests.find(r=>r.url.endsWith('/events'));assert.ok(request);
  assert.equal(request.options.headers['x-codex-history-window'],'1');assert.equal(request.options.headers['x-codex-lazy-output'],'1');assert.equal(request.options.headers['x-codex-staged-preview'],undefined);
  f.run('active?.abort()');
});

test('thread list sends visible ids as a POST body so the relay can resolve running status',async()=>{
  const f=await fixture(async()=>response({projects:[],recent:[]}),{stubLoadThreads:false});
  f.run(`connected=true;selectedId='${id}'`);
  await f.run('loadThreads()');await tick();
  const call=f.requests.filter(r=>r.url.endsWith('/api/threads')).at(-1);
  assert.ok(call);assert.equal(call.options.method,'POST');
  assert.equal(call.options.headers['content-type'],'application/json');
  assert.deepEqual(JSON.parse(call.options.body).visibleThreads,[id]);
});

test('visible sidebar rows are observed on desktop and excluded when the mobile drawer is offscreen',async()=>{
  const other='22222222-2222-4222-8222-222222222222';
  const f=await fixture(async()=>response({projects:[],recent:[]}),{stubLoadThreads:false});
  f.run(`selectedId=null;projectList.append(renderTask({id:'${other}',title:'active'}));`);
  await f.run('loadThreads()');
  assert.deepEqual(JSON.parse(f.requests.filter(r=>r.url.endsWith('/api/threads')).at(-1).options.body).visibleThreads,[other]);
  f.run(`projectList.append(renderTask({id:'${other}',title:'active'}));window.innerWidth=375;projectList.rect={top:0,bottom:700,left:-300,right:0,width:300,height:700};projectList.querySelector('.task').rect={top:100,bottom:136,left:-300,right:0,width:300,height:36}`);
  await f.run('loadThreads()');
  assert.deepEqual(JSON.parse(f.requests.filter(r=>r.url.endsWith('/api/threads')).at(-1).options.body).visibleThreads,[]);
});

test('visible running tasks below the first four rows are included without observing offscreen tasks',async()=>{
  const ids=Array.from({length:9},(_,index)=>`${String(index+2).padStart(8,'0')}-2222-4222-8222-222222222222`);
  const f=await fixture(async()=>response({projects:[],recent:[]}),{stubLoadThreads:false});
  f.run(`selectedId='${id}';projectList.rect={top:0,bottom:700,left:0,right:250,width:250,height:700};`);
  for(let index=0;index<ids.length;index++) f.run(`{const row=renderTask({id:'${ids[index]}',title:'task ${index}',status:'unknown'});row.rect={top:${100+index*80},bottom:${136+index*80},left:0,right:250,width:250,height:36};projectList.append(row);}`);
  await f.run('loadThreads()');
  const visible=JSON.parse(f.requests.filter(r=>r.url.endsWith('/api/threads')).at(-1).options.body).visibleThreads;
  assert.deepEqual(visible,[id,...ids.slice(0,8)]);
  assert.ok(visible.includes(ids[6]),'lower visible running task is watched');
  assert.equal(visible.includes(ids[8]),false,'below-viewport task is not subscribed');
});

test('sidebar observation remains bounded even when many task rows share the viewport',async()=>{
  const f=await fixture();
  f.run(`selectedId=null;projectList.rect={top:0,bottom:700,left:0,right:250,width:250,height:700};for(let index=0;index<100;index++){const row=renderTask({id:String(index+2).padStart(8,'0')+'-2222-4222-8222-222222222222',title:'task',status:'unknown'});row.rect={top:100,bottom:136,left:0,right:250,width:250,height:36};projectList.append(row);}`);
  assert.equal(f.run('visibleStatusIds().length'),32);
  assert.equal(f.run('new Set(visibleStatusIds()).size'),32);
});

test('directory summary only shows confirmed running tasks while folded',async()=>{
  const ids=Array.from({length:6},(_,index)=>`${String(index+2).padStart(8,'0')}-3333-4333-8333-333333333333`);
  const f=await fixture();
  f.run(`selectedId=null;projectList.append(renderGroup('project:summary','project',${JSON.stringify(ids.map((id,index)=>({id,title:'task',status:index===5?'active':'idle'})))},false,false))`);
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.hidden"),false);
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.dataset.status"),'active');
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.title"),'目录内有任务进行中');
  f.run("projectStatusGroups.get('project:summary').heading.listeners.click()");
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.hidden"),true);
  f.run("projectStatusGroups.get('project:summary').heading.listeners.click()");
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.hidden"),false);
  f.run(`acceptSidebarStatuses(${JSON.stringify(Object.fromEntries(ids.map(id=>[id,'idle'])))})`);
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.hidden"),true);
  f.run(`acceptSidebarStatuses(${JSON.stringify({[ids[0]]:'unknown'})})`);
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.hidden"),true);
  f.run(`updateLiveTaskStatus('${ids[5]}','active')`);
  assert.equal(f.run("projectStatusGroups.get('project:summary').indicator.dataset.status"),'active');
});

test('visible folded directories keep observing hidden children while offscreen directories are excluded',async()=>{
  const ids=Array.from({length:8},(_,index)=>`${String(index+2).padStart(8,'0')}-4444-4444-8444-444444444444`);
  const offscreen='99999999-4444-4444-8444-444444444444';
  const f=await fixture();
  f.run(`selectedId=null;projectList.rect={top:0,bottom:700,left:0,right:250,width:250,height:700};projectList.append(renderGroup('project:visible','visible',${JSON.stringify(ids.map(id=>({id,title:'task',status:'unknown'})))},false,false));projectList.append(renderGroup('project:outside','outside',[{id:'${offscreen}',title:'outside',status:'unknown'}],false,false));for(const task of projectList.querySelectorAll('.task'))task.rect={top:0,bottom:0,left:0,right:0,width:0,height:0};projectStatusGroups.get('project:visible').heading.rect={top:100,bottom:138,left:0,right:250,width:250,height:38};projectStatusGroups.get('project:outside').heading.rect={top:800,bottom:838,left:0,right:250,width:250,height:38}`);
  assert.deepEqual(Array.from(f.run('visibleStatusIds()')),ids);
  assert.equal(f.run(`visibleStatusIds().includes('${offscreen}')`),false);
});

test('large folded directories rotate a bounded budget while retaining confirmed active children',async()=>{
  const ids=Array.from({length:80},(_,index)=>`${String(index+2).padStart(8,'0')}-5555-4555-8555-555555555555`);
  const active=ids.at(-1),f=await fixture();
  f.run(`selectedId=null;projectList.rect={top:0,bottom:700,left:0,right:250,width:250,height:700};projectList.append(renderGroup('project:large','large',${JSON.stringify(ids.map(id=>({id,title:'task',status:id===active?'active':'unknown'})))},false,false));for(const task of projectList.querySelectorAll('.task'))task.rect={top:0,bottom:0,left:0,right:0,width:0,height:0};projectStatusGroups.get('project:large').heading.rect={top:100,bottom:138,left:0,right:250,width:250,height:38}`);
  const observed=new Set();
  for(let attempt=0;attempt<3;attempt++) {
    const batch=Array.from(f.run('visibleStatusIds()'));
    assert.ok(batch.length<=32);assert.ok(batch.includes(active));
    for(const id of batch)observed.add(id);
  }
  assert.equal(observed.size,80);
});

test('directory status survives list rerender without changing selection and becomes unknown on disconnect',async()=>{
  const data={projects:[{id:'folder',name:'folder',threads:[{id,title:'running',status:'unknown'}]}],recent:[]};
  const f=await fixture();
  f.run(`renderThreadList(${JSON.stringify(data)});acceptSidebarStatuses({'${id}':'active'})`);
  assert.equal(f.run("projectStatusGroups.get('project:folder').indicator.dataset.status"),'active');
  f.run(`renderThreadList(${JSON.stringify(data)})`);
  assert.equal(f.run('selectedId'),id);
  assert.equal(f.run('projectStatusGroups.size'),1);
  assert.equal(f.run("projectStatusGroups.get('project:folder').indicator.dataset.status"),'active');
  f.run('stopSidebarStatuses()');
  assert.equal(f.run("projectStatusGroups.get('project:folder').indicator.hidden"),true);
  f.run(`acceptSidebarStatuses({'${id}':'idle'})`);
  assert.equal(f.run("projectStatusGroups.get('project:folder').indicator.hidden"),true);
  f.run('invalidateThreadList()');
  assert.equal(f.run('projectStatusGroups.size'),0);
});

test('sidebar SSE updates running indicators when retained tasks exceed the visible window',async()=>{
  const f=await fixture();
  f.run("projectList.append(renderTask({id:selectedId,title:'running task',status:'idle'}))");
  const marker=f.run("projectList.querySelector('.task-active')");
  assert.equal(marker.hidden,true);
  const statuses=Object.fromEntries([id,...Array.from({length:8},(_,index)=>`${String(index+2).padStart(8,'0')}-1111-4111-8111-111111111111`)].map(key=>[key,'active']));
  f.run(`handleEvent('event: sidebar-status\\ndata: '+${JSON.stringify(JSON.stringify(statuses))})`);
  assert.equal(marker.hidden,false);assert.equal(marker.dataset.status,'active');
  statuses[id]='idle';
  f.run(`handleEvent('event: sidebar-status\\ndata: '+${JSON.stringify(JSON.stringify(statuses))})`);
  assert.equal(marker.hidden,true);assert.equal(marker.dataset.status,'idle');
});

test('a confirmed list status settles handover before its deadline can hide a running task',async()=>{
  const f=await fixture(undefined,{manualHandoverTimers:true});
  f.run("projectList.append(renderTask({id:selectedId,title:'running',status:'idle'}));updateLiveTaskStatus(selectedId,'active');beginStatusHandover(selectedId)");
  assert.equal(f.handoverTimers.size,1);
  f.run("projectList.replaceChildren(renderTask({id:selectedId,title:'running',status:'active'}))");
  for(const fire of f.handoverTimers.values())fire();f.handoverTimers.clear();
  assert.equal(f.run("projectList.querySelector('.task').dataset.status"),'active');
  assert.equal(f.run("projectList.querySelector('.task-active').hidden"),false);
  assert.equal(f.run('statusHandovers.has(selectedId)'),false);
});

test('an inconclusive list status leaves the handover deadline to clear the old live spinner',async()=>{
  const f=await fixture(undefined,{manualHandoverTimers:true});
  f.run("projectList.append(renderTask({id:selectedId,title:'running',status:'idle'}));updateLiveTaskStatus(selectedId,'active');beginStatusHandover(selectedId);projectList.replaceChildren(renderTask({id:selectedId,title:'running',status:'unknown'}))");
  assert.equal(f.handoverTimers.size,1);
  assert.equal(f.run("projectList.querySelector('.task-active').dataset.status"),'checking');
  assert.equal(f.run("projectList.querySelector('.task-active').hidden"),false);
  f.run("acceptSidebarStatuses({[selectedId]:'unknown'})");
  assert.equal(f.run("projectList.querySelector('.task-active').dataset.status"),'checking');
  for(const fire of f.handoverTimers.values())fire();f.handoverTimers.clear();
  assert.equal(f.run("projectList.querySelector('.task-active').hidden"),true);
  assert.equal(f.run('statusHandovers.has(selectedId)'),false);
});

test('a fresh sidebar status resolves handover immediately, including idle',async()=>{
  const f=await fixture(undefined,{manualHandoverTimers:true});
  f.run("projectList.append(renderTask({id:selectedId,title:'running',status:'active'}));updateLiveTaskStatus(selectedId,'active');beginStatusHandover(selectedId);acceptSidebarStatuses({[selectedId]:'idle'})");
  assert.equal(f.run('statusHandovers.has(selectedId)'),false);
  assert.equal(f.run("projectList.querySelector('.task-active').hidden"),true);
  assert.equal(f.handoverTimers.size,0);
});

test('list refresh retains the selected task project and only fills a placeholder title',async()=>{
  const data={projects:[{id:'phone',name:'手机助手',threads:[]},{id:'code',name:'代码项目',threads:[{id,title:'侧栏任务标题'}]}],recent:[]};
  const f=await fixture(async()=>response(data),{stubLoadThreads:false});
  f.run("selectedTitle='新聊天';currentProject.value='phone'");
  await f.run('loadThreads()');
  assert.equal(f.nodes.get('#current-project').value,'code');assert.equal(f.nodes.get('#current-project').hidden,false);
  assert.equal(f.run('selectedTitle'),'侧栏任务标题');assert.equal(f.nodes.get('#title').textContent,'侧栏任务标题');
  f.run("selectedTitle='实时任务新标题';title.textContent=selectedTitle;currentProject.value='phone'");
  await f.run('loadThreads()');
  assert.equal(f.nodes.get('#current-project').value,'code');assert.equal(f.nodes.get('#title').textContent,'实时任务新标题');
  data.projects[1].threads=[];data.recent=[{id,title:'侧栏任务标题'}];
  await f.run('loadThreads()');
  assert.equal(f.nodes.get('#current-project').hidden,true);assert.equal(f.nodes.get('#current-project').value,'');
  f.run("selectedId=null;newDraft={projectId:'phone',pending:false,uncertain:false,attachments:[]};updateNewProjectOptions()");
  assert.equal(f.nodes.get('#current-project').hidden,false);assert.equal(f.nodes.get('#current-project').value,'phone');
});

test('list refresh keeps the pressed task attached until its click and then renders the latest list',async()=>{
  const next='22222222-2222-4222-8222-222222222222';
  let title='old';
  const f=await fixture(url=>url==='/api/threads'?response({projects:[],recent:[{id:next,title}]}):undefined,{stubLoadThreads:false});
  await f.run('loadThreads()');
  const list=f.run('projectList'), pressed=list.querySelector('.task');
  list.listeners.pointerdown({pointerId:7});
  title='new';await f.run('loadThreads()');
  assert.equal(list.querySelector('.task'),pressed);
  f.run('document.listeners.pointerup({pointerId:7});document.listeners.click()');
  pressed.listeners.click();
  assert.equal(f.run('selectedId'),next);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.notEqual(list.querySelector('.task'),pressed);
  assert.equal(list.querySelector('.task-title').textContent,'new');
  assert.equal(f.run('selectedId'),next);
});

test('cancelled pointer applies latest data and authorization failure discards deferred data',async()=>{
  let status=200,title='old';
  const f=await fixture(url=>url==='/api/threads'?response({projects:[],recent:[{id,title}]},status):undefined,{stubLoadThreads:false});
  await f.run('loadThreads()');const list=f.run('projectList'),old=list.querySelector('.task');
  list.listeners.pointerdown({pointerId:1});title='new';await f.run('loadThreads()');
  f.run('document.listeners.pointercancel({pointerId:1})');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.notEqual(list.querySelector('.task'),old);assert.equal(list.querySelector('.task-title').textContent,'new');
  list.listeners.pointerdown({pointerId:2});title='stale';await f.run('loadThreads()');
  status=401;await f.run('loadThreads()');
  f.run('document.listeners.pointerup({pointerId:2});document.listeners.click()');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(list.querySelector('.task'),null);assert.equal(list.querySelector('.list-error').textContent,'配对状态不可用，请重新配对');
});

test('a show-more click survives a concurrent list update and the expanded state is retained',async()=>{
  const recent=Array.from({length:6},(_,i)=>({id:`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`,title:`task ${i}`}));
  const f=await fixture(url=>url==='/api/threads'?response({projects:[],recent}):undefined,{stubLoadThreads:false});
  await f.run('loadThreads()');const list=f.run('projectList'),more=list.querySelector('.show-more');
  assert.equal(list.querySelectorAll('.task').length,5);
  list.listeners.pointerdown({pointerId:4});await f.run('loadThreads()');
  assert.equal(list.querySelector('.show-more'),more);
  f.run('document.listeners.pointerup({pointerId:4});document.listeners.click()');more.listeners.click();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(list.querySelectorAll('.task').length,6);assert.equal(f.run("expandedGroups.has('recent')"),true);
});

test('retryable list failures retain working task buttons and one notice until recovery',async()=>{
  let failed=false;
  const f=await fixture(url=>url==='/api/threads'?response(failed?{error:'host-offline'}:{projects:[],recent:[{id,title:'现有任务'}]},failed?503:200):undefined,{stubLoadThreads:false});
  await f.run('loadThreads()');
  const list=f.run('projectList'),task=list.querySelector('.task'),click=task.listeners.click;
  list.scrollTop=81;failed=true;
  await f.run('loadThreads()');await f.run('loadThreads()');
  assert.equal(list.querySelector('.task'),task);assert.equal(task.listeners.click,click);assert.equal(list.scrollTop,81);
  assert.equal(list.querySelectorAll('.list-error').length,1);assert.match(list.querySelector('.list-error').textContent,/电脑未连接.*正在重试/);
  const originalFetch=f.run('fetch');
  f.run("fetch=async()=>{throw new TypeError('network offline')}");await f.run('loadThreads()');
  assert.equal(list.querySelector('.task'),task);assert.equal(list.querySelectorAll('.list-error').length,1);
  assert.equal(list.querySelector('.list-error').textContent,'连接中断，正在重试');
  f.run('value => { fetch = value; }')(originalFetch);
  failed=false;await f.run('loadThreads()');
  assert.ok(list.querySelector('.task'));assert.equal(list.querySelector('.list-error'),null);assert.equal(list.scrollTop,81);
  assert.equal(f.run('listFailureStreak'),0);
});

test('list authorization failures clear old tasks and stop retrying',async()=>{
  let status=200;
  const f=await fixture(url=>url==='/api/threads'?response({projects:[],recent:[{id,title:'现有任务'}]},status):undefined,{stubLoadThreads:false});
  const list=f.run('projectList');
  for(const rejected of [401,403]){
    status=200;await f.run('loadThreads()');assert.ok(list.querySelector('.task'));
    status=rejected;const before=f.requests.filter(r=>r.url==='/api/threads').length;
    await Promise.all([f.run('loadThreads()'),f.run('loadThreads()')]);
    assert.equal(list.querySelector('.task'),null);assert.equal(list.querySelectorAll('.list-error').length,1);
    assert.equal(list.querySelector('.list-error').textContent,'配对状态不可用，请重新配对');
    assert.equal(f.run('listRetryTimer'),undefined);
    assert.equal(f.requests.filter(r=>r.url==='/api/threads').length,before+1);
  }
});

test('device invalidation clears retained tasks and ignores an old in-flight list',async()=>{
  let defer=false,release;
  const data={projects:[],recent:[{id,title:'旧设备任务'}]};
  const f=await fixture(url=>url==='/api/threads'?(defer?new Promise(resolve=>{release=()=>resolve(response(data));}):response(data)):undefined,{stubLoadThreads:false});
  await f.run('loadThreads()');const list=f.run('projectList');assert.ok(list.querySelector('.task'));
  defer=true;const pending=f.run('loadThreads()');
  f.run('invalidateThreadList()');assert.equal(list.querySelector('.task'),null);
  release();await pending;
  assert.equal(list.querySelector('.task'),null);assert.equal(list.querySelector('.list-error'),null);
  assert.equal(list.children[0].textContent,'正在加载任务');assert.equal(f.run('listRetryTimer'),undefined);
});

test('concurrent list refreshes share one request and at most one fresh trailing request',async()=>{
  let defer=false,inFlight=0,maxInFlight=0;const pending=[];
  const f=await fixture(url=>{
    if(url!=='/api/threads'||!defer)return undefined;
    maxInFlight=Math.max(maxInFlight,++inFlight);
    return new Promise(resolve=>pending.push(()=>{--inFlight;resolve(response({projects:[],recent:[]}));}));
  },{stubLoadThreads:false});
  defer=true;const before=f.requests.length;
  const first=f.run('loadThreads()'),second=f.run('loadThreads()'),third=f.run('loadThreads()');
  assert.equal(f.requests.length,before+1);assert.equal(inFlight,1);
  const nextId='22222222-2222-4222-8222-222222222222';
  f.run(`selectedId='${nextId}';statusHandovers.set('${id}',undefined)`);
  pending.shift()();await tick();
  assert.equal(f.requests.length,before+2);assert.equal(inFlight,1);
  const body=JSON.parse(f.requests.at(-1).options.body);
  assert.deepEqual(body.visibleThreads,[id,nextId]);assert.equal(body.handoverThread,id);
  const fourth=f.run('loadThreads()'),fifth=f.run('loadThreads()');
  assert.equal(f.requests.length,before+2);
  pending.shift()();await Promise.all([first,second,third,fourth,fifth]);await tick();
  assert.equal(maxInFlight,1);assert.equal(f.requests.length,before+2);assert.equal(inFlight,0);
  assert.equal(f.run('listLoadInFlight'),null);assert.ok(f.run('listRetryTimer'));
});

test('invalidated requests neither block a new device list nor release its in-flight lock',async()=>{
  let defer=false;const pending=[];
  const f=await fixture(url=>url==='/api/threads'&&defer?new Promise(resolve=>pending.push(value=>resolve(response(value)))):undefined,{stubLoadThreads:false});
  defer=true;const before=f.requests.length,old=f.run('loadThreads()');
  f.run("invalidateThreadList();currentDeviceId='new-device'");
  const current=f.run('loadThreads()');assert.equal(f.requests.length,before+2);
  pending.shift()({projects:[],recent:[{id,title:'旧设备任务'}]});await old;
  assert.equal(f.run("projectList.querySelector('.task')"),null);
  const merged=f.run('loadThreads()');assert.equal(f.requests.length,before+2);
  pending.shift()({projects:[],recent:[{id,title:'新设备任务'}]});await tick();
  assert.equal(f.requests.length,before+3);
  pending.shift()({projects:[],recent:[{id,title:'新设备任务'}]});await Promise.all([current,merged]);
  assert.equal(f.run("projectList.querySelector('.task-title').textContent"),'新设备任务');
});

test('a dispatched placeholder is dropped once the same text arrives as a real turn',async()=>{
  const f=await fixture();
  f.run("connected=true;outgoingMessages.set(outgoingScopeKey(selectedId),[{localId:'local-1',scopeKey:outgoingScopeKey(selectedId),scopeGeneration:historyScopeGeneration,threadId:selectedId,text:'你好',images:[],state:'unknown',messageDispatched:true}])");
  assert.equal(f.run('hasPendingOutgoing(selectedId)'),true);
  f.run("streamView={id:selectedId,title:'t',runtimeStatus:'idle',turns:[{id:'turn',status:'completed',items:[{id:'m',type:'userMessage',text:'你好'}]}],requests:[],history:{complete:true}};showState(streamView)");
  assert.equal(f.run('(outgoingMessages.get(outgoingScopeKey(selectedId))||[]).length'),0);
});
