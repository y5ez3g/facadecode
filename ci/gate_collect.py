"""Collect an exact CI Gate observation snapshot using read-only GitHub queries."""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from catalog import AcceptanceError, json_object
from evidence import git
from gate_shadow import (
    CANDIDATE_FIELDS, OBSERVATION_ERRORS, SNAPSHOT_LIMIT, Pending, candidate_plan, check_workflow_jobs,
    decide, decision_status,
)
from github_evidence import artifact_pages, check_archive_digest, download_archive, require_run_artifacts
from merge_review import (
    COLD, CORE, EXTENSION, REMOTE, REQUIRED, ROOT, SHA, SHADOW, attempt_evidence, find_candidate_run, head_runs,
    read_candidate, require_checkout, workflow_registrations,
)


MODE = 'read-only GitHub CI Gate collection'
NATIVE_RECEIPTS = {
    CORE: ('core-ssh-route-1', 'receipt.json'),
    EXTENSION: ('release-fixture-linux-x64-1', 'receipt.json'),
    COLD: ('core-cold-migration-1', 'cold-cutover/receipt.json'),
    REMOTE: ('extension-remote-ssh-1', 'receipt.json'),
}
READ_ERRORS = (*OBSERVATION_ERRORS, subprocess.SubprocessError)


def blocker(error):
    return {'status': 'pending' if isinstance(error, Pending) else 'failure', 'reason': str(error)}


def candidate_inputs(repo, pull, head, base):
    try:
        observed, position = read_candidate(repo, pull, head, base)
    except AcceptanceError as error:
        raise Pending(str(error)) from error
    if observed['main']['ref'] != 'refs/heads/main':
        raise AcceptanceError('expected the GitHub main ref')
    head, base = (observed['pull'][side]['sha'] for side in ('head', 'base'))
    if not all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in (head, base, position['tree'])):
        raise AcceptanceError('GitHub returned invalid candidate hashes')
    return observed, position, head, base


def workflow_inputs(plan, position, *, names=None):
    if names is None:
        names = plan['workflows'].keys() - plan['unsupported_workflows'].keys()
    observations, blockers = {}, {}
    if not names:
        return observations, blockers
    repo, pull, head, base = (plan[key] for key in ('repo', 'pull', 'head', 'base'))
    registrations = workflow_registrations(repo)
    runs = head_runs(repo, head)
    for name in sorted(names):
        observation = observations[name] = {}
        matches = [item for item in registrations if item['path'] == f'.github/workflows/{name}']
        try:
            if not matches:
                raise Pending('required workflow is missing from GitHub registrations')
            if len(matches) != 1:
                raise AcceptanceError('more than one GitHub registration for this workflow path')
            registration = observation['registration'] = matches[0]
            if registration['state'] != 'active':
                continue
            run, stale_bases = find_candidate_run(runs, name, pull, head, base, position, registration['id'])
            if run is None:
                if stale_bases:
                    raise Pending(f'only runs for stale bases {", ".join(sorted(stale_bases))}, expected {base}')
                raise Pending(f'no pull_request run for PR #{pull} at head {head} and base {base}')
            observation['run'] = run
        except AcceptanceError as error:
            blockers[name] = blocker(error)
    return observations, blockers


def run_positions(observations):
    return {
        name: (
            tuple(observation.get('registration', {}).get(key) for key in ('id', 'path', 'state')),
            tuple(observation.get('run', {}).get(key)
                  for key in ('id', 'run_attempt', 'status', 'conclusion', 'check_suite_id')),
        )
        for name, observation in observations.items()
    }


def matrix_observations(workflows):
    matrix = {}
    for name, observation in workflows.items():
        if run := observation.get('run'):
            matrix[name] = {key: run[key] for key in ('id', 'run_attempt', 'status', 'conclusion')}
        else:
            state = observation.get('registration', {}).get('state', 'unregistered')
            matrix[name] = {'status': 'unobserved' if state == 'active' else state}
    return matrix


def native_source(repo, workflow, artifacts, scratch):
    name, member = NATIVE_RECEIPTS[workflow]
    artifact = artifacts[name]
    archive = download_archive(repo, artifact, scratch, name)
    check_archive_digest(archive, artifact['digest'])
    with ZipFile(archive) as package:
        receipts = [info for info in package.infolist() if info.filename == member]
        if len(receipts) != 1 or not 0 < receipts[0].file_size <= SNAPSHOT_LIMIT:
            raise AcceptanceError(f'{name}: missing, duplicate or oversized source receipt {member}')
        receipt = json.loads(package.read(receipts[0]), object_pairs_hook=json_object)
    try:
        source = receipt['inputs']['source'] if workflow == REMOTE else receipt['source']
        revision, tree, run = (source[key] for key in ('revision', 'tree', 'run'))
        if workflow == EXTENSION:
            run = f'github/{run}/{source["attempt"]}'
        if (not all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in (revision, tree))
                or not isinstance(run, str) or not re.fullmatch(r'github/[1-9][0-9]*/[1-9][0-9]*', run)):
            raise AcceptanceError(f'{name}: invalid source or attempt in {member}')
    except (KeyError, TypeError) as error:
        raise AcceptanceError(f'{name}: missing source or attempt in {member}') from error
    return {
        'merge': revision, 'tree': tree, 'run': run,
        'proof': {'artifact': name, 'id': artifact['id'], 'digest': artifact['digest'], 'member': member},
    }


def collect_workflow(plan, workflow, observation, bundle, scratch):
    run = observation.get('run')
    if run is None or (run['status'], run['conclusion'], run['run_attempt']) != ('completed', 'success', 1):
        return
    if any(type(value) is not int or value <= 0 for value in (
            observation['registration']['id'], run['id'], run['run_attempt'], run['check_suite_id'])):
        raise AcceptanceError('invalid GitHub workflow, attempt or check suite ID')
    repo = plan['repo']
    jobs, checks = attempt_evidence(repo, run)
    observation.update(jobs=jobs, checks=checks)
    check_workflow_jobs(plan, workflow, run, jobs, checks)
    source = {**{key: plan[key] for key in CANDIDATE_FIELDS}, 'plan': plan['id'], 'run': f'github/{run["id"]}/1'}
    if names := plan['artifacts'].get(workflow):
        pages = observation['artifacts'] = artifact_pages(f'repos/{repo}/actions/runs/{run["id"]}')
        artifacts = require_run_artifacts(pages, run, set(names))
        if workflow == SHADOW:
            shadow = bundle / 'shadow'
            shadow.mkdir()
            for name, artifact in artifacts.items():
                try:
                    download_archive(repo, artifact, shadow, name)
                except READ_ERRORS:
                    (shadow / f'{name}.zip').unlink(missing_ok=True)
                    raise
        else:
            source.update(native_source(repo, workflow, artifacts, scratch))
    observation['source'] = source


def collect(root, repo, pull, output, *, head=None, base=None, compare_matrix=False):
    if output.exists():
        raise AcceptanceError(f'use a new collection directory, {output} already exists')
    candidate, position, head, base = candidate_inputs(repo, pull, head, base)
    merge = position['merge']
    try:
        plan, _ = candidate_plan(root, repo, pull, head, base, merge)
    except subprocess.CalledProcessError as error:
        raise Pending(f'reviewed checkout could not resolve the current Git candidate {merge}') from error
    except AcceptanceError as error:
        failed = blocker(error)
        return {
            'mode': MODE,
            'status': failed['status'],
            'candidate': {'repo': repo, 'pull': pull, 'head': head, 'base': base, 'merge': merge,
                          'tree': position['tree']},
            'blockers': [failed],
        }
    if plan['tree'] != position['tree']:
        raise Pending(f'GitHub test tree is {position["tree"]}, reviewed checkout has {plan["tree"]}')
    up_to_date = git(root, 'merge-base', head, base) == base
    workflows, blockers = workflow_inputs(plan, position) if up_to_date else ({}, {})
    positions, initial_blockers = run_positions(workflows), dict(blockers)

    with TemporaryDirectory(prefix='facade-gate-collect-') as directory:
        scratch = Path(directory)
        bundle = scratch / 'snapshot'
        bundle.mkdir()
        for workflow, observation in workflows.items():
            try:
                collect_workflow(plan, workflow, observation, bundle, scratch)
            except READ_ERRORS as error:
                blockers[workflow] = blocker(error)
        collection_blockers = [{'workflow': name, **item} for name, item in blockers.items()]
        snapshot = {'candidate': candidate, 'workflows': workflows,
                    'collection': {'source': 'GitHub API', 'plan': plan['id'], 'blockers': collection_blockers}}
        stored = bundle / 'observations.json'
        data = (json.dumps(snapshot, separators=(',', ':')) + '\n').encode()
        if len(data) > SNAPSHOT_LIMIT:
            raise AcceptanceError('collected GitHub observations exceed 4 MiB')
        stored.write_bytes(data)
        result = decide(root, repo, pull, head, base, merge, stored)
        if result['plan']['id'] != plan['id']:
            raise Pending('the local candidate plan changed during collection')

        latest, latest_blockers = ({}, {})
        if compare_matrix or up_to_date:
            latest, latest_blockers = workflow_inputs(plan, position, names=REQUIRED if compare_matrix else None)
        _, latest_position, _, _ = candidate_inputs(repo, pull, head, base)
        if latest_position != position:
            raise Pending('the GitHub test merge or PR position changed during collection')
        latest_planned = {name: latest[name] for name in workflows}
        planned_blockers = {name: item for name, item in latest_blockers.items() if name in workflows}
        if run_positions(latest_planned) != positions or planned_blockers != initial_blockers:
            raise Pending('the current GitHub workflow registrations or attempts changed during collection')
        require_checkout(root, head, plan)
        output.mkdir(parents=True)
        if (bundle / 'shadow').is_dir():
            shutil.copytree(bundle / 'shadow', output / 'shadow')
        staged = output / 'observations.json.tmp'
        staged.write_bytes(data)
        staged.rename(output / 'observations.json')
    result['mode'] = MODE
    result['observations'] = str(output / 'observations.json')
    result['blockers'] = [item for item in result['blockers'] if item.get('workflow') not in blockers]
    result['blockers'].extend(collection_blockers)
    result['status'] = decision_status(result['blockers'])
    if compare_matrix:
        result['matrix'] = matrix_observations(latest)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--checkout', type=Path, default=ROOT, help='clean reviewed head or test merge checkout')
    parser.add_argument('--output', required=True, type=Path, help='new directory for the snapshot and original ZIPs')
    parser.add_argument('--head', help='expected current PR head')
    parser.add_argument('--base', help='expected current main commit')
    args = parser.parse_args()
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo) or args.pr <= 0
            or not all(sha is None or SHA.fullmatch(sha) for sha in (args.head, args.base))):
        parser.error('supply owner/repository, positive PR number and full hashes for any candidate pins')
    try:
        result = collect(args.checkout, args.repo, args.pr, args.output, head=args.head, base=args.base)
    except READ_ERRORS as error:
        failed = blocker(error)
        result = {'mode': MODE, 'status': failed['status'], 'blockers': [failed]}
    print(json.dumps(result, indent=2, sort_keys=True))
    return {'success': 0, 'pending': 1, 'failure': 2}[result['status']]


if __name__ == '__main__':
    sys.exit(main())
