import copy
import hashlib
from io import BytesIO
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

from catalog import AcceptanceError, load, read_cases, read_json, reconcile, validate_binding
from evidence import (
    EDITOR, EDITOR_PASS, binding_paths, binding_product, clean_scope, command_for, completion_record, execute, execution_groups,
    download_prior_vsix, observed_mocha_tests, observed_pass, reclaim_scope_processes, run_identity, verify_receipts,
)

ROOT = Path(__file__).resolve().parent.parent
CORE = 'core/daemon/local-client-request/hello'
EDITOR_CASE = 'extension/p0/pin-reload/resume-rust'
REMOTE_WORKTREE = 'core/p0/remote-execution/remote-worktree'
HARD_FAILURE = 'extension/p0/activation-shell/activation-failure'


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases, cls.inventory, cls.required_p0, _ = load(ROOT)

    def test_a_new_api_needs_a_catalog_row(self):
        added = 'core/daemon/local-client-request/new_operation'
        with self.assertRaisesRegex(AcceptanceError, f'missing API cases: {added}'):
            reconcile(self.cases, {**self.inventory, added: self.inventory[CORE]}, self.required_p0)

    def test_an_extra_api_is_reported(self):
        inventory = {key: source for key, source in self.inventory.items() if key != CORE}
        with self.assertRaisesRegex(AcceptanceError, f'unexpected API cases: {CORE}'):
            reconcile(self.cases, inventory, self.required_p0)

    def test_a_missing_p0_case_is_detected_even_when_its_siblings_exist(self):
        cases = {key: case for key, case in self.cases.items() if key != EDITOR_CASE}
        with self.assertRaisesRegex(AcceptanceError, f'missing P0 cases: {EDITOR_CASE}'):
            reconcile(cases, self.inventory, self.required_p0)

    def test_removing_a_pr_p0_binding_fails(self):
        case = self.cases[EDITOR_CASE]
        row = {'id': case.id, 'assertion': case.assertion, 'stage': case.stage, 'existing_tests': []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ci').mkdir()
            (root / 'ci/cases.json').write_text(json.dumps({'version': 2, 'cases': [row]}))
            with self.assertRaisesRegex(AcceptanceError, f'missing executable PR P0 bindings:\\s+{case.id}'):
                read_cases(root)

    def test_every_bound_pr_case_is_in_the_plan(self):
        cases, pilots = read_cases(ROOT)
        self.assertEqual({key: binding for key, binding in pilots.items() if cases[key].stage == 'pr'},
                         {case.id: case.test for case in cases.values() if case.stage == 'pr' and case.test is not None})
        self.assertEqual({key for key in pilots if cases[key].stage != 'pr'}, {
            'extension/p0/vsix-upgrade/install-pair',
            'extension/p0/vsix-upgrade/upgrade-pair',
        })

    def test_an_unbound_vsix_rehearsal_fails_the_catalog(self):
        case_id = 'extension/p0/vsix-upgrade/upgrade-pair'
        case = self.cases[case_id]
        row = {'id': case_id, 'assertion': case.assertion, 'stage': case.stage, 'existing_tests': []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ci').mkdir()
            (root / 'ci/cases.json').write_text(json.dumps({'version': 2, 'cases': [row]}))
            with self.assertRaisesRegex(AcceptanceError, r'missing executable VSIX release rehearsals: .*upgrade-pair'):
                read_cases(root)

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'duplicate.json'
            fixture.write_text('{"test": 1, "test": 2}')
            with self.assertRaisesRegex(AcceptanceError, 'duplicate JSON field test'):
                read_json(fixture)

    def test_unknown_runner_is_rejected(self):
        with self.assertRaisesRegex(AcceptanceError, 'unknown runner'):
            validate_binding({'runner': 'shell'}, CORE)

    def test_unit_bindings_use_a_named_test_file_and_cannot_replace_p0_journeys(self):
        name = 'Extension suite checks its state'
        binding = {'runner': 'extension-unit', 'target': 'windowTerminals.test', 'name': name}
        case_id = 'extension/window-component-old/registration/activate'
        self.assertEqual(validate_binding(binding, case_id), binding)
        for case, target in ((EDITOR_CASE, 'windowTerminals.test'), (case_id, '../windowTerminals.test')):
            with self.subTest(case=case, target=target), self.assertRaisesRegex(AcceptanceError, 'invalid Extension unit'):
                validate_binding({**binding, 'target': target}, case)

    def test_unknown_editor_route_is_rejected(self):
        binding = {**self.cases[EDITOR_CASE].test, 'journey': 'remote'}
        with self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
            validate_binding(binding, EDITOR_CASE)

    def test_an_editor_binding_needs_the_right_engine_and_a_supported_fixture(self):
        for field, value in {'engine': 'old', 'built_in': 'made_up'}.items():
            with self.subTest(field=field), self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
                validate_binding({**self.cases[EDITOR_CASE].test, field: value}, EDITOR_CASE)

    def test_an_editor_driver_requires_its_exact_route(self):
        driver = {
            'runner': 'extension-editor', 'journey': 'shell-handoff', 'name': 'shell-handoff',
            'engine': 'rust', 'built_in': 'codex',
        }
        case_id = 'extension/p0/activation-shell/rust-handoff'
        self.assertEqual(validate_binding(driver, case_id), driver)
        for field, value in {'built_in': 'claude', 'name': 'another-driver'}.items():
            with self.subTest(field=field), self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
                validate_binding({**driver, field: value}, case_id)

    def test_fallback_binding_names_the_observed_old_engine(self):
        binding = {
            'runner': 'extension-editor', 'journey': 'activation-failure', 'name': 'activation-failure',
            'engine': 'old', 'built_in': 'claude',
        }
        case_id = 'extension/p0/activation-shell/startup-fallback'
        self.assertEqual(validate_binding(binding, case_id), binding)
        _, _, env = command_for(ROOT, [binding], None, Path('/tmp/code'), {})
        self.assertEqual(env['FACADE_IT_ENGINE'], 'rust')
        marker = EDITOR_PASS + '{"name":"activation-failure","engine":"old"}'
        self.assertTrue(observed_pass([binding], marker))
        self.assertFalse(observed_pass([binding], marker.replace('"old"', '"rust"')))


    def test_incompatible_activation_requires_no_serving_engine(self):
        binding = self.cases[HARD_FAILURE].test
        self.assertEqual(binding['engine'], 'none')
        self.assertEqual(validate_binding(binding, HARD_FAILURE), binding)
        _, _, env = command_for(ROOT, [binding], None, Path('/tmp/code'), {})
        self.assertEqual(env['FACADE_IT_ENGINE'], 'rust')
        marker = EDITOR_PASS + '{"name":"incompatible-activation","engine":"none"}'
        self.assertTrue(observed_pass([binding], marker))
        self.assertFalse(observed_pass([binding], marker.replace('"none"', '"rust"')))
        fallback = self.cases['extension/p0/activation-shell/startup-fallback'].test
        with self.assertRaisesRegex(AcceptanceError, 'requires the incompatible-activation editor route'):
            validate_binding(fallback, HARD_FAILURE)
        for unrelated in (binding, {**self.cases[EDITOR_CASE].test, 'engine': 'none'}):
            with self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
                validate_binding(unrelated, EDITOR_CASE)

    def test_remote_worktree_editor_route_applies_to_its_case(self):
        binding = self.cases[REMOTE_WORKTREE].test
        self.assertEqual(validate_binding(binding, REMOTE_WORKTREE), binding)
        with self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
            validate_binding(binding, EDITOR_CASE)
        portable = {
            'runner': 'core-scenario', 'target': 'machines', 'name': 'a_remote_start_opens_a_worktree_at_the_remote_head',
        }
        with self.assertRaisesRegex(AcceptanceError, 'requires the remote-worktree editor route'):
            validate_binding(portable, REMOTE_WORKTREE)


    def test_window_replacement_cases_require_their_exact_editor_routes(self):
        names = ('replacement-in-flight', 'stale-owner')
        for name in names:
            with self.subTest(name=name):
                case_id = f'extension/p0/window-replacement/{name}'
                binding = self.cases[case_id].test
                self.assertEqual(validate_binding(binding, case_id), binding)
                with self.assertRaisesRegex(AcceptanceError, 'requires the .* editor route'):
                    validate_binding(self.cases[EDITOR_CASE].test, case_id)
                with self.assertRaisesRegex(AcceptanceError, 'invalid Extension editor binding'):
                    validate_binding(binding, EDITOR_CASE)


class PriorPackageTests(unittest.TestCase):
    def test_release_download_is_written_only_if_it_matches_the_pin(self):
        original = b'verified release'
        packages = {'fixture.vsix': (len(original), hashlib.sha256(original).hexdigest())}
        with tempfile.TemporaryDirectory() as directory, patch('evidence.PRIOR_VSIX', packages):
            root = Path(directory)
            with patch('evidence.urlopen', return_value=BytesIO(original)):
                download_prior_vsix(root / 'valid')
            self.assertEqual((root / 'valid/fixture.vsix').read_bytes(), original)
            corrupt = bytes([original[0] + 1]) + original[1:]
            with patch('evidence.urlopen', return_value=BytesIO(corrupt)):
                with self.assertRaisesRegex(AcceptanceError, 'pinned digest'):
                    download_prior_vsix(root / 'corrupt')
            self.assertEqual(list((root / 'corrupt').iterdir()), [])

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.directory = Path(self.tmp)
        catalog, _ = read_cases(ROOT)
        self.bindings = {key: catalog[key].test for key in (CORE, EDITOR_CASE)}
        self.core = self.bindings[CORE]
        self.editor = self.bindings[EDITOR_CASE]
        self.plan = {
            'id': 'current-plan', 'revision': 'revision', 'tree': 'tree',
            'platform': 'linux-x64', 'run': 'github/100/2', 'editor': EDITOR, 'rust': '1.98.1',
            'node_major': '24', 'cases': self.bindings,
        }
        self.core_log = (
            f"running 1 test\ntest {self.core['name']} ... ok\n"
            'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out\n'
        )
        self.editor_log = EDITOR_PASS + json.dumps({'name': self.editor['name'], 'engine': self.editor['engine']}) + '\n'

    def receipt(self, case_id, **changes):
        binding = self.bindings[case_id]
        product = binding_product(binding)
        observation, console, completion = binding_paths(self.directory, [binding])
        if product == 'core':
            observation.write_text(self.core_log)
            console.write_text('tests exit 0\nno processes left\n')
        else:
            observation.write_text(self.editor_log + 'no processes left\n')
        completion.write_text(json.dumps(completion_record(self.plan, [binding], observation, console)))
        item = {'id': case_id, 'status': 'pass', 'binding': copy.copy(binding), 'log': observation.name, 'elapsed_ms': 1}
        receipt = {
            'plan': self.plan['id'], 'revision': self.plan['revision'], 'tree': self.plan['tree'],
            'platform': self.plan['platform'], 'run': self.plan['run'], 'product': product,
            'editor': EDITOR if product == 'extension' else None, 'preparation_ms': 0, 'results': [item],
            'rust': 'rustc 1.98.1 (pinned build)',
            'node': 'v24.18.0' if product == 'extension' else None,
        }
        path = self.directory / (product + '.json')
        path.write_text(json.dumps({**receipt, **changes}))
        return path

    def test_complete_receipts(self):
        self.assertEqual(verify_receipts(self.plan, [self.receipt(CORE), self.receipt(EDITOR_CASE)]), 2)

    def test_exact_mocha_unit_results_reject_zero_skipped_and_wrong_names(self):
        title = 'A suite reports (the real result)'
        target = 'testFixture.test'
        passed = {'fullTitle': title, 'err': {}, 'file': f'/runner/extension/build/out/test/{target}.js'}
        report = {'stats': {'tests': 1, 'passes': 1, 'failures': 0, 'pending': 0},
                  'tests': [passed], 'passes': [passed], 'pending': [], 'failures': []}
        self.assertTrue(observed_mocha_tests([title], target, json.dumps(report)))
        for changes in (
            {'tests': [], 'passes': []},
            {'pending': [passed]},
            {'failures': [passed]},
            {'tests': [{**passed, 'fullTitle': 'a different scenario'}]},
            {'passes': [{**passed, 'file': '/runner/extension/build/out/test/foreign.test.js'}]},
            {'passes': [passed, passed]},
        ):
            with self.subTest(result=changes):
                self.assertFalse(observed_mocha_tests([title], target, json.dumps({**report, **changes})))

    def test_remote_worktree_binds_the_core_case_to_the_editor_job(self):
        catalog, _ = read_cases(ROOT)
        binding = self.bindings[REMOTE_WORKTREE] = catalog[REMOTE_WORKTREE].test
        self.plan['cases'] = {REMOTE_WORKTREE: binding}
        scenario = 'a_remote_worktree_is_shared_by_the_shell_and_editor'
        core = (f'running 1 test\ntest {scenario} ... ok\n'
                'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out\n')
        editor = {
            'origin': 'origin-id', 'reference': {'machine_id': 'remote-id', 'agent_id': 'a1'},
            'address': 'a1@devbox', 'pid': 41, 'cwd': '/fixture/project.worktrees/feat-x',
            'engine': 'rust', 'viewers': [2, 3, 2], 'marker': 'Editor typed into the remote worktree',
        }
        evidence = 'remote editor evidence ' + json.dumps(editor) + '\n'
        marker = EDITOR_PASS + json.dumps({'name': binding['name'], 'engine': binding['engine']}) + '\n'
        self.editor_log = core + evidence + marker
        self.assertEqual(verify_receipts(self.plan, [self.receipt(REMOTE_WORKTREE)], 'extension'), 1)
        for invalid in (marker, core + marker, evidence + marker,
                        core + evidence + evidence + marker, core + evidence.replace('remote-id', 'origin-id') + marker):
            with self.subTest(log=invalid):
                self.assertFalse(observed_pass([binding], invalid))
        with self.assertRaisesRegex(AcceptanceError, 'wrong receipt product'):
            verify_receipts(self.plan, [self.receipt(REMOTE_WORKTREE, product='core', editor=None)])

    def test_replacement_receipt_rechecks_all_four_packages(self):
        case_id = 'extension/p0/window-replacement/replacement-in-flight'
        catalog, _ = read_cases(ROOT)
        binding = self.bindings[case_id] = catalog[case_id].test
        self.plan['cases'] = {case_id: binding}
        self.editor_log = EDITOR_PASS + json.dumps({'name': binding['name'], 'engine': binding['engine']}) + '\n'
        files = []
        for stage in ('prior', 'candidate'):
            folder = self.directory / (stage + '-vsix')
            folder.mkdir()
            names = ['workspace.vsix', 'window.vsix']
            for name in names:
                path = folder / name
                path.write_bytes(f'{stage} {name}'.encode())
                files.append(path)
            if stage == 'prior':
                self.plan['prior_vsix'] = {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in names}
            else:
                self.plan['candidate_vsix'] = names
        receipt = self.receipt(case_id)
        self.assertEqual(verify_receipts(self.plan, [receipt], 'extension'), 1)
        for stage, file in (('prior', files[0]), ('candidate', files[-1])):
            with self.subTest(stage=stage, issue='unexpected package'):
                unexpected = file.with_name('00-alternate-' + file.name)
                unexpected.write_bytes(b'an unverified package of the same version')
                with self.assertRaisesRegex(AcceptanceError, f'unexpected {stage} update packages'):
                    verify_receipts(self.plan, [receipt], 'extension')
                unexpected.unlink()
        for file in files:
            with self.subTest(package=str(file.relative_to(self.directory))):
                original = file.read_bytes()
                file.write_bytes(original + b'changed')
                with self.assertRaisesRegex(AcceptanceError, 'pinned digests|does not match'):
                    verify_receipts(self.plan, [receipt], 'extension')
                file.write_bytes(original)

    def test_fresh_vsix_install_uses_the_candidate_pair_only(self):
        case_id = 'extension/p0/vsix-upgrade/install-pair'
        catalog, _ = read_cases(ROOT)
        binding = self.bindings[case_id] = catalog[case_id].test
        self.plan['cases'] = {case_id: binding}
        self.editor_log = EDITOR_PASS + json.dumps({'name': binding['name'], 'engine': binding['engine']}) + '\n'
        directory = self.directory / 'candidate-vsix'
        directory.mkdir()
        self.plan['candidate_vsix'] = ['main.vsix', 'window.vsix']
        for name in self.plan['candidate_vsix']:
            (directory / name).write_text(name)
        receipt = self.receipt(case_id)
        self.assertEqual(verify_receipts(self.plan, [receipt], 'extension'), 1)
        (directory / 'main.vsix').unlink()
        with self.assertRaisesRegex(AcceptanceError, 'missing candidate update packages'):
            verify_receipts(self.plan, [receipt], 'extension')

    def test_missing_and_duplicate_results(self):
        path = self.receipt(CORE)
        with self.assertRaisesRegex(AcceptanceError, f'missing pilot results: {EDITOR_CASE}'):
            verify_receipts(self.plan, [path])
        with self.assertRaisesRegex(AcceptanceError, f'duplicate result for .*{CORE}'):
            verify_receipts(self.plan, [path, path])

    def test_stale_plan_revision_platform_and_attempt(self):
        stale = {'plan': 'old-plan', 'revision': 'old-sha', 'platform': 'linux-arm64', 'run': 'github/100/1'}
        for field, value in stale.items():
            with self.subTest(field=field), self.assertRaisesRegex(AcceptanceError, 'does not match'):
                verify_receipts(self.plan, [self.receipt(CORE, **{field: value})], 'core')

    def test_wrong_engine_does_not_settle_the_case(self):
        path = self.receipt(EDITOR_CASE)
        document = read_json(path)
        document['results'][0]['binding']['engine'] = 'old'
        path.write_text(json.dumps(document))
        with self.assertRaisesRegex(AcceptanceError, f'{EDITOR_CASE}: wrong runner, engine or selector'):
            verify_receipts(self.plan, [path], 'extension')

    def test_missing_editor_log_does_not_settle_the_case(self):
        path = self.receipt(EDITOR_CASE)
        binding_paths(path.parent, [self.editor])[0].unlink()
        with self.assertRaisesRegex(AcceptanceError, f'{EDITOR_CASE}: missing log'):
            verify_receipts(self.plan, [path], 'extension')

    def test_an_older_completion_cannot_settle_a_new_attempt(self):
        path = self.receipt(CORE)
        observation, console, completion = binding_paths(path.parent, [self.core])
        previous = {**self.plan, 'run': 'github/100/1'}
        completion.write_text(json.dumps(completion_record(previous, [self.core], observation, console)))
        with self.assertRaisesRegex(AcceptanceError, 'does not match this binding and attempt'):
            verify_receipts(self.plan, [path], 'core')

    def test_an_altered_core_log_and_missing_cleanup_are_rejected(self):
        path = self.receipt(CORE)
        observation, console, _ = binding_paths(path.parent, [self.core])
        observation.write_text(self.core_log + 'output from another run\n')
        with self.assertRaisesRegex(AcceptanceError, 'does not match this binding and attempt'):
            verify_receipts(self.plan, [path], 'core')
        console.unlink()
        with self.assertRaisesRegex(AcceptanceError, 'missing log or completion record'):
            verify_receipts(self.plan, [path], 'core')

    def test_editor_log_truncated_at_the_pass_marker_is_rejected(self):
        path = self.receipt(EDITOR_CASE)
        binding_paths(path.parent, [self.editor])[0].write_text(self.editor_log)
        with self.assertRaisesRegex(AcceptanceError, 'does not match this binding and attempt'):
            verify_receipts(self.plan, [path], 'extension')

    def test_zero_skipped_wrong_or_duplicate_test_is_not_a_proof(self):
        fixtures = (
            (self.core, 'running 0 tests\n'),
            (self.core, self.core_log.replace(self.core['name'], 'other_test')),
            (self.core, self.core_log.replace('0 ignored', '1 ignored')),
            (self.editor, '  0 passing\n  1 pending\n'),
            (self.editor, self.editor_log.replace('"rust"', '"old"')),
            (self.editor, self.editor_log * 2),
        )
        for binding, result in fixtures:
            with self.subTest(result=result):
                self.assertFalse(observed_pass([binding], result))

    def test_core_group_requires_each_exact_test_and_deduplicates_aliases(self):
        second = {**self.core, 'name': 'also_negotiates'}
        selected = {'primary': self.core, 'alias': self.core, 'other': second}
        groups = list(execution_groups(selected))
        self.assertEqual(groups, [(selected, [second, self.core])])
        complete = (
            f'running 2 tests\ntest {self.core["name"]} ... ok\ntest also_negotiates ... ok\n'
            'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n'
        )
        self.assertTrue(observed_pass(groups[0][1], complete))
        self.assertFalse(observed_pass(groups[0][1], complete.replace('test also_negotiates ... ok\n', '')))
        self.assertFalse(observed_pass(groups[0][1], complete + 'test result: FAILED. 0 passed; 1 failed;\n'))
        self.assertFalse(observed_pass(groups[0][1], complete + 'test unexpected ... ignored\n'))

    def test_editor_group_requires_every_observed_engine_and_title(self):
        second = {**self.editor, 'name': 'Another editor case'}
        first_marker = self.editor_log
        second_marker = EDITOR_PASS + json.dumps({'name': second['name'], 'engine': 'rust'}) + '\n'
        groups = list(execution_groups({'first': self.editor, 'second': second}))
        self.assertEqual(len(groups), 1)
        self.assertTrue(observed_pass(groups[0][1], second_marker + first_marker))
        self.assertFalse(observed_pass(groups[0][1], first_marker))
        self.assertFalse(observed_pass(groups[0][1], first_marker + second_marker.replace('"rust"', '"old"')))

    def test_local_and_github_attempt_ids(self):
        self.assertEqual(run_identity('local-1', {}), 'local/local-1')
        self.assertEqual(run_identity(None, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '2'}), 'github/1/2')
        with self.assertRaisesRegex(AcceptanceError, 'GitHub run ID and attempt'):
            run_identity(None, {'GITHUB_RUN_ID': '1'})
        with self.assertRaisesRegex(AcceptanceError, 'unique local'):
            run_identity(None, {})


@unittest.skipUnless(sys.platform == 'linux', 'The pilot process scan targets Linux.')
class CleanupTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux PID handles required.')
    def test_interrupted_cleanup_reaps_only_the_owned_detached_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir()
            processes = [
                subprocess.Popen(
                    ['sleep', '30'], start_new_session=True,
                    env={'PATH': os.environ['PATH'], 'TMPDIR': str(path)},
                )
                for path in (root, root.with_name('owned-sibling'))
            ]
            owned, sibling = processes
            try:
                with tempfile.TemporaryFile(mode='w+') as log:
                    reclaim_scope_processes(root, log)
                self.assertEqual(owned.wait(timeout=5), -signal.SIGTERM)
                self.assertIsNone(sibling.poll())
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=5)

    def test_interrupted_cleanup_reclaims_a_late_child_and_scans_again(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryFile(mode='w+') as stream:
            with patch('evidence.reclaim_scope_processes') as reclaim, patch('evidence.execute', side_effect=['fail', 'pass']) as scan:
                self.assertEqual(clean_scope(ROOT, Path(directory), {}, stream, interrupted=True), 'pass')
                self.assertEqual(reclaim.call_count, 2)
                self.assertEqual(scan.call_count, 2)

    @unittest.skipUnless(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux PID handles required.')
    def test_editor_cleanup_reclaims_only_its_exact_crash_reporter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scope = root / 'owned'
            scope.mkdir()
            editor = root / 'editor/code'
            editor.parent.mkdir()
            crashpad = editor.with_name('chrome_crashpad_handler')
            unrelated = root / crashpad.name
            for executable in (crashpad, unrelated):
                shutil.copy2('/bin/sh', executable)
            processes = [
                subprocess.Popen(['sh', '-c', 'read unused'], executable=executable, start_new_session=True,
                                 stdin=subprocess.PIPE, env={'CI_ACCEPTANCE_ROOT': str(owned)})
                for executable, owned in (
                    (crashpad, scope), (crashpad, scope.with_name('owned-sibling')), (unrelated, scope),
                )
            ]
            helper, sibling, decoy = processes
            try:
                with tempfile.TemporaryFile(mode='w+') as log:
                    self.assertEqual(clean_scope(ROOT, scope, dict(os.environ), log, False, editor=editor), 'fail')
                    self.assertEqual(helper.wait(timeout=5), -signal.SIGTERM)
                    self.assertIsNone(sibling.poll())
                    self.assertIsNone(decoy.poll())
                    log.seek(0)
                    text = log.read()
                    self.assertIn(f'Stopped owned fixture process {helper.pid} (chrome_crashpad_handler).', text)
                    self.assertIn('processes left:', text)
                    self.assertNotIn('no processes left', text)
                decoy.terminate()
                decoy.wait(timeout=5)
                with tempfile.TemporaryFile(mode='w+') as log:
                    self.assertEqual(clean_scope(ROOT, scope, dict(os.environ), log, False, editor=editor), 'pass')
                    log.seek(0)
                    self.assertEqual(log.read().splitlines()[-1], 'no processes left')
                self.assertIsNone(sibling.poll())
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=5)
                    process.stdin.close()

    def test_editor_group_cancellation_stops_an_active_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'child.log'
            cancelled = Event()
            script = (
                'import os, signal, time\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'print(os.getpid(), flush=True)\n'
                'time.sleep(30)\n'
            )
            with log.open('w') as stream, ThreadPoolExecutor(max_workers=1) as worker:
                future = worker.submit(
                    execute, [sys.executable, '-c', script], ROOT, dict(os.environ),
                    stream, timeout=30, cancelled=cancelled,
                )
                try:
                    deadline = time.monotonic() + 10
                    while log.stat().st_size == 0 and time.monotonic() < deadline:
                        time.sleep(0.025)
                    pid = int(log.read_text().strip())
                    self.assertTrue(Path(f'/proc/{pid}').exists())
                finally:
                    cancelled.set()
                self.assertEqual(future.result(timeout=5), 'cancelled')
                self.assertFalse(Path(f'/proc/{pid}').exists())

    def test_core_process_list_is_portable_to_awk_without_multiline_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            temp = root / 'scratch'
            checkout = root / 'core'
            temp.mkdir()
            checkout.mkdir()
            awk = shutil.which('awk')
            stub = root / 'awk'
            stub.write_text(
                f'#!{sys.executable}\n'
                'import os, sys\n'
                'if any(arg.startswith("pids=") and "\\n" in arg for arg in sys.argv[1:]):\n'
                '    sys.exit(2)\n'
                f'os.execv({awk!r}, [{awk!r}, *sys.argv[1:]])\n'
            )
            stub.chmod(0o755)
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            processes = [subprocess.Popen(['sleep', '30'], cwd=checkout) for _ in range(2)]
            try:
                scan = subprocess.run(
                    ['sh', str(ROOT / 'core/scripts/leftovers.sh'), str(temp), str(checkout)],
                    env=env, text=True, capture_output=True, check=False,
                )
                self.assertEqual(scan.returncode, 0, scan.stdout + scan.stderr)
                self.assertEqual(scan.stdout, 'no processes left\n')
            finally:
                for process in processes:
                    process.terminate()
                    process.wait(timeout=5)

    def test_unavailable_or_invalid_process_table_fails_the_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / 'ps'
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            for response in ('exit 2\n', 'echo malformed\n'):
                with self.subTest(response=response):
                    stub.write_text('#!/bin/sh\n' + response)
                    stub.chmod(0o755)
                    scan = subprocess.run(
                        ['sh', str(ROOT / 'core/scripts/leftovers.sh'), directory],
                        env=env, text=True, capture_output=True, check=False,
                    )
                    self.assertEqual(scan.returncode, 2)
                    self.assertIn('process table', scan.stderr)
                    self.assertNotIn('no processes left', scan.stdout)

    def test_scans_owned_scratch_and_portable_paths_without_matching_siblings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir()
            environments = (
                {'TMPDIR': str(root)},
                {'VSCODE_PORTABLE': str(root / 'profile')},
                {'TMPDIR': str(root.with_name('owned-neighbor'))},
            )
            processes = [
                subprocess.Popen(['sleep', '30'], env={'PATH': os.environ['PATH'], **env})
                for env in environments
            ]
            try:
                check = subprocess.run(
                    ['sh', str(ROOT / 'core/scripts/leftovers.sh'), str(root)],
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(check.returncode, 1, check.stdout + check.stderr)
                observed = {int(row.split()[0]) for row in check.stdout.splitlines()[1:]}
                self.assertEqual(observed, {process.pid for process in processes[:2]})
            finally:
                for process in processes:
                    process.terminate()
                    process.wait(timeout=5)

    def test_timeout_leaves_a_detached_owned_process_visible_to_the_scanner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = (
                'import subprocess\n'
                'import time\n'
                'fixture = subprocess.Popen(["sleep", "30"], start_new_session=True)\n'
                'print(fixture.pid, flush=True)\n'
                'time.sleep(30)\n'
            )
            log = root / 'timeout.log'
            with log.open('w') as stream:
                result = execute(
                    [sys.executable, '-c', script], ROOT, {**os.environ, 'TMPDIR': directory}, stream, timeout=1,
                )
            pid = int(log.read_text().strip())
            try:
                self.assertEqual(result, 'timeout')
                scan = subprocess.run(
                    ['sh', str(ROOT / 'core/scripts/leftovers.sh'), directory],
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(scan.returncode, 1, scan.stdout + scan.stderr)
                self.assertRegex(scan.stdout, rf'(?m)^\s*{pid}\s+')
            finally:
                os.kill(pid, signal.SIGTERM)
