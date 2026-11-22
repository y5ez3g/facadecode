"""Acceptance pilot selection from the candidate's changed paths."""

import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from acceptance import affected_products, changed_paths, review_bound_cases
from catalog import AcceptanceError, Case


class PilotScopeTests(unittest.TestCase):
    def test_a_surviving_api_cannot_lose_its_test(self):
        case_id = 'core/shell/command/start'
        binding = {'runner': 'core-scenario', 'target': 'cli', 'name': 'start_fixture'}
        before = [{'id': case_id, 'assertion': 'Observe the started process', 'stage': 'pr', 'test': binding}]
        case = Case(case_id, 'pr', 'Observe the started process', (), binding)
        review_bound_cases({case_id: case}, before)
        with self.assertRaisesRegex(AcceptanceError, case_id):
            review_bound_cases({case_id: replace(case, test=None)}, before)

    def test_selects_product_changes_and_shared_inputs(self):
        both = ('core', 'extension')
        examples = {
            'docs and IDE': (('docs/CI-ACCEPTANCE.md', 'docs/core/protocol.md', 'core/README.md', 'ide/src/change.ts'), ()),
            'policy': (('ci/evidence.py',), both),
            'workflow': (('.github/workflows/extension-check.yml',), both),
            'release workflow': (('.github/workflows/extension-release.yml',), both),
            'release mirror': (('.github/release-mirror/worker.mjs',), both),
            'design': (('docs/CI.md',), both),
            'core code and editor binaries': (('core/crates/daemon/src/lib.rs',), both),
            'shared names': (('extension/src/base/names.ts',), both),
            'extension source': (('extension/src/extension.ts',), ('extension',)),
            'extension packaging': (('extension/package.json',), ('extension',)),
            'mixed': (('core/Cargo.lock', 'extension/package.json'), both),
        }
        for name, (paths, expected) in examples.items():
            with self.subTest(scenario=name):
                self.assertEqual(affected_products(paths), expected)

    def test_rename_out_of_product_still_selects_its_pilots(self):
        with tempfile.TemporaryDirectory(prefix='acceptance-scope-') as directory:
            root = Path(directory)
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')

            def git(*args):
                return subprocess.check_output([
                    'git', '-C', str(root), '-c', 'user.email=fixture@example.invalid',
                    '-c', 'user.name=CI Fixture', *args,
                ], env=env, stderr=subprocess.PIPE, text=True).strip()

            git('init', '-q')
            for name in ('core', 'docs'):
                (root / name).mkdir()
            old = 'core/removed interface.ts'
            new = 'docs/moved interface.ts'
            (root / old).write_text('a source file previously in Core\n')
            git('add', old)
            git('commit', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            git('mv', old, new)
            git('commit', '-qm', 'candidate rename')
            self.assertEqual(set(changed_paths(root, base)), {old, new})
            self.assertEqual(affected_products(changed_paths(root, base)), ('core', 'extension'))


if __name__ == '__main__':
    unittest.main()
