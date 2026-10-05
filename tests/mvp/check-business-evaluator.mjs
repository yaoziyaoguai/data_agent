import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const cases=JSON.parse(await readFile('docs/sources/evaluation/cases.json','utf8')).cases;
const evaluate=value=>JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify(value),encoding:'utf8'}));
for(const c of cases){
 const result=evaluate({case_id:c.id,sql:await readFile('docs/sources/evaluation/'+c.sql_file,'utf8')});
 assert.equal(result.passed,true,c.id);assert.deepEqual(result.rows,c.expected_rows,c.id+'固定种子独立数值保持');
}
const where="FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z'";
const known='COUNT(DISTINCT customer_id) AS known_customer_count';
const anonymousOrders='COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END) AS anonymous_orders';
const anonymousLines='SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS anonymous_lines';
const anonymousPresence='SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END)>0 AS has_unknown_customer';
for(const columns of [[known,anonymousOrders,anonymousLines],[anonymousLines,known,anonymousOrders],[known,anonymousOrders],[known,anonymousOrders,anonymousPresence]]){
 const result=evaluate({case_id:'Q02',sql:'SELECT '+columns.join(',')+' '+where});
 assert.equal(result.passed,true,'主指标和匿名边界逐列核算');assert.equal(result.data_variations.length,7);
}
const moneyRatio='SUM(refunded_amount_cents)*1.0/NULLIF(SUM(paid_amount_cents),0) AS refund_amount_ratio';
for(const columns of [[moneyRatio],['SUM(refunded_amount_cents) AS refunded_amount_cents','SUM(paid_amount_cents) AS paid_amount_cents',moneyRatio],[moneyRatio,'SUM(paid_amount_cents) AS paid_amount_cents']])assert.equal(evaluate({case_id:'Q05',sql:'SELECT '+columns.join(',')+' '+where}).passed,true,'金额比例可附独立核算的分子分母');
const wrong=[
 {case_id:'Q02',sql:"SELECT SUM(uv) FROM (SELECT COUNT(DISTINCT customer_id) AS uv FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-01-01T00:00:00Z' AND paid_at<'2026-02-01T00:00:00Z' GROUP BY DATE(paid_at))"},
 {case_id:'Q06',sql:"SELECT SUM(d.paid_amount_cents-d.refunded_amount_cents) FROM demo_order_detail d JOIN customer_tags t ON t.customer_id=d.customer_id WHERE d.is_test=0 AND d.paid_amount_cents>0 AND d.paid_at>='2026-01-01T00:00:00Z' AND d.paid_at<'2026-02-01T00:00:00Z' AND t.tag IN ('vip','newsletter')"},
 {case_id:'Q10',sql:'SELECT 0'},
 {case_id:'Q01',sql:'DELETE FROM demo_order_detail'},
 {case_id:'Q02',sql:'SELECT 5 AS known_customer_count, '+anonymousOrders+', '+anonymousLines+' '+where},
 {case_id:'Q02',sql:'SELECT '+known+', SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS anonymous_orders, COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END) AS anonymous_lines '+where},
 {case_id:'Q02',sql:'SELECT '+known+', COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END)+1 AS anonymous_orders '+where},
 {case_id:'Q02',sql:"SELECT COUNT(DISTINCT COALESCE(customer_id,'unknown')) AS known_customer_count "+where},
 {case_id:'Q02',sql:'SELECT 3 AS known_customer_count, 5 AS meaningless_column '+where},
 {case_id:'Q02',sql:'SELECT '+known+', 1 AS has_unknown_customer '+where},
 {case_id:'Q02',sql:'SELECT '+known+', SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS has_unknown_customer '+where},
 {case_id:'Q02',sql:'SELECT '+known+', (SELECT COUNT(*)>0 FROM demo_order_detail WHERE customer_id IS NULL) AS has_unknown_customer '+where},
 {case_id:'Q05',sql:'SELECT SUM(refunded_amount_cents)+1 AS refunded_amount_cents,'+moneyRatio+' '+where},
 {case_id:'Q05',sql:'SELECT SUM(paid_amount_cents) AS refunded_amount_cents, SUM(refunded_amount_cents) AS paid_amount_cents,'+moneyRatio+' '+where},
 {case_id:'Q05',sql:'SELECT 16000 AS misleading_column,'+moneyRatio+' '+where},
 {case_id:'Q05',sql:'SELECT 0.225 AS refund_amount_ratio'},
 ...['Q04','Q10'].map(case_id=>{
   const month=case_id==='Q10'?'03':'01',end=case_id==='Q10'?'04':'02';
   return {case_id,sql:`SELECT COUNT(DISTINCT CASE WHEN refunded_amount_cents>0 THEN order_id END)*1.0/NULLIF(COUNT(DISTINCT order_id),0) AS order_refund_rate FROM demo_order_detail WHERE is_test=0 AND paid_amount_cents>0 AND paid_at>='2026-${month}-01T00:00:00Z' AND paid_at<'2026-${end}-01T00:00:00Z'`};
 }),
];
for(const c of wrong)assert.equal(evaluate(c).passed,false,c.case_id+' adversarial');
for(const case_id of ['Q04','Q10']){
 const c=cases.find(c=>c.id===case_id);
 const result=evaluate({case_id,sql:await readFile('docs/sources/evaluation/'+c.sql_file,'utf8')});
 assert.equal(result.passed,true);assert.equal(result.data_variations.length,5);
 assert.ok(result.data_variations.some(v=>v.name==='same_order_other_month_refund'&&v.passed));
 assert.ok(result.data_variations.some(v=>v.name==='refunded_order_outside_paid_set'&&v.passed));
}
const catalog=JSON.parse(await readFile('docs/sources/semantic-catalog.json','utf8'));
const refundMetric=catalog.objects.find(v=>v.id==='metric-refund_rate').entries.find(e=>e.path==='sql');
assert.equal(evaluate({case_id:'Q04',sql:refundMetric.effective_value,parameters:{start:'2026-01-01T00:00:00Z',end:'2026-02-01T00:00:00Z'}}).passed,true,'业务语义SQL也按分母订单集合核对全部退款行');
const netQuery="SELECT SUM(paid_amount_cents-refunded_amount_cents) AS net_cents "+where;
for(const channel of [null,'web','app','store']){
 const scoped=netQuery+(channel?" AND channel='"+channel+"'":'');
 const result=evaluate({case_id:'net_revenue_scope',channel,sql:scoped});
 assert.equal(result.passed,true);assert.equal(result.data_variations.length,5);
 if(channel)assert.equal(evaluate({case_id:'net_revenue_scope',channel,sql:netQuery+' AND channel=:channel',parameters:{channel}}).passed,true);
}
for(const sql of [netQuery,netQuery+" AND channel='app'",'SELECT 10000',netQuery+" AND channel='web' AND paid_amount_cents>1000"])
 assert.equal(evaluate({case_id:'net_revenue_scope',channel:'web',sql}).passed,false,'默认渠道由独立结果验证，不限制SQL参数写法');
const net='SUM(paid_amount_cents-refunded_amount_cents)';
const tagged=" AND EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=demo_order_detail.customer_id AND t.tag IN ('vip','newsletter'))";
for(const sample of [{case_id:'net_revenue_scope',channel:'app',filter:" AND channel='app'"},{case_id:'Q06',filter:tagged}]){
 for(const columns of [`${net} AS net_cents, ${net}/100.0 AS net_yuan`,`${net}/100.0 AS net_yuan`,`${net}/100.0 AS 净收入元, ${net} AS 净收入分`]){
  const result=evaluate({...sample,sql:'SELECT '+columns+' '+where+sample.filter});
  assert.equal(result.passed,true,'明确分/元列逐列独立核算');assert.equal(result.data_variations.length,5);
 }
 for(const columns of [`${net} AS net_cents, ${net} AS net_yuan`,`${net} AS net_cents, ${net}/1000.0 AS net_yuan`,`${net} AS net_cents, 1600 AS meaningless_column`,`1600 AS net_cents, 16.0 AS net_yuan`,`${net} AS net_cents, ${net}/100.0+0.01 AS net_yuan`,`${net}/100 AS net_yuan`,`ROUND(${net}/100.0,0) AS net_yuan`,`${net} AS net_yuan`,`${net} AS net_cents, SUM(paid_amount_cents)+1 AS paid_cents`,`${net} AS net_cents, SUM(paid_amount_cents) AS refund_cents`])
  assert.equal(evaluate({...sample,sql:'SELECT '+columns+' '+where+sample.filter}).passed,false,'错误换算/多余列/常数不能靠主指标正确而通过');
}
for(const sql of ['SELECT '+net+' AS net_cents '+where,'SELECT '+net+' AS net_cents '+where+tagged.replace("IN ('vip','newsletter')","= 'vip' AND t.tag = 'newsletter'"),'SELECT SUM(DISTINCT paid_amount_cents-refunded_amount_cents) AS net_cents '+where+tagged])
 assert.equal(evaluate({case_id:'Q06',sql}).passed,false,'标签客户集合不能丢失、改成AND或按金额值去重');
console.log(JSON.stringify({passed:true,referenceCases:cases.length,validBoundaryShapes:4,validRefundAmountShapes:3,validMoneyUnitShapes:6,rejectedMoneyUnitCounterexamples:20,rejectedTagCounterexamples:3,dataVariations:7,rejectedCounterexamples:wrong.length,officialRequests:0}));
