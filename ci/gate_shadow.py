"""Evaluate a proposed CI Gate decision from a reviewed checkout and local observations."""

import argparse
from fnmatch import fnmatchcase
from itertools import takewhile
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile

from acceptance import POLICY_PATHS, affected_products, baseline_cases, changed_paths
from catalog import AcceptanceError, PRODUCTS, RELEASE_FIXTURE_CASES, load, read_json
from evidence import binding_product, digest, git, make_plan, verify_receipts
from github_evidence import require_run_artifacts, unpack_artifact
from merge_review import (
    COLD, CORE, EXTENSION, REMOTE, REQUIRED, REVIEW_MODE, ROOT, RUNNERS, SHA, SHADOW, TARGETS,
    candidate_position, require_catalog_minimum, require_checkout, require_jobs, require_merge_tree,
    require_run_identity, required_artifact_names,
)
from merge_review_native import NATIVE_EDITOR_MINIMUM, TYPED_NATIVE_CASES


ROOT_DOCS = {'README.md', 'CONTRIBUTING.md', 'SECURITY.md'}
PRODUCT_AND_DOC_PATHS = ('core/', 'extension/', 'docs/', 'ide/')
CORE_COMPATIBILITY = (
    'core/Cargo.*', 'core/rust-toolchain.toml', 'core/install*', 'core/scripts/leftovers.sh',
    'core/protocol/*', 'core/crates/base/src/model/*',
    'core/crates/base/src/paths.rs', 'core/crates/base/src/protocol/*',
    'core/crates/base/src/platform/install*', 'core/crates/daemon/src/server/*',
    'core/crates/daemon/src/lifecycle/*', 'core/crates/daemon/src/machine_service.rs',
    'core/crates/daemon/src/store/*', 'core/crates/keeper/*', 'core/tests/tests/machines.rs',
    'core/tests/src/binaries.rs', 'core/tests/src/home.rs', 'core/tests/src/bin/facade-fakecli.rs',
)
CORE_NATIVE = (
    'core/crates/base/src/platform/*', 'core/crates/*/src/*pty*', 'core/vendor/*',
    'core/scripts/package*', 'core/scripts/*ssh*',
)
EXTENSION_RISK = (
    'extension/.nvmrc', 'extension/package*.json', 'extension/scripts/*', 'extension/window/*',
    'extension/src/ptyd/*', 'extension/src/*windowNetwork*', 'extension/src/*windowIdentity*',
    'extension/src/*remote*', 'extension/src/*ptyd*', 'extension/src/*paths*',
    'extension/src/*migration*', 'extension/src/*protocol*',
)
CANDIDATE_FIELDS = ('repo', 'pull', 'head', 'base', 'merge', 'tree')
CATALOG_JOB = 'Shadow catalog and policy tests'
REPORT_JOB = 'Shadow pilot evidence'
SNAPSHOT_LIMIT = 4 * 1024**2
OBSERVATION_ERRORS = (OSError, ValueError, KeyError, TypeError, AttributeError, BadZipFile)


class Pending(AcceptanceError):
    """The requested observation is missing, running or superseded."""


def select_workflows(paths):
    if any(path in POLICY_PATHS or not (path in ROOT_DOCS or path.startswith(PRODUCT_AND_DOC_PATHS)) for path in paths):
        return 'expanded', PRODUCTS, tuple(REQUIRED)

    products = affected_products(paths)
    if 'extension/src/schema/protocol.ts' in paths:
        products = PRODUCTS
    if not products:
        catalog = any(path == 'docs/CI-ACCEPTANCE.md'
                      or path.startswith(('core/', 'extension/', 'docs/core/', 'docs/extension/')) for path in paths)
        return 'empty', products, (SHADOW,) if catalog else ()
    workflows = [SHADOW, CORE, EXTENSION] if 'core' in products else [SHADOW, EXTENSION]
    compatibility = {path for path in paths if any(fnmatchcase(path, pattern) for pattern in CORE_COMPATIBILITY)}
    native = {path for path in paths if any(fnmatchcase(path, pattern) for pattern in CORE_NATIVE)}
    if compatibility:
        workflows.append(COLD)
    remote = any(path.startswith(('core/crates/', 'core/protocol/', 'core/vendor/'))
                 or path in ('core/Cargo.toml', 'core/Cargo.lock', 'core/rust-toolchain.toml', 'core/scripts/leftovers.sh')
                 for path in compatibility | native)
    remote = remote or any(fnmatchcase(path, pattern) for path in paths for pattern in EXTENSION_RISK)
    if remote:
        workflows.append(REMOTE)
    route = 'expanded' if compatibility or native or remote else products[0]
    return route, products, tuple(workflows)


def pull_request_patterns(workflow):
    """Read the static, positive path filters used by the current PR workflows."""
    lines = [line.rstrip() for line in workflow.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if lines.count('on:') != 1:
        return None
    events = list(takewhile(lambda line: line.startswith(' '), lines[lines.index('on:') + 1:]))
    if events.count('  pull_request:') != 1:
        return None
    rules = list(takewhile(lambda line: line.startswith('    '), events[events.index('  pull_request:') + 1:]))
    if not rules or not re.fullmatch(r'    paths:(?: &[A-Za-z0-9_-]+)?', rules[0]):
        return None
    patterns = []
    for rule in rules[1:]:
        match = re.fullmatch(r"      - '([A-Za-z0-9_./*-]+)'", rule)
        if not match or '**' in match[1].removesuffix('/**'):
            return None
        patterns.append(match[1])
    return patterns or None


def matches_workflow_path(path, pattern):
    regex = re.escape(pattern).replace(r'\*\*', '.*').replace(r'\*', '[^/]*')
    return re.fullmatch(regex, path) is not None


def unsupported_workflows(root, workflows, paths):
    unsupported = {}
    for workflow in workflows:
        file = root / '.github' / 'workflows' / workflow
        if file.is_symlink() or not file.is_file():
            unsupported[workflow] = 'required workflow is missing from the test tree'
            continue
        patterns = pull_request_patterns(file.read_text())
        if patterns is None:
            unsupported[workflow] = 'unsupported pull_request trigger in the tested workflow'
        elif not any(matches_workflow_path(path, pattern) for path in paths for pattern in patterns):
            unsupported[workflow] = 'no changed path matches the required workflow pull_request paths'
    return unsupported


def candidate_plan(root, repo, pull, head, base, merge):
    if git(root, 'rev-list', '--parents', '-n', '1', merge).split() != [merge, base, head]:
        raise AcceptanceError('local test merge must have the exact base and head as its parents')
    tree = git(root, 'rev-parse', f'{merge}^{{tree}}')
    require_checkout(root, head, {'merge': merge, 'tree': tree})
    paths = changed_paths(root, base)
    route, products, workflows = select_workflows(paths)
    cases, _, _, pilots = load(root)
    require_catalog_minimum(cases, baseline_cases(root, base))

    selected = {case: binding for case, binding in pilots.items() if binding_product(binding) in products}
    if {binding_product(binding) for binding in selected.values()} != set(products):
        raise AcceptanceError('each affected product needs at least one bound pilot case')
    pilot = make_plan(root, pilots, 'local/gate-plan')
    pilot['revision'] = merge
    del pilot['id'], pilot['run']
    jobs = {workflow: REQUIRED[workflow] for workflow in workflows}
    if SHADOW in jobs:
        names = {CATALOG_JOB, *(f'Shadow pilot ({product})' for product in products)}
        if products:
            names.add(REPORT_JOB)
        jobs[SHADOW] = {name: steps for name, steps in REQUIRED[SHADOW].items() if name in names}
        jobs[SHADOW][CATALOG_JOB] = ('Select runtime pilots', *jobs[SHADOW][CATALOG_JOB])
    requirements = {
        workflow: {name: {'runner': RUNNERS[name], 'steps': steps} for name, steps in expected.items()}
        for workflow, expected in jobs.items()
    }
    artifacts = {workflow: sorted(required_artifact_names(workflow, 1)) for workflow in workflows if workflow != SHADOW}
    if products:
        artifacts[SHADOW] = [f'shadow-pilot-{product}-1' for product in products]
    plan = {
        'repo': repo, 'pull': pull, 'head': head, 'base': base, 'merge': merge, 'tree': tree,
        'route': route, 'changed_paths': sorted(paths), 'products': products, 'cases': selected,
        'workflows': requirements, 'artifacts': artifacts, 'pilot_policy': digest(pilot),
        'unsupported_workflows': unsupported_workflows(root, workflows, paths),
    }
    if route == 'empty':
        plan['empty_reason'] = 'only documentation or IDE paths changed' if paths else 'the test merge has the base tree'
    return {**plan, 'id': digest(plan)}, pilot


def require_observation(record, field):
    observed = record.get(field)
    if observed is None:
        raise Pending(f'missing {field} observation')
    return observed


def check_candidate(plan, snapshot):
    observed = require_observation(snapshot, 'candidate')
    pull = require_observation(observed, 'pull')
    ref = require_observation(observed, 'main')
    commit = require_observation(observed, 'merge')
    if ref['ref'] != 'refs/heads/main':
        raise AcceptanceError('expected an observation of refs/heads/main')
    repo, number, head, base, merge, tree = (plan[field] for field in CANDIDATE_FIELDS)
    try:
        position = candidate_position(repo, number, head, base, pull, ref)
        if position['merge'] != merge:
            raise AcceptanceError(f'PR #{number} test merge changed to {position["merge"]}')
        observed_tree = require_merge_tree(commit, merge, head, base)
        if observed_tree != tree:
            raise AcceptanceError(f'test merge tree is {observed_tree}, expected {tree}')
    except AcceptanceError as error:
        raise Pending(str(error)) from error
    return position


def verify_shadow_archives(pilot, attempt_id, products, archives, directory):
    attempt_plan = {**pilot, 'run': attempt_id}
    attempt_plan['id'] = digest(attempt_plan)
    verified = {}
    with TemporaryDirectory(prefix='facade-gate-shadow-') as folder:
        for product in products:
            name = f'shadow-pilot-{product}-1'
            archive = directory / 'shadow' / f'{name}.zip'
            if not archive.is_file():
                raise Pending(f'missing {product} pilot archive for {attempt_id}')
            entry = archives[name]
            if archive.stat().st_size != entry['size_in_bytes']:
                raise AcceptanceError(f'{name}: archive size does not match its run manifest')
            dest = Path(folder) / product
            unpack_artifact(archive, dest, entry['digest'])
            verified[product] = verify_receipts(attempt_plan, [dest / 'receipt.json'], product)
    return {'plan': attempt_plan['id'], 'verified_cases': verified}


def check_workflow_jobs(plan, workflow, run, jobs, checks):
    run_id, attempt = run['id'], run['run_attempt']
    expected = {name: details['steps'] for name, details in plan['workflows'][workflow].items()}
    job_names = {job['name'] for job in jobs}
    if len(jobs) != len(job_names) or len(jobs) != len({job['id'] for job in jobs}):
        raise AcceptanceError('duplicate job observation')
    if missing := expected.keys() - job_names:
        raise Pending('missing jobs ' + ', '.join(sorted(missing)))
    if any((job['run_id'], job['run_attempt'], job['head_sha']) != (run_id, attempt, plan['head']) for job in jobs):
        raise AcceptanceError('a job belongs to a different run, attempt or head')
    if len(checks) != len({check['id'] for check in checks}):
        raise AcceptanceError('duplicate check run observation')
    # GitHub may include the skipped report job even when the plan selects no pilots.
    if workflow == SHADOW and not plan['products']:
        jobs = [job for job in jobs if (job['name'], job['status'], job['conclusion'])
                != (REPORT_JOB, 'completed', 'skipped')]
    return require_jobs(plan['repo'], workflow, run, jobs, checks, expected=expected)


def check_workflow(plan, pilot, position, workflow, observed, directory):
    registration = require_observation(observed, 'registration')
    if registration['path'] != f'.github/workflows/{workflow}':
        raise AcceptanceError('expected the required registered workflow path')
    if registration['state'] != 'active':
        raise AcceptanceError(f'required workflow is {registration["state"]}')
    run = require_observation(observed, 'run')
    run_id, attempt = run['id'], run['run_attempt']
    workflow_id = registration['id']
    if any(type(value) is not int or value <= 0 for value in (run_id, attempt, workflow_id)):
        raise AcceptanceError('workflow, run and attempt require positive integer IDs')
    require_run_identity(run, plan['pull'], plan['head'], plan['base'], position, workflow, workflow_id)

    if attempt != 1:
        raise AcceptanceError(f'run {run_id} is at attempt {attempt}, which requires reviewed recovery evidence')
    if run['status'] != 'completed':
        raise Pending(f'run {run_id} has status {run["status"]}')
    if run['conclusion'] != 'success':
        raise AcceptanceError(f'run {run_id} completed with {run["conclusion"]}')

    source = require_observation(observed, 'source')
    attempt_id = f'github/{run_id}/{attempt}'
    expected_source = {**{key: plan[key] for key in CANDIDATE_FIELDS}, 'plan': plan['id'], 'run': attempt_id}
    for field, value in expected_source.items():
        actual = require_observation(source, field)
        if actual != value:
            raise Pending(f'stale {field} for run {run_id}, observed {actual}, expected {value}')
    jobs = require_observation(observed, 'jobs')
    checks = require_observation(observed, 'checks')
    job_ids = check_workflow_jobs(plan, workflow, run, jobs, checks)
    result = {'run': run_id, 'attempt': attempt, 'job_metadata': job_ids}
    if names := plan['artifacts'].get(workflow):
        archives = require_run_artifacts(require_observation(observed, 'artifacts'), run, set(names))
        result['artifact_manifest'] = {
            name: {'id': entry['id'], 'digest': entry['digest']} for name, entry in archives.items()
        }
        if 'proof' in source:
            proof = source['proof']
            if result['artifact_manifest'].get(proof['artifact']) != {'id': proof['id'], 'digest': proof['digest']}:
                raise Pending('source receipt refers to a different artifact than the run manifest')
            result['source_receipt'] = proof
    if workflow == SHADOW and plan['products']:
        result['shadow_replay'] = verify_shadow_archives(pilot, attempt_id, plan['products'], archives, directory)
    return result


def match_expanded_review(plan, workflows, review):
    if workflows.keys() != REQUIRED.keys() or review['mode'] != REVIEW_MODE:
        raise AcceptanceError('expanded review evidence requires the full matrix')
    if any(review[field] != plan[field] for field in CANDIDATE_FIELDS):
        raise Pending('expanded review is for a different candidate')
    expected_runs = {
        name: {'run': workflow['run'], 'attempt': workflow['attempt'], 'jobs': workflow['job_metadata']}
        for name, workflow in workflows.items()
    }
    if review['workflows'] != expected_runs:
        raise Pending('expanded review is for different workflow jobs or attempts')
    expected_artifacts = {name: workflow['artifact_manifest'] for name, workflow in workflows.items() if name != SHADOW}
    if review['native_artifacts'] != expected_artifacts:
        raise Pending('expanded review is for different native artifacts')
    shadow = workflows[SHADOW]
    pilot = shadow['shadow_replay']
    artifact_ids = {
        product: shadow['artifact_manifest'][f'shadow-pilot-{product}-1']['id'] for product in plan['products']
    }
    report = review['shadow']
    replay_identity = (plan['merge'], plan['tree'], f'github/{shadow["run"]}/{shadow["attempt"]}',
                       pilot['plan'], pilot['verified_cases'], artifact_ids)
    if tuple(report[key] for key in ('merge', 'tree', 'attempt', 'plan', 'per_job', 'artifact_ids')) != replay_identity:
        raise Pending('expanded review has different shadow evidence')
    native = review['native']
    if not isinstance(native, dict) or native.keys() != {'typed_cases', 'release_fixture_cases', 'package_targets',
                                                         'editor_passes'}:
        raise AcceptanceError('expanded review has an incomplete native replay report')
    editor_passes = native['editor_passes']
    expected_editors = {name for name in expected_artifacts[EXTENSION] if name.startswith('editor-tests-')}
    if (native['typed_cases'] != TYPED_NATIVE_CASES or native['release_fixture_cases'] != sorted(RELEASE_FIXTURE_CASES)
            or type(native['package_targets']) is not int or native['package_targets'] != len(TARGETS)
            or not isinstance(editor_passes, dict) or editor_passes.keys() != expected_editors
            or any(type(count) is not int or count < NATIVE_EDITOR_MINIMUM for count in editor_passes.values())):
        raise AcceptanceError('expanded review does not cover the required native and release evidence')
    return native


def decision_status(blockers):
    return next((status for status in ('failure', 'pending') if any(item['status'] == status for item in blockers)),
                'success')


def decide(root, repo, pull, head, base, merge, observations):
    plan, pilot = candidate_plan(root, repo, pull, head, base, merge)
    blocked = plan['unsupported_workflows']
    result = {
        'mode': 'local CI Gate shadow', 'plan': plan, 'verified_workflows': {},
        'blockers': [{'status': 'failure', 'workflow': name, 'reason': reason} for name, reason in blocked.items()],
    }
    try:
        if observations is None or not observations.exists():
            raise Pending('missing local candidate observations')
        if observations.stat().st_size > SNAPSHOT_LIMIT:
            raise AcceptanceError('local observations exceed 4 MiB')
        snapshot = read_json(observations)
        position = check_candidate(plan, snapshot)
        if git(root, 'merge-base', head, base) != base:
            raise Pending(f'PR #{pull} head needs the current main base {base}')
        workflows = snapshot.get('workflows', {})
    except OBSERVATION_ERRORS as error:
        status = 'pending' if isinstance(error, Pending) else 'failure'
        result['blockers'].append({'status': status, 'reason': str(error)})
    else:
        for workflow in plan['workflows']:
            if workflow in blocked:
                continue
            try:
                observed = require_observation(workflows, workflow)
                result['verified_workflows'][workflow] = check_workflow(
                    plan, pilot, position, workflow, observed, observations.parent,
                )
            except OBSERVATION_ERRORS as error:
                status = 'pending' if isinstance(error, Pending) else 'failure'
                result['blockers'].append({'status': status, 'workflow': workflow, 'reason': str(error)})
        if not result['blockers'] and 'expanded_review' in snapshot:
            try:
                result['expanded_review'] = match_expanded_review(
                    plan, result['verified_workflows'], snapshot['expanded_review'],
                )
            except OBSERVATION_ERRORS as error:
                status = 'pending' if isinstance(error, Pending) else 'failure'
                result['blockers'].append({'status': status, 'reason': str(error)})
    require_checkout(root, head, plan)
    result['status'] = decision_status(result['blockers'])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--pr', type=int, required=True)
    for field in ('head', 'base', 'merge'):
        parser.add_argument(f'--{field}', required=True)
    parser.add_argument('--checkout', type=Path, default=ROOT, help='clean reviewed head or test merge checkout')
    parser.add_argument('--observations', type=Path, help='local JSON snapshot and sibling shadow receipts')
    args = parser.parse_args()
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo)
            or args.pr <= 0 or not all(SHA.fullmatch(sha) for sha in (args.head, args.base, args.merge))):
        parser.error('supply owner/repository, positive PR number and full head, base and merge hashes')
    try:
        result = decide(args.checkout, args.repo, args.pr, args.head, args.base, args.merge, args.observations)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
        result = {'mode': 'local CI Gate shadow', 'status': 'failure', 'blockers': [
            {'status': 'failure', 'reason': str(error)},
        ]}
    print(json.dumps(result, indent=2, sort_keys=True))
    return {'success': 0, 'pending': 1, 'failure': 2}[result['status']]


if __name__ == '__main__':
    sys.exit(main())
