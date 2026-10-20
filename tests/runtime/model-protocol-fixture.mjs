import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
// 合成供应商只负责协议回执，真实Pi负责工具调用、续接与终态。
export async function modelProtocolFixture() {
  const requests=[],errors=[];let status=200,withUsage=true,holdResult=false,releaseResult,answerNext=false;
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);requests.push({path:req.url,body,key:req.headers['x-api-key']??req.headers.authorization});
      if(status!==200){res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({error:{type:'server_error',message:'synthetic temporary error'}}));return;}
      const path=new URL(req.url,'http://synthetic').pathname;
      const api=path.endsWith('/responses')?'responses':path.endsWith('/v1/messages')?'anthropic':'completions';
      const inputs=body.messages??body.input;
      const last=inputs.at(-1);
      const finished=last?.role==='tool'||last?.type==='function_call_output'||last?.content?.some?.(p=>p.type==='tool_result');
      if(holdResult&&finished){holdResult=false;await new Promise(resolve=>releaseResult=resolve);}
      const tool=body.tools?.length&&!finished&&!answerNext;answerNext=false;
      const name='update_analysis_task',args={action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]},id='call_'+randomUUID().replaceAll('-','');
      const text='合成模型已完成本轮调查并保留会话。';
      res.writeHead(200,{'content-type':'text/event-stream'});
      const emit=(value,event)=>res.write((event?'event: '+event+'\n':'')+'data: '+JSON.stringify(value)+'\n\n');
      if(api==='completions') {
        const chunk=part=>emit({id,object:'chat.completion.chunk',created:1,model:body.model,...part});
        chunk({choices:[{index:0,delta:{role:'assistant',...(tool?{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:text})},finish_reason:null}]});
        chunk({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]});
        if(withUsage)chunk({choices:[],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125,prompt_tokens_details:{cached_tokens:20}}});
        res.end('data: [DONE]\n\n');
      }else if(api==='responses') {
        const item=tool?{type:'function_call',id,call_id:id,name,arguments:JSON.stringify(args),status:'completed'}:{type:'message',id,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
        emit({type:'response.created',response:{id:'resp_'+id,status:'in_progress',output:[]}});
        emit({type:'response.output_item.added',output_index:0,item:{...item,...(tool?{arguments:''}:{content:[]})}});
        if(!tool)emit({type:'response.output_text.delta',item_id:id,output_index:0,content_index:0,delta:text});
        emit({type:'response.output_item.done',output_index:0,item});
        emit({type:'response.completed',response:{id:'resp_'+id,status:'completed',output:[item],...(withUsage?{usage:{input_tokens:100,output_tokens:25,total_tokens:125,input_tokens_details:{cached_tokens:20}}}:{})}});res.end();
      }else {
        const send=event=>emit(event,event.type);
        send({type:'message_start',message:{id,type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,...(withUsage?{usage:{input_tokens:70,output_tokens:0,cache_read_input_tokens:20,cache_creation_input_tokens:10}}:{})}});
        send({type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id,name,input:{}}:{type:'text',text:''}});
        send({type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text}});
        send({type:'content_block_stop',index:0});
        send({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},...(withUsage?{usage:{output_tokens:25}}:{})});
        send({type:'message_stop'});res.end();
      }
    }catch(error){errors.push(error.message);res.writeHead(500).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,requests,errors,setStatus(value){status=value;},setUsage(value){withUsage=value;},holdAfterTool(){holdResult=true;},answerNext(){answerNext=true;},blocked(){return !!releaseResult;},release(){releaseResult?.();releaseResult=undefined;},async close(){releaseResult?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
