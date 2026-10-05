"""只从合成知识允许列表建立示例语义，独立验收文件不作输入。"""
import json
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1];source=ROOT/'docs/sources';guide=(source/'business-guide.md').read_text();schema=(source/'schema.sql').read_text();etl=(source/'etl.sql').read_text();objects=[]
def entry(path,label,value,source_id='business-guide',location='正文'):
 return {'entry_id':path.replace('.','-'),'path':path,'label':label,'source_facts':{'value':value,'source_id':source_id,'version':'1','location':location,'complete':True},'suggestion':{'value':value,'method':'synthetic_reference','uncertainty':[]},'human_override':None,'effective_value':value,'review_state':'unverified'}
def add(ident,kind,name,entries,related=(),source_id='business-guide'):
 objects.append({'id':ident,'kind':kind,'name':name,'version':'1','state':'enabled','entries':entries,'related_ids':list(related),'source_id':source_id,'source_version':'1','updated_by':'synthetic-import'})
for match in re.finditer(r'CREATE TABLE (\w+)\s*\((.*?)\n\);',schema,re.S):
 table,ddl=match.groups();description={'demo_order_detail':'订单行明细；一行对应一个订单商品行，主键(order_id,line_id)。','raw_order_lines':'原始订单行；一行对应一个订单商品行。','raw_payments':'原始支付和退款事件；一行对应一个已分摊的资金事件。','dim_customers':'当前客户快照；没有购买时地区历史。','customer_tags':'客户标签；同一客户有多个标签，筛选使用EXISTS避免放大金额。'}[table]
 add('table-'+table,'table',table,[entry('description','表含义',description),entry('ddl','表结构',match.group(0),'schema','DDL'),entry('etl','加工SQL',etl if table=='demo_order_detail' else '该表为构造的来源表，不声明加工SQL。','etl','加工SQL')],source_id='schema')
for row in guide.splitlines():
 if row.startswith('| `'):
  parts=row.split('|');field=parts[1].strip().strip('`');desc=parts[3].strip()
  add('field-'+field,'field',field,[entry('meaning','字段含义',desc,'business-guide','第4节'),entry('type','字段类型',parts[2].strip(),'schema','DDL')],['table-demo_order_detail'])
metrics=[('net_revenue','支付归属净收入','净收入 收入 净收','SUM(paid_amount_cents - refunded_amount_cents)','5.1'),('paying_customers','月支付客户数','UV 支付客户 月客户','COUNT(DISTINCT customer_id)','5.2'),('refund_rate','订单退款率','退款率 订单退款比例','COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM demo_order_detail AS r WHERE r.order_id = demo_order_detail.order_id AND r.is_test = 0 AND r.refunded_amount_cents > 0) THEN order_id END) * 1.0 / NULLIF(COUNT(DISTINCT order_id), 0)','5.3')]
for ident,name,aliases,expr,section in metrics:
 body=re.search(r'### '+re.escape(section)+r'.*?(?=\n### |\n## |\Z)',guide,re.S).group(0)
 add('metric-'+ident,'metric',name,[entry('definition','指标口径',body,'business-guide','第'+section+'节'),entry('aliases','别名',aliases),entry('sql','计算SQL',f'SELECT {expr} AS {ident}\nFROM demo_order_detail\nWHERE is_test = 0 AND paid_amount_cents > 0\n  AND paid_at >= :start AND paid_at < :end;')],['table-demo_order_detail','field-paid_at','field-is_test'])
for i,match in enumerate(re.finditer(r'(?m)^## (.*?)\n(.*?)(?=^## |\Z)',guide,re.S),1):
 add('document-guide-'+str(i),'document',match[1],[entry('body','章节正文',match[2].strip(),'business-guide','第'+str(i)+'节')],['table-demo_order_detail'])
add('relationship-tags','relationship','客户标签关联',[entry('join','关联说明','demo_order_detail.customer_id -> customer_tags.customer_id，1:N，使用EXISTS或先去重标签客户，不能直接连接后聚合金额。')],['table-demo_order_detail','table-customer_tags'])
add('relationship-payments','relationship','订单行与支付事件',[entry('join','关联说明','raw_order_lines(order_id,line_id) -> raw_payments(order_id,line_id)，1:N；先按订单行汇总支付和退款再关联。')],['table-raw_order_lines','table-raw_payments'])
(source/'semantic-catalog.json').write_text(json.dumps({'synthetic':True,'objects':objects},ensure_ascii=False,indent=2)+'\n')
