import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';

// 每个数据库场景独立；旧结构迁移必须从空库run_to，不能继承前例的当前结构。
for (const name of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_MODEL_PROFILE',
  'DATA_AGENT_MODEL_FAULT','DATABASE_URL','DATA_AGENT_DATABASE_URL']) delete process.env[name];
const filter = process.argv.find(value => value.startsWith('--filter='))?.slice(9);
if (filter) assert.match(filter, /^[a-z0-9_]+$/);
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? 'run';
assert.match(label, /^[a-z0-9-]+$/);
const dockerContext = process.env.DATA_AGENT_DOCKER_CONTEXT || (process.platform === 'darwin' ? 'colima-data-agent' : 'default');
const container = execFileSync('docker', ['--context',dockerContext,'ps','--filter',
  'label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql',
  '--format','{{.ID}}'], {encoding:'utf8'}).trim();
assert.match(container, /^[a-f0-9]+$/);
const prefix = 'data_agent_test_' + randomBytes(8).toString('hex');
const cases = [
  'delivery_preparation_longer_than_ttl_does_not_burn_an_undispatched_attempt',
  'delivery_preparation_maintains_claim_while_waiting_for_conversation_lock',
  'historical_receipts_keep_identity_when_recovery_uses_current_tools',
  'fresh_messages_use_current_tools_independent_of_inherited_configuration',
  'registered_legacy_decisions_complete_within_contract_two_without_downgrading_new_state',
  'run_version_is_frozen_across_process_recovery',
].filter(name => !filter || name.includes(filter));
const databases = Object.fromEntries(cases.map((name,index) => [name,prefix+'_'+index]));
const sql = query => execFileSync('docker', ['--context',dockerContext,'exec','-i',container,
  'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--skip-column-names'],
  {input:query, encoding:'utf8', stdio:['pipe','pipe','pipe']});
const command = ['test','--offline','--locked','-p','data-agent','--test','tool_contract_version',
  ...(filter ? [filter] : []),'--','--include-ignored','--skip','delivery_process','--test-threads=1','--nocapture'];
await mkdir('.local/checks', {recursive:true});
const name = 'tool-contract-version-' + label + '-' + Date.now();
let passed = false, output = '', code = null, signal = null;
const created=[];
try {
  for(const database of Object.values(databases)){
    sql('CREATE DATABASE ' + database + ';');created.push(database);
    sql('GRANT ALL ON ' + database + '.* TO data_agent;');
  }
  const password = (await readFile('.local/infra/mysql-app-password', 'utf8')).trim();
  const urls = Object.fromEntries(Object.entries(databases).map(([name,database]) =>
    [name,'mysql://data_agent:' + encodeURIComponent(password) + '@127.0.0.1:13306/' + database]));
  const env = {...process.env, PI_OFFLINE:'1', DATA_AGENT_PROVIDER_TEST:'1', DATA_AGENT_DIAGNOSTICS:'1',
    DATA_AGENT_CONTRACT_DATABASES:JSON.stringify(urls)};
  const result = await new Promise((resolve, reject) => {
    const child = spawn(homedir() + '/.cargo/bin/cargo', command, {env, stdio:['ignore','pipe','pipe']});
    child.stdout.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
    child.stderr.on('data', chunk => {output += chunk; process.stderr.write(chunk);});
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  ({code, signal} = result);
  assert.equal(code, 0, '真实旧结构迁移和跨进程合同恢复必须完整通过');
  assert.equal(signal, null);
  assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
  assert.doesNotMatch(output, /running 0 tests/);
  if (!filter) assert.match(output, /test result: ok\. 7 passed; 0 failed/);
  passed = true;
} finally {
  for(const database of created)sql('DROP DATABASE ' + database + ';');
  await writeFile('.local/checks/' + name + '.log', output, {flag:'wx'});
  const report = {passed, code, signal, command:['cargo', ...command], officialRequests:0,
    storage:'real per-case isolated MySQL', model:'not_called', databases,
    log:'.local/checks/' + name + '.log'};
  await writeFile('.local/checks/' + name + '.json', JSON.stringify(report, null, 2) + '\n', {flag:'wx'});
  console.log(JSON.stringify(report));
}
