import {execFileSync, spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness} from './harness.mjs';
import {seedRawAllowedSources} from './source-recall-fixtures.mjs';

// 数据库单测需要隔离MySQL及一个已完成的Pi运行，复用正式测试夹具。
// 此dense用例由下方既有专用Milvus/父Node协议入口执行，最后核实际通过记录。
const vectorTest = 'use_cases::source_limits::tests::synchronized_document_recalls_its_own_windows_without_upstream_access';
const h = await harness({capture:true});
try {
  const cid = await h.create();
  const run = await h.capture(cid, '解释合成订单表的字段');
  await h.pauseWorker();
  await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(run.run_id);
  seedRawAllowedSources(h);
  execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib','--','--skip',vectorTest], {
    env:{...h.env, DATA_AGENT_TEST_CONVERSATION_ID:cid}, stdio:'inherit',
  });
} finally {
  await h.close();
}
// raw集成反例依赖专用Milvus和父Node协议代理；关闭前一harness后串行运行正式入口。
await new Promise((resolve,reject) => {
  let output = '';
  const child = spawn(process.execPath, ['tests/mvp/check-source-recall.mjs'], {stdio:['ignore','pipe','inherit']});
  child.stdout.on('data',chunk => {output += chunk; process.stdout.write(chunk);});
  child.once('error',reject);
  child.once('close',code => {
    if (code !== 0) {reject(new Error('source recall exited '+code)); return;}
    if (!output.includes('test '+vectorTest+' ... ok')) {
      reject(new Error('dedicated Milvus stage did not execute '+vectorTest)); return;
    }
    resolve();
  });
});
console.log(JSON.stringify({passed:true,scope:'all data-agent library tests with isolated MySQL and completed mock Pi run, followed by raw integration with dedicated Milvus',officialRequests:0}));
