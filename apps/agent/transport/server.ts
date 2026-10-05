import { createServer } from 'node:http';
import { decodeContract } from '../../../packages/contracts/validate.ts';
import type { RunEnvelope, CancelRun } from '../../../packages/contracts/generated/boundary.ts';
import type { deliver } from '../session/deliver.ts';

export function createDeliveryServer(apiUrl:string,token:string,dispatch:typeof deliver,fault='') {
  const active=new Map<string,{run:RunEnvelope,controller:AbortController}>();
  return createServer(async(request,response)=>{
    if(request.url==='/health'&&request.method==='GET'){response.end('ok');return;}
    if(request.headers.authorization!=='Bearer '+token){console.error('bridge_auth_rejected');response.writeHead(401).end();return;}
    if(request.method!=='POST'||!['/resume-and-deliver','/cancel-run'].includes(request.url??'')){response.writeHead(404).end();return;}
    let run:RunEnvelope|undefined;let acquired=false;
    try{
      const chunks:Buffer[]=[];let receivedBytes=0;
      for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);receivedBytes+=bytes.length;if(receivedBytes>512*1024)throw new Error('payload too large');chunks.push(bytes);}
      const text=Buffer.concat(chunks,receivedBytes).toString('utf8');
      if(request.url==='/cancel-run'){
        const input=decodeContract<CancelRun>('CancelRun',JSON.parse(text));
        const entry=[...active.values()].find(e=>e.run.run_id===input.run_id&&e.run.lease_epoch===input.lease_epoch);
        entry?.controller.abort();response.writeHead(200).end('cancel_notified');return;
      }
      run=decodeContract<RunEnvelope>('RunEnvelope',JSON.parse(text));
      if(active.has(run.conversation_id)){response.writeHead(409).end();return;}
      const controller=new AbortController();active.set(run.conversation_id,{run,controller});acquired=true;
      await dispatch(run,apiUrl,token,fault,controller.signal);response.writeHead(200).end('finished');
    }catch(error){if(process.env.DATA_AGENT_DIAGNOSTICS==='1'&&!process.env.DEEPSEEK_API_KEY)console.error('bridge_diagnostic '+(error instanceof Error?error.message.replaceAll(token,'[redacted]'):'unknown'));console.error('bridge_failed run='+ (run?.run_id??'invalid'));response.writeHead(500).end('delivery_failed');}
    finally{if(acquired&&run)active.delete(run.conversation_id);}
  });
}
