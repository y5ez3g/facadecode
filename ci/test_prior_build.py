from copy import deepcopy
import json
from pathlib import Path
import shlex
import tempfile
import unittest

from catalog import AcceptanceError
from check_prior_build import (
    CANDIDATE_BUILD_LOGS, DELIVERY_TEXT, HOME_LOG, RUN_LOG, SELECTOR, SESSION, SUCCESS_MARKER,
    TEST_ARGS, TRACE, binary_hashes, cold_observation, harness_hashes, pinned_programs,
    prior_success, verified_prior,
)
from native_core import hash_file, source_identity


def recorded_trace(homes):
    local, peer = 'origin-machine', 'peer-machine'
    reference = {'machine_id': local, 'agent_id': 'a1'}
    agent = {'address': 'a1@laptop', 'name': 'kept', 'cli': 'fake', 'cwd': str(homes[0].parent / 'project'),
             'process': 'ended', 'exit': {'code': 0}, 'session': SESSION}
    saved = {'machine_id': peer, 'initiator_machine_id': local, 'kind': 'saved'}
    transport = {'ssh_destination': 'devbox', 'ssh_args': ['-p', '2222', 'devbox'], 'remote_home': str(homes[1])}
    message = {'message_id': 'm1', 'from': 'command_line', 'to': 'a1', 'text': DELIVERY_TEXT,
               'delivery': {'status': 'success', 'text_written': 'full', 'enter_written': True,
                            'delivered_via': 'terminal', 'delivered_at': '2000-01-01T00:00:00Z'}}
    original = {'id': 'm1@laptop', 'message': message, 'recipient': {'reference': reference}}
    replay = {**original, 'repeated': True}
    return {
        'prior': {'protocol': 3, 'agent': {**agent, **reference}, 'saved': {**saved, **transport},
                  'peer': {'machine_id': peer}},
        'candidate': {'api_version': 1, 'agent': {**agent, 'reference': reference},
                      'saved': {**saved, 'transport': {'kind': 'ssh', **transport}},
                      'peer': {'machine_id': peer, 'state': 'disconnected'}},
        'ssh_attempts': {'before': 'interactive 2222 login\n', 'after': 'interactive 2222 login\n'},
        'receipt': {'original': original, 'prior_replay': deepcopy(replay), 'candidate_replay': deepcopy(replay)},
        'new_request': {'error': {'data': {'reason': 'ended'}}},
        'cli_bytes': list(f'📨 Message from \x1b[200~the command line · m1\r{DELIVERY_TEXT}\x1b[201~\r'.encode()),
        'transcript': json.dumps({'message': f'📨 Message from the command line · m1\n{DELIVERY_TEXT}'}) + '\n',
    }


class NativePriorEvidence(unittest.TestCase):
    def test_exact_result_without_the_typed_trace_or_owned_homes_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            scope = output / 'scope'
            homes = [scope / 'tmp' / name / 'home' for name in ('origin', 'peer')]
            good = recorded_trace(homes)
            (output / HOME_LOG).write_text('\n'.join(map(str, homes)) + '\n')
            log = output / RUN_LOG

            def write_trace(trace):
                log.write_text(f'running 1 test\ntest {SELECTOR} ... ok\n'
                               f'test result: ok. 1 passed; 0 failed; 0 ignored;\n'
                               f'{TRACE}{json.dumps(trace)}\n')

            write_trace(good)
            self.assertEqual(cold_observation(output, scope)['trace'], good)
            for message, mutate in (
                ('incomplete or malformed', dict.clear),
                ('saved session', lambda trace: trace['candidate']['agent'].update(session='different')),
                ('saved session', lambda trace: (trace['prior']['agent'].update(session='other'),
                                                 trace['candidate']['agent'].update(session='other'))),
                ('complete delivery', lambda trace: trace['receipt']['original'].update(repeated=True)),
                ('saved transport', lambda trace: trace['candidate']['saved']['transport'].update(ssh_args=['wrong'])),
                ('replays', lambda trace: trace['receipt']['candidate_replay']['message']['delivery'].update(enter_written=False)),
                ('one exact CLI delivery', lambda trace: trace['cli_bytes'].extend(trace['cli_bytes'])),
            ):
                altered = deepcopy(good)
                mutate(altered)
                write_trace(altered)
                with self.subTest(message=message), self.assertRaisesRegex(AcceptanceError, message):
                    cold_observation(output, scope)
            write_trace(good)
            (output / HOME_LOG).write_text(str(homes[0]) + '\n')
            with self.assertRaisesRegex(AcceptanceError, 'two distinct scoped'):
                cold_observation(output, scope)
            (output / HOME_LOG).write_text(f'{homes[0]}\n{homes[0]}/../home\n')
            with self.assertRaisesRegex(AcceptanceError, 'two distinct scoped'):
                cold_observation(output, scope)

    def test_marker_covers_cleaned_observations_and_the_original_programs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            scope = output / 'scope'
            homes = [scope / 'tmp' / name / 'home' for name in ('origin', 'peer')]
            (output / HOME_LOG).write_text('\n'.join(map(str, homes)) + '\n')
            commands = []
            for name, args, body in (
                (CANDIDATE_BUILD_LOGS[0], ['cargo', 'build', '--bin', 'facade-fakecli'], ''),
                (CANDIDATE_BUILD_LOGS[1], ['cargo', 'test', '--test', 'machines'], ''),
                (RUN_LOG, [str(scope / 'candidate-bin' / 'machines'), *TEST_ARGS],
                 f'running 1 test\ntest {SELECTOR} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n'
                 f'{TRACE}{json.dumps(recorded_trace(homes))}\n'),
            ):
                log = output / name
                log.write_text('$ ' + shlex.join(args) + '\n' + body)
                commands.append({'argv': args, 'log': name, 'status': 'pass', 'sha256': hash_file(log)})
            candidate, prior = output / 'candidate', output / 'prior'
            for folder in (candidate, prior):
                folder.mkdir()
                for name in ('facade', 'facade-mcp'):
                    path = folder / name
                    path.write_text(folder.name + name)
                    path.chmod(0o700)
            manifest = output / 'SHA256SUMS'
            manifest.write_text(''.join(f'{value}  {name}\n' for name, value in binary_hashes(prior).items()))
            attempt = 'local/cold-prior'
            receipt = {
                'scope': str(scope), 'source': source_identity(attempt), 'harness_sha256': harness_hashes(),
                'candidate': {'program_sha256': binary_hashes(candidate),
                              'facade-fakecli_sha256': 'a' * 64, 'machines_sha256': 'b' * 64},
                'prior': pinned_programs(prior, manifest), 'fallback_home_empty': True,
                'observation': cold_observation(output, scope), 'elapsed_seconds': 1,
                'commands': commands,
                'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'},
            }
            receipt['success'] = prior_success(receipt)
            file, console = output / 'receipt.json', output / 'console.log'
            file.write_text(json.dumps(receipt))
            marker = SUCCESS_MARKER + json.dumps(receipt['success']) + '\n'
            console.write_text(marker)

            def verify(run=attempt):
                return verified_prior(candidate, output, console, run, prior, manifest)

            verify()
            with self.assertRaisesRegex(AcceptanceError, 'different source or attempt'):
                verify('local/stale-attempt')
            file.write_text(json.dumps({**receipt, 'elapsed_seconds': 2}))
            with self.assertRaisesRegex(AcceptanceError, 'cleaned evidence record'):
                verify()
            incomplete = {**receipt, 'commands': commands[1:]}
            incomplete['success'] = prior_success(incomplete)
            file.write_text(json.dumps(incomplete))
            console.write_text(SUCCESS_MARKER + json.dumps(incomplete['success']) + '\n')
            with self.assertRaisesRegex(AcceptanceError, 'command logs are incomplete'):
                verify()
            file.write_text(json.dumps(receipt))
            console.write_text(marker)
            (output / CANDIDATE_BUILD_LOGS[0]).write_text('altered build log\n')
            with self.assertRaisesRegex(AcceptanceError, 'command log changed'):
                verify()
            (candidate / 'facade').write_text('different bytes')
            with self.assertRaisesRegex(AcceptanceError, 'different candidate'):
                verify()
