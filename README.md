# Facade Code

Facade Code is a fork of [Visual Studio Code](https://github.com/microsoft/vscode). It lists
a workspace's folders in a column of their own and opens the rest of the window on one of
them at a time, so that the explorer, the title, the editors, the terminal and source
control all read as though the window had been opened on that folder alone.

## What it adds

- **The workspace bar.** Every folder of the window in one column: click one and the window
  is on it, with its own editors, terminals and focus, the way it was left. Folders are
  added by Open Folder, a drop or the command line, `facade <folder>`, and taken out with
  Remove Folder, which asks first only when something would be lost.
- **Git worktrees.** A repository's worktrees are rows under it: New Worktree makes one,
  copies the local files it needs (`.worktreeinclude`) and runs its setup, and Delete
  Worktree removes it, saying first what would be lost.
- **Agents.** Coding agents run in terminals of the folder they work in, and the bar shows
  which folder runs which.

Everything else is VS Code's: its editor, its extensions (from
[Open VSX](https://open-vsx.org)), its settings and keybindings, and the `.vscode` folder
and `.code-workspace` files of every project.

## Getting it

Each release is on the repository's
[Releases](https://github.com/y5ez3g/facadecode/releases) page: a disk image for macOS, an
installer for Windows and a `.deb` package for Ubuntu. Facade Code installs beside VS Code
and shares nothing with it: its own settings, extensions and command line, `facade`.

## Building from source

It builds as VS Code does; see VS Code's
[How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) for the
tools it needs. How this fork's branches and builds work is in
[`facade-code-spec/ENGINEERING.md`](facade-code-spec/ENGINEERING.md), and what it is meant
to do, in the rest of [`facade-code-spec/`](facade-code-spec/).

## Feedback

Bugs and ideas go to the repository's [issues](https://github.com/y5ez3g/facadecode/issues);
Help > Report Issue opens a new one. Security vulnerabilities go privately, as
[`SECURITY.md`](SECURITY.md) says.

## License

MIT, as VS Code's code is: [`LICENSE.txt`](LICENSE.txt) carries Microsoft's copyright notice
for the code taken from VS Code and the Facade Code contributors' for this fork's.
