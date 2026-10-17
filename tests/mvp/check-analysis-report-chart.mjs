import assert from 'node:assert/strict';
import {decimalChartScale} from '../../apps/web/src/features/workbench/analysis-report-chart.ts';

const exact=['9007199254740993.01','9007199254740993.02','9007199254740993.03'];
assert.deepEqual(decimalChartScale(exact,false).positions,[0,0.5,1]);
assert.deepEqual(exact,['9007199254740993.01','9007199254740993.02','9007199254740993.03']);
const signed=decimalChartScale(['-0.01',null,'0.00','0.03']);
assert.deepEqual(signed.positions,[0,null,0.25,1]);assert.equal(signed.zero,0.25);
assert.deepEqual(decimalChartScale(['0','-0.00']).positions,[0.5,0.5]);
const months=Array.from({length:13},(_,index)=>String(index));
assert.equal(decimalChartScale(months).positions.length,13);
assert.equal(decimalChartScale(months).positions[12],1);
assert.equal(decimalChartScale([]),null);assert.equal(decimalChartScale([null,null]),null);
for(const invalid of ['NaN','Infinity','1e99999','1e-8','01','+1','.1','1.','1'.repeat(257),'0.'+'0'.repeat(255)])assert.equal(decimalChartScale([invalid]),null,invalid.slice(0,20));
const huge=decimalChartScale(['-'+'9'.repeat(250),'0','9'.repeat(250)]);
assert.deepEqual(huge.positions,[0,0.5,1]);
console.log(JSON.stringify({passed:true,checks:['大金额相邻分值保留差异与原文本','负数/零/NULL分别处理','13个点不截前10行','非法及超256字小数明确不可绘图','有界坐标支持250位整数'],officialRequests:0}));
