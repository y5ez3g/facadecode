import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from github_candidate_summary import summarize


OBSERVED = '2026-11-25T07:05:00Z'
CORE = '.github/workflows/core-check.yml'
EXTENSION = '.github/workflows/extension-check.yml'


def candidate(pull, head, timing, **fields):
    return {'repository': 'owner/name', 'pull': pull, 'head': head * 40, 'base': 'c' * 40,
            'eligible_at': '2026-11-23T07:00:00Z', 'expected_workflow_paths': [EXTENSION], 'timing': timing, **fields}


def job(conclusion, finish='2026-11-23T07:05:00Z', **fields):
    return {'url': f'https://github.com/owner/name/actions/jobs/{conclusion}', 'conclusion': conclusion,
            'status': 'completed', 'created_at': '2026-11-23T07:00:00Z', 'completed_at': finish,
            'steps': [], **fields}


class CandidateSummary(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / 'roster.json'

    def roster(self, *candidates):
        self.path.write_text(json.dumps({'observed_at': OBSERVED, 'candidates': candidates}))
        return self.path

    def timing(self, name, run_id, head, first_jobs, **fields):
        run = {'id': run_id, 'event': 'pull_request', 'path': EXTENSION,
               'attempt': 1, 'status': 'completed', 'conclusion': 'success', 'first_attempt_jobs': first_jobs,
               **fields}
        saved = {'repository': 'owner/name', 'event': 'pull_request', 'head': head * 40, 'workflows': [run]}
        (self.path.parent / name).write_text(json.dumps(saved))
        return saved

    def test_cli_counts_missing_and_newest_cancellation_and_preserves_first_attempts(self):
        failed = job('failure', steps=[{'name': 'Run npm test', 'conclusion': 'failure', 'seconds': None}])
        cancelled = job('cancelled', runner_id=0, runner_seconds=None, queue_seconds=300)
        old_timing = self.timing('old.json', 41, 'a', [failed, cancelled], conclusion='cancelled')
        new_timing = self.timing('new.json', 42, 'a', [cancelled], conclusion='cancelled')
        retry_timing = self.timing('retry.json', 53, 'b', [failed], attempt=2,
                                   latest_attempt_jobs=[job('success', '2026-11-23T07:20:00Z')])
        older = candidate(4, 'a', 'old.json')
        newer = candidate(4, 'a', 'new.json', base='d' * 40, eligible_at='2026-11-23T07:01:00Z')
        missing = candidate(5, 'e', None)
        rerun = candidate(6, 'b', 'retry.json')
        roster = self.roster(newer, older, missing, rerun)
        output = subprocess.check_output([sys.executable, '-B', str(Path(__file__).with_name(
            'github_candidate_summary.py')), str(roster)], text=True)
        report = json.loads(output)
        newest_row, older_row, missing_row, rerun_row = report['candidates']
        self.assertEqual(older_row['superseded_by'], {field: newer[field] for field in
                                                     ('repository', 'pull', 'head', 'base')})
        for row, state in ((newest_row, 'cancelled'), (missing_row, 'missing')):
            self.assertEqual(row['workflow_result'], state)
            self.assertIsNone(row['superseded_by'])
            self.assertTrue(row['counted_service_breach'])
            self.assertIsNone(row['first_attempt']['first_feedback_seconds'])
        self.assertFalse(older_row['counted_service_breach'])
        self.assertEqual(newest_row['first_attempt']['job_conclusions'], {'cancelled': 1})
        self.assertEqual(missing_row['observed_workflow_paths'], [])
        self.assertEqual(missing_row['missing_workflow_paths'], [EXTENSION])
        self.assertEqual((newest_row['timing'], older_row['timing'], missing_row['timing'], rerun_row['timing']),
                         (new_timing, old_timing, None, retry_timing))
        self.assertEqual(rerun_row['first_attempt']['failure_classification'], 'unresolved')
        self.assertEqual(rerun_row['first_attempt']['first_feedback_seconds'], 300)
        self.assertEqual(report['counts'], {
            'eligible_candidates': 4, 'latest_eligible_candidates': 3, 'superseded_candidates': 1,
            'latest_workflow_results': {'cancelled': 1, 'missing': 1, 'completed_success': 1},
            'latest_service_failures_and_latency_breaches': 2, 'latest_unknown_first_feedback_durations': 2,
            'evaluated_first_attempts': 2, 'first_failure_classifications': {'unresolved': 2},
            'unresolved_first_failures_at_least_48h': 2, 'unresolved_first_failures_with_unknown_age': 0,
            'first_failure_budget_charges': 2,
        })
        self.assertIsNone(report['latency_p95_seconds'])

    def test_missing_required_workflow_beside_a_success_and_completed_outcomes(self):
        timing = self.timing('timing.json', 11, 'a', [job('success')])
        roster = self.roster(candidate(1, 'a', 'timing.json', expected_workflow_paths=[EXTENSION, CORE]))
        partial = summarize(roster)
        row, = partial['candidates']
        self.assertEqual(row['expected_workflow_paths'], [EXTENSION, CORE])
        self.assertEqual(row['observed_workflow_paths'], [EXTENSION])
        self.assertEqual(row['missing_workflow_paths'], [CORE])
        self.assertEqual(row['workflow_result'], 'missing')
        self.assertTrue(row['counted_service_breach'])
        self.assertEqual(row['timing'], timing)
        self.assertEqual(row['first_attempt']['job_conclusions'], {'success': 1})
        self.assertEqual(row['first_attempt']['first_feedback_seconds'], 300)
        self.assertEqual(partial['counts']['latest_workflow_results'], {'missing': 1})
        self.assertEqual(partial['counts']['latest_service_failures_and_latency_breaches'], 1)

        extension, = timing['workflows']
        for conclusion, result in (('success', 'completed_success'), ('failure', 'completed_failure'),
                                   ('neutral', 'completed_other')):
            with self.subTest(required_conclusion=conclusion):
                core = {**extension, 'id': 12, 'path': CORE, 'conclusion': conclusion,
                        'first_attempt_jobs': [job(conclusion)]}
                full = {**timing, 'workflows': [extension, core]}
                (self.path.parent / 'timing.json').write_text(json.dumps(full))
                report = summarize(roster)
                row, = report['candidates']
                self.assertEqual(row['observed_workflow_paths'], [EXTENSION, CORE])
                self.assertEqual(row['missing_workflow_paths'], [])
                self.assertEqual(row['workflow_result'], result)
                self.assertFalse(row['counted_service_breach'])
                self.assertEqual(report['counts']['latest_workflow_results'], {result: 1})

    def test_retains_raw_jobs_from_workflows_outside_the_expected_paths(self):
        timing = self.timing('timing.json', 11, 'a', [job('success')])
        extension, = timing['workflows']
        timing['workflows'].append({**extension, 'path': CORE, 'id': 12, 'conclusion': 'failure',
                                    'first_attempt_jobs': [job('failure')]})
        (self.path.parent / 'timing.json').write_text(json.dumps(timing))

        report = summarize(self.roster(candidate(1, 'a', 'timing.json')))
        row, = report['candidates']
        self.assertEqual(row['observed_workflow_paths'], [EXTENSION, CORE])
        self.assertEqual(row['workflow_result'], 'completed_success')
        self.assertEqual(row['first_attempt']['job_conclusions'], {'success': 1})
        self.assertEqual(row['timing'], timing)

    def test_unknown_failure_timing_and_reviewed_classifications(self):
        self.timing('unknown.json', 11, 'a', [job('failure', None), job('success')], conclusion='failure')
        self.timing('known.json', 12, 'b', [job('failure')], conclusion='failure')
        triage = {'classification': 'confirmed_false_red', 'evidence': 'Verified dependency timeout in fixture logs'}
        report = summarize(self.roster(candidate(1, 'a', 'unknown.json'),
                                      candidate(2, 'b', 'known.json', eligible_at='2026-11-23T07:06:00Z',
                                                first_failure_triage=triage)))
        unknown, known = [row['first_attempt'] for row in report['candidates']]
        self.assertTrue(unknown['evaluated'])
        self.assertIsNone(unknown['first_feedback_seconds'])
        self.assertIsNone(unknown['first_failure_age_seconds'])
        self.assertEqual(unknown['failure_classification'], 'unresolved')
        self.assertEqual(known['first_feedback_seconds'], 0)
        self.assertEqual(known['failure_classification'], 'confirmed_false_red')
        self.assertEqual(known['failure_classification_evidence'], triage['evidence'])
        self.assertEqual(report['counts']['unresolved_first_failures_with_unknown_age'], 1)
        self.assertEqual(report['counts']['first_failure_budget_charges'], 1)

    def test_keeps_pending_and_timed_out_results_in_the_latest_denominator(self):
        self.timing('pending.json', 11, 'a', [job(None, None, status='queued')], status='queued', conclusion=None)
        self.timing('timeout.json', 12, 'b', [job('timed_out')], conclusion='failure')
        report = summarize(self.roster(candidate(1, 'a', 'pending.json'), candidate(2, 'b', 'timeout.json')))
        pending, timed_out = report['candidates']
        self.assertEqual(pending['workflow_result'], 'pending')
        self.assertFalse(pending['counted_service_breach'])
        self.assertIsNone(pending['first_attempt']['first_feedback_seconds'])
        self.assertEqual(timed_out['workflow_result'], 'timed_out')
        self.assertTrue(timed_out['counted_service_breach'])
        self.assertEqual(timed_out['first_attempt']['job_conclusions'], {'timed_out': 1})
        self.assertEqual(report['counts']['latest_eligible_candidates'], 2)

    def test_rejects_duplicate_or_unverified_roster_bindings(self):
        self.timing('first.json', 10, 'a', [job('success')])
        self.timing('future.json', 11, 'b', [job('success', '2026-11-25T07:05:01Z')])
        first = candidate(1, 'a', 'first.json')
        for records, error in (
            ([first, {**first, 'repository': 'Owner/Name'}], 'Duplicate candidate'),
            ([first, candidate(1, 'b', None)], 'same eligibility time'),
            ([first, candidate(2, 'a', 'first.json')], 'only one candidate'),
            ([candidate(1, 'b', 'first.json')], 'different repository, head, or event'),
            ([candidate(2, 'b', 'future.json')], 'after the roster observation cutoff'),
            ([{**first, 'expected_workflow_paths': []}], 'unique expected workflow paths'),
            ([{**first, 'expected_workflow_paths': [EXTENSION, EXTENSION]}], 'unique expected workflow paths'),
            ([{**first, 'first_failure_triage': {'classification': 'confirmed_false_red', 'evidence': 'note'}}],
             'needs an actionable failure'),
        ):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                summarize(self.roster(*records))
