#!/usr/bin/env python3
"""Audit specification structure, local links, old-rule coverage (no product runtime tests)."""
from pathlib import Path
import re,json,sys
ROOT=Path(__file__).resolve().parents[3]
SPEC=ROOT/'docs/extension'
NORM=[SPEC/x for x in ['PRODUCT.md','EXPERIENCE.md','RULES.md','UX.md','features/LIFECYCLE.md','features/WORKTREES.md','features/PANEL.md','engineering/ARCHITECTURE.md','engineering/CLIS.md','engineering/VERIFICATION.md']]
LEDGER=[SPEC/'audit/source-inventory.json',SPEC/'audit/migration.json',SPEC/'MIGRATION.md']
errors=[];links=0;rule_count=0

def anchors(path):
    seen={};out=set()
    for h in re.findall(r'^#{1,6} ([^\n]+)',path.read_text(),re.M):
        key=re.sub(r'[^\w\- ]','',h.strip().lower()).replace(' ','-')
        n=seen.get(key,0);seen[key]=n+1;out.add(key+(f'-{n}' if n else ''))
    return out

known={}
for p in NORM:
    s=p.read_text();ids=re.findall(r'^### (\d+\.\d+) ',s,re.M)
    groups=set(re.findall(r'^## (\d+) ',s,re.M));known[p.stem]=set(ids)|groups;rule_count+=len(ids)
    if len(ids)!=len(set(ids)):errors.append(f'{p}: repeated rule ID')
    if '## Change log' not in s:errors.append(f'{p}: missing change log')
    if p.stem!='PRODUCT' and '## Checks' not in s:errors.append(f'{p}: missing checks')
    for m in re.finditer(r'^### (\d+\.\d+) [^\n]+\n(.*?)(?=^### |^## |\Z)',s,re.M|re.S):
        if m.group(1).split('.')[0] not in groups: errors.append(f'{p}: orphan group {m.group(1)}')
        if not m.group(2).lstrip().startswith('**'):errors.append(f'{p}: rule {m.group(1)} missing bold decision')
    if any(line.rstrip()!=line for line in s.splitlines()): errors.append(f'{p}: trailing whitespace')
    if s.count('```')%2:errors.append(f'{p}: unmatched code fence')

for p in NORM:
    for doc,n in re.findall(r'\b([A-Z][A-Z]+)-(\d+(?:\.\d+)?)',p.read_text()):
        if doc in known and n not in known[doc]:errors.append(f'{p.name}: invalid current reference {doc}-{n}')

paths=[ROOT/'AGENTS.md',ROOT/'README.md']+list((ROOT/'docs').glob('*.md'))+list(SPEC.rglob('*.md'))
for p in paths:
    for ref in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)',p.read_text()):
        if re.match(r'\w+://',ref): continue
        target,_,anchor=ref.partition('#');q=(p.parent/target).resolve() if target else p
        links+=1
        if not q.exists(): errors.append(f'{p.relative_to(ROOT)}: missing {ref}')
        elif anchor and q.suffix=='.md' and anchor not in anchors(q):errors.append(f'{p.relative_to(ROOT)}: missing anchor {ref}')

# The migration ledger joins the specification in the last of the extension's steps; until then its files are absent.
ledger=[p.exists() for p in LEDGER];inv=None;source_ids=[]
if any(ledger) and not all(ledger):errors.append('Incomplete migration ledger: missing '+', '.join(str(p.relative_to(SPEC)) for p,e in zip(LEDGER,ledger) if not e))
if all(ledger):
    inv=json.loads((SPEC/'audit/source-inventory.json').read_text());migration=json.loads((SPEC/'audit/migration.json').read_text())
    source_ids=[r['id'] for r in inv['rules']];mapped=[r['id'] for r in migration]
    if len(source_ids)!=427 or len(inv['groups'])!=83 or len(inv['gaps'])!=97: errors.append('Source inventory counts changed')
    if sorted(source_ids)!=sorted(mapped) or len(mapped)!=len(set(mapped)): errors.append('Rule migration missing/duplicated')
    for r in migration:
        target,_,anchor=r['target'].partition('#');p=SPEC/target
        if not p.exists() or (anchor and anchor not in anchors(p)):errors.append('Bad migration target: '+r['id'])
        if r['disposition'] not in ['rewritten','retired','retained'] or not r['reason']: errors.append('Incomplete disposition: '+r['id'])
    for g in inv['groups']:
        if not any(r['id'].startswith(g['id']+'.') for r in migration):errors.append('Unmapped group '+g['id'])

for p in (ROOT/'docs').glob('*.md'):
    if p.stem in ['PRODUCT','UX','ARCHITECTURE','PANEL','LIFECYCLE','WORKTREES','TOOLS','MESSAGES','CLIS','EXTENSIONS','COMMANDS']:errors.append('Obsolete top-level spec '+str(p))

result={'status':'PASS' if not errors else 'FAIL','normative_documents':len(NORM),'current_rules':rule_count,'local_links_checked':links,'migration_ledger':'checked' if inv else 'absent; checked once its files are added','source_groups':len(inv['groups']) if inv else None,'source_rules':len(source_ids) if inv else None,'source_gap_claims':len(inv['gaps']) if inv else None,'archive_files_checked':0,'errors':errors,'scope':'Extension specification structure, references and, when present, migration coverage only; no runtime claims.'}
print(json.dumps(result,indent=2));sys.exit(bool(errors))
