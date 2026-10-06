export const targets=[
 ['fund_returns','订单行的成功退款累计金额；已分摊到商品行，以整数分保存。','顾客付的钱退回多少？'],
 ['buyers_monthly','月支付客户数：按整月customer_id去重，一个顾客多次购买只计一个，匿名客户不合并成统一客户。','同一顾客这个月买了三次应该算几位顾客？'],
 ['revenue_period','支付归属净收入用首次成功付款时刻paid_at归属月份，不用下单日期order_date，月底创建的订单可能于下个月付款。','月底创建的订单为何收入算下个月？'],
 ['buyer_labels','客户标签是一对多，一个客户有VIP及订阅标签。筛选这些标签用EXISTS避免同一订单金额重复累加。','为客户打多种标记会不会让订单金额被算两次？'],
];
export const topics=['库存快照，仓库与商品日粒度，数量为当前在库件数。','物流配送流水，一行一个包裹，配送路线与预计签收时刻。','对账批次摘要，一行一个结算批次，累计账单总额包含税费。','营销曝光记录，一行一次广告展示，点击记录单独保存。','客户基本信息，当前快照地区与注册时刻，没有购买历史地区。','退货申请记录，一行一次申请，审批尚未完成，不代表退款成功。'];
export const table=(id,comment)=>({id,name:id,platform_version:'1',comment,ddl:`CREATE TABLE ${id} (record_id INTEGER);`,columns:[{id:'record_id',name:'record_id',data_type:'INTEGER',nullable:false,comment:'记录技术编号'}],node:null});
