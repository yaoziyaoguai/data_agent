#!/usr/bin/env python3
"""检查当前单业务crate的模块依赖、SQL归属和事务出口；不是通用Rust解析器。"""
import argparse
from pathlib import Path
import re
import sys

OWNERS={
 'conversations':{'conversations','conversation_messages','conversation_events','conversation_message_tasks'},
 'analysis':{'analysis_tasks','condition_revisions','clarifications','task_lifecycle_operations'},
 'runtime':{'agent_runs','pi_checkpoints','tool_calls','assistant_outputs','output_chunks','budget_scopes','model_call_attempts','model_trials','maintenance_model_calls'},
 'jobs':{'background_jobs'},'access':{'semantic_ownership','semantic_owner_operations'},
 'queries':{'query_requests'},'knowledge':{'knowledge_objects','knowledge_versions','knowledge_operations','semantic_change_proposals','knowledge_index_jobs','knowledge_index_rebuilds','semantic_corrections','semantic_correction_operations'},
 'ingestion':{'source_heads', 'source_sync_locks','source_snapshots','prefill_attempts','catalog_imports','catalog_platform_heads','catalog_table_snapshots','catalog_namespace_heads','table_analysis_preferences','analysis_preference_operations'},'assets':{'skill_publications','skill_suggestions','personal_memory_index_jobs','personal_assets','personal_asset_versions','asset_operations','skill_selections','asset_adoptions'},'retrieval':{'retrieval_documents'},
}
def violations(root:Path)->list[str]:
 errors=[];base=root/'crates/data-agent/src'
 for path in sorted(base.rglob('*.rs')):
  name=path.relative_to(base);source=path.read_text();code=re.sub(r'//[^\n]*|/\*.*?\*/','',source,flags=re.S)
  module=name.parts[1] if name.parts[0]=='modules' and len(name.parts)>2 else None
  if module:
   for imported in re.findall(r'\b(?:super::)(?:super::)?([A-Za-z_]+)',code):
    if imported in OWNERS and imported != module:errors.append(f'{name}: 兄弟模块相对导入 {imported}')
   for imported in re.findall(r'(?:crate::)?modules::([A-Za-z_]+)',code):
    if imported!=module:errors.append(f'{name}: 兄弟模块互导 {imported}')
   if re.search(r'\buse\s+(?:super::super|crate::modules)\s*::\s*\{',code):errors.append(f'{name}: 兄弟模块集合导入')
  sql_owner=module if path.name=='store.rs' else None
  if name.parts[0]!='persistence' and not sql_owner and re.search(r'\bsqlx::(?:query|raw_sql)|\.connection\s*\(',code):errors.append(f'{name}: SQL或底层连接位于私有store之外')
  if sql_owner:
   for table in re.findall(r'\b(?:FROM|INTO|JOIN)\s+([a-z_]+)|\bUPDATE\s+([a-z_]+)\s+SET',source,re.I):
    table=next(part for part in table if part)
    if table.lower() not in OWNERS[sql_owner]:errors.append(f'{name}: 越界访问表 {table}')
  if name.parts[0]=='use_cases' and re.search(r'\b(?:Executor|Deref)\b|\b(?:SELECT|INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM)\b',code):errors.append(f'{name}: 协调层持有通用SQL入口')
 for directory in ('apps/api/src','apps/worker/src'):
  for path in sorted((root/directory).rglob('*.rs')):
   code=path.read_text()
   if re.search(r'\bsqlx::(?:query|raw_sql)|\.connection\s*\(',code):errors.append(f'{path.relative_to(root)}: 接入层绕过模块存储')
 return errors
def main()->int:
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=parser.parse_args();errors=violations(args.root)
 for error in errors:print(error,file=sys.stderr)
 if not errors:print('模块依赖、SQL位置和表归属检查通过')
 return bool(errors)
if __name__=='__main__':sys.exit(main())
