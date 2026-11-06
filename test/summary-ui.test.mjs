import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('summary shows observed agents and files, and clears when disconnected', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; this.hidden = true; this.value = ''; this.open = false; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get childNodes() { return this.children; }
    querySelectorAll() { return []; }
    contains(target) { return target === this; }
  }
  const nodes = new Map();
  const document = { body: new Element(), listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); },
    createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  const requests = [];
  const context = vm.createContext({ document, fetch: async (url, options = {}) => { requests.push({ url, options }); return { ok: true, json: async () => url.includes('/file-preview') ? ({ text: 'file content' }) : url.includes('/agents/') ? ({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', turns: [{ items: [{ type: 'agentMessage', text: 'agent result' }, { type: 'reasoning', summary: ['<script>'] }, { type: 'fileChange', changes: [{ path: 'src/example.js' }] }, { type: 'mcpToolCall', server: 'test', tool: 'read' }] }] }) : ({ projects: [], recent: [] }) }; },
    AbortController, TextDecoder, setTimeout, clearTimeout, sessionStorage: { removeItem() {} }, window: { addEventListener() {} } });
  vm.runInContext(await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`selectedId = '12345678-1234-1234-1234-123456789012'; showState({ history: { complete: true }, turns: [{ id:'turn', status:'completed', items: [
    { type: 'subAgentActivity', agentPath: '/root/test', agentThreadId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', kind: 'started' },
    { type: 'fileChange', id: 'change', changes: [{ path: 'src/test.js' }], status: 'completed' },
    { type: 'agentMessage', phase:'final_answer', text:'完成' }
  ] }] })`, context);
  const sections = nodes.get('#summary-content').children[0].children;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].children[0].children[0].textContent, '子智能体 · 1');
  assert.equal(sections[0].children[0].children[1].className, 'chevron-icon');
  assert.equal(sections[0].children[1].children[0].children[0].textContent, 'test');
  vm.runInContext(`renderSummary({turns:[{items:[
    {type:'subAgentActivity',agentPath:'/root/done',kind:'completed'},
    {type:'subAgentActivity',agentPath:'/root/active',kind:'started'},
    {type:'subAgentActivity',agentPath:'/root/other',kind:'failed'},
    {type:'collabAgentToolCall',agents:[{id:'/root/running',status:'inProgress'}]}
  ]}]})`, context);
  const sorted = nodes.get('#summary-content').children[0].children[0].children.slice(1).map(row => row.children[0].children[0].textContent);
  assert.deepEqual(sorted, ['active', 'running', 'done', 'other']);
  assert.equal(sections[0].open, false);
  sections[0].children[1].children[0].children[0].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const history = document.body.children[0].children[0].children[1].children;
  assert.match(history[0].textContent, /非实时/);
  assert.equal(history[1].children[0].className, 'item assistant-message');
  assert.ok(requests.some(({ url }) => url.endsWith('/agents/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/history')));
  document.body.children = [];
  assert.equal(sections[1].children[1].children[0].children[0].textContent, 'test.js');
  assert.equal(sections[1].children[1].children[0].children[1].textContent, 'src');
  assert.equal(sections[1].children[1].children[0].children[0].title, 'src/test.js');
  assert.equal(sections[1].open, false);
  const work = nodes.get('#turns').children[0].children[0].children.find(node => node.className === 'work-activity');
  assert.equal(work.open, false);
  assert.equal(nodes.get('#turns').children[0].children[0].children.at(-1).children[0].textContent, '完成');
  sections[1].children[1].children[0].children[0].listeners.click();
  assert.equal(work.open, false);
  assert.equal(document.body.children[0].className, 'file-view-overlay');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.body.children[0].children[0].children[1].textContent, 'file content');
  assert.ok(requests.some(({ url }) => url.endsWith('/file-preview')));
  sections[1].open = true; sections[1].listeners.toggle();
  vm.runInContext("renderSummary({turns:[], history:{complete:true}})", context);
  assert.equal(nodes.get('#summary-content').children[0].children[1].open, true);
  nodes.get('#toggle-summary').listeners.click();
  assert.equal(nodes.get('#summary-panel').hidden, false);
  assert.equal(nodes.get('#summary-scrim').hidden, false);
  nodes.get('#summary-scrim').listeners.click();
  assert.equal(nodes.get('#summary-panel').hidden, true);
  assert.equal(nodes.get('#summary-scrim').hidden, true);
  nodes.get('#toggle-summary').listeners.click();
  nodes.get('#summary-panel').listeners.touchstart({ touches: [{ clientX: 10, clientY: 30 }] });
  nodes.get('#summary-panel').listeners.touchend({ changedTouches: [{ clientX: 100, clientY: 35 }] });
  assert.equal(nodes.get('#summary-panel').hidden, true);
  vm.runInContext('clearConversation()', context);
  assert.equal(nodes.get('#summary-content').children.length, 0);
});
