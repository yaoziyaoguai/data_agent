import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness} from './harness.mjs';

// 数据库单测需要隔离MySQL及一个已完成的Pi运行，复用正式测试夹具。
const h = await harness({capture:true});
try {
  const cid = await h.create();
  const run = await h.capture(cid, '解释合成订单表的字段');
  await h.pauseWorker();
  await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
  h.releaseRun(run.run_id);
  execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib'], {
    env:{...h.env, DATA_AGENT_TEST_CONVERSATION_ID:cid}, stdio:'inherit',
  });
  console.log(JSON.stringify({passed:true,scope:'all data-agent library tests with isolated MySQL and completed mock Pi run',officialRequests:0}));
} finally {
  await h.close();
}
