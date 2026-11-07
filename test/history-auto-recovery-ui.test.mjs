import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const id='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(value={},status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,clone:()=>({json:async()=>value})});
async function fixture(handler) {
  class Element {
    constructor(){this.children=[];this.listeners={};this.dataset={};this.value='';this.style={};this.classList={toggle(){},contains(){return false;}};this.scrollHeight=300;this.clientHeight=500;this.scrollTop=0;}
    addEventListener(type,fn){this.listeners[type]=fn;}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}get childNodes(){return this.children;}setAttribute(){}querySelectorAll(){return [];}after(){}before(){}
  }
  const nodes=new Map(),requests=[],reserves=[],removes=[];
  const document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const store={read:async()=>null,reserve:async(...args)=>{reserves.push(args);return true;},remove:async(...args)=>{removes.push(args);return true;}};
  const context=vm.createContext({document,store,crypto:webcrypto,AbortController,URLSearchParams,TextDecoder,TextEncoder,Date,setTimeout,clearTimeout,localStorage:{getItem(){return null;},removeItem(){}},sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});return await handler?.(url,options)||response({projects:[],recent:[]});
  }});
  let source=await readFile(new URL('../public/desktop.js',import.meta.url),'utf8');
  source=source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())",'Promise.resolve(store)');
  const run=code=>vm.runInContext(code,context);run(source);run('const fixtureConnect=connect');await tick();
  run(`selectedId='${id}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=false;recoverableHistoryId=selectedId;recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});loadThreads=async()=>{};connect=async()=>{};updateComposer();`);
  return {run,nodes,requests,reserves,removes,submit:()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}})};
}

test('history is editable without takeover and only the explicit send recovers before dispatch',async()=>{
  const f=await fixture((url)=>url.endsWith('/recover')?response({status:'accepted'},202):url.endsWith('/messages')?response({status:'accepted'},202):undefined);
  assert.equal(f.nodes.get('#message').disabled,false);assert.equal(f.nodes.get('#recover-chat').hidden,true);
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
  assert.equal(f.run('recoveryState(currentDeviceId,selectedId).status'),'unknown');assert.equal(f.nodes.get('#recover-chat').hidden,false);
  f.run('updateComposer()');await f.run('runOutgoingQueue(selectedId)');await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/recover')).length,1);assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);assert.equal(f.nodes.get('#message').disabled,true);
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

test('new chats without older history do not show a paging button or partial-history notice',async()=>{
  const f=await fixture();
  f.run("connected=true;streamView={id:selectedId,title:'new',runtimeStatus:'idle',turns:[{id:'turn',status:'completed',items:[{id:'m',type:'userMessage',text:'first'}]}],requests:[],history:{complete:false,reason:'history-not-confirmed'}};showState(streamView)");
  assert.equal(f.run('historyCanLoad'),false);assert.equal(f.run('loadEarlier.hidden'),true);assert.equal(f.nodes.get('#history').textContent,'');
});

test('connecting negotiates recent history windows and staged preview before reading events',async()=>{
  const f=await fixture(url=>url.endsWith('/events')?new Promise(()=>{}):undefined);
  f.run('connect=fixtureConnect');
  f.run('void connect(selectedId)');await tick();
  const request=f.requests.find(r=>r.url.endsWith('/events'));assert.ok(request);
  assert.equal(request.options.headers['x-codex-history-window'],'1');assert.equal(request.options.headers['x-codex-staged-preview'],'1');
  f.run('active?.abort()');
});
