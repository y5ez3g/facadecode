"""Load the acceptance catalog and reconcile it with the product entry points."""

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

PRODUCTS = ('framework', 'extension')
STAGES = ('pr', 'native', 'scheduled', 'release', 'historical')
CASE_ID = re.compile(r'(?:framework|extension)(?:/[A-Za-z0-9._-]+){3}')
FLOW_ID = re.compile(r'(?:framework|extension)/p0/[A-Za-z0-9._-]+')
CASE_NAME = re.compile(r'\x60([A-Za-z0-9._-]+)\x60')
NAME = re.compile(r'[a-z][a-z0-9_]*', re.ASCII)
FIELDS = {'id', 'assertion', 'stage', 'existing_tests'}
MOCHA_JOURNEYS = ('journeys', 'cross')
VSIX_REHEARSALS = ('install-pair', 'upgrade-pair')
NATIVE_INSTALL_CASES = (
    'framework/p0/install-upgrade/install',
    'framework/p0/install-upgrade/bad-archive',
)
NATIVE_INSTALL_BINDING = {'runner': 'framework-install', 'target': 'linux-x64', 'name': 'installed-candidate'}
NATIVE_SSH_CASE = 'framework/p0/remote-execution/real-ssh'
NATIVE_SSH_BINDING = {'runner': 'framework-ssh', 'target': 'linux-x64', 'name': 'real-machine-route'}
NATIVE_HOT_CASE = 'framework/p0/prior-build/hot-replacement'
NATIVE_HOT_BINDING = {'runner': 'framework-prior', 'target': 'linux-x64', 'name': 'hot-qa'}
NATIVE_INCOMPATIBLE_CASE = 'framework/p0/prior-build/incompatible-version'
NATIVE_INCOMPATIBLE_BINDING = {'runner': 'framework-prior', 'target': 'linux-x64', 'name': 'incompatible-qa'}
NATIVE_REMOTE_EDITOR_CASE = 'extension/p0/remote-host/ssh-connect'
NATIVE_REMOTE_EDITOR_BINDING = {'runner': 'extension-ssh', 'target': 'linux-x64', 'name': 'ssh-connect'}
RELEASE_FIXTURE_CASES = (
    'extension/p0/release/invalid-artifact',
    'extension/p0/release/stable-pointer',
)
RELEASE_FIXTURE_BINDING = {'runner': 'extension-release', 'target': 'linux-x64', 'name': 'release-script-fixtures'}
NATIVE_BINDINGS = {
    **dict.fromkeys(RELEASE_FIXTURE_CASES, RELEASE_FIXTURE_BINDING),
    **dict.fromkeys(NATIVE_INSTALL_CASES, NATIVE_INSTALL_BINDING),
    NATIVE_SSH_CASE: NATIVE_SSH_BINDING,
    NATIVE_HOT_CASE: NATIVE_HOT_BINDING,
    NATIVE_INCOMPATIBLE_CASE: NATIVE_INCOMPATIBLE_BINDING,
    NATIVE_REMOTE_EDITOR_CASE: NATIVE_REMOTE_EDITOR_BINDING,
}
NATIVE_ROUTES = {binding['runner'] for binding in NATIVE_BINDINGS.values()}
REQUIRED_EDITOR_ROUTES = {
    'framework/p0/remote-execution/remote-worktree': 'remote-worktree',
    'extension/p0/activation-shell/activation-failure': 'incompatible-activation',
    'extension/p0/activation-shell/startup-failure': 'activation-failure',
    'extension/p0/vsix-upgrade/install-pair': 'install-pair',
    'extension/p0/vsix-upgrade/upgrade-pair': 'upgrade-pair',
    'extension/p0/vsix-upgrade/cutover-live': 'cutover-live',
    'extension/p0/vsix-upgrade/cutover-uncertain': 'cutover-uncertain',
}
EDITOR_DRIVERS = {
    'activation-failure': ('none', 'claude'),
    'cutover-live': ('framework', 'claude'),
    'cutover-uncertain': ('framework', 'claude'),
    'incompatible-activation': ('none', 'claude'),
    'install-pair': ('framework', 'claude'),
    'lifetime': ('framework', 'claude'),
    'missing-session-unpin': ('framework', 'claude'),
    'multi-window': ('framework', 'claude'),
    'remote-worktree': ('framework', 'fake'),
    'shell-handoff': ('framework', 'codex'),
    'upgrade-pair': ('framework', 'claude'),
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
    if case_id in NATIVE_BINDINGS or runner in NATIVE_ROUTES:
        if value != NATIVE_BINDINGS.get(case_id):
            raise AcceptanceError(f'{case_id}: invalid native binding')
        return value
    required_route = REQUIRED_EDITOR_ROUTES.get(case_id)
    if required_route and (runner != 'extension-editor' or value.get('journey') != required_route):
        raise AcceptanceError(f'{case_id}: requires the {required_route} editor route')
    if runner == 'framework-scenario':
        if (
            not case_id.startswith('framework/')
            or value.keys() != {'runner', 'target', 'name'}
            or not all(NAME.fullmatch(value[key]) for key in ('target', 'name'))
        ):
            raise AcceptanceError(f'{case_id}: invalid Facade Code Framework scenario binding')
    elif runner == 'extension-unit':
        if (not case_id.startswith('extension/') or '/p0/' in case_id
                or value.keys() != {'runner', 'target', 'name'}
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.test', value['target'])):
            raise AcceptanceError(f'{case_id}: invalid Extension unit binding')
    elif runner == 'extension-editor':
        _, boundary, _, name = case_id.split('/')
        variants = set((name if boundary == 'p0' else boundary).split('-')) & {'legacy', 'framework'}
        if (
            value.keys() != {'runner', 'implementation', 'journey', 'built_in', 'name'}
            or value['implementation'] not in ('legacy', 'framework', 'none')
            or (variants and value['implementation'] not in variants)
        ):
            raise AcceptanceError(f'{case_id}: invalid Extension editor binding')
        journey = value['journey']
        if journey in MOCHA_JOURNEYS:
            matches_route = value['built_in'] == 'claude' and value['implementation'] in ('legacy', 'framework')
        else:
            matches_route = value['name'] == journey and EDITOR_DRIVERS.get(journey) == (value['implementation'], value['built_in'])
        if journey in REQUIRED_EDITOR_ROUTES.values():
            applies = required_route == journey
        else:
            applies = case_id.startswith('extension/')
        if not (applies and matches_route):
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
        or document.keys() != {'version', 'cases'}
        or type(document['version']) is not int
        or document['version'] != 2
        or not isinstance(document['cases'], list)
    ):
        raise AcceptanceError('ci/cases.json: expected version 2 and cases')
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
        if row['stage'] == 'historical' and (not test or test.get('implementation') != 'legacy'):
            raise AcceptanceError(f'{case_id}: historical stage requires an earlier legacy editor journey')
        if test == NATIVE_INSTALL_BINDING and row['stage'] not in ('native', 'release'):
            raise AcceptanceError(f'{case_id}: native install requires a native or release stage')
        if case_id in NATIVE_BINDINGS:
            if test is None:
                raise AcceptanceError(f'{case_id}: missing executable native binding')
            if test == RELEASE_FIXTURE_BINDING and row['stage'] != 'release':
                raise AcceptanceError(f'{case_id}: release script fixture requires the release stage')
            if test not in (NATIVE_INSTALL_BINDING, RELEASE_FIXTURE_BINDING) and row['stage'] != 'native':
                raise AcceptanceError(f'{case_id}: this native route requires a native stage')
        if test and test.get('journey') in VSIX_REHEARSALS and row['stage'] != 'release':
            raise AcceptanceError(f'{case_id}: installed VSIX rehearsal requires a release stage')
        cases[case_id] = Case(case_id, row['stage'], assertion, tuple(refs), test)
    missing = sorted(case.id for case in cases.values()
                     if case.stage == 'pr' and case.journey and case.test is None)
    if missing:
        raise AcceptanceError('missing executable PR P0 bindings:\n  ' + '\n  '.join(missing))
    rehearsals = {case_id for case_id, route in REQUIRED_EDITOR_ROUTES.items() if route in VSIX_REHEARSALS}
    require_same_ids(rehearsals, {
        case.id for case in cases.values() if case.test and case.test.get('journey') in VSIX_REHEARSALS
    }, 'executable VSIX release rehearsals')
    pilots = {
        case.id: case.test
        for case in sorted(cases.values(), key=lambda case: case.journey is None)
        if case.test is not None and (case.stage == 'pr' or case.test.get('journey') in VSIX_REHEARSALS)
    }
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
    from inventory_framework import discover as discover_framework
    from inventory_extension import discover as discover_extension

    inventory = {}
    for product, discover in zip(PRODUCTS, (discover_framework, discover_extension), strict=True):
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
