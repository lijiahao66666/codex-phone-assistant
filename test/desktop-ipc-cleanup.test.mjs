import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Run without a process-level exception handler: a cleanup regression must
// fail the child exactly as it would terminate the installed helper runtime.
async function isolatedCleanup(action) {
  const { default: assert } = await import('node:assert/strict');
  const { default: net } = await import('node:net');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const { syncBuiltinESMExports } = await import('node:module');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const directory = await mkdtemp(join(os.tmpdir(), 'hub-ipc-cleanup-'));
  const originalHomedir = os.homedir;
  let DesktopIpc, SidebarStatus, trace;
  try {
    os.homedir = () => directory;
    syncBuiltinESMExports();
    ({ DesktopIpc } = await import('./src/desktop/ipc.mjs'));
    ({ SidebarStatus } = await import('./src/desktop/sidebar-status.mjs'));
    ({ trace } = await import('./src/desktop/diagnostics.mjs'));
  } finally {
    os.homedir = originalHomedir;
    syncBuiltinESMExports();
  }
  const frame = value => {
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
  };
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\hub-cleanup-${randomUUID()}` : join(directory, 'ipc.sock');
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4 && input.length >= input.readUInt32LE() + 4) {
        const length = input.readUInt32LE(), msg = JSON.parse(input.subarray(4, length + 4)); input = input.subarray(length + 4);
        if (msg.method === 'initialize' || msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId,
          resultType: 'success', handledByClientId: 'owner', result: msg.method === 'initialize' ? { clientId: 'client' } : {} }));
        else if (msg.method === 'thread-stream-following-changed' && msg.params.following) socket.write(frame({
          type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', hostId: 'local',
            change: { type: 'snapshot', revision: 1, conversationState: { id: 'thread', threadRuntimeStatus: { type: 'idle' } } } },
        }));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const original = net.createConnection;
  let transport, client, status;
  net.createConnection = (...args) => (transport = original(...args));
  try {
    client = new DesktopIpc({ socketPath: path, timeout: 1000 });
    if (action === 'unsubscribe') {
      await client.connect();
      const off = await client.subscribe('thread', () => {});
      transport.destroy(); assert.equal(client.state, 'ready');
      assert.equal(off(), true); assert.equal(off(), false);
      assert.equal(client.subscriptions.size, 0);
    } else {
      status = new SidebarStatus({ createClient: () => client, retryMs: 10000 });
      await status.updateAndWait(['thread'], 1000);
      const deadline = Date.now() + 1000;
      while (!status.entries.get('thread')?.off) {
        if (Date.now() > deadline) throw new Error('subscription not installed');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.equal(status.get('thread'), 'idle');
      transport.destroy(); assert.equal(client.state, 'ready');
      if (action === 'fail') { status.fail('thread', status.entries.get('thread')); assert.equal(status.entries.get('thread').status, 'unavailable'); }
      else { status.clearEntries(); assert.equal(status.entries.size, 0); }
      assert.equal(client.subscriptions.size, 0);
    }
    trace('cleanup-test', 'isolated', { action });
    assert.match(await readFile(join(directory, '.codex-phone', 'bridge.log'), 'utf8'), /cleanup-test isolated/);
    console.log(JSON.stringify({ action, destroyedBeforeClose: true, cleanup: 'PASS' }));
  } finally {
    net.createConnection = original;
    await status?.close(); await client?.close();
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const action of ['unsubscribe', 'fail', 'clearEntries']) {
  test(`destroyed socket cleanup ${action} exits normally before the close event`, () => {
    const source = `await (${isolatedCleanup.toString()})(${JSON.stringify(action)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { action, destroyedBeforeClose: true, cleanup: 'PASS' });
  });
}
