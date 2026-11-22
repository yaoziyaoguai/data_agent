#!/usr/bin/env python3
"""检查当前单业务crate的模块依赖、SQL归属和事务出口；不是通用Rust解析器。"""
import argparse
from hashlib import sha256
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
# 已有超长文件按原内容冻结，改动前必须拆分。完成拆分后删除对应例外。
OVERSIZED_BASELINE={
 'apps/web/src/features/knowledge/SemanticStructure.tsx': '2a8d3f88417582b67d9b5d1c98b06af3329f0bb7761d0e00c085d2f4411cdd61',
 'apps/web/src/features/models/ModelConfigurationPage.tsx': 'c434d977a84d7fbcf61f7eef59b9caa5d1b2c16e87a4bcd17ded89957e4bfd66',
 'apps/web/src/style.css': '961e0d88092d860cc3c621669ec38bb4ec56d68cd79c966064576b8e351ad75e',
 'crates/data-agent/src/modules/analysis/store.rs': '652d31ffec66c23278ad1e18b919eb1f310623bf3398ce9ddbc066b79d5febdd',
 'crates/data-agent/src/modules/assets/store.rs': 'bf29fe5c0beb8cc7e464d0bd56ac8783343c1cfe7c696241e3f94179228323e1',
 'crates/data-agent/src/modules/ingestion/prefill.rs': '4f6a17fc6b98fe939caed4a3d5b9d816feb6df25f8ec1fd22afca18e87dff88b',
 'crates/data-agent/src/modules/ingestion/store.rs': '2bd810565a46875781cea1a8e81c047d18e26021be3e1569ffbe3a9f6b1f5328',
 'crates/data-agent/src/modules/knowledge/structure.rs': '7bc99f2217f077107811f929577e34f5cdc49c4259f9dd116363943bf2ba4c97',
 'crates/data-agent/src/modules/queries/semantic_checks.rs': '219983cf99a36af16d8617826edafbc6fdf60ebf6e4f0e8a1c73e674bc5a9ca5',
 'crates/data-agent/src/modules/runtime/outputs.rs': '1afc170bf2c48ec6026349f1689a979ba771f946f2f68c0ba4312816675acac9',
 'crates/data-agent/src/modules/runtime/store.rs': '079f0d3117a58e19aa073e6e5eaa7ce495fb4824e3c0ffd731685d793df5d247',
 'crates/data-agent/src/use_cases/analysis_reports.rs': '8a45ec4358b5278c5c86b02cda9489aa2410a31ac293f6df1fc7805f74df106c',
 'crates/data-agent/src/use_cases/context_authority.rs': '69649443caa429b3699bdd50247ce3ead483390b5831bcdd0d1e8e639bcf6fc0',
 'crates/data-agent/src/use_cases/data_tools.rs': '5d03e96c485a51b4ecf2868ff52a777bad15e2a04d20bd19fada165856b3b30a',
 'crates/data-agent/src/use_cases/evidence_delivery.rs': '8265d38cd489e6c796a2c3c2aaa2ba9667475b0ebadc3e8fd2589f6d401f0d27',
 'crates/data-agent/src/use_cases/knowledge_sources.rs': '12207c13d68887e4dc3e79393f6a2cf5d3790de8a97ef9d1cded59c9d35c4ffd',
 'crates/data-agent/src/use_cases/prefill_materials.rs': '888f331d702d03a11c6f67fc7cdc3e222ab954d0d1b5f4dc6ba6392cbdafd8fb',
 'crates/data-agent/src/use_cases/source_limits.rs': 'ffdcbdcb329f41804ab3ee9be224454859b5509d4518bd6e6c3aeb3f374ffffd',
 'crates/data-agent/src/use_cases/task_answers.rs': 'e48f14755316d4e51d7c14a6d511daabd78807bd2ac44f1670a3c4790ae3ef50',
}
def source_line_errors(root:Path)->list[str]:
 errors=[]
 for directory, folders, names in walk(root):
  folders[:]=sorted(f for f in folders if not f.startswith('.') and f not in {'tests','node_modules','target','__pycache__','dist'})
  for name in sorted(names):
   path=Path(directory)/name
   relative=path.relative_to(root).as_posix()
   if path.suffix not in SOURCE_SUFFIXES or name.startswith('test_') or relative.startswith('packages/contracts/generated/'):
    continue
   raw=path.read_bytes(); lines=len(raw.splitlines())
   if lines>800 and OVERSIZED_BASELINE.get(relative)!=sha256(raw).hexdigest():
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
