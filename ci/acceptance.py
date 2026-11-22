"""The local and CI entry point for Facade acceptance."""

import argparse
import json
import subprocess
import sys
from collections import Counter
from os import environ, fsdecode
from pathlib import Path

from catalog import AcceptanceError, PRODUCTS, discover_apis, json_object, load
from evidence import git, make_plan, run_identity, run_pilots, verify_receipts

ROOT = Path(__file__).resolve().parent.parent
POLICY_PATHS = {
    'docs/CI.md',
    '.github/workflows/ci-acceptance.yml',
    '.github/workflows/core-check.yml',
    '.github/workflows/core-compatibility.yml',
    '.github/workflows/extension-check.yml',
    '.github/workflows/extension-release.yml',
}
PRODUCT_GUIDES = {'core/README.md', 'core/AGENTS.md', 'extension/README.md', 'extension/AGENTS.md'}


def affected_products(paths):
    changes = set(paths) - PRODUCT_GUIDES
    if changes & POLICY_PATHS or 'extension/src/base/names.ts' in changes:
        return PRODUCTS
    if any(path.startswith(('core/', 'ci/', '.github/release-mirror/')) for path in changes):
        return PRODUCTS
    if any(path.startswith('extension/') for path in changes):
        return ('extension',)
    return ()


def base_commit(root, base):
    return git(root, 'rev-parse', '--verify', '--end-of-options', f'{base}^{{commit}}')


def changed_paths(root, base):
    tree = base_commit(root, base)
    names = subprocess.check_output([
        'git', '-C', str(root), 'diff', '--name-only', '--no-renames', '-z', tree, 'HEAD', '--',
    ])
    return tuple(fsdecode(path) for path in names.split(b'\0') if path)


def baseline_cases(root, base):
    commit = base_commit(root, base)
    file = 'ci/cases.json'
    if not git(root, 'ls-tree', '--name-only', commit, '--', file):
        return []
    document = json.loads(git(root, 'show', f'{commit}:{file}'), object_pairs_hook=json_object)
    if not isinstance(document, dict) or not isinstance(document.get('cases'), list):
        raise AcceptanceError('the base commit has an unreadable acceptance catalog')
    return document['cases']


def review_bound_cases(cases, baseline):
    lost = []
    changed = []
    for old in baseline:
        if not old.get('test'):
            continue
        case_id = old['id']
        current = cases.get(case_id)
        if current is None:
            changed.append((case_id, 'removed from the catalog'))
        elif current.test is None:
            lost.append(case_id)
        elif (old['assertion'], old['stage'], old['test']) != (current.assertion, current.stage, current.test):
            changed.append((case_id, 'assertion, stage or binding changed'))
    for case_id, reason in sorted(changed):
        print(f'Acceptance review for {case_id}: {reason}')
    if lost:
        raise AcceptanceError('existing obligations lost their executable binding:\n  ' + '\n  '.join(sorted(lost)))


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', help='unique attempt ID shared by the local plan, runs and verification')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('inventory', help='emit the API inventory from current product sources')
    catalog = commands.add_parser('catalog', help='reconcile the inventory and report executable bindings')
    catalog.add_argument('--require-bindings', action='store_true')
    catalog.add_argument('--base', help='compare existing bindings with this Git base commit')
    table = commands.add_parser('table', help='render the reviewed case catalog as Markdown')
    table.add_argument('--product', choices=PRODUCTS)
    scope = commands.add_parser('scope', help='select runtime pilots for changes since the base commit')
    scope.add_argument('--base', required=True)
    commands.add_parser('plan', help='emit the bound PR pilot plan for this source tree')
    run = commands.add_parser('run', help='run a product pilot and verify its receipt')
    run.add_argument('--product', required=True, choices=PRODUCTS)
    run.add_argument('--output', required=True, type=Path)
    run.add_argument('--vscode', type=Path, help='use an existing executable of the pinned official editor')
    run.add_argument('--editor-workers', type=int, choices=(1, 2),
                     help='editor groups to run concurrently (default: 2)')
    verify = commands.add_parser('verify', help='verify case receipts against the current pilot plan')
    verify.add_argument('--product', choices=PRODUCTS)
    verify.add_argument('receipts', nargs='+', type=Path)
    install = commands.add_parser('verify-native-install', help='verify the Linux x64 candidate install evidence')
    for field in ('archive', 'checksums', 'receipt', 'output'):
        install.add_argument(field, type=Path)
    ssh = commands.add_parser('verify-native-ssh', help='verify the Linux x64 real machine route evidence')
    ssh.add_argument('--bin-dir', type=Path, required=True)
    for field in ('receipt', 'output'):
        ssh.add_argument(field, type=Path)
    prior = commands.add_parser('verify-native-prior', help='verify the native Core cold-cutover evidence')
    prior.add_argument('--candidate-bin', type=Path, required=True)
    prior.add_argument('--prior-bin', type=Path)
    prior.add_argument('--manifest', type=Path)
    prior.add_argument('evidence', type=Path)
    prior.add_argument('console', type=Path)
    return parser


def report(cases, inventory, required_p0, pilots):
    pending = sorted(case.id for case in cases.values() if case.test is None)
    journey_count = len({key.rsplit('/', 1)[0] for key in required_p0})
    print(f'{len(inventory)} API entries, {journey_count} P0 journeys, {len(required_p0)} P0 cases')
    print(f'{len(cases)} planned cases')
    print(f'{len(cases) - len(pending)} executable bindings, {len(pending)} awaiting an executable binding')
    print(f'Shadow plan: {len(pilots)} pilot cases, with no results evaluated by catalog')
    for product in PRODUCTS:
        entries = sum(key.startswith(product + '/') for key in inventory)
        print(f'  {product}: {entries} API entries')
        stages = Counter((case.stage, case.test is not None) for case in cases.values() if case.product == product)
        for stage in sorted({stage for stage, _ in stages}):
            print(f'    {stage}: {stages[stage, True]} bound, {stages[stage, False]} pending')
        for engine in ('old', 'rust') if product == 'extension' else ():
            api_cases = [case for case in cases.values()
                         if case.id in inventory and case.id.split('/')[1].endswith('-' + engine)]
            bound = sum(case.test is not None for case in api_cases)
            selected = sum(binding.get('engine') == engine for binding in pilots.values())
            print(f'    {engine}: {bound}/{len(api_cases)} APIs bound, {selected} selected editor cases')
    return pending


def source_link(reference):
    path, _, line = reference.partition(':')
    anchor = f'#L{line}' if line else ''
    return f'[{Path(path).name}](../{path}{anchor})'


def render_table(cases, inventory, product):
    selected = [case for case in cases.values() if product is None or case.product == product]
    apis = sum(case.id in inventory for case in selected)
    bound = sum(case.test is not None for case in selected)
    print('# CI acceptance cases\n')
    print('Generated from [ci/cases.json](../ci/cases.json) by `python3 -B ci/acceptance.py table`.')
    print('See the [CI design](CI.md) for the acceptance policy.\n')
    print(f'{apis} API obligations and {len(selected) - apis} P0 cases. '
          f'{bound} have exact bindings and {len(selected) - bound} are pending.\n')
    print('A bound row requires passing evidence for the current run. Candidate test references are for review.\n')
    print('| Case | Stage | Exact binding | Expected behavior | Code and candidate tests |')
    print('| --- | --- | --- | --- | --- |')
    for case in selected:
        binding = 'Pending'
        if case.test:
            variant = case.test.get('engine') or case.test['target']
            binding = f'`{variant}` · `{case.test["name"]}`'
        origin = inventory.get(case.id)
        refs = (origin, *case.existing_tests) if origin else case.existing_tests
        links = ', '.join(source_link(ref) for ref in dict.fromkeys(refs))
        row = (f'`{case.id}`', case.stage, binding, case.assertion, links)
        print('| ' + ' | '.join(' '.join(field.splitlines()).replace('|', r'\|') for field in row) + ' |')


def main():
    args = argument_parser().parse_args()
    try:
        if args.command == 'inventory':
            print(json.dumps(discover_apis(ROOT), indent=2, sort_keys=True))
            return 0
        if args.command == 'scope':
            print(json.dumps(affected_products(changed_paths(ROOT, args.base)), separators=(',', ':')))
            return 0
        if args.command == 'verify-native-install':
            from check_native_install import verified_install
            passed = verified_install(args.archive, args.checksums, args.receipt, args.output,
                                      run_identity(args.run_id, environ))
            print(f'{passed} Linux x64 native install cases passed and matched the candidate archive')
            return 0
        if args.command == 'verify-native-ssh':
            from check_real_ssh_route import verified_ssh
            verified_ssh(args.bin_dir, args.receipt, args.output, run_identity(args.run_id, environ))
            print('Linux x64 real SSH machine route passed and matched the tested Core programs')
            return 0
        if args.command == 'verify-native-prior':
            from check_prior_build import verified_prior
            try:
                verified_prior(args.candidate_bin, args.evidence, args.console, run_identity(args.run_id, environ),
                               args.prior_bin, args.manifest)
            except (KeyError, TypeError) as error:
                raise AcceptanceError('native prior-build evidence is incomplete or malformed') from error
            print('Linux x64 Core cold migration passed and matched the tested inputs and cleanup')
            return 0
        cases, inventory, required_p0, pilots = load(ROOT)
        if args.command == 'catalog':
            if args.base is not None:
                review_bound_cases(cases, baseline_cases(ROOT, args.base))
            pending = report(cases, inventory, required_p0, pilots)
            if pending and args.require_bindings:
                raise AcceptanceError('missing executable bindings:\n  ' + '\n  '.join(pending))
            return 0
        if args.command == 'table':
            render_table(cases, inventory, args.product)
            return 0
        plan = make_plan(ROOT, pilots, run_identity(args.run_id, environ))
        if args.command == 'plan':
            print(json.dumps(plan, indent=2, sort_keys=True))
            return 0
        if args.command == 'run':
            if args.vscode and args.product != 'extension':
                raise AcceptanceError('--vscode applies to the Extension pilot')
            if args.editor_workers is not None and args.product != 'extension':
                raise AcceptanceError('--editor-workers applies to the Extension pilot')
            receipts = [run_pilots(ROOT, plan, args.product, args.output.resolve(), args.vscode,
                                   editor_workers=args.editor_workers or 2)]
        else:
            receipts = args.receipts
        passed = verify_receipts(plan, receipts, args.product)
        print(f'{passed} pilot cases passed and matched the current plan')
        return 0
    except KeyboardInterrupt:
        print('Acceptance interrupted.', file=sys.stderr)
        return 130
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Acceptance failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
