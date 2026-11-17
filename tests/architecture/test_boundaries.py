import importlib.util
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('boundaries',ROOT/'scripts/check_architecture.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Boundaries(unittest.TestCase):
 def check(self,path,source):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);file=root/'crates/data-agent/src'/path;file.parent.mkdir(parents=True);file.write_text(source)
   return module.violations(root)
 def test_coordinator_sql_rejected(self):self.assertTrue(self.check('use_cases/receive_message.rs','sqlx::query("SELECT id FROM conversations");'))
 def test_coordinator_connection_rejected(self):self.assertTrue(self.check('use_cases/receive_message.rs','tx.connection();'))
 def test_sibling_import_rejected(self):self.assertTrue(self.check('modules/conversations/messages.rs','use crate::modules::analysis;'))
 def test_wrong_table_rejected(self):self.assertTrue(self.check('modules/conversations/store.rs','sqlx::query("SELECT id FROM analysis_tasks");'))
 def test_relative_sibling_import_rejected(self):self.assertTrue(self.check('modules/conversations/messages.rs','use super::super::analysis;'))
 def test_owner_store_accepted(self):self.assertFalse(self.check('modules/conversations/store.rs','sqlx::query("SELECT id FROM conversations");'))
 def test_owner_ctes_and_json_table_are_not_physical_tables(self):
  self.assertFalse(self.check('modules/knowledge/store.rs', '''sqlx::query("WITH selected AS (SELECT body FROM knowledge_objects), entries AS (SELECT j.n FROM selected JOIN JSON_TABLE(body,'$.entries[*]' COLUMNS(n FOR ORDINALITY)) AS j) SELECT n FROM entries");'''))
 def test_cte_does_not_hide_cross_owner_table(self):
  self.assertTrue(self.check('modules/knowledge/store.rs', '''sqlx::query("WITH selected AS (SELECT id FROM analysis_tasks) SELECT id FROM selected");'''))
 def test_cte_alias_cannot_exempt_registered_cross_owner_table(self):
  self.assertTrue(self.check('modules/knowledge/store.rs', '''sqlx::query("WITH analysis_tasks AS (SELECT id FROM knowledge_objects) SELECT id FROM analysis_tasks"); sqlx::query("SELECT id FROM analysis_tasks");'''))
 def test_registered_dependency_store_tables_accepted(self):
  # 已登记owner的表在所属store可用：依赖索引两张表归knowledge，来源准备进度归ingestion。
  self.assertFalse(self.check('modules/knowledge/dependency_index/store.rs','sqlx::query("SELECT owner_id FROM knowledge_dependencies");sqlx::query("SELECT mapping_state FROM knowledge_dependency_states");'))
  self.assertFalse(self.check('modules/ingestion/store.rs','sqlx::query("SELECT semantic_status FROM source_preparations");'))
 def test_cross_owner_table_still_rejected(self):
  # 登记不放松边界：knowledge的store仍不得越界读ingestion或jobs的表。
  self.assertTrue(self.check('modules/knowledge/dependency_index/store.rs','sqlx::query("SELECT version FROM source_heads");'))
  self.assertTrue(self.check('modules/ingestion/store.rs','sqlx::query("SELECT state FROM background_jobs");'))
 def test_cli_rejects_deliberate_violations(self):
  for path,source in [('use_cases/bad.rs','sqlx::query("SELECT id FROM conversations");'),('modules/conversations/bad.rs','use crate::modules::analysis;')]:
   with self.subTest(path=path), tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);file=root/'crates/data-agent/src'/path;file.parent.mkdir(parents=True);file.write_text(source)
    result=subprocess.run([sys.executable,str(ROOT/'scripts/check_architecture.py'),'--root',str(root)],capture_output=True,text=True)
    self.assertEqual(result.returncode,1);self.assertTrue(result.stderr.strip())
if __name__=='__main__':unittest.main()
