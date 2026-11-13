import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedUserOperation } from '../src/desktop/confirmed-user-operation.mjs';
const thread='thread', operation='client-operation';
const base=items=>({id:thread,turns:[{turnId:'turn',items}]});
test('only matching concrete user items prove an operation, not optimistic prompts', () => {
  assert.equal(confirmedUserOperation({id:thread,turns:[{turnId:'turn',params:{clientUserMessageId:operation},items:[]}]},thread,operation),false);
  assert.equal(confirmedUserOperation(base([{type:'userMessage',id:'server',clientId:operation}]),thread,operation),true);
  assert.equal(confirmedUserOperation(base([{type:'steeringUserMessage',clientUserMessageId:operation,serverUserMessageId:'server'}]),thread,operation),false);
  assert.equal(confirmedUserOperation(base([{type:'steeringUserMessage',status:'accepted',clientUserMessageId:operation,serverUserMessageId:'server'},{type:'userMessage',id:'server'}]),thread,operation),true);
  assert.equal(confirmedUserOperation(base([{type:'userMessage',id:'server',clientId:operation}]),'other',operation),false);
  assert.equal(confirmedUserOperation(base([{type:'userMessage',id:'one',clientId:operation},{type:'userMessage',id:'two',clientId:operation}]),thread,operation),false);
});
test('canonical evidence is allowed but malformed or conflicting histories fail closed', () => {
  const turn={turnId:'turn',items:[{type:'userMessage',id:'server',clientId:operation}]};
  const state={id:thread,turns:[],turnHistory:{kind:'canonical',history:{islands:[{entries:[{value:'key'}]}],entitiesByKey:{key:turn}}}};
  assert.equal(confirmedUserOperation(state,thread,operation),true);
  assert.equal(confirmedUserOperation({...state,turns:[{turnId:'turn',items:[]}]},thread,operation),false);
  assert.equal(confirmedUserOperation({...state,turnHistory:{kind:'canonical',history:{islands:[{entries:[{value:'missing'}]}],entitiesByKey:{}}}},thread,operation),false);
});

test('desktop session passes the same operation identity to start and steer', async () => {
  const { DesktopSession } = await import('../src/desktop/session.mjs');
  const session = new DesktopSession({conversationId:thread});
  let captured;
  session.client={startTurn:async(_id,params)=>{captured=params.request.clientUserMessageId;},steerTurn:async(_id,_input,options)=>{captured=options.clientUserMessageId;}};
  session.status='ready';
  session.conversation.accept('owner',{type:'snapshot',revision:1,conversationState:{id:thread,cwd:'/tmp',threadRuntimeStatus:{type:'idle'},turns:[]}});
  await session.sendText('fixture',{clientUserMessageId:operation});assert.equal(captured,operation);
  session.conversation.accept('owner',{type:'snapshot',revision:2,conversationState:{id:thread,cwd:'/tmp',threadRuntimeStatus:{type:'active'},turns:[{turnId:'turn',status:'inProgress',items:[]}]}});
  await session.sendText('fixture',{clientUserMessageId:operation});assert.equal(captured,operation);
  await session.sendAttachments('fixture',[{kind:'file',path:'/tmp/file',name:'file'}],{clientUserMessageId:operation});assert.equal(captured,operation);
});

test('only a unique accepted steer with a server identity is confirmed', () => {
  const steer={type:'steeringUserMessage',status:'accepted',clientUserMessageId:operation,serverUserMessageId:'server'};
  assert.equal(confirmedUserOperation(base([steer]),thread,operation),true);
  for (const status of ['pending','failed','unknown']) assert.equal(confirmedUserOperation(base([{...steer,status}]),thread,operation),false);
  for (const serverUserMessageId of ['',null,'bad id']) assert.equal(confirmedUserOperation(base([{...steer,serverUserMessageId}]),thread,operation),false);
  assert.equal(confirmedUserOperation(base([{...steer,clientUserMessageId:'other'}]),thread,operation),false);
  assert.equal(confirmedUserOperation(base([steer,steer]),thread,operation),false);
  assert.equal(confirmedUserOperation(base([steer,{type:'userMessage',id:'other',clientId:operation}]),thread,operation),false);
  assert.equal(confirmedUserOperation({id:thread,turns:[{turnId:'turn',remodexOptimisticPendingTurn:true,items:[steer]}]},thread,operation),false);
});
