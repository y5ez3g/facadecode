# Facade Code

This repository contains the IDE and reserves space for its independently distributed extension. Product documentation
is shared under `docs/`, separated by product.

## Routing

- IDE source, dependencies, build scripts and tests: `ide/`. Read [ide/AGENTS.md](ide/AGENTS.md) and
  [docs/ide/ENGINEERING.md](docs/ide/ENGINEERING.md) before changing it.
- Standalone extension: `extension/`, currently reserved for the owner to add the project.
- IDE specifications: `docs/ide/`. The former `facade-code-spec/` directory has moved here.
- Translated repository documentation: `docs/locales/`. Runtime translations remain in `ide/locales/`.
- Extension documentation: `docs/extension/`, currently reserved.

Run IDE development commands from `ide/`; open that folder to use its existing editor settings and development tools.
Keep GitHub workflows and repository-wide metadata at the repository root. Each product keeps its own package manifest
and build process. Moving the repository does not authorize integrating or replacing the old built-in agent extension.

## Working safely

Follow current user instructions and preserve unrelated tracked, untracked and ignored files. Work on a feature branch;
do not stage, commit, merge, push or release unless requested. Never use the owner's live editor windows or agents as
test subjects. Editor tests use separate temporary user-data and extensions directories. Test real CLIs only in isolated
state; do not run real Qwen probes.

Validate the affected paths, build tools and behavior. Report checks actually run and any remaining limitations.
