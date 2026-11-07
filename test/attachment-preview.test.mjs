import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPreviewKind, createAttachmentPreview } from '../public/attachment-preview.mjs';

test('file preview selects supported content without treating Office or archives as text', () => {
  for (const [name, type, expected] of [
    ['report.pdf', '', 'pdf'], ['clip.MOV', '', 'video'], ['clip', 'video/mp4', 'video'],
    ['config.json', '', 'text'], ['source.java', '', 'text'], ['document', 'text/plain', 'text'],
    ['book.xlsx', '', null], ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', null], ['archive.zip', '', null],
  ]) assert.equal(attachmentPreviewKind({ name, type }), expected);
});

test('text thumbnail reads a bounded prefix and renders HTML as plain text', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement(tag) { return { tag, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }; } };
  try {
    const text = '<script>window.unwanted=true</script>\n' + 'line\n'.repeat(5000);
    const source = new File([text], 'notes.html', { type: 'text/html' });
    const reads = [];
    const file = { name: source.name, type: source.type, slice(start, end) { reads.push([start, end]); return source.slice(start, end); } };
    const preview = await createAttachmentPreview(file);
    assert.deepEqual(reads, [[0, 8192]]);
    assert.equal(preview.tag, 'pre');
    assert.match(preview.textContent, /^<script>/);
    assert.ok(preview.textContent.split('\n').length <= 16);
    assert.ok(preview.textContent.length <= 1200);
    assert.equal(preview.attributes['aria-label'], 'notes.html 内容预览');
    await assert.rejects(createAttachmentPreview(new File(['abc\0def'], 'binary.txt')), /Binary/);
  } finally { globalThis.document = previous; }
});

test('unsupported and cancelled previews never read the selected file', async () => {
  const neverRead = { slice() { throw new Error('must not read'); }, arrayBuffer() { throw new Error('must not read'); } };
  assert.equal(await createAttachmentPreview({ ...neverRead, name: 'archive.zip', type: '' }), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createAttachmentPreview({ ...neverRead, name: 'notes.txt', type: 'text/plain' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('removing a file while its content is loading cancels its preview', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement() { return { setAttribute() {} }; } };
  let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  const file = { name: 'slow.txt', type: 'text/plain', slice() { started(); return { arrayBuffer: () => new Promise(resolve => { release = resolve; }) }; } };
  const controller = new AbortController();
  try {
    const pending = createAttachmentPreview(file, { signal: controller.signal });
    await reading;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    release?.(new ArrayBuffer(0));
    await new Promise(resolve => setImmediate(resolve));
    globalThis.document = previous;
  }
});
