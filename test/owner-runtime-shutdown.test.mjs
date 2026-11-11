import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createOwnerRuntime } from '../src/desktop/owner-runtime.mjs';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { readProcessStartIdentity } from '../src/desktop/recovery-execution.mjs';

const writerSource = `const readline=require('node:readline');process.on('SIGTERM',()=>{});readline.createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(value.method==='initialize')process.stdout.write(JSON.stringify({id:value.id,result:{}})+'\\n');});`;
const windowsSignalSkip = process.platform === 'win32' && 'Windows terminates the process directly instead of running Node SIGTERM handlers';
const optionsFor = (directory, hostId) => ({ hostId, codexHome: directory, dataDir: directory, projects: async () => [],
  ownerOptions: { binary: process.execPath, args: ['-e', writerSource], cwd: directory, timeout: 5000, socketPath: join(directory, 'isolated.sock') } });

test('explicit force close confirms its busy writer exits and preserves unrelated unknown SQLite writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'force-owner-shutdown-')), host = randomUUID();
  const native = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(native, 'spawn');
  let runtime, journal;
  try {
    runtime = await createOwnerRuntime(optionsFor(directory, host));
    const writer = runtime.owner.client.child, journalBefore = runtime.router.journal;
    runtime.owner.uncertainWrites = true;
    runtime.owner.queuedThreads.add(randomUUID());
    await assert.rejects(runtime.close(), { code: 'tasks-active' });
    assert.equal(writer.exitCode, null); assert.equal(writer.signalCode, null);
    const ownThread = randomUUID(), legacyThread = randomUUID();
    journalBefore.beginRecovery(host, ownThread, randomUUID(), runtime.router.recoveryExecution);
    journalBefore.beginRecovery(host, legacyThread, randomUUID());
    journalBefore.db.prepare("INSERT INTO message_writes VALUES (?,?,?,'dispatching')").run(host, 'message-thread', 'message');
    journalBefore.db.prepare("INSERT INTO model_writes VALUES (?,?,?,?,'unknown')").run(host, 'model-thread', 'device', 'model');
    journalBefore.db.prepare("INSERT INTO raw_request_experiment (instance,request_key,thread,turn,item,method,digest,phase,host_id) VALUES (?,?,?,?,?,?,?,'unknown',?)").run('raw', 'request', 'raw-thread', 'turn', 'item', 'method', 'digest', host);
    const tables = ['message_writes', 'model_writes', 'raw_request_experiment'];
    const before = tables.map(table => journalBefore.db.prepare(`SELECT * FROM ${table}`).all());
    await Promise.all([runtime.close({ force: true }), runtime.close({ force: true })]);
    if (process.platform === 'win32') assert.ok(['SIGTERM', 'SIGKILL'].includes(writer.signalCode), 'the busy writer is actually reaped');
    else assert.equal(writer.signalCode, 'SIGKILL', 'a writer ignoring SIGTERM is actually reaped');
    assert.equal(await readProcessStartIdentity(writer.pid), null);
    assert.notEqual(await readProcessStartIdentity(native.pid), null, 'native Desktop or any other process is never terminated');
    journal = new CreationJournal(join(directory, 'creations.sqlite'));
    assert.equal(journal.recoveryPending(host, ownThread), false, 'only the confirmed exited execution is retired');
    assert.equal(journal.recoveryPending(host, legacyThread), true);
    assert.deepEqual(tables.map(table => journal.db.prepare(`SELECT * FROM ${table}`).all()), before);
    await assert.rejects(runtime.router.route(randomUUID()), { code: 'unavailable' });
  } finally {
    journal?.close();
    if (runtime?.owner.client.child.exitCode === null && runtime.owner.client.child.signalCode === null) await runtime.close({ force: true });
    const exited = once(native, 'exit'); native.kill('SIGTERM'); await exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test('force close does not wait for a stalled route and retains its journal until that operation settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'force-owner-inflight-')), host = randomUUID();
  let release, entered, runtime;
  const started = new Promise(resolve => { entered = resolve; });
  const projects = new Promise(resolve => { release = resolve; });
  try {
    runtime = await createOwnerRuntime({ ...optionsFor(directory, host), projects: async () => { entered(); return projects; } });
    const preparing = runtime.router.prepare({ projectId: 'project', deviceId: 'device', requestId: 'request', digest: 'a'.repeat(64) });
    const rejected = assert.rejects(preparing, { code: 'unavailable' });
    await started;
    await assert.rejects(runtime.close(), { code: 'tasks-active' });
    await runtime.close({ force: true });
    assert.equal(runtime.router.inFlight, 1, 'an unrelated awaited adapter cannot prevent explicit exit');
    assert.equal(runtime.router.journal.recoveryPending(host, 'thread'), false, 'in-flight handlers still have an open database');
    release([{ id: 'project', cwd: directory }]);
    await rejected;
    await runtime.router.whenIdle();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => runtime.router.journal.recoveryPending(host, 'thread'), /not open|closed/i);
  } finally {
    release?.([]);
    if (runtime?.owner.client.child.exitCode === null && runtime.owner.client.child.signalCode === null) await runtime.close({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real helper signal handler exits despite busy state and reaps its app-server', { skip: windowsSignalSkip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-signal-exit-')), host = randomUUID();
  const runtimeSource = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const shutdownSource = runtimeSource.slice(runtimeSource.indexOf('async function stop()'));
  const bootstrap = `
    import { createOwnerRuntime } from ${JSON.stringify(new URL('../src/desktop/owner-runtime.mjs', import.meta.url).href)};
    const ownerRuntime = await createOwnerRuntime(${JSON.stringify(optionsFor(directory, host), (_key, value) => typeof value === 'function' ? undefined : value)});
    ownerRuntime.owner.uncertainWrites = true;
    ownerRuntime.owner.queuedThreads.add('busy-thread');
    ownerRuntime.router.journal.beginRecovery(${JSON.stringify(host)},'owned-thread','owned-attempt',ownerRuntime.router.recoveryExecution);
    ownerRuntime.router.journal.db.prepare("INSERT INTO model_writes VALUES (?,?,?,?,'unknown')").run(${JSON.stringify(host)},'model-thread','device','model');
    let stopping=false,stopChecking=false,startPromise,stopPromise;
    const panel={async close(){}},connector={beginShutdown(){throw new Error('must not ask task guard')},async close(){}};
    ${shutdownSource}
    console.log(JSON.stringify({writer:ownerRuntime.owner.client.child.pid}));
  `;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', writerPid, journal;
  helper.stderr.on('data', chunk => { stderr += chunk; });
  helper.stdout.on('data', chunk => { stdout += chunk; });
  const lines = createInterface({ input: helper.stdout });
  try {
    const ready = await Promise.race([once(lines, 'line'), once(helper, 'exit').then(() => { throw new Error(stderr || 'helper exited before readiness'); })]);
    writerPid = JSON.parse(ready[0]).writer;
    const exited = once(helper, 'exit'); helper.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.equal(stdout.includes('STOP_BLOCKED'), false);
    assert.equal(await readProcessStartIdentity(writerPid), null);
    journal = new CreationJournal(join(directory, 'creations.sqlite'));
    assert.equal(journal.recoveryPending(host, 'owned-thread'), false);
    assert.equal(journal.threadWritePending(host, 'model-thread'), true);
  } finally {
    lines.close(); journal?.close();
    if (helper.exitCode === null && helper.signalCode === null) { const exited = once(helper, 'exit'); helper.kill('SIGKILL'); await exited; }
    if (writerPid && await readProcessStartIdentity(writerPid)) process.kill(writerPid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('the helper exit deadline kills its exact child when enrollment startup is stuck initializing', { timeout: 10000, skip: windowsSignalSkip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-startup-exit-')), host = randomUUID();
  const marker = join(directory, 'writer.pid');
  const runtimeSource = await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const shutdownSource = runtimeSource.slice(runtimeSource.indexOf('async function stop()'));
  const stalledWriter = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const options = optionsFor(directory, host);
  options.ownerOptions.args = ['-e', stalledWriter]; options.ownerOptions.timeout = 20000;
  const bootstrap = `
    import { createOwnerRuntime } from ${JSON.stringify(new URL('../src/desktop/owner-runtime.mjs', import.meta.url).href)};
    let ownerRuntime,stopping=false,stopChecking=false,stopPromise;
    const startPromise=createOwnerRuntime(${JSON.stringify(options, (_key, value) => typeof value === 'function' ? undefined : value)}).then(value=>{ownerRuntime=value;});
    const panel={async close(){}},connector=undefined;
    ${shutdownSource}
    console.log('starting');
  `;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { stdio: ['ignore', 'pipe', 'pipe'] });
  let writerPid, stderr = '';
  helper.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 2500;
    while (!writerPid && Date.now() < deadline) {
      writerPid = Number(await readFile(marker, 'utf8').catch(() => '')) || undefined;
      if (!writerPid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(writerPid, stderr);
    const exited = once(helper, 'exit'); helper.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    const reapedDeadline = Date.now() + 500;
    while (await readProcessStartIdentity(writerPid) && Date.now() < reapedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await readProcessStartIdentity(writerPid), null, 'even a TERM-ignoring child spawned before initialize completes cannot outlive helper exit');
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) { const exited = once(helper, 'exit'); helper.kill('SIGKILL'); await exited; }
    if (writerPid && await readProcessStartIdentity(writerPid)) process.kill(writerPid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
