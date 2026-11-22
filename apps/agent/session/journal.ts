import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { constants, mkdirSync, lstatSync, chmodSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const directory=resolve(fileURLToPath(new URL('../../../.local/pi-sessions/',import.meta.url)));
const entryTypes=new Set(['message','model_change','thinking_level_change','usage','compaction','custom','custom_message','branch_summary','label','session_info','context_edit']);

function privateDirectory() {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('checkpoint_storage_invalid');
  chmodSync(directory,0o700);return directory;
}
function sessionPath(file:string) {
  if(!/^[A-Za-z0-9_-]{1,128}\.jsonl$/.test(file))throw new Error('checkpoint_storage_invalid');
  return join(privateDirectory(),file);
}
export function validateEntries(entries:unknown[],sessionId?:string,leaf?:string|null):FileEntry[] {
  const header=entries[0] as Record<string,unknown>|undefined;
  if(!header||header.type!=='session'||header.version!==3||typeof header.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(header.id)||(sessionId!==undefined&&header.id!==sessionId))throw new Error('checkpoint_storage_invalid');
  const seen=new Set<string>([header.id]);
  for(const entry of entries.slice(1)) {
    if(!entry||typeof entry!=='object')throw new Error('checkpoint_storage_invalid');
    const value=entry as Record<string,unknown>;
    if(typeof value.type!=='string'||!entryTypes.has(value.type)||typeof value.id!=='string'||seen.has(value.id)||(value.parentId!==null&&(typeof value.parentId!=='string'||value.parentId===header.id||!seen.has(value.parentId))))throw new Error('checkpoint_storage_invalid');
    seen.add(value.id);
  }
  if(leaf!==undefined&&leaf!==null&&(!seen.has(leaf)||leaf===header.id))throw new Error('checkpoint_leaf_unavailable');
  return entries as FileEntry[];
}
function openJournal(cwd:string,file:string,sessionId:string,leaf:string|null) {
  const path=sessionPath(file);
  if(!existsSync(path))throw new Error('checkpoint_storage_missing');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('checkpoint_storage_invalid');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let lineCount: number;
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(fd));
    if(!text.endsWith('\n'))throw new Error('checkpoint_storage_invalid');
    const lines=text.slice(0,-1).split('\n');
    // SDK 会跳过坏行并升级旧头部；先锁定持久格式，再核对它实际加载的条目数。
    validateEntries([JSON.parse(lines[0])],sessionId);
    lineCount=lines.length;
  }catch(error){
    if(error instanceof SyntaxError||error instanceof TypeError)throw new Error('checkpoint_storage_invalid');
    throw error;
  }finally{closeSync(fd);}
  const manager=SessionManager.open(path,dirname(path),cwd);
  const entries=[manager.getHeader(),...manager.getEntries()];
  if(entries.length!==lineCount)throw new Error('checkpoint_storage_invalid');
  const verified=validateEntries(entries,sessionId,leaf);
  if(leaf===null)manager.resetLeaf();else manager.branch(leaf);
  return {manager,entries:verified};
}
function syncJournal(path:string) {
  chmodSync(path,0o600);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{fsyncSync(fd);}finally{closeSync(fd);}
  const root=openSync(dirname(path),constants.O_RDONLY);
  try{fsyncSync(root);}finally{closeSync(root);}
}
export function createStoredSession(cwd:string) {
  return SessionManager.create(cwd,privateDirectory());
}
export function openStoredSession(cwd:string,file:string,sessionId:string,leaf:string|null) {
  return openJournal(cwd,file,sessionId,leaf).manager;
}
export function importStoredSession(cwd:string,entries:unknown[],leaf:string|null) {
  const valid=validateEntries(entries,undefined,leaf);
  const sessionId=String(valid[0].id),file=sessionId+'.jsonl',path=sessionPath(file);
  if(!existsSync(path)) {
    const temporary=path+'.'+randomUUID();
    try {
      writeFileSync(temporary,valid.map(entry=>JSON.stringify(entry)).join('\n')+'\n',{flag:'wx',mode:0o600});
      syncJournal(temporary);
      try{linkSync(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }finally{if(existsSync(temporary))unlinkSync(temporary);}
  }
  const {manager,entries:existing}=openJournal(cwd,file,sessionId,leaf);
  const byId=new Map(existing.map(entry=>[entry.id,entry]));
  if(valid.some(entry=>!isDeepStrictEqual(byId.get(entry.id),entry)))throw new Error('checkpoint_conflict');
  syncJournal(path);
  return manager;
}
export function storedReference(manager:SessionManager,verifyPersisted=false) {
  const file=manager.getSessionFile();
  if(!manager.isPersisted()||!file)return null;
  if(dirname(file)!==privateDirectory())throw new Error('checkpoint_storage_invalid');
  if(!existsSync(file)) {
    // Pi尚无user/assistant时不会创建文件；此时只导出很小的初始化状态。
    if(manager.getEntries().some(entry=>entry.type==='message'&&['user','assistant'].includes(entry.message.role)))throw new Error('checkpoint_storage_missing');
    return null;
  }
  // 正常运行由SDK同步追加；异常出口才核内存leaf是否实际落盘。
  if(verifyPersisted)openJournal(manager.getCwd(),basename(file),manager.getSessionId(),manager.getLeafId());
  syncJournal(file);
  return {kind:'pi_session' as const,file:basename(file),session_id:manager.getSessionId()};
}
