import assert from 'node:assert/strict';
import {fork, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {harness, until} from '../mvp/harness.mjs';

if (process.argv.includes('--child')) {
  const h = await harness({capture:true, startWorker:false});
  const pids = execFileSync('pgrep', ['-P', String(process.pid)], {encoding:'utf8'}).trim().split('\n').map(Number);
  process.send({database:new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1), pids});
} else {
  const container = execFileSync('docker', ['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'], {encoding:'utf8'}).trim();
  assert.match(container, /^[a-f0-9]+$/);
  const sql = query => execFileSync('docker', ['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--skip-column-names'], {input:query,encoding:'utf8'}).trim();
  const alive = pid => {try {process.kill(pid,0); return true;} catch {return false;}};
  const checks = []; let passed = false;
  try {
    for (const signal of ['SIGTERM','SIGINT']) {
      const child = fork(fileURLToPath(import.meta.url), ['--child'], {stdio:['ignore','ignore','pipe','ipc']});
      let resource, exited, errors = '';
      child.stderr.on('data', data => errors += data);
      const exit = once(child, 'exit').then(value => {exited=value; return value;});
      child.on('message', message => {resource=message;});
      try {
        await until(() => {assert.ok(!exited,errors);return resource;}, '隔离harness启动',60000);
        assert.match(resource.database, /^data_agent_test_[a-f0-9]+$/);
        child.kill(signal);
        await until(() => exited, 'harness中断后清理并退出',15000);
        assert.equal(sql(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${resource.database}';`), '0', '中断必须移除本次专用测试库');
        assert.ok(resource.pids.every(pid => !alive(pid)), '中断必须结束本次子进程');
        assert.deepEqual(await exit, [signal==='SIGTERM'?143:130,null]);
        checks.push(`${signal}退出保留失败码并清理自身进程和专用库`);
      } finally {
        if (!exited) child.kill('SIGKILL');
        // RED阶段的遗留仅按本测试实际创建的身份回收，不扫描或删除其他测试资源。
        if (resource) {
          for (const pid of resource.pids) if (alive(pid)) process.kill(pid,'SIGTERM');
          sql(`DROP DATABASE IF EXISTS ${resource.database};`);
        }
      }
    }
    passed = true;
  } finally {
    await writeFile('.local/checks/harness-cleanup.json', JSON.stringify({passed,checks,officialRequests:0},null,2));
  }
  console.log(JSON.stringify({passed,checks,officialRequests:0}));
}
