"""Summarize first attempts for an explicit roster of eligible PR candidates."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

from catalog import read_json
from github_timing import FEEDBACK_CONCLUSIONS, timestamp


IDENTITY = ('repository', 'pull', 'head', 'base')
SERVICE_BREACHES = {'missing', 'cancelled', 'timed_out'}
RESOLVED_FAILURES = {'confirmed_false_red', 'confirmed_product_failure'}
TRIAGE_SECONDS = 48 * 60 * 60


def candidate_key(candidate):
    repository, pull, head, base = (candidate[field] for field in IDENTITY)
    if not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('A candidate needs a repository in owner/name form')
    if type(pull) is not int or pull <= 0:
        raise ValueError('A candidate needs a positive PR number')
    if not all(isinstance(sha, str) and re.fullmatch(r'[0-9a-f]{40}', sha) for sha in (head, base)):
        raise ValueError('A candidate needs full head and base commit SHAs')
    return repository.lower(), pull, head, base


def candidate_scope(candidate):
    key = candidate_key(candidate)
    paths = candidate.get('expected_workflow_paths')
    if (not isinstance(paths, list) or not paths
            or any(not isinstance(path, str) or not path.strip() for path in paths)
            or len(set(paths)) != len(paths)):
        raise ValueError(f'PR #{key[1]} needs a nonempty list of unique expected workflow paths')
    return key, paths


def load_timing(path, key, observed_at, claimed_runs):
    timing = read_json(path)
    repository, pull, head, _ = key
    recorded_repo = timing['repository']
    if (not isinstance(recorded_repo, str)
            or (recorded_repo.lower(), timing['head'], timing['event']) != (repository, head, 'pull_request')):
        raise ValueError(f'{path} has timing for a different repository, head, or event than PR #{pull}')
    workflows = timing['workflows']
    if not workflows or len({run['path'] for run in workflows}) != len(workflows):
        raise ValueError(f'{path} must contain one run per observed workflow')
    for run in workflows:
        run_id = run['id']
        if type(run_id) is not int or run_id <= 0 or run['event'] != 'pull_request':
            raise ValueError(f'{path} contains an invalid PR workflow run')
        run_key = (repository, run_id)
        if run_key in claimed_runs:
            raise ValueError(f'Run {run_id} can be assigned to only one candidate in {repository}')
        claimed_runs.add(run_key)

        records = [run, *run['first_attempt_jobs'], *run.get('latest_attempt_jobs', [])]
        if any(instant > observed_at for record in records for field in ('created_at', 'completed_at')
               if (instant := timestamp(record.get(field))) is not None):
            raise ValueError(f'Run {run_id} has timestamps after the roster observation cutoff')
    return timing


def workflow_result(workflows):
    conclusions = {run['conclusion'] for run in workflows if run['status'] == 'completed'}
    if 'timed_out' in conclusions or any(
        job['conclusion'] == 'timed_out' for run in workflows if run['status'] == 'completed'
        for job in run.get('latest_attempt_jobs', run['first_attempt_jobs'])
    ):
        return 'timed_out'
    if 'cancelled' in conclusions:
        return 'cancelled'
    if any(run['status'] != 'completed' for run in workflows):
        return 'pending'
    if 'failure' in conclusions:
        return 'completed_failure'
    return 'completed_success' if conclusions == {'success'} else 'completed_other'


def job_completion(job):
    finished = timestamp(job.get('completed_at'))
    if finished is not None and any(
        finished < start for name in ('created_at', 'started_at') if (start := timestamp(job.get(name))) is not None
    ):
        return None
    return finished


def first_attempt(workflows, eligible_at, observed_at, triage):
    jobs = [job for run in workflows for job in run['first_attempt_jobs']]
    results = [(job_completion(job), job['url'], job['conclusion']) for job in jobs
               if job['status'] == 'completed' and job['conclusion'] in FEEDBACK_CONCLUSIONS]
    failures = [finished for finished, _, conclusion in results if conclusion != 'success']
    first_feedback_seconds = first_feedback_url = None
    if results and all(finished is not None for finished, _, _ in results):
        finished, first_feedback_url, _ = min(results)
        first_feedback_seconds = max(0.0, round((finished - eligible_at).total_seconds(), 3))

    classification = 'unresolved' if failures else None
    failure_age = None
    if failures and None not in failures:
        failure_age = (observed_at - min(failures)).total_seconds()
    if triage is not None:
        if (not failures or triage['classification'] not in RESOLVED_FAILURES
                or not isinstance(triage['evidence'], str) or not triage['evidence'].strip()):
            raise ValueError('A resolved first failure needs an actionable failure and classification evidence')
        classification = triage['classification']
    return {
        'job_conclusions': dict(Counter(job['conclusion'] or 'unknown' for job in jobs)),
        'evaluated': bool(results),
        'first_feedback_seconds': first_feedback_seconds,
        'first_feedback_url': first_feedback_url,
        'failure_classification': classification,
        'failure_classification_evidence': triage['evidence'] if triage is not None else None,
        'first_failure_age_seconds': failure_age,
    }


def summarize(path):
    roster = read_json(path)
    observed_at = timestamp(roster['observed_at'])
    if observed_at is None or not isinstance(roster['candidates'], list) or not roster['candidates']:
        raise ValueError('Supply an observation cutoff with a timezone and a nonempty candidate list')

    inputs, latest = {}, {}
    eligibility = set()
    for candidate in roster['candidates']:
        key, expected_paths = candidate_scope(candidate)
        eligible_at = timestamp(candidate['eligible_at'])
        if eligible_at is None or eligible_at > observed_at:
            raise ValueError(f'PR #{key[1]} needs an eligibility time at or before the observation cutoff')
        if key in inputs:
            raise ValueError(f'Duplicate candidate {key}')
        pull_key = key[:2]
        if (pull_key, eligible_at) in eligibility:
            raise ValueError(f'PR #{key[1]} has candidates with the same eligibility time')
        eligibility.add((pull_key, eligible_at))
        inputs[key] = (candidate, eligible_at, expected_paths)
        if pull_key not in latest or eligible_at > latest[pull_key][0]:
            latest[pull_key] = (eligible_at, key)

    rows = []
    claimed_runs = set()
    for key, (candidate, eligible_at, expected_paths) in inputs.items():
        timing_path = candidate['timing']
        timing = (load_timing(path.parent / timing_path, key, observed_at, claimed_runs)
                  if timing_path is not None else None)
        workflows = timing['workflows'] if timing is not None else []
        observed = {run['path']: run for run in workflows}
        missing_paths = [workflow for workflow in expected_paths if workflow not in observed]
        required_runs = [observed[workflow] for workflow in expected_paths if workflow in observed]
        newest = latest[key[:2]][1]
        result = 'missing' if missing_paths else workflow_result(required_runs)
        rows.append({
            **dict(zip(IDENTITY, key)),
            'eligible_at': candidate['eligible_at'],
            'eligibility_evidence': candidate.get('eligibility_evidence'),
            'superseded_by': dict(zip(IDENTITY, newest)) if newest != key else None,
            'expected_workflow_paths': expected_paths,
            'observed_workflow_paths': list(observed),
            'missing_workflow_paths': missing_paths,
            'workflow_result': result,
            'counted_service_breach': newest == key and result in SERVICE_BREACHES,
            'first_attempt': first_attempt(required_runs, eligible_at, observed_at, candidate.get('first_failure_triage')),
            'timing': timing,
        })

    current = [row for row in rows if row['superseded_by'] is None]
    first_attempts = [row['first_attempt'] for row in rows]
    classes = Counter(attempt['failure_classification'] for attempt in first_attempts)
    unresolved_ages = [attempt['first_failure_age_seconds'] for attempt in first_attempts
                       if attempt['failure_classification'] == 'unresolved']
    overdue = sum(age is not None and age >= TRIAGE_SECONDS for age in unresolved_ages)
    return {
        'observed_at': roster['observed_at'],
        'scope': 'explicit candidate sample',
        'counts': {
            'eligible_candidates': len(rows),
            'latest_eligible_candidates': len(current),
            'superseded_candidates': len(rows) - len(current),
            'latest_workflow_results': dict(Counter(row['workflow_result'] for row in current)),
            'latest_service_failures_and_latency_breaches': sum(row['counted_service_breach'] for row in current),
            'latest_unknown_first_feedback_durations': sum(
                row['first_attempt']['first_feedback_seconds'] is None for row in current),
            'evaluated_first_attempts': sum(attempt['evaluated'] for attempt in first_attempts),
            'first_failure_classifications': {status: count for status, count in classes.items() if status is not None},
            'unresolved_first_failures_at_least_48h': overdue,
            'unresolved_first_failures_with_unknown_age': unresolved_ages.count(None),
            'first_failure_budget_charges': classes['confirmed_false_red'] + overdue,
        },
        'latency_p95_seconds': None,
        'limits': [
            'Population coverage depends on the supplied roster and workflow records.',
            'A latency P95 requires a rolling 30-day roster with at least 30 comparable candidates per cohort.',
            'The workflow evidence measures first feedback. Verified merge decision latency requires gate evidence.',
        ],
        'candidates': rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('roster', type=Path, help='JSON roster with eligibility times and saved GitHub timing records')
    args = parser.parse_args()
    try:
        print(json.dumps(summarize(args.roster), indent=2))
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f'Could not summarize CI candidates ({error})', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
