#!/usr/bin/env python3
"""检查当前单业务crate的模块依赖、SQL归属和事务出口；不是通用Rust解析器。"""
import argparse
from os import walk
from pathlib import Path
import re
import sys

OWNERS={
 'conversations':{'conversations','conversation_messages','conversation_events','conversation_message_tasks'},
 'analysis':{'analysis_tasks','condition_revisions','clarifications','task_lifecycle_operations','analysis_evidence','analysis_evidence_operations','analysis_reports','analysis_report_revisions','analysis_report_operations'},
 'runtime':{'agent_runs','pi_checkpoints','tool_calls','assistant_outputs','output_chunks','budget_scopes','model_call_attempts','model_trials','maintenance_model_calls','model_space_settings','model_services','model_service_versions','model_definitions','model_definition_versions'},
 'jobs':{'background_jobs'},'access':{'semantic_ownership','semantic_owner_operations','user_sessions'},
 'queries':{'query_requests'},
 # knowledge含依赖索引两张表（迁移202610240004，设计17.3归属M02）；
 # ingestion含来源级准备进度（迁移202610240003，设计17.3归属M03）。
 'knowledge':{'knowledge_statements','knowledge_relations','knowledge_objects','knowledge_versions','knowledge_revisions','knowledge_operations','semantic_change_proposals','knowledge_index_jobs','knowledge_index_rebuilds','semantic_corrections','semantic_correction_operations','knowledge_dependencies','knowledge_dependency_states'},
 'ingestion':{'source_current','source_revisions','catalog_sync_members','catalog_sync_pages','source_heads', 'source_sync_locks','source_snapshots','prefill_attempts','catalog_imports','catalog_platform_heads','catalog_table_snapshots','catalog_namespace_heads','table_analysis_preferences','analysis_preference_operations','source_preparations'},'assets':{'skill_publications','skill_suggestions','skill_drafts','personal_memory_index_jobs','personal_assets','personal_asset_versions','asset_operations','skill_selections','asset_adoptions'},'retrieval':{'retrieval_documents','retrieval_source_projections'},
}
SOURCE_SUFFIXES={'.rs','.ts','.tsx','.py','.css'}
def source_line_errors(root:Path)->list[str]:
 errors=[]
 for directory, folders, names in walk(root):
  parent=Path(directory).relative_to(root)
  folders[:]=sorted(f for f in folders if f not in {'node_modules','target','__pycache__','dist','.git','.local'} and
   not (f=='tests' and (not parent.parts or len(parent.parts)==2 and parent.parts[0]=='crates')) and
   not (f=='generated' and parent.parts==('packages','contracts')))
  for name in sorted(names):
   path=Path(directory)/name
   relative=path.relative_to(root).as_posix()
   if path.suffix not in SOURCE_SUFFIXES or name=='tests.rs':
    continue
   lines=len(path.read_bytes().splitlines())
   if lines>800:
    errors.append(f'{relative}: {lines} 行，源码上限为 800 行')
 return errors

# The delivery read model composes explicitly exported CTE relations from their owners.
# Real table names always keep their normal ownership checks.
DELIVERY_RELATIONS = {
 'modules/analysis/task_context/store.rs': {'delivery_input', 'task_context'},
 'modules/assets/store.rs': {'delivery_input', 'workspace_assets'},
 'modules/conversations/delivery/store.rs': {'delivery_input', 'checkpoint_run'},
 'modules/knowledge/storage/catalog_search/store.rs': {'workspace_assets', 'workspace_dependency_ids', 'checkpoint_asset_heads'},
 'modules/queries/store.rs': {'delivery_input', 'readable_delivery_conversations'},
 'modules/runtime/checkpoints/store.rs': {'delivery_input', 'history_chain', 'delivery_history'},
}

def violations(root:Path)->list[str]:
 errors=source_line_errors(root);base=root/'crates/data-agent/src'
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
   # CTE引用和JSON_TABLE函数不是持久表；CTE体内的实际表仍按owner检查。
   sql=re.sub(r'\\\n\s*',' ',source)
   ctes={name.lower() for name in re.findall(r'(?:\bWITH(?:\s+RECURSIVE)?|,)\s*([a-z_]+)\s+AS\s*\(',sql,re.I)}
   ctes.update(DELIVERY_RELATIONS.get(name.as_posix(), ()))
   for match in re.finditer(r'\b(?:FROM|INTO|JOIN)\s+([a-z_]+)|\bUPDATE\s+([a-z_]+)\s+SET',sql,re.I):
    table=next(part for part in match.groups() if part)
    if not any(table.lower() in tables for tables in OWNERS.values()):
     if table.lower() in ctes or (table.upper()=='JSON_TABLE' and sql[match.end():].lstrip().startswith('(')):continue
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
 if not errors:print('模块依赖、SQL位置、表归属与源码行数检查通过')
 return bool(errors)
if __name__=='__main__':sys.exit(main())
