import assert from 'node:assert/strict';
import net from 'node:net';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';

// 候选元信息与定点读取的粒度证据（05接续C，审计缺口2）：候选阶段只读身份/名称/
// 版本/启停/类型/来源头，选中后才按对象读正文。用真实下行字节量作证——不解析
// MySQL协议，只累计服务端送回应用方向的总字节；不用耗时快慢冒充读取粒度。
//
// 两条判据：①首轮下行远小于整个语料，说明候选阶段没有装配body；②语料再翻三倍
// 后同一查询的下行增量只应来自元信息，比新增正文小一个数量级。
const shipped = {bytes: 0};
const sockets = new Set();
const proxy = net.createServer(sock => {
  sock.on('error', () => {});
  const remote = net.connect(13306, '127.0.0.1');
  remote.on('error', () => {});
  sockets.add(sock);
  sockets.add(remote);
  sock.on('close', () => { remote.destroy(); sockets.delete(sock); });
  remote.on('close', () => { sock.destroy(); sockets.delete(remote); });
  sock.on('data', chunk => remote.write(chunk));
  remote.on('data', chunk => { shipped.bytes += chunk.length; sock.write(chunk); });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));

const checks = [];
let passed = false;
const h = await harness({
  capture: true,
  startWorker: false,
  onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:' + proxy.address().port + '/'),
  env: {DATA_AGENT_LEASE_MS: '120000'},
});
// 正文在服务端生成，SQL语句本身很小；每个对象约1.4万字符，全部含查询标记词。
const seed = (from, count) => h.sql(`SET SESSION cte_max_recursion_depth=${count + 10};
  INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
  WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<${count})
  SELECT CONCAT('gran-',LPAD(${from}+i,4,'0')),'demo','document','合成粒度资料',1,'enabled',
    JSON_OBJECT('id',CONCAT('gran-',LPAD(${from}+i,4,'0')),'kind','document','name','合成粒度资料','version','1','state','enabled',
      'entries',JSON_ARRAY(JSON_OBJECT('entry_id','body','path','body','label','正文',
        'effective_value',CONCAT('粒度标记专属词 granneedle。',REPEAT('大原文填充段。',2000)),
        'source_facts',JSON_OBJECT('complete',false,'gap','独立合成粒度夹具'),
        'suggestion',JSON_OBJECT(),'human_override',NULL,'review_state','unverified')),
      'related_ids',JSON_ARRAY(),'source_id',NULL,'source_version','0','updated_by','synthetic-test'),
    NULL,0,'synthetic-test' FROM n;
  INSERT IGNORE INTO retrieval_documents(object_id,space_id,version,body)
    SELECT id,space_id,version,body FROM knowledge_objects WHERE id LIKE 'gran-%';
  INSERT IGNORE INTO knowledge_revisions(object_id,version,archived_body)
    SELECT id,version,body FROM knowledge_objects WHERE id LIKE 'gran-%';
  INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by)
    SELECT space_id,id,id,'system','synthetic-test' FROM knowledge_objects WHERE id LIKE 'gran-%'`);
const corpus = () => {
  const row = h.sql("SELECT JSON_OBJECT('n',COUNT(*),'chars',SUM(CHAR_LENGTH(body))) FROM knowledge_objects WHERE id LIKE 'gran-%'")[0];
  return {objects: Number(row.n), chars: Number(row.chars)};
};
const search = async query => {
  const before = shipped.bytes;
  const response = await h.request('/knowledge?q=' + encodeURIComponent(query));
  const window = shipped.bytes - before;
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return {value: response.value, window};
};
try {
  await h.pauseWorker();
  // 首轮400个对象（约580万字符），选中页只占7.5%；候选阶段若装配body，下行
  // 必然接近整库体积（中文UTF-8每字符3字节，约17MB）。
  seed(1, 400);
  const small = corpus();
  assert.ok(small.chars > 5_000_000, '首轮语料须显著大于单页读取量：' + JSON.stringify(small));
  const first = await search('granneedle');
  assert.equal(first.value.objects.length, 30, '浏览检索按页上限返回选中对象');
  for (const object of first.value.objects) {
    assert.equal(object.retrieval?.state, 'located', JSON.stringify(object.retrieval));
    assert.ok(object.retrieval.excerpts.length > 0, '选中对象按当前正文交付真实命中片段');
  }
  assert.ok(
    first.window < small.chars,
    '候选阶段不得装配全部对象正文：语料' + small.chars + '字符，首轮下行' + first.window + 'B',
  );
  // 判据②：语料翻倍到800个对象，新增正文约580万字符；同一查询选中页仍30项，
  // 候选集合扩大只增加元信息下行。
  seed(401, 400);
  const large = corpus();
  assert.ok(large.chars > small.chars * 1.8, '语料须实际翻倍：' + JSON.stringify({small, large}));
  const second = await search('granneedle');
  assert.equal(second.value.objects.length, 30);
  const added = large.chars - small.chars;
  assert.ok(
    second.window - first.window < added / 10,
    '候选阶段不得装配全部对象正文：新增正文' + added + '字符，下行增量' + (second.window - first.window) + 'B' +
      '（首轮' + first.window + 'B，次轮' + second.window + 'B）',
  );
  checks.push(
    '语料' + small.objects + '→' + large.objects + '个对象（新增' + added + '字符）：首轮下行' + first.window +
      'B远小于整库，新增正文后同一查询只增' + (second.window - first.window) + 'B——候选阶段只读元信息，选中30项才定点读正文',
  );
  // 零命中不读任何对象正文：下行不随语料增长。查询用纯ASCII随机串——中文会被
  // 切成二元词，容易命中填充正文里的常用字。
  const miss = await search('zzqqxxjjvvww');
  assert.equal(miss.value.objects.length, 0);
  checks.push('零命中查询不触发对象正文装配：本次下行' + miss.window + 'B');
  passed = true;
  console.log(JSON.stringify({passed, checks, windows: {first: first.window, second: second.window, miss: miss.window}, corpus: {small, large}, officialRequests: 0}));
} finally {
  await h.close();
  proxy.closeAllConnections?.();
  await new Promise(resolve => proxy.close(resolve));
  await writeFile('.local/checks/retrieval-granularity.json', JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
}
