import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, Agent } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChunkUploads } from '../src/media/chunk-upload.mjs';
import { UploadStore } from '../src/media/upload-store.mjs';

const scope={hostId:'host',deviceId:'device',threadId:'thread'};
async function fixture(options={}) {
  const root=await mkdtemp(join(tmpdir(),'phone-upload-pipeline-'));
  const store=await UploadStore.create({root});
  const uploads=new ChunkUploads(store,{maxChunk:512*1024,pipelineWindow:2,...options});
  return {store,uploads,async close(){await uploads.close();await store.close();await rm(root,{recursive:true,force:true});}};
}

test('out-of-order pair waits for ordered storage and preserves every byte',async()=>{
  const f=await fixture();
  try {
    const a=randomBytes(512*1024),b=randomBytes(512*1024),data=Buffer.concat([a,b]);
    const id=f.uploads.start({...scope,name:'ordered.bin',kind:'file',size:data.length});
    let acknowledged=false;
    const second=f.uploads.chunk(id,scope,1,b).then(()=>{acknowledged=true;});
    await delay(10);assert.equal(acknowledged,false);
    await Promise.all([second,f.uploads.chunk(id,scope,0,a)]);
    const saved=await f.uploads.finish(id,scope);
    assert.deepEqual(await readFile(f.store.resolve({id:saved.id,...scope}).path),data);
  }finally{await f.close();}
});

test('acknowledgement waits until the store resumes after its awaited file write',async()=>{
  const f=await fixture();let release;const gate=new Promise(r=>{release=r;});
  const put=f.store.put.bind(f.store);
  f.store.put=options=>put({...options,chunks:(async function*(){for await(const bytes of options.chunks){yield bytes;await gate;}})()});
  try {
    const id=f.uploads.start({...scope,name:'ack.bin',kind:'file',size:32});
    let acknowledged=false;
    const pending=f.uploads.chunk(id,scope,0,Buffer.alloc(32)).then(()=>{acknowledged=true;});
    await delay(15);assert.equal(acknowledged,false);
    release();await pending;await f.uploads.finish(id,scope);
  }finally{release();await f.close();}
});

for(const reason of ['cancel','close','idle','deadline','writer-error'])test(`${reason} rejects all queued requests without reviving the upload`,async()=>{
  const f=await fixture({timeoutMs:reason==='idle'?30:500,maxDurationMs:reason==='deadline'?40:2000});
  let release;const gate=new Promise(r=>{release=r;});
  const put=f.store.put.bind(f.store);
  if(reason!=='idle'&&reason!=='deadline')f.store.put=async options=>{await gate;if(reason==='writer-error')throw new Error('disk failed');return put(options);};
  try {
    const id=f.uploads.start({...scope,name:'pending.bin',kind:'file',size:1024*1024});
    const second=f.uploads.chunk(id,scope,1,Buffer.alloc(512*1024));
    const p1=assert.rejects(second,/Upload cancelled|disk failed/);
    let p0;
    if(reason!=='idle'&&reason!=='deadline')p0=assert.rejects(f.uploads.chunk(id,scope,0,Buffer.alloc(512*1024)),/Upload cancelled|disk failed/);
    if(reason==='cancel'){const stopping=f.uploads.cancel(id,scope);release();await stopping;}
    else if(reason==='close'){const stopping=f.uploads.close();release();await stopping;}
    else if(reason==='writer-error')release();
    await Promise.all([p1,p0]);
    await assert.rejects(f.uploads.chunk(id,scope,0,Buffer.alloc(1)),/Upload unavailable/);
    await f.uploads.close();assert.deepEqual(await readdir(f.store.directory),[]);
  }finally{release();await f.close();}
});

test('duplicate, far-ahead, over-reserved bytes and premature finish are rejected',async()=>{
  for(const mode of ['duplicate','far-ahead','size','finish']){
    const f=await fixture();
    try{
      const id=f.uploads.start({...scope,name:'invalid.bin',kind:'file',size:mode==='size'?10:100});
      const second=f.uploads.chunk(id,scope,1,Buffer.alloc(mode==='size'?6:50));
      const rejected=assert.rejects(second,/Upload cancelled/);
      if(mode==='finish')await assert.rejects(f.uploads.finish(id,scope),/Incomplete upload/);
      else await assert.rejects(f.uploads.chunk(id,scope,mode==='duplicate'?1:mode==='far-ahead'?2:0,Buffer.alloc(mode==='size'?6:50)),/Invalid upload chunk/);
      await rejected;
    }finally{await f.close();}
  }
});

test('isolated real HTTP pair pipeline overlaps the same artificial response RTT',async t=>{
  // Keep loopback payload small so this isolates response round trips, rather
  // than machine-specific upload throughput. Separate tests cover 512 KiB.
  const data=randomBytes(256*1024),chunkSize=32*1024,rttMs=30;
  async function transfer(window){
    const f=await fixture();
    const id=f.uploads.start({...scope,name:'http.bin',kind:'file',size:data.length});
    const server=createServer(async(req,res)=>{
      try{
        const pieces=[];for await(const b of req)pieces.push(b);
        await f.uploads.chunk(id,scope,Number(req.url.slice(1)),Buffer.concat(pieces));
        await delay(rttMs);res.end('ok');
      }catch{res.statusCode=400;res.end('failed');}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const agent=new Agent({keepAlive:true,maxSockets:2});
    try{
      const started=performance.now(),requests=data.length/chunkSize;let next=0;
      async function worker(){while(next<requests){
        const seq=next++,body=data.subarray(seq*chunkSize,(seq+1)*chunkSize);
        const status=await new Promise((resolve,reject)=>{
          const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:`/${seq}`,method:'PUT',agent,headers:{'content-length':body.length}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));res.once('error',reject);});
          req.once('error',reject);req.end(body);
        });
        assert.equal(status,200);
      }}
      await Promise.all(Array.from({length:window},worker));
      const saved=await f.uploads.finish(id,scope),elapsedMs=Math.round(performance.now()-started);
      assert.deepEqual(await readFile(f.store.resolve({id:saved.id,...scope}).path),data);
      return {requests,elapsedMs};
    }finally{agent.destroy();await new Promise(r=>server.close(r));await f.close();}
  }
  const serial=await transfer(1),pipeline2=await transfer(2);
  assert.equal(serial.requests,8);assert.equal(pipeline2.requests,8);
  t.diagnostic(JSON.stringify({isolatedHttp:true,bytes:data.length,artificialResponseRttMs:rttMs,serial,pipeline2}));
});
