import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('failed attachment can be restored to the composer and only resends after a new user submit', async () => {
  class Element {
    constructor() { this.children=[]; this.dataset={}; this.listeners={}; this.value=''; this.classList={toggle(){},contains(){return false;}}; }
    addEventListener(type,fn){this.listeners[type]=fn;} setAttribute(){} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} get childNodes(){return this.children;} querySelectorAll(){return [];} after(){} before(){}
  }
  const nodes=new Map(), document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const requests=[];
  let failUpload=true;
  const response=(status,value={})=>({ok:status>=200&&status<300,status,json:async()=>value});
  const context=vm.createContext({document,Blob,AbortController,TextDecoder,TextEncoder,URL,Date,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});
    if(url.endsWith('/capabilities'))return response(200,{imageUpload:true,imageChunkBytes:128*1024,uploadConcurrency:1,maxImageBytes:20*1024*1024});
    if(url.endsWith('/uploads'))return response(200,{uploadId:'22222222-2222-4222-8222-222222222222'});
    if(url.includes('/chunks/'))return failUpload?response(503,{error:'unavailable',extra:'private server detail'}):response(200);
    if(url.endsWith('/finish'))return response(200,{attachmentId:'33333333-3333-4333-8333-333333333333'});
    if(url.endsWith('/messages'))return response(202,{status:'accepted'});
    return response(200,{projects:[],recent:[]});
  }});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  // Let startup capability loading settle before setting the connected test state.
  await new Promise(resolve=>setImmediate(resolve));
  const run=code=>vm.runInContext(code,context);
  const submit=()=>nodes.get('#composer-form').listeners.submit({preventDefault(){}});
  const flattened=node=>[node,...node.children.flatMap(flattened)];
  run("selectedId='11111111-1111-4111-8111-111111111111'; connected=true; currentDeviceId='device'; recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'}); imageUploadAvailable=true; const retainedFile=Object.assign(new Blob(['test']),{name:'test.txt'}); imageDrafts.set(selectedId,[{kind:'file',file:retainedFile,previewPromise:Promise.resolve()}]); messageInput.value='original message';");
  await submit();
  const bubbleText=flattened(run('outgoingList')).map(node=>node.textContent||'').join('\n');
  assert.match(bubbleText,/传输 1\/1 · 503 · unavailable · \d+秒/);
  assert.doesNotMatch(bubbleText,/private server detail/);
  assert.equal(nodes.get('#send-status').textContent,'');
  assert.equal(nodes.get('#message').value,'');
  assert.equal(requests.some(r=>r.url.endsWith('/messages')),false);
  assert.equal(run('imageDrafts.has(selectedId)'),false);
  assert.equal(run('outgoingMessages.get(outgoingScopeKey())[0].images[0].file===retainedFile'),true);
  assert.ok(requests.some(r=>r.options.method==='DELETE'));

  // A live refresh cannot retry the failed write; recovery requires the explicit button.
  run('syncOutgoingWithView({id:selectedId,turns:[]})');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.filter(r=>r.url.includes('/chunks/')).length,1);
  const restore=flattened(run('outgoingList')).find(node=>node.textContent==='恢复草稿');
  assert.ok(restore);
  run("messageInput.value='next draft'");
  restore.listeners.click();
  assert.equal(nodes.get('#message').value,'next draft\noriginal message');
  assert.equal(run('imageDrafts.get(selectedId).length'),1);
  assert.equal(run('imageDrafts.get(selectedId)[0].file===retainedFile'),true);
  assert.equal(run('outgoingMessages.has(outgoingScopeKey())'),false);
  assert.equal(run('outgoingList.hidden'),true);
  assert.equal(requests.filter(r=>r.url.includes('/chunks/')).length,1);
  assert.equal(requests.some(r=>r.url.endsWith('/messages')),false);
  assert.equal(nodes.get('#send-status').textContent,'');

  failUpload=false;
  await submit();
  assert.equal(requests.filter(r=>r.url.includes('/chunks/')).length,2);
  const sent=requests.filter(r=>r.url.endsWith('/messages'));
  assert.equal(sent.length,1);
  assert.deepEqual(JSON.parse(sent[0].options.body),{text:'next draft\noriginal message',attachmentIds:['33333333-3333-4333-8333-333333333333']});
  assert.equal(nodes.get('#message').value,'');
  assert.equal(run('imageDrafts.has(selectedId)'),false);
  assert.equal(nodes.get('#send-status').textContent,'');
});
