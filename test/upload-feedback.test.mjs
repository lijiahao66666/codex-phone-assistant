import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('upload failure reports stage/status/time and never submits a message', async () => {
  class Element {
    constructor() { this.children=[]; this.dataset={}; this.listeners={}; this.value=''; this.classList={toggle(){},contains(){return false;}}; }
    addEventListener(type,fn){this.listeners[type]=fn;} setAttribute(){} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} get childNodes(){return this.children;} querySelectorAll(){return [];} after(){} before(){}
  }
  const nodes=new Map(), document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const requests=[];
  const context=vm.createContext({document,Blob,AbortController,TextDecoder,TextEncoder,URL,Date,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}},fetch:async(url,options={})=>{
    requests.push({url,options});
    if(url.endsWith('/uploads'))return {ok:true,status:200,json:async()=>({uploadId:'22222222-2222-4222-8222-222222222222'})};
    if(url.includes('/chunks/'))return {ok:false,status:503,json:async()=>({error:'unavailable',extra:'private server detail'})};
    return {ok:true,status:200,json:async()=>({projects:[],recent:[]})};
  }});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  vm.runInContext("selectedId='11111111-1111-4111-8111-111111111111'; currentDeviceId='33333333-3333-4333-8333-333333333333'; recoveryChecks.set(recoveryKey(currentDeviceId, selectedId), {status:'ready'}); recoveries.set(recoveryKey(currentDeviceId, selectedId), {status:'clear'}); connected=true; imageUploadAvailable=true; imageDrafts.set(selectedId,[{kind:'file',file:Object.assign(new Blob(['test']),{name:'test.txt'})}]);",context);
  await nodes.get('#composer-form').listeners.submit({preventDefault(){}});
  assert.match(nodes.get('#send-status').textContent,/传输 1\/1 · 503 · unavailable · \d+秒/);
  assert.doesNotMatch(nodes.get('#send-status').textContent,/private server detail/);
  assert.equal(requests.some(r=>r.url.endsWith('/messages')),false);
  assert.equal(vm.runInContext('submissions.get(selectedId).uncertain',context),false);
  assert.equal(vm.runInContext('imageDrafts.get(selectedId).length',context),1);
  assert.ok(requests.some(r=>r.options.method==='DELETE'));
});
