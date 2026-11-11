import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { desktopView } from '../src/desktop/view.mjs';
import { makeWindow } from '../src/desktop/history-pagination.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const descendants = node => [node, ...node.children.flatMap(descendants)];
async function fixture(handler) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.attributes = {}; this.classList = { toggle() {}, contains() { return false; } }; this.focusCount = 0; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) if (node && typeof node === 'object') node.parentElement = this; }
    replaceChildren(...nodes) { if (this.contains(document.activeElement)) document.activeElement = document.body; for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } }
    get childNodes() { return this.children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    querySelectorAll(selector) { return descendants(this).slice(1).filter(node => selector.split(',').some(part => part.trim().startsWith('.') ? String(node.className || '').split(/\s+/).includes(part.trim().slice(1)) : part === 'button[type="submit"]' ? node.type === 'submit' : part === 'input[type=radio]' ? node.type === 'radio' : false)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(target) { return Boolean(target) && descendants(this).includes(target); }
    get isConnected() { let node = this; while (node && node !== document.body) node = node.parentElement; return node === document.body; }
    closest(selector) { let node = this; while (node) { if (selector === 'form' && node.tagName === 'FORM') return node; node = node.parentElement; } return null; }
    focus() { document.activeElement = this; this.focusCount++; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = Math.min(start, this.value.length); this.selectionEnd = Math.min(end, this.value.length); this.selectionDirection = direction; }
    after(...nodes) { if (this.parentElement) { const parent = this.parentElement, index = parent.children.indexOf(this); parent.children.splice(index + 1, 0, ...nodes); for (const node of nodes) node.parentElement = parent; } }
    before(...nodes) { if (this.parentElement) { const parent = this.parentElement, index = parent.children.indexOf(this); parent.children.splice(index, 0, ...nodes); for (const node of nodes) node.parentElement = parent; } }
  }
  const nodes = new Map(), requests = [];
  const store = { read: async () => null, reserve: async () => true, remove: async () => true };
  const document = { body: new Element(), querySelector(key) { if (!nodes.has(key)) { const node = new Element(); nodes.set(key, node); this.body.append(node); } return nodes.get(key); }, createElement(tag) { const node = new Element(); node.tagName = tag.toUpperCase(); return node; }, createDocumentFragment: () => new Element() };
  const context = vm.createContext({ document, store, AbortController, URLSearchParams, TextDecoder, Date, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    fetch: async (url, options = {}) => { requests.push({ url, options }); return await handler?.(url, options) || response({ projects: [], recent: [] }); } });
  let source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  source = source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source); await tick();
  run(`selectedId='${threadId}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=true;loadThreads=async()=>{};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});`);
  return { nodes, requests, run, document, show(view, live = true) { run(`showState(${JSON.stringify({ id: threadId, runtimeStatus: 'idle', requests: [], turns: [], history: { complete: true }, ...view })},${live})`); }, find(selector) { return [...nodes.values(), run('questionPanel')].flatMap(descendants).find(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); } };
}

test('live approval submits one decision while pending and history never exposes its buttons', async () => {
  let release;
  const f = await fixture(url => url.endsWith('/approvals') ? new Promise(resolve => { release = () => resolve(response()); }) : undefined);
  const view = { requests: [{ id: 'approval', kind: 'command', command: 'echo isolated' }] };
  f.show(view, false);
  assert.equal(f.find('.approval-accept'), undefined);
  f.show(view);
  const accept = f.find('.approval-accept'), decline = f.find('.approval-decline');
  const work = accept.listeners.click();
  await decline.listeners.click(); await accept.listeners.click();
  assert.equal(f.requests.filter(request => request.url.endsWith('/approvals')).length, 1);
  assert.equal(accept.disabled, true); assert.equal(decline.disabled, true);
  release(); await work;
  assert.deepEqual(JSON.parse(f.requests.find(request => request.url.endsWith('/approvals')).options.body), { requestId: 'approval', kind: 'command', decision: 'accept' });
  f.show(view); assert.equal(f.find('.approval-accept'), undefined);
});

test('command cancellation uses the native decision and uncertain results cannot be submitted twice', async () => {
  const f = await fixture(url => url.endsWith('/approvals') ? Promise.reject(new TypeError('connection lost')) : undefined);
  const view = { requests: [{ id: 'approval', kind: 'command', command: 'pwd', decisions: ['accept', 'cancel'] }] };
  f.show(view);
  assert.equal(f.find('.approval-accept').textContent, '允许一次');
  const cancel = f.find('.approval-decline');
  assert.equal(cancel.textContent, '拒绝并中断');
  await cancel.listeners.click();
  f.show(view);
  await f.find('.approval-decline').listeners.click();
  const requests = f.requests.filter(request => request.url.endsWith('/approvals'));
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).decision, 'cancel');
  assert.equal(f.find('.approval-decline').disabled, true);
});

for (const kind of ['userInput', 'async']) {
  test(`${kind} questions validate all answers and preserve uncertain submission across rerenders`, async () => {
    const endpoint = kind === 'async' ? '/async-question' : '/user-input';
    const f = await fixture(url => url.endsWith(endpoint) ? Promise.reject(new TypeError('isolated network failure')) : undefined);
    const questions = [{ id: 'question', question: 'Choose a path', options: [] }];
    const view = kind === 'async'
      ? { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'question-item', type: 'agentMessage', text: 'Choose a path', questions }] }] }
      : { requests: [{ id: 'question-item', kind: 'userInput', questions }] };
    f.show(view);
    let form = f.find('.user-input-form');
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.some(request => request.url.endsWith(endpoint)), false);
    assert.ok(descendants(form).some(node => node.textContent === '请回答所有问题'));
    const input = f.find('.user-input-text'); input.value = 'answer'; input.listeners.input();
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.filter(request => request.url.endsWith(endpoint)).length, 1);
    assert.deepEqual(JSON.parse(f.requests.find(request => request.url.endsWith(endpoint)).options.body), { requestId: 'question-item', answers: { question: 'answer' } });
    f.show(view); form = f.find('.user-input-form');
    assert.equal(f.find('.approval-accept').disabled, true);
    assert.ok(descendants(form).some(node => node.textContent === '结果暂不确定，请查看电脑上的任务状态'));
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.filter(request => request.url.endsWith(endpoint)).length, 1);
    f.show({ requests: [], turns: [] }); assert.equal(f.run('questionPanel.hidden'), true);
  });
}

test('recovery uncertainty prevents approval and question actions from dispatching writes', async () => {
  const f = await fixture();
  f.show({ requests: [{ id: 'approval', kind: 'file' }, { id: 'input', kind: 'userInput', questions: [{ id: 'q', question: 'Answer', options: [] }] }] });
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'old'});updateComposer()");
  await f.find('.approval-accept').listeners.click();
  const input = f.find('.user-input-text'); input.value = 'answer'; input.listeners.input();
  await f.find('.user-input-form').listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => request.url.endsWith('/approvals') || request.url.endsWith('/user-input')), false);
});

const acceptanceQuestions = [{ id: 'choice', question: '验收选择', options: ['继续', '停止'] }];
const acceptanceView = text => ({ turns: [{ id: 'turn', status: 'completed', items: [{ id: 'question-item', type: 'agentMessage', text, questions: acceptanceQuestions }] }] });

for (const body of ['验收选择\n\n继续\n停止', '## 验收选择\n\n1. 继续\n2. 停止', '**验收选择**\n\n- **继续**\n- 停止']) {
  test(`pending async form removes its repeated standalone labels: ${JSON.stringify(body)}`, async () => {
    const f = await fixture(); f.show(acceptanceView(body));
    assert.equal(f.find('.markdown'), undefined);
    const form = f.find('.user-input-form');
    for (const label of ['验收选择', '继续', '停止']) assert.equal(descendants(form).filter(node => node.textContent === label).length, 1);
    assert.match(f.find('.user-input-choices').className, /\bcompact\b/);
  });
}

test('pending form keeps meaningful explanation and code while removing only duplicate labels', async () => {
  const f = await fixture();
  f.show(acceptanceView('操作会恢复上次验收进度，请确认手机已联网。\n\n验收选择\n\n- 继续\n- 停止\n\n继续之前，请保存当前输入。\n\n```text\n继续\n\n\n停止\n```'));
  const body = f.find('.markdown').textContent;
  assert.match(body, /操作会恢复上次验收进度，请确认手机已联网。/);
  assert.match(body, /继续之前，请保存当前输入。/);
  assert.match(body, /```text\n继续\n\n\n停止\n```/);
  assert.doesNotMatch(body, /验收选择|^- 继续|^- 停止/m);
});

test('unlinked history keeps its question text; authoritative answered IDs remove the duplicate', async () => {
  const body = '验收选择\n\n1. 继续\n2. 停止', f = await fixture();
  f.show(acceptanceView(body), false);
  assert.equal(f.find('.markdown').textContent, body);
  assert.equal(f.find('.user-input-form'), undefined);
  const answered = acceptanceView(body);
  answered.turns[0].items.push({ id: 'answer', type: 'userMessage', text: '验收选择\n继续' });
  f.show(answered);
  assert.equal(f.find('.markdown').textContent, body);
  answered.turns[0].items[1].questionReplyIds = ['choice'];
  f.show(answered);
  assert.equal(f.find('.markdown'), undefined);
  assert.equal(f.find('.user-input-form'), undefined);
  assert.equal(f.find('.question-reply-question').textContent, '验收选择');
  assert.equal(f.find('.question-reply-answer').textContent, '继续');
  f.show(answered, false);
  assert.equal(f.find('.markdown'), undefined);
  assert.equal(f.find('.question-reply-question').textContent, '验收选择');
  assert.equal(f.find('.question-reply-answer').textContent, '继续');
});

test('answered question deduplication preserves extra explanation and an ordinary model echo', async () => {
  const f = await fixture();
  const view = acceptanceView('执行本次操作不会发布版本。\n\n验收选择\n- 继续\n- 停止');
  view.turns[0].items.push({ id: 'answer', type: 'userMessage', text: '验收选择\n继续', questionReplyIds: ['choice'] }, { id: 'echo', type: 'agentMessage', text: '验收选择\n继续' });
  f.show(view);
  const bodies = [...f.nodes.values()].flatMap(descendants).filter(node => String(node.className || '').split(/\s+/).includes('markdown'));
  assert.deepEqual(bodies.map(node => node.textContent), ['执行本次操作不会发布版本。', '验收选择\n继续']);
  assert.equal(f.find('.question-reply-question').textContent, '验收选择');
  assert.equal(f.find('.question-reply-answer').textContent, '继续');
});

test('unmatched or ambiguous answer IDs never hide history labels', async () => {
  const f = await fixture(), body = '验收选择\n继续\n停止', view = acceptanceView(body);
  view.turns[0].items.push({ id: 'answer', type: 'userMessage', text: '验收选择\n继续', questionReplyIds: ['another-choice'] });
  f.show(view, false);
  assert.equal(f.find('.markdown').textContent, body);
  view.turns[0].items[1].questionReplyIds = ['choice'];
  view.turns[0].items.push({ ...view.turns[0].items[0], id: 'other-question-item' });
  f.show(view, false);
  assert.equal(f.find('.markdown').textContent, body);
});

test('compact choices preserve radio submission and collapse state across rerenders', async () => {
  const f = await fixture(); f.show(acceptanceView('验收选择\n继续\n停止'));
  const form = f.find('.user-input-form'), stop = descendants(form).find(node => node.type === 'radio' && node.value === '停止');
  stop.listeners.change();
  f.find('.question-collapse').listeners.click();
  f.show(acceptanceView('验收选择\n继续\n停止'));
  assert.equal(f.find('.user-input-form').hidden, true);
  f.find('.question-collapse').listeners.click();
  assert.equal(f.find('.user-input-form').hidden, false);
  await f.find('.user-input-form').listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith('/async-question'));
  assert.deepEqual(JSON.parse(request.options.body), { requestId: 'question-item', answers: { choice: '停止' } });
});

test('multiple pending questions deduplicate each label and keep long options in one column', async () => {
  const f = await fixture();
  const questions = [...acceptanceQuestions, { id: 'second', question: '后续安排', options: ['执行完整回归后再进行发布操作', '继续排查尚未解决的性能问题'] }];
  const text = '请逐项确认。\n\n验收选择\n继续\n停止\n\n后续安排\n- 执行完整回归后再进行发布操作\n- 继续排查尚未解决的性能问题';
  const view = acceptanceView(text); view.turns[0].items[0].questions = questions;
  f.show(view);
  assert.equal(f.find('.markdown').textContent, '请逐项确认。');
  const choices = descendants(f.find('.user-input-form')).filter(node => String(node.className).includes('user-input-choices'));
  assert.match(choices[0].className, /\bcompact\b/);
  assert.doesNotMatch(choices[1].className, /\bcompact\b/);
});

const forms = f => descendants(f.run('questionPanel')).filter(node => String(node.className || '').split(/\s+/).includes('user-input-form'));
const inputIn = form => descendants(form).find(node => node.className === 'user-input-text');
const fill = (form, text) => { const input = inputIn(form); input.value = text; input.listeners.input(); };
const choiceItem = suffix => ({ id: `item-${suffix}`, type: 'agentMessage', text: `选择${suffix}\n继续\n停止`, questions: [{ id: `question-${suffix}`, question: `选择${suffix}`, options: ['继续', '停止'] }], pendingQuestionIds: [`question-${suffix}`] });
const multipleView = () => ({ history: { complete: false }, turns: [{ id: 'first-turn', status: 'completed', items: [choiceItem('A')] }, { id: 'second-turn', status: 'completed', items: [choiceItem('B')] }] });

test('authoritative pending IDs expose every independent question across a limited live window', async () => {
  const f = await fixture(), view = multipleView();
  view.turns[1].items.push({ id: 'ordinary', type: 'userMessage', text: '请继续检查，不代表回答此前的问题' }, { id: 'model', type: 'agentMessage', text: '仍保留两个待答问题。' });
  f.show(view);
  assert.equal(forms(f).length, 2);
  fill(forms(f)[0], 'A 的回答'); fill(forms(f)[1], 'B 的回答');
  f.show(view);
  assert.equal(inputIn(forms(f)[0]).value, 'A 的回答');
  assert.equal(inputIn(forms(f)[1]).value, 'B 的回答');
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  await forms(f)[1].listeners.submit({ preventDefault() {} });
  const replies = f.requests.filter(request => request.url.endsWith('/async-question')).map(request => JSON.parse(request.options.body));
  assert.deepEqual(replies, [{ requestId: 'item-A', answers: { 'question-A': 'A 的回答' } }, { requestId: 'item-B', answers: { 'question-B': 'B 的回答' } }]);
});

test('known answered IDs remove only their form and preserve the model result', async () => {
  const f = await fixture(), view = multipleView();
  view.turns[0].items[0].pendingQuestionIds = [];
  view.turns[1].items.push({ id: 'answer', type: 'userMessage', text: '选择A\n继续', questionReplyIds: ['question-A'] }, { id: 'model-result', type: 'agentMessage', text: '选择A\n继续' });
  f.show(view);
  assert.equal(forms(f).length, 1);
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '选择B'));
  assert.equal(f.find('.markdown').textContent, '选择A\n继续');
});

test('unknown limited history retains the recent-question path and never infers answers from text', async () => {
  const f = await fixture(), view = multipleView();
  for (const turn of view.turns) delete turn.items[0].pendingQuestionIds;
  f.show(view);
  assert.equal(forms(f).length, 1);
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '选择B'));
  view.turns[1].items.push({ id: 'ordinary', type: 'userMessage', text: '继续' });
  f.show(view);
  assert.equal(forms(f).length, 0);
  assert.ok([...f.nodes.values()].flatMap(descendants).some(node => node.textContent === '选择A\n继续\n停止'));
});

test('malformed pending metadata or repeated item identities cannot expose writable forms', async () => {
  const f = await fixture(), view = multipleView();
  view.turns[0].items[0].pendingQuestionIds = ['foreign'];
  view.turns[1].items[0].pendingQuestionIds = ['question-B', 'question-B'];
  f.show(view); assert.equal(forms(f).length, 0);
  const duplicate = multipleView(); duplicate.turns[1].items = [structuredClone(duplicate.turns[0].items[0])];
  f.show(duplicate); assert.equal(forms(f).length, 0);
});

test('a partially answered item submits only the remaining IDs while retaining its own draft', async () => {
  const f = await fixture(), item = choiceItem('A');
  item.questions.push({ id: 'question-extra', question: '第二项', options: [] });
  item.pendingQuestionIds.push('question-extra');
  const view = { turns: [{ id: 'turn', status: 'completed', items: [item] }] };
  f.show(view);
  const inputs = descendants(forms(f)[0]).filter(node => node.className === 'user-input-text');
  inputs[0].value = '第一项回答'; inputs[0].listeners.input();
  inputs[1].value = '第二项回答'; inputs[1].listeners.input();
  item.pendingQuestionIds = ['question-extra']; f.show(view);
  assert.equal(inputIn(forms(f)[0]).value, '第二项回答');
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith('/async-question'));
  assert.deepEqual(JSON.parse(request.options.body), { requestId: 'item-A', answers: { 'question-extra': '第二项回答' } });
});

test('one delayed unknown answer serializes its sibling, then unlocks only the sibling', async () => {
  let failFirst;
  const f = await fixture((url, options) => {
    if (!url.endsWith('/async-question')) return;
    if (JSON.parse(options.body).requestId === 'item-A') return new Promise((resolve, reject) => { failFirst = () => reject(new TypeError('offline')); });
    return response();
  });
  const view = multipleView(); f.show(view);
  fill(forms(f)[0], '回答A'); fill(forms(f)[1], '回答B');
  const pending = forms(f)[0].listeners.submit({ preventDefault() {} });
  f.show(view);
  assert.equal(descendants(forms(f)[1]).find(node => node.type === 'submit').disabled, true);
  await forms(f)[1].listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.filter(request => request.url.endsWith('/async-question')).length, 1);
  failFirst(); await pending;
  assert.equal(descendants(forms(f)[0]).find(node => node.type === 'submit').disabled, true);
  assert.equal(descendants(forms(f)[1]).find(node => node.type === 'submit').disabled, false);
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  await forms(f)[1].listeners.submit({ preventDefault() {} });
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '结果暂不确定，请查看电脑上的任务状态'));
  assert.ok(descendants(forms(f)[1]).some(node => node.textContent === '已提交，等待任务更新'));
  assert.equal(inputIn(forms(f)[1]).value, '回答B');
  f.show(view);
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '结果暂不确定，请查看电脑上的任务状态'));
  assert.ok(descendants(forms(f)[1]).some(node => node.textContent === '已提交，等待任务更新'));
  assert.equal(f.requests.filter(request => request.url.endsWith('/async-question')).length, 2);
});

test('a late answer and detached form from the old device cannot alter or submit the new device form', async () => {
  let releaseOld, sent = 0;
  const f = await fixture(url => {
    if (!url.endsWith('/async-question')) return;
    if (++sent === 1) return new Promise(resolve => { releaseOld = () => resolve(response()); });
    return response();
  });
  const view = multipleView(); f.show(view); const oldForm = forms(f)[0]; fill(oldForm, '旧电脑回答');
  const oldRequest = oldForm.listeners.submit({ preventDefault() {} });
  f.run("resetHistoryScope();currentDeviceId='new-device';historyScope={hostId:'host',deviceId:'new-device'};connected=true;recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'})");
  f.show(view);
  assert.equal(inputIn(forms(f)[0]).value, '');
  fill(forms(f)[0], '新电脑回答');
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  releaseOld(); await oldRequest;
  await oldForm.listeners.submit({ preventDefault() {} });
  assert.equal(sent, 2);
  assert.equal(inputIn(forms(f)[0]).value, '新电脑回答');
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '已提交，等待任务更新'));
});

test('pending and response-ID changes are immediate control updates', async () => {
  const f = await fixture(), before = multipleView(), after = structuredClone(before);
  after.turns[0].items[0].pendingQuestionIds = [];
  const signature = value => f.run(`controlSignature(${JSON.stringify(value)})`);
  assert.notEqual(signature(before), signature(after));
  before.turns[1].items.push({ id: 'answer', type: 'userMessage', text: '选择A\n继续' });
  after.turns[1].items.push({ id: 'answer', type: 'userMessage', text: '选择A\n继续', questionReplyIds: ['question-A'] });
  before.turns[0].items[0].pendingQuestionIds = [];
  assert.notEqual(signature(before), signature(after));
  before.turns[1].items[1].questionReplyIds = ['question-A'];
  after.turns[0].items[0].submittingQuestionIds = ['question-A'];
  assert.notEqual(signature(before), signature(after));
  before.turns[0].items[0].submittingQuestionIds = ['question-A'];
  after.turns[1].items[1].questionReplyPendingIds = ['question-B'];
  assert.notEqual(signature(before), signature(after));
});

test('skipping one subquestion never hides a later pending subquestion of the same item', async () => {
  const f = await fixture(), item = choiceItem('A');
  item.questions.push({ id: 'question-B', question: '选择B', options: ['继续', '停止'] });
  const view = { turns: [{ id: 'turn', status: 'completed', items: [item] }] };
  f.show(view); f.find('.question-skip').listeners.click();
  assert.equal(forms(f).length, 0);
  item.pendingQuestionIds = ['question-B']; f.show(view);
  assert.equal(forms(f).length, 1);
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '选择B'));
  fill(forms(f)[0], 'B 的回答');
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith('/async-question'));
  assert.deepEqual(JSON.parse(request.options.body), { requestId: 'item-A', answers: { 'question-B': 'B 的回答' } });
});

test('label words outside a complete question block remain visible as independent explanation', async () => {
  const f = await fixture();
  f.show(acceptanceView('验收选择\n- 继续\n- 停止\n\n下面逐项说明：\n继续\n表示保留当前进度。\n停止\n表示结束本次操作。'));
  const body = f.find('.markdown').textContent;
  assert.equal(body, '下面逐项说明：\n继续\n表示保留当前进度。\n停止\n表示结束本次操作。');
  const ambiguous = '验收选择\n请先查看说明。\n继续\n停止';
  f.show(acceptanceView(ambiguous));
  assert.equal(f.find('.markdown').textContent, ambiguous);
});

test('identified replies use the exact unique question ID despite similar multiline titles', async () => {
  const f = await fixture();
  const long = { ...choiceItem('long'), text: '同名题\n补充说明', questions: [{ id: 'long-id', question: '同名题\n补充说明', options: [] }], pendingQuestionIds: [] };
  const short = { ...choiceItem('short'), text: '同名题', questions: [{ id: 'short-id', question: '同名题', options: [] }], pendingQuestionIds: ['short-id'] };
  const view = { turns: [{ id: 'turn', status: 'completed', items: [long, short, { id: 'answer', type: 'userMessage', text: '同名题\n补充说明\n确认', questionReplyIds: ['long-id'] }] }] };
  f.show(view);
  assert.equal(f.find('.question-reply-question').textContent, '同名题\n补充说明');
  assert.equal(f.find('.question-reply-answer').textContent, '确认');
});

for (const ids of [['unknown-id'], ['choice', 'second-id'], []]) test(`unresolved explicit reply IDs keep the original answer text: ${JSON.stringify(ids)}`, async () => {
  const f = await fixture(), view = acceptanceView('验收选择\n继续\n停止');
  view.turns[0].items.push({ id: 'answer', type: 'userMessage', text: '验收选择\n继续', questionReplyIds: ids });
  f.show(view, false);
  assert.equal(f.find('.question-reply-question'), undefined);
  assert.ok([...f.nodes.values()].flatMap(descendants).some(node => node.className === 'item-text' && node.textContent === '验收选择\n继续'));
});

test('duplicated reply IDs or an identified title mismatch do not guess a question', async () => {
  const f = await fixture(), view = acceptanceView('验收选择\n继续\n停止');
  view.turns[0].items.push({ ...view.turns[0].items[0], id: 'duplicate' }, { id: 'answer', type: 'userMessage', text: '验收选择\n继续', questionReplyIds: ['choice'] });
  f.show(view, false); assert.equal(f.find('.question-reply-question'), undefined);
  view.turns[0].items.splice(1, 1); view.turns[0].items[1].text = '另一个题目\n继续';
  f.show(view, false); assert.equal(f.find('.question-reply-question'), undefined);
});

test('two rapid submissions reach a busy backend sequentially without a rejected second answer', async () => {
  let releaseFirst, busy = false, rejected = 0;
  const f = await fixture((url, options) => {
    if (!url.endsWith('/async-question')) return;
    if (busy) { rejected++; return response({}, 409); }
    if (JSON.parse(options.body).requestId === 'item-A') { busy = true; return new Promise(resolve => { releaseFirst = () => { busy = false; resolve(response()); }; }); }
    return response();
  });
  const view = multipleView(); f.show(view); fill(forms(f)[0], 'A'); fill(forms(f)[1], 'B');
  const first = forms(f)[0].listeners.submit({ preventDefault() {} });
  await forms(f)[1].listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.filter(request => request.url.endsWith('/async-question')).length, 1);
  releaseFirst(); await first;
  assert.equal(descendants(forms(f)[1]).find(node => node.type === 'submit').disabled, false);
  await forms(f)[1].listeners.submit({ preventDefault() {} });
  assert.equal(rejected, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith('/async-question')).length, 2);
});

test('a fresh page preserves remote submitting questions and blocks duplicate submissions and skipping', async () => {
  const f = await fixture(), view = multipleView();
  view.turns[0].items[0].submittingQuestionIds = ['question-A'];
  view.turns[1].items.push({ id: 'unconfirmed', type: 'userMessage', text: '选择A\n继续', questionReplyPendingIds: ['question-A'] });
  f.show(view);
  assert.equal(forms(f).length, 2);
  assert.equal(descendants(forms(f)[0]).find(node => node.type === 'submit').disabled, true);
  assert.equal(descendants(forms(f)[0]).find(node => node.className === 'question-skip').disabled, true);
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '回答结果待确认，请查看电脑上的任务状态'));
  fill(forms(f)[0], '再次回答'); await forms(f)[0].listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => request.url.endsWith('/async-question')), false);
  view.turns[0].items[0].submittingQuestionIds = []; f.show(view);
  assert.equal(descendants(forms(f)[0]).find(node => node.type === 'submit').disabled, false);
  view.turns[0].items[0].pendingQuestionIds = [];
  view.turns[1].items[1] = { id: 'confirmed', type: 'userMessage', text: '选择A\n继续', questionReplyIds: ['question-A'] };
  f.show(view); assert.equal(forms(f).length, 1);
});

test('disconnect blocks other forms; clearing the chat aborts a write without clearing its unknown guard', async () => {
  let release;
  const f = await fixture(url => url.endsWith('/async-question') ? new Promise(resolve => { release = () => resolve(response()); }) : undefined);
  const view = multipleView(); f.show(view); fill(forms(f)[0], 'A'); fill(forms(f)[1], 'B');
  const first = forms(f)[0].listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith('/async-question'));
  f.run('connected=false'); await forms(f)[1].listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.filter(entry => entry.url.endsWith('/async-question')).length, 1);
  f.run('clearConversation();connected=true');
  assert.equal(request.options.signal.aborted, true);
  f.show(view);
  assert.equal(descendants(forms(f)[0]).find(node => node.type === 'submit').disabled, true);
  assert.equal(descendants(forms(f)[1]).find(node => node.type === 'submit').disabled, false);
  release(); await first;
  assert.ok(descendants(forms(f)[0]).some(node => node.textContent === '结果暂不确定，请查看电脑上的任务状态'));
});

for (const kind of ['async', 'request']) test(`${kind} custom answer keeps its attached input, focus and selection through streaming updates and still submits`, async () => {
  const f = await fixture();
  const view = kind === 'async'
    ? { turns: [{ id: 'turn', status: 'inProgress', items: [choiceItem('A')] }] }
    : { requests: [{ id: 'request', kind: 'userInput', questions: [{ id: 'q', question: '回答', isOther: true, options: [{ label: '继续' }] }] }], turns: [{ id: 'turn', status: 'inProgress', items: [] }] };
  f.show(view);
  const form = forms(f)[0], input = inputIn(form);
  fill(form, '输入中中文 custom answer'); input.focus(); input.setSelectionRange(3, 7, 'backward');
  // These are actual renders of streamed state, not a copied reconciliation function.
  for (let n = 0; n < 25; n++) {
    const next = structuredClone(view);
    next.turns[0].items.push({ id: 'tool', type: 'mcpToolCall', server: 'server', tool: 'run', status: 'inProgress', output: `chunk ${n}` }, { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: `stream ${n}` });
    next.requests ||= [];
    next.requests.push({ id: `approval-${n}`, kind: 'command', command: 'echo unrelated' });
    f.show(next);
    assert.equal(inputIn(forms(f)[0]), input);
    assert.equal(input.isConnected, true);
    assert.equal(f.document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [3, 7, 'backward']);
    assert.equal(input.focusCount, 1);
  }
  // Continued input must use the still-current form closure, including IME commit input.
  input.value = '中文输入完成'; input.listeners.input();
  await form.listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith(kind === 'async' ? '/async-question' : '/user-input'));
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body).answers, kind === 'async' ? { 'question-A': '中文输入完成' } : { q: '中文输入完成' });
  f.show(view);
  assert.equal(inputIn(forms(f)[0]), input);
  assert.equal(descendants(form).find(node => node.type === 'submit').disabled, true);
  assert.ok(descendants(form).some(node => node.textContent === '已提交，等待任务更新'));
});

test('retained question controls still react to recovery guards without replacing the editor', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  const form = forms(f)[0], input = inputIn(form); input.focus(); fill(form, '未提交回答');
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown'})");
  f.show(view);
  assert.equal(inputIn(forms(f)[0]), input);
  assert.equal(descendants(form).find(node => node.type === 'submit').disabled, true);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => request.url.endsWith('/async-question')), false);
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'})"); f.show(view);
  assert.equal(descendants(form).find(node => node.type === 'submit').disabled, false);
});

for (const kind of ['async', 'request']) test(`${kind} question schema changes reset the old answer and do not focus the replacement`, async () => {
  const f = await fixture();
  const view = kind === 'async' ? { turns: [{ id: 'turn', status: 'completed', items: [choiceItem('A')] }] }
    : { requests: [{ id: 'request', kind: 'userInput', questions: [{ id: 'q', question: '原来的问题', options: [] }] }] };
  f.show(view); const original = inputIn(forms(f)[0]); fill(forms(f)[0], '不适用于新问题的答案'); original.focus(); original.setSelectionRange(2, 5);
  const next = structuredClone(view);
  const question = kind === 'async' ? next.turns[0].items[0].questions[0] : next.requests[0].questions[0];
  question.question = '相同 ID 的另一个问题'; question.options = [];
  f.show(next); const replacement = inputIn(forms(f)[0]);
  assert.notEqual(replacement, original);
  assert.equal(original.isConnected, false);
  assert.equal(replacement.value, '');
  assert.notEqual(f.document.activeElement, replacement);
  await forms(f)[0].listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => request.url.endsWith(kind === 'async' ? '/async-question' : '/user-input')), false);
});

test('answered or remotely submitting questions update immediately and do not steal input focus', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  const input = inputIn(forms(f)[0]); fill(forms(f)[0], 'custom'); input.focus(); input.setSelectionRange(2, 4, 'backward');
  const remote = structuredClone(view); remote.turns[0].items[0].submittingQuestionIds = ['question-A']; f.show(remote);
  assert.equal(descendants(forms(f)[0]).find(node => node.type === 'submit').disabled, true);
  assert.notEqual(f.document.activeElement, inputIn(forms(f)[0]));
  const answered = structuredClone(remote); answered.turns[0].items[0].pendingQuestionIds = []; f.show(answered);
  assert.equal(forms(f).length, 1);
  assert.equal(inputIn(forms(f)[0]).dataset.inputQuestionId, 'question-B');
  assert.notEqual(f.document.activeElement, inputIn(forms(f)[0]));
});

test('an unrelated question change restores selection direction only in the same question scope', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  fill(forms(f)[0], 'same answer'); const input = inputIn(forms(f)[0]); input.focus(); input.setSelectionRange(2, 6, 'backward');
  const changed = structuredClone(view); changed.turns[1].items[0].questions[0].question = 'B 新问题'; f.show(changed);
  const replacement = inputIn(forms(f)[0]);
  assert.equal(f.document.activeElement, replacement);
  assert.equal(replacement.value, 'same answer');
  assert.deepEqual([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection], [2, 6, 'backward']);
  f.run("resetHistoryScope();currentDeviceId='new-device';historyScope={hostId:'host',deviceId:'new-device'};connected=true"); f.show(changed);
  const otherDevice = inputIn(forms(f)[0]);
  assert.notEqual(f.document.activeElement, otherDevice);
  assert.equal(otherDevice.value, '');
});

test('clearing a conversation invalidates its retained question form', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  const original = inputIn(forms(f)[0]); original.focus();
  f.run('clearConversation()'); assert.equal(forms(f).length, 0);
  f.show(view);
  assert.notEqual(inputIn(forms(f)[0]), original);
  assert.notEqual(f.document.activeElement, inputIn(forms(f)[0]));
});

test('the first live state becoming connected does not replace a just-focused question input', async () => {
  const f = await fixture(), view = multipleView();
  f.run('connected=false'); f.show(view);
  assert.equal(f.run('connected'), true);
  const input = inputIn(forms(f)[0]); fill(forms(f)[0], 'first state input'); input.focus(); input.setSelectionRange(3, 8, 'backward');
  f.show(view);
  assert.equal(inputIn(forms(f)[0]), input);
  assert.equal(input.isConnected, true);
  assert.equal(f.document.activeElement, input);
  assert.equal(input.focusCount, 1);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [3, 8, 'backward']);
});

for (const kind of ['async', 'request']) test(`${kind} question keeps its editor and IME input through reconnect and a history preview, with submission blocked until live confirmation`, async () => {
  let releaseEvents;
  const f = await fixture(url => url.endsWith('/events') ? new Promise(resolve => { releaseEvents = () => resolve(response()); }) : undefined);
  const view = kind === 'async' ? multipleView() : { requests: [{ id: 'request', kind: 'userInput', questions: [{ id: 'q', question: '输入回答', options: [] }] }] };
  f.show(view);
  const oldForm = forms(f)[0], oldInput = inputIn(oldForm); fill(oldForm, '拼音 composing'); oldInput.focus(); oldInput.setSelectionRange(2, 7, 'backward');
  const reconnect = f.run('connect(selectedId,0,true)');
  try {
    assert.equal(f.run('questionPanel.hidden'), false);
    assert.equal(inputIn(forms(f)[0]), oldInput); assert.equal(oldInput.isConnected, true); assert.equal(f.document.activeElement, oldInput);
    assert.equal(descendants(oldForm).find(node => node.type === 'submit').disabled, true);
    await oldForm.listeners.submit({ preventDefault() {} });
    const skip = descendants(oldForm).find(node => node.className === 'question-skip');
    if (skip) { assert.equal(skip.disabled, true); skip.listeners.click(); assert.equal(forms(f)[0], oldForm); }
    // A cached or recorded preview is not authority that the live question was answered.
    f.show({ requests: [], turns: [{ id: 'older-history', status: 'completed', items: [{ id: 'older-user-message', type: 'userMessage', text: '只用于历史显示' }] }], history: { complete: true } }, false);
    assert.equal(f.run('questionPanel.hidden'), false); assert.equal(forms(f)[0], oldForm); assert.equal(f.document.activeElement, oldInput);
    oldInput.value = '中文合成输入完成'; oldInput.listeners.input(); oldInput.setSelectionRange(3, 6, 'backward');
    await oldForm.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.some(request => /\/(?:async-question|user-input)$/.test(request.url)), false);
    f.run("recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'})");
    await oldForm.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.some(request => /\/(?:async-question|user-input)$/.test(request.url)), false, 'readiness alone cannot authorize a history-only question');
    f.show(view);
    assert.equal(inputIn(forms(f)[0]), oldInput); assert.equal(oldInput.value, '中文合成输入完成'); assert.equal(oldInput.focusCount, 1);
    assert.equal(f.document.activeElement, oldInput); assert.deepEqual([oldInput.selectionStart, oldInput.selectionEnd, oldInput.selectionDirection], [3, 6, 'backward']);
    assert.equal(descendants(oldForm).find(node => node.type === 'submit').disabled, false);
    await oldForm.listeners.submit({ preventDefault() {} });
    const request = f.requests.find(entry => entry.url.endsWith(kind === 'async' ? '/async-question' : '/user-input'));
    assert.ok(request); assert.deepEqual(JSON.parse(request.options.body).answers, kind === 'async' ? { 'question-A': '中文合成输入完成' } : { q: '中文合成输入完成' });
  } finally { f.run('active.abort()'); releaseEvents(); await reconnect; }
});

for (const kind of ['async', 'request']) test(`${kind} retained question is removed only by new live authority and detached callbacks cannot submit`, async () => {
  const f = await fixture();
  const view = kind === 'async' ? multipleView() : { requests: [{ id: 'request', kind: 'userInput', questions: [{ id: 'q', question: '输入回答', options: [] }] }] };
  f.show(view); const oldForm = forms(f)[0], oldInput = inputIn(oldForm); fill(oldForm, '未发送'); oldInput.focus();
  f.show({ requests: [], turns: [] }, false);
  assert.equal(forms(f)[0], oldForm);
  f.show({ requests: [], turns: [] });
  assert.equal(forms(f).length, 0); assert.equal(oldInput.isConnected, false);
  await oldForm.listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => /\/(?:async-question|user-input)$/.test(request.url)), false);
});

test('an unchanged retained question still clears immediately when switching tasks or invalidating the device', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  const original = inputIn(forms(f)[0]); fill(forms(f)[0], '原设备草稿'); original.focus();
  f.run('invalidateDeviceState()'); assert.equal(forms(f).length, 0); assert.equal(original.isConnected, false);
  f.run(`selectedId='${threadId}';currentDeviceId='other-device';historyScope={hostId:'host',deviceId:'other-device'};connected=true`);
  f.show(view, false); assert.equal(forms(f).length, 0);
  f.show(view); assert.notEqual(inputIn(forms(f)[0]), original); assert.equal(inputIn(forms(f)[0]).value, '');
  f.run('selectedId=null;clearConversation()'); assert.equal(forms(f).length, 0);
});

test('question retention signatures exclude long message, reasoning and tool bodies', async () => {
  const f = await fixture();
  const makeSignature = length => f.run(`questionPanelSignature({requests:[],turns:[{id:'long',items:[{id:'user',type:'userMessage',text:'x'.repeat(${length})},{id:'tool',type:'commandExecution',output:'y'.repeat(${length})},{id:'reasoning',type:'reasoning',summary:['z'.repeat(${length})]}]}]},[], 'scope')`);
  const short = makeSignature(1), long = makeSignature(500000);
  assert.equal(long, short);
  assert.ok(long.length < 200);
});

const laterTurns = count => Array.from({ length: count }, (_, index) => ({ id: `later-${index}`, status: 'completed', items: [{ id: `later-message-${index}`, type: 'agentMessage', text: `后续回合 ${index}` }] }));
const pendingTurn = () => ({ id: 'old-pending-turn', viewKey: 'old-pending-turn:stable', status: 'completed', items: [choiceItem('old')] });
const lightweightPending = turn => ({ ...turn, items: turn.items.filter(item => item.questions?.length).map(item => ({ id: item.id, type: item.type, text: '', questions: item.questions, pendingQuestionIds: item.pendingQuestionIds, submittingQuestionIds: item.submittingQuestionIds })) });

test('a pending question outside the last three turns remains attached without adding its empty control turn to the timeline', async () => {
  const f = await fixture(), old = pendingTurn();
  f.show({ turns: [old, ...laterTurns(2)], pendingQuestionTurns: [] });
  const form = forms(f)[0], input = inputIn(form); fill(form, '跨窗口的中文输入'); input.focus(); input.setSelectionRange(2, 6, 'backward');
  const windowed = { turns: laterTurns(3), pendingQuestionTurns: [lightweightPending(old)] };
  f.show(windowed);
  assert.equal(forms(f).length, 1); assert.equal(forms(f)[0], form); assert.equal(inputIn(forms(f)[0]), input);
  assert.equal(f.document.activeElement, input); assert.equal(input.isConnected, true); assert.equal(input.value, '跨窗口的中文输入'); assert.equal(input.focusCount, 1);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 6, 'backward']);
  const timeline = descendants(f.nodes.get('#turns'));
  assert.equal(timeline.filter(node => node.className === 'turn').length, 3);
  assert.equal(timeline.filter(node => node.className === 'item assistant-message').length, 3, 'supplemental controls must not create empty assistant bubbles');
  await form.listeners.submit({ preventDefault() {} });
  const sent = f.requests.find(request => request.url.endsWith('/async-question')); assert.ok(sent); assert.equal(JSON.parse(sent.options.body).requestId, 'item-old');
});

test('live pending-control removal clears an old windowed question and a changed schema replaces only the old editor', async () => {
  const f = await fixture(), old = pendingTurn();
  const windowed = { turns: laterTurns(3), pendingQuestionTurns: [lightweightPending(old)] };
  f.show(windowed); const input = inputIn(forms(f)[0]); fill(forms(f)[0], '原答案'); input.focus();
  const changed = structuredClone(windowed); changed.pendingQuestionTurns[0].items[0].questions[0].question = '更新后的旧问题';
  f.show(changed); assert.notEqual(inputIn(forms(f)[0]), input); assert.equal(inputIn(forms(f)[0]).value, '');
  const answered = structuredClone(changed); answered.pendingQuestionTurns[0].items[0].pendingQuestionIds = [];
  f.show(answered); assert.equal(forms(f).length, 0);
  f.show(windowed); assert.equal(forms(f).length, 1);
  f.show({ turns: laterTurns(3), pendingQuestionTurns: [] }); assert.equal(forms(f).length, 0);
});

test('loaded full history remains intact when the same turn supplies lightweight pending controls without duplicate forms', async () => {
  const f = await fixture(), old = pendingTurn();
  old.items.unshift({ id: 'old-large-tool', type: 'commandExecution', command: 'fixture', output: '保留已加载的完整工具输出' });
  old.items[1].text = '原始问题说明\n选择old\n继续\n停止';
  f.run(`recordedHistory={id:selectedId,turns:${JSON.stringify([old])},baseView:{},initialized:true,olderComplete:true,stale:false}`);
  const supplemental = lightweightPending(old);
  f.show({ turns: laterTurns(3), pendingQuestionTurns: [supplemental, supplemental] });
  assert.equal(forms(f).length, 1);
  const timeline = descendants(f.nodes.get('#turns'));
  assert.equal(timeline.filter(node => node.className === 'turn').length, 4);
  assert.ok(timeline.some(node => node.textContent?.includes('保留已加载的完整工具输出')));
  assert.ok(timeline.some(node => node.textContent?.includes('原始问题说明')));
  const inWindow = { turns: [old, ...laterTurns(2)], pendingQuestionTurns: [supplemental] };
  f.show(inWindow); assert.equal(forms(f).length, 1, 'a source turn wins over a duplicate supplemental turn');
});

test('delta metadata changes to pendingQuestionTurns immediately update the old question cards', async () => {
  const f = await fixture(), old = lightweightPending(pendingTurn());
  const initial = { id: threadId, turns: laterTurns(3), requests: [], history: { complete: false }, pendingQuestionTurns: [old] };
  f.run(`handleEvent(${JSON.stringify('event: state\ndata: ' + JSON.stringify({ seq: 1, conversation: initial }))})`);
  assert.equal(forms(f).length, 1);
  const next = { ...initial, pendingQuestionTurns: [] }; delete next.turns;
  const delta = { baseSeq: 1, seq: 2, metadata: next, order: initial.turns.map(turn => turn.id), changed: [] };
  f.run(`handleEvent(${JSON.stringify('event: state-delta\ndata: ' + JSON.stringify(delta))})`);
  assert.equal(forms(f).length, 0); assert.equal(f.run('streamView.pendingQuestionTurns.length'), 0);
});

function canonicalQuestionState(laterCount = 4) {
  const keys = ['old', ...Array.from({ length: laterCount }, (_, index) => `later-${index}`)];
  return { id: threadId, turns: [], threadRuntimeStatus: { type: 'idle' }, turnHistory: { kind: 'canonical', history: {
    isComplete: true, islands: [{ entries: keys.map(value => ({ value })), newerBoundary: { status: 'exhausted' } }],
    entitiesByKey: Object.fromEntries(keys.map((key, index) => [key, { turnId: key, status: 'completed', items: index
      ? [{ id: `message-${key}`, type: 'agentMessage', text: '后续消息' }]
      : [{ id: 'old-question', type: 'agentMessage', text: '问题说明', questions: [{ title: '回答问题', options: ['继续', '停止'] }] }] }])),
  } } };
}

for (const laterCount of [1, 4]) for (const mode of ['incomplete-tail', 'new-island-gap']) test(`${mode} preserves the attached question editor without writes when canonical proof temporarily disappears (${laterCount} later turns)`, async () => {
  const f = await fixture(), state = canonicalQuestionState(laterCount);
  f.show(makeWindow(desktopView(state)));
  const form = forms(f)[0], input = inputIn(form); fill(form, '中文合成输入中'); input.focus(); input.setSelectionRange(1, 5, 'backward');
  const uncertain = structuredClone(state), canonical = uncertain.turnHistory.history;
  if (mode === 'incomplete-tail') canonical.entitiesByKey[`later-${laterCount - 1}`].itemsPagination = { hasLoadedOldest: false };
  else { const entries = canonical.islands[0].entries.splice(1); canonical.islands.push({ entries, newerBoundary: { status: 'exhausted' }, olderBoundary: { status: 'available' } }); canonical.isComplete = false; }
  const unknown = makeWindow(desktopView(uncertain));
  assert.deepEqual(unknown.unknownQuestionItemIds, ['old-question']);
  assert.equal(unknown.pendingQuestionTurns.length, 0);
  f.show(unknown);
  assert.equal(forms(f)[0], form); assert.equal(inputIn(form), input); assert.equal(input.isConnected, true); assert.equal(f.document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 5, 'backward']); assert.equal(input.focusCount, 1);
  const submit = descendants(form).find(node => node.type === 'submit'), skip = descendants(form).find(node => node.className === 'question-skip');
  assert.equal(submit.disabled, true); assert.equal(skip.disabled, true);
  input.value = '中文合成输入完成'; input.listeners.input();
  await form.listeners.submit({ preventDefault() {} }); skip.listeners.click();
  assert.equal(forms(f)[0], form); assert.equal(f.requests.some(request => request.url.endsWith('/async-question')), false);
  // Fresh proof restores the exact editor, including the edit made while uncertain.
  f.show(makeWindow(desktopView(state)));
  assert.equal(forms(f)[0], form); assert.equal(input.value, '中文合成输入完成'); assert.equal(input.focusCount, 1); assert.equal(f.document.activeElement, input); assert.equal(submit.disabled, false);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.filter(request => request.url.endsWith('/async-question')).length, 1);
});

test('unknown question metadata never creates a new old card and only the current scope can retain an existing editor', async () => {
  const f = await fixture(), state = canonicalQuestionState();
  const unknownState = structuredClone(state); unknownState.turnHistory.history.entitiesByKey['later-3'].itemsPagination = { hasLoadedOldest: false };
  const unknown = makeWindow(desktopView(unknownState));
  f.show(unknown); assert.equal(forms(f).length, 0);
  const tailUnknown = canonicalQuestionState(0); tailUnknown.turnHistory.history.entitiesByKey.old.itemsPagination = { hasLoadedOldest: false };
  f.show(makeWindow(desktopView(tailUnknown))); assert.equal(forms(f).length, 0, 'unknown final items cannot use the legacy actionable-tail fallback');
  f.show(makeWindow(desktopView(state))); const old = inputIn(forms(f)[0]); old.focus();
  f.run("resetHistoryScope();currentDeviceId='other-device';historyScope={hostId:'host',deviceId:'other-device'};connected=true");
  f.show(unknown); assert.equal(forms(f).length, 0); assert.equal(old.isConnected, false);
});

test('an unknown focused card stays attached when another question resolves or a new card appears', async () => {
  const f = await fixture(), view = multipleView(); f.show(view);
  const first = forms(f)[0], input = inputIn(first); fill(first, '继续输入'); input.focus(); input.setSelectionRange(1, 3);
  const changed = structuredClone(view); delete changed.turns[0].items[0].pendingQuestionIds;
  changed.unknownQuestionItemIds = ['item-A']; changed.turns[1].items[0].pendingQuestionIds = [];
  changed.turns.push({ id: 'new-turn', status: 'completed', items: [choiceItem('C')] });
  f.show(changed);
  assert.equal(forms(f).length, 2); assert.ok(forms(f).includes(first)); assert.equal(f.document.activeElement, input); assert.equal(input.isConnected, true); assert.equal(input.focusCount, 1);
  assert.equal(descendants(first).find(node => node.type === 'submit').disabled, true);
  const added = forms(f).find(form => form !== first); assert.equal(inputIn(added).dataset.inputQuestionId, 'question-C'); assert.equal(descendants(added).find(node => node.type === 'submit').disabled, false);
  // An explicit accepted reply is conclusive even while later history is incomplete.
  const state = canonicalQuestionState(); f.show(makeWindow(desktopView(state)));
  const form = forms(f)[0], oldInput = inputIn(form); oldInput.focus();
  state.turnHistory.history.entitiesByKey['later-3'].itemsPagination = { hasLoadedOldest: false };
  state.turnHistory.history.entitiesByKey['later-3'].items.push({ type: 'userMessage', id: 'accepted-answer', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'old-question', 0]), question: '回答问题', answer: '继续' }]) + '\n</send_user_message_question_reply>' }] });
  const accepted = makeWindow(desktopView(state)); assert.deepEqual(accepted.unknownQuestionItemIds, []);
  f.show(accepted); assert.equal(forms(f).length, 0); assert.equal(oldInput.isConnected, false);
  await form.listeners.submit({ preventDefault() {} }); assert.equal(f.requests.some(request => request.url.endsWith('/async-question')), false);
});

test('delta metadata alone immediately disables an unknown retained question without removing its editor', async () => {
  const f = await fixture(), old = lightweightPending(pendingTurn());
  const initial = { id: threadId, turns: laterTurns(3), requests: [], history: { complete: false }, pendingQuestionTurns: [old], unknownQuestionItemIds: [] };
  f.run(`handleEvent(${JSON.stringify('event: state\ndata: ' + JSON.stringify({ seq: 1, conversation: initial }))})`);
  const form = forms(f)[0], input = inputIn(form); input.focus(); fill(form, '未完成');
  const metadata = { ...initial, pendingQuestionTurns: [], unknownQuestionItemIds: ['item-old'] }; delete metadata.turns;
  f.run(`handleEvent(${JSON.stringify('event: state-delta\ndata: ' + JSON.stringify({ baseSeq: 1, seq: 2, metadata, order: initial.turns.map(turn => turn.id), changed: [] }))})`);
  assert.equal(forms(f)[0], form); assert.equal(f.document.activeElement, input); assert.equal(descendants(form).find(node => node.type === 'submit').disabled, true);
});

test('an incomplete legacy latest question keeps the same actionable fallback as the backend', async () => {
  const f = await fixture();
  const state = { id: threadId, turns: [{ turnId: 'latest', status: 'completed', items: [
    { id: 'old-legacy-question', type: 'agentMessage', text: 'Earlier question', questions: [{ title: '此前问题', options: ['继续', '停止'] }] },
    { id: 'latest-legacy-question', type: 'agentMessage', text: 'Latest question', questions: [{ title: '最新问题', options: ['继续', '停止'] }] },
  ] }] };
  const view = makeWindow(desktopView(state));
  assert.equal(view.history.complete, false);
  assert.deepEqual(view.unknownQuestionItemIds, ['old-legacy-question']);
  assert.equal(view.turns[0].items[1].pendingQuestionIds, undefined, 'legacy fallback does not invent complete-history proof');
  f.show(view); assert.equal(forms(f).length, 1);
  const form = forms(f)[0]; fill(form, '最新问题的回答');
  assert.equal(descendants(form).find(node => node.type === 'submit').disabled, false);
  await form.listeners.submit({ preventDefault() {} });
  const request = f.requests.find(request => request.url.endsWith('/async-question'));
  assert.equal(JSON.parse(request.options.body).requestId, 'latest-legacy-question');
});

test('an attached request editor survives async cards appearing, resolving or becoming unknown without an ID namespace collision', async () => {
  const f = await fixture(), initial = { ...multipleView(), requests: [{ id: 'item-A', kind: 'userInput', questions: [{ id: 'request-question', question: '请求问题', options: [] }] }] };
  f.show(initial);
  const requestForm = forms(f).find(form => inputIn(form).dataset.inputQuestionId === 'request-question'), input = inputIn(requestForm);
  fill(requestForm, '请求输入法合成中'); input.focus(); input.setSelectionRange(2, 6, 'backward');
  const uncertain = structuredClone(initial); uncertain.unknownQuestionItemIds = ['item-A']; delete uncertain.turns[0].items[0].pendingQuestionIds;
  uncertain.turns[1].items[0].pendingQuestionIds = [];
  uncertain.turns.push({ id: 'new-turn', status: 'completed', items: [choiceItem('C')] });
  for (const next of [uncertain, { ...uncertain, turns: [], unknownQuestionItemIds: [] }, initial]) {
    f.show(next);
    assert.ok(forms(f).includes(requestForm)); assert.equal(inputIn(requestForm), input); assert.equal(input.isConnected, true); assert.equal(f.document.activeElement, input); assert.equal(input.focusCount, 1);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 6, 'backward']);
    assert.equal(descendants(requestForm).find(node => node.type === 'submit').disabled, false, 'async unknown IDs do not disable a request with the same ID');
  }
  input.value = '请求输入完成'; input.listeners.input(); await requestForm.listeners.submit({ preventDefault() {} });
  const request = f.requests.find(entry => entry.url.endsWith('/user-input'));
  assert.deepEqual(JSON.parse(request.options.body), { requestId: 'item-A', answers: { 'request-question': '请求输入完成' } });
});
