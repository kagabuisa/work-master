"""Read-only orchestration safeguards, without a Docker daemon or credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('benchmark_control',Path(__file__).resolve().parents[1] / 'scripts/erpnext-benchmark/control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)

class ControlTests(unittest.TestCase):
    def test_image_repair_preserves_database_configuration_and_records_lineage(self):
        self.check_image_repair()

    def test_image_repair_refuses_unvalidated_or_changed_profiles_before_mutation(self):
        for fault in ['traffic','pilot_failed','source_changed','profile_changed','running','image_changed']:
            with self.subTest(fault=fault): self.check_image_repair(fault)

    def check_image_repair(self, fault=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            full, pilot_dir, state = root/'full', root/'pilot', root/'state'
            for directory in [full/'output',pilot_dir/'output',state]: directory.mkdir(parents=True)
            meta = {'run_id':'erp-full-safe','mode':'full','directory':str(full),
                    'image':'old-image','image_id':'old-id','source_sha256':'old-source'}
            pilot = {'run_id':'erp-pilot-safe','directory':str(pilot_dir),
                     'image':'passed-image','image_id':'passed-id','source_sha256':'current'}
            control.write(full/'output/status.json',{'stage':'failed','error':'seed error'})
            control.write(full/'output/seed-checkpoint.json',{'fingerprint':'same-profile','completed':{'stock':200}})
            control.write(pilot_dir/'output/status.json',{'stage':'complete','passed':fault!='pilot_failed'})
            control.write(pilot_dir/'output/runtime.json',{'job_running':False,'job_exit_code':0,'job_oom_killed':False})
            original = 'BENCHMARK_IMAGE=old-image\nBENCHMARK_DB_PASSWORD=dedicated-test-only\n'
            (full/'config.env').write_text(original)
            if fault=='traffic': (full/'output/traffic-started.json').write_text('{}')
            if fault=='running': control.write(state/'erp-full-other.json',{})
            def execute(args, **kwargs):
                value = ('wrong-id' if fault=='image_changed' else 'passed-id') if args[1]=='image' else ('changed-profile' if fault=='profile_changed' else 'same-profile')
                return SimpleNamespace(stdout=value)
            with patch.object(control,'STATE',state), patch.object(control,'load',return_value=pilot), \
                 patch.object(control,'digest',return_value='changed' if fault=='source_changed' else 'current'), \
                 patch.object(control,'run',side_effect=execute), \
                 patch.object(control,'compose',return_value=SimpleNamespace(stdout='running' if fault=='running' else '')):
                if fault:
                    with self.assertRaises(RuntimeError): control.use_pilot_image(meta)
                    self.assertEqual((full/'config.env').read_text(),original)
                    self.assertFalse((full/'output/manifest.json').exists())
                else:
                    updated = control.use_pilot_image(meta)
                    self.assertEqual(updated['directory'],meta['directory'])
                    self.assertEqual(updated['run_id'],meta['run_id'])
                    self.assertEqual(updated['image_id'],'passed-id')
                    self.assertEqual(updated['image_history'][0]['previous_image_id'],'old-id')
                    self.assertIn('BENCHMARK_DB_PASSWORD=dedicated-test-only',(full/'config.env').read_text())
                    self.assertEqual(control.read(full/'output/seed-checkpoint.json')['completed'],{'stock':200})
                    self.assertEqual(len(list((full/'output').glob('pre-repair-*.json'))),1)

    def test_load_rejects_traversal_and_foreign_directories(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            with patch.object(control,'STATE',state), patch.object(control,'VOLUME',Path('/dedicated')):
                for run in ['../../prod','other','erp-pilot-../production']:
                    with self.assertRaises(RuntimeError): control.load(run)
                run = 'erp-pilot-safe'
                (state / (run+'.json')).write_text(json.dumps({'run_id':run,'directory':'/production/wm-'+run}))
                with self.assertRaises(RuntimeError): control.load(run)
                (state / (run+'.json')).write_text(json.dumps({'run_id':run,'directory':'/dedicated/wm-'+run}))
                self.assertEqual(control.load(run)['run_id'],run)

    def test_source_snapshot_detects_code_changes_and_excludes_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['server.js','package.json','package-lock.json','Dockerfile']:(root/name).write_text(name)
            for name in ['src','scripts','public','views','tests']:(root/name).mkdir()
            with patch.object(control,'ROOT',root):
                original = control.digest()
                (root/'.env').write_text('secret=not-in-image')
                self.assertEqual(original,control.digest())
                (root/'src/changed.js').write_text('changed')
                self.assertNotEqual(original,control.digest())

    def test_missing_volume_is_rejected_before_docker_is_called(self):
        with patch.object(Path,'is_mount',return_value=False), patch.object(control,'run') as execute:
            with self.assertRaises(RuntimeError): control.start('pilot')
            execute.assert_not_called()

    def test_compose_ignores_poisoned_shell_mount_and_project_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            meta = {'directory':str(directory),'run_id':'erp-pilot-safe','image':'test-image','mode':'pilot','project':'test-project'}
            values = {'BENCHMARK_DIRECTORY':str(directory),'BENCHMARK_RUN_ID':meta['run_id'],'BENCHMARK_IMAGE':meta['image'],'BENCHMARK_MODE':meta['mode'],'BENCHMARK_DB_PASSWORD':'dedicated-test-only'}
            (directory/'config.env').write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
            with patch.dict(control.os.environ,{'BENCHMARK_DIRECTORY':'/production','COMPOSE_ENV_FILES':'/production/.env'}), patch.object(control,'run') as execute:
                control.compose(meta,'config','--quiet')
                environment = execute.call_args.kwargs['env']
                self.assertEqual(environment['BENCHMARK_DIRECTORY'],str(directory))
                self.assertNotIn('COMPOSE_ENV_FILES',environment)
            values['BENCHMARK_DIRECTORY']='/production'
            (directory/'config.env').write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
            with patch.object(control,'run') as execute:
                with self.assertRaises(RuntimeError): control.compose(meta,'up','-d')
                execute.assert_not_called()

if __name__ == '__main__': unittest.main()
