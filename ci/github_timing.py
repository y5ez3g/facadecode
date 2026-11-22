"""Record queue, build and test durations for a candidate's GitHub workflows."""

import argparse
from datetime import datetime
import json
import re
import subprocess
import sys


def gh_json(*args):
    return json.loads(subprocess.check_output(['gh', 'api', *args], text=True, timeout=30))


def seconds_between(start, end):
    if start is None or end is None:
        return None
    seconds = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
    if seconds < 0:
        raise ValueError(f'GitHub timestamp {end} precedes {start}')
    return round(seconds, 3)


def job_sample(job):
    # GitHub fills started_at with the creation time even when no runner was assigned.
    started = job['started_at'] if job['runner_id'] else None
    finished = job['completed_at']
    queue_end = started if started else (finished if job['conclusion'] == 'cancelled' else None)
    return {
        'name': job['name'],
        'url': job['html_url'],
        'status': job['status'],
        'conclusion': job['conclusion'],
        'created_at': job['created_at'],
        'started_at': started,
        'completed_at': finished,
        'queue_seconds': seconds_between(job['created_at'], queue_end),
        'runner_seconds': seconds_between(started, finished),
        'steps': [
            {
                'name': step['name'],
                'status': step['status'],
                'conclusion': step['conclusion'],
                'seconds': seconds_between(step['started_at'], step['completed_at']),
            }
            for step in job['steps']
        ],
    }


def attempt_jobs(endpoint, run, number):
    pages = gh_json('--paginate', '--slurp', f'{endpoint}/attempts/{number}/jobs?per_page=100')
    jobs = [job for page in pages for job in page['jobs']]
    if not pages or len(jobs) != pages[0]['total_count'] or len({job['id'] for job in jobs}) != len(jobs):
        raise ValueError(f'GitHub returned an incomplete job list for {run["id"]} attempt {number}')
    for job in jobs:
        if (job['run_id'], job['run_attempt'], job['head_sha']) != (run['id'], number, run['head_sha']):
            raise ValueError(f'Job {job["id"]} belongs to another candidate or attempt')
    return [job_sample(job) for job in jobs]


def sample_workflow(repo, head, run_id):
    endpoint = f'repos/{repo}/actions/runs/{run_id}'
    run = gh_json(endpoint)
    if run['id'] != run_id or run['head_sha'] != head:
        raise ValueError(f'Run {run_id} does not belong to {head}')
    current = run['run_attempt']
    first = attempt_jobs(endpoint, run, 1)
    jobs = first if current == 1 else attempt_jobs(endpoint, run, current)
    return {
        'name': run['name'],
        'path': run['path'],
        'id': run_id,
        'event': run['event'],
        'url': run['html_url'],
        'status': run['status'],
        'conclusion': run['conclusion'],
        'created_at': run['created_at'],
        'attempt': current,
        'first_attempt_jobs': first,
        **({'latest_attempt_jobs': jobs} if current != 1 else {}),
    }


def sample_candidate(repo, head, runs):
    if len(set(runs)) != len(runs):
        raise ValueError('Supply each run ID once')
    workflows = [sample_workflow(repo, head, run_id) for run_id in runs]
    paths = {workflow['path'] for workflow in workflows}
    events = {workflow['event'] for workflow in workflows}
    if len(paths) != len(workflows) or len(events) != 1:
        raise ValueError('Supply one run per workflow for the same event')
    started = min(workflow['created_at'] for workflow in workflows)
    first_jobs = [job for workflow in workflows for job in workflow['first_attempt_jobs']]
    current_jobs = [
        job for workflow in workflows
        for job in workflow.get('latest_attempt_jobs', workflow['first_attempt_jobs'])
    ]
    first_results = sorted(
        (job for job in first_jobs if job['completed_at'] and job['conclusion'] in (
            'success', 'failure', 'timed_out', 'action_required'
        )), key=lambda job: job['completed_at'],
    )
    last_finish = max((job['completed_at'] for job in current_jobs if job['completed_at']), default=None)
    complete = all(workflow['status'] == 'completed' for workflow in workflows)
    return {
        'repository': repo,
        'head': head,
        'event': events.pop(),
        'first_feedback_seconds': seconds_between(started, first_results[0]['completed_at']) if first_results else None,
        'first_feedback_url': first_results[0]['url'] if first_results else None,
        'first_attempt_failures': [
            {'name': job['name'], 'conclusion': job['conclusion'], 'url': job['url']}
            for job in first_results if job['conclusion'] != 'success'
        ],
        'wall_seconds': seconds_between(started, last_finish) if complete else None,
        'completed_first_attempt_runner_seconds': sum(job['runner_seconds'] or 0 for job in first_jobs),
        'workflows': workflows,
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
