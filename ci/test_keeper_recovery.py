from copy import deepcopy
import json
import os
from pathlib import Path
import shlex
from tempfile import TemporaryDirectory
import tomllib
import unittest
from unittest.mock import patch

from catalog import AcceptanceError
import check_keeper_recovery as keeper
from native_core import hash_file, scenario_sockets


class KeeperEvidence(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.output = Path(directory.name)
        self.scope = Path('/tmp/fci-keeper-example')
        self.source = {'revision': 'a' * 40, 'tree': 'b' * 40, 'run': 'github/31/1'}
        target = 'x86_64-unknown-linux-gnu'
        channel = tomllib.loads((keeper.CORE / 'rust-toolchain.toml').read_text())['toolchain']['channel']
        self.observation = {
            **{name: {'pid': pid, 'birth': str(pid * 2)} for pid, name in enumerate(
                ('daemon', 'keeper_before', 'keeper_after', 'cli', 'stopped_cli'), 10)},
            'reference': {'machine_id': '00000000-0000-4000-8000-000000000001', 'agent_id': 'a1'},
            'api_version': 1, 'watch': 1, 'submissions': ['still here'], 'exit': {'at': '2026-01-01T00:00:00.000Z'},
        }
        flags = keeper.build_flags(target, True, False)
        records = [
            ('keeper-build.log', ['cargo', 'test', *flags, *keeper.SCENARIO_BUILD]),
            ('programs.log', ['cargo', 'build', *flags, *keeper.PROGRAM_BUILD]),
            ('keeper.log', [str(self.scope / 'bin/keeper'), *keeper.TEST_ARGS]),
        ]
        commands = []
        for name, argv in records:
            (self.output / name).write_text('$ ' + shlex.join(argv) + '\n')
            commands.append({'log': name, 'argv': argv, 'status': 'pass', 'sha256': hash_file(self.output / name)})
        home = self.scope / 'tmp/fcs-keepergone-123/home'
        home_log = self.output / keeper.HOME_LOG
        home_log.write_text(str(home) + '\n')
        programs = dict.fromkeys((*keeper.PROGRAMS, 'keeper'), '1' * 64)
        self.receipt = {
            'case': keeper.CASE, 'stage': 'native', 'binding': keeper.BINDING, 'status': 'pass',
            'source': self.source.copy(), 'source_after': self.source.copy(), 'scope': str(self.scope),
            'harness_sha256': keeper.harness_hashes(), 'workspace_build': True, 'offline': False,
            'native': {'platform': 'linux-x64', 'architecture': 'x86_64', 'target': target, 'kernel': '7.0.0',
                       'rustc': f'host: {target}\nrelease: {channel}'},
            'executable_sha256': programs, 'executable_sha256_after': programs.copy(),
            'commands': commands, 'scenario_timeout_seconds': keeper.SCENARIO_TIMEOUT, 'scenario_elapsed_seconds': 2,
            'homes_sha256': hash_file(home_log), 'scenario_teardown': {
                'homes': [str(home)], 'homes_removed': True, 'sockets_absent': True, 'fallback_home_empty': True,
                'sockets': sorted(map(str, scenario_sockets(home_log, self.scope / 'tmp').values())),
            },
            'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'},
        }
        self.ssh_programs = {name: programs[name] for name in keeper.PROGRAMS}
        self.write_observation(self.observation)

    def write_observation(self, observation, selector=keeper.SELECTOR):
        command = self.receipt['commands'][-1]
        path = self.output / command['log']
        path.write_text(f'$ {shlex.join(command["argv"])}\nrunning 1 test\ntest {selector} ... ok\n'
                        f'{keeper.OBSERVATION}{json.dumps(observation)}\n'
                        'test result: ok. 1 passed; 0 failed; 0 ignored;\n')
        command['sha256'] = hash_file(path)
        self.receipt['observation'] = observation

    def verify(self, *, source=None, programs=None):
        return keeper.verify_keeper(self.output, self.receipt, self.source if source is None else source,
                                    program_sha256=self.ssh_programs if programs is None else programs)

    def test_requires_the_same_revision_tree_attempt_and_programs(self):
        self.assertEqual(self.verify(), keeper.CASE)
        for key, value in [('revision', 'c' * 40), ('tree', 'c' * 40), ('run', 'github/31/2'), ('run', 'local/31')]:
            with self.subTest(key=key, value=value), self.assertRaisesRegex(AcceptanceError, 'candidate, attempt'):
                self.verify(source={**self.source, key: value})
        with self.assertRaisesRegex(AcceptanceError, 'same candidate programs'):
            self.verify(programs={**self.ssh_programs, 'facade': '2' * 64})
        with self.assertRaisesRegex(AcceptanceError, 'same-attempt SSH programs'):
            keeper.verify_keeper(self.output, self.receipt, self.source)
        self.receipt['workspace_build'] = False
        with self.assertRaisesRegex(AcceptanceError, 'revalidate the workspace build'):
            self.verify()

    def test_hosted_workflow_sha_pins_the_checkout(self):
        with (patch.object(keeper, 'source_identity', return_value=self.source),
              patch.object(keeper, 'git', return_value='') as git,
              patch.dict(os.environ, GITHUB_SHA=self.source['revision'])):
            self.assertEqual(keeper.candidate_identity(self.source['run']), self.source)
            git.assert_called_once_with(keeper.ROOT, 'status', '--porcelain', '--untracked-files=normal')
            with patch.dict(os.environ, GITHUB_SHA='c' * 40):
                with self.assertRaisesRegex(AcceptanceError, 'GITHUB_SHA'):
                    keeper.candidate_identity(self.source['run'])

    def test_rehashing_a_wrong_test_or_missing_transition_cannot_pass(self):
        self.write_observation(self.observation, 'another_test')
        with self.assertRaisesRegex(AcceptanceError, 'exactly one passing Keeper'):
            self.verify()
        bad = deepcopy(self.observation)
        bad['keeper_after'] = bad['keeper_before']
        self.write_observation(bad)
        with self.assertRaisesRegex(AcceptanceError, 'original and replacement'):
            self.verify()

    def test_an_unowned_socket_or_a_leaked_process_fails_review(self):
        self.receipt['scenario_teardown']['sockets'][1] = '/tmp/other.sock'
        with self.assertRaisesRegex(AcceptanceError, 'both owned sockets'):
            self.verify()
        self.receipt['cleanup']['log'] = 'processes left\n'
        with self.assertRaisesRegex(AcceptanceError, 'cleanup did not complete'):
            self.verify()
