"""Offline CI Gate fixtures with local Git candidates and exact pilot receipts."""

from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile

from catalog import AcceptanceError, Case, RELEASE_FIXTURE_CASES
from evidence import EDITOR_PASS, INPUT_FILES, binding_paths, binding_product, completion_record, digest
from gate_shadow import (
    CANDIDATE_FIELDS, CATALOG_JOB, REPORT_JOB, candidate_plan, decide, matches_workflow_path, select_workflows,
)
from merge_review import ACTIONS_APP, EXTENSION, FRAMEWORK, REMOTE, REQUIRED, ROOT, SHADOW, require_jobs, review
from merge_review_native import NATIVE_EDITOR_MINIMUM, TYPED_NATIVE_CASES


REPO, PULL, REPO_ID = 'owner/fixture', 11, 42
PASS = {'status': 'completed', 'conclusion': 'success'}
PILOTS = {
    'framework/shell/command/start': {'runner': 'framework-scenario', 'target': 'cli', 'name': 'starts_one_agent'},
    'extension/p0/panel/select': {
        'runner': 'extension-editor', 'journey': 'stale-owner', 'implementation': 'legacy', 'name': 'selects_agent',
        'built_in': 'claude',
    },
}


class GateFixture:
    def setUp(self):
        directory = Path(self.enterContext(TemporaryDirectory(prefix='ci-gate-fixture-')))
        self.root = directory / 'checkout'
        self.root.mkdir()
        self.observations = directory / 'observations.json'
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
        self.git('init', '-q')
        for path in INPUT_FILES:
            self.write(path, 'fixture policy input\n')
        for workflow in REQUIRED:
            path = f'.github/workflows/{workflow}'
            self.write(path, (ROOT / path).read_text())
        self.write('framework/rust-toolchain.toml', '[toolchain]\nchannel = "1.98.1"\n')
        self.write('extension/.nvmrc', '24\n')
        catalog = [
            {'id': case, 'stage': 'pr', 'assertion': 'Observe the selected agent', 'test': binding}
            for case, binding in PILOTS.items()
        ]
        self.write('ci/cases.json', json.dumps({'cases': catalog}))
        self.base = self.commit('base')
        cases = {item['id']: Case(item['id'], item['stage'], item['assertion'], (), item['test']) for item in catalog}
        self.catalog = cases, {}, set(), PILOTS
        self.enterContext(patch('gate_shadow.load', return_value=self.catalog))

    def git(self, *args):
        return subprocess.check_output([
            'git', '-C', str(self.root), '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=CI fixture',
            '-c', f'core.hooksPath={os.devnull}', *args,
        ], env=self.env, text=True).strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)
        return self.git('rev-parse', 'HEAD')

    def prepare(self, path, *, advance_main=False, contents='candidate change\n'):
        self.write(path, contents)
        head = self.commit('candidate')
        tree = self.git('rev-parse', 'HEAD^{tree}')
        if advance_main:
            base_tree = self.git('rev-parse', f'{self.base}^{{tree}}')
            self.base = self.git('commit-tree', base_tree, '-p', self.base, '-m', 'advanced main')
        merge = self.git('commit-tree', tree, '-p', self.base, '-p', head, '-m', 'test merge')
        self.arguments = self.root, REPO, PULL, head, self.base, merge
        self.plan, pilot = candidate_plan(*self.arguments)
        origin = {'id': REPO_ID, 'full_name': REPO}
        branch = 'feature/11-fixture'
        link = {'number': PULL, 'head': {'sha': head}, 'base': {'sha': self.base}}
        self.snapshot = {
            'candidate': {
                'pull': {**link, 'state': 'open', 'draft': False, 'mergeable': True, 'merge_commit_sha': merge,
                         'head': {**link['head'], 'repo': origin, 'ref': branch},
                         'base': {**link['base'], 'repo': origin, 'ref': 'main'}},
                'main': {'ref': 'refs/heads/main', 'object': {'sha': self.base}},
                'merge': {'sha': merge, 'tree': {'sha': tree}, 'parents': [link['base'], link['head']]},
            },
            'workflows': {},
        }
        for index, (workflow, requirements) in enumerate(self.plan['workflows'].items(), 1):
            run_id, suite = 100 + index, 1000 + index
            workflow_path = f'.github/workflows/{workflow}'
            run = {**PASS, 'id': run_id, 'path': workflow_path, 'run_attempt': 1, 'check_suite_id': suite,
                   'workflow_id': index, 'repository': origin, 'head_repository': origin, 'head_branch': branch,
                   'event': 'pull_request', 'head_sha': head, 'pull_requests': [link]}
            attempt = f'github/{run_id}/1'
            source = {**{field: self.plan[field] for field in CANDIDATE_FIELDS},
                      'plan': self.plan['id'], 'run': attempt}
            jobs, checks = [], []
            for job_id, (name, requirement) in enumerate(requirements.items(), run_id * 100):
                url = f'https://github.com/{REPO}/actions/runs/{run_id}/job/{job_id}'
                jobs.append({**PASS, 'id': job_id, 'name': name, 'html_url': url, 'head_sha': head,
                             'run_id': run_id, 'run_attempt': 1, 'runner_id': 1, 'labels': [requirement['runner']],
                             'steps': [{**PASS, 'name': step} for step in requirement['steps']]})
                checks.append({**PASS, 'id': job_id, 'name': name, 'details_url': url, 'head_sha': head,
                               'check_suite': {'id': suite}, 'app': {'id': ACTIONS_APP, 'slug': 'github-actions'}})
            self.snapshot['workflows'][workflow] = {
                'registration': {'path': workflow_path, 'state': 'active', 'id': index},
                'run': run, 'source': source, 'jobs': jobs, 'checks': checks,
            }
            names = self.plan['artifacts'].get(workflow, ())
            if names:
                artifacts = [{
                    'name': name, 'id': artifact_id, 'expired': False, 'digest': 'sha256:' + '1' * 64,
                    'size_in_bytes': 100, 'workflow_run': {
                        'id': run_id, 'head_sha': head, 'repository_id': REPO_ID, 'head_repository_id': REPO_ID,
                    },
                } for artifact_id, name in enumerate(names, run_id * 100)]
                self.snapshot['workflows'][workflow]['artifacts'] = [
                    {'total_count': len(artifacts), 'artifacts': artifacts},
                ]
            if workflow == SHADOW:
                attempt_plan = {**pilot, 'run': attempt}
                attempt_plan['id'] = digest(attempt_plan)
                for case, binding in self.plan['cases'].items():
                    self.write_receipt(case, binding, attempt_plan)
                for product in self.plan['products']:
                    self.pack_shadow(product)

    def write_receipt(self, case, binding, plan):
        product = binding_product(binding)
        directory = self.receipt(product).parent
        directory.mkdir(parents=True, exist_ok=True)
        observation, console, completion = binding_paths(directory, [binding])
        if product == 'framework':
            observation.write_text(f'running 1 test\ntest {binding["name"]} ... ok\n'
                                   'test result: ok. 1 passed; 0 failed; 0 ignored;\n')
            console.write_text('no processes left\n')
        else:
            marker = json.dumps({'name': binding['name'], 'implementation': binding['implementation']})
            console.write_text(f'{EDITOR_PASS}{marker}\nno processes left\n')
        completion.write_text(json.dumps(completion_record(plan, [binding], observation, console)))
        result = {'id': case, 'status': 'pass', 'binding': binding, 'log': observation.name, 'elapsed_ms': 1}
        self.receipt(product).write_text(json.dumps({
            'plan': plan['id'], **{field: plan[field] for field in ('revision', 'tree', 'platform', 'run')},
            'product': product, 'results': [result], 'preparation_ms': 0, 'rust': f'rustc {plan["rust"]} (fixture)',
            'editor': plan['editor'] if product == 'extension' else None,
            'node': f'v{plan["node_major"]}.0.0' if product == 'extension' else None,
        }))

    def receipt(self, product):
        return self.observations.parent / 'shadow' / product / 'receipt.json'

    def pack_shadow(self, product):
        name = f'shadow-pilot-{product}-1'
        directory = self.receipt(product).parent
        archive = directory.parent / f'{name}.zip'
        with ZipFile(archive, 'w') as output:
            for path in sorted(directory.iterdir()):
                output.write(path, path.name)
        entries = self.snapshot['workflows'][SHADOW]['artifacts'][0]['artifacts']
        entry = next(item for item in entries if item['name'] == name)
        contents = archive.read_bytes()
        entry.update(size_in_bytes=len(contents), digest='sha256:' + sha256(contents).hexdigest())
        return archive

    def evaluate(self, status, workflow=None, reason=None):
        self.observations.write_text(json.dumps(self.snapshot))
        result = decide(*self.arguments, self.observations)
        self.assertEqual(result['status'], status, result['blockers'])
        self.assertEqual(result['plan'], self.plan)
        if reason:
            self.assertTrue(any(
                item.get('workflow') == workflow and item['status'] == status and reason in item['reason']
                for item in result['blockers']
            ), result['blockers'])
        return result


class GateShadowTests(GateFixture, unittest.TestCase):
    def test_ide_only_has_an_explicit_empty_plan_and_needs_a_current_candidate(self):
        self.prepare('ide/src/change.ts')
        self.assertEqual(self.plan['route'], 'empty')
        self.assertEqual(self.plan['products'], ())
        self.assertEqual(self.plan['cases'], {})
        self.assertEqual(self.plan['workflows'], {})
        self.assertIn('documentation or IDE', self.plan['empty_reason'])
        self.assertEqual(decide(*self.arguments, None)['status'], 'pending')
        self.evaluate('success')
        self.snapshot['candidate']['main']['object']['sha'] = '1' * 40
        self.evaluate('pending', reason='main is ' + '1' * 40)

    def test_product_documentation_needs_only_the_shadow_catalog_job(self):
        self.prepare('docs/framework/example.md')
        self.assertEqual(list(self.plan['workflows'][SHADOW]), [CATALOG_JOB])
        workflow = self.snapshot['workflows'][SHADOW]
        catalog = workflow['jobs'][0]
        workflow['jobs'].append({**catalog, 'id': catalog['id'] + 1, 'name': REPORT_JOB, 'conclusion': 'skipped'})
        self.evaluate('success')
        del self.snapshot['workflows'][SHADOW]
        self.evaluate('pending', SHADOW, 'missing')

    def test_framework_change_proves_both_pilots_on_the_exact_test_merge(self):
        self.prepare('framework/crates/facade/src/cli.rs')
        self.assertEqual(self.plan['route'], 'framework')
        self.assertEqual(set(self.plan['workflows']), {SHADOW, FRAMEWORK, EXTENSION})
        self.git('checkout', '--detach', '-q', self.plan['merge'])
        result = self.evaluate('success')
        workflows = result['verified_workflows']
        self.assertEqual(workflows[SHADOW]['shadow_replay']['verified_cases'], {'framework': 1, 'extension': 1})
        self.assertIn('job_metadata', workflows[FRAMEWORK])
        self.assertEqual(set(workflows[FRAMEWORK]['artifact_manifest']),
                         {'framework-ssh-route-1', 'framework-keeper-recovery-1'})
        self.assertNotIn('shadow_replay', workflows[FRAMEWORK])

    def test_extension_change_needs_only_its_pilot_and_product_workflow(self):
        self.prepare('extension/src/extension.ts')
        self.assertEqual(self.plan['route'], 'extension')
        self.assertEqual(set(self.plan['workflows']), {SHADOW, EXTENSION})
        self.assertEqual(self.plan['products'], ('extension',))
        self.evaluate('success')
        receipt = self.receipt('extension')
        data = json.loads(receipt.read_text())
        receipt.write_text(json.dumps({**data, 'results': []}))
        archive = self.pack_shadow('extension')
        self.evaluate('failure', SHADOW, 'missing pilot results: extension/p0/panel/select')
        archive.unlink()
        self.evaluate('pending', SHADOW, 'missing extension pilot archive')

    def test_expanded_wire_change_needs_the_four_workflow_matrix_and_keeper_evidence(self):
        self.prepare('framework/crates/base/src/protocol/address.rs')
        self.assertEqual(self.plan['route'], 'expanded')
        self.assertEqual(set(self.plan['workflows']), {SHADOW, FRAMEWORK, EXTENSION, REMOTE})
        self.assertEqual(sum(len(jobs) for jobs in self.plan['workflows'].values()), 18)
        self.assertNotIn('Extension on linux-x64, legacy implementation', self.plan['workflows'][EXTENSION])
        self.assertIn('Extension on linux-x64, framework implementation', self.plan['workflows'][EXTENSION])
        self.evaluate('success')
        workflows = self.snapshot['workflows']
        linux = next(job for job in workflows[FRAMEWORK]['jobs'] if job['name'] == 'Framework on linux-x64')
        for name in ('Run and verify the exact Keeper recovery', 'Keep the Keeper recovery evidence'):
            step = next(step for step in linux['steps'] if step['name'] == name)
            with self.subTest(step=name), patch.dict(step, {'conclusion': 'skipped'}):
                self.evaluate('failure', FRAMEWORK, name)
        page = workflows[FRAMEWORK]['artifacts'][0]
        ssh = [entry for entry in page['artifacts'] if entry['name'] == 'framework-ssh-route-1']
        with patch.dict(page, {'total_count': len(ssh), 'artifacts': ssh}):
            self.evaluate('failure', FRAMEWORK, 'framework-keeper-recovery-1')
        remote = workflows.pop(REMOTE)
        self.evaluate('pending', REMOTE, 'missing')
        remote['run']['conclusion'] = 'cancelled'
        workflows[REMOTE] = remote
        self.evaluate('failure', REMOTE, 'completed with cancelled')

    def test_shared_policy_or_unclassified_paths_expand_scope(self):
        for path in ('ci/cases.json', 'docs/CI.md',
                     '.github/workflows/windows-install-check.yml', 'shared-new-input'):
            with self.subTest(path=path):
                route, products, workflows = select_workflows((path, 'ide/README.md'))
                self.assertEqual((route, products, set(workflows)),
                                 ('expanded', ('framework', 'extension'), set(REQUIRED)))
        self.assertEqual(select_workflows(('extension/package.json',)),
                         ('expanded', ('extension',), (SHADOW, EXTENSION, REMOTE)))
        self.assertEqual(select_workflows(('extension/src/base/names.ts',)),
                         ('framework', ('framework', 'extension'), (SHADOW, FRAMEWORK, EXTENSION)))

    def test_installer_route_uses_the_current_product_workflows(self):
        self.prepare('framework/install.ps1')
        self.assertEqual(self.plan['route'], 'expanded')
        self.assertEqual(set(self.plan['workflows']), {SHADOW, FRAMEWORK, EXTENSION})
        self.assertEqual(self.plan['unsupported_workflows'], {})
        self.evaluate('success')

    def test_policy_route_reports_a_missing_pr_trigger(self):
        self.prepare('docs/CI.md')
        self.evaluate('failure', FRAMEWORK, 'no changed path matches')

    def test_required_workflow_with_an_unknown_trigger_is_blocked(self):
        self.prepare('.github/workflows/extension-remote.yml')
        self.evaluate('failure', REMOTE, 'unsupported pull_request trigger')

    def test_native_package_route_uses_only_schedulable_required_workflows(self):
        self.prepare('extension/scripts/package.mjs')
        self.assertEqual(self.plan['route'], 'expanded')
        self.assertEqual(set(self.plan['workflows']), {SHADOW, EXTENSION, REMOTE})
        self.assertEqual(self.plan['unsupported_workflows'], {})
        self.evaluate('success')
        self.assertFalse(matches_workflow_path('extension/package/nested.json', 'extension/package*.json'))

    def test_accepts_the_manual_review_for_the_exact_expanded_evidence(self):
        self.prepare('framework/crates/base/src/protocol/address.rs')
        observed = self.snapshot['workflows']
        verified = self.evaluate('success')['verified_workflows']
        pilot = verified[SHADOW]['shadow_replay']
        shadow = {
            **{field: self.plan[field] for field in ('merge', 'tree')},
            'attempt': f'github/{verified[SHADOW]["run"]}/1', 'plan': pilot['plan'],
            'per_job': pilot['verified_cases'], 'artifact_ids': {
                product: verified[SHADOW]['artifact_manifest'][f'shadow-pilot-{product}-1']['id']
                for product in self.plan['products']
            },
        }
        native = {
            'typed_cases': TYPED_NATIVE_CASES,
            'release_fixture_cases': sorted(RELEASE_FIXTURE_CASES), 'package_targets': 6,
            'editor_passes': {name: NATIVE_EDITOR_MINIMUM for name in self.plan['artifacts'][EXTENSION]
                              if name.startswith('editor-tests-')},
        }
        replay = Mock(return_value=native)
        output = self.observations.parent / 'manual'
        output.mkdir()
        with patch.multiple(
            'merge_review',
            load=Mock(return_value=self.catalog),
            current_candidate=Mock(return_value={
                'repo_id': REPO_ID, 'branch': 'feature/11-fixture', 'draft': False,
                'merge': self.plan['merge'], 'tree': self.plan['tree'],
            }),
            registered_workflows=Mock(return_value={name: item['registration']['id'] for name, item in observed.items()}),
            current_runs=Mock(return_value={name: item['run'] for name, item in observed.items()}),
            verify_jobs=lambda repo, name, run: require_jobs(repo, name, run, observed[name]['jobs'],
                                                            observed[name]['checks']),
            required_artifacts=lambda repo, name, run: {
                entry['name']: entry for entry in observed[name]['artifacts'][0]['artifacts']
            },
            verify_hosted=Mock(return_value=shadow),
            replay_native=replay,
        ):
            self.snapshot['expanded_review'] = review(*self.arguments[:-1], output)
        replay.assert_called_once()
        self.assertEqual(self.evaluate('success')['expanded_review'], native)
        self.assertEqual(len(TYPED_NATIVE_CASES), 8)
        for incomplete in ({'typed_cases': TYPED_NATIVE_CASES[:-1]}, {'release_fixture_cases': []},
                           {'typed_cases': sorted([*TYPED_NATIVE_CASES, 'framework/p0/prior-build/cold-migration'])},
                           {'package_targets': 5}, {'editor_passes': {}},
                           {'editor_passes': dict.fromkeys(native['editor_passes'], NATIVE_EDITOR_MINIMUM - 1)}):
            with self.subTest(incomplete=incomplete), patch.dict(self.snapshot['expanded_review']['native'], incomplete):
                self.evaluate('failure', reason='expanded review does not cover the required native and release evidence')
        self.snapshot['expanded_review']['native_artifacts'][FRAMEWORK] = {}
        self.evaluate('pending', reason='expanded review is for different native artifacts')

    def test_stale_head_merge_tree_plan_and_attempt_cannot_pass(self):
        self.prepare('extension/src/extension.ts')
        candidate = self.snapshot['candidate']
        for record, field, reason in (
            (candidate['pull']['head'], 'sha', 'head changed'),
            (candidate['pull'], 'merge_commit_sha', 'test merge changed'),
            (candidate['merge']['tree'], 'sha', 'test merge tree is'),
        ):
            with self.subTest(field=field), patch.dict(record, {field: '2' * 40}):
                self.evaluate('pending', reason=reason)
        workflow = self.snapshot['workflows'][EXTENSION]
        for field in ('head', 'base', 'merge', 'tree', 'plan', 'run'):
            with self.subTest(field=field), patch.dict(workflow['source'], {field: 'stale'}):
                self.evaluate('pending', EXTENSION, f'stale {field}')
        with patch.dict(workflow['run'], {'run_attempt': 2}):
            self.evaluate('failure', EXTENSION, 'attempt 2')

    def test_head_must_include_the_observed_main_base(self):
        self.prepare('ide/src/change.ts', advance_main=True)
        self.evaluate('pending', reason='head needs the current main base')

    def test_incomplete_or_wrong_workflow_job_and_runner_cannot_pass(self):
        self.prepare('extension/src/extension.ts')
        workflow = self.snapshot['workflows'][EXTENSION]
        with patch.dict(workflow, {'run': None}), patch.dict(workflow['registration'], {'state': 'disabled_manually'}):
            self.evaluate('failure', EXTENSION, 'disabled_manually')
        with patch.dict(workflow['run'], {'status': 'queued', 'conclusion': None}):
            self.evaluate('pending', EXTENSION, 'status queued')
        with patch.dict(workflow['run'], {'event': 'workflow_dispatch'}):
            self.evaluate('failure', EXTENSION, 'another candidate or workflow')
        job = workflow['jobs'][0]
        with patch.dict(job, {'labels': ['ubuntu-24.04-arm']}):
            self.evaluate('failure', EXTENSION, 'runner label')
        with patch.dict(job, {'run_attempt': 2}):
            self.evaluate('failure', EXTENSION, 'different run, attempt or head')
        with patch.dict(job, {'steps': []}):
            self.evaluate('failure', EXTENSION, 'did not succeed exactly once')
        workflow['jobs'].pop(0)
        self.evaluate('pending', EXTENSION, f'missing jobs {job["name"]}')

    def test_wrong_receipt_platform_and_implementation_cannot_pass(self):
        self.prepare('extension/src/extension.ts')
        path = self.receipt('extension')
        receipt = json.loads(path.read_text())
        path.write_text(json.dumps({**receipt, 'platform': 'linux-arm64'}))
        self.pack_shadow('extension')
        self.evaluate('failure', SHADOW, 'source, plan, platform or attempt')
        result = receipt['results'][0]
        result['binding']['implementation'] = 'framework'
        path.write_text(json.dumps(receipt))
        archive = self.pack_shadow('extension')
        self.evaluate('failure', SHADOW, 'wrong runner, implementation or selector')
        contents = archive.read_bytes()
        archive.write_bytes(contents[1:] + contents[:1])
        self.evaluate('failure', SHADOW, 'does not match the GitHub digest')

    def test_local_source_must_match_the_merge_object_and_be_clean(self):
        self.prepare('ide/src/change.ts')
        with self.assertRaisesRegex(AcceptanceError, 'exact base and head'):
            candidate_plan(*self.arguments[:-1], self.plan['head'])
        self.write('ide/src/change.ts', 'dirty fixture\n')
        with self.assertRaisesRegex(AcceptanceError, 'clean reviewed checkout'):
            decide(*self.arguments, None)
