"""Review a same-repository PR with the complete Core and Extension matrix."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile

from acceptance import affected_products, baseline_cases, changed_paths, require_new_bindings
from catalog import AcceptanceError, load
from evidence import git
from github_evidence import SHA, check_pull_run, run_artifacts, verify_hosted
from github_timing import attempt_job_records, gh_json
from merge_review_native import replay_native


ROOT = Path(__file__).resolve().parents[1]
ACTIONS_APP = 15368
TARGETS = {
    'linux-x64': ('Linux', 'ubuntu-latest'), 'linux-arm64': ('Linux', 'ubuntu-24.04-arm'),
    'darwin-x64': ('macOS', 'macos-15-intel'), 'darwin-arm64': ('macOS', 'macos-latest'),
    'win32-x64': ('Windows', 'windows-latest'), 'win32-arm64': ('Windows', 'windows-11-arm'),
}
SHADOW = 'ci-acceptance.yml'
CORE = 'core-check.yml'
EXTENSION = 'extension-check.yml'
COLD = 'core-compatibility.yml'
REMOTE = 'extension-remote.yml'
REQUIRED = {
    SHADOW: {
        'Shadow catalog and policy tests': ('Run python3 -B -m unittest discover -s ci',
                                            'Report catalog coverage', 'Check the generated acceptance table'),
        'Shadow pilot (core)': ('Run and verify selected cases',),
        'Shadow pilot (extension)': ('Run and verify selected cases',),
        'Shadow pilot evidence': ('Reconcile the selected pilots',),
    },
    CORE: {
        'Core at each commit': ('Each commit builds and leaves Cargo.lock as it is',),
        **{f'Core on {target}': ('Lint', 'Tests on Windows' if os == 'Windows' else 'Tests')
           for target, (os, _) in TARGETS.items()},
    },
    EXTENSION: {
        f'Extension on {target}, {engine} engine': (
            'Run npm run compile', 'Build the isolated editor fixtures',
            'Download official VS Code for isolated tests',
            f'Isolated editor journeys on {os}', 'Keep editor test output',
            *(('Run npm test', 'Run npm run test:package', 'Pack core from the native VSIX',
               'Install the local core archive on Windows' if os == 'Windows'
               else 'Install the local core archive on Linux and macOS',
               'Record the tested native package digests', 'Keep tested packages') if engine == 'old' else ()),
        )
        for target, (os, _) in TARGETS.items() for engine in ('old', 'rust')
    },
    COLD: {'Core cold migration (linux-x64)': ('Reopen the pinned v3 state in the candidate',
                                               'Keep the prior and candidate evidence')},
    REMOTE: {'Extension Remote SSH connect (linux-x64)': ('Stage the verified official desktop editor',
                                                        'Observe ownership in the actual Remote SSH workspace',
                                                        'Keep Remote SSH runtime and cleanup evidence')},
}
REQUIRED[CORE]['Core on linux-x64'] += ('Format', 'Agents outlive an SSH login', 'Route a Core agent over real SSH',
                                       'Keep the real SSH route evidence')
REQUIRED[EXTENSION]['Extension on linux-x64, old engine'] += (
    'Verify the installed Linux x64 candidate', 'Keep the Linux x64 candidate install evidence',
    'Keep the checked-out source tree', 'Release script tests', 'Record the release fixture results',
    'Keep the release fixture output',
)
RUNNERS = {
    **dict.fromkeys(REQUIRED[SHADOW] | REQUIRED[COLD] | REQUIRED[REMOTE], 'ubuntu-24.04'),
    'Core at each commit': 'ubuntu-latest',
    **{f'Core on {target}': runner for target, (_, runner) in TARGETS.items()},
    **{f'Extension on {target}, {engine} engine': runner
       for target, (_, runner) in TARGETS.items() for engine in ('old', 'rust')},
}


def listed(label, pages, field):
    records = [record for page in pages for record in page[field]]
    if (not pages or any(page['total_count'] != len(records) for page in pages)
            or len({record['id'] for record in records}) != len(records)):
        raise AcceptanceError(f'GitHub returned incomplete or duplicate {label}')
    return records


def current_candidate(repo, pull, head, base):
    entry = gh_json(f'repos/{repo}/pulls/{pull}')
    origin = entry['base']['repo']
    ref = gh_json(f'repos/{repo}/git/ref/heads/main')
    if (entry['number'], entry['state'], entry['head']['sha'], entry['base']['sha'],
        entry['base']['ref'], origin['full_name'].lower(), ref['object']['sha']) != (
            pull, 'open', head, base, 'main', repo.lower(), base):
        raise AcceptanceError(f'PR #{pull} or main no longer matches the reviewed candidate')
    if entry['head']['repo']['id'] != origin['id']:
        raise AcceptanceError('expanded review currently requires a same-repository pull request')
    merge = entry['merge_commit_sha']
    if entry['mergeable'] is not True or not isinstance(merge, str) or not SHA.fullmatch(merge):
        raise AcceptanceError(f'PR #{pull} has no mergeable GitHub test revision')
    commit = gh_json(f'repos/{repo}/git/commits/{merge}')
    if commit['sha'] != merge or [parent['sha'] for parent in commit['parents']] != [base, head]:
        raise AcceptanceError('GitHub test revision does not have the reviewed base and head')
    return {'repo_id': origin['id'], 'branch': entry['head']['ref'], 'draft': entry['draft'],
            'merge': merge, 'tree': commit['tree']['sha']}


def require_catalog_minimum(cases, baseline):
    if not baseline:
        raise AcceptanceError('the reviewed main commit has no acceptance catalog')
    require_new_bindings(cases, baseline)
    differences = []
    for previous in baseline:
        current = cases.get(previous['id'])
        if (current is None or (current.assertion, current.stage) != (previous['assertion'], previous['stage'])
                or (previous.get('test') and current.test != previous['test'])):
            differences.append(previous['id'])
    if differences:
        raise AcceptanceError('previous acceptance obligations need explicit review: ' + ', '.join(sorted(differences)))


def registered_workflows(repo):
    pages = gh_json('--paginate', '--slurp', f'repos/{repo}/actions/workflows?per_page=100')
    registrations = listed('registered workflows', pages, 'workflows')
    result = {}
    for name in REQUIRED:
        workflows = [item for item in registrations if item['path'] == f'.github/workflows/{name}']
        if len(workflows) != 1 or workflows[0]['state'] != 'active':
            raise AcceptanceError(f'{name}: expected exactly one active registered workflow')
        result[name] = workflows[0]['id']
    return result


def current_runs(repo, pull, head, base, candidate, workflows):
    pages = gh_json('--paginate', '--slurp',
                    f'repos/{repo}/actions/runs?event=pull_request&head_sha={head}&per_page=100')
    runs = {}
    for run in listed('workflow runs', pages, 'workflow_runs'):
        path = run['path']
        workflow = path.removeprefix('.github/workflows/')
        if path != f'.github/workflows/{workflow}' or workflow not in REQUIRED:
            continue
        if not run['pull_requests']:
            raise AcceptanceError(f'{workflow}: a run for this head has no identifiable pull request')
        if any(link['number'] == pull and link['base']['sha'] == base for link in run['pull_requests']):
            check_pull_run(run, pull, head, base)
            identity = (run['repository']['id'], run['head_repository']['id'], run['head_branch'],
                        run['head_sha'], run['event'])
            if (identity != (candidate['repo_id'], candidate['repo_id'], candidate['branch'], head, 'pull_request')
                    or run['workflow_id'] != workflows[workflow]):
                raise AcceptanceError(f'{workflow}: workflow run belongs to another candidate')
            if workflow in runs:
                raise AcceptanceError(f'{workflow}: more than one run claims this candidate')
            runs[workflow] = run
    if missing := REQUIRED.keys() - runs.keys():
        raise AcceptanceError('no current run for ' + ', '.join(sorted(missing)))
    failures = [f'{workflow} ({run["status"]}/{run["conclusion"]}, attempt {run["run_attempt"]})'
                for workflow, run in sorted(runs.items())
                if (run['status'], run['conclusion'], run['run_attempt']) != ('completed', 'success', 1)]
    if failures:
        raise AcceptanceError('expected a successful first attempt for every expanded workflow: ' + ', '.join(failures))
    return runs


def require_jobs(repo, workflow, run, jobs, checks):
    expected = REQUIRED[workflow]
    by_name = {job['name']: job for job in jobs}
    if len(jobs) != len(by_name) or expected.keys() != by_name.keys():
        raise AcceptanceError(f'{workflow}: missing, unexpected or duplicate jobs for the expanded matrix')
    by_id = {check['id']: check for check in checks}
    for name, steps in expected.items():
        job = by_name[name]
        url = f'https://github.com/{repo}/actions/runs/{run["id"]}/job/{job["id"]}'
        if ((job['status'], job['conclusion']) != ('completed', 'success') or not job['runner_id']
                or job['labels'] != [RUNNERS[name]] or job['html_url'] != url):
            raise AcceptanceError(f'{name}: the job did not complete successfully on a runner')
        check = by_id.get(job['id'], {})
        if (check.get('name'), check.get('details_url'), check.get('head_sha'), check.get('status'),
            check.get('conclusion'), check.get('app', {}).get('id'), check.get('app', {}).get('slug'),
            check.get('check_suite', {}).get('id')) != (
                name, url, run['head_sha'], 'completed', 'success', ACTIONS_APP, 'github-actions', run['check_suite_id']):
            raise AcceptanceError(f'{name}: missing exact successful GitHub Actions check for this job')
        for step in steps:
            matches = [(item['status'], item['conclusion']) for item in job['steps'] if item['name'] == step]
            if matches != [('completed', 'success')]:
                raise AcceptanceError(f'{name}: {step!r} did not succeed exactly once')
    return {name: by_name[name]['id'] for name in sorted(expected)}


def verify_jobs(repo, workflow, run):
    endpoint = f'repos/{repo}/actions/runs/{run["id"]}'
    jobs = attempt_job_records(endpoint, run, run['run_attempt'])
    pages = gh_json('--paginate', '--slurp',
                    f'repos/{repo}/check-suites/{run["check_suite_id"]}/check-runs?filter=all&per_page=100')
    return require_jobs(repo, workflow, run, jobs, listed('check runs', pages, 'check_runs'))


def required_artifacts(repo, workflow, run):
    attempt = run['run_attempt']
    names = {
        CORE: {f'core-ssh-route-{attempt}'},
        COLD: {f'core-cold-migration-{attempt}'},
        REMOTE: {f'extension-remote-ssh-{attempt}'},
        EXTENSION: {
            'tested-extension-tree', f'native-install-linux-x64-{attempt}', f'release-fixture-linux-x64-{attempt}',
            *(f'extension-{target}' for target in TARGETS),
            *(f'editor-tests-{target}-{engine}' for target in TARGETS for engine in ('old', 'rust')),
        },
    }
    return run_artifacts(f'repos/{repo}/actions/runs/{run["id"]}', run, names[workflow])


def require_checkout(root, head, candidate):
    if (git(root, 'rev-parse', 'HEAD') not in (head, candidate['merge'])
            or git(root, 'rev-parse', 'HEAD^{tree}') != candidate['tree']
            or git(root, 'status', '--porcelain')):
        raise AcceptanceError('use a clean reviewed checkout of the matching head or GitHub test tree')


def review(root, repo, pull, head, base, output):
    if sys.flags.optimize:
        raise AcceptanceError('the evidence validators require Python assertions enabled')
    candidate = current_candidate(repo, pull, head, base)
    require_checkout(root, head, candidate)
    if affected_products(changed_paths(root, base)) != ('core', 'extension'):
        raise AcceptanceError('expanded review requires a candidate with both shadow products selected')
    cases, _, _, _ = load(root)
    require_catalog_minimum(cases, baseline_cases(root, base))
    workflows = registered_workflows(repo)
    runs = current_runs(repo, pull, head, base, candidate, workflows)

    shadow_output = output / 'shadow'
    shadow_output.mkdir()
    with ThreadPoolExecutor(max_workers=5) as workers:
        jobs = {workflow: workers.submit(verify_jobs, repo, workflow, run) for workflow, run in runs.items()}
        archives = {workflow: workers.submit(required_artifacts, repo, workflow, run)
                    for workflow, run in runs.items() if workflow != SHADOW}
        shadow = workers.submit(verify_hosted, root, repo, runs[SHADOW]['id'], head, base, shadow_output, pull=pull)
        job_ids = {workflow: result.result() for workflow, result in jobs.items()}
        artifacts = {workflow: result.result() for workflow, result in archives.items()}
        shadow = shadow.result()
    if (shadow['merge'], shadow['tree'], shadow['attempt']) != (
            candidate['merge'], candidate['tree'], f'github/{runs[SHADOW]["id"]}/1'):
        raise AcceptanceError('shadow reconciliation belongs to another candidate or attempt')
    native = replay_native(root, repo, candidate, {name: entry for records in artifacts.values()
                                                    for name, entry in records.items()}, output / 'native')
    latest = current_runs(repo, pull, head, base, candidate, registered_workflows(repo))
    if (any((run['id'], run['run_attempt']) != (latest[workflow]['id'], latest[workflow]['run_attempt'])
            for workflow, run in runs.items()) or current_candidate(repo, pull, head, base) != candidate):
        raise AcceptanceError('the candidate or its current workflow runs changed during review')
    require_checkout(root, head, candidate)
    return {
        'mode': 'read-only expanded CI review', 'repo': repo, 'pull': pull, 'head': head, 'base': base, **candidate,
        'workflows': {workflow: {'run': run['id'], 'attempt': run['run_attempt'], 'jobs': job_ids[workflow]}
                      for workflow, run in sorted(runs.items())},
        'shadow': shadow, 'native': native,
        'native_artifacts': {
            workflow: {name: {'id': archive['id'], 'digest': archive['digest']} for name, archive in records.items()}
            for workflow, records in sorted(artifacts.items())
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--head', required=True, help='reviewed PR head')
    parser.add_argument('--base', required=True, help='reviewed current main commit')
    parser.add_argument('--output', type=Path, help='new directory for original downloaded artifacts')
    args = parser.parse_args()
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo)
            or args.pr <= 0 or not all(SHA.fullmatch(sha) for sha in (args.head, args.base))):
        parser.error('supply owner/repository, positive PR number and full head and base hashes')
    try:
        arguments = (ROOT, args.repo, args.pr, args.head, args.base)
        if args.output:
            output = args.output.resolve()
            output.mkdir()
            result = review(*arguments, output)
        else:
            with TemporaryDirectory(prefix='facade-merge-review-') as directory:
                result = review(*arguments, Path(directory))
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError) as error:
        print(f'Expanded CI review blocked: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
