# Repository instructions

This repository contains Facade Code Extension, Facade Code Framework and the IDE source. Documentation lives under
`docs/`.

## Routing

- IDE source, dependencies, build scripts and tests: `ide/`. Read [ide/AGENTS.md](ide/AGENTS.md) and
  [docs/ide/ENGINEERING.md](docs/ide/ENGINEERING.md) before changing it.
- Standalone extension: `extension/`. Read [extension/AGENTS.md](extension/AGENTS.md) before changing it.
- IDE specifications: `docs/ide/`. The former `facade-code-spec/` directory has moved here.
- Translated repository documentation: `docs/locales/`. Runtime translations remain in `ide/locales/`.
- Extension specification: `docs/extension/`.
- Facade Code Framework lives in `framework/`. Read [framework/README.md](framework/README.md) and
  [Facade Code Framework engineering](docs/framework/ENGINEERING.md) before changing it. The
  [island index](docs/framework/ARCHITECTURE.md#islands) identifies owners, interfaces and checks.
  Use [Facade Code Framework features](docs/framework/FEATURES.md) for Shell commands
  and [Facade Code Framework engineering](docs/framework/ENGINEERING.md#tests) for test isolation and cleanup.
  For published API and stored data changes, follow the
  [compatibility review](docs/framework/ENGINEERING.md#compatibility-contracts).

Run IDE development commands from `ide/`; open that folder to use its existing editor settings and development tools.
Keep GitHub workflows and repository-wide metadata at the repository root. Each product keeps its own package manifest
and build process. Moving the repository does not authorize integrating or replacing the old built-in agent extension.

## Working safely

Follow current user instructions and preserve unrelated tracked, untracked and ignored files. Work on a numbered
`feature/<number>-<name>` branch as specified in `docs/ide/ENGINEERING.md`; do not stage, commit, merge, push or release
unless requested. Never use the owner's live editor windows or agents as
test subjects. Editor tests use separate temporary user-data and extensions directories. Test real CLIs only in isolated
state; do not run real Qwen probes.

Validate the affected paths, build tools and behavior. Report checks actually run and any remaining limitations.

## README approval

Every `README.md` in this repository is protected, including the root file, nested files and translations.
Obtain the repository owner's explicit prior approval before creating, editing, deleting, translating, renaming
or moving any of them. This covers link-only, formatting and automated edits.
