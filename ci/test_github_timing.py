from subprocess import TimeoutExpired
import unittest
from unittest.mock import patch

from github_timing import job_sample, sample_candidate


REPO = 'owner/name'
HEAD = 'a' * 40
RUN = 7
ENDPOINT = f'repos/{REPO}/actions/runs/{RUN}'


def job_record(job_id, attempt=1, **fields):
    return {
        'id': job_id, 'run_id': RUN, 'run_attempt': attempt, 'head_sha': HEAD,
        'name': 'Extension on linux-x64, old engine',
        'html_url': f'https://github.com/{REPO}/actions/runs/{RUN}/job/{job_id}',
        'runner_id': 3, 'status': 'completed', 'conclusion': 'success',
        'created_at': '2026-11-23T07:00:00Z', 'started_at': '2026-11-23T07:01:00Z',
        'completed_at': '2026-11-23T07:05:00Z', 'steps': [],
        **fields,
    }


def collect(jobs_by_attempt, **run_fields):
    def fetch(*args):
        if args == (ENDPOINT,):
            return {
                'id': RUN, 'head_sha': HEAD, 'run_attempt': max(jobs_by_attempt), 'name': 'Extension checks',
                'path': '.github/workflows/extension-check.yml', 'event': 'pull_request',
                'html_url': f'https://github.com/{REPO}/actions/runs/{RUN}',
                'status': 'completed', 'conclusion': 'success', 'created_at': '2026-11-23T07:00:00Z',
                **run_fields,
            }
        for attempt, jobs in jobs_by_attempt.items():
            if args == ('--paginate', '--slurp', f'{ENDPOINT}/attempts/{attempt}/jobs?per_page=100'):
                if isinstance(jobs, TimeoutExpired):
                    raise jobs
                if isinstance(jobs, dict):
                    return [jobs]
                return [{'total_count': len(jobs), 'jobs': jobs}]
        raise AssertionError(f'Unexpected GitHub request {args}')

    with patch('github_timing.gh_json', side_effect=fetch):
        return sample_candidate(REPO, HEAD, [RUN])


class HostedTiming(unittest.TestCase):
    def test_distinguishes_a_queued_cancellation_from_runner_time(self):
        job = {
            'name': 'Extension on darwin-arm64, Framework implementation',
            'html_url': 'https://github.com/owner/name/actions/runs/1/job/2',
            'created_at': '2026-11-22T08:57:38Z',
            'started_at': '2026-11-22T08:57:38Z',
            'completed_at': '2026-11-22T09:59:28Z',
            'runner_id': 0, 'status': 'completed', 'conclusion': 'cancelled', 'steps': [],
        }
        cancelled = job_sample(job)
        self.assertIsNone(cancelled['started_at'])
        self.assertEqual(cancelled['queue_seconds'], 3710)
        self.assertIsNone(cancelled['runner_seconds'])

        queued = job_sample({**job, 'completed_at': None, 'status': 'queued', 'conclusion': None})
        self.assertIsNone(queued['queue_seconds'])
        self.assertIsNone(queued['runner_seconds'])

        ran = job_sample({**job, 'runner_id': 3, 'conclusion': 'success', 'started_at': '2026-11-22T09:03:38Z'})
        self.assertEqual(ran['queue_seconds'], 360)
        self.assertEqual(ran['runner_seconds'], 3350)

    def test_reruns_keep_first_failure_and_link_the_executions_that_were_copied(self):
        step = {'name': 'Isolated editor journeys on Windows', 'status': 'completed', 'conclusion': 'failure',
                'started_at': '2026-11-23T07:02:00Z', 'completed_at': '2026-11-23T07:05:00Z'}
        windows = job_record(11, name='Extension on win32-x64, old engine', conclusion='failure', steps=[step])
        linux = job_record(12)
        second_linux = job_record(21, 2, name='Extension on linux-arm64, old engine',
                                  created_at='2026-11-23T07:20:00Z', started_at='2026-11-23T07:21:00Z',
                                  completed_at='2026-11-23T07:25:00Z')
        second_copy = job_record(22, 2, created_at=second_linux['created_at'])
        third_created = '2026-11-23T07:30:00Z'
        third_copy = job_record(31, 3, created_at=third_created)
        recent_copy = job_record(32, 3, name=second_linux['name'], created_at=third_created,
                                 started_at=second_linux['started_at'], completed_at=second_linux['completed_at'])
        recent_windows = job_record(33, 3, name=windows['name'], created_at=third_created,
                                    started_at='2026-11-23T07:31:00Z', completed_at='2026-11-23T07:35:00Z')

        report = collect({1: [windows, linux], 2: [second_linux, second_copy],
                          3: [third_copy, recent_copy, recent_windows]})
        workflow, = report['workflows']
        self.assertEqual(workflow['attempt'], 3)
        self.assertEqual(workflow['first_attempt_jobs'][0]['steps'][0]['conclusion'], 'failure')
        self.assertEqual(workflow['first_attempt_jobs'][0]['steps'][0]['seconds'], 180)
        self.assertEqual(workflow['first_attempt_jobs'][1]['queue_seconds'], 60)
        self.assertEqual(report['first_attempt_failures'], [
            {'name': windows['name'], 'conclusion': 'failure', 'url': windows['html_url']},
        ])
        self.assertEqual(report['first_feedback_seconds'], 300)
        self.assertEqual(report['wall_seconds'], 2100)
        self.assertEqual(report['completed_first_attempt_runner_seconds'], 480)
        copied_first, copied_second, fresh = workflow['latest_attempt_jobs']
        for sample, original in ((copied_first, linux), (copied_second, second_linux)):
            with self.subTest(producing_attempt=original['run_attempt']):
                self.assertEqual(sample['producing_attempt'], original['run_attempt'])
                self.assertEqual(sample['producing_job_url'], original['html_url'])
                self.assertIsNone(sample['queue_seconds'])
                self.assertEqual(sample['runner_seconds'], 240)
                self.assertTrue(sample['timing_diagnostics'])
        self.assertEqual(fresh['producing_attempt'], 3)
        self.assertEqual(fresh['queue_seconds'], 60)

    def test_only_a_unique_execution_provides_retry_provenance(self):
        copy = job_record(21, 2, created_at='2026-11-23T07:20:00Z')
        for originals in ([job_record(11, runner_id=1)], [job_record(11), job_record(12)]):
            with self.subTest(originals=len(originals)):
                report = collect({1: originals, 2: [copy]})
                sample, = report['workflows'][0]['latest_attempt_jobs']
                self.assertIsNone(sample['producing_attempt'])
                self.assertIsNone(sample['queue_seconds'])
                self.assertIn('no unique earlier match', ' '.join(sample['timing_diagnostics']))

    def test_unavailable_intermediate_history_keeps_the_first_attempt(self):
        failed = job_record(11, name='Extension on win32-x64, old engine', conclusion='failure')
        copy = job_record(31, 3, created_at='2026-11-23T07:30:00Z')
        rerun = job_record(32, 3, name=failed['name'], created_at=copy['created_at'],
                           started_at='2026-11-23T07:31:00Z', completed_at='2026-11-23T07:35:00Z')
        for history in (TimeoutExpired('gh', 30), {'total_count': 2, 'jobs': [job_record(21, 2)]}):
            with self.subTest(history=history):
                report = collect({1: [failed, job_record(12)], 2: history, 3: [copy, rerun]})

                self.assertEqual(report['first_attempt_failures'][0]['url'], failed['html_url'])
                copied, fresh = report['workflows'][0]['latest_attempt_jobs']
                self.assertIsNone(copied['producing_attempt'])
                self.assertIsNone(copied['queue_seconds'])
                self.assertIn('earlier job records are unavailable', ' '.join(copied['timing_diagnostics']))
                self.assertEqual(fresh['producing_attempt'], 3)

    def test_incomplete_latest_execution_times_leave_provenance_unknown(self):
        first = job_record(11, conclusion='failure')
        for field, value in (('created_at', None), ('started_at', None), ('completed_at', 'invalid'),
                             ('started_at', '2026-11-23T07:06:00Z')):
            with self.subTest(field=field, value=value):
                latest = job_record(21, 2, **{field: value})
                report = collect({1: [first], 2: [latest]})
                sample, = report['workflows'][0]['latest_attempt_jobs']
                self.assertIsNone(sample['producing_attempt'])
                self.assertNotIn('producing_job_url', sample)
                self.assertIn('execution timestamps are missing or inconsistent', ' '.join(sample['timing_diagnostics']))
                self.assertEqual(report['first_attempt_failures'][0]['url'], first['html_url'])

    def test_unknown_timing_does_not_hide_a_first_attempt_failure(self):
        step = {'name': 'Run npm test', 'status': 'completed', 'conclusion': 'failure',
                'started_at': '2026-11-23T07:01:00Z', 'completed_at': '2026-11-23T07:00:00Z'}
        failed = job_record(11, created_at='2026-11-23T07:02:00Z', completed_at='invalid',
                            conclusion='failure', steps=[step])
        report = collect({1: [failed, job_record(12, name='Other check')]}, conclusion='failure')
        sample = report['workflows'][0]['first_attempt_jobs'][0]
        self.assertEqual(report['first_attempt_failures'], [
            {'name': failed['name'], 'conclusion': 'failure', 'url': failed['html_url']},
        ])
        self.assertEqual(sample['steps'][0]['conclusion'], 'failure')
        self.assertIsNone(sample['steps'][0]['seconds'])
        self.assertIsNone(sample['queue_seconds'])
        self.assertIsNone(sample['runner_seconds'])
        self.assertEqual(len(sample['timing_diagnostics']), 3)
        for field in ('first_feedback_seconds', 'wall_seconds', 'completed_first_attempt_runner_seconds'):
            with self.subTest(field=field):
                self.assertIsNone(report[field])
                self.assertIn(field, ' '.join(report['timing_diagnostics']))

    def test_rejects_run_and_job_identity_mismatches(self):
        first = job_record(11)
        for fields in ({'id': RUN + 1}, {'head_sha': 'b' * 40}, {'run_attempt': 0}):
            with self.subTest(run=fields), self.assertRaisesRegex(ValueError, f'Run {RUN}'):
                collect({1: [first]}, **fields)

        copied = job_record(31, 3, created_at='2026-11-23T07:30:00Z')
        for attempt, job in ((1, first), (2, job_record(21, 2)), (3, copied)):
            for fields in ({'run_id': RUN + 1}, {'head_sha': 'b' * 40}, {'run_attempt': attempt + 1}):
                jobs = {1: [first], 2: [], 3: [copied]}
                records = [{**job, **fields}]
                jobs[attempt] = {'total_count': 2, 'jobs': records} if attempt == 2 else records
                with self.subTest(attempt=attempt, job=fields), self.assertRaisesRegex(ValueError, 'belongs'):
                    collect(jobs)
