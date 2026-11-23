"""Reconcile hosted shadow receipts with the reviewed commit and GitHub job metadata."""

import argparse
from collections import Counter
from hashlib import file_digest
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from zipfile import BadZipFile, ZipFile

from acceptance import affected_products, changed_paths
from catalog import AcceptanceError, load, read_json
from evidence import digest, git, make_plan, verify_receipts
from github_timing import attempt_jobs, gh_json


WORKFLOW = '.github/workflows/ci-acceptance.yml'
ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r'[0-9a-f]{40}')
ARCHIVE_SHA = re.compile(r'sha256:([0-9a-f]{64})')


def check_run(run, repo, head):
    if run['repository']['full_name'].lower() != repo.lower() or run['head_sha'] != head:
        raise AcceptanceError('workflow run is for a different repository or candidate head')
    if run['path'] != WORKFLOW or run['event'] != 'pull_request':
        raise AcceptanceError('expected the CI acceptance shadow pull request workflow')
    if run['status'] != 'completed' or run['conclusion'] != 'success':
        raise AcceptanceError('the current workflow attempt has no successful completed result')


def current_pull_merge(repo, pull, head, base):
    candidate = gh_json(f'repos/{repo}/pulls/{pull}')
    if ((candidate['number'], candidate['state'], candidate['head']['sha'], candidate['base']['sha'])
            != (pull, 'open', head, base)):
        raise AcceptanceError(f'PR #{pull} no longer matches the reviewed open candidate')
    merge = candidate.get('merge_commit_sha')
    if not isinstance(merge, str) or not SHA.fullmatch(merge):
        raise AcceptanceError(f'PR #{pull} has no current GitHub merge revision')
    return merge


def check_pull_run(run, pull, head, base):
    matches = [candidate for candidate in run['pull_requests'] if candidate['number'] == pull]
    if len(matches) != 1 or (matches[0]['head']['sha'], matches[0]['base']['sha']) != (head, base):
        raise AcceptanceError(f'workflow run is not for the reviewed revision of PR #{pull}')


def check_jobs(jobs, products):
    required = {'Shadow catalog and policy tests'}
    if products:
        required.update(f'Shadow pilot ({product})' for product in products)
        required.add('Shadow pilot evidence')
    for name in sorted(required):
        outcomes = [(job['status'], job['conclusion']) for job in jobs if job['name'] == name]
        if outcomes != [('completed', 'success')]:
            raise AcceptanceError(f'{name}: expected one successful job in this attempt')


def run_artifacts(endpoint, run, expected):
    pages = gh_json('--paginate', '--slurp', f'{endpoint}/artifacts?per_page=100')
    artifacts = [entry for page in pages for entry in page['artifacts']]
    if (not pages or any(page['total_count'] != len(artifacts) for page in pages)
            or len({artifact['id'] for artifact in artifacts}) != len(artifacts)):
        raise AcceptanceError('GitHub returned an incomplete or duplicate artifact list')
    selected = {}
    for artifact in artifacts:
        name = artifact['name']
        if name not in expected:
            continue
        associated = artifact['workflow_run']
        if (name in selected or artifact['expired'] is not False
                or type(artifact['id']) is not int or artifact['id'] <= 0
                or associated['id'] != run['id'] or associated['head_sha'] != run['head_sha']
                or associated['repository_id'] != run['repository']['id']
                or associated['head_repository_id'] != run['head_repository']['id']
                or type(artifact['size_in_bytes']) is not int or not 0 < artifact['size_in_bytes'] <= 1024**3
                or not ARCHIVE_SHA.fullmatch(artifact.get('digest', '') or '')):
            raise AcceptanceError(f'{name}: absent, stale, duplicate or unchecksummed artifact')
        selected[name] = artifact
    if expected != selected.keys():
        raise AcceptanceError(f'missing artifacts for this attempt: {sorted(expected - selected.keys())}')
    return selected


def artifact_manifest(endpoint, run, products):
    expected = {f'shadow-pilot-{product}-{run["run_attempt"]}': product for product in products}
    selected = run_artifacts(endpoint, run, expected.keys())
    return {product: selected[name] for name, product in expected.items()}


def unpack_artifact(archive, directory, expected):
    with archive.open('rb') as stream:
        actual = f'sha256:{file_digest(stream, "sha256").hexdigest()}'
    if actual != expected:
        raise AcceptanceError(f'{archive.name}: downloaded ZIP does not match the GitHub digest')
    directory.mkdir()
    with ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 4096 or sum(item.file_size for item in entries) > 2 * 1024**3:
            raise AcceptanceError(f'{archive.name}: artifact exceeds the review size limit')
        seen = set()
        for entry in entries:
            member = PurePosixPath(entry.filename)
            if (not member.parts or member.is_absolute() or '..' in member.parts
                    or any(character in entry.filename for character in ('\\', ':')) or member in seen):
                raise AcceptanceError(f'{archive.name}: invalid archive entry {entry.filename!r}')
            seen.add(member)
            target = directory.joinpath(*member.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as data, target.open('xb') as output:
                    shutil.copyfileobj(data, output)


def download_artifact(repo, artifact, output, name):
    archive = output / f'{name}.zip'
    directory = output / name
    if not 0 < artifact['size_in_bytes'] <= 1024**3:
        raise AcceptanceError(f'{name}: artifact exceeds the review download limit')
    with archive.open('xb') as stream:
        subprocess.run(['gh', 'api', f'repos/{repo}/actions/artifacts/{artifact["id"]}/zip'],
                       stdout=stream, check=True, timeout=90)
    if archive.stat().st_size != artifact['size_in_bytes']:
        raise AcceptanceError(f'{name}: downloaded ZIP size differs from GitHub metadata')
    unpack_artifact(archive, directory, artifact['digest'])
    return directory


def download_receipts(repo, artifacts, output):
    return {
        product: download_artifact(repo, artifact, output, product) / 'receipt.json'
        for product, artifact in artifacts.items()
    }


def verify_hosted(root, repo, run_id, head, base, output, *, pull=None):
    current_merge = current_pull_merge(repo, pull, head, base) if pull is not None else None
    endpoint = f'repos/{repo}/actions/runs/{run_id}'
    run = gh_json(endpoint)
    check_run(run, repo, head)
    if run['id'] != run_id:
        raise AcceptanceError('GitHub returned an unexpected workflow run')
    if pull is not None:
        check_pull_run(run, pull, head, base)
    attempt = run['run_attempt']
    products = affected_products(changed_paths(root, base))
    if not products:
        raise AcceptanceError('no runtime pilots selected for this reviewed head and base')
    check_jobs(attempt_jobs(endpoint, run, attempt), products)
    artifacts = artifact_manifest(endpoint, run, products)
    receipts = download_receipts(repo, artifacts, output)
    attempt_id = f'github/{run_id}/{attempt}'
    documents = {product: read_json(path) for product, path in receipts.items()}
    revisions = {document['revision'] for document in documents.values()}
    if len(revisions) != 1:
        raise AcceptanceError('the product receipts have different revisions')
    merge = revisions.pop()
    if not isinstance(merge, str) or not SHA.fullmatch(merge):
        raise AcceptanceError('the receipts do not name a valid merge commit')
    if current_merge is not None and merge != current_merge:
        raise AcceptanceError(f'the receipts do not match the current GitHub merge revision of PR #{pull}')
    commit = gh_json(f'repos/{repo}/git/commits/{merge}')
    if commit['sha'] != merge or [parent['sha'] for parent in commit['parents']] != [base, head]:
        raise AcceptanceError('the receipts do not match this PR merge revision')
    cases, _, _, pilots = load(root)
    plan = make_plan(root, pilots, attempt_id)
    local_revision = git(root, 'rev-parse', 'HEAD')
    if commit['tree']['sha'] != plan['tree'] or local_revision not in (head, merge):
        raise AcceptanceError('check out the reviewed PR head or the exact matching merge tree')
    plan['revision'] = merge
    plan['id'] = digest({key: value for key, value in plan.items() if key != 'id'})
    verified = verify_receipts(plan, receipts.values(), products[0] if len(products) == 1 else None)
    by_stage = Counter(
        f'{cases[item["id"]].stage}_p0' if cases[item['id']].journey else 'api'
        for document in documents.values() for item in document['results']
    )
    latest = gh_json(endpoint)
    check_run(latest, repo, head)
    if (latest['id'], latest['run_attempt']) != (run_id, attempt):
        raise AcceptanceError('a new attempt started while verifying the receipts')
    if pull is not None and current_pull_merge(repo, pull, head, base) != current_merge:
        raise AcceptanceError(f'PR #{pull} acquired a new GitHub merge revision while verifying the receipts')
    return {
        **({'pull': pull} if pull is not None else {}),
        'head': head, 'base': base, 'attempt': attempt_id, 'merge': merge, 'tree': plan['tree'],
        'plan': plan['id'], 'verified': verified, 'scope': dict(by_stage),
        'per_job': {product: len(document['results']) for product, document in documents.items()},
        'artifact_ids': {product: artifact['id'] for product, artifact in artifacts.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='GitHub repository as owner/name')
    parser.add_argument('--run', type=int, required=True)
    parser.add_argument('--head', required=True, help='reviewed PR head commit')
    parser.add_argument('--base', required=True, help='first parent of the tested GitHub merge commit')
    parser.add_argument('--pr', type=int, help='also require the current head, base and merge revision of this open PR')
    parser.add_argument('--checkout', type=Path, default=ROOT, help='reviewed checkout with the tested source and policy')
    parser.add_argument('--output', type=Path, help='retain the downloaded ZIPs and receipts in a new directory')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('expected a GitHub repository as owner/name')
    if not all(SHA.fullmatch(sha) for sha in (args.head, args.base)):
        parser.error('expected full head and base commit hashes')
    if args.run <= 0 or (args.pr is not None and args.pr <= 0):
        parser.error('expected a positive run ID and PR number')
    try:
        arguments = (args.checkout.resolve(), args.repo, args.run, args.head, args.base)
        if args.output:
            args.output.mkdir()
            observed = verify_hosted(*arguments, args.output, pull=args.pr)
        else:
            with tempfile.TemporaryDirectory(prefix='facade-hosted-evidence-') as directory:
                observed = verify_hosted(*arguments, Path(directory), pull=args.pr)
        print(json.dumps(observed, indent=2))
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError) as error:
        print(f'Could not reconcile hosted evidence: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
