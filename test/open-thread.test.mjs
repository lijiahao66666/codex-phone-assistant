import test from 'node:test';
import assert from 'node:assert/strict';
import { openDesktopThread } from '../src/desktop/open-thread.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const uri = `codex://threads/${id}`;

test('native Desktop routes use explicit executables and shell-free arguments', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const calls = [];
    assert.equal(await openDesktopThread(id, { platform,
      execute: async (...args) => { calls.push(args); } }), uri);
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 15_000);
    if (platform === 'darwin') {
      assert.equal(command, 'open'); assert.deepEqual(args, ['-g', uri]);
    } else if (platform === 'win32') {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), `Start-Process -FilePath '${uri}'`);
    } else {
      assert.equal(command, 'xdg-open'); assert.deepEqual(args, [uri]);
    }
  }
});

test('untrusted thread IDs never reach a process or URI handler', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const value of [null, '', `${id}/other`, `${id}?prompt=hello`, `'; touch /tmp/injected; '`, `${id}\n`]) {
      await assert.rejects(openDesktopThread(value, { platform,
        execute: async () => { assert.fail('Invalid input launched a process'); } }), TypeError);
    }
  }
});

test('handler failures are propagated instead of reporting an ownership handoff', async () => {
  const failure = new Error('No application handles codex:');
  await assert.rejects(openDesktopThread(id, { platform: 'darwin',
    execute: async () => { throw failure; } }), error => error === failure);
  await assert.rejects(openDesktopThread(id, { platform: 'unsupported',
    execute: async () => { assert.fail('Unsupported platform launched a process'); } }), /unsupported/);
});
