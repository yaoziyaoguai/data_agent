import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {syntheticAction} from '../../apps/agent/provider/synthetic-analysis.ts';

// 固定协议替身的行为回归，不评价真实模型；预期沿原S01/S02/S05与公开加工资料。
const receipt=(toolName,data)=>({role:'toolResult',toolName,content:[{type:'text',text:JSON.stringify(data)}]});
const previous=process.env.DATA_AGENT_DEMO_PROFILE;
process.env.DATA_AGENT_DEMO_PROFILE='retail';
try{
  for(const [text,metric] of [
    ['有vip或newsletter标签的客户在2026年1月贡献多少净收入？请避免标签一对多重复计入，给SQL等待确认',/净收入/],
    ['查2026年1月整月支付客户数，保留未知客户边界',/支付客户数/],
  ]){
    const run={text,tool_contract_version:2,workspace_context:{tasks:[],query_observations:[],memories:[]}};
    const selected=syntheticAction(run,{messages:[{role:'user',content:text},receipt('update_analysis_task',{task_id:null})]});
    assert.equal(selected.tool,'search_knowledge');assert.match(selected.args.query,metric,'明确度量不能被泛称客户覆盖');
  }
  const text='paid_amount_cents为0是什么意思';
  const content=await readFile('docs/sources/business-guide.md','utf8');
  const ref={object_id:'document-guide-3',version:'1',path:'body'};
  const sql=await readFile('docs/sources/etl.sql','utf8');
  const citation={source:{kind:'platform',id:'etl'},revision:'1',locator:{offset:0,length:[...sql].length}};
  const run={text,tool_contract_version:2,workspace_context:{tasks:[],query_observations:[],memories:[]}};
  for(const reads of [
    [receipt('search_knowledge',{hits:[{record_kind:'source_excerpt',citation,source_length:[...sql].length}]}),
      receipt('read_source',{source:citation.source,revision:citation.revision,text:sql,next_locator:null})],
    [receipt('search_knowledge',{hits:[{record_kind:'knowledge_entry',kind:'document',ref,definition:'上游与加工'}]}),
      receipt('read_knowledge',{items:[{kind:'knowledge',state:'ok',ref,content,content_page:{offset:0,total_chars:[...content].length,next_offset:null,complete:true}}]})],
  ]){
    const explanation=syntheticAction(run,{messages:[{role:'user',content:text},...reads,receipt('update_analysis_task',{task_id:null})]});
    assert.match(explanation.text,/COALESCE|缺失|填.?0/);assert.match(explanation.text,/不能.*(断言|仅凭)/);
  }
  console.log(JSON.stringify({passed:true,checks:4,officialRequests:0,databaseUsed:false}));
}finally{
  if(previous===undefined)delete process.env.DATA_AGENT_DEMO_PROFILE;else process.env.DATA_AGENT_DEMO_PROFILE=previous;
}
