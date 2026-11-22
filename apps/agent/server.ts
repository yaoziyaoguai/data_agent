import { BlockList, isIP } from 'node:net';

const started = performance.now();
console.log('startup service=bridge stage=imports_started');
const { createDeliveryServer } = await import('./transport/server.ts');
const { deliver } = await import('./session/deliver.ts');
console.log('startup service=bridge stage=imports_ready elapsed_ms=' + Math.round(performance.now()-started));

const token = process.env.DATA_AGENT_INTERNAL_TOKEN;
const apiUrl = process.env.DATA_AGENT_API_URL;
const port = Number(process.env.DATA_AGENT_BRIDGE_PORT);
if (!token || token.length < 32 || !apiUrl || !port || process.env.DATA_AGENT_MODE !== 'development') {
  throw new Error('explicit development configuration required');
}

const url = new URL(apiUrl);
const apiHost = url.hostname.replace(/^\[(.+)\]$/, '$1');
const policy = (process.env.DATA_AGENT_HTTP_UPSTREAMS ?? 'localhost,127.0.0.0/8,::1').split(',');
const subnets = new BlockList();
const hosts = [];
for (const segment of policy) {
  const entry = segment.trim();
  if (!entry) continue;
  if (!entry.includes('/')) {
    hosts.push(entry.replace(/^\[(.+)\]$/, '$1').toLowerCase());
    continue;
  }
  const [network, prefix, extra] = entry.split('/');
  const version = isIP(network);
  if (!version || !/^\d+$/.test(prefix) || extra !== undefined) throw new Error('invalid API upstream subnet');
  subnets.addSubnet(network, Number(prefix), version === 4 ? 'ipv4' : 'ipv6');
}
const apiVersion = isIP(apiHost);
const allowed = hosts.includes(apiHost) ||
  (apiVersion !== 0 && subnets.check(apiHost, apiVersion === 4 ? 'ipv4' : 'ipv6'));
if (url.protocol !== 'http:' || url.username || url.password || !allowed) {
  throw new Error('permitted API upstream required');
}
const host = process.env.DATA_AGENT_BIND_HOST ?? '127.0.0.1';
createDeliveryServer(apiUrl, token, deliver, process.env.DATA_AGENT_FAULT ?? '').listen(port, host, () => {
  console.log('startup service=bridge stage=listening elapsed_ms=' + Math.round(performance.now() - started) + ' port=' + port);
});
