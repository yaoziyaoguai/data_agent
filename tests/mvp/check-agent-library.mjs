import {execFileSync, spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness} from './harness.mjs';
import {seedRawAllowedSources} from './source-recall-fixtures.mjs';

// 数据库单测需要隔离MySQL及一个已完成的Pi运行，复用正式测试夹具。
const h = await harness({capture:true});
try {
  const cid = await h.create();
  const run = await h.capture(cid, '解释合成订单表的字段');
  await h.pauseWorker();
  await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(run.run_id);
  seedRawAllowedSources(h);
  execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib'], {
    env:{...h.env, DATA_AGENT_TEST_CONVERSATION_ID:cid}, stdio:'inherit',
  });
} finally {
  await h.close();
}
// raw集成反例依赖专用Milvus和父Node协议代理；关闭前一harness后串行运行正式入口。
await new Promise((resolve,reject) => {
  const child = spawn(process.execPath, ['tests/mvp/check-source-recall.mjs'], {stdio:'inherit'});
  child.once('error',reject);
  child.once('close',code => code === 0 ? resolve() : reject(new Error('source recall exited '+code)));
});
console.log(JSON.stringify({passed:true,scope:'all data-agent library tests with isolated MySQL and completed mock Pi run, followed by raw integration with dedicated Milvus',officialRequests:0}));
