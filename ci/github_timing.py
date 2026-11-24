"""Record queue, build and test durations for a candidate's GitHub workflows."""

import argparse
from collections import defaultdict
from datetime import datetime
import json
import re
import subprocess
import sys


FEEDBACK_CONCLUSIONS = ('success', 'failure', 'timed_out', 'action_required')


class IncompleteJobList(ValueError):
    """GitHub did not return the full set of jobs for an attempt."""


def gh_json(*args):
    return json.loads(subprocess.check_output(['gh', 'api', *args], text=True, timeout=30))


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def seconds_between(start, end, diagnostics, field, *, expected=True):
    if start is None or end is None:
        if expected:
            diagnostics.append(f'{field} is unknown because a GitHub timestamp is missing or invalid')
        return None
    if end < start:
        diagnostics.append(f'{field} is unknown because GitHub timestamp {end.isoformat()} precedes {start.isoformat()}')
        return None
    return round((end - start).total_seconds(), 3)


def job_started_at(job):
    # GitHub fills started_at with the creation time even when no runner was assigned.
    return job.get('started_at') if job['runner_id'] else None


def job_sample(job):
    diagnostics = []
    created = job.get('created_at')
    started = job_started_at(job)
    finished = job.get('completed_at')
    runner_id = job['runner_id']
    cancelled = job['conclusion'] == 'cancelled'
    queue_end = started if runner_id else (finished if cancelled else None)
    return {
        'name': job['name'],
        'url': job['html_url'],
        'status': job['status'],
        'conclusion': job['conclusion'],
        'producing_attempt': job.get('run_attempt'),
        'runner_id': runner_id,
        'created_at': created,
        'started_at': started,
        'completed_at': finished,
        'queue_seconds': seconds_between(timestamp(created), timestamp(queue_end), diagnostics, 'queue_seconds',
                                         expected=runner_id or cancelled),
        'runner_seconds': seconds_between(timestamp(started), timestamp(finished), diagnostics, 'runner_seconds',
                                          expected=runner_id and job['status'] == 'completed'),
        'steps': [
            {
                'name': step['name'],
                'status': step['status'],
                'conclusion': step['conclusion'],
                'seconds': seconds_between(timestamp(step.get('started_at')), timestamp(step.get('completed_at')),
                                           diagnostics, f'Duration of step {step["name"]!r}',
                                           expected=step['conclusion'] in FEEDBACK_CONCLUSIONS),
            }
            for step in job['steps']
        ],
        **({'timing_diagnostics': diagnostics} if diagnostics else {}),
    }


def attempt_job_records(endpoint, run, number):
    pages = gh_json('--paginate', '--slurp', f'{endpoint}/attempts/{number}/jobs?per_page=100')
    jobs = [job for page in pages for job in page['jobs']]
    for job in jobs:
        if (job['run_id'], job['run_attempt'], job['head_sha']) != (run['id'], number, run['head_sha']):
            raise ValueError(f'Job {job["id"]} belongs to another candidate or attempt')
    if not pages or len(jobs) != pages[0]['total_count'] or len({job['id'] for job in jobs}) != len(jobs):
        raise IncompleteJobList(f'GitHub returned an incomplete job list for {run["id"]} attempt {number}')
    return jobs


def attempt_jobs(endpoint, run, number):
    return [job_sample(job) for job in attempt_job_records(endpoint, run, number)]


def execution_times(job):
    return (timestamp(job.get('created_at')), timestamp(job_started_at(job)), timestamp(job.get('completed_at')))


def execution_key(job, started, finished):
    return (job['name'], job['runner_id'], job['conclusion'], started, finished)


def has_completed_execution(job, times):
    created, started, finished = times
    queue_end = started if job['runner_id'] else finished
    return (job['status'] == 'completed' and created is not None and queue_end is not None
            and finished is not None and created <= queue_end <= finished)


def prior_executions(endpoint, run, first):
    executions = defaultdict(list)
    for number in range(1, run['run_attempt']):
        records = first if number == 1 else attempt_job_records(endpoint, run, number)
        for job in records:
            times = execution_times(job)
            if has_completed_execution(job, times):
                _, started, finished = times
                executions[execution_key(job, started, finished)].append(job)
    return executions


def latest_job_samples(endpoint, run, first):
    latest = attempt_job_records(endpoint, run, run['run_attempt'])
    observed = [(job, execution_times(job)) for job in latest]
    copies = {}
    for job, (created, started, finished) in observed:
        if (job['status'] == 'completed' and created is not None
                and any(time is not None and time < created for time in (started, finished))):
            copies[job['id']] = execution_key(job, started, finished)

    # A partial rerun assigns a new job ID and creation time to carried results.
    try:
        executions = prior_executions(endpoint, run, first) if copies else {}
    except (IncompleteJobList, OSError, subprocess.SubprocessError):
        executions = None

    jobs = []
    for job, times in observed:
        sample = job_sample(job)
        if job['id'] in copies:
            matches = executions.get(copies[job['id']], []) if executions is not None else []
            sample['queue_seconds'] = None
            sample['producing_attempt'] = None
            diagnostics = sample.setdefault('timing_diagnostics', [])
            if len(matches) == 1:
                original = matches[0]
                sample['producing_attempt'] = original['run_attempt']
                sample['producing_job_url'] = original['html_url']
                diagnostics.append(f'GitHub carried this result over from attempt {original["run_attempt"]}')
            elif executions is None:
                diagnostics.append('The producing attempt is unknown because earlier job records are unavailable')
            else:
                diagnostics.append('The execution predates job creation and has no unique earlier match')
        elif job['status'] == 'completed' and not has_completed_execution(job, times):
            sample['producing_attempt'] = None
            sample.setdefault('timing_diagnostics', []).append(
                'The producing attempt is unknown because execution timestamps are missing or inconsistent')
        jobs.append(sample)
    return jobs


def sample_workflow(repo, head, run_id):
    endpoint = f'repos/{repo}/actions/runs/{run_id}'
    run = gh_json(endpoint)
    if run['id'] != run_id or run['head_sha'] != head:
        raise ValueError(f'Run {run_id} does not belong to {head}')
    current = run['run_attempt']
    if type(current) is not int or current < 1:
        raise ValueError(f'Run {run_id} has an invalid attempt number')
    first = attempt_job_records(endpoint, run, 1)
    return {
        'name': run['name'],
        'path': run['path'],
        'id': run_id,
        'event': run['event'],
        'url': run['html_url'],
        'status': run['status'],
        'conclusion': run['conclusion'],
        'created_at': run.get('created_at'),
        'attempt': current,
        'first_attempt_jobs': [job_sample(job) for job in first],
        **({'latest_attempt_jobs': latest_job_samples(endpoint, run, first)} if current != 1 else {}),
    }


def sample_candidate(repo, head, runs):
    if len(set(runs)) != len(runs):
        raise ValueError('Supply each run ID once')
    workflows = [sample_workflow(repo, head, run_id) for run_id in runs]
    paths = {workflow['path'] for workflow in workflows}
    events = {workflow['event'] for workflow in workflows}
    if len(paths) != len(workflows) or len(events) != 1:
        raise ValueError('Supply one run per workflow for the same event')
    diagnostics = []
    creations = [timestamp(workflow['created_at']) for workflow in workflows]
    started = min(creations) if None not in creations else None
    first_jobs = [job for workflow in workflows for job in workflow['first_attempt_jobs']]
    current_jobs = [
        job for workflow in workflows
        for job in workflow.get('latest_attempt_jobs', workflow['first_attempt_jobs'])
    ]
    first_results = sorted(
        ((timestamp(job['completed_at']), job) for job in first_jobs if job['conclusion'] in FEEDBACK_CONCLUSIONS),
        key=lambda result: (result[0] is None, result[0]),
    )
    first_feedback = first_url = None
    if first_results:
        if first_results[-1][0] is None:
            diagnostics.append('first_feedback_seconds is unknown because an actionable job has no valid completion time')
        else:
            finished, first_job = first_results[0]
            first_feedback = seconds_between(started, finished, diagnostics, 'first_feedback_seconds')
            first_url = first_job['url']

    finishes = [timestamp(job['completed_at']) for job in current_jobs
                if job['completed_at'] is not None or (job['status'] == 'completed' and job['conclusion'] != 'skipped')]
    last_finish = max(finishes, default=None) if None not in finishes else None
    complete = all(workflow['status'] == 'completed' for workflow in workflows)
    wall = seconds_between(started, last_finish, diagnostics, 'wall_seconds') if complete else None

    runner_times = [job['runner_seconds'] for job in first_jobs if job['status'] == 'completed' and job['runner_id']]
    runner_total = None
    if None in runner_times:
        diagnostics.append('completed_first_attempt_runner_seconds is unknown because a completed job has unknown runner time')
    else:
        runner_total = sum(runner_times)
    return {
        'repository': repo,
        'head': head,
        'event': events.pop(),
        'first_feedback_seconds': first_feedback,
        'first_feedback_url': first_url,
        'first_attempt_failures': [
            {'name': job['name'], 'conclusion': job['conclusion'], 'url': job['url']}
            for _, job in first_results if job['conclusion'] != 'success'
        ],
        'wall_seconds': wall,
        'completed_first_attempt_runner_seconds': runner_total,
        'workflows': workflows,
        **({'timing_diagnostics': diagnostics} if diagnostics else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='GitHub repository as owner/name')
    parser.add_argument('--head', required=True, help='expected candidate head commit')
    parser.add_argument('runs', nargs='+', type=int)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('expected a GitHub repository as owner/name')
    if not re.fullmatch(r'[0-9a-f]{40}', args.head) or any(run <= 0 for run in args.runs):
        parser.error('expected a full commit SHA and positive run IDs')
    try:
        print(json.dumps(sample_candidate(args.repo, args.head, args.runs), indent=2))
    except (OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
        print(f'Could not measure this candidate: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
