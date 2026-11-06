import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { absolutePath, insidePath, pathKey, sameOrInside } from '../src/common/path-utils.mjs';

test('Windows project paths preserve drive and UNC boundaries', () => {
  assert.equal(absolutePath('C:\\Users\\name\\project', win32), true);
  assert.equal(absolutePath('C:project', win32), false);
  assert.equal(absolutePath('\\project', win32), false);
  assert.equal(pathKey('C:\\Users\\Name\\Project\\', win32), 'c:\\users\\name\\project');
  assert.equal(sameOrInside('C:\\Users\\Name\\Project', 'c:\\users\\name\\project\\src', win32), true);
  assert.equal(sameOrInside('C:\\project', 'C:\\project-other', win32), false);
  assert.equal(sameOrInside('C:\\project', 'D:\\project\\src', win32), false);
  assert.equal(sameOrInside('\\\\server\\share\\project', '\\\\server\\share\\project\\src', win32), true);
});

test('history containment rejects siblings and traversal on both platforms', () => {
  for (const [api, root, child, sibling, escape] of [
    [posix, '/users/a/sessions', '/users/a/sessions/x.jsonl', '/users/a/sessions-old/x.jsonl', '/users/a/secret.jsonl'],
    [win32, 'C:\\Users\\a\\sessions', 'C:\\Users\\a\\sessions\\x.jsonl', 'C:\\Users\\a\\sessions-old\\x.jsonl', 'C:\\Users\\a\\secret.jsonl'],
  ]) {
    assert.equal(insidePath(root, child, api), true);
    assert.equal(insidePath(root, sibling, api), false);
    assert.equal(insidePath(root, escape, api), false);
    assert.equal(insidePath(root, root, api), false);
  }
});
