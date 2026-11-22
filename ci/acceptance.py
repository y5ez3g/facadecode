"""The local and CI entry point for Facade acceptance."""

import argparse
import json
import subprocess
import sys
from collections import Counter
from os import environ
from pathlib import Path

from catalog import AcceptanceError, PRODUCTS, discover_apis, load
from evidence import make_plan, run_identity, run_pilots, verify_receipts

ROOT = Path(__file__).resolve().parent.parent


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', help='unique attempt ID shared by the local plan, runs and verification')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('inventory', help='emit the API inventory from current product sources')
    catalog = commands.add_parser('catalog', help='reconcile the inventory and report executable bindings')
    catalog.add_argument('--require-bindings', action='store_true')
    table = commands.add_parser('table', help='render the reviewed case catalog as Markdown')
    table.add_argument('--product', choices=PRODUCTS)
    commands.add_parser('plan', help='emit the bound PR pilot plan for this source tree')
    run = commands.add_parser('run', help='run a product pilot and verify its receipt')
    run.add_argument('--product', required=True, choices=PRODUCTS)
    run.add_argument('--output', required=True, type=Path)
    run.add_argument('--vscode', type=Path, help='use an existing executable of the pinned official editor')
    verify = commands.add_parser('verify', help='verify case receipts against the current pilot plan')
    verify.add_argument('--product', choices=PRODUCTS)
    verify.add_argument('receipts', nargs='+', type=Path)
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
        binding = f'`{case.test["name"]}`' if case.test else 'Pending'
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
        cases, inventory, required_p0, pilots = load(ROOT)
        if args.command == 'catalog':
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
            receipts = [run_pilots(ROOT, plan, args.product, args.output.resolve(), args.vscode)]
        else:
            receipts = args.receipts
        passed = verify_receipts(plan, receipts, args.product)
        print(f'{passed} pilot cases passed and matched the current plan')
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Acceptance failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
