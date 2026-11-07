import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('recorded agent activity retains failure states and collapsible file differences', async () => {
  class Element {
    constructor(){this.children=[];this.dataset={};this.listeners={};this.value='';this.classList={toggle(){}};}
    append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} get childNodes(){return this.children;} addEventListener(t,f){this.listeners[t]=f;} setAttribute(){} querySelectorAll(){return [];} after(){} before(){}
  }
  const nodes=new Map(),document={querySelector(k){if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k);},createElement(){return new Element();},createDocumentFragment(){return new Element();}};
  const context=vm.createContext({document,fetch:async()=>({ok:true,json:async()=>({projects:[],recent:[]})}),AbortController,TextDecoder,setTimeout,clearTimeout,sessionStorage:{removeItem(){}},window:{addEventListener(){}}});
  vm.runInContext(await readFile(new URL('../public/desktop.js',import.meta.url),'utf8'),context);
  const row=vm.runInContext(`renderAgentHistoryTurn({status:'completed',items:[
    {type:'fileChange',status:'failed',changes:[{path:'/src/example.js',diff:'-old\\n+new'}]},
    {type:'mcpToolCall',status:'interrupted',server:'test',tool:'read'},
    {type:'subAgentActivity',kind:'completed',agentPath:'/root/reviewer'},
    {type:'collabAgentToolCall',status:'failed',agents:[{id:'/root/worker',status:'failed'}]},
    {type:'agentMessage',phase:'final_answer',text:'done'}
  ]})`,context);
  const flat=node=>[node,...node.children.flatMap(flat)];
  const all=flat(row);
  assert.ok(all.some(n=>n.textContent==='编辑失败 example.js'));
  assert.ok(all.some(n=>n.textContent==='调用已中断 test · read'));
  assert.ok(all.some(n=>n.textContent==='reviewer · 已完成'));
  assert.ok(all.some(n=>n.textContent==='worker · 失败'));
  const diff=all.find(n=>n.className==='file-diff-details');
  assert.equal(diff.children[0].textContent,'查看差异');
  assert.equal(diff.children[1].textContent,'-old\n+new');
  assert.equal(all.some(n=>typeof n.textContent==='string'&&n.textContent.startsWith('已编辑')),false);
  assert.equal(row.children[0].className,'work-activity');
});
