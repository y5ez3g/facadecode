"""Collect and replay real-shaped GitHub responses through a fixture-only gh."""

from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from catalog import AcceptanceError, read_json
from gate_collect import NATIVE_RECEIPTS, collect
from gate_shadow import Pending, decide
from merge_review import COLD, CORE, EXTENSION, REMOTE, SHADOW
from test_gate_shadow import GateFixture, PULL, REPO


GITHUB = '''import json
from pathlib import Path
import sys

config = Path(__file__).with_name('responses.json')
fixture = json.loads(config.read_text())
args = sys.argv[1:]
assert args[:-1] in (['api'], ['api', '--paginate', '--slurp']), args
endpoint = args[-1]
log = config.with_name('calls.jsonl')
calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
with log.open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
if endpoint in fixture['archives']:
    sys.stdout.buffer.write(Path(fixture['archives'][endpoint]).read_bytes())
else:
    responses = fixture['responses'][endpoint]
    count = sum(call[-1] == endpoint for call in calls)
    print(json.dumps(responses[min(count, len(responses) - 1)]))
'''


class CollectionFixture(GateFixture):
    def create_collection_fixture(self, path, **candidate):
        self.prepare(path, **candidate)
        self.collection = self.observations.parent / 'collected'
        self.bin = self.observations.parent / 'stub-bin'
        self.bin.mkdir()
        cli = self.bin / 'gh'
        cli.write_text(f'#!{sys.executable}\n{GITHUB}')
        cli.chmod(0o700)
        fixture_path = str(self.bin) + os.pathsep + os.environ.get('PATH', os.defpath)
        self.enterContext(patch.dict(os.environ, {'PATH': fixture_path}))

        self.responses, self.archives = {}, {}
        self.prefix = f'repos/{REPO}'
        self.runs_endpoint = f'{self.prefix}/actions/runs?event=pull_request&head_sha={self.plan["head"]}&per_page=100'
        candidate = self.snapshot['candidate']
        self.respond(f'{self.prefix}/pulls/{PULL}', candidate['pull'])
        self.respond(f'{self.prefix}/git/ref/heads/main', candidate['main'])
        self.respond(f'{self.prefix}/git/commits/{self.plan["merge"]}', candidate['merge'])
        workflows = self.snapshot['workflows']
        self.respond(f'{self.prefix}/actions/workflows?per_page=100',
                     self.pages('workflows', [item['registration'] for item in workflows.values()]))
        self.respond(self.runs_endpoint, self.pages('workflow_runs', [item['run'] for item in workflows.values()]))
        for name, item in workflows.items():
            run = item['run']
            endpoint = f'{self.prefix}/actions/runs/{run["id"]}'
            self.respond(f'{endpoint}/attempts/1/jobs?per_page=100', self.pages('jobs', item['jobs']))
            self.respond(f'{self.prefix}/check-suites/{run["check_suite_id"]}/check-runs?filter=all&per_page=100',
                         self.pages('check_runs', item['checks']))
            if 'artifacts' not in item:
                continue
            self.respond(f'{endpoint}/artifacts?per_page=100', item['artifacts'])
            if name in NATIVE_RECEIPTS:
                self.native_archive(name)
            if name == SHADOW:
                for entry in item['artifacts'][0]['artifacts']:
                    self.archives[f'{self.prefix}/actions/artifacts/{entry["id"]}/zip'] = str(
                        self.observations.parent / 'shadow' / (entry['name'] + '.zip'),
                    )

    @staticmethod
    def pages(field, items):
        return [{'total_count': len(items), field: items}]

    def respond(self, endpoint, *responses):
        self.responses[endpoint] = responses

    def native_archive(self, workflow, **changes):
        name, member = NATIVE_RECEIPTS[workflow]
        observation = self.snapshot['workflows'][workflow]
        run_id = observation['run']['id']
        source = {'revision': self.plan['merge'], 'tree': self.plan['tree'], 'run': f'github/{run_id}/1'}
        if workflow == EXTENSION:
            source.update(run=str(run_id), attempt='1')
        source.update(changes)
        receipt = {'source': source}
        if workflow == REMOTE:
            receipt = {'inputs': receipt}
        archive = self.bin / f'{name}.zip'
        with ZipFile(archive, 'w') as package:
            package.writestr(member, json.dumps(receipt))
        data = archive.read_bytes()
        entry = next(item for item in observation['artifacts'][0]['artifacts'] if item['name'] == name)
        entry.update(size_in_bytes=len(data), digest='sha256:' + sha256(data).hexdigest())
        self.archives[f'{self.prefix}/actions/artifacts/{entry["id"]}/zip'] = str(archive)

    def write_responses(self):
        (self.bin / 'responses.json').write_text(json.dumps({'responses': self.responses, 'archives': self.archives}))

    def collect_fixture(self, status=None, **pins):
        self.write_responses()
        result = collect(self.root, REPO, PULL, self.collection, **pins)
        if status is not None:
            self.assertEqual(result['status'], status, result['blockers'])
        return result

    def queries(self):
        return [json.loads(line)[-1] for line in (self.bin / 'calls.jsonl').read_text().splitlines()]


class GateCollectionTests(CollectionFixture, unittest.TestCase):
    def test_rejected_plan_keeps_the_observed_candidate_and_skips_workflow_reads(self):
        self.create_collection_fixture('extension/src/extension.ts')
        reason = "invalid or duplicate case ID 'framework/configuration/cli-field/args'"
        with patch('gate_collect.candidate_plan', side_effect=AcceptanceError(reason)):
            result = self.collect_fixture('failure')
        self.assertEqual(result['candidate'], {
            key: self.plan[key] for key in ('repo', 'pull', 'head', 'base', 'merge', 'tree')
        })
        self.assertEqual(result['blockers'], [{'status': 'failure', 'reason': reason}])
        self.assertFalse(self.collection.exists())
        self.assertEqual(self.queries(), [
            f'{self.prefix}/pulls/{PULL}',
            f'{self.prefix}/git/ref/heads/main',
            f'{self.prefix}/git/commits/{self.plan["merge"]}',
        ])

    def test_extension_collection_replays_using_the_existing_local_contract(self):
        self.create_collection_fixture('extension/src/extension.ts')
        result = self.collect_fixture('success', head=self.plan['head'], base=self.base)
        observations = self.collection / 'observations.json'
        self.assertEqual(result['observations'], str(observations))
        snapshot = read_json(observations)
        self.assertEqual(set(snapshot['workflows']), {SHADOW, EXTENSION})
        native = snapshot['workflows'][EXTENSION]
        proof = native['source']['proof']
        self.assertEqual(proof['artifact'], 'release-fixture-linux-x64-1')
        self.assertEqual(result['verified_workflows'][EXTENSION]['source_receipt'], proof)
        replay = decide(*self.arguments, observations)
        self.assertEqual(replay['status'], 'success')
        self.assertEqual(replay['plan']['id'], result['plan']['id'])
        self.assertEqual(replay['verified_workflows'], result['verified_workflows'])
        self.assertEqual(len(list((self.collection / 'shadow').glob('*.zip'))), 1)
        self.assertEqual(len([endpoint for endpoint in self.queries() if endpoint.endswith('/zip')]), 2)
        receipt = next(item for item in native['artifacts'][0]['artifacts'] if item['name'] == proof['artifact'])
        receipt['digest'] = 'sha256:' + 'a' * 64
        observations.write_text(json.dumps(snapshot))
        stale = decide(*self.arguments, observations)
        self.assertEqual(stale['status'], 'pending')
        self.assertIn('source receipt refers to a different artifact', stale['blockers'][0]['reason'])

    def test_core_collection_uses_both_pilots_and_native_source_receipts(self):
        self.create_collection_fixture('core/crates/facade/src/cli.rs')
        result = self.collect_fixture('success')
        self.assertEqual(set(result['verified_workflows']), {SHADOW, CORE, EXTENSION})
        self.assertEqual(result['verified_workflows'][SHADOW]['shadow_replay']['verified_cases'],
                         {'core': 1, 'extension': 1})

    def test_expanded_collection_reads_nested_cold_and_remote_receipts(self):
        self.create_collection_fixture('core/crates/base/src/protocol/address.rs')
        result = self.collect_fixture('success')
        self.assertEqual(set(result['verified_workflows']), {SHADOW, CORE, EXTENSION, COLD, REMOTE})
        snapshot = read_json(self.collection / 'observations.json')
        self.assertEqual(snapshot['workflows'][COLD]['source']['proof']['member'], 'cold-cutover/receipt.json')
        self.assertEqual(snapshot['workflows'][REMOTE]['source']['merge'], self.plan['merge'])

    def test_empty_collection_only_reads_the_candidate(self):
        self.create_collection_fixture('ide/src/change.ts')
        result = self.collect_fixture('success')
        self.assertEqual(result['plan']['route'], 'empty')
        self.assertEqual(len(self.queries()), 6)
        self.assertTrue(all('/actions/' not in endpoint for endpoint in self.queries()))

    def test_explains_a_missing_run_and_a_run_for_a_stale_base(self):
        self.create_collection_fixture('extension/src/extension.ts')
        stale = 'a' * 40
        run = deepcopy(self.snapshot['workflows'][EXTENSION]['run'])
        run['pull_requests'][0]['base']['sha'] = stale
        self.respond(self.runs_endpoint, self.pages('workflow_runs', [run]))
        result = self.collect_fixture('pending')
        reasons = {item['workflow']: item['reason'] for item in result['blockers']}
        self.assertIn('no pull_request run', reasons[SHADOW])
        self.assertIn(f'stale bases {stale}', reasons[EXTENSION])
        self.assertTrue((self.collection / 'observations.json').is_file())
        self.assertFalse(any('/attempts/' in endpoint for endpoint in self.queries()))

    def test_preserves_a_stale_observed_merge_from_native_archive(self):
        self.create_collection_fixture('extension/src/extension.ts')
        stale = 'a' * 40
        self.native_archive(EXTENSION, revision=stale)
        result = self.collect_fixture('pending')
        self.assertTrue(any(item.get('workflow') == EXTENSION and 'stale merge' in item['reason']
                            for item in result['blockers']))
        file = self.collection / 'observations.json'
        self.assertEqual(read_json(file)['workflows'][EXTENSION]['source']['merge'], stale)
        self.assertEqual(decide(*self.arguments, file)['status'], 'pending')

    def test_explains_a_missing_native_artifact_without_downloading_it(self):
        self.create_collection_fixture('extension/src/extension.ts')
        entry = self.snapshot['workflows'][EXTENSION]
        artifact = next(item for item in entry['artifacts'][0]['artifacts']
                        if item['name'] == 'release-fixture-linux-x64-1')
        remaining = [item for item in entry['artifacts'][0]['artifacts'] if item is not artifact]
        self.respond(f'{self.prefix}/actions/runs/{entry["run"]["id"]}/artifacts?per_page=100',
                     self.pages('artifacts', remaining))
        result = self.collect_fixture('failure')
        self.assertTrue(any(item.get('workflow') == EXTENSION and artifact['name'] in item['reason']
                            for item in result['blockers']))
        self.assertNotIn(f'{self.prefix}/actions/artifacts/{artifact["id"]}/zip', self.queries())

    def test_attempt_churn_cannot_publish_a_snapshot(self):
        self.create_collection_fixture('extension/src/extension.ts')
        run = self.snapshot['workflows'][EXTENSION]['run']
        shadow_run = self.snapshot['workflows'][SHADOW]['run']
        self.respond(self.runs_endpoint, self.pages('workflow_runs', [shadow_run, run]),
                     self.pages('workflow_runs', [shadow_run, {**run, 'run_attempt': 2}]))
        with self.assertRaisesRegex(Pending, 'attempts changed'):
            self.collect_fixture()
        self.assertFalse(self.collection.exists())

    def test_head_churn_and_a_stale_explicit_pin_are_reported(self):
        self.create_collection_fixture('ide/src/change.ts')
        old = self.snapshot['candidate']['pull']
        new = {**old, 'head': {**old['head'], 'sha': 'a' * 40}}
        self.respond(f'{self.prefix}/pulls/{PULL}', old, new)
        with self.assertRaisesRegex(Pending, 'head changed'):
            self.collect_fixture()
        self.assertFalse(self.collection.exists())
        with self.assertRaisesRegex(Pending, 'head changed'):
            self.collect_fixture(head=self.plan['head'])

    def test_cancelled_current_attempt_keeps_its_record_without_reading_evidence(self):
        self.create_collection_fixture('extension/src/extension.ts')
        run = self.snapshot['workflows'][EXTENSION]['run']
        run['conclusion'] = 'cancelled'
        result = self.collect_fixture('failure')
        self.assertTrue(any(item.get('workflow') == EXTENSION and 'cancelled' in item['reason']
                            for item in result['blockers']))
        self.assertFalse(any(f'/runs/{run["id"]}/attempts/' in endpoint for endpoint in self.queries()))
