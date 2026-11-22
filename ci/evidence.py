"""Run explicit acceptance bindings and verify the exact case receipts they produce."""

import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from catalog import AcceptanceError, MOCHA_JOURNEYS, json_object, read_json, require_same_ids

ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
PLATFORM = 'linux-x64'
EDITOR = {'version': '1.105.1', 'commit': '7d842fb85a0275a4a8e4d7e040d2625abbf7f084'}
HARNESS_FILES = (
    'core/scripts/leftovers.sh',
    'core/scripts/test-all.sh',
    'extension/src/test/integration/index.ts',
    'extension/src/test/integration/journey.it.ts',
    'extension/src/test/integration/run.ts',
)
INPUT_FILES = (*HARNESS_FILES, '.github/workflows/ci-acceptance.yml', 'docs/CI.md')
EDITOR_PASS = 'Facade acceptance test '


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def run_identity(local_id, env):
    run_id, attempt = (env.get(key, '') for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    if run_id or attempt:
        if local_id or not all(re.fullmatch(r'[1-9][0-9]*', value) for value in (run_id, attempt)):
            raise AcceptanceError('expected a GitHub run ID and attempt')
        return f'github/{run_id}/{attempt}'
    if not local_id or not re.fullmatch(r'[A-Za-z0-9._-]+', local_id):
        raise AcceptanceError('provide a unique local --run-id for this attempt')
    return f'local/{local_id}'


def make_plan(root, pilots, run_id):
    dirty = git(
        root, 'status', '--porcelain', '--untracked-files=normal', '--', 'core', 'extension',
        *(f':(exclude){path}' for path in HARNESS_FILES),
    )
    if dirty:
        raise AcceptanceError(f'pilot evidence requires committed product sources:\n{dirty}')
    policy_files = sorted((root / 'ci').glob('*.py')) + [root / path for path in INPUT_FILES]
    implementation = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in policy_files
    }
    plan = {
        'revision': git(root, 'rev-parse', 'HEAD'),
        'tree': git(root, 'rev-parse', 'HEAD^{tree}'),
        'platform': PLATFORM,
        'editor': EDITOR,
        'rust': tomllib.loads((root / 'core/rust-toolchain.toml').read_text())['toolchain']['channel'],
        'node_major': (root / 'extension/.nvmrc').read_text().strip(),
        'run': run_id,
        'catalog': hashlib.sha256((root / 'ci/cases.json').read_bytes()).hexdigest(),
        'implementation': digest(implementation),
        'cases': pilots,
    }
    plan['id'] = digest(plan)
    return plan


def runtime():
    if platform.system() == 'Linux' and platform.machine() == 'x86_64':
        return PLATFORM
    raise AcceptanceError('the acceptance pilots require a native Linux x64 runner')


def execution_groups(cases):
    groups = {}
    for case_id, binding in cases.items():
        runner = binding['runner']
        if runner == 'core-scenario':
            key = (runner, binding['target'])
        else:
            key = (runner, binding['journey'], binding['engine'], binding['built_in'])
        groups.setdefault(key, {})[case_id] = binding
    for cases_in_group in groups.values():
        unique = {binding['name']: binding for binding in cases_in_group.values()}
        yield cases_in_group, [unique[name] for name in sorted(unique)]


def observed_pass(bindings, output):
    output = ANSI.sub('', output)
    binding = bindings[0]
    if binding['runner'] == 'core-scenario':
        names = sorted(entry['name'] for entry in bindings)
        count = len(names)
        results = re.findall(r'^test (.+?) \.\.\. (.+)$', output, re.M)
        summaries = re.findall(r'^test result: (.+)$', output, re.M)
        return (
            re.findall(r'^running (\d+) tests?\s*$', output, re.M) == [str(count)]
            and sorted(results) == [(name, 'ok') for name in names]
            and len(summaries) == 1
            and summaries[0].startswith(f'ok. {count} passed; 0 failed; 0 ignored;')
        )
    markers = [line.removeprefix(EDITOR_PASS) for line in output.splitlines() if line.startswith(EDITOR_PASS)]
    try:
        records = [json.loads(marker, object_pairs_hook=json_object) for marker in markers]
    except ValueError:
        return False
    if not all(
        isinstance(record, dict) and record.keys() == {'name', 'engine'}
        and isinstance(record['name'], str) and isinstance(record['engine'], str)
        for record in records
    ):
        return False
    return sorted((record['name'], record['engine']) for record in records) == sorted(
        (entry['name'], entry['engine']) for entry in bindings
    )


def command_for(root, bindings, log_path, vscode, env):
    binding = bindings[0]
    if binding['runner'] == 'core-scenario':
        return root / 'core', [
            'sh', 'scripts/test-all.sh', str(log_path), '--', '--locked', '-p', 'facade-scenarios',
            '--test', binding['target'], '--', '--exact', '--test-threads=1',
            *(entry['name'] for entry in bindings),
        ], env
    editor_env = {
        **env,
        'VSCODE_EXECUTABLE': str(vscode),
        'FACADE_IT_ENGINE': binding['engine'],
        'FACADE_IT_ONLY': binding['journey'],
        'FACADE_IT_BUILT_IN': binding['built_in'],
    }
    if binding['journey'] in MOCHA_JOURNEYS:
        names = [entry['name'] for entry in bindings]
        patterns = [re.sub(r'([\\.^$|?*+()[\]{}])', r'\\\1', name) for name in names]
        editor_env['FACADE_IT_GREP'] = '^(?:' + '|'.join(patterns) + ')$'
        editor_env['FACADE_IT_EXPECT_TESTS'] = json.dumps(names)
    else:
        editor_env['FACADE_IT_EXPECT_DRIVER'] = binding['name']
    return root / 'extension', ['xvfb-run', '-a', 'node', 'build/out/test/integration/run.js'], editor_env


def execute(args, cwd, env, log, *, timeout=900):
    try:
        with subprocess.Popen(
            args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        ) as process:
            try:
                return 'pass' if process.wait(timeout=timeout) == 0 else 'fail'
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if isinstance(error, KeyboardInterrupt):
                    raise
                return 'timeout'
    except OSError as error:
        print(error, file=log, flush=True)
        return 'infra-error'


def build_extension(root, env, output_dir):
    with (output_dir / 'editor-build.log').open('w') as log:
        for args in (
            ['npm', 'ci'], ['npm', 'run', 'compile'], ['npm', 'run', 'bundle'],
            ['node', 'scripts/build-it.mjs'],
        ):
            print(f'Preparing editor: {" ".join(args)}', flush=True)
            print('$ ' + ' '.join(args), file=log, flush=True)
            status = execute(args, root / 'extension', env, log)
            if status != 'pass':
                return status
    return 'pass'


def download_editor(root, env, output_dir):
    path_file = output_dir / 'editor-path.txt'
    script = """
    const fs = require('node:fs');
    require('@vscode/test-electron').downloadAndUnzipVSCode(process.argv[1]).then(
        path => fs.writeFileSync(process.argv[2], path)
    ).catch(error => { console.error(error); process.exitCode = 1; });
    """
    with (output_dir / 'editor-download.log').open('w') as log:
        status = execute(['node', '-e', script, EDITOR['version'], str(path_file)], root / 'extension', env, log)
    if status == 'pass':
        return Path(path_file.read_text()).resolve()
    raise AcceptanceError(f'editor download {status}. See {output_dir / "editor-download.log"}')


def editor_identity(vscode):
    if not vscode.is_absolute() or not vscode.is_file() or not os.access(vscode, os.X_OK):
        raise AcceptanceError('--vscode must be an absolute, executable path to the pinned official VS Code')
    app = vscode.resolve().parent / 'resources/app'
    product = json.loads((app / 'product.json').read_text())
    package = json.loads((app / 'package.json').read_text())
    identity = {'version': package.get('version'), 'commit': product.get('commit')}
    if product.get('applicationName') != 'code' or product.get('dataFolderName') != '.vscode' or identity != EDITOR:
        raise AcceptanceError(f'{vscode}: expected official VS Code {EDITOR}, found {identity}')
    return identity


def binding_paths(directory, bindings):
    base = directory / digest(bindings)[:12]
    console = base.with_suffix('.console.log')
    observation = base.with_suffix('.log.full') if bindings[0]['runner'] == 'core-scenario' else console
    return observation, console, base.with_suffix('.complete.json')


def completion_record(plan, bindings, observation, console):
    return {
        'plan': plan['id'],
        'run': plan['run'],
        'bindings': bindings,
        'status': 'pass',
        'observation': {'name': observation.name, 'sha256': hashlib.sha256(observation.read_bytes()).hexdigest()},
        'cleanup': {'name': console.name, 'sha256': hashlib.sha256(console.read_bytes()).hexdigest()},
    }


def verify_completion(plan, bindings, directory):
    observation, console, completion = binding_paths(directory, bindings)
    for path in dict.fromkeys((observation, console, completion)):
        if not path.is_file() or path.is_symlink():
            raise AcceptanceError(f'missing log or completion record {path.name}')
    if read_json(completion) != completion_record(plan, bindings, observation, console):
        raise AcceptanceError('observation or cleanup does not match this binding and attempt')
    if console.read_text(errors='replace').splitlines()[-1:] != ['no processes left']:
        raise AcceptanceError(f'cleanup did not complete in {console.name}')
    if not observed_pass(bindings, observation.read_text(errors='replace')):
        raise AcceptanceError(f'no exact passing observation in {observation.name}')
    return observation.name


def run_binding(root, bindings, output_dir, vscode, env):
    output, stdout, _ = binding_paths(output_dir, bindings)
    isolated = Path(tempfile.mkdtemp(prefix='fci-', dir='/tmp'))
    runtime_dir = isolated / 'runtime'
    runtime_dir.mkdir(mode=0o700)
    cwd, args, test_env = command_for(
        root, bindings, output.with_suffix(''), vscode,
        {**env, 'TMPDIR': str(isolated), 'XDG_RUNTIME_DIR': str(runtime_dir)},
    )
    status = 'interrupted'
    with stdout.open('w') as stream:
        try:
            status = execute(args, cwd, test_env, stream)
        finally:
            cleanup = execute(['sh', 'core/scripts/leftovers.sh', str(isolated)], root, env, stream)
            if cleanup == 'pass':
                try:
                    shutil.rmtree(isolated)
                except OSError as error:
                    print(error, file=stream)
                    cleanup = 'fail'
            if cleanup != 'pass':
                print(f'Cleanup {cleanup}. Kept {isolated} for diagnosis.', file=stream)
                status = 'cleanup-fail' if status == 'pass' else f'{status}+cleanup-fail'
    if status == 'pass' and (not output.is_file() or not observed_pass(bindings, output.read_text(errors='replace'))):
        status = 'missing-pass'
    if status != 'pass':
        return status, stdout.name
    return status, output.name if output.is_file() else stdout.name


def run_pilots(root, plan, product, output_dir, vscode=None):
    host = runtime()
    selected = {key: binding for key, binding in plan['cases'].items() if key.startswith(product + '/')}
    if not selected:
        raise AcceptanceError(f'{product}: no executable PR pilot bindings')
    editor = editor_identity(vscode) if product == 'extension' and vscode is not None else None
    output_dir.mkdir(parents=True, exist_ok=False)
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(('FACADE_', 'CLAUDE_', 'XDG_', 'GIT_', 'RUSTUP_TOOLCHAIN'))
        and key != 'VSCODE_EXECUTABLE'
    }
    env.setdefault('CC_x86_64_unknown_linux_musl', 'musl-gcc')
    rustc = subprocess.check_output(['rustup', 'which', 'rustc'], cwd=root / 'core', env=env, text=True).strip()
    rust = subprocess.check_output([rustc, '--version'], cwd=root / 'core', env=env, text=True).strip()
    if not rust.startswith(f'rustc {plan["rust"]} '):
        raise AcceptanceError(f'expected pinned Rust {plan["rust"]}, observed {rust}')
    (output_dir / 'rustc-version.txt').write_text(rust + '\n')
    env.update(RUSTC=rustc, RUSTC_WRAPPER='', RUSTC_WORKSPACE_WRAPPER='')
    node = None
    if product == 'extension':
        node = subprocess.check_output(['node', '--version'], cwd=root / 'extension', env=env, text=True).strip()
        if not node.startswith(f'v{plan["node_major"]}.'):
            raise AcceptanceError(f'expected Node {plan["node_major"]}, observed {node}')
        (output_dir / 'node-version.txt').write_text(node + '\n')
    started = time.monotonic()
    prepared = build_extension(root, env, output_dir) if product == 'extension' else 'pass'
    if product == 'extension' and prepared == 'pass' and vscode is None:
        print(f'Downloading official VS Code {EDITOR["version"]}', flush=True)
        vscode = download_editor(root, env, output_dir)
        editor = editor_identity(vscode)
    preparation_ms = round((time.monotonic() - started) * 1000)
    def run_group(group):
        group_cases, bindings = group
        names = ', '.join(binding['name'] for binding in bindings)
        print(f'Running {bindings[0]["runner"]} {names}', flush=True)
        started = time.monotonic()
        if prepared == 'pass':
            status, log = run_binding(root, bindings, output_dir, vscode, env)
            if status == 'pass':
                observation, console, completion = binding_paths(output_dir, bindings)
                completion.write_text(json.dumps(completion_record(plan, bindings, observation, console), indent=2) + '\n')
        else:
            status, log = f'build-{prepared}', 'editor-build.log'
        elapsed_ms = round((time.monotonic() - started) * 1000)
        return [
            {'id': case_id, 'status': status, 'binding': binding, 'log': log, 'elapsed_ms': elapsed_ms}
            for case_id, binding in group_cases.items()
        ]

    results = []
    groups = execution_groups(selected)
    if product == 'extension' and prepared == 'pass':
        # Test contexts and displays are isolated. The staged binaries are shared and read-only here.
        with ThreadPoolExecutor(max_workers=2) as workers:
            for observed in workers.map(run_group, groups):
                results.extend(observed)
    else:
        for group in groups:
            results.extend(run_group(group))
    if make_plan(root, plan['cases'], plan['run']) != plan:
        raise AcceptanceError('acceptance inputs changed during the run')
    receipt = {
        'plan': plan['id'], 'revision': plan['revision'], 'tree': plan['tree'], 'platform': host,
        'run': plan['run'], 'preparation_ms': preparation_ms, 'results': results,
        'product': product, 'editor': editor, 'rust': rust, 'node': node,
    }
    receipt_path = output_dir / 'receipt.json'
    temporary = receipt_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(receipt, indent=2) + '\n')
    temporary.replace(receipt_path)
    return receipt_path


def verify_receipts(plan, receipts, product=None):
    if not receipts:
        raise AcceptanceError('no pilot receipts supplied')
    expected = {
        case_id: binding for case_id, binding in plan['cases'].items()
        if product is None or case_id.startswith(product + '/')
    }
    if not expected:
        raise AcceptanceError('no cases selected for verification')
    groups = {case_id: bindings for cases, bindings in execution_groups(expected) for case_id in cases}
    verified_logs = {}
    seen = set()
    failures = []
    for path in receipts:
        receipt = read_json(path)
        fields = {'plan', 'revision', 'tree', 'platform', 'run', 'preparation_ms', 'results', 'product', 'editor', 'rust', 'node'}
        if not isinstance(receipt, dict) or receipt.keys() != fields or not isinstance(receipt['results'], list):
            raise AcceptanceError('invalid receipt format')
        if receipt['plan'] != plan['id'] or any(
            receipt[key] != plan[key] for key in ('revision', 'tree', 'platform', 'run')
        ):
            raise AcceptanceError('receipt does not match this source, plan, platform or attempt')
        if type(receipt['preparation_ms']) is not int or receipt['preparation_ms'] < 0:
            raise AcceptanceError('invalid preparation duration')
        if not isinstance(receipt['rust'], str) or not receipt['rust'].startswith(f'rustc {plan["rust"]} '):
            raise AcceptanceError('wrong Rust toolchain in receipt')
        receipt_product = receipt['product']
        if receipt_product not in ('core', 'extension'):
            raise AcceptanceError('invalid receipt product')
        if receipt_product == 'extension' and (
            not isinstance(receipt['node'], str) or not receipt['node'].startswith(f'v{plan["node_major"]}.')
        ):
            raise AcceptanceError('wrong Node version in receipt')
        for item in receipt['results']:
            if not isinstance(item, dict) or item.keys() != {'id', 'status', 'binding', 'log', 'elapsed_ms'}:
                raise AcceptanceError('invalid case result')
            case_id = item['id']
            if not isinstance(case_id, str) or not case_id.startswith(receipt_product + '/') or case_id in seen:
                raise AcceptanceError(f'invalid or duplicate result for {case_id!r}')
            seen.add(case_id)
            if case_id not in expected:
                continue
            if item['binding'] != expected[case_id]:
                failures.append(f'{case_id}: wrong runner, engine or selector')
            if item['status'] != 'pass':
                failures.append(f'{case_id}: {item["status"]!r}')
            elif receipt['editor'] != (plan['editor'] if receipt_product == 'extension' else None):
                failures.append(f'{case_id}: wrong editor build')
            if type(item['elapsed_ms']) is not int or item['elapsed_ms'] < 0:
                failures.append(f'{case_id}: invalid case duration')
            log = item['log']
            if not isinstance(log, str) or not log or log != Path(log).name or log in ('.', '..'):
                failures.append(f'{case_id}: invalid log reference')
            elif item['status'] == 'pass' and item['binding'] == expected[case_id]:
                bindings = groups[case_id]
                key = (path.parent, digest(bindings))
                try:
                    if key not in verified_logs:
                        verified_logs[key] = verify_completion(plan, bindings, path.parent)
                    if log != verified_logs[key]:
                        raise AcceptanceError('wrong log for this group of exact test bindings')
                except AcceptanceError as error:
                    failures.append(f'{case_id}: {error}')
    require_same_ids(set(expected), seen, 'pilot results')
    if failures:
        raise AcceptanceError('\n'.join(failures))
    return len(seen)
