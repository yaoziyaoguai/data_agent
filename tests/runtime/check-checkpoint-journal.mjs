import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,unlinkSync,symlinkSync} from 'node:fs';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {restoreCheckpoint,exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {createDeliveryServer} from '../../apps/agent/transport/server.ts';
import {appendLongHistory} from './checkpoint-fixture.mjs';

const cwd='/synthetic/data-agent';
const manager=restoreCheckpoint(cwd,null);
const history=await appendLongHistory(manager);
const checkpoint=exportCheckpoint(manager);
assert.equal(checkpoint.storage.kind,'pi_session');assert.deepEqual(checkpoint.entries,[]);
const path=manager.getSessionFile(),journal=readFileSync(path);
assert.ok(journal.length>512*1024);assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<2048);
assert.equal(lstatSync(path).mode&0o777,0o600);
const restored=restoreCheckpoint(cwd,checkpoint);
assert.equal(restored.getSessionId(),manager.getSessionId());assert.equal(restored.getLeafId(),checkpoint.leaf_id);
assert.deepEqual(restored.getEntries(),manager.getEntries());
assert.equal(restored.getEntries().filter(e=>e.type==='compaction').length,10);
const projected=restored.buildSessionContext();
const originalLeaf=restored.getLeafId();
const tail=restored.appendMessage({role:'user',content:'未由MySQL确认的尾部分支',timestamp:Date.now()});
const beforeRecovery=readFileSync(path);
const recovered=restoreCheckpoint(cwd,checkpoint);
assert.equal(recovered.getLeafId(),originalLeaf);assert.deepEqual(recovered.buildSessionContext(),projected);
assert.ok(recovered.getEntry(tail),'原始分支保留在Pi日志');
const empty=restoreCheckpoint(cwd,{...checkpoint,leaf_id:null});assert.equal(empty.getLeafId(),null);assert.equal(empty.buildSessionContext().messages.length,0);
let dispatches=0;const token='synthetic-token';
const server=createDeliveryServer('http://127.0.0.1:1',token,async(run)=>{dispatches++;assert.equal(run.checkpoint.storage.session_id,manager.getSessionId());});
const body=Buffer.from(JSON.stringify({run_id:'run-1',conversation_id:'conversation-1',recovery_chain_id:'chain-1',lease_epoch:'1',budget_scope_id:'scope-1',output_id:'output-1',attempt_id:'attempt-1',message_id:'message-1',request_id:'request-1',text:'继续原长期会话',checkpoint,model_profile:null}));
const response={statusCode:200,writeHead(code){this.statusCode=code;return this;},end(){return this;}};
await server.listeners('request')[0]({url:'/resume-and-deliver',method:'POST',headers:{authorization:'Bearer '+token},async *[Symbol.asyncIterator](){yield body;}},response);
assert.equal(response.statusCode,200);assert.equal(dispatches,1);
const inline=exportCheckpoint(SessionManager.inMemory(cwd));
const legacy=SessionManager.inMemory(cwd,undefined,[manager.getHeader(),...manager.getEntries()]);legacy.branch(checkpoint.leaf_id);
const migrated=restoreCheckpoint(cwd,exportCheckpoint(legacy));
assert.equal(migrated.getSessionId(),manager.getSessionId());assert.equal(migrated.getLeafId(),checkpoint.leaf_id);assert.deepEqual(migrated.getEntries(),manager.getEntries());
assert.equal(exportCheckpoint(migrated).storage.kind,'pi_session');
const migratedPath=migrated.getSessionFile();assert.notEqual(migratedPath,path);
const faults=[
 ['empty',Buffer.alloc(0)],
 ['broken_json',Buffer.concat([beforeRecovery,Buffer.from('{broken\n')])],
 ['invalid_utf8',Buffer.concat([beforeRecovery,Buffer.from([0xff,0x0a])])],
 ['duplicate_id',Buffer.concat([beforeRecovery,Buffer.from(JSON.stringify(manager.getEntries()[0])+'\n')])],
 ['missing_parent',Buffer.concat([beforeRecovery,Buffer.from(JSON.stringify({type:'message',id:'orphan-id',parentId:'missing-parent',message:{role:'user',content:'坏父节点'}})+'\n')])],
 ];
try {
 for(const [name,bytes]of faults){writeFileSync(path,bytes);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_invalid/,name);assert.deepEqual(readFileSync(path),bytes,'失败不修补或覆盖原文件');}
 writeFileSync(path,beforeRecovery);assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,leaf_id:'missing-leaf'}),/checkpoint_leaf_unavailable/);
 assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,storage:{...checkpoint.storage,session_id:inline.entries[0].id}}),/checkpoint_storage_invalid/);
 assert.throws(()=>restoreCheckpoint(cwd,{...checkpoint,storage:{...checkpoint.storage,file:'../private.jsonl'}}));
 unlinkSync(path);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_missing/);assert.equal(lstatSync(migratedPath).isFile(),true);
 symlinkSync(migratedPath,path);assert.throws(()=>restoreCheckpoint(cwd,checkpoint),/checkpoint_storage_invalid/);unlinkSync(path);
}finally{writeFileSync(path,beforeRecovery,{mode:0o600});}
console.log(JSON.stringify({passed:true,...history,journalBytes:journal.length,referenceBytes:Buffer.byteLength(JSON.stringify(checkpoint)),envelopeBytes:body.length,nativeSessionPreserved:true,originalLeafPreserved:true,malformedFilesRejected:faults.length,officialRequests:0}));
