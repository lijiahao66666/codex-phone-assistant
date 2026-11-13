import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
const deviceId='22222222-2222-4222-8222-222222222222', threadId='33333333-3333-4333-8333-333333333333', other='44444444-4444-4444-8444-444444444444';
const wait=async f=>{const end=Date.now()+3000;while(!f()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,5));}};
async function fixture(listThreads=async()=>({projects:[],recent:[{id:threadId}],nativeUnread:{status:'unavailable'}}),open=async()=>{}) {
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const conn=once(server,'connection'),events=[],calls=[];
 const connector=createPreviewConnector({url:`ws://127.0.0.1:${server.address().port}/connector`,secret:'x'.repeat(32),hostId:'host',allowInsecureForTests:true,listThreads,openDesktopThreadForTests:async id=>{calls.push(id);await open(id);},traceForTests:()=>{}});
 connector.start();const [socket]=await conn;socket.on('message',raw=>events.push(JSON.parse(raw)));return {calls,events,send:value=>socket.send(JSON.stringify(value)),async reply(id){await wait(()=>events.some(x=>x.id===id&&x.type==='response'));return events.find(x=>x.id===id&&x.type==='response');},async close(){await connector.close();socket.terminate();await new Promise(r=>server.close(r));}};
}
test('explicit open requires an authorized chat, but no unread identity or notification capability',async()=>{const f=await fixture();try{f.send({type:'desktop-open',id:'ok',deviceId,conversationId:threadId});assert.equal((await f.reply('ok')).status,'accepted');assert.deepEqual(f.calls,[threadId]);f.send({type:'desktop-open',id:'bad',deviceId,conversationId:other});assert.equal((await f.reply('bad')).status,'unavailable');assert.deepEqual(f.calls,[threadId]);}finally{await f.close();}});
test('cancel or device revocation during authorization prevents desktop navigation',async()=>{for(const kind of ['cancel-reply','device-revoked']){let release,entered=false;const gate=new Promise(r=>release=r);const f=await fixture(async()=>{entered=true;await gate;return {projects:[],recent:[{id:threadId}]};});try{f.send({type:'desktop-open',id:'pending',deviceId,conversationId:threadId});await wait(()=>entered);f.send({type:kind,id:'pending',deviceId});await new Promise(r=>setTimeout(r,30));release();await new Promise(r=>setTimeout(r,60));assert.deepEqual(f.calls,[]);}finally{release();await f.close();}}});
test('concurrent desktop openings never run simultaneously',async()=>{let release,entered=false;const gate=new Promise(r=>release=r);const f=await fixture(undefined,async()=>{entered=true;await gate;});try{f.send({type:'desktop-open',id:'a',deviceId,conversationId:threadId});await wait(()=>entered);f.send({type:'desktop-open',id:'b',deviceId,conversationId:threadId});assert.equal((await f.reply('b')).status,'unavailable');assert.equal(f.calls.length,1);release();assert.equal((await f.reply('a')).status,'accepted');}finally{release();await f.close();}});

test('immediate cancellation and a cancelled recovery wait never open the desktop', async()=>{
  const f=await fixture();try{f.send({type:'desktop-open',id:'early',deviceId,conversationId:threadId});f.send({type:'cancel-reply',id:'early'});await new Promise(r=>setTimeout(r,100));assert.deepEqual(f.calls,[]);}finally{await f.close();}
});
