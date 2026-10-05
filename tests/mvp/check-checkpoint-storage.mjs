import assert from 'node:assert/strict';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {appendLongHistory} from '../runtime/checkpoint-fixture.mjs';
import {harness} from './harness.mjs';

const h=await harness({capture:true});let passed=false;
try {
 const cid=await h.create();await h.resumeWorker();
 let run=await h.capture(cid,'解释净收入指标的含义');await h.pauseWorker();
 await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
 const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
 const sourceChain=run.recovery_chain_id;
 assert.equal(saved.storage.kind,'pi_session');
 const manager=SessionManager.inMemory('/synthetic/data-agent');await appendLongHistory(manager);
 const legacy=exportCheckpoint(manager,saved.authority_revision,saved.authority_snapshot);
 const legacyBytes=Buffer.byteLength(JSON.stringify(legacy));assert.ok(legacyBytes>512*1024);
 const sqlString=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'";
 h.sql(`UPDATE pi_checkpoints SET checkpoint=CAST(${sqlString(legacy)} AS JSON),version=version+1 WHERE recovery_chain_id='${run.recovery_chain_id}'`);
 execFileSync(process.env.HOME+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','checkpoint_selection_preserves_large_history_and_latest_valid_run','--','--nocapture'],{env:{...h.env,DATA_AGENT_TEST_CONVERSATION_ID:cid},stdio:'inherit'});
 await h.resumeWorker();run=await h.capture(cid,'继续解释支付客户数指标');await h.pauseWorker();
 assert.equal(run.checkpoint.storage.kind,'host_checkpoint');assert.deepEqual(run.checkpoint.entries,[]);
 assert.ok(Buffer.byteLength(JSON.stringify(run))<512*1024);
 const binding={run_id:run.run_id,lease_epoch:run.lease_epoch};
 assert.equal((await h.request('/internal/checkpoints/read',binding)).status,401);
 assert.equal((await h.internal('/internal/checkpoints/read',{...binding,lease_epoch:'0'})).status,409);
 const original=await h.internal('/internal/checkpoints/read',binding);assert.equal(original.status,200);assert.deepEqual(original.value,legacy);
 // 交付后的源行变化不能让只读迁移换成另一份SDK历史。
 const beforeVersion=h.sql(`SELECT JSON_OBJECT('v',version) FROM pi_checkpoints WHERE recovery_chain_id='${sourceChain}'`)[0].v;
 h.sql(`UPDATE pi_checkpoints SET checkpoint=CAST(${sqlString(saved)} AS JSON),version=version+1 WHERE recovery_chain_id='${sourceChain}'`);
 assert.equal(h.sql(`SELECT JSON_OBJECT('v',version) FROM pi_checkpoints WHERE recovery_chain_id='${sourceChain}'`)[0].v,beforeVersion+1);
 const transport=new RustTransport(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN);
 const acquired=await transport.post('/internal/checkpoints/read','ReadCheckpoint',binding,run.checkpoint.storage.fingerprint);assert.deepEqual(acquired,legacy);
 await assert.rejects(transport.post('/internal/checkpoints/read','ReadCheckpoint',binding,'0'.repeat(64)),/checkpoint_conflict/);
 await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);
 const current=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
 assert.equal(current.storage.kind,'pi_session');assert.ok(Buffer.byteLength(JSON.stringify(current))<32768);
 const restored=restoreCheckpoint('/synthetic/data-agent',current);assert.equal(restored.getSessionId(),manager.getSessionId());
 assert.ok(readFileSync(restored.getSessionFile()).length>512*1024);
 assert.equal((await h.snapshot(cid)).runs.find(r=>r.run_id===run.run_id).state,'finished');
 assert.equal((await h.internal('/internal/checkpoints/read',binding)).status,409,'已结束运行不能再次读取历史');
 await h.resumeWorker();const next=await h.capture(cid,'再说明支付时间的口径');await h.pauseWorker();
 assert.equal(next.checkpoint.storage.kind,'pi_session');assert.equal(next.checkpoint.storage.session_id,manager.getSessionId());
 assert.equal((await h.internal('/internal/checkpoints/read',{run_id:next.run_id,lease_epoch:next.lease_epoch})).status,404,'新引用不伪装为旧内联迁移');
 const document=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+document.id+'/disable',{operation_id:crypto.randomUUID(),expected_version:document.version})).status,200);
 // 本运行的授权快照失效后，不得回读原始SDK历史。
 h.sql(`UPDATE agent_runs SET legacy_delivery_checkpoint=CAST(${sqlString(legacy)} AS JSON) WHERE id='${next.run_id}'`);
 assert.equal((await h.internal('/internal/checkpoints/read',{run_id:next.run_id,lease_epoch:next.lease_epoch})).value.code,'stale_context');
 passed=true;
 console.log(JSON.stringify({passed,legacyBytes,referenceBytes:Buffer.byteLength(JSON.stringify(current)),journalBytes:readFileSync(restored.getSessionFile()).length,checks:['大旧检查点以小交付迁移','不可变原值与指纹','正式API工具登记及finish以小引用提交','同原生session续聊','内部权限/租约/终态/失效依据拒绝'],officialRequests:0}));
}finally{await h.close();}
