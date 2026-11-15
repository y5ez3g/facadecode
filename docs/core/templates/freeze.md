# Freeze: <island path>

<!-- A parent writes this before its children start; the bar raiser reviews it. Replace every <…>. A section that does
not apply says so in one line. -->

Owner: <name and agent ID>. Written <`date` output>. Branch `feature/<n>-<island path>`, worktree
`facadecode.worktrees/<n>-<island path>`, from `<start commit>`. Review: <where the bar raiser's review is>.

What the spec asks of this island: <one paragraph, in the spec's words where they are clear>.

## 1 The two lines

- **Keeps**: <invariants a reader can check against the code; no slogans>.
- **Never does**: <…>.

## 2 The layer

- **Its own code**: <files, and what each does>. Only what joins several children stays in the layer.
- **Shared values**: <the layer's values and constants the children may use, one a line>. Children use nothing else of
  the layer.

## 3 Each child

### 3.<k> <child>

- **Two lines**: what it keeps; what it never does.
- **Owns**: <fields, table methods, files>.
- **Frozen interface**: one line each, the exact signature and what it means. The child writes it as given and the layer
  calls it as given; a change goes up the chain first.
- **Gets at creation**: <the handles the parent passes in: a narrow type, a channel's sender or a closure>.
- **References out of the island**: <each shared value, handle type and dependency it uses; nothing else>.
- **Its paths**: <its folder or its one file>. Its commit touches nothing else.
- **Tests**: <its unit tests; the scenario tests that cover it>.

## 4 Wiring

Every exchange between siblings goes through the layer:

| Exchange | Who starts it | How the layer joins it, in order | Interfaces used |
| --- | --- | --- | --- |

Write each order that crosses children step by step. Where a handle is called while a lock is held, name the lock and
the handle.

## 5 What changes

- Behavior that changes, and who decided it: <the spec, the owner, the General TL>.
- The checks from [ENGINEERING](../ENGINEERING.md#islands), run on the layer's code: each line of the first check marked
  as a shared value, a handle or a dependency; any line of the others explained.
- The layer's build, `cargo clippy -- -D warnings` and its tests: <results, or "not written yet">.

## 6 For the children

- Done means: it builds; its tests pass; its part works when run; the frozen interface is unchanged; one commit with
  only its paths, its message saying what the island does.
- Report: the branch and commit; the checks' output on its paths; `git diff --stat <start>`, which lists only its paths.

## 7 No closed doors, new words, renames

- **No closed doors**: one line each on how the island keeps the rules in
  [ARCHITECTURE](../ARCHITECTURE.md#rules-between-islands), or "does not apply": branching by operating system; agents
  and messages known by their numbers, never a process ID or a local path; what clients show comes through the
  protocol; the Linux code stays.
- **New words**: <words the glossary lacks; send them to the bar raiser first>.
- **Renames**: <old name → new name, and the callers that change with it>.
