# Contributing to Facade Code

Thank you for helping. Facade Code is developed in the open at
[github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Bugs and ideas

Open an [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue opens a new one
with your version filled in. Please search the existing issues first, and for a bug, say:

- what you did, what you expected, and what happened instead;
- the version, from Help > About, and your operating system;
- for an agent problem, which agent CLI and which version.

Security vulnerabilities are not reported in issues; see [`SECURITY.md`](SECURITY.md).

## Code

How this repository works is in [`facade-code-spec/ENGINEERING.md`](facade-code-spec/ENGINEERING.md):
setting up a build, the commands that check a change, and the rules below in full.

- Branch from `main` as `feature/<name>`.
- Merge, never rebase: a feature lands on `main` with `--no-ff`, after review.
- Keep Facade Code's files together, and in VS Code's files add optional hooks rather than
  rewriting their logic, so that merging a newer VS Code stays cheap.
- Every feature has a switch, and off means stock VS Code.
- Every change lands with tests.
- English everywhere: documents, comments and commit messages.

What a feature is meant to do is in [`facade-code-spec/`](facade-code-spec/). For a change to
behavior, start from the spec, or open an issue to discuss it first.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT license](LICENSE.txt).
