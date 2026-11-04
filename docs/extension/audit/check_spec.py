#!/usr/bin/env python3
"""Audit the extension specification's structure and references (no product runtime tests)."""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'docs/extension'
NORM = [SPEC / x for x in [
    'PRODUCT.md', 'EXPERIENCE.md', 'RULES.md', 'UX.md',
    'features/LIFECYCLE.md', 'features/WORKTREES.md', 'features/PANEL.md', 'features/COLLABORATION.md',
    'engineering/ARCHITECTURE.md', 'engineering/CLIS.md', 'engineering/MCP.md', 'engineering/VERIFICATION.md',
]]
errors = []
links = 0
rule_count = 0


def anchors(path):
    seen = {}
    out = set()
    for heading in re.findall(r'^#{1,6} ([^\n]+)', path.read_text(encoding='utf-8'), re.M):
        key = re.sub(r'[^\w\- ]', '', heading.strip().lower()).replace(' ', '-')
        n = seen.get(key, 0)
        seen[key] = n + 1
        out.add(key + (f'-{n}' if n else ''))
    return out


# Structure: numbered groups and rules, a bold decision opening each rule, Checks, no change history.
known = {}
for p in NORM:
    s = p.read_text(encoding='utf-8')
    ids = re.findall(r'^### (\d+\.\d+) ', s, re.M)
    groups = re.findall(r'^## (\d+) ', s, re.M)
    known[p.stem] = set(ids) | set(groups)
    rule_count += len(ids)
    if len(ids) != len(set(ids)):
        errors.append(f'{p.name}: repeated rule ID')
    if p.stem != 'PRODUCT' and '## Checks' not in s:
        errors.append(f'{p.name}: missing Checks')
    current_group = None
    for line in s.splitlines():
        g = re.match(r'^## (\d+) ', line)
        if g:
            current_group = g.group(1)
        r = re.match(r'^### (\d+)\.\d+ ', line)
        if r and r.group(1) != current_group:
            errors.append(f'{p.name}: rule {line[4:].split()[0]} is outside group {r.group(1)}')
    for m in re.finditer(r'^### (\d+\.\d+) [^\n]+\n(.*?)(?=^### |^## |\Z)', s, re.M | re.S):
        if not m.group(2).lstrip().startswith('**'):
            errors.append(f'{p.name}: rule {m.group(1)} missing bold decision')
    if any(line.rstrip() != line for line in s.splitlines()):
        errors.append(f'{p.name}: trailing whitespace')
    if s.count('```') % 2:
        errors.append(f'{p.name}: unmatched code fence')

for p in SPEC.rglob('*.md'):
    s = p.read_text(encoding='utf-8')
    if re.search(r'^## Change log', s, re.M):
        errors.append(f'{p.relative_to(ROOT)}: change log (history belongs to git)')
    for ref in sorted(set(re.findall(r'\b[DO]\d{2,3}\b', s))):
        errors.append(f'{p.relative_to(ROOT)}: decision reference {ref}')
if (SPEC / 'DECISIONS.md').exists():
    errors.append('docs/extension/DECISIONS.md exists; decisions belong in their owning rules')

# Numbered references between normative documents.
for p in NORM:
    for doc, n in re.findall(r'\b([A-Z][A-Z]+)-(\d+(?:\.\d+)?)', p.read_text(encoding='utf-8')):
        if doc in known and n not in known[doc]:
            errors.append(f'{p.name}: invalid reference {doc}-{n}')

# Local Markdown links and anchors.
paths = [ROOT / 'AGENTS.md', ROOT / 'README.md', ROOT / 'CONTRIBUTING.md', ROOT / 'extension/AGENTS.md',
         ROOT / 'extension/README.md'] + list((ROOT / 'docs').glob('*.md')) + list(SPEC.rglob('*.md'))
for p in paths:
    for ref in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)', p.read_text(encoding='utf-8')):
        if re.match(r'\w+://', ref):
            continue
        target, _, anchor = ref.partition('#')
        q = (p.parent / target).resolve() if target else p
        links += 1
        if not q.exists():
            errors.append(f'{p.relative_to(ROOT)}: missing {ref}')
        elif anchor and q.suffix == '.md' and anchor not in anchors(q):
            errors.append(f'{p.relative_to(ROOT)}: missing anchor {ref}')

result = {
    'status': 'PASS' if not errors else 'FAIL',
    'normative_documents': len(NORM),
    'current_rules': rule_count,
    'local_links_checked': links,
    'errors': errors,
    'scope': 'Extension specification structure and references only; no runtime claims.',
}
print(json.dumps(result, indent=2))
sys.exit(bool(errors))
