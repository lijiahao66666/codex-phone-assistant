import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const thread='11111111-1111-4111-8111-111111111111';
const upload='22222222-2222-4222-8222-222222222222';
const attachment='33333333-3333-4333-8333-333333333333';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response(status=200,value={}) { return {ok:status>=200&&status<300,status,json:async()=>value}; }
async function fixture(handler) {
  class Element {
    constructor(){this.children=[];this.dataset={};this.listeners={};this.value='';this.classList={toggle(){},contains(){return false;}};this.style={};this.scrollHeight=500;}
    append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}get childNodes(){return this.children;}addEventListener(type,fn){this.listeners[type]=fn;}setAttribute(){}querySelectorAll(){return [];}after(){}before(){}
  }
  const nodes=new Map(),requests=[],revoked=[];
  const document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const context=vm.createContext({document,Blob,AbortController,TextDecoder,TextEncoder,Date,setTimeout,clearTimeout,URL:{revokeObjectURL(url){revoked.push(url);}},sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});
    const custom = await handler?.(url,options);
    if(custom)return custom;
    if(url.endsWith('/capabilities'))return response(200,{
      imageUpload:true,maxImageBytes:20*1024*1024,
      imageChunkBytes:vm.runInContext('imageChunkBytes',context),
      uploadConcurrency:vm.runInContext('uploadConcurrency',context),
    });
    return response(200,{projects:[],recent:[]});
  }});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  await tick();
  vm.runInContext(`selectedId='${thread}';connected=true;currentDeviceId='device';recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});imageUploadAvailable=true;historyScope={hostId:'host',deviceId:'device'};`,context);
  return {context,nodes,requests,revoked,run:code=>vm.runInContext(code,context),submit:()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}})};
}
function flattened(node){return [node,...node.children.flatMap(flattened)];}

test('send immediately moves text and attachment into chat, keeps composer usable, and queues in order',async()=>{
  let resolveStart;
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return new Promise(resolve=>{resolveStart=resolve;});
    if(url.includes('/chunks/'))return response();
    if(url.endsWith('/finish'))return response(200,{attachmentId:attachment});
    if(url.endsWith('/messages'))return response(202,{status:'accepted'});
  });
  f.run(`messageInput.value='first';imageDrafts.set(selectedId,[{kind:'image',url:'blob:first',file:Object.assign(new Blob(['image']),{name:'first.png'})}]);`);
  const first=f.submit();
  assert.equal(f.nodes.get('#message').value,'');
  assert.equal(f.run('imageDrafts.has(selectedId)'),false);
  assert.equal(f.nodes.get('#send-status').textContent,'');
  assert.equal(f.nodes.get('#attachment-toggle').disabled,false);
  assert.ok(flattened(f.run('outgoingList')).some(n=>n.textContent==='first'));
  assert.ok(flattened(f.run('outgoingList')).some(n=>n.src==='blob:first'));
  assert.deepEqual(f.revoked,[]);
  f.run("messageInput.value='second';updateComposer()");
  const queued=f.submit();
  assert.equal(f.nodes.get('#message').value,'');
  assert.equal(f.run('outgoingMessages.get(outgoingScopeKey()).length'),2);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,0);
  await tick();
  resolveStart(response(200,{uploadId:upload}));
  await first;await queued;await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,1);
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[0].state"),'queued');
  // The acknowledgement removes only the local placeholder. A new live view releases the queue.
  f.run(`syncOutgoingWithView({id:selectedId,turns:[{items:[{id:'server-first',type:'userMessage',text:'first'}]}]})`);
  await tick();
  const sent=f.requests.filter(r=>r.url.endsWith('/messages')).map(r=>JSON.parse(r.options.body));
  assert.deepEqual(sent,[{text:'first',attachmentIds:[attachment]},{text:'second'}]);
  assert.deepEqual(f.revoked,['blob:first']);
  assert.equal(f.nodes.get('#send-status').textContent,'');
});

test('failed upload remains on its message, retains the attachment, and cannot auto-submit or retry',async()=>{
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.includes('/chunks/'))return response(503,{error:'unavailable',extra:'private detail'});
  });
  f.run(`imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob(['file']),{name:'test.txt'})}])`);
  await f.submit();await tick();
  const text=flattened(f.run('outgoingList')).map(n=>n.textContent).filter(Boolean).join('\n');
  assert.match(text,/传输 1\/1 · 503 · unavailable/);
  assert.doesNotMatch(text,/private detail/);
  assert.equal(f.nodes.get('#send-status').textContent,'');
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[0].state"),'failed');
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[0].images.length"),1);
  assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);
  await f.run('runOutgoingQueue(selectedId)');
  assert.equal(f.requests.filter(r=>r.url.includes('/chunks/')).length,1);
  assert.ok(f.requests.some(r=>r.options.method==='DELETE'));
});

test('unknown message outcome blocks its queued successor and never automatically sends again',async()=>{
  const f=await fixture(url=>url.endsWith('/messages')?response(504):undefined);
  f.run("messageInput.value='first'");await f.submit();
  f.run("messageInput.value='second'");await f.submit();await tick();
  f.run(`syncOutgoingWithView({id:selectedId,turns:[{items:[{id:'some-new-user',type:'userMessage',text:'first'}]}]})`);
  await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,1);
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[0].state"),'unknown');
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[1].state"),'queued');
  assert.equal(f.nodes.get('#send-status').textContent,'');
  assert.match(flattened(f.run('outgoingList')).map(n=>n.textContent).join('\n'),/发送结果未知/);
});

test('changing task does not leak local bubbles or dispatch an attachment into the new task',async()=>{
  let resolveStart;
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return new Promise(resolve=>{resolveStart=resolve;});
    if(url.includes('/chunks/'))return response();
    if(url.endsWith('/finish'))return response(200,{attachmentId:attachment});
  });
  f.run(`imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob(['file']),{name:'test.txt'})}])`);
  const pending=f.submit();
  await tick();
  f.run("selectedId='44444444-4444-4444-8444-444444444444';clearConversation()");
  assert.equal(f.run('outgoingList.hidden'),true);
  resolveStart(response(200,{uploadId:upload}));await pending;await tick();
  assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);
  assert.equal(f.requests.some(r=>r.url.includes('44444444')),false);
  f.run(`selectedId='${thread}';renderOutgoingMessages()`);
  assert.equal(f.run('outgoingList.hidden'),false);
  assert.equal(f.run("outgoingMessages.get(outgoingScopeKey())[0].state"),'queued');
});

test('device scope change aborts old pending work and cannot reuse new device credentials',async()=>{
  let resolveStart;
  const f=await fixture((url,options)=>url.endsWith('/uploads')&&options.method==='POST'?new Promise(resolve=>{resolveStart=resolve;}):undefined);
  f.run(`imageDrafts.set(selectedId,[{kind:'image',url:'blob:old',file:Object.assign(new Blob(['file']),{name:'test.png'})}])`);
  const pending=f.submit();
  await tick();
  f.run("resetHistoryScope();historyScope={hostId:'new-host',deviceId:'new-device'};renderOutgoingMessages()");
  resolveStart(response(200,{uploadId:upload}));await pending;await tick();
  assert.equal(f.run('outgoingList.hidden'),true);
  assert.equal(f.requests.some(r=>r.url.endsWith('/messages')),false);
  assert.equal(f.requests.some(r=>r.options.headers?.['x-codex-expected-device']==='new-device'),false);
  assert.deepEqual(f.revoked,['blob:old']);
});

test('capabilities negotiate 512 KB chunks and preserve 128 KB compatibility',async()=>{
  let bytes=512*1024;
  const f=await fixture(url=>url.endsWith('/capabilities')?response(200,{imageUpload:true,imageChunkBytes:bytes,maxImageBytes:20*1024*1024}):undefined);
  await f.run('loadCapabilities()');assert.equal(f.run('imageChunkBytes'),512*1024);
  bytes=128*1024;await f.run('loadCapabilities()');assert.equal(f.run('imageChunkBytes'),128*1024);
  bytes=1024*1024;await f.run('loadCapabilities()');assert.equal(f.run('imageUploadAvailable'),false);
});

test('upload refreshes stale 512 KB capabilities and sends original bytes serially in 128 KB chunks',async()=>{
  let hostBytes=512*1024,hostConcurrency=2,active=0,maxActive=0;
  const bodies=[];
  const f=await fixture(async(url,options)=>{
    if(url.endsWith('/capabilities'))return response(200,{imageUpload:true,imageChunkBytes:hostBytes,uploadConcurrency:hostConcurrency,maxImageBytes:20*1024*1024});
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.includes('/chunks/')){
      active++;maxActive=Math.max(maxActive,active);
      assert.equal(options.headers['content-encoding'],undefined);
      bodies.push({seq:Number(url.split('/').at(-1)),bytes:new Uint8Array(await options.body.arrayBuffer())});
      await tick();active--;return response();
    }
    if(url.endsWith('/finish'))return response(200,{attachmentId:attachment});
    if(url.endsWith('/messages'))return response(202);
  });
  await f.run('loadCapabilities()');
  assert.equal(f.run('imageChunkBytes'),512*1024);
  assert.equal(f.run('uploadConcurrency'),2);
  hostBytes=128*1024;hostConcurrency=1;
  f.run(`const originalBytes=Uint8Array.from({length:256*1024},(_,i)=>i%251);imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob([originalBytes]),{name:'original.bin'})}]);`);
  await f.submit();
  assert.equal(bodies.length,2);
  assert.equal(maxActive,1);
  assert.ok(bodies.every(chunk=>chunk.bytes.length<=128*1024));
  const restored=Buffer.concat(bodies.sort((a,b)=>a.seq-b.seq).map(chunk=>Buffer.from(chunk.bytes)));
  assert.deepEqual(restored,Buffer.from(f.run('originalBytes')));
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,1);
  assert.equal(f.nodes.get('#send-status').textContent,'');
});

test('negotiated two-chunk pipeline overlaps requests and waits for both acknowledgements before finish',async()=>{
  const pending=new Map();let active=0,maxActive=0;
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.includes('/chunks/'))return new Promise(resolve=>{active++;maxActive=Math.max(maxActive,active);pending.set(Number(url.split('/').at(-1)),()=>{active--;resolve(response());});});
    if(url.endsWith('/finish'))return response(200,{attachmentId:attachment});
    if(url.endsWith('/messages'))return response(202);
  });
  f.run(`uploadConcurrency=2;imageChunkBytes=512*1024;imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob([new Uint8Array(3*512*1024)]),{name:'test.bin'})}]);`);
  const sent=f.submit();await tick();
  assert.deepEqual([...pending.keys()],[0,1]);assert.equal(maxActive,2);
  pending.get(1)();await tick();
  assert.ok(pending.has(2));assert.equal(f.requests.some(r=>r.url.endsWith('/finish')),false);
  pending.get(2)();await tick();assert.equal(f.requests.some(r=>r.url.endsWith('/finish')),false);
  pending.get(0)();await sent;
  assert.ok(f.requests.some(r=>r.url.endsWith('/finish')));
  assert.equal(f.requests.filter(r=>r.url.endsWith('/messages')).length,1);
  assert.equal(f.nodes.get('#send-status').textContent,'');
});

test('pipeline failure aborts the other in-flight chunk and does not finish or retry',async()=>{
  let siblingAborted=false;
  const f=await fixture((url,options)=>{
    if(url.endsWith('/uploads')&&options.method==='POST')return response(200,{uploadId:upload});
    if(url.endsWith('/chunks/0'))return new Promise(resolve=>setImmediate(()=>resolve(response(503,{error:'unavailable'}))));
    if(url.endsWith('/chunks/1'))return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{siblingAborted=true;reject(new Error('aborted'));},{once:true});});
  });
  f.run(`uploadConcurrency=2;imageChunkBytes=512*1024;imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob([new Uint8Array(2*512*1024)]),{name:'test.bin'})}]);`);
  await f.submit();await tick();
  assert.equal(siblingAborted,true);
  assert.equal(f.requests.some(r=>r.url.endsWith('/finish')||r.url.endsWith('/messages')),false);
  assert.equal(f.requests.filter(r=>r.url.includes('/chunks/')).length,2);
  assert.match(flattened(f.run('outgoingList')).map(n=>n.textContent).join('\n'),/传输 1\/2 · 503/);
});
