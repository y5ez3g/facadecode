"""Load the acceptance catalog and reconcile it with the product entry points."""

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

PRODUCTS = ('core', 'extension')
STAGES = ('pr', 'native', 'scheduled', 'release')
CASE_ID = re.compile(r'(?:core|extension)(?:/[A-Za-z0-9._-]+){3}')
FLOW_ID = re.compile(r'(?:core|extension)/p0/[A-Za-z0-9._-]+')
CASE_NAME = re.compile(r'\x60([A-Za-z0-9._-]+)\x60')
NAME = re.compile(r'[a-z][a-z0-9_]*', re.ASCII)
FIELDS = {'id', 'assertion', 'stage', 'existing_tests'}
MOCHA_JOURNEYS = ('journeys', 'cross')
EDITOR_DRIVERS = {
    'activation-failure': ('old', 'claude'),
    'conversion': ('old', 'claude'),
    'expiry': ('old', 'claude'),
    'lifetime': ('rust', 'claude'),
    'missing-session-unpin': ('rust', 'claude'),
    'multi-window': ('rust', 'claude'),
    'shell-handoff': ('rust', 'codex'),
    'switch': ('rust', 'claude'),
}


class AcceptanceError(ValueError):
    """An invalid plan, test result or acceptance input."""


@dataclass(frozen=True)
class Case:
    id: str
    stage: str
    assertion: str
    existing_tests: tuple[str, ...]
    test: dict[str, str] | None

    @property
    def product(self):
        return self.id.split('/', 1)[0]

    @property
    def journey(self):
        if self.id.split('/')[1] == 'p0':
            return self.id.rsplit('/', 1)[0]
        return None


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AcceptanceError(f'duplicate JSON field {key}')
        result[key] = value
    return result


def read_json(path):
    try:
        return json.loads(path.read_text(), object_pairs_hook=json_object)
    except (OSError, ValueError) as error:
        raise AcceptanceError(f'{path}: {error}') from error


def validate_binding(value, case_id):
    if not isinstance(value, dict) or not all(
        isinstance(item, str) and item.strip() and '\n' not in item and '\r' not in item
        for item in value.values()
    ):
        raise AcceptanceError(f'{case_id}: invalid test binding')
    runner = value.get('runner')
    if runner == 'core-scenario':
        if (
            not case_id.startswith('core/')
            or value.keys() != {'runner', 'target', 'name'}
            or not all(NAME.fullmatch(value[key]) for key in ('target', 'name'))
        ):
            raise AcceptanceError(f'{case_id}: invalid Core scenario binding')
    elif runner == 'extension-editor':
        _, boundary, _, name = case_id.split('/')
        variants = set((name if boundary == 'p0' else boundary).split('-')) & {'old', 'rust'}
        if (
            not case_id.startswith('extension/')
            or value.keys() != {'runner', 'engine', 'journey', 'built_in', 'name'}
            or value['engine'] not in ('old', 'rust')
            or (variants and value['engine'] not in variants)
        ):
            raise AcceptanceError(f'{case_id}: invalid Extension editor binding')
        journey = value['journey']
        if journey in MOCHA_JOURNEYS:
            matches_route = value['built_in'] == 'claude'
        else:
            matches_route = value['name'] == journey and EDITOR_DRIVERS.get(journey) == (value['engine'], value['built_in'])
        if not matches_route:
            raise AcceptanceError(f'{case_id}: invalid Extension editor binding for {journey}')
    else:
        raise AcceptanceError(f'{case_id}: unknown runner {runner!r}')
    return value


def reference_exists(root, reference):
    if not isinstance(reference, str):
        return False
    match = re.fullmatch(r'([^:\n]+)(?::[1-9][0-9]*)?', reference)
    if not match:
        return False
    path = PurePosixPath(match[1])
    if path.is_absolute() or '..' in path.parts:
        return False
    target = (root / path).resolve()
    return target.is_relative_to(root) and target.is_file()


def read_cases(root):
    document = read_json(root / 'ci/cases.json')
    if (
        not isinstance(document, dict)
        or document.keys() != {'version', 'pilot_cases', 'cases'}
        or type(document['version']) is not int
        or document['version'] != 1
        or not isinstance(document['pilot_cases'], list)
        or not isinstance(document['cases'], list)
    ):
        raise AcceptanceError('ci/cases.json: expected version 1, pilot_cases and cases')
    cases = {}
    for row in document['cases']:
        if not isinstance(row, dict) or row.keys() - {'test'} != FIELDS:
            raise AcceptanceError('each case needs id, assertion, stage and existing_tests')
        case_id = row['id']
        if not isinstance(case_id, str) or not CASE_ID.fullmatch(case_id) or case_id in cases:
            raise AcceptanceError(f'invalid or duplicate case ID {case_id!r}')
        assertion = row['assertion']
        if not isinstance(assertion, str) or not assertion.strip() or row['stage'] not in STAGES:
            raise AcceptanceError(f'{case_id}: invalid assertion or stage')
        refs = row['existing_tests']
        if not isinstance(refs, list) or not all(reference_exists(root, ref) for ref in refs):
            raise AcceptanceError(f'{case_id}: invalid existing test reference')
        test = validate_binding(row['test'], case_id) if 'test' in row else None
        cases[case_id] = Case(case_id, row['stage'], assertion, tuple(refs), test)
    pilots = {}
    for case_id in document['pilot_cases']:
        if not isinstance(case_id, str) or case_id in pilots:
            raise AcceptanceError(f'invalid or duplicate pilot case ID {case_id!r}')
        case = cases.get(case_id)
        if not case or case.stage != 'pr' or not case.test:
            raise AcceptanceError(f'{case_id}: pilot requires a PR case with an executable binding')
        pilots[case_id] = case.test
    require_same_ids(set(PRODUCTS), {cases[key].product for key in pilots}, 'pilot products')
    return cases, pilots


def documented_p0_cases(root):
    doc = (root / 'docs/CI.md').read_text()
    try:
        table = doc.split('### P0 acceptance\n', 1)[1].split('\n## ', 1)[0]
    except IndexError as error:
        raise AcceptanceError('docs/CI.md: P0 acceptance table is missing') from error
    rows = [row for row in table.splitlines() if row.startswith('|')][2:]
    journeys = set()
    cases = set()
    for row in rows:
        match = re.match(r'^\| \x60([^\x60]+)\x60 ', row)
        if not match or not FLOW_ID.fullmatch(match[1]) or match[1] in journeys:
            raise AcceptanceError(f'docs/CI.md: invalid or duplicate P0 journey in {row.split("|")[1].strip()}')
        journeys.add(match[1])
        names = row.split('|')[-2].strip().split(', ')
        for name in names:
            suffix = CASE_NAME.fullmatch(name)
            case_id = f'{match[1]}/{suffix[1]}' if suffix else None
            if case_id is None or case_id in cases:
                raise AcceptanceError(f'docs/CI.md: invalid or duplicate P0 case {match[1]}/{name}')
            cases.add(case_id)
    if not journeys:
        raise AcceptanceError('docs/CI.md: P0 acceptance table is empty')
    return cases


def discover_apis(root):
    from inventory_core import discover as discover_core
    from inventory_extension import discover as discover_extension

    inventory = {}
    for product, discover in zip(PRODUCTS, (discover_core, discover_extension), strict=True):
        entries = discover(root)
        if not entries:
            raise AcceptanceError(f'{product}: API inventory is empty')
        for case_id, source in entries.items():
            if (
                not CASE_ID.fullmatch(case_id)
                or not case_id.startswith(product + '/')
                or case_id.split('/')[1] == 'p0'
                or case_id in inventory
                or not reference_exists(root, source)
            ):
                raise AcceptanceError(f'{product}: invalid inventory entry {case_id!r} from {source!r}')
            inventory[case_id] = source
    return inventory


def require_same_ids(expected, actual, label):
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    errors = []
    if missing:
        errors.append(f'missing {label}: {", ".join(missing)}')
    if unexpected:
        errors.append(f'unexpected {label}: {", ".join(unexpected)}')
    if errors:
        raise AcceptanceError('\n'.join(errors))


def reconcile(cases, inventory, required_p0):
    apis = {case.id for case in cases.values() if case.journey is None}
    require_same_ids(set(inventory), apis, 'API cases')
    require_same_ids(required_p0, set(cases) - apis, 'P0 cases')


def load(root):
    cases, pilots = read_cases(root)
    inventory = discover_apis(root)
    required_p0 = documented_p0_cases(root)
    reconcile(cases, inventory, required_p0)
    return cases, inventory, required_p0, pilots
