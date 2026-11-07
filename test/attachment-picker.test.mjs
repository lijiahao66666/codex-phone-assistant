import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup({ modeResponse } = {}) {
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.files = []; this.classList = { toggle() {}, contains() { return false; } }; this.clicks = 0; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(name, value) { this[name] = value; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    replaceWith(node) { this.parent.children.splice(this.parent.children.indexOf(this), 1, node); node.parent = this.parent; }
    querySelectorAll() { return []; }
    click() { this.clicks++; this.listeners.click?.(); }
    after() {}
    get childNodes() { return this.children; }
  }
  const nodes = new Map(), revoked = [], requests = [];
  const document = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); }, createElement(tag) { return new Element(tag); }, createDocumentFragment() { return new Element(); }, addEventListener() {} };
  const context = vm.createContext({ document, fetch: async url => { requests.push(url); if (url.endsWith('/mode') && modeResponse) return modeResponse; return { ok: true, json: async () => ({ projects: [], recent: [] }) }; }, AbortController, TextDecoder, URL: { createObjectURL: file => `blob:${file.name}`, revokeObjectURL: url => revoked.push(url) }, setTimeout() { return 1; }, clearTimeout() {}, sessionStorage: { removeItem() {} }, window: { addEventListener() {} } });
  vm.runInContext(await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8'), context);
  nodes.get('#attachment-menu').hidden = true;
  vm.runInContext("selectedId='11111111-1111-1111-1111-111111111111'; connected=true; imageUploadAvailable=true; currentDeviceId='device'; recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'}); recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'}); updateComposer()", context);
  return { context, nodes, revoked, requests };
}

test('plus opens the menu and attachment action opens the system picker without submitting', async () => {
  const { context, nodes, requests } = await setup();
  nodes.get('#attachment-toggle').click();
  assert.equal(nodes.get('#attachment-file').clicks, 0);
  assert.equal(nodes.get('#attachment-menu').hidden, false);
  assert.equal(nodes.get('#image-choose').hidden, true);
  nodes.get('#file-choose').click();
  assert.equal(nodes.get('#attachment-file').clicks, 1);
  assert.equal(nodes.get('#attachment-menu').hidden, true);
  assert.ok(requests.every(url => !/uploads|messages/.test(url)));
  vm.runInContext('imageUploadAvailable=false; updateComposer()', context);
  nodes.get('#attachment-toggle').click();
  assert.equal(nodes.get('#attachment-file').clicks, 1);
});

test('plan mode remains accessible through the plus menu when attachments are unavailable', async () => {
  const { context, nodes } = await setup();
  vm.runInContext("imageUploadAvailable=false; liveMode='default'; liveRuntimeStatus='idle'; updateComposer()", context);
  assert.equal(nodes.get('#attachment-control').hidden, false);
  assert.equal(nodes.get('#attachment-toggle').disabled, false);
  nodes.get('#attachment-toggle').click();
  assert.equal(nodes.get('#attachment-menu').hidden, false);
  assert.equal(nodes.get('#file-choose').hidden, true);
  assert.equal(nodes.get('#mode-choose').hidden, false);
  assert.equal(nodes.get('#mode-choose').disabled, false);
  assert.equal(nodes.get('#attachment-file').clicks, 0);
});

test('selecting plan mode keeps the menu open through pending and confirmed states', async () => {
  let confirm;
  const modeResponse = new Promise(resolve => { confirm = resolve; });
  const { context, nodes, requests } = await setup({ modeResponse });
  vm.runInContext("liveMode='default'; liveRuntimeStatus='idle'; updateComposer()", context);
  nodes.get('#attachment-toggle').click();
  const pending = nodes.get('#mode-choose').listeners.click();
  assert.equal(nodes.get('#attachment-menu').hidden, false);
  assert.equal(nodes.get('#mode-choose').textContent, '正在切换模式');
  assert.equal(nodes.get('#mode-choose').disabled, true);
  confirm({ ok: true }); await pending;
  assert.equal(nodes.get('#attachment-menu').hidden, false);
  vm.runInContext("liveMode='plan'; modeChanges.delete(selectedId); updateComposer()", context);
  assert.equal(nodes.get('#mode-choose').textContent, '计划模式 ✓');
  assert.equal(nodes.get('#attachment-menu').hidden, false);
  assert.equal(requests.filter(url => url.endsWith('/mode')).length, 1);
  nodes.get('#attachment-toggle').click();
  assert.equal(nodes.get('#attachment-menu').hidden, true);
});

test('mixed attachments keep image upload semantics and thumbnails, with removable file cards', async () => {
  const { context, nodes, revoked } = await setup();
  const input = nodes.get('#attachment-file');
  input.files = [{ name: 'camera.jpg', type: 'image/jpeg', size: 12000 }, { name: 'notes.pdf', type: 'application/pdf', size: 24576 }, { name: 'from-files.png', type: '', size: 64 }];
  input.listeners.change();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(imageDrafts.get(selectedId).map(draft => draft.kind))', context)), ['image', 'file', 'image']);
  const cards = nodes.get('#image-draft').children;
  assert.equal(cards[0].children[0].tagName, 'IMG');
  assert.equal(cards[0].children[0].src, 'blob:camera.jpg');
  assert.equal(cards[2].children[0].tagName, 'IMG');
  const fileCard = cards[1].children[0];
  assert.equal(fileCard.className, 'attachment-card');
  assert.deepEqual(fileCard.children.map(node => node.textContent), ['PDF', 'notes.pdf', '24 KB']);
  cards[0].children[1].click();
  assert.deepEqual(revoked, ['blob:camera.jpg']);
  assert.equal(nodes.get('#image-draft').children.length, 2);
  vm.runInContext("selectedId='22222222-2222-2222-2222-222222222222'; renderImageDraft()", context);
  assert.equal(nodes.get('#image-draft').hidden, true);
  vm.runInContext("selectedId='11111111-1111-1111-1111-111111111111'; renderImageDraft(); clearImageDrafts()", context);
  assert.deepEqual(revoked, ['blob:camera.jpg', 'blob:from-files.png']);
});

test('unrenderable image preview falls back to a named file card', async () => {
  const { nodes } = await setup();
  const input = nodes.get('#attachment-file');
  input.files = [{ name: 'photo.jpg', type: 'image/jpeg', size: 1024 }];
  input.listeners.change();
  const holder = nodes.get('#image-draft').children[0];
  holder.children[0].listeners.error();
  assert.equal(holder.children[0].className, 'attachment-card');
  assert.equal(holder.children[0].children[1].textContent, 'photo.jpg');
  assert.equal(holder.children[1].className, 'image-draft-remove');
});

test('videos above 10 MB are rejected before creating a draft or starting any upload', async () => {
  const { context, nodes, requests } = await setup();
  const input = nodes.get('#attachment-file');
  for (const file of [{ name: 'recording.MOV', type: '', size: 10 * 1024 * 1024 + 1 }, { name: 'clip', type: 'video/mp4', size: 10 * 1024 * 1024 + 1 }]) {
    input.files = [file]; input.listeners.change();
    assert.equal(vm.runInContext('imageDrafts.has(selectedId)', context), false);
    assert.equal(nodes.get('#send-status').textContent, '视频不能超过 10 MB');
  }
  assert.ok(requests.every(url => !/uploads|messages/.test(url)));
});

test('a video at the 10 MB limit can be selected without uploading automatically', async () => {
  const { context, nodes, requests } = await setup();
  const input = nodes.get('#attachment-file');
  input.files = [{ name: 'clip.mp4', type: 'video/mp4', size: 10 * 1024 * 1024 }];
  input.listeners.change();
  assert.equal(vm.runInContext('imageDrafts.get(selectedId)[0].file.size', context), 10 * 1024 * 1024);
  assert.equal(vm.runInContext('imageDrafts.get(selectedId)[0].kind', context), 'file');
  assert.ok(requests.every(url => !/uploads|messages/.test(url)));
});

test('new chat uses the same mixed attachment picker and removable thumbnails before a thread exists', async () => {
  const { context, nodes, revoked, requests } = await setup();
  vm.runInContext("selectedId=null; newDraft={projectId:'project',attachments:[],pending:false,uncertain:false}; updateComposer()", context);
  nodes.get('#attachment-toggle').click();
  assert.equal(nodes.get('#attachment-file').clicks, 0);
  nodes.get('#file-choose').click();
  assert.equal(nodes.get('#attachment-file').clicks, 1);
  const input = nodes.get('#attachment-file');
  input.files = [{ name: 'photo.png', type: 'image/png', size: 200 }, { name: 'notes.txt', type: 'text/plain', size: 32 }];
  input.listeners.change();
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(newDraft.attachments.map(entry=>entry.kind))',context)), ['image','file']);
  assert.equal(nodes.get('#image-draft').children[0].children[0].tagName,'IMG');
  nodes.get('#image-draft').children[0].children[1].click();
  assert.equal(vm.runInContext('newDraft.attachments.length',context),1);
  assert.deepEqual(revoked,['blob:photo.png']);
  assert.ok(requests.every(url=>!/uploads|messages|chats/.test(url)));
});
