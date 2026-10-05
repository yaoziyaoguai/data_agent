import { defineConfig } from 'vite';
export default defineConfig({ server:{ host:'127.0.0.1',strictPort:true,proxy:{'/api':{target:process.env.DATA_AGENT_API_URL ?? 'http://127.0.0.1:8780',rewrite:path=>path.replace(/^\/api/,'')}}} });
