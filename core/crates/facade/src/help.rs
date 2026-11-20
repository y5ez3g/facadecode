//! The public Shell help pages and their usage examples.

pub(crate) struct Page {
    pub(crate) path: &'static str,
    intro: &'static str,
    pub(crate) usage: &'static str,
    examples: &'static str,
    details: &'static str,
}

impl Page {
    pub(crate) fn render(&self, machine: &str) -> String {
        let details = self.details.replace("{machine}", machine);
        format!(
            "{}\n\n{}\n\nExamples\n{}\n\n{details}\n",
            self.intro, self.usage, self.examples
        )
    }

    pub(crate) fn first_example(&self) -> &'static str {
        self.examples
            .lines()
            .next()
            .expect("help page has an example")
            .trim_start()
    }
}

pub(crate) fn page(path: &str) -> Option<&'static Page> {
    PAGES.iter().find(|page| page.path == path)
}

const START: Page = Page {
    path: "start",
    intro: r#"Start an agent from a coding CLI.

Facade options come before the CLI name. Everything after the CLI name is
passed to that CLI unchanged. Use that CLI's own flags for model, reasoning,
and prompts."#,
    usage: r#"Usage: facade start [OPTIONS] <CLI> [CLI_ARGS]..."#,
    examples: r#"  facade start codex
  facade start -d -n Nova codex --model gpt-6.2-sol
  facade start --machine devbox --workdir /work/app -d codex"#,
    details: r#"Arguments
  <CLI>          Configured coding CLI (e.g. claude, codex)
  [CLI_ARGS]...  Arguments passed to the CLI unchanged

Options
  -n, --name <NAME>          Name this agent (default: chosen by Facade)
      --machine <MACHINE>    Run on this machine (default: {machine})
      --workdir <DIRECTORY>  Working directory (default: current directory locally,
                             login directory remotely)
      --worktree <BRANCH>    Create a Git worktree and branch from current HEAD
  -d, --detach               Start in the background
  -h, --help                 Show help"#,
};

pub(crate) const PAGES: &[Page] = &[
    Page {
        path: "",
        intro: r#"Run AI coding agents that can collaborate across your machines.

Start Claude Code, Codex, or another coding CLI. Agents can start other
agents, send messages, read screens, and type in terminals — just as you do.
They run in the background while other agents direct them, across connected
machines as if on the same machine. Attach anytime to watch or take over.
Third-party agents can join as guests over MCP to exchange messages with
managed agents."#,
        usage: r#"Usage: facade [OPTIONS] [COMMAND]"#,
        examples: r#"  facade start codex
  facade list
  facade attach Nova
  facade start --machine devbox -d codex"#,
        details: r#"Agents
  start     Start an agent
  list      List active agents
  resume    List or resume agents and sessions
  stop      Stop an agent
  rename    Rename an agent

Interact
  attach    Open an agent's terminal
  send      Send a message to an agent
  screen    Read an agent's terminal output
  type      Type text or press keys in an agent's terminal

System
  status    Show Facade or agent status
  machine   Connect and manage machines over SSH
  upgrade   Upgrade Facade

Options
  -h, --help     Show help
  -V, --version  Print version

Run 'facade <COMMAND> --help' for examples and options.
Learn more at https://facadecode.com"#,
    },
    START,
    Page {
        path: "stop",
        intro: r#"Stop a running agent.

The agent's record and saved session are kept, so you can read its final
screen or resume it later."#,
        usage: r#"Usage: facade stop <AGENT>"#,
        examples: r#"  facade stop Nova
  facade stop a5@laptop"#,
        details: r#"Arguments
  <AGENT>  Agent reference, agent ID, or unique name

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "list",
        intro: r#"List active agents and connected guests.

Shows currently running managed agents and connected MCP guests across
reachable machines, newest first. Stopped agents move to 'facade resume'."#,
        usage: r#"Usage: facade list [--machine <MACHINE>]"#,
        examples: r#"  facade list
  facade list --machine devbox"#,
        details: r#"Options
      --machine <MACHINE>  List agents on this machine only
  -h, --help               Show help"#,
    },
    Page {
        path: "resume",
        intro: r#"List or resume stopped agents and saved CLI sessions.

Without arguments, lists resumable stopped agents across reachable machines
and saved sessions in the current directory. Pass a reference from the list
to open it in this terminal, or pass '-d' to resume in the background. Press
Ctrl+] to detach and leave it running."#,
        usage: r#"Usage:
  facade resume [--machine <MACHINE>]
  facade resume [-d|--detach] <REFERENCE>"#,
        examples: r#"  facade resume
  facade resume --machine devbox
  facade resume a5@laptop
  facade resume 7f3e9a1c
  facade resume -d a5@laptop"#,
        details: r#"Arguments
  <REFERENCE>  Stopped agent reference, agent ID, unique name, or session ID

Options
      --machine <MACHINE>  List resumable agents and sessions on this machine only
  -d, --detach           Resume in the background
  -h, --help             Show help"#,
    },
    Page {
        path: "rename",
        intro: r#"Rename an active agent, guest, or stopped agent.

Changes only the display name; the agent reference stays the same."#,
        usage: r#"Usage: facade rename <AGENT> <NAME>"#,
        examples: r#"  facade rename Nova review
  facade rename a5@laptop "Shell review""#,
        details: r#"Arguments
  <AGENT>  Agent reference, agent ID, or unique name (active agents take priority for duplicate names)
  <NAME>   New name

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "attach",
        intro: r#"Open a running managed agent's terminal.

Streams the agent's live terminal here so you can watch or type directly.
Press Ctrl+] to detach and leave the agent running in the background."#,
        usage: r#"Usage: facade attach <AGENT>"#,
        examples: r#"  facade attach Nova
  facade attach a5@laptop"#,
        details: r#"Arguments
  <AGENT>  Running managed agent reference, agent ID, or unique name

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "send",
        intro: r#"Send a message to an active agent or guest.

Waits up to 30 seconds for delivery: types and submits the message in a
managed agent's terminal once its input box is free, or waits for a guest to
read it over MCP. Messages can be up to 8,000 characters and 540 lines."#,
        usage: r#"Usage: facade send <RECIPIENT> <TEXT>"#,
        examples: r#"  facade send Nova "Check the build"
  facade send a5@laptop "Please review the diff in src/parser.rs""#,
        details: r#"Arguments
  <RECIPIENT>  Active agent or guest reference, agent ID, or unique name
  <TEXT>       Message text

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "screen",
        intro: r#"Read an agent's recent terminal output.

Prints the last lines of the terminal screen and scrollback as plain text.
Works for both running and stopped agents."#,
        usage: r#"Usage: facade screen [-n|--lines <N>] <AGENT>"#,
        examples: r#"  facade screen Nova
  facade screen -n 200 a5@laptop"#,
        details: r#"Arguments
  <AGENT>  Agent reference, agent ID, or unique name (active agents take priority for duplicate names)

Options
  -n, --lines <N>  Number of lines to print, from 1 to 2,000 (default: 50)
  -h, --help       Show help"#,
    },
    Page {
        path: "type",
        intro: r#"Type text or press keys in a running agent's terminal.

Use 'facade send' to deliver a complete message safely without overwriting a
draft. Use 'facade type' to edit a draft, navigate menus, or answer prompts."#,
        usage: r#"Usage:
  facade type <AGENT> <TEXT> [--enter]
  facade type <AGENT> --key <KEY> [--key <KEY>]..."#,
        examples: r#"  facade type Nova "draft"
  facade type Nova "hello" --enter
  facade type Nova --key Esc
  facade type Nova --key Down --key Enter"#,
        details: r#"Arguments
  <AGENT>  Running managed agent reference, agent ID, or unique name
  <TEXT>   Text to type

Options
      --enter      Press Enter after typing <TEXT>
  -k, --key <KEY>  Press a key (repeat for more): Enter, Esc, Tab, Shift+Tab,
                   Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp,
                   PageDown, Space, Ctrl+A to Ctrl+Z, or one character
  -h, --help       Show help"#,
    },
    Page {
        path: "status",
        intro: r#"Show Facade or agent status.

Without arguments, checks the local Facade service without starting it.
Pass an agent to inspect its state, working directory, and launch details."#,
        usage: r#"Usage: facade status [AGENT]"#,
        examples: r#"  facade status
  facade status Nova
  facade status a5@laptop"#,
        details: r#"Arguments
  [AGENT]  Agent reference, agent ID, or unique name (active agents take priority for duplicate names)

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "machine",
        intro: r#"Connect and manage machines over SSH."#,
        usage: r#"Usage: facade machine <COMMAND>"#,
        examples: r#"  facade machine add devbox
  facade machine connect devbox
  facade machine list"#,
        details: r#"Commands
  add      Connect and save an SSH machine
  connect  Connect while this command runs
  list     List local and known machines
  remove   Remove a saved SSH connection
  rename   Rename a machine

Options
  -h, --help  Show help

Run 'facade machine <COMMAND> --help' for examples and options."#,
    },
    Page {
        path: "machine add",
        intro: r#"Connect to a remote machine over SSH and save it.

Runs SSH in this terminal so you can answer host key or password prompts,
then installs or upgrades Facade on the remote machine if needed. Put '--home'
before SSH options and destination; everything after is passed to ssh."#,
        usage: r#"Usage: facade machine add [--home <PATH>] <SSH_ARGS>..."#,
        examples: r#"  facade machine add devbox
  facade machine add user@10.0.0.5
  facade machine add -p 2222 -i ~/.ssh/work user@devbox"#,
        details: r#"Arguments
  <SSH_ARGS>...  SSH flags and destination, passed directly to ssh

Options
      --home <PATH>  Facade home directory on the remote machine (default: ~/.facade)
  -h, --help         Show help"#,
    },
    Page {
        path: "machine connect",
        intro: r#"Connect to a remote machine temporarily over SSH.

Keeps the connection open while this command runs (press Ctrl+C to
disconnect) without saving it. Runs SSH in this terminal and installs or
upgrades Facade on the remote machine if needed. Put '--home' before SSH
options and destination; everything after is passed to ssh."#,
        usage: r#"Usage: facade machine connect [--home <PATH>] <SSH_ARGS>..."#,
        examples: r#"  facade machine connect devbox
  facade machine connect -p 2222 user@devbox"#,
        details: r#"Arguments
  <SSH_ARGS>...  SSH flags and destination, passed directly to ssh

Options
      --home <PATH>  Facade home directory on the remote machine (default: ~/.facade)
  -h, --help         Show help"#,
    },
    Page {
        path: "machine list",
        intro: r#"List the local machine and known remote machines.

Shows each machine's name, ID, connection state, Facade version, route,
and whether its SSH connection is saved."#,
        usage: r#"Usage: facade machine list"#,
        examples: r#"  facade machine list"#,
        details: r#"Options
  -h, --help  Show help"#,
    },
    Page {
        path: "machine remove",
        intro: r#"Delete a saved SSH machine connection.

Removes the saved connection and closes the direct SSH link if open.
Running agents on that machine are not stopped."#,
        usage: r#"Usage: facade machine remove <MACHINE>"#,
        examples: r#"  facade machine remove devbox
  facade machine remove 9a0d44b2"#,
        details: r#"Arguments
  <MACHINE>  Machine name or ID (from 'facade machine list')

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "machine rename",
        intro: r#"Rename a machine.

Updates the machine's name. Names may contain lowercase letters, digits,
and hyphens ('-')."#,
        usage: r#"Usage: facade machine rename <MACHINE> <NAME>"#,
        examples: r#"  facade machine rename devbox lab
  facade machine rename 9a0d44b2 devbox-east"#,
        details: r#"Arguments
  <MACHINE>  Machine name or ID (from 'facade machine list')
  <NAME>     New machine name (lowercase letters, digits, and hyphens ('-'))

Options
  -h, --help  Show help"#,
    },
    Page {
        path: "upgrade",
        intro: r#"Upgrade Facade.

Installs the latest stable release or the specified version, then hands off
running services without stopping active agents."#,
        usage: r#"Usage: facade upgrade [--version X.Y.Z]"#,
        examples: r#"  facade upgrade
  facade upgrade --version 0.1.6"#,
        details: r#"Options
      --version X.Y.Z  Install this release version
  -h, --help           Show help"#,
    },
];
