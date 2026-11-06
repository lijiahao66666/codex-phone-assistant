import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('scrolling up loads one page, preserves position, and stops at the end', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; this.value = ''; this.scrollHeight = 1000; this.clientHeight = 500; this.scrollTop = 0; }
    addEventListener(type, fn) { this.listeners[type] = fn; } setAttribute() {} append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } get childNodes() { return this.children; } querySelectorAll() { return []; }
  }
  const nodes = new Map();
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  let resolvePage, requests = 0;
  const fetch = url => url.includes('/history-page?') ? (requests++, new Promise(resolve => { resolvePage = resolve; })) : Promise.resolve({ ok: true, json: async () => ({ projects: [], recent: [] }) });
  const context = vm.createContext({ document, fetch, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout, sessionStorage: { removeItem() {} }, window: { addEventListener() {} } });
  vm.runInContext(await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8'), context);
  const id = '11111111-1111-1111-1111-111111111111', hash = 'a'.repeat(64);
  vm.runInContext(`selectedId='${id}'; connected=true; streamView={id:selectedId,turns:[{id:'recent',items:[]}],history:{historicalHash:'${hash}',cursor:'recent',keyField:'id'}}; historyCanLoad=true; updateHistoryControl(); showState=()=>{conversation.scrollHeight=1400;historyCanLoad=false}`, context);
  const button = vm.runInContext('loadEarlier', context);
  assert.equal(button.hidden, true);
  const scroll = nodes.get('.conversation');
  scroll.scrollTop = 400; scroll.listeners.scroll();
  scroll.scrollTop = 80; scroll.listeners.scroll();
  assert.equal(button.hidden, false); assert.equal(button.textContent, '加载中...');
  scroll.scrollTop = 30; scroll.listeners.scroll();
  assert.equal(requests, 1);
  resolvePage({ ok: true, json: async () => ({ threadId:id, historicalHash:hash, before:'recent', keyField:'id', turns:[{id:'older',items:[]}], nextBefore:null, complete:true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scroll.scrollTop, 430);
  assert.equal(vm.runInContext('loadedHistory.nextBefore', context), null);
  scroll.scrollTop = 20; scroll.listeners.scroll();
  assert.equal(requests, 1);
});

test('failed automatic page waits for manual retry and late response cannot cross chats', async () => {
  class Element {
    constructor() { this.children=[]; this.dataset={}; this.listeners={}; this.classList={toggle(){}}; this.value=''; this.scrollHeight=1000; this.clientHeight=500; this.scrollTop=0; }
    addEventListener(type,fn){this.listeners[type]=fn;} setAttribute(){} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} get childNodes(){return this.children;} querySelectorAll(){return [];}
  }
  const nodes=new Map(), document={querySelector(key){if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  let count=0, resolveRetry;
  const fetch=url=>url.includes('/history-page?') ? (++count===1 ? Promise.reject(new Error('offline')) : new Promise(resolve=>{resolveRetry=resolve;})) : Promise.resolve({ok:true,json:async()=>({projects:[],recent:[]})});
  const context=vm.createContext({document,fetch,URLSearchParams,AbortController,TextDecoder,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}}});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  const id='11111111-1111-1111-1111-111111111111',hash='b'.repeat(64);
  vm.runInContext(`selectedId='${id}'; connected=true; streamView={id:selectedId,turns:[{id:'recent',items:[]}],history:{historicalHash:'${hash}',cursor:'recent',keyField:'id'}}; historyCanLoad=true; updateHistoryControl()`,context);
  const scroll=nodes.get('.conversation'); scroll.scrollTop=400; scroll.listeners.scroll(); scroll.scrollTop=60; scroll.listeners.scroll();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.get('#history').textContent,'历史加载失败，请重试');
  scroll.scrollTop=20; scroll.listeners.scroll(); assert.equal(count,1);
  const button=vm.runInContext('loadEarlier',context); assert.equal(button.hidden,false); assert.equal(button.textContent,'重新加载更早消息');
  const retry=button.listeners.click(); assert.equal(count,2);
  vm.runInContext("selectedId='22222222-2222-2222-2222-222222222222'; clearConversation()",context);
  resolveRetry({ok:true,json:async()=>({threadId:id,historicalHash:hash,before:'recent',keyField:'id',turns:[{id:'older',items:[]}],nextBefore:null,complete:true})});
  await retry;
  assert.equal(vm.runInContext('loadedHistory',context),null);
});

test('short content and invalidated history provide an accessible load action', async () => {
  class Element { constructor(){this.children=[];this.dataset={};this.listeners={};this.classList={toggle(){}};this.value='';this.scrollHeight=300;this.clientHeight=500;this.scrollTop=0;} addEventListener(t,f){this.listeners[t]=f;} setAttribute(){} append(...n){this.children.push(...n);} replaceChildren(...n){this.children=n;} get childNodes(){return this.children;} querySelectorAll(){return [];} }
  const nodes=new Map(),document={querySelector(k){if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const context=vm.createContext({document,fetch:async()=>({ok:true,json:async()=>({projects:[],recent:[]})}),AbortController,TextDecoder,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}}});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  vm.runInContext('historyCanLoad=true; updateHistoryControl()',context);
  const button=vm.runInContext('loadEarlier',context); assert.equal(button.hidden,false); assert.equal(button.textContent,'加载更早消息');
  vm.runInContext("conversation.scrollHeight=1000; loadedHistory={stale:true}; updateHistoryControl()",context);
  assert.equal(button.hidden,false); assert.equal(button.textContent,'历史已变化，刷新');
  vm.runInContext('loadedHistory=null; historyCanLoad=false; updateHistoryControl()',context); assert.equal(button.hidden,true);
});
