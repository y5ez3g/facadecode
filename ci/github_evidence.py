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


def check_jobs(jobs, products):
    required = {'Shadow catalog and policy tests'}
    if products:
        required.update(f'Shadow pilot ({product})' for product in products)
        required.add('Shadow pilot evidence')
    for name in sorted(required):
        outcomes = [(job['status'], job['conclusion']) for job in jobs if job['name'] == name]
        if outcomes != [('completed', 'success')]:
            raise AcceptanceError(f'{name}: expected one successful job in this attempt')


def artifact_manifest(endpoint, run, products):
    pages = gh_json('--paginate', '--slurp', f'{endpoint}/artifacts?per_page=100')
    artifacts = [entry for page in pages for entry in page['artifacts']]
    if not pages or len(artifacts) != pages[0]['total_count']:
        raise AcceptanceError('GitHub returned an incomplete artifact list')
    expected = {f'shadow-pilot-{product}-{run["run_attempt"]}': product for product in products}
    selected = {}
    for artifact in artifacts:
        name = artifact['name']
        if name not in expected:
            continue
        associated = artifact['workflow_run']
        if (name in selected or artifact['expired']
                or associated['id'] != run['id'] or associated['head_sha'] != run['head_sha']
                or associated['repository_id'] != run['repository']['id']
                or not ARCHIVE_SHA.fullmatch(artifact.get('digest', '') or '')):
            raise AcceptanceError(f'{name}: absent, stale, duplicate or unchecksummed artifact')
        selected[name] = artifact
    if expected.keys() != selected.keys():
        raise AcceptanceError(f'missing artifacts for this attempt: {sorted(expected.keys() - selected.keys())}')
    return {product: selected[name] for name, product in expected.items()}


def unpack_artifact(archive, directory, expected):
    with archive.open('rb') as stream:
        actual = f'sha256:{file_digest(stream, "sha256").hexdigest()}'
    if actual != expected:
        raise AcceptanceError(f'{archive.name}: downloaded ZIP does not match the GitHub digest')
    directory.mkdir()
    with ZipFile(archive) as package:
        seen = set()
        for entry in package.infolist():
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


def download_receipts(repo, artifacts, output):
    receipts = {}
    for product, artifact in artifacts.items():
        archive = output / f'{product}.zip'
        directory = output / product
        with archive.open('wb') as stream:
            subprocess.run(['gh', 'api', f'repos/{repo}/actions/artifacts/{artifact["id"]}/zip'],
                           stdout=stream, check=True, timeout=90)
        unpack_artifact(archive, directory, artifact['digest'])
        receipts[product] = directory / 'receipt.json'
    return receipts


def verify_hosted(root, repo, run_id, head, base, output):
    endpoint = f'repos/{repo}/actions/runs/{run_id}'
    run = gh_json(endpoint)
    check_run(run, repo, head)
    if run['id'] != run_id:
        raise AcceptanceError('GitHub returned an unexpected workflow run')
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
    return {
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
    parser.add_argument('--checkout', type=Path, default=ROOT, help='reviewed checkout with the tested source and policy')
    parser.add_argument('--output', type=Path, help='retain the downloaded ZIPs and receipts in a new directory')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('expected a GitHub repository as owner/name')
    if args.run <= 0 or not all(SHA.fullmatch(sha) for sha in (args.head, args.base)):
        parser.error('expected a positive run ID and full head and base commit hashes')
    try:
        arguments = (args.checkout.resolve(), args.repo, args.run, args.head, args.base)
        if args.output:
            args.output.mkdir()
            observed = verify_hosted(*arguments, args.output)
        else:
            with tempfile.TemporaryDirectory(prefix='facade-hosted-evidence-') as directory:
                observed = verify_hosted(*arguments, Path(directory))
        print(json.dumps(observed, indent=2))
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError) as error:
        print(f'Could not reconcile hosted evidence: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
