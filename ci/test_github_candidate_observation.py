from datetime import UTC, datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import call, patch

from github_candidate_observation import observe_candidate
from github_candidate_summary import summarize
from github_timing import timestamp


REPO = 'owner/name'
PR, BASE, HEAD, MERGE, TREE = 7, 'b' * 40, 'a' * 40, 'c' * 40, 'd' * 40
WORKFLOW = '.github/workflows/ci-acceptance.yml'
INPUT = {'repository': REPO, 'pull': PR, 'head': HEAD, 'base': BASE, 'expected_workflow_paths': [WORKFLOW]}
ORIGIN = {'full_name': REPO, 'id': 25}
ENTRY = {'number': PR, 'state': 'open', 'draft': False, 'mergeable': True, 'merge_commit_sha': MERGE,
         'head': {'sha': HEAD, 'ref': 'feature/7-sample', 'repo': ORIGIN},
         'base': {'sha': BASE, 'ref': 'main', 'repo': ORIGIN}, 'created_at': '2026-01-01T00:00:00Z'}
REF = {'ref': 'refs/heads/main', 'object': {'sha': BASE}}
COMMIT = {'sha': MERGE, 'parents': [{'sha': BASE}, {'sha': HEAD}], 'tree': {'sha': TREE}}
REQUESTS = [call(f'repos/{REPO}/pulls/{PR}'), call(f'repos/{REPO}/git/ref/heads/main'),
            call(f'repos/{REPO}/git/commits/{MERGE}')]


class CandidateObservation(unittest.TestCase):
    def test_captures_exact_candidate_without_workflow_results(self):
        before = datetime.now(UTC)
        with patch('merge_review.gh_json', side_effect=[ENTRY, REF, COMMIT] * 2) as gh:
            observed = observe_candidate({**INPUT, 'repository': 'Owner/Name'})
        self.assertEqual(gh.call_args_list, REQUESTS * 2)
        observed_at = timestamp(observed.pop('observed_at'))
        self.assertLessEqual(before, observed_at)
        self.assertLessEqual(observed_at, datetime.now(UTC))
        self.assertEqual(observed, {
            **INPUT, 'kind': 'candidate_observation', 'repository_id': ORIGIN['id'],
            'head_ref': ENTRY['head']['ref'], 'base_ref': 'main', 'merge': MERGE, 'tree': TREE,
            'draft': False, 'ready_for_review': True, 'mergeable': True, 'eligible_at': None,
        })

    def test_retains_draft_readiness_and_requires_separate_eligibility_evidence(self):
        draft = {**ENTRY, 'draft': True}
        with patch('merge_review.gh_json', side_effect=[draft, REF, COMMIT] * 2):
            observed = observe_candidate(INPUT)
        self.assertTrue(observed['draft'])
        self.assertFalse(observed['ready_for_review'])
        self.assertEqual((observed['merge'], observed['tree']), (MERGE, TREE))
        self.assertIsNone(observed['eligible_at'])
        with TemporaryDirectory(prefix='candidate-observation-') as directory:
            roster = Path(directory) / 'roster.json'
            roster.write_text(json.dumps({'observed_at': observed['observed_at'], 'candidates': [observed]}))
            with self.assertRaisesRegex(ValueError, 'needs an eligibility time'):
                summarize(roster)

    def test_rejects_stale_base_and_unverified_merge(self):
        for responses, reason in (
            ([ENTRY, {**REF, 'object': {'sha': HEAD}}], f'base is {BASE} and main is {HEAD}, expected {BASE}'),
            ([{**ENTRY, 'mergeable': None}, REF], 'no mergeable GitHub test revision'),
            ([ENTRY, REF, {**COMMIT, 'parents': [{'sha': HEAD}, {'sha': BASE}]}], 'reviewed base and head'),
            ([ENTRY, REF, {**COMMIT, 'tree': {'sha': 'invalid'}}], 'invalid readiness or test merge tree'),
        ):
            with self.subTest(reason=reason), patch('merge_review.gh_json', side_effect=responses), (
                self.assertRaisesRegex(ValueError, reason)
            ):
                observe_candidate(INPUT)

    def test_rejects_a_readiness_or_head_change_between_checks(self):
        draft = {**ENTRY, 'draft': True}
        moved = {**ENTRY, 'head': {**ENTRY['head'], 'sha': TREE}}
        for responses, reason in (
            ([draft, REF, COMMIT], 'changed while recording'),
            ([moved, REF], f'head changed to {TREE}'),
        ):
            with self.subTest(reason=reason), patch('merge_review.gh_json', side_effect=[ENTRY, REF, COMMIT] + responses), (
                self.assertRaisesRegex(ValueError, reason)
            ):
                observe_candidate(INPUT)

    def test_validates_the_candidate_and_workflow_roster_before_github_reads(self):
        for fields, reason in (({'head': 'not-a-sha'}, 'head and base commit SHAs'),
                               ({'expected_workflow_paths': [WORKFLOW, WORKFLOW]}, 'unique expected workflow paths')):
            with self.subTest(fields=fields), patch('merge_review.gh_json') as gh:
                with self.assertRaisesRegex(ValueError, reason):
                    observe_candidate({**INPUT, **fields})
                gh.assert_not_called()
