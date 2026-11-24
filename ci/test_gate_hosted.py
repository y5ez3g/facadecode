"""Local exercises of the protected reporter, its data checkout and matrix comparison."""

import json
import unittest
from unittest.mock import patch

from catalog import AcceptanceError, load
from gate_hosted import MAIN, WORKFLOW, checkout_candidate, render_summary, review, trusted_inputs
from gate_shadow import Pending
from merge_review import EXTENSION, FRAMEWORK, REMOTE, SHADOW
from test_gate_collect import CollectionFixture
from test_gate_shadow import PULL, REPO


class HostedReviewTests(CollectionFixture, unittest.TestCase):
    def hosted_review(self, *, policy=None):
        self.write_responses()
        return review(REPO, PULL, self.base if policy is None else policy, str(self.root), None,
                      self.observations.parent)

    def test_exact_checkout_reports_the_existing_matrix_and_gate_evidence(self):
        self.write('ide/fixture.txt', 'tracked data\n')
        (self.root / 'ide/link').symlink_to('fixture.txt')
        self.base = self.commit('base with existing IDE symlink')
        self.create_collection_fixture('extension/src/extension.ts')
        workflows = self.snapshot['workflows']
        remote_path = f'.github/workflows/{REMOTE}'
        remote_registration = {'path': remote_path, 'id': 99, 'state': 'active'}
        remote_run = {**workflows[EXTENSION]['run'], 'path': remote_path, 'workflow_id': 99,
                      'id': 999, 'conclusion': 'failure'}
        self.respond(f'{self.prefix}/actions/workflows?per_page=100', self.pages(
            'workflows', [item['registration'] for item in workflows.values()] + [remote_registration],
        ))
        self.respond(self.runs_endpoint, self.pages(
            'workflow_runs', [item['run'] for item in workflows.values()] + [remote_run],
        ))
        self.git('update-ref', f'refs/pull/{PULL}/merge', self.plan['merge'])

        result = self.hosted_review()
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['plan']['id'], self.plan['id'])
        self.assertEqual(set(result['matrix']), {SHADOW, FRAMEWORK, EXTENSION, REMOTE})
        self.assertEqual(result['matrix'][REMOTE]['conclusion'], 'failure')
        self.assertEqual(set(result['verified_workflows']), {SHADOW, EXTENSION})
        summary = render_summary(result, REPO, PULL, self.base)
        for key in ('head', 'base', 'merge', 'tree', 'id'):
            self.assertIn(self.plan[key], summary)
        self.assertIn('Cases replayed 1', summary)
        self.assertIn('Job and source metadata', summary)
        self.assertIn('`extension-remote.yml` | Matrix only |', summary)
        self.assertIn(f'https://github.com/{REPO}/actions/runs/999', summary)
        self.assertFalse(any('/runs/999/' in endpoint for endpoint in self.queries()))

    def test_moved_test_merge_is_rejected_before_checkout(self):
        self.prepare('ide/src/change.ts')
        self.git('update-ref', f'refs/pull/{PULL}/merge', self.plan['head'])
        root = self.observations.parent / 'fetched'
        with self.assertRaisesRegex(Pending, 'test merge changed'):
            checkout_candidate(root, str(self.root), PULL, self.plan['head'], self.base, self.plan, None)
        self.assertFalse((root / 'ci').exists())

    def test_new_candidate_symlink_is_rejected_before_checkout(self):
        link = self.root / 'ci/escaped.py'
        link.symlink_to(self.observations.parent / 'outside')
        head = self.commit('candidate adds a symlink')
        tree = self.git('rev-parse', 'HEAD^{tree}')
        merge = self.git('commit-tree', tree, '-p', self.base, '-p', head, '-m', 'test merge')
        self.git('update-ref', f'refs/pull/{PULL}/merge', merge)
        root = self.observations.parent / 'fetched'
        with self.assertRaisesRegex(AcceptanceError, 'new symlink or submodule at .*ci/escaped.py'):
            checkout_candidate(root, str(self.root), PULL, head, self.base, {'merge': merge, 'tree': tree}, None)
        self.assertFalse((root / 'ci').exists())

    def test_fork_and_stale_policy_stop_before_reading_workflow_evidence(self):
        self.create_collection_fixture('ide/src/change.ts')
        with self.assertRaisesRegex(Pending, 'expected ' + 'a' * 40):
            self.hosted_review(policy='a' * 40)
        candidate = self.snapshot['candidate']['pull']
        candidate['head'] = {**candidate['head'], 'repo': {'id': 99, 'full_name': 'other/fork'}}
        with self.assertRaisesRegex(Pending, 'same-repository'):
            self.hosted_review()
        self.assertTrue(all('/actions/' not in endpoint for endpoint in self.queries()))

    def test_retired_core_catalog_rejection_reports_the_exact_candidate_before_planning(self):
        case = 'core/window/command/open'
        catalog = {'version': 2, 'cases': [
            {'id': case, 'assertion': 'Open a window', 'stage': 'pr', 'existing_tests': []},
        ]}
        self.create_collection_fixture('ci/cases.json', contents=json.dumps(catalog))
        self.git('update-ref', f'refs/pull/{PULL}/merge', self.plan['merge'])
        with patch('gate_shadow.load', side_effect=load):
            result = self.hosted_review()
        self.assertEqual(result['status'], 'failure')
        self.assertNotIn('plan', result)
        self.assertNotIn('matrix', result)
        self.assertIn('invalid or duplicate case ID', result['blockers'][0]['reason'])
        self.assertIn(case, result['blockers'][0]['reason'])
        summary = render_summary(result, REPO, PULL, self.base)
        for key in ('head', 'base', 'merge', 'tree'):
            self.assertEqual(result['candidate'][key], self.plan[key])
            self.assertIn(self.plan[key], summary)
        self.assertIn(case, summary)
        self.assertTrue(all('/actions/' not in endpoint for endpoint in self.queries()))

    def test_dispatch_and_policy_checkout_must_match_main(self):
        env = {
            'GITHUB_REPOSITORY': REPO, 'GITHUB_WORKFLOW_SHA': self.base, 'CI_GATE_PR': str(PULL),
            'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': MAIN,
            'GITHUB_WORKFLOW_REF': f'{REPO}/{WORKFLOW}@{MAIN}',
        }
        self.assertEqual(trusted_inputs(env, self.root), (REPO, PULL, self.base))
        for change, message in (
            ({'GITHUB_REF': 'refs/heads/feature/11-other'}, 'dispatched from main'),
            ({'GITHUB_EVENT_NAME': 'pull_request_target'}, 'dispatched from main'),
            ({'GITHUB_WORKFLOW_REF': f'{REPO}/{WORKFLOW}@refs/heads/other'}, 'dispatched from main'),
            ({'GITHUB_WORKFLOW_SHA': 'a' * 40}, 'reviewer checkout differs'),
            ({'CI_GATE_PR': '-1'}, 'positive pull request number'),
        ):
            with self.subTest(change=change), self.assertRaisesRegex(AcceptanceError, message):
                trusted_inputs({**env, **change}, self.root)
        self.write('ci/gate_hosted.py', 'changed policy\n')
        with self.assertRaisesRegex(AcceptanceError, 'checkout must be clean'):
            trusted_inputs(env, self.root)

    def test_summary_keeps_candidate_text_inside_the_diagnostic_block(self):
        reason = 'bad data\n```\n::error::untrusted line'
        summary = render_summary({'status': 'failure', 'blockers': [{'status': 'failure', 'reason': reason}]})
        self.assertIn('bad data\\n```\\n::error::untrusted line', summary)
        self.assertNotIn('\n::error::', summary)
