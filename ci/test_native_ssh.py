from copy import deepcopy
import json
import tempfile
import unittest
from pathlib import Path

from catalog import AcceptanceError, NATIVE_SSH_CASE
from check_real_ssh_route import INPUT, PROGRAMS, REFUSE_UNKNOWN_MACHINE, SUCCESS_MARKER, ssh_success, verified_ssh
from evidence import digest
from native_framework import hash_file, source_identity


def observations(scope):
    program = str(scope / 'bin/facade')
    agent = {
        'reference': {'machine_id': 'peer-id', 'agent_id': 'a1'},
        'address': 'a1@qa-peer', 'cwd': str(scope / 'peer-work'), 'pid': 17, 'start_ticks': 66,
        'executable': str(scope / 'bin/facade-fakecli'),
    }
    local = {
        'agent': {**agent, 'reference': {'machine_id': 'origin-id', 'agent_id': 'a1'},
                  'address': 'a1@qa-origin', 'cwd': str(scope / 'origin-work'), 'pid': 19},
        'input_hex': '', 'settings': ['a' * 64, 'b' * 64],
    }
    start = [program, 'start', '-d']
    worker = ['--name', 'route-worker', '--workdir']
    commands = [
        ('launch the peer over OpenSSH', 0, ['/usr/bin/ssh'], ''),
        ('launch the origin', 0, [program, 'daemon', '--detach'], ''),
        ('start the route fixture agent', 0, [*start, *worker, local['agent']['cwd'], 'qa-route'], ''),
        ('start the route fixture agent', 0, [*start, '--machine', 'qa-peer', *worker, agent['cwd'], 'qa-route'], ''),
        ('refuse unmapped machine', 1, [program, 'type', 'a1@qa-absent'], REFUSE_UNKNOWN_MACHINE),
        ('type exact UTF-8 plus Enter on the SSH peer', 0,
         [program, 'type', agent['address'], '--key', '界', '--key', 'Enter'], ''),
        ('stop the exact peer agent', 0, [program, 'stop', agent['address']], ''),
    ]
    return {
        'scope': str(scope), 'machines': {'origin': 'origin-id', 'peer': 'peer-id'},
        'route': {'machine_id': 'peer-id', 'route': ['peer-id'], 'state': 'online', 'name': 'qa-peer'},
        'link': [program, 'machine', 'connect', '--home', str(scope / 'peer-facade'),
                 '-F', str(scope / 'ssh_config'), 'fixture-peer'],
        'sshd.log': 'Server listening on 127.0.0.1 port 123.\n'
                    'Accepted publickey for example from 127.0.0.1 port 456\n'
                    'Accepted publickey for example from 127.0.0.1 port 457\n',
        'inspect': {'peer': agent, 'origin': deepcopy(agent)},
        'unrelated_before': local, 'unrelated_after': deepcopy(local),
        'refusal': {'peer_input_hex': '', 'unrelated': deepcopy(local)},
        'peer_effect': {**agent, 'input_hex': INPUT.hex()},
        'peer_stopped': {'reference': agent['reference'], 'process': 'ended'},
        'commands': [{'label': label, 'status': status, 'argv': argv, 'stderr': stderr}
                     for label, status, argv, stderr in commands],
    }


class NativeSshEvidence(unittest.TestCase):
    def test_refuses_stale_attempt_output_and_changed_program(self):
        with tempfile.TemporaryDirectory(prefix='native-ssh-evidence-') as directory:
            root = Path(directory)
            receipt, output = (root / name for name in ('receipt.json', 'console.log'))
            digests = {}
            for name in PROGRAMS:
                binary = root / name
                binary.write_text(name)
                binary.chmod(0o700)
                digests[name] = hash_file(binary)
            attempt = 'local/native-ssh-1'
            saved = {
                **observations(root),
                'source': source_identity(attempt), 'program_sha256': digests,
                'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'},
            }
            success = ssh_success(saved)
            saved['success'] = success
            receipt.write_text(json.dumps(saved))
            marker = SUCCESS_MARKER + json.dumps(success) + '\n'
            output.write_text(marker)
            verified_ssh(root, receipt, output, attempt)
            with self.assertRaisesRegex(AcceptanceError, 'source and attempt'):
                verified_ssh(root, receipt, output, 'local/native-ssh-2')
            for changed in ('', marker + marker, marker.replace(NATIVE_SSH_CASE, 'other-case')):
                with self.subTest(output=changed):
                    output.write_text(changed)
                    with self.assertRaisesRegex(AcceptanceError, 'marker did not match'):
                        verified_ssh(root, receipt, output, attempt)
            output.write_text(marker)
            receipt.write_text(json.dumps({**saved, 'cleanup': {**saved['cleanup'], 'sockets_absent': False}}))
            with self.assertRaisesRegex(AcceptanceError, 'fixture cleanup'):
                verified_ssh(root, receipt, output, attempt)

            for field, replacement in {
                'route': {'machine_id': 'peer-id', 'route': ['wrong'], 'state': 'online', 'name': 'qa-peer'},
                'inspect': {},
                'sshd.log': '',
                'commands': [],
                'peer_effect': {**saved['peer_effect'], 'input_hex': '780d'},
                'refusal': {**saved['refusal'], 'peer_input_hex': '780d'},
                'unrelated_after': {**saved['unrelated_after'], 'input_hex': '780d'},
            }.items():
                with self.subTest(field=field):
                    changed = {**saved, field: replacement}
                    changed['success'] = {**success, 'observations_sha256': digest(
                        {key: value for key, value in changed.items() if key != 'success'}
                    )}
                    receipt.write_text(json.dumps(changed))
                    output.write_text(SUCCESS_MARKER + json.dumps(changed['success']) + '\n')
                    with self.assertRaisesRegex(AcceptanceError, 'native SSH did not observe|observations are incomplete'):
                        verified_ssh(root, receipt, output, attempt)
            receipt.write_text(json.dumps(saved))
            output.write_text(marker)
            (root / 'facade-mcp').write_text('different program')
            with self.assertRaisesRegex(AcceptanceError, 'case and the checked programs'):
                verified_ssh(root, receipt, output, attempt)
