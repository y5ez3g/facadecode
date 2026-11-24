"""Write the protected-main workflow's diagnostic CI Gate summary."""

from base64 import b64encode
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

from catalog import AcceptanceError
from gate_collect import READ_ERRORS, blocker, candidate_inputs, collect
from gate_shadow import Pending
from merge_review import REQUIRED, ROOT, SHA


WORKFLOW = '.github/workflows/ci-gate-shadow.yml'
MAIN = 'refs/heads/main'


def read_git(root, *args, env=None):
    return subprocess.check_output(['git', '-C', str(root), *args], env=env, stderr=subprocess.PIPE, timeout=120)


def trusted_inputs(env, root):
    repo, policy, number = (env.get(key, '') for key in ('GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_SHA', 'CI_GATE_PR'))
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not SHA.fullmatch(policy):
        raise AcceptanceError('missing trusted workflow repository or revision')
    if (env.get('GITHUB_EVENT_NAME'), env.get('GITHUB_REF'), env.get('GITHUB_WORKFLOW_REF')) != (
            'workflow_dispatch', MAIN, f'{repo}/{WORKFLOW}@{MAIN}'):
        raise AcceptanceError('use the diagnostic workflow dispatched from main')
    if read_git(root, 'rev-parse', 'HEAD').decode().strip() != policy:
        raise AcceptanceError('reviewer checkout differs from the main workflow revision')
    if read_git(root, 'status', '--porcelain'):
        raise AcceptanceError('reviewer checkout must be clean')
    if not re.fullmatch(r'[1-9][0-9]*', number):
        raise AcceptanceError('supply a positive pull request number')
    return repo, int(number), policy


def special_entries(root, revision, env):
    entries = read_git(root, 'ls-tree', '-rz', '--full-tree', revision, env=env)
    return {entry for entry in entries.split(b'\0') if entry.startswith((b'120000 blob ', b'160000 commit '))}


def checkout_candidate(root, remote, pull, head, base, position, token):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_') and key != 'GH_TOKEN'}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    root.mkdir()
    read_git(root, 'init', '--quiet', '--template=', env=env)
    fetch_env = dict(env)
    if token:
        authorization = b64encode(f'x-access-token:{token}'.encode()).decode()
        fetch_env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
                         GIT_CONFIG_VALUE_0=f'Authorization: Basic {authorization}')
    ref = f'refs/pull/{pull}/merge'
    read_git(root, '-c', 'http.followRedirects=false', 'fetch', '--quiet', '--no-tags',
             '--no-recurse-submodules', remote, ref, env=fetch_env)
    merge, tree = position['merge'], position['tree']
    if read_git(root, 'rev-parse', 'FETCH_HEAD').decode().strip() != merge:
        raise Pending(f'PR #{pull} test merge changed while fetching {merge}')
    if (read_git(root, 'rev-list', '--parents', '-n', '1', merge).decode().split() != [merge, base, head]
            or read_git(root, 'rev-parse', f'{merge}^{{tree}}').decode().strip() != tree):
        raise AcceptanceError('fetched test merge has different parents or tree')
    if added := special_entries(root, merge, env) - special_entries(root, base, env):
        path = os.fsdecode(min(added).split(b'\t', 1)[1])
        raise AcceptanceError(f'hosted data checkout cannot inspect a new symlink or submodule at {path!r}')
    read_git(root, 'checkout', '--quiet', '--detach', merge, env=env)


def review(repo, pull, policy, remote, token, scratch):
    _, position, head, base = candidate_inputs(repo, pull, None, policy)
    candidate = {'repo': repo, 'pull': pull, 'head': head, 'base': base,
                 'merge': position['merge'], 'tree': position['tree']}
    try:
        with TemporaryDirectory(prefix='facade-hosted-gate-', dir=scratch) as directory:
            area = Path(directory)
            root = area / 'candidate'
            checkout_candidate(root, remote, pull, head, base, position, token)
            return collect(root, repo, pull, area / 'observations', head=head, base=base, compare_matrix=True)
    except READ_ERRORS as error:
        issue = blocker(error)
        return {'candidate': candidate, 'status': issue['status'], 'blockers': [issue]}


def status_label(value):
    return value.replace('_', ' ') if isinstance(value, str) and re.fullmatch(r'[a-z_]{1,30}', value) else '—'


def render_summary(result, repo=None, pull=None, policy=None):
    lines = ['# CI Gate shadow review', '', f'**Diagnostic result** {status_label(result["status"])}']
    if repo:
        lines.extend(('', f'PR [{repo}#{pull}](https://github.com/{repo}/pull/{pull})', f'Workflow revision `{policy}`'))
    plan = result.get('plan')
    if candidate := plan or result.get('candidate'):
        lines.append('')
        for key, label in (('head', 'Head'), ('base', 'Base'), ('merge', 'Test merge'), ('tree', 'Tree')):
            lines.append(f'- {label} `{candidate[key]}`')
    if plan:
        lines.extend(('', f'**Plan** `{plan["id"]}` ({plan["route"]})'))
        if plan['route'] == 'empty':
            lines.extend(('', f'Empty product plan because {plan["empty_reason"]}.'))
        if matrix := result.get('matrix'):
            lines.extend(('', '## Existing PR matrix', '',
                          '| Workflow | Gate plan | Run and attempt | GitHub result | Gate evidence |',
                          '| --- | --- | --- | --- | --- |'))
            for name in REQUIRED:
                run = matrix[name]
                scope = 'Required' if name in plan['workflows'] else 'Matrix only'
                identity = '—'
                if type(run.get('id')) is int and type(run.get('run_attempt')) is int:
                    identifier = run['id']
                    identity = f'[{identifier}](https://github.com/{repo}/actions/runs/{identifier}) / {run["run_attempt"]}'
                meta = status_label(run.get('conclusion') or run['status'])
                verified = result['verified_workflows'].get(name, {})
                evidence = '—'
                if replay := verified.get('shadow_replay'):
                    evidence = f'Cases replayed {sum(replay["verified_cases"].values())}'
                elif 'source_receipt' in verified:
                    evidence = 'Job and source metadata'
                elif 'job_metadata' in verified:
                    evidence = 'Job metadata'
                lines.append(f'| `{name}` | {scope} | {identity} | {meta} | {evidence} |')
    if result['blockers']:
        lines.extend(('', '## Blockers', '', '```text'))
        for item in result['blockers'][:12]:
            reason = json.dumps(str(item['reason'])[:600], ensure_ascii=True)
            name = item.get('workflow', 'Candidate')
            lines.append(f'{name} ({status_label(item["status"])}) {reason}')
        lines.append('```')
    return '\n'.join(lines) + '\n'


def main():
    repo = pull = policy = None
    try:
        repo, pull, policy = trusted_inputs(os.environ, ROOT)
        result = review(repo, pull, policy, f'https://github.com/{repo}.git', os.environ['GH_TOKEN'],
                        Path(os.environ['RUNNER_TEMP']))
    except READ_ERRORS as error:
        issue = blocker(error)
        result = {'status': issue['status'], 'blockers': [issue]}
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as output:
        output.write(render_summary(result, repo, pull, policy))


if __name__ == '__main__':
    main()
