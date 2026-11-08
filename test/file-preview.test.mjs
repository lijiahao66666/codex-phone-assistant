import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readChangedFile, readLinkedFile, linkedPreviewMatches } from '../src/media/file-preview.mjs';

const safeMediaOpenSource = fileURLToPath(new URL('../macos/safe-media-open.c', import.meta.url));

test('line suffix matching accepts only the referenced path or its numeric line suffix', () => {
  assert.equal(linkedPreviewMatches('/tmp/a.md:12:3', '/tmp/a.md'), true);
  assert.equal(linkedPreviewMatches('/tmp/a.md:12:3', '/tmp/a.md:12:3'), true);
  assert.equal(linkedPreviewMatches('/tmp/a.md:12:3', '/tmp/b.md'), false);
  assert.equal(linkedPreviewMatches('/tmp/a.md:words', '/tmp/a.md'), false);
  assert.equal(linkedPreviewMatches(null, '/tmp/a.md'), false);
});

test('only a live structured change can preview a bounded text file', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'phone-file-test-')));
  const root = join(dir, 'root'), helperPath = join(dir, 'safe-open');
  try {
    await mkdir(root);
    await promisify(execFile)('/usr/bin/cc', ['-std=c11', '-D_DARWIN_C_SOURCE', safeMediaOpenSource, '-o', helperPath]);
    const path = join(root, 'a.txt'), outside = join(dir, 'outside');
    await writeFile(path, 'hello'); await writeFile(outside, 'private');
    const state = { id: 't', turns: [{ turnId: 'turn', items: [{ id: 'item', type: 'fileChange', changes: [{ path }] }] }] };
    const scope = { state, threadId: 't', turnId: 'turn', itemId: 'item', index: 0, helperPath, roots: [root] };
    assert.deepEqual(await readChangedFile(scope), { text: 'hello' });
    assert.equal(await readChangedFile({ ...scope, threadId: 'other' }), null);
    assert.equal(await readChangedFile({ ...scope, index: 1 }), null);
    await writeFile(path, Buffer.from([0, 1]));
    assert.equal(await readChangedFile(scope), null);
    await rm(path); await symlink(outside, path);
    assert.equal(await readChangedFile(scope), null);
    assert.equal(await readFile(outside, 'utf8'), 'private');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('message file links must occur in the authorized message and remain inside an allowed root', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'phone-link-test-')));
  const root = join(dir, 'root'), helperPath = join(dir, 'safe-open');
  try {
    await mkdir(root);
    await promisify(execFile)('/usr/bin/cc', ['-std=c11', '-D_DARWIN_C_SOURCE', safeMediaOpenSource, '-o', helperPath]);
    const path = join(root, 'a space.md'), outside = join(dir, 'outside.md');
    await writeFile(path, 'linked'); await writeFile(outside, 'private');
    const state = { id: 't', turns: [{ turnId: 'turn', items: [{ id: 'item', type: 'agentMessage', text: `[doc](<${path}>)` }] }] };
    const scope = { state, threadId: 't', turnId: 'turn', itemId: 'item', path, helperPath, roots: [root] };
    assert.deepEqual(await readLinkedFile(scope), { text: 'linked' });
    state.turns[0].items[0].text = `[doc](<${path}:12>)`;
    assert.deepEqual(await readLinkedFile({ ...scope, path: `${path}:12` }), { text: 'linked' });
    assert.equal(await readLinkedFile(scope), null);
    state.turns[0].items[0].text = `[doc](<${path}:12:3>)`;
    assert.deepEqual(await readLinkedFile({ ...scope, path: `${path}:12:3` }), { text: 'linked' });
    await writeFile(`${path}:12:3`, 'exact');
    assert.deepEqual(await readLinkedFile({ ...scope, path: `${path}:12:3` }), { text: 'exact' });
    await writeFile(`${path}:12:3`, Buffer.from([0, 1]));
    assert.equal(await readLinkedFile({ ...scope, path: `${path}:12:3` }), null);
    state.turns[0].items[0].text = `[doc](<${path}>)`;
    assert.equal(await readLinkedFile({ ...scope, threadId: 'other' }), null);
    assert.equal(await readLinkedFile({ ...scope, path: outside }), null);
    state.turns[0].items[0].text = `\`[doc](<${path}>)\``;
    assert.equal(await readLinkedFile(scope), null);
    state.turns[0].items[0].text = `[doc](<${path}>)`;
    await rm(path); await symlink(outside, path);
    assert.equal(await readLinkedFile(scope), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
