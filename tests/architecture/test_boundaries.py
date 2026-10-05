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
 def test_cli_rejects_deliberate_violations(self):
  for path,source in [('use_cases/bad.rs','sqlx::query("SELECT id FROM conversations");'),('modules/conversations/bad.rs','use crate::modules::analysis;')]:
   with self.subTest(path=path), tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);file=root/'crates/data-agent/src'/path;file.parent.mkdir(parents=True);file.write_text(source)
    result=subprocess.run([sys.executable,str(ROOT/'scripts/check_architecture.py'),'--root',str(root)],capture_output=True,text=True)
    self.assertEqual(result.returncode,1);self.assertTrue(result.stderr.strip())
if __name__=='__main__':unittest.main()
