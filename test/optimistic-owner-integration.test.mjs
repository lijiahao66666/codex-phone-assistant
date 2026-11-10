import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const thread='11111111-1111-4111-8111-111111111111';
const upload='22222222-2222-4222-8222-222222222222';
const attachment='33333333-3333-4333-8333-333333333333';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(status=200,value={})=>({ok:status>=200&&status<300,status,json:async()=>value});
async function fixture(handler) {
  class Element {
    constructor(){this.children=[];this.dataset={};this.listeners={};this.value='';this.style={};this.classList={toggle(){},contains(){return false;}};}
    append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}get childNodes(){return this.children;}addEventListener(type,fn){this.listeners[type]=fn;}setAttribute(){}querySelectorAll(){return [];}after(){}before(){}
  }
  const nodes=new Map(),requests=[],connections=[];
  const document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const context=vm.createContext({document,Blob,AbortController,TextDecoder,TextEncoder,URL,Date,setTimeout,clearTimeout,crypto:webcrypto,connections,localStorage:{getItem(){return null;},setItem(){},removeItem(){}},sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});const custom=await handler?.(url,options);if(custom)return custom;
    if(url.endsWith('/capabilities'))return response(200,{imageUpload:true,imageChunkBytes:128*1024,uploadConcurrency:1,maxImageBytes:20*1024*1024});
    if(url.endsWith('/messages'))return response(202,{status:'accepted'});
    return response(200,{projects:[],recent:[]});
  }});
  const run=code=>vm.runInContext(code,context);
  run(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'));await tick();
  run(`selectedId='${thread}';connected=true;imageUploadAvailable=true;currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});connect=async id=>{connections.push(id);updateComposer();};loadThreads=async()=>{};`);
  return {run,nodes,requests,connections,submit:()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}})};
}
function seedQueued(f,text='queued') {
  f.run(`outgoingMessages.set(outgoingScopeKey(),[{localId:'seed',scopeKey:outgoingScopeKey(),scopeGeneration:historyScopeGeneration,threadId:selectedId,text:${JSON.stringify(text)},images:[],state:'queued',messageDispatched:false}]);`);
}
const sent=f=>f.requests.filter(request=>request.url.endsWith('/messages'));

test('new chat first text uses creation endpoint and preserves automatic or explicit model selection',async()=>{
  for(const explicit of [false,true]) {
    const f=await fixture(url=>url==='/api/chats'?response(202,{threadId:thread}):undefined);
    f.run(`selectedId=null;newModels=[{model:'model-a',supportedReasoningEfforts:['high']}];newDraft={projectId:'project',attachments:[],model:${explicit?"'model-a'":'null'},effort:${explicit?"'high'":'null'},pending:false,uncertain:false};messageInput.value='first';`);
    await f.submit();
    const creations=f.requests.filter(request=>request.url==='/api/chats');assert.equal(creations.length,1);
    const payload=JSON.parse(creations[0].options.body);assert.equal(payload.text,'first');assert.equal(payload.projectId,'project');assert.match(payload.requestId,/^[a-f0-9-]{36}$/);
    assert.equal(payload.model,explicit?'model-a':undefined);assert.equal(payload.effort,explicit?'high':undefined);
    assert.equal(sent(f).length,0);assert.equal(f.run('newDraft'),null);assert.equal(f.run('outgoingMessages.size'),0);assert.equal(f.nodes.get('#message').value,'');assert.deepEqual(f.connections,[thread]);
  }
});

test('new chat first attachment retains prepare and creation-bound upload before submit',async()=>{
  const f=await fixture((url,options)=>{
    if(url==='/api/chats/prepare')return response(202,{threadId:thread});
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.includes('/chunks/'))return response();
    if(url.endsWith('/finish'))return response(200,{attachmentId:attachment});
    if(url==='/api/chats/submit')return response(202,{threadId:thread});
  });
  f.run(`selectedId=null;newModels=[];newDraft={projectId:'project',attachments:[{file:Object.assign(new Blob(['original']),{name:'test.txt'}),kind:'file',previewPromise:Promise.resolve()}],model:null,effort:null,pending:false,uncertain:false};messageInput.value='first file';`);
  await f.submit();
  const prepare=f.requests.find(request=>request.url==='/api/chats/prepare');assert.ok(prepare);
  const prepared=JSON.parse(prepare.options.body);assert.match(prepared.digest,/^[a-f0-9]{64}$/);
  const uploads=f.requests.filter(request=>/\/uploads/.test(request.url));assert.equal(uploads.length,3);
  for(const request of uploads)assert.equal(request.options.headers['x-creation-id'],prepared.requestId);
  const submit=f.requests.find(request=>request.url==='/api/chats/submit');assert.ok(submit);assert.deepEqual(JSON.parse(submit.options.body),{requestId:prepared.requestId,text:'first file',attachmentIds:[attachment],title:'first file'});
  assert.equal(sent(f).length,0);assert.equal(f.run('outgoingMessages.size'),0);
});

test('unknown first creation result keeps legacy write lock until the user explicitly clears it',async()=>{
  const f=await fixture(url=>url==='/api/chats'?response(504,{error:'start-unknown',threadId:thread}):undefined);
  f.run("selectedId=null;newModels=[];newDraft={projectId:'project',attachments:[],model:null,effort:null,pending:false,uncertain:false};messageInput.value='first';");await f.submit();
  assert.equal(f.run('submissions.get(selectedId).uncertain'),true);assert.equal(f.nodes.get('#unlock-send').hidden,false);
  f.run("messageInput.value='next'");await f.submit();assert.equal(sent(f).length,0);assert.equal(f.nodes.get('#message').value,'next');
  f.nodes.get('#unlock-send').listeners.click();await f.submit();assert.equal(sent(f).length,1);
});

test('recovery gate holds an existing queue and releasing it wakes the queue without another live message',async()=>{
  const f=await fixture();seedQueued(f);
  f.run("recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'checking'});updateComposer()");await tick();assert.equal(sent(f).length,0);
  f.run("recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});updateComposer()");await tick();assert.equal(sent(f).length,1);
});

test('recovery becoming blocked during upload is checked again before message dispatch',async()=>{
  let finish;
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.includes('/chunks/'))return response();
    if(url.endsWith('/finish'))return new Promise(resolve=>{finish=resolve;});
  });
  f.run("imageDrafts.set(selectedId,[{file:Object.assign(new Blob(['file']),{name:'test.txt'}),kind:'file'}]);messageInput.value='file'");
  const work=f.submit();await tick();assert.equal(typeof finish,'function');
  f.run("recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'locked'})");finish(response(200,{attachmentId:attachment}));await work;
  assert.equal(sent(f).length,0);assert.equal(f.run('outgoingMessages.get(outgoingScopeKey())[0].state'),'queued');
  assert.ok(f.requests.some(request=>request.options.method==='DELETE'));
  f.run('resetHistoryScope()');
});

test('model lock holds queued sends and pending sends block model and mode changes',async()=>{
  const f=await fixture();seedQueued(f);
  f.run("liveRuntimeStatus='idle';liveMode='default';liveModel={model:'model-a',effort:'high'};modelCatalog=[{model:'model-a',displayName:'A',supportedReasoningEfforts:['high']},{model:'model-b',displayName:'B',supportedReasoningEfforts:['high']}];modelChanges.set(selectedId,{message:'unknown'});updateComposer()");
  await tick();assert.equal(sent(f).length,0);assert.equal(f.run('modelControl.disabled'),true);assert.equal(f.nodes.get('#mode-choose').disabled,true);
  await f.run("requestModelChange('model-b','high')");await f.nodes.get('#mode-choose').listeners.click();
  assert.equal(f.requests.some(request=>/\/(model|mode)$/.test(request.url)&&request.options.method==='POST'),false);
  f.run('modelChanges.delete(selectedId);updateComposer()');await tick();assert.equal(sent(f).length,1);
});

test('prepared new draft blocks an existing queue and stale restore buttons cannot change the new draft',async()=>{
  const f=await fixture();seedQueued(f);
  f.run("newDraft={projectId:'project',attachments:[],prepared:{threadId:selectedId,uploaded:[]},pending:false,uncertain:false};messageInput.value='new draft';updateComposer()");await tick();assert.equal(sent(f).length,0);
  f.run("newDraft=null;outgoingMessages.get(outgoingScopeKey())[0].state='failed';renderOutgoingMessages()");
  const flatten=node=>[node,...node.children.flatMap(flatten)];const restore=flatten(f.run('outgoingList')).find(node=>node.textContent==='恢复草稿');assert.ok(restore);
  f.run("newDraft={projectId:'project',attachments:[],pending:false,uncertain:false};messageInput.value='new draft'");restore.listeners.click();
  assert.equal(f.nodes.get('#message').value,'new draft');assert.equal(f.run('newDraft.attachments.length'),0);assert.equal(f.run('outgoingMessages.get(outgoingScopeKey()).length'),1);
});
