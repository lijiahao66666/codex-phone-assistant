import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const id='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(value={},status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,clone:()=>({json:async()=>value})});
async function fixture(handler, { stubLoadThreads = true } = {}) {
  class Element {
    constructor(){this.children=[];this.listeners={};this.dataset={};this.value='';this.style={};this.classList={toggle(){},contains(){return false;}};this.scrollHeight=300;this.clientHeight=500;this.scrollTop=0;}
    addEventListener(type,fn){this.listeners[type]=fn;}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}get childNodes(){return this.children;}setAttribute(){}after(){}before(){}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.startsWith('.')&&String(node.className||'').split(/\s+/).includes(selector.slice(1))?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    cloneNode(){const copy=new Element();copy.value=this.value;copy.textContent=this.textContent;return copy;}
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
  run(`selectedId='${id}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=false;recoverableHistoryId=selectedId;recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});${stubLoadThreads ? 'loadThreads=async()=>{};' : ''}connect=async()=>{};updateComposer();`);
  return {run,nodes,requests,reserves,removes,submit:()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}})};
}

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

test('connecting negotiates recent history windows and staged preview before reading events',async()=>{
  const f=await fixture(url=>url.endsWith('/events')?new Promise(()=>{}):undefined);
  f.run('connect=fixtureConnect');
  f.run('void connect(selectedId)');await tick();
  const request=f.requests.find(r=>r.url.endsWith('/events'));assert.ok(request);
  assert.equal(request.options.headers['x-codex-history-window'],'1');assert.equal(request.options.headers['x-codex-staged-preview'],'1');
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
