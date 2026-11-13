import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const device = '22222222-2222-4222-8222-222222222222';

for (const outcome of ['accepted', 'unknown']) {
  test(`a ${outcome} dispatch remains guarded across a lower revision until it advances`, async () => {
    const thread = randomUUID();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    let session, calls = 0; const traces = [];
    const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), allowInsecureForTests: true, traceForTests: (scope, event, detail) => traces.push({scope, event, detail}),
      createSession() {
        session = new EventEmitter(); session.status = 'ready'; session.revision = 100;
        session.conversation = { ownerId: 'desktop-owner' }; session.value = { id: thread, turns: [] };
        session.start = () => session.emit('state', { status: 'ready', value: session.value, revision: session.revision });
        session.close = async () => {};
        session.sendText = async () => { calls++; if (calls === 1 && outcome === 'unknown') throw new Error('indeterminate'); };
        return session;
      } });
    const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
    const pending = new Map(); peer.on('message', raw => { const msg = JSON.parse(raw); pending.get(msg.id)?.(msg); });
    const request = msg => new Promise(resolve => { pending.set(msg.id, resolve); peer.send(JSON.stringify(msg)); });
    const write = id => request({ type: 'write', id, deviceId: device, conversationId: thread, text: 'redacted fixture' });
    try {
      await request({ type: 'request', id: 'stream', deviceId: device, path: `/api/threads/${thread}/events` });
      assert.equal((await write('first')).status, outcome);
      session.revision = 3;
      assert.equal((await write('lower')).status, 'unavailable');
      session.revision = 100;
      assert.equal((await write('equal')).status, 'unavailable');
      assert.equal(calls, 1);
      session.revision = 101;
      assert.equal((await write('advanced')).status, 'accepted');
      assert.equal(calls, 2);
      const events = traces.filter(x => x.scope === 'write' && ['revision-guard-detail', 'outcome'].includes(x.event) && x.detail.thread === thread).map(x => x.detail);
      assert.deepEqual(events.map(({ previousRevision, currentRevision, priorOutcome, revision, outcome }) => ({ previousRevision, currentRevision, priorOutcome, revision, outcome })), [
        { previousRevision: undefined, currentRevision: undefined, priorOutcome: undefined, revision: 100, outcome },
        { previousRevision: 100, currentRevision: 3, priorOutcome: outcome, revision: undefined, outcome: undefined },
        { previousRevision: 100, currentRevision: 100, priorOutcome: outcome, revision: undefined, outcome: undefined },
        { previousRevision: undefined, currentRevision: undefined, priorOutcome: undefined, revision: 101, outcome: 'accepted' },
      ]);
      assert.ok(!JSON.stringify(events).includes('redacted fixture'));
    } finally { await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); }
  });
}

test('question diagnostics distinguish accepted, rejected and unknown without answer data', async () => {
  const testThread = randomUUID(); const traces = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), allowInsecureForTests: true, traceForTests: (scope, event, detail) => traces.push({scope, event, detail}),
    createSession() {
      const s = new EventEmitter(); s.status = 'ready'; s.revision = 1;
      s.conversation = { ownerId: 'owner' }; s.value = { id: testThread, turns: [] };
      s.start = () => s.emit('state', { status: 'ready', value: s.value, revision: 1 }); s.close = async () => {};
      s.replyUserInput = async id => { if (id === 'sensitive-rejected') throw Object.assign(new Error('secret error details'), { code: 'unavailable' }); if (id === 'sensitive-unknown') throw new Error('secret error details'); };
      return s;
    } });
  const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
  const pending = new Map(); peer.on('message', raw => { const msg = JSON.parse(raw); pending.get(msg.id)?.(msg); });
  const request = msg => new Promise(resolve => { pending.set(msg.id, resolve); peer.send(JSON.stringify(msg)); });
  try {
    await request({ type: 'request', id: 'stream', deviceId: device, path: `/api/threads/${testThread}/events` });
    for (const [id, status] of [['sensitive-accepted','accepted'], ['sensitive-rejected','unavailable'], ['sensitive-unknown','unknown']]) {
      const response = await request({ type:'user-input', id, deviceId:device, conversationId:testThread, requestId:id, answers:{ private:'secret answer' } });
      assert.equal(response.status, status);
    }
    const events = traces.filter(x => x.scope === 'user-input' && x.event === 'outcome' && x.detail.thread === testThread).map(x => x.detail);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(({kind,outcome,reason}) => ({kind,outcome,reason})), [
      {kind:'native', outcome:'accepted', reason:'completed'}, {kind:'native', outcome:'unavailable', reason:'session-rejected'}, {kind:'native', outcome:'unknown', reason:'dispatch-unknown'},
    ]);
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['kind','outcome','reason','thread']);
    assert.ok(!/secret|sensitive/.test(JSON.stringify(events)));
  } finally { await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); }
});

for (const outcome of ['accepted', 'unknown']) {
  test(`a concurrent write stays blocked while prior ${outcome} result is unresolved`, async () => {
    const testThread = randomUUID(), traces = [];
    const server = new WebSocketServer({ host:'127.0.0.1', port:0 }); await once(server, 'listening');
    let started, release, calls = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const connector = createPreviewConnector({ url:`ws://127.0.0.1:${server.address().port}/connector`, secret:'x'.repeat(32), allowInsecureForTests:true, traceForTests:(scope,event,detail)=>traces.push({scope,event,detail}),
      createSession() { const s = new EventEmitter(); s.status='ready'; s.revision=1; s.conversation={ownerId:'owner'}; s.value={id:testThread,turns:[]}; s.start=()=>s.emit('state',{status:'ready',value:s.value,revision:1}); s.close=async()=>{}; s.sendText=async()=>{ calls++; started(); await gate; if (outcome==='unknown') throw new Error('unknown'); }; return s; } });
    const connected=once(server,'connection'); connector.start(); const [peer]=await connected;
    const pending=new Map(); peer.on('message',raw=>{const msg=JSON.parse(raw);pending.get(msg.id)?.(msg);});
    const request=msg=>new Promise(resolve=>{pending.set(msg.id,resolve);peer.send(JSON.stringify(msg));});
    const write=id=>request({type:'write',id,deviceId:device,conversationId:testThread,text:'fixture'});
    try {
      await request({type:'request',id:'stream',deviceId:device,path:`/api/threads/${testThread}/events`});
      const first=write('first'); await entered;
      assert.equal((await write('concurrent')).status,'unavailable');
      release(); assert.equal((await first).status,outcome);
      assert.equal((await write('retry')).status,'unavailable'); assert.equal(calls,1);
      assert.ok(traces.some(x=>x.scope==='write' && x.event==='rejected' && x.detail.reason==='write-pending'));
      assert.ok(traces.some(x=>x.scope==='write' && x.event==='revision-guard-detail' && x.detail.priorOutcome===outcome));
    } finally { release(); await connector.close(); peer.terminate(); await new Promise(resolve=>server.close(resolve)); }
  });
}

test('trace override cannot be enabled in production', () => {
  assert.throws(() => createPreviewConnector({url:'wss://example.test/connector',secret:'x'.repeat(32),traceForTests(){}}), /Test overrides are unavailable/);
});

for (const outcome of ['accepted', 'unknown']) {
  test(`only a confirmed accepted prior operation can retire a stale guard (${outcome})`, async () => {
    const testThread=randomUUID(), traces=[]; let session, operationId, calls=0;
    const server=new WebSocketServer({host:'127.0.0.1',port:0}); await once(server,'listening');
    const connector=createPreviewConnector({url:`ws://127.0.0.1:${server.address().port}/connector`,secret:'x'.repeat(32),allowInsecureForTests:true,traceForTests:(scope,event,detail)=>traces.push({scope,event,detail}),
      createSession(){session=new EventEmitter();session.status='ready';session.revision=100;session.conversation={ownerId:'owner'};session.value={id:testThread,turns:[]};session.start=()=>session.emit('state',{status:'ready',value:session.value,revision:100});session.close=async()=>{};session.sendText=async(_text,options)=>{calls++;if(calls===1){operationId=options.clientUserMessageId;if(outcome==='unknown')throw new Error('unknown');}};return session;}});
    const connected=once(server,'connection');connector.start();const [peer]=await connected;
    const pending=new Map();peer.on('message',raw=>{const msg=JSON.parse(raw);pending.get(msg.id)?.(msg);});
    const request=msg=>new Promise(resolve=>{pending.set(msg.id,resolve);peer.send(JSON.stringify(msg));});
    const write=id=>request({type:'write',id,deviceId:device,conversationId:testThread,text:'fixture'});
    try {
      await request({type:'request',id:'stream',deviceId:device,path:`/api/threads/${testThread}/events`});
      assert.equal((await write('first')).status,outcome);session.revision=3;
      session.value={id:testThread,turns:[{turnId:'turn',params:{clientUserMessageId:operationId},items:[]}]};
      assert.equal((await write('optimistic')).status,'unavailable');
      session.value.turns[0].items.push({type:'userMessage',id:'confirmed',clientId:operationId});
      assert.equal((await write('confirmed')).status,outcome==='accepted'?'accepted':'unavailable');
      assert.equal(calls,outcome==='accepted'?2:1);
    } finally {await connector.close();peer.terminate();await new Promise(resolve=>server.close(resolve));}
  });
}

for (const outcome of ['accepted', 'unknown']) {
  test(`only an acknowledged matching steer retires a stale guard (${outcome})`, async () => {
    const testThread=randomUUID();let session,operationId,calls=0;
    const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
    const connector=createPreviewConnector({url:`ws://127.0.0.1:${server.address().port}/connector`,secret:'x'.repeat(32),allowInsecureForTests:true,traceForTests(){},
      createSession(){session=new EventEmitter();session.status='ready';session.revision=100;session.conversation={ownerId:'owner'};session.value={id:testThread,turns:[]};session.start=()=>session.emit('state',{status:'ready',value:session.value,revision:100});session.close=async()=>{};session.sendText=async(_text,options)=>{calls++;if(calls===1){operationId=options.clientUserMessageId;if(outcome==='unknown')throw new Error('unknown');}};return session;}});
    const connected=once(server,'connection');connector.start();const [peer]=await connected;const pending=new Map();peer.on('message',raw=>{const msg=JSON.parse(raw);pending.get(msg.id)?.(msg);});
    const request=msg=>new Promise(resolve=>{pending.set(msg.id,resolve);peer.send(JSON.stringify(msg));});const write=id=>request({type:'write',id,deviceId:device,conversationId:testThread,text:'fixture'});
    try {
      await request({type:'request',id:'stream',deviceId:device,path:`/api/threads/${testThread}/events`});assert.equal((await write('first')).status,outcome);session.revision=3;
      const steer={type:'steeringUserMessage',status:'pending',clientUserMessageId:operationId,serverUserMessageId:'server'};session.value={id:testThread,turns:[{turnId:'turn',items:[steer]}]};
      assert.equal((await write('pending')).status,'unavailable');steer.status='accepted';steer.clientUserMessageId='wrong';assert.equal((await write('wrong')).status,'unavailable');
      steer.clientUserMessageId=operationId;session.value.turns[0].items.push({...steer});assert.equal((await write('duplicate')).status,'unavailable');session.value.turns[0].items.pop();
      assert.equal((await write('acknowledged')).status,outcome==='accepted'?'accepted':'unavailable');assert.equal(calls,outcome==='accepted'?2:1);
    } finally {await connector.close();peer.terminate();await new Promise(resolve=>server.close(resolve));}
  });
}
