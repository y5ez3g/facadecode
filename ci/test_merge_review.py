from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from catalog import AcceptanceError, Case
from github_main_health import first_attempt_state
from merge_review import (
    ACTIONS_APP, REMOTE, REQUIRED, RUNNERS, current_candidate, current_runs, listed, require_catalog_minimum, require_jobs,
)
from merge_review_native import (
    OLD_EXPIRED_REOPEN, OLD_IMMEDIATE_REOPEN, OLD_WINDOW_GRACE_CASE, check_old_window_grace, editor_passes,
)


REPO, PULL = 'owner/repo', 11
HEAD, BASE, MERGE, TREE = (char * 40 for char in 'abcd')


class ExpandedReview(unittest.TestCase):
    def setUp(self):
        self.candidate = {'repo_id': 42, 'branch': 'feature/11-ci', 'draft': True, 'merge': MERGE, 'tree': TREE}
        self.workflows = {name: index for index, name in enumerate(REQUIRED, 1)}
        self.link = {'number': PULL, 'head': {'sha': HEAD}, 'base': {'sha': BASE}}
        self.runs = [{
            'id': 100 + index, 'path': f'.github/workflows/{name}', 'workflow_id': index,
            'repository': {'id': 42}, 'head_branch': 'feature/11-ci', 'head_repository': {'id': 42},
            'head_sha': HEAD, 'event': 'pull_request', 'pull_requests': [self.link],
            'status': 'completed', 'conclusion': 'success', 'run_attempt': 1, 'check_suite_id': index + 1000,
        } for name, index in self.workflows.items()]

    def test_catalog_minimum_retains_the_meaning_and_bound_selector(self):
        case_id = 'core/shell/command/start'
        binding = {'name': 'starts_one_cli'}
        old = {'id': case_id, 'assertion': 'starts one CLI', 'stage': 'pr', 'test': binding}
        case = Case(case_id, 'pr', old['assertion'], (), binding)
        require_catalog_minimum({case_id: case}, [old])
        require_catalog_minimum({case_id: case}, [{**old, 'test': None}])
        for changed in ({}, {case_id: Case(case_id, 'release', case.assertion, (), binding)},
                        {case_id: Case(case_id, 'pr', 'weaker assertion', (), binding)},
                        {case_id: Case(case_id, 'pr', case.assertion, (), None)},
                        {case_id: Case(case_id, 'pr', case.assertion, (), {'name': 'other'})}):
            with self.subTest(changed=changed), self.assertRaisesRegex(AcceptanceError, case_id):
                require_catalog_minimum(changed, [old])

    def test_a_new_api_needs_a_binding_while_visible_backlog_is_preserved(self):
        old_id = 'core/shell/command/list'
        new_id = 'core/shell/command/screen'
        old = Case(old_id, 'pr', 'List visible agents.', (), None)
        new = Case(new_id, 'pr', 'Read the chosen screen.', (), None)
        baseline = [{'id': old.id, 'assertion': old.assertion, 'stage': old.stage}]
        require_catalog_minimum({old_id: old}, baseline)
        with self.assertRaisesRegex(AcceptanceError, new_id):
            require_catalog_minimum({old_id: old, new_id: new}, baseline)
        bound = Case(new_id, new.stage, new.assertion, (), {'name': 'reads_the_exact_screen'})
        require_catalog_minimum({old_id: old, new_id: bound}, baseline)

    def test_current_base_head_and_merge_parents_are_exact(self):
        origin = {'id': 42, 'full_name': REPO}
        pull = {**self.link, 'state': 'open', 'draft': True, 'merge_commit_sha': MERGE, 'mergeable': True,
                'base': {'sha': BASE, 'ref': 'main', 'repo': origin},
                'head': {'sha': HEAD, 'repo': origin, 'ref': 'feature/11-ci'}}
        main = {'object': {'sha': BASE}}
        commit = {'sha': MERGE, 'tree': {'sha': TREE}, 'parents': [{'sha': BASE}, {'sha': HEAD}]}
        arguments = (REPO, PULL, HEAD, BASE)
        with patch('merge_review.gh_json', side_effect=[pull, main, commit]):
            self.assertEqual(current_candidate(*arguments), self.candidate)
        for responses in ([{**pull, 'mergeable': False}, main, commit],
                          [pull, {'object': {'sha': HEAD}}, commit],
                          [pull, main, {**commit, 'parents': [{'sha': HEAD}, {'sha': BASE}]}]):
            with self.subTest(responses=responses), patch('merge_review.gh_json', side_effect=responses), (
                    self.assertRaises(AcceptanceError)):
                current_candidate(*arguments)

    def test_run_identity_cannot_be_replaced_by_a_stale_duplicate_or_later_attempt(self):
        def list_runs(records):
            page = {'total_count': len(records), 'workflow_runs': records}
            with patch('merge_review.gh_json', return_value=[page]):
                return current_runs(REPO, PULL, HEAD, BASE, self.candidate, self.workflows)

        self.assertEqual(len(list_runs(self.runs)), 5)
        with self.assertRaisesRegex(AcceptanceError, 'no current run'):
            list_runs(self.runs[:-1])
        first = self.runs[0]
        for change in (
            {'run_attempt': 2}, {'status': 'in_progress', 'conclusion': None}, {'conclusion': 'cancelled'},
            {'workflow_id': 99}, {'head_sha': MERGE}, {'head_branch': 'main'}, {'head_repository': {'id': 1}},
            {'pull_requests': []}, {'pull_requests': [{**self.link, 'base': {'sha': TREE}}]},
        ):
            with self.subTest(change=change), self.assertRaises(AcceptanceError):
                list_runs([{**first, **change}, *self.runs[1:]])
        with self.assertRaisesRegex(AcceptanceError, 'more than one run'):
            list_runs([*self.runs, {**first, 'id': 211}])
        with self.assertRaisesRegex(AcceptanceError, 'no identifiable pull request'):
            list_runs([*self.runs, {**first, 'id': 211, 'pull_requests': []}])

    def test_requires_a_matching_passing_job_check_runner_and_runtime_step(self):
        run = self.runs[-1]
        name, steps = next(iter(REQUIRED[REMOTE].items()))
        job_id = 311
        url = f'https://github.com/{REPO}/actions/runs/{run["id"]}/job/{job_id}'
        passed = {'status': 'completed', 'conclusion': 'success'}
        job = {'id': job_id, 'name': name, **passed, 'runner_id': 1, 'html_url': url, 'labels': [RUNNERS[name]],
               'steps': [{'name': step, **passed} for step in steps]}
        check = {'id': job_id, 'name': name, **passed, 'details_url': url, 'head_sha': HEAD,
                 'app': {'id': ACTIONS_APP, 'slug': 'github-actions'}, 'check_suite': {'id': run['check_suite_id']}}
        self.assertEqual(require_jobs(REPO, REMOTE, run, [job], [check]), {name: job_id})
        for change in ({'labels': ['ubuntu-24.04-arm']}, {'steps': []}, {'runner_id': 0},
                       {'steps': [*job['steps'], job['steps'][0]]}, {'conclusion': 'skipped'}):
            with self.subTest(change=change), self.assertRaises(AcceptanceError):
                require_jobs(REPO, REMOTE, run, [{**job, **change}], [check])
        for change in ({'app': {'id': 1, 'slug': 'github-actions'}}, {'head_sha': BASE}, {'check_suite': {'id': 1}},
                       {'conclusion': 'cancelled'}, {'details_url': url.replace(str(job_id), '312')}):
            with self.subTest(change=change), self.assertRaises(AcceptanceError):
                require_jobs(REPO, REMOTE, run, [job], [{**check, **change}])
        with self.assertRaisesRegex(AcceptanceError, 'missing, unexpected or duplicate'):
            require_jobs(REPO, REMOTE, run, [job, deepcopy(job)], [check])

    def test_pagination_refuses_an_inconsistent_page_or_repeated_id(self):
        first = {'total_count': 2, 'runs': [{'id': 1}]}
        second = {'total_count': 2, 'runs': [{'id': 2}]}
        self.assertEqual(len(listed('runs', [first, second], 'runs')), 2)
        for changed in ({**second, 'total_count': 1}, {**second, 'runs': [{'id': 1}]}):
            with self.subTest(changed=changed), self.assertRaises(AcceptanceError):
                listed('runs', [first, changed], 'runs')

    def test_a_clean_later_attempt_cannot_hide_the_original_main_failure(self):
        current = {'run_attempt': 2, 'status': 'completed', 'conclusion': 'success'}
        first_failure = {'name': 'Shadow pilot (extension)', 'conclusion': 'failure',
                         'html_url': 'https://example.test/job', 'steps': [
                             {'name': 'Run and verify selected cases', 'conclusion': 'failure'},
                         ]}
        status, _, failures = first_attempt_state(current, [first_failure])
        self.assertEqual(status, 'hold')
        self.assertEqual(failures[0]['steps'], ['Run and verify selected cases'])
        self.assertEqual(first_attempt_state(current, [])[0], 'hold')
        self.assertEqual(first_attempt_state({**current, 'run_attempt': 1, 'status': 'in_progress'}, [])[0], 'pending')

    def test_native_editor_needs_executed_tests_and_completed_cleanup(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'integration.log'
            complete = 'Isolated editor profile cleanup finished.\n'
            passed = '\x1b[32m 2 passing\x1b[0m\n'
            path.write_text(passed + ' 59 passing (5s)\n' + complete)
            self.assertEqual(editor_passes(path), 61)
            for output in (complete, passed, passed + complete, passed + complete * 2,
                           '61 passing\n 1 failing\n' + complete,
                           '0 passing\n' + complete):
                path.write_text(output)
                with self.subTest(output=output), self.assertRaises(AcceptanceError):
                    editor_passes(path)

    def test_old_window_grace_requires_both_reopens_the_natural_exit_and_cleanup(self):
        before = {'phase': 'folder', 'runId': 'run-' + '1' * 32, 'pid': 40, 'session': 'native-session'}
        closed = {'phase': 'closed', 'host': 38}
        after = {**before, 'phase': 'reopened', 'terminals': 1}
        reopened = {**after, 'runId': 'run-' + '2' * 32, 'pid': 41}
        early = OLD_IMMEDIATE_REOPEN + json.dumps([before, closed, after])
        timing = "✔ claude: the closed window's process ended after 89605 ms, using the production grace period"
        late = OLD_EXPIRED_REOPEN + json.dumps([before, closed, reopened])
        cleanup = 'Isolated editor profile cleanup finished.'
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'integration.log'
            path.write_text('\n'.join((early, timing, late, cleanup)))
            self.assertEqual(check_old_window_grace(path), OLD_WINDOW_GRACE_CASE)
            for observation in ((early, late, cleanup), (late, timing, early, cleanup), (early, timing, late),
                                (early, timing.replace('89605', '1200'), late, cleanup),
                                (early, timing, late.replace('"pid": 41', '"pid": 40'), cleanup),
                                (early, timing, late.replace('"terminals": 1', '"terminals": 2'), cleanup),
                                (early, timing, late.replace('"phase": "reopened"', '"phase": "other"'), cleanup),
                                (early, timing, late.replace('"session": "native-session", "terminals"',
                                                             '"session": "other-session", "terminals"'), cleanup)):
                path.write_text('\n'.join(observation))
                with self.subTest(observation=observation), self.assertRaises(AcceptanceError):
                    check_old_window_grace(path)
