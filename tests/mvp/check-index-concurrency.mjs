import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

let h,gate,passed=false;const observed={};
try{
 h=await harness();await h.pauseWorker();
 const objectId='table-demo_order_detail',markerId='field-paid_amount_cents';
 const original=(await h.request('/knowledge/'+objectId)).value;
 h.sql("UPDATE knowledge_index_jobs SET state='indexed'");
 h.sql(`UPDATE knowledge_index_jobs SET state='pending' WHERE object_id IN ('${objectId}','${markerId}')`);
 const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
 const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);assert.match(database,/^data_agent_test_[a-f0-9]+$/);
 gate=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--skip-column-names','--unbuffered'],{stdio:['pipe','pipe','pipe']});
 let stdout='';gate.stdout.on('data',v=>stdout+=v.toString());
 gate.stdin.write(`USE ${database}; START TRANSACTION; SELECT id FROM knowledge_objects WHERE id='${objectId}' FOR UPDATE; SELECT 'object_locked';\n`);
 await until(()=>stdout.includes('object_locked'),'语义对象竞争窗口');
 const saving=h.request('/knowledge/'+objectId+'/reanalyze',{operation_id:randomUUID(),expected_version:original.version});
 const waits=()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='knowledge_objects' AND l.LOCK_DATA LIKE '%${objectId}%'`)[0].n;
 const markerIndexed=()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM knowledge_index_jobs WHERE object_id='${markerId}' AND version=1`)[0].state==='indexed';
 await until(()=>waits()===1,'前端先排队等待对象');await h.resumeWorker();
 // 旧实现也进入对象等待且持有作业锁；修复后跳过该对象，仍处理其他作业。
 await until(()=>waits()>=2||markerIndexed(),'Worker领取其他对象或暴露旧反向锁序');
 observed.workerSkippedLockedObject=markerIndexed();observed.objectWaiters=waits();
 gate.stdin.end('COMMIT;\n');const saved=await saving;observed.saveStatus=saved.status;
 assert.equal(saved.status,200,'合法重新预填不应被索引Worker死锁回滚');
 assert.equal(observed.workerSkippedLockedObject,true,'被锁对象不应阻塞其他对象索引');assert.equal(observed.objectWaiters,1);
 assert.equal(BigInt(saved.value.version),BigInt(original.version)+1n);
 const records=h.sql(`SELECT JSON_OBJECT('versions',(SELECT COUNT(*) FROM knowledge_versions WHERE object_id='${objectId}'),'jobs',(SELECT COUNT(*) FROM knowledge_index_jobs WHERE object_id='${objectId}' AND version=${saved.value.version}))`)[0];
 assert.deepEqual(records,{versions:2,jobs:1});
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM knowledge_index_jobs WHERE object_id='${objectId}' AND version=${saved.value.version}`)[0].state==='indexed','最新知识版本索引');
 assert.equal(h.sql(`SELECT JSON_OBJECT('state',vector_state) FROM knowledge_index_jobs WHERE object_id='${objectId}' AND version=${original.version}`)[0].state,'superseded');
 await h.pauseWorker();
 // 构造超过单轮清理上限的合法版本积压，核对后续轮次仍能清理尾部。
 h.sql(`UPDATE knowledge_objects SET version=72,body=JSON_SET(body,'$.version','72') WHERE id='${objectId}'`);
 h.sql(`INSERT INTO knowledge_versions(object_id,version,body) WITH RECURSIVE versions(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM versions WHERE n<72) SELECT '${objectId}',n,JSON_SET(k.body,'$.version',CAST(n AS CHAR)) FROM versions CROSS JOIN knowledge_objects k WHERE k.id='${objectId}'`);
 h.sql(`INSERT INTO knowledge_index_jobs(object_id,version) WITH RECURSIVE versions(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM versions WHERE n<72) SELECT '${objectId}',n FROM versions`);
 await h.resumeWorker();
 await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id='${objectId}' AND version<72 AND vector_state='superseded'`)[0].n===71,'多轮清理超过64条旧索引作业');
 await until(()=>h.sql(`SELECT JSON_OBJECT('state',state) FROM knowledge_index_jobs WHERE object_id='${objectId}' AND version=72`)[0].state==='indexed','清理尾部后最新版本仍可索引');
 observed.staleJobsRetired=71;observed.currentVersionIndexed='72';
 passed=true;console.log(JSON.stringify({passed,observed,records,officialRequests:0}));
}finally{
 if(gate&&gate.exitCode===null){gate.stdin.end('ROLLBACK;\n');await new Promise(r=>gate.once('exit',r));}
 if(h)await h.close();await writeFile('.local/checks/mvp-index-concurrency.json',JSON.stringify({passed,observed,officialRequests:0},null,2));
}
