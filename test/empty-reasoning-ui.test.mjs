import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const threadId = '11111111-1111-4111-8111-111111111111';
const descendants = node => [node, ...node.children.flatMap(descendants)];
const hasClass = (node, name) => String(node.className || '').split(/\s+/).includes(name);
async function fixture() {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get childNodes() { return this.children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute() {}
    querySelectorAll() { return []; }
    after() {} before() {}
  }
  const nodes = new Map();
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement: () => new Element(), createDocumentFragment: () => new Element() };
  const context = vm.createContext({ document, AbortController, TextDecoder, setTimeout, clearTimeout, sessionStorage: { removeItem() {} }, window: { addEventListener() {} }, fetch: async () => ({ ok: true, json: async () => ({ projects: [], recent: [] }) }) });
  const run = code => vm.runInContext(code, context);
  run(await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8'));
  run(`selectedId='${threadId}';`);
  return {
    render(turn, mode) {
      if (mode === 'agent-history') return run(`renderAgentHistoryTurn(${JSON.stringify(turn)})`);
      const view = { id: threadId, runtimeStatus: turn.status === 'inProgress' ? 'active' : 'idle', requests: [], history: { complete: true }, turns: [turn] };
      run(`showState(${JSON.stringify(view)},${mode === 'live'})`);
      return nodes.get('#turns');
    },
  };
}
const user = { id: 'u', type: 'userMessage', text: '测试新会话' };
const final = { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '收到，你的新会话正常工作。' };
const emptyReasoning = { id: 'r', type: 'reasoning', summary: [] };

for (const mode of ['live', 'history', 'agent-history']) {
  if (mode !== 'agent-history') test(`${mode}: a failed turn shows the projected service error`, async () => {
    const f = await fixture();
    const rendered = descendants(f.render({ id: 'turn', status: 'failed', items: [{ id: 'error', type: 'error', message: '服务当前繁忙，请稍后重试。' }] }, mode));
    assert.ok(rendered.some(node => node.textContent === '服务当前繁忙，请稍后重试。'));
  });
  test(`${mode}: a simple response with empty reasoning has no empty work or thinking disclosure`, async () => {
    for (const summary of [[], [' ', '\n'], undefined]) {
      const f = await fixture();
      const rendered = descendants(f.render({ id: 'turn', status: 'completed', items: [user, { ...emptyReasoning, summary }, final] }, mode));
      assert.equal(rendered.filter(node => hasClass(node, 'work-activity')).length, 0);
      assert.equal(rendered.filter(node => hasClass(node, 'thinking')).length, 0);
      assert.equal(rendered.filter(node => node.textContent === final.text).length, 1);
      assert.equal(rendered.filter(node => node.textContent === user.text).length, 1);
    }
  });

  test(`${mode}: actual reasoning and tool activity remain visible around empty reasoning`, async () => {
    const f = await fixture();
    const rendered = descendants(f.render({ id: 'turn', status: 'completed', items: [user, emptyReasoning, { id: 'reasoning', type: 'reasoning', summary: ['实际思考摘要'] }, { ...emptyReasoning, id: 'r2' }, { id: 'tool', type: 'mcpToolCall', status: 'completed', server: 'test', tool: 'read' }, { ...emptyReasoning, id: 'r3' }, final] }, mode));
    assert.equal(rendered.filter(node => hasClass(node, 'work-activity')).length, 1);
    assert.equal(rendered.filter(node => hasClass(node, 'thinking')).length, 1);
    assert.equal(rendered.filter(node => node.textContent === '实际思考摘要').length, 1);
    assert.ok(rendered.some(node => String(node.textContent).includes('test · read')));
    assert.equal(rendered.filter(node => node.textContent === final.text).length, 1);
  });
}

test('live: empty reasoning preserves the active thinking indicator and later visible summary', async () => {
  const f = await fixture();
  const active = { id: '22222222-2222-4222-8222-222222222222', status: 'inProgress', items: [user, emptyReasoning] };
  let rendered = descendants(f.render(active, 'live'));
  assert.equal(rendered.filter(node => hasClass(node, 'work-activity')).length, 0);
  assert.ok(rendered.some(node => hasClass(node, 'live-thinking') && node.textContent === '正在思考'));
  rendered = descendants(f.render({ ...active, items: [user, { ...emptyReasoning, summary: ['开始分析'] }] }, 'live'));
  assert.ok(rendered.some(node => hasClass(node, 'live-activity-title') && node.textContent === '开始分析'));
  assert.equal(rendered.filter(node => hasClass(node, 'live-thinking')).length, 0);
});
