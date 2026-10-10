const test = require('node:test');
const assert = require('node:assert/strict');
const { persistPharmacyMessage } = require('../services/pharmacyChatMessageService');
const ChatMessage = require('../models/ChatMessage');
const ChatSession = require('../models/ChatSession');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const controller = require('../controllers/chatController');
const id='000000000000000000000010', sid='000000000000000000000001', owner='000000000000000000000002', pharmacist='000000000000000000000003';
const approved={_id:pharmacist,isVendor:true,vendorStatus:'approved',pharmacistStatus:'approved'};
const session={_id:sid,user:owner,pharmacist,status:'assigned',pharmacyAccessGrantedAt:new Date(),pharmacyAccessSource:'one_time'};
function memory(){const rows=new Map();return {rows,async create(data){const key=data._id||String(rows.size);if(rows.has(key))throw Object.assign(new Error('duplicate'),{code:11000});const m={...data,_id:key,createdAt:new Date()};rows.set(key,m);return m;},async findById(key){return rows.get(key);}};}
const args={sessionId:sid,senderId:owner,senderType:'user',text:'Local message',clientMessageId:id};
function response(){return {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
function req(user={_id:owner},body={sessionId:sid,message:'Local message',clientMessageId:id}){return {user,body,params:{sessionId:sid},app:{get(){return undefined;}}};}
function fixture(t, override={}){const store=memory();t.mock.method(ChatMessage,'create',store.create.bind(store));t.mock.method(ChatMessage,'findById',store.findById.bind(store));const current={...session,...override};t.mock.method(ChatSession,'findById',()=>Object.assign(Promise.resolve(current),{lean:async()=>current}));t.mock.method(User,'findByIdAndUpdate',async()=>({}));t.mock.method(notificationService,'sendToUser',async()=>({}));return store;}
test('socket and HTTP retries persist one message under concurrent delivery',async()=>{const store=memory();const results=await Promise.all([persistPharmacyMessage(args,store),persistPharmacyMessage(args,store),persistPharmacyMessage(args,store)]);assert.equal(store.rows.size,1);assert.equal(results.filter(r=>r.created).length,1);});
for(const [name,change] of Object.entries({text:{text:'changed'},sender:{senderId:pharmacist},session:{sessionId:pharmacist},role:{senderType:'pharmacist'}}))test('retry identity cannot change '+name,async()=>{const store=memory();await persistPharmacyMessage(args,store);await assert.rejects(persistPharmacyMessage({...args,...change},store),e=>e.status===409);assert.equal(store.rows.size,1);});
for(const [name,change] of Object.entries({malformed:{clientMessageId:'not-an-id'},empty:{text:' '},object:{text:{}},long:{text:'x'.repeat(5001)}}))test('invalid message rejected: '+name,async()=>{const store=memory();await assert.rejects(persistPharmacyMessage({...args,...change},store),e=>e.status===400);assert.equal(store.rows.size,0);});
test('older clients can send without retry identity',async()=>{const store=memory();const result=await persistPharmacyMessage({...args,clientMessageId:undefined},store);assert.equal(result.created,true);});
test('owner message confirmation includes durable identity',async t=>{const store=fixture(t);const res=response();await controller.sendMessage(req(),res);assert.equal(res.statusCode,200);assert.equal(String(res.body.message.id),id);assert.equal(res.body.message.session,sid);assert.equal(store.rows.size,1);});
test('HTTP retry returns existing confirmation without saving twice',async t=>{const store=fixture(t);await controller.sendMessage(req(),response());const res=response();await controller.sendMessage(req(),res);assert.equal(res.body.success,true);assert.equal(store.rows.size,1);});
test('approved pharmacist using own customer consultation remains a customer',async t=>{const store=fixture(t,{user:pharmacist,pharmacist:owner});const res=response();await controller.sendMessage(req(approved),res);assert.equal(res.statusCode,200);assert.equal([...store.rows.values()][0].senderType,'user');});
test('assigned approved pharmacist can respond',async t=>{fixture(t);const res=response();await controller.sendMessage(req(approved),res);assert.equal(res.statusCode,200);assert.equal(res.body.message.senderType,'pharmacist');});
for(const [name,user] of Object.entries({foreign:{_id:id},otherPharmacist:{...approved,_id:id},unapproved:{...approved,vendorStatus:'pending'}}))test('cannot send as '+name,async t=>{const store=fixture(t);const res=response();await controller.sendMessage(req(user),res);assert.equal(res.statusCode,403);assert.equal(store.rows.size,0);});
test('closed consultations reject messages',async t=>{const store=fixture(t,{status:'closed'});const res=response();await controller.sendMessage(req(),res);assert.equal(res.statusCode,409);assert.equal(store.rows.size,0);});
test('paid chat access cannot be bypassed',async t=>{const store=fixture(t,{pharmacyAccessGrantedAt:null});const res=response();await controller.sendMessage(req(),res);assert.equal(res.statusCode,402);assert.equal(store.rows.size,0);});
test('unrelated pharmacist cannot read assigned history',async t=>{fixture(t);const res=response();await controller.getSessionMessages(req({...approved,_id:id}),res);assert.equal(res.statusCode,403);});
test('active-session lookup stays scoped to the authenticated customer',async t=>{let query;t.mock.method(ChatSession,'findOne',q=>{query=q;return {sort(){return {lean:async()=>session};}};});const res=response();await controller.getActiveSession(req(),res);assert.equal(query.user,owner);assert.deepEqual(query.status,{$in:['open','assigned']});assert.equal(res.body.session._id,sid);});
test('closed consultations cannot be reopened by claiming',async t=>{fixture(t,{status:'closed'});const res=response();await controller.claimSession(req(approved),res);assert.equal(res.statusCode,409);});

const { retainChatSocketPresence } = require('../utils/chatSocketPresence');
const { claimPharmacySession } = require('../services/pharmacyChatSessionService');
test('closing a pharmacy chat keeps the authenticated inbox online', () => {
  const map = new Map([[pharmacist, 'chat']]);
  const sockets = [{id:'inbox',connected:true,user:{id:pharmacist}}, {id:'foreign',connected:true,user:{id:owner}}];
  assert.equal(retainChatSocketPresence(map,pharmacist,'chat',sockets),true);
  assert.equal(map.get(pharmacist),'inbox');
});
test('explicit offline status is not reactivated by a socket disconnect', () => {
  const map=new Map(); retainChatSocketPresence(map,pharmacist,'chat',[{id:'inbox',connected:true,user:{id:pharmacist}}]); assert.equal(map.size,0);
});
test('last socket disconnect removes presence and foreign sockets cannot replace it', () => {
  const map=new Map([[pharmacist,'chat']]); retainChatSocketPresence(map,pharmacist,'chat',[{id:'foreign',connected:true,user:{id:owner}}]);assert.equal(map.size,0);
});
test('a secondary disconnect does not remove the active socket', () => {
  const map=new Map([[pharmacist,'inbox']]);retainChatSocketPresence(map,pharmacist,'chat',[]);assert.equal(map.get(pharmacist),'inbox');
});
test('claim compares the previous assignment so a concurrent claim cannot overwrite it', async () => {
  let seen; const model={async findOneAndUpdate(filter,update){seen={filter,update};return null;}};
  const result=await claimPharmacySession({...session,pharmacist:null,status:'open'},pharmacist,model);
  assert.equal(result,null);assert.equal(seen.filter.pharmacist,null);assert.equal(seen.filter.status,'open');assert.equal(seen.update.$set.pharmacist,pharmacist);
});
test('reopening the assigned pharmacist conversation does not reassign it', async () => {
  const result=await claimPharmacySession(session,pharmacist,{findOneAndUpdate(){throw Error('must not update');}});assert.equal(result,session);
});

for (const [name, current, actor, role] of [
  ['owner', {}, {_id:owner}, 'user'],
  ['assigned pharmacist', {}, approved, 'pharmacist'],
  ['unassigned paid queue preview', {pharmacist:null,status:'open'}, approved, 'pharmacist'],
]) test('authorized history includes the correct actor: '+name, async t => {
  fixture(t,current);
  t.mock.method(ChatMessage,'find',()=>({sort:()=>({lean:async()=>[]})}));
  t.mock.method(User,'findById',()=>({select:()=>({lean:async()=>({businessName:'Local Pharmacy'})})}));
  const res=response(); await controller.getSessionMessages(req(actor),res);
  assert.equal(res.statusCode,200);assert.equal(res.body.actorRole,role);assert.deepEqual(res.body.messages,[]);
});
test('an unapproved assigned pharmacist cannot read history',async t=>{fixture(t);const res=response();await controller.getSessionMessages(req({...approved,pharmacistStatus:'pending'}),res);assert.equal(res.statusCode,403);});
test('a queue preview requires an explicit access grant',async t=>{fixture(t,{pharmacist:null,status:'open',pharmacyAccessGrantedAt:null});const res=response();await controller.getSessionMessages(req(approved),res);assert.equal(res.statusCode,403);});
test('retry confirmation broadcasts the stored message only once',async t=>{fixture(t);const events=[];const request=req();request.app.get=key=>key==='io'?{to:()=>({emit:(event,data)=>events.push({event,data})})}:undefined;await controller.sendMessage(request,response());await controller.sendMessage(request,response());assert.equal(events.length,1);assert.equal(events[0].data.id,id);});
