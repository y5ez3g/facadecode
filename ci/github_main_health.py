"""Inspect the current main shadow result, retaining the original attempt."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile

from catalog import AcceptanceError, PRODUCTS
from evidence import git, verify_receipts
from github_evidence import SHA, WORKFLOW, artifact_manifest, download_receipts
from github_timing import attempt_job_records, gh_json
from merge_review import SHADOW, listed, require_checkout, verify_jobs


ROOT = Path(__file__).resolve().parents[1]


def main_position(repo, head):
    branch = gh_json(f'repos/{repo}/git/ref/heads/main')
    if branch['ref'] != 'refs/heads/main' or branch['object']['sha'] != head:
        raise AcceptanceError('main moved from the requested commit')
    organization = gh_json(f'repos/{repo}')
    if organization['full_name'].lower() != repo.lower():
        raise AcceptanceError('GitHub returned a different repository')
    return organization['id']


def matching_run(repo, head, repo_id):
    workflow = gh_json(f'repos/{repo}/actions/workflows/{SHADOW}')
    if workflow['path'] != WORKFLOW or workflow['state'] != 'active':
        raise AcceptanceError('the main shadow workflow is not registered and active')
    pages = gh_json('--paginate', '--slurp', f'repos/{repo}/actions/workflows/{workflow["id"]}/runs'
                    f'?event=push&branch=main&head_sha={head}&per_page=100')
    runs = listed('main shadow runs', pages, 'workflow_runs')
    if not runs:
        return None
    if len(runs) != 1:
        raise AcceptanceError('more than one push run claims the current main commit')
    run = runs[0]
    if (run['workflow_id'], run['path'], run['event'], run['head_branch'], run['head_sha'],
        run['repository']['id'], run['head_repository']['id']) != (
            workflow['id'], WORKFLOW, 'push', 'main', head, repo_id, repo_id):
        raise AcceptanceError('the workflow result is for a different main position')
    return run


def first_attempt_state(run, jobs):
    failures = [{
        'name': job['name'], 'conclusion': job['conclusion'], 'url': job['html_url'],
        'steps': [step['name'] for step in job['steps']
                  if step['conclusion'] in ('failure', 'timed_out', 'action_required')],
    } for job in jobs if job['conclusion'] in ('failure', 'timed_out', 'action_required')]
    if failures:
        return 'hold', 'the original attempt contains an actionable failure', failures
    if run['run_attempt'] != 1:
        return 'hold', 'a later attempt requires reviewed recovery evidence', failures
    if run['status'] != 'completed':
        return 'pending', 'the current main checks are still running', failures
    if run['conclusion'] != 'success':
        return 'hold', f'the workflow ended with {run["conclusion"]}', failures
    return 'verified', 'the original main checks and exact shadow evidence passed', failures


def inspect_main(root, repo, head, output):
    repo_id = main_position(repo, head)
    run = matching_run(repo, head, repo_id)
    result = {'mode': 'read-only main shadow review', 'repo': repo, 'head': head,
              'status': 'pending', 'reason': 'no main shadow run for this commit'}
    if run is None:
        if main_position(repo, head) != repo_id or matching_run(repo, head, repo_id) is not None:
            raise AcceptanceError('main or its run changed while reading health')
        return result

    endpoint = f'repos/{repo}/actions/runs/{run["id"]}'
    jobs = attempt_job_records(endpoint, run, 1)
    status, reason, failures = first_attempt_state(run, jobs)
    result.update(status=status, reason=reason, run=run['id'], current_attempt=run['run_attempt'],
                  url=run['html_url'], first_attempt_failures=failures)
    if status == 'verified':
        commit = gh_json(f'repos/{repo}/git/commits/{head}')
        if commit['sha'] != head or git(root, 'rev-parse', 'HEAD') != head:
            raise AcceptanceError('use a clean checkout of the reviewed main commit')
        tree = commit['tree']['sha']
        require_checkout(root, head, {'tree': tree, 'merge': head})
        verify_jobs(repo, SHADOW, run)
        # Reconstruct the run under the reviewed main checkout's own case policy.
        # The reviewer may already require cases that this main revision predates.
        plan = json.loads(subprocess.check_output(
            [sys.executable, '-B', 'ci/acceptance.py', 'plan'], cwd=root, text=True, timeout=30,
            env={'PATH': os.defpath, 'GITHUB_RUN_ID': str(run['id']), 'GITHUB_RUN_ATTEMPT': '1'},
        ))
        if (plan['revision'], plan['tree'], plan['run']) != (head, tree, f'github/{run["id"]}/1'):
            raise AcceptanceError('the reviewed main checkout returned a different shadow plan')
        receipts = download_receipts(repo, artifact_manifest(endpoint, run, PRODUCTS), output)
        result.update(tree=tree, plan=plan['id'], verified_cases=verify_receipts(plan, receipts.values()))
        require_checkout(root, head, {'tree': tree, 'merge': head})

    if main_position(repo, head) != repo_id:
        raise AcceptanceError('the repository changed while checking main')
    latest = matching_run(repo, head, repo_id)
    fields = ('id', 'run_attempt', 'status', 'conclusion')
    if latest is None or any(latest[key] != run[key] for key in fields):
        raise AcceptanceError('the main workflow changed during review')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--head', required=True, help='expected current main commit')
    parser.add_argument('--checkout', type=Path, default=ROOT, help='clean checkout of the reviewed main commit')
    parser.add_argument('--output', type=Path, help='new directory for downloaded original artifacts')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo) or not SHA.fullmatch(args.head):
        parser.error('supply owner/repository and a full main commit hash')
    try:
        if args.output:
            args.output.mkdir()
            result = inspect_main(args.checkout.resolve(), args.repo, args.head, args.output)
        else:
            with TemporaryDirectory(prefix='facade-main-health-') as directory:
                result = inspect_main(args.checkout.resolve(), args.repo, args.head, Path(directory))
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError) as error:
        print(f'Could not verify current main health: {error}', file=sys.stderr)
        return 2
    return 0 if result['status'] == 'verified' else 1


if __name__ == '__main__':
    sys.exit(main())
