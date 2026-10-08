// 明确 --real 才调用现有已授权配置。沿用原数据库和总账，不新建试验或补额。
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {until} from './harness.mjs';
import {assetInput} from './skill-fixtures.mjs';
assert.ok(process.argv.includes('--real'),'真实试用必须显式选择 --real');
const configPath=process.env.DATA_AGENT_DOGFOOD_CONFIG??'.local/dogfood-20261007/configuration.json';
const embeddingPath=process.env.DATA_AGENT_DOGFOOD_EMBEDDING_PROFILE??'.local/dogfood-20261007/embedding-profile.json';
assert.ok(configPath.startsWith('.local/')&&embeddingPath.startsWith('.local/'));
const config=JSON.parse(await readFile(configPath,'utf8'));assert.equal(config.profile.model_id,'deepseek-flash');assert.match(config.database,/^data_agent_trial_[a-f0-9]+$/);assert.match(config.profile.trial_id,/^[a-f0-9-]+$/);
const directory='.local/skill-delivery/real-'+randomUUID();await mkdir(directory,{recursive:true,mode:0o700});
const report={passed:false,mode:'official_flash_mem0_hybrid_mock_platform',started_at:new Date().toISOString(),startup:[],cases:[],ledger_before:null,ledger_after:null};
const save=()=>writeFile(directory+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();assert.match(container,/^[a-f0-9]+$/);
const sql=query=>execFileSync('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--skip-column-names','--default-character-set=utf8mb4'],{input:'USE '+config.database+';'+query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v));
const ledger=()=>sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state,'valid',expires_at>UTC_TIMESTAMP(3)) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0]??{calls:0,spent_micros:0,reserved_micros:0};
const probe=port=>new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
let offset;for(let value=25000;value<=45000;value+=100){if((await Promise.all([8780,8781,8790,8791,5173].map(port=>probe(port+value)))).every(Boolean)){offset=value;break;}}assert.ok(offset);
let launcher,output='';
const stop=async()=>{if(launcher&&launcher.exitCode===null&&launcher.signalCode===null){launcher.kill('SIGTERM');await new Promise(resolve=>launcher.once('exit',resolve));}};
const launch=async(check,runtime)=>{
 output='';launcher=spawn('python3',['scripts/development.py','--model','deepseek','--model-profile',configPath,'--embedding-profile',embeddingPath,'--port-offset',String(offset),'--runtime-dir',runtime,...(check?['--check']:[])],{stdio:['ignore','pipe','pipe']});
 launcher.stdout.on('data',v=>output+=v);launcher.stderr.on('data',v=>output+=v);
 if(check){const code=await new Promise(resolve=>launcher.once('exit',resolve));await writeFile(runtime+'/launcher.log',output);assert.equal(code,0,output);}
 else await until(()=>{if(launcher.exitCode!==null)throw new Error('real_startup_failed');return output.includes('Ctrl+C 关闭本次启动');},'真实服务全部就绪',90000);
 report.startup.push({check,stages:output.split('\n').filter(line=>line.startsWith('startup ')).map(line=>line.replace(/log=.*/, 'log=<runtime>'))});await save();
};
try {
 report.ledger_before=ledger();await save();
 assert.equal(report.ledger_before.valid,true,'原试验预算已过期；需用户授权延长期限，不重置账本或额度');
 await launch(true,directory+'/startup');
 await launch(false,directory+'/runtime');
 const identity=JSON.parse(await readFile(directory+'/runtime/identities.json','utf8'));const apiUrl='http://127.0.0.1:'+(8780+offset);
 const request=async(path,body,user='alice')=>{const response=await fetch(apiUrl+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+identity[user],'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;};
 const create=async()=>(await request('/conversations',{operation_id:randomUUID()})).conversation_id;
 const ask=async(cid,text)=>{
  const before=(await request(`/conversations/${cid}/snapshot`)).runs.map(v=>v.run_id);
  const receipt=await request(`/conversations/${cid}/messages`,{client_message_id:randomUUID(),text});
  const record={conversation_id:cid,message_id:receipt.message_id,text};report.cases.push(record);await save();
  // 一条输入会经过多次官方模型调用；等待覆盖实测累计延迟，产品请求超时仍独立生效。
  const state=await until(async()=>{const s=await request(`/conversations/${cid}/snapshot`);const runs=s.runs.filter(v=>!before.includes(v.run_id));return runs.length&&runs.every(v=>['finished','failed','cancelled'].includes(v.state))?s:false;},'真实输入 '+receipt.message_id,360000);
  record.snapshot=state;await save();assert.ok(state.runs.filter(v=>!before.includes(v.run_id)).every(v=>v.state==='finished'),'真实输入未完成，见隔离报告');return state;
 };
 const cid=await create();
 const skill=await request('/assets',assetInput({name:'合成试用报告方法',body:'需要查看结果时先核对语义与时间。SQL 必须经用户按钮确认。回答顺序遵守 references/report.md。',files:[{path:'references/report.md',content:'回答顺序：先给结论，再列出依据，最后说明范围限制。'}]}));
 await request(`/conversations/${cid}/skill-selections`,{operation_id:randomUUID(),asset_id:skill.id,version:skill.version});
 await ask(cid,'请完整读取本会话已选 Skill 及 references/report.md，简要说明方法约定的回答顺序。现在不查数据。');
 const nativeReads=sql(`SELECT JSON_OBJECT('tool',tool_name,'state',state,'path',JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.path'))) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='read' AND state='succeeded'`);
 assert.ok(nativeReads.some(v=>v.path.endsWith('/SKILL.md')));assert.ok(nativeReads.some(v=>v.path.endsWith('/references/report.md')));report.native_reads=nativeReads;await save();
 await ask(cid,'请给出2026年1月按渠道汇总净收入的SQL。使用现有合成业务表和正式口径，包含所有渠道；先不执行。');
 let query=(await request(`/conversations/${cid}/queries`)).queries.at(-1);assert.ok(query);assert.equal(query.confirmation_state,'awaiting_confirmation');assert.equal(query.execution_state,'not_submitted');
 await ask(cid,'刚才的SQL改为只看web渠道，时间仍是2026年1月，先不要执行。');
 const revised=(await request(`/conversations/${cid}/queries`)).queries.at(-1);assert.ok(revised);assert.notEqual(revised.id,query.id);assert.equal(revised.confirmation_state,'awaiting_confirmation');assert.equal(revised.execution_state,'not_submitted');
 const taskChanges=sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='update_analysis_task' AND state='succeeded'`).map(v=>v.data);
 assert.ok(taskChanges.some(v=>v.task_id===revised.task_id&&v.condition_version===revised.condition_version&&v.conditions?.channel==='web'),'本次修订应保存对应任务版本的web条件');assert.ok(/web/i.test(revised.sql)||Object.values(revised.parameters).some(v=>v==='web'));
 await request('/queries/'+revised.id+'/confirm',{operation_id:randomUUID(),draft_version:revised.draft_version,condition_version:revised.condition_version});
 query=await until(async()=>{const q=await request('/queries/'+revised.id);if(q.execution_state==='failed')throw new Error('mock_query_failed');return q.execution_state==='succeeded'?q:false;},'确认版本后mock查询',30000);
 report.query={id:query.id,results:await request('/queries/'+query.id+'/results')};await save();
 await ask(cid,'请解释刚才查询到的web渠道净收入和口径。');
 const memoryCid=await create(), memoryTopic='合成订单验收'+randomUUID().slice(0,8);
 const previousMemories=new Map((await request('/assets')).assets.filter(v=>v.kind==='memory').map(v=>[v.id,v.version]));
 await ask(memoryCid,`请记住：以后我做${memoryTopic}的收入分析时，默认金额以元展示；这是我的个人习惯，临时要求优先，不改变共享指标定义。现在不用查数据。`);
 const saves=sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${memoryCid}' AND tool_name='manage_personal_asset' AND state='succeeded'`).map(v=>v.data);
 const saved=saves.find(v=>v.kind==='memory'&&v.body.includes(memoryTopic)&&previousMemories.get(v.id)!==v.version);
 assert.ok(saved,'本次须生成或修订目标范围的正式记忆，不能借用旧记录');
 const memory=await until(async()=>{const list=(await request('/assets')).assets;return list.find(v=>v.id===saved.id&&v.version===saved.version&&v.state==='enabled'&&v.memory_index_state==='indexed');},'本次Mem0正式记忆与索引',60000);
 report.memory={id:memory.id,version:memory.version,index_state:memory.memory_index_state,topic:memoryTopic};await save();
 const recallCid=await create();const recalled=await ask(recallCid,`请检索我的个人记忆，说明我做${memoryTopic}的收入分析时默认用什么金额单位。现在不用查数据。`);
 const recalls=sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${recallCid}' AND tool_name='search_knowledge' AND state='succeeded'`).map(v=>v.data);
 assert.ok(recalls.some(v=>v.memory_retrieval==='mem0_authoritative'&&v.personal_memories?.some(m=>m.id===memory.id&&m.version===memory.version)),'Mem0本次召回应包含刚保存的正式版本');
 assert.ok(recalled.messages.some(v=>v.role==='assistant'&&v.committed&&v.text.includes('元')));report.recalls=recalls.map(v=>({retrieval:v.memory_retrieval,memories:v.personal_memories.map(m=>({id:m.id,version:m.version}))}));
 report.passed=true;
} catch(error) {report.error=error.message;throw error;}
finally {
 await stop();report.ledger_after=ledger();report.finished_at=new Date().toISOString();
 report.calls=sql(`SELECT JSON_OBJECT('id',a.id,'purpose',a.purpose,'state',a.state,'usage',a.usage_json,'actual_micros',a.actual_micros) FROM model_call_attempts a LEFT JOIN budget_scopes b ON b.id=a.budget_scope_id WHERE COALESCE(a.trial_id,JSON_UNQUOTE(JSON_EXTRACT(b.model_profile,'$.trial_id')))='${config.profile.trial_id}'`);
 await writeFile(directory+'/launcher.log',output);await save();await writeFile('.local/checks/skill-dogfood-real.json',JSON.stringify({passed:report.passed,evidence:directory+'/report.json',ledger_before:report.ledger_before,ledger_after:report.ledger_after,error:report.error},null,2));
 console.log(JSON.stringify({passed:report.passed,evidence:directory+'/report.json',ledger:report.ledger_after,error:report.error}));
}
