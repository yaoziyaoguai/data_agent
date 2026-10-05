import { createDeliveryServer } from './transport/server.ts';
import { deliver } from './session/deliver.ts';
const token = process.env.DATA_AGENT_INTERNAL_TOKEN;
const apiUrl = process.env.DATA_AGENT_API_URL;
const port = Number(process.env.DATA_AGENT_BRIDGE_PORT);
if (!token || token.length < 32 || !apiUrl || !port || process.env.DATA_AGENT_MODE !== 'development') throw new Error('explicit development configuration required');
const url = new URL(apiUrl);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('loopback API required');
createDeliveryServer(apiUrl,token,deliver,process.env.DATA_AGENT_FAULT ?? '').listen(port, '127.0.0.1', () => console.log('bridge_started port=' + port));
