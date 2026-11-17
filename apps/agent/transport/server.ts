import { createServer } from 'node:http';
import { decodeContract } from '../../../packages/contracts/validate.ts';
import type { RunEnvelope, CancelRun } from '../../../packages/contracts/generated/boundary.ts';
import type { deliver, DeliveryStage } from '../session/deliver.ts';
import { rustRequestFailure } from './client.ts';

function failureCode(error: unknown): string {
  // 只放行同源契约可解释的分类；超时/限流/重试耗尽/用量未知/取消等原义不被吞并成unexpected。
  const allowed = new Set([
    'model_unavailable', 'model_secret_unavailable', 'model_credential_required',
    'provider_configuration_invalid', 'provider_model_unavailable', 'model_capacity_invalid',
    'invalid_skill_resource', 'invalid_skill_receipt', 'model_run_failed',
    'model_request_failed', 'model_input_limit', 'model_output_limit',
    'request_too_large: model_input_limit', 'model_budget_exhausted',
    'model_timeout', 'model_auth_failed', 'model_rate_limited', 'model_quota_exhausted',
    'model_service_unavailable', 'model_network_error', 'model_retry_exhausted',
    'model_usage_unknown', 'model_usage_invalid', 'model_limits_exceeded',
    'model_finalize_unconfirmed', 'model_receipt_unknown', 'provider_transport_rejected',
    'provider_parameters_changed', 'provider_payload_invalid',
    'run_cancelled', 'stale_context', 'checkpoint_conflict', 'budget_exhausted',
    'answer_sources_required', 'no_final_output', 'invalid_tool_arguments', 'unavailable',
  ]);
  if (!(error instanceof Error)) return 'unexpected_error';
  const code = (error as Error & {code?: unknown}).code;
  if (typeof code === 'string' && allowed.has(code)) return code;
  return allowed.has(error.message) ? error.message : 'unexpected_error';
}

export function createDeliveryServer(apiUrl:string,token:string,dispatch:typeof deliver,fault='') {
  const active=new Map<string,{run:RunEnvelope,controller:AbortController}>();
  return createServer(async(request,response)=>{
    let deliveryStage: DeliveryStage | 'delivery' = 'delivery';
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
      await dispatch(run,apiUrl,token,fault,controller.signal,stage=>{deliveryStage=stage;});response.writeHead(200).end('finished');
    }catch(error){
      const code=failureCode(error),host=rustRequestFailure(error);
      const errorKind=error instanceof Error&&['Error','TypeError','SyntaxError','TimeoutError','AbortError'].includes(error.name)?error.name:'other';
      console.error(JSON.stringify({event:'bridge_failed',run_id:run?.run_id??'invalid',
        message_id:run?.message_id??null,recovery_chain_id:run?.recovery_chain_id??null,
        stage:host?.path==='/internal/finish'?'finish':host?'host_request':deliveryStage,
        call_site:host?.path??'deliver.'+deliveryStage,
        code,error_kind:errorKind,path:host?.path??null,http_status:host?.status??null,
        elapsed_ms:host?.elapsedMs??null,reason:host?.reason??(code==='unexpected_error'?'other':code)}));
      // 失败码随响应体返回，worker据此区分确定性配置失败与可重试中断。
      response.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({code}));}
    finally{if(acquired&&run)active.delete(run.conversation_id);}
  });
}
