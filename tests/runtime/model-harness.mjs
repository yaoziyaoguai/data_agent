import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import net from 'node:net';
import {createDeliveryServer} from '../../apps/agent/transport/server.ts';

export const trialProfile=trial_id=>({provider_id:'deepseek',model_id:'deepseek-flash',trial_id,price_version:'2026-10-04-peak-usd',input_limit:4096,output_limit:1024,trial_call_limit:6,trial_cost_micros:'50000'});
export async function until(action,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const v=await action();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw new Error('timeout: '+label);}
export async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});

// 本地协议测试创建临时数据库；官方小样保留自己的数据库与原试验ID供审计。
export async function modelHarness(profile,{database,keep=false}={}){
 const root=process.cwd();database??='data_agent_test_'+randomBytes(8).toString('hex');assert.match(database,/^data_agent_(test|trial)_[a-f0-9]+$/);
 const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();assert.match(container,/^[a-f0-9]+$/);
 const rawSql=q=>execFileSync('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--default-character-set=utf8mb4','--skip-column-names'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 rawSql('CREATE DATABASE IF NOT EXISTS '+database+'; GRANT ALL ON '+database+'.* TO data_agent;');
 const query=q=>{const v=rawSql('USE '+database+'; '+q);return v?v.split('\n').map(s=>JSON.parse(s)):[];};
 const apiPort=await freePort(),bridgePort=await freePort();const token=randomBytes(32).toString('hex'),alice=randomBytes(32).toString('hex'),bob=randomBytes(32).toString('hex');
 const password=(await readFile(root+'/.local/infra/mysql-app-password','utf8')).trim();
 const env={...process.env,PI_OFFLINE:'1',DATA_AGENT_MODE:'development',DATA_AGENT_DATABASE_URL:'mysql://data_agent:'+encodeURIComponent(password)+'@127.0.0.1:13306/'+database,DATA_AGENT_DEV_IDENTITIES:JSON.stringify({[alice]:'alice',[bob]:'bob'}),DATA_AGENT_INTERNAL_TOKEN:token,DATA_AGENT_API_PORT:String(apiPort),DATA_AGENT_API_URL:'http://127.0.0.1:'+apiPort,DATA_AGENT_BRIDGE_URL:'http://127.0.0.1:'+bridgePort,DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_MODEL_PROFILE:JSON.stringify(profile)};
 for(const k of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_FAULT','DATA_AGENT_MOCK_DELAY_MS'])delete env[k];
 const children=[];let logs='';
 const start=(path,args=[])=>{const c=spawn(path,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(c);c.stdout.on('data',v=>logs+=v);c.stderr.on('data',v=>logs+=v);return c;};
 let api;
 let dispatch=async()=>{throw new Error('dispatch not configured');};
 const bridge=createDeliveryServer(env.DATA_AGENT_API_URL,token,(...args)=>dispatch(...args));await new Promise(r=>bridge.listen(bridgePort,'127.0.0.1',r));
 const request=async(path,body,{user='alice',internal=false}={})=>{const res=await fetch(env.DATA_AGENT_API_URL+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(internal?token:user==='bob'?bob:alice),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:res.status,value:await res.json()};};
 async function setProfile(next){await stop(api);env.DATA_AGENT_MODEL_PROFILE=JSON.stringify(next);api=start('target/debug/data-agent-api');await until(async()=>{try{return(await fetch(env.DATA_AGENT_API_URL+'/health')).ok;}catch{return false;}},'api health');}
 await setProfile(profile);
 return {database,env,token,query,request,getLogs:()=>logs,setProfile,
  async run(text,execute){
   const cid=(await request('/conversations',{operation_id:randomUUID()})).value.conversation_id;
   const accepted=await request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text});assert.equal(accepted.status,200);
   let captured;const capture=run=>{captured=run;};let release;const ready=new Promise(r=>release=r);let done;const result=new Promise(r=>done=r);
   dispatch=async(run,url,tok,fault,signal)=>{capture(run);await ready;try{await execute?.(run,url,tok,fault,signal);done({ok:true});}catch{done({ok:false});}};
   const worker=start('target/debug/data-agent-worker');const run=await until(()=>captured,'worker run');await stop(worker);release();
   return {cid,run,result,accepted:accepted.value};
  },
  async web(){const port=await freePort();start('node',['node_modules/vite/bin/vite.js','apps/web','--config','apps/web/vite.config.ts','--port',String(port)]);const url='http://127.0.0.1:'+port;await until(async()=>{try{return(await fetch(url)).ok;}catch{return false;}},'web');return {url,alice};},
  async snapshot(cid){const r=await request('/conversations/'+cid+'/snapshot');assert.equal(r.status,200);return r.value;},
  async close(){for(const c of children.reverse())await stop(c);await new Promise(r=>bridge.close(r));if(!keep)rawSql('DROP DATABASE '+database+';');}
 };
}
