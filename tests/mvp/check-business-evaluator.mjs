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
const boundaryPresence=anonymousPresence.replace('has_unknown_customer','unknown_boundary_present');
assert.equal(evaluate({case_id:'Q02',sql:'SELECT '+known+', '+anonymousLines+', '+boundaryPresence+' '+where}).passed,true,'明确的unknown_boundary_present别名按匿名存在标志核算');
for(const columns of [known+', 1 AS unknown_boundary_present',known+', COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END) AS anonymous_lines, '+boundaryPresence,'COUNT(customer_id) AS known_customer_count, '+boundaryPresence,known+', '+anonymousPresence+', '+boundaryPresence])
 assert.equal(evaluate({case_id:'Q02',sql:'SELECT '+columns+' '+where}).passed,false,'存在标志别名不能绕过常数、粒度、去重或重复角色检查');
// §4.2/B1：形状未覆盖（无法自动判分）与已核算数值不符分开记录；原Q02失败SQL按独立合成数据保留原结果，不改列名不删变体。
const originalQ02Sql=`SELECT
  COUNT(DISTINCT customer_id) AS paying_customers_known,
  COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END) AS unknown_customer_orders,
  SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS unknown_customer_rows,
  COUNT(DISTINCT CASE WHEN customer_id IS NOT NULL THEN customer_id END)
    + CASE WHEN COUNT(DISTINCT CASE WHEN customer_id IS NULL THEN order_id END) > 0
           THEN 1 ELSE 0 END AS paying_customers_with_unknown_boundary
FROM demo_order_detail
WHERE is_test = 0
  AND paid_amount_cents > 0
  AND paid_at >= :start
  AND paid_at < :end`;
const originalQ02=evaluate({case_id:'Q02',sql:originalQ02Sql,parameters:{start:'2026-01-01T00:00:00Z',end:'2026-02-01T00:00:00Z'}});
assert.equal(originalQ02.passed,false,'原Q02失败SQL在独立判分中继续失败');
assert.equal(originalQ02.scoring,'cannot_autoscore_shape','第四列把未知折进总量属形状未覆盖，标无法自动判分；业务依据仍是原题、定义与表达式');
assert.equal(originalQ02.expected_rows,null);
assert.deepEqual(originalQ02.rows,[[5,1,1,6]],'独立合成数据上的原结果保持');
const unrecognizedAlias=evaluate({case_id:'Q02',sql:'SELECT COUNT(DISTINCT customer_id) AS monthly_active_buyers, COUNT(DISTINCT order_id) AS paid_orders '+where});
assert.equal(unrecognizedAlias.passed,false,'语义合法但别名未识别时不能自动推进为通过');
assert.equal(unrecognizedAlias.scoring,'cannot_autoscore_shape','别名未识别只代表无法自动判分，不自动归因为模型口径错误');
assert.equal(unrecognizedAlias.expected_rows,null);
assert.ok(unrecognizedAlias.data_variations.every(v=>v.expected_rows===null));
const numericMismatch=evaluate({case_id:'Q02',sql:'SELECT COUNT(DISTINCT customer_id)+1 AS known_customer_count '+where});
assert.equal(numericMismatch.passed,false);
assert.equal(numericMismatch.scoring,'compared','已核算的数值不符单独成类，与形状未覆盖区分');
assert.deepEqual(numericMismatch.expected_rows,[[5]]);
// 主指标可附整体订单/明细行作核对；仍按独立口径逐列核算，不能因正确主指标而忽略附列。
const overallColumns=[known,'COUNT(DISTINCT order_id) AS paid_orders','COUNT(*) AS paid_order_lines'];
const overall=evaluate({case_id:'Q02',sql:'SELECT '+overallColumns.join(', ')+' '+where});
assert.equal(overall.passed,true,'客户汇总附整体订单数/订单行数也必须独立核算');
assert.deepEqual(overall.expected_rows,[[5,8,10]]);
assert.ok(overall.data_variations.every(v=>v.passed));
const overallWithBoundary=[anonymousPresence,overallColumns[2],known,anonymousOrders,overallColumns[1],anonymousLines];
assert.equal(evaluate({case_id:'Q02',sql:'SELECT '+overallWithBoundary.join(', ')+' '+where}).passed,true,'整体指标与匿名边界可换列序组合');
for(const columns of [
 [known,'COUNT(*) AS paid_orders'],
 [known,'COUNT(DISTINCT order_id) AS paid_order_lines'],
 [known,'8 AS paid_orders'],
 [known,'10 AS paid_order_lines'],
 [known,anonymousLines,'COUNT(*) AS paid_order_lines', '1 AS has_unknown_customer'],
 [known,overallColumns[1],'COUNT(DISTINCT order_id) AS total_orders'],
 [known,overallColumns[2],'COUNT(*) AS meaningless_column'],
])assert.equal(evaluate({case_id:'Q02',sql:'SELECT '+columns.join(', ')+' '+where}).passed,false,'整体附列仍拒绝错粒度、常数、错误匿名边界、重复或未知角色');
// 分组标签是维度，不能与客户去重数占用同一列角色；参考仍来自独立合成数据。
const groupedCustomers=`SELECT CASE WHEN customer_id IS NULL THEN 'anonymous' ELSE 'known' END AS 客户分组,
 COUNT(DISTINCT customer_id) AS 支付客户数 ${where} GROUP BY customer_id IS NULL`;
const grouped=evaluate({case_id:'Q02',sql:groupedCustomers});
assert.equal(grouped.passed,true,'按已知/匿名客户分组也必须独立核算，不能把分组列当计数');
assert.deepEqual(grouped.expected_rows,[['known',5],['anonymous',0]]);
const customerGroup="CASE WHEN customer_id IS NULL THEN '未知客户(匿名)' ELSE '已知客户' END AS customer_category";
const groupedMetrics='COUNT(DISTINCT customer_id) AS monthly_customer_uv, COUNT(DISTINCT order_id) AS paying_orders, COUNT(*) AS paying_lines';
const groupedSql=`SELECT ${customerGroup}, ${groupedMetrics} ${where} GROUP BY customer_id IS NULL`;
const detailedGroup=evaluate({case_id:'Q02',sql:groupedSql});
assert.equal(detailedGroup.passed,true,'分组的客户、订单和明细行数分别核算');
assert.deepEqual(detailedGroup.expected_rows,[['known',5,7,9],['anonymous',0,1,1]]);
assert.equal(detailedGroup.data_variations.length,7);
assert.ok(detailedGroup.data_variations.every(v=>v.passed));
assert.equal(evaluate({case_id:'Q02',sql:`SELECT ${groupedMetrics}, ${customerGroup.replace('customer_category','客户类型')} ${where} GROUP BY customer_id IS NULL ORDER BY paying_lines DESC`}).passed,true,'列序、行序与中英文角色名不限定为某题输出');
const compoundLineNames=['paid_order_lines','order_line_count','支付订单行数'];
for(const name of compoundLineNames){
 const wrongGrain=`SELECT ${customerGroup}, COUNT(DISTINCT customer_id) AS paying_customers, COUNT(DISTINCT order_id) AS ${name} ${where} GROUP BY customer_id IS NULL`;
 assert.equal(evaluate({case_id:'Q02',sql:wrongGrain}).passed,false,'订单行是行粒度，订单数不能因复合列名被接受：'+name);
 assert.equal(evaluate({case_id:'Q02',sql:groupedSql.replace('AS paying_lines','AS '+name)}).passed,true,'复合订单行列名应与订单数区分：'+name);
}
assert.equal(evaluate({case_id:'Q02',sql:'SELECT '+known+', '+anonymousLines.replace('anonymous_lines','anonymous_order_lines')+' '+where}).passed,true,'匿名订单行也按明细行核算');
const invalidGroups=[
 groupedSql.replace('COUNT(DISTINCT customer_id)','5'),
 groupedSql.replace('COUNT(DISTINCT customer_id)',"COUNT(DISTINCT COALESCE(customer_id,'anonymous'))"),
 groupedSql.replace('COUNT(DISTINCT order_id)','COUNT(*)'),
 groupedSql.replace('COUNT(*) AS paying_lines','COUNT(DISTINCT order_id) AS paying_lines'),
 groupedSql.replace('GROUP BY customer_id IS NULL','AND customer_id IS NOT NULL GROUP BY customer_id IS NULL'),
 groupedSql.replace("THEN '未知客户(匿名)' ELSE '已知客户'","THEN '已知客户' ELSE '未知客户(匿名)'"),
 groupedSql+' UNION ALL '+groupedSql,
 groupedSql.replace('AS paying_orders','AS customer_count'),
 groupedSql.replace('AS paying_lines','AS meaningless_column'),
];
for(const sql of invalidGroups)assert.equal(evaluate({case_id:'Q02',sql}).passed,false,'分组不能绕过去重、匿名边界、粒度、常数或重复角色核验');
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
console.log(JSON.stringify({passed:true,referenceCases:cases.length,validBoundaryShapes:4,validOverallCustomerShapes:2,rejectedOverallCustomerCounterexamples:7,validCustomerGroupShapes:3,compoundLineNames:compoundLineNames.length,rejectedCustomerGroupCounterexamples:invalidGroups.length+compoundLineNames.length,validRefundAmountShapes:3,validMoneyUnitShapes:6,rejectedMoneyUnitCounterexamples:20,rejectedTagCounterexamples:3,dataVariations:7,rejectedCounterexamples:wrong.length,officialRequests:0}));
