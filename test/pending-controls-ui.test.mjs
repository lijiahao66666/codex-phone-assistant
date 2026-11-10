import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const threadId = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const descendants = node => [node, ...node.children.flatMap(descendants)];
async function fixture(handler) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.attributes = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) if (node && typeof node === 'object') node.parentElement = this; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    get childNodes() { return this.children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    querySelectorAll(selector) { return descendants(this).slice(1).filter(node => selector.split(',').some(part => part.trim().startsWith('.') && String(node.className || '').split(/\s+/).includes(part.trim().slice(1)))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    after() {} before() {}
  }
  const nodes = new Map(), requests = [];
  const store = { read: async () => null, reserve: async () => true, remove: async () => true };
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement: () => new Element(), createDocumentFragment: () => new Element() };
  const context = vm.createContext({ document, store, AbortController, URLSearchParams, TextDecoder, Date, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    fetch: async (url, options = {}) => { requests.push({ url, options }); return await handler?.(url, options) || response({ projects: [], recent: [] }); } });
  let source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  source = source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source); await tick();
  run(`selectedId='${threadId}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=true;loadThreads=async()=>{};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});`);
  return { nodes, requests, run, show(view, live = true) { run(`showState(${JSON.stringify({ id: threadId, runtimeStatus: 'idle', requests: [], turns: [], history: { complete: true }, ...view })},${live})`); }, find(selector) { return [...nodes.values(), run('questionPanel')].flatMap(descendants).find(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); } };
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
