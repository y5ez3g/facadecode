# Facade Code extension

The Facade Code extension is a VS Code extension providing infrastructure for a person and their coding agents to work
together. This file routes work on the extension in `extension/`; the repository-wide rules are in [../AGENTS.md](../AGENTS.md).

## 1 Start here

1. Read [the extension's specification index](../docs/extension/README.md), then [PRODUCT](../docs/extension/PRODUCT.md)
   and [EXPERIENCE](../docs/extension/EXPERIENCE.md). These say what the user is building in plain terms.
2. Read [RULES](../docs/extension/RULES.md), then the feature you are changing. UI work also reads [UX](../docs/extension/UX.md).
3. Before implementation/testing, read [ARCHITECTURE](../docs/extension/engineering/ARCHITECTURE.md), especially group 5, and
   [VERIFICATION](../docs/extension/engineering/VERIFICATION.md). Respect the already dirty working tree.
4. Follow the current user instructions for assignments, model choices, pauses and authorization. Documentation
   cleanup does not resume a paused implementation task.

The extension is built in incremental steps. Each step is a complete product of its own scope; code, tests and translations
of a later step are not added ahead of it. [README.md](README.md) says which step the code is at.

## 2 The specification

**Only `../docs/extension/` defines the extension's active product. Its status is a normative implementation target, not a
runtime certification.**

The [specification index](../docs/extension/README.md) lists its layers and each document's responsibility. Product constrains
experience and shared rules; those constrain features and UX; engineering implements their contracts.
[Decisions](../docs/extension/DECISIONS.md) records owner calibration and deductions; it does not override normative files.
Verification results accompany the tested build or handoff.

## 3 Write and change a rule

- Higher layers constrain lower ones. Each decision has one owner; other files refer to it by `DOCUMENT-n.m`.
- Normative files start with an overview, use `## n Group` and `### n.m Rule`, and open each rule with a bold decision.
  Keep present tense. Use exact cases/values in lower layers; include a reason where it helps.
- Separate the target from evidence: “not run,” “historical claim,” “failed” and “passed” have different meanings.
  Never make a document match a code defect just to call the work complete.
- Amend the owning rule first, record the reason, update dependent schemas/scenarios/references, then implement.
  Preserve owner-calibrated decisions. Never weaken a requirement to hide an implementation gap.

## 4 Engineering safeguards

The full rules are [ARCHITECTURE-5](../docs/extension/engineering/ARCHITECTURE.md). In particular:

- Preserve unrelated edits; no reset/clean, staging, commits, push, publishing or release without an owner request.
- Never drive/reload/close the owner's existing editor windows/agents as tests. Every test editor has isolated temporary
  `--user-data-dir` and `--extensions-dir`; even version probes must not launch the owner's editor profile.
- Tests point Facade's root at a temporary folder with `FACADE_HOME`; the extension keeps its data in its `extension`
  subfolder (`~/.facade/extension` by default), beside the Facade Code IDE's own data. Do not override `HOME` for an editor
  process.
- Real CLI probes use isolated state. Never run a real Qwen probe. Task-specific agent authorization does not permit
  changes to global credentials/settings.
- Run meaningful regression tests and required milestone gates. Docs-only edits use the spec audit, not code suites.
- Native/remote support and true window-lifetime/draft detection require evidence. Do not equate a build with a working product.

## 5 Build and test

Use Node 24 (`.nvmrc`). Run every command inside `extension/`:

```sh
npm ci
npm run compile
npm test
node scripts/l10n.mjs check
npm run package
npm run test:package
npm run test:integration
```

`npm run test:package` checks the VSIX `npm run package` made. The integration suite runs the official VS Code with its own
profile, a temporary Facade root and fake CLIs only; `FACADE_IT_ONLY=journeys` or `conversion` runs one part of it, and
`FACADE_IT_KEEP=1` keeps what a run left.

## 6 Other files

`README.md` introduces the extension and honestly states development status. It follows the specification and is not a
second specification. Specifications are English; conversation with the owner is Chinese.
