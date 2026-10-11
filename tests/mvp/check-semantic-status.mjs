import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness} from './harness.mjs';
import {ok} from './skill-fixtures.mjs';
import {knowledgeEntryStatus} from '../../apps/web/src/shared/knowledge-labels.ts';

const base={entry_id:'body',path:'body',label:'正文',source_facts:{value:'设备测量定义'},suggestion:{},human_override:null,effective_value:'设备测量定义',review_state:'unverified'};
assert.equal(knowledgeEntryStatus(base).kind,'source');
assert.equal(knowledgeEntryStatus({...base,suggestion:{value:'整理测量定义'}}).kind,'model');
assert.equal(knowledgeEntryStatus({...base,human_override:{value:'人工定义'},review_state:'confirmed'}).kind,'human');
assert.equal(knowledgeEntryStatus({...base,human_override:{value:'保留定义'},review_state:'needs_review'}).kind,'review');
assert.equal(knowledgeEntryStatus({...base,review_state:'confirmed'}).kind,'source');
const output='.local/product-repairs';await mkdir(output,{recursive:true});
const h=await harness({web:true,startWorker:false});const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:820}});let passed=false;const checks=[];
try {
  const doc=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成测量单位指南',body:'# 合成测量单位指南\n\n## 测量范围\n仅解释设备读数，温度单位由对应传感器定义。\n\n## 例外\n未标注单位时先补充资料。',related_ids:[]}));
  await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();await page.getByLabel('你的数据问题').waitFor();
  let fixture;
  // 仅替换已合法读取对象的展示状态，验证前端区分；不将夹具冒充模型预填或权限验证。
  await page.route('**/api/knowledge/**',async route=>{
    const response=await route.fetch();
    if(route.request().method()!=='GET'||!response.ok()||!fixture)return route.fulfill({response});
    const value=await response.json();
    const patch=object=>{if(object.id===doc.id)object.entries=object.entries.map(entry=>({...entry,...fixture}));};
    if(value.parts)value.parts.forEach(patch);else patch(value);
    await route.fulfill({response,json:value});
  });
  const cases=[
    ['source',{human_override:null,suggestion:{},review_state:'unverified'},'来源资料'],
    ['model',{human_override:null,suggestion:{value:'模型整理测量范围'},review_state:'unverified'},'模型整理 · 尚未人工维护'],
    ['human',null,'人工维护'],
    ['review',{review_state:'needs_review'},'来源变化，待复核'],
  ];
  for(const [name,state,label] of cases){
    fixture=state;
    await page.goto(h.url+'/#knowledge?'+new URLSearchParams({object:doc.id,scope:'documents',tab:'概览'}));await page.reload();
    const reader=page.locator('.document-reader');await reader.getByRole('heading',{name:doc.name,exact:true}).waitFor();
    await reader.getByLabel('内容维护状态').getByText(label,{exact:true}).waitFor();
    assert.equal(await page.getByText('已验证正确',{exact:true}).count(),0);
    await page.screenshot({path:output+'/semantics-'+name+'.png'});
  }
  fixture=null;await page.reload();await page.getByRole('button',{name:'编辑文档',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('文档正文').fill('所有有效测量均需保留原单位。');await dialog.getByRole('button',{name:'保存文档',exact:true}).click();await dialog.waitFor({state:'detached'});
  assert.equal(ok(await h.request('/knowledge/'+doc.id)).entries[0].effective_value,'所有有效测量均需保留原单位。');
  await page.locator('.document-reader').getByLabel('内容维护状态').getByText('人工维护',{exact:true}).waitFor();
  checks.push('4类维护状态在整篇文档准确展示；人工保存仍走原接口，未声称业务验证通过');
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile(output+'/semantic-status.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await browser.close();await h.close();}
