"""Record an exact current-main PR candidate and its observed readiness."""

import argparse
from datetime import UTC, datetime
import json
import subprocess
import sys

from github_candidate_summary import IDENTITY, candidate_scope
from github_evidence import SHA
from merge_review import current_candidate


def observe_candidate(candidate):
    key, paths = candidate_scope(candidate)
    verified = current_candidate(*key)
    tree = verified['tree']
    if type(verified['draft']) is not bool or not isinstance(tree, str) or not SHA.fullmatch(tree):
        raise ValueError(f'PR #{key[1]} has invalid readiness or test merge tree metadata')
    if current_candidate(*key) != verified:
        raise ValueError(f'PR #{key[1]} changed while recording the candidate observation')

    return {
        'kind': 'candidate_observation',
        **dict(zip(IDENTITY, key)),
        'repository_id': verified['repo_id'],
        'head_ref': verified['branch'],
        'base_ref': 'main',
        'merge': verified['merge'],
        'tree': tree,
        'draft': verified['draft'],
        'ready_for_review': not verified['draft'],
        'mergeable': True,
        'observed_at': datetime.now(UTC).isoformat(),
        'eligible_at': None,
        'expected_workflow_paths': paths,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', dest='repository', required=True, help='GitHub repository as owner/name')
    parser.add_argument('--pr', dest='pull', required=True, type=int)
    parser.add_argument('--head', required=True, help='expected PR head commit')
    parser.add_argument('--base', required=True, help='expected live main commit')
    parser.add_argument('--workflow', dest='expected_workflow_paths', required=True, action='append',
                        metavar='PATH', help='required workflow path, repeat for each path')
    args = parser.parse_args()
    try:
        print(json.dumps(observe_candidate(vars(args)), indent=2))
    except (OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as error:
        print(f'Could not record the candidate observation ({error})', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
