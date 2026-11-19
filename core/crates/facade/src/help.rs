//! The words of `facade`'s help: the root page and its groups, each page's description and
//! examples, and the layout every page shares. The summaries are each command's `about` in
//! `cli.rs`, so the root page and the pages cannot disagree.

use clap::builder::StyledStr;
use std::fmt::Write as _;

/// The widest help that wraps to the terminal.
pub(crate) const MAX_WIDTH: usize = 100;

/// What Facade is for, at the top of the root page.
const ROOT_INTRODUCTION: &str = "Start AI coding agents and use their terminals from the Shell. You can watch \
     an agent work, step in or send it a task. Agents can also start and message one another.\n\nLearn more at \
     https://facadecode.com";

/// The line at the bottom of the root page.
const ROOT_FOOTER: &str = "Run 'facade <COMMAND> --help' for more information on a command.";

/// The root page's groups: each heading and its commands, in order.
pub(crate) const GROUPS: &[(&str, &[&str])] = &[
    (
        "Agents",
        &[
            "start", "list", "attach", "stop", "resume", "remove", "rename",
        ],
    ),
    ("Inspect and control", &["inspect", "screen", "type"]),
    ("Messages", &["send"]),
    (
        "Setup and info",
        &["machine", "status", "version", "completion", "upgrade"],
    ),
];

/// One help example: what it does, the line shown, and its words after `facade`, which the help
/// tests parse. `argv` is None for a line with shell operators, which runs in its shell instead.
pub(crate) struct Example {
    pub(crate) comment: &'static str,
    pub(crate) line: &'static str,
    // Read only by the help tests, which parse each direct example.
    #[allow(dead_code)]
    pub(crate) argv: Option<&'static [&'static str]>,
}

/// An example whose line is `facade` followed by `argv`, written as a shell would show it.
const fn direct(
    comment: &'static str,
    line: &'static str,
    argv: &'static [&'static str],
) -> Example {
    Example {
        comment,
        line,
        argv: Some(argv),
    }
}

/// An example with shell operators: pipes, substitutions or redirections.
const fn piped(comment: &'static str, line: &'static str) -> Example {
    Example {
        comment,
        line,
        argv: None,
    }
}

/// A command or subcommand page: its path, its description, its alias, and its examples.
pub(crate) struct Page {
    pub(crate) path: &'static str,
    pub(crate) description: &'static str,
    pub(crate) alias: Option<&'static str>,
    pub(crate) examples: &'static [Example],
}

/// Every public page under the root, by command path.
pub(crate) const PAGES: &[Page] = &[
    Page {
        path: "start",
        description: "Start a built-in or configured CLI. Place Facade options before the CLI name. In an \
             interactive terminal, Ctrl-] detaches and returns 0. If the agent exits first, this command \
             returns the CLI's exit code. Use '-d' to start in the background and print the address. A \
             successful start means the agent is running. Delivery of '--prompt' is separate. Scripts \
             that need confirmation can start first, then run 'facade send ADDRESS TEXT' and check its result.",
        alias: None,
        examples: &[
            direct(
                "Start Claude Code and work with it here",
                "facade start claude",
                &["start", "claude"],
            ),
            direct(
                "Choose a name, model and effort",
                "facade start --name review --model gpt-6.2-sol --effort high codex",
                &[
                    "start",
                    "--name",
                    "review",
                    "--model",
                    "gpt-6.2-sol",
                    "--effort",
                    "high",
                    "codex",
                ],
            ),
            direct(
                "Start in the background with a first prompt",
                "facade start -d --prompt \"Fix the failing test in parser.rs\" claude",
                &[
                    "start",
                    "-d",
                    "--prompt",
                    "Fix the failing test in parser.rs",
                    "claude",
                ],
            ),
            direct(
                "Start Codex in a folder relative to this shell",
                "facade start --folder ./app codex",
                &["start", "--folder", "./app", "codex"],
            ),
            direct(
                "Create a worktree on gpu and start there",
                "facade start --machine gpu --folder /work/app --worktree review codex",
                &[
                    "start",
                    "--machine",
                    "gpu",
                    "--folder",
                    "/work/app",
                    "--worktree",
                    "review",
                    "codex",
                ],
            ),
        ],
    },
    Page {
        path: "list",
        description: "Show running managed agents and connected guests on machines already connected, with the \
             latest starts and resumes first. Use 'facade resume' to find ended agents with saved sessions. \
             '--machine' queries one machine and wakes it if needed.",
        alias: Some("ls"),
        examples: &[
            direct(
                "See which agents are working or waiting for you",
                "facade list",
                &["list"],
            ),
            direct(
                "Print agent addresses, one per line",
                "facade ls -q",
                &["ls", "-q"],
            ),
        ],
    },
    Page {
        path: "attach",
        description: "Watch a running managed agent and use its terminal. Ctrl-] detaches and returns 0. If \
             the agent exits first, this command returns the CLI's exit code. Use 'facade screen' to read an \
             ended agent's last screen.",
        alias: None,
        examples: &[
            direct("Watch agent a3", "facade attach a3", &["attach", "a3"]),
            direct(
                "Watch the agent named Pixel",
                "facade attach Pixel",
                &["attach", "Pixel"],
            ),
        ],
    },
    Page {
        path: "stop",
        description: "Stop running managed agents. You can read their screens, remove them or resume a saved \
             session. Agents they started keep running.",
        alias: None,
        examples: &[
            direct("Stop agent a3", "facade stop a3", &["stop", "a3"]),
            direct(
                "Stop two agents, by ID and by name",
                "facade stop a3 Ada",
                &["stop", "a3", "Ada"],
            ),
        ],
    },
    Page {
        path: "resume",
        description: "Without a reference, list resumable agents and CLI sessions for the current folder. Use \
             '--folder' or '--machine' to look elsewhere. With a reference, resume the agent or start a new \
             agent from a CLI session. In an interactive terminal, Ctrl-] detaches and returns 0. If the \
             agent exits first, this command returns the CLI's exit code. Use '-d' to run in the background.",
        alias: None,
        examples: &[
            direct(
                "List resumable agents and CLI sessions",
                "facade resume",
                &["resume"],
            ),
            direct(
                "List ended agents across awake machines",
                "facade resume --all",
                &["resume", "--all"],
            ),
            direct(
                "Resume agent a3 and work with it here",
                "facade resume a3",
                &["resume", "a3"],
            ),
            direct(
                "Resume agent a3 in the background",
                "facade resume -d a3",
                &["resume", "-d", "a3"],
            ),
        ],
    },
    Page {
        path: "remove",
        description: "Remove agents that the Orchestrator started, along with their screens and inboxes. The \
             Orchestrator stops any that are still running, and each CLI keeps its saved session.",
        alias: Some("rm"),
        examples: &[
            direct("Remove agent a3", "facade rm a3", &["rm", "a3"]),
            direct("Remove two agents", "facade rm a3 a4", &["rm", "a3", "a4"]),
        ],
    },
    Page {
        path: "rename",
        description: "Change the agent's display name. Pass an empty or blank name to let the Orchestrator choose one.",
        alias: None,
        examples: &[
            direct(
                "Rename agent a3 to reviewer",
                "facade rename a3 reviewer",
                &["rename", "a3", "reviewer"],
            ),
            direct(
                "Let the Orchestrator choose a new name for agent a3",
                "facade rename a3 \" \"",
                &["rename", "a3", " "],
            ),
        ],
    },
    Page {
        path: "inspect",
        description: "See the agent's address, state, launch settings and saved session. You can also check \
             who started it, who is watching its terminal, and whether YOLO is on.",
        alias: None,
        examples: &[
            direct(
                "Show what agent a3 is doing",
                "facade inspect a3",
                &["inspect", "a3"],
            ),
            direct(
                "Print agent a3's details as JSON",
                "facade inspect --json a3",
                &["inspect", "--json", "a3"],
            ),
        ],
    },
    Page {
        path: "screen",
        description: "Print recent terminal output and scrollback, including the last screen of an ended agent. \
             Use '--json' for the text and its screen details.",
        alias: None,
        examples: &[
            direct(
                "Print agent a3's recent output",
                "facade screen a3",
                &["screen", "a3"],
            ),
            direct(
                "Print the last 200 lines with screen details",
                "facade screen --json -n 200 a3",
                &["screen", "--json", "-n", "200", "a3"],
            ),
        ],
    },
    Page {
        path: "type",
        description: "Type text into the agent's terminal, or press keys to answer its menus. Add '--enter' to \
             press Enter after the text. To give the agent a task or ask it a question, use 'facade send'.",
        alias: None,
        examples: &[
            direct(
                "Type text and press Enter",
                "facade type a3 \"run the tests\" --enter",
                &["type", "a3", "run the tests", "--enter"],
            ),
            direct(
                "Press Esc",
                "facade type a3 --key Esc",
                &["type", "a3", "--key", "Esc"],
            ),
            direct(
                "Pick the second item of a menu",
                "facade type a3 -k Down -k Enter",
                &["type", "a3", "-k", "Down", "-k", "Enter"],
            ),
        ],
    },
    Page {
        path: "send",
        description: "Send a message from the command line. The Orchestrator waits up to 30 seconds for a \
             managed agent's terminal to receive it or a guest to read it. On delivery, this command prints \
             the message address.",
        alias: None,
        examples: &[direct(
            "Ask an agent on gpu to review a change",
            "facade send a3@gpu \"Please review the diff in src/parser.rs\"",
            &["send", "a3@gpu", "Please review the diff in src/parser.rs"],
        )],
    },
    Page {
        path: "machine",
        description: "Work with agents on other machines. Orchestrators connect over SSH and open no port. Once two \
             machines are connected, you can list, start and message agents on both from either one.",
        alias: None,
        examples: &[
            direct(
                "Connect to gpu from your SSH config",
                "facade machine add gpu",
                &["machine", "add", "gpu"],
            ),
            direct(
                "See the machines this one connects to",
                "facade machine list",
                &["machine", "list"],
            ),
        ],
    },
    Page {
        path: "machine add",
        description: "Connect over SSH and save the connection. Use the same arguments you would give ssh. \
             Put '--home' before those arguments to use another remote Facade home. SSH can ask for a \
             password or host key here. Saved machines connect automatically while awake. An operation that names \
             a sleeping machine wakes it. Run the same command again when a saved connection needs a login.",
        alias: None,
        examples: &[
            direct(
                "Connect to gpu from your SSH config",
                "facade machine add gpu",
                &["machine", "add", "gpu"],
            ),
            direct(
                "Connect as another user on port 2222",
                "facade machine add -p 2222 me@10.0.0.5",
                &["machine", "add", "-p", "2222", "me@10.0.0.5"],
            ),
            direct(
                "Use an SSH key and another remote Facade home",
                "facade machine add --home /srv/facade -i ~/.ssh/work me@gpu",
                &[
                    "machine",
                    "add",
                    "--home",
                    "/srv/facade",
                    "-i",
                    "~/.ssh/work",
                    "me@gpu",
                ],
            ),
        ],
    },
    Page {
        path: "machine connect",
        description: "Keep a temporary SSH connection until you press Ctrl-C or close this terminal. Use \
             the same SSH arguments and optional '--home' as 'facade machine add'.",
        alias: None,
        examples: &[direct(
            "Connect to gpu for now",
            "facade machine connect gpu",
            &["machine", "connect", "gpu"],
        )],
    },
    Page {
        path: "machine list",
        description: "See connected and saved machines, their state, and how to sign in again when needed. \
             Copy a machine selector from the table to use in a command.",
        alias: None,
        examples: &[
            direct(
                "See your machines",
                "facade machine list",
                &["machine", "list"],
            ),
            direct(
                "Print every machine as JSON",
                "facade machine list --json",
                &["machine", "list", "--json"],
            ),
        ],
    },
    Page {
        path: "machine remove",
        description: "Forget this machine's saved SSH arguments and close that connection. Agents keep running, \
             and another route may still be available.",
        alias: None,
        examples: &[direct(
            "Stop connecting to gpu",
            "facade machine remove gpu",
            &["machine", "remove", "gpu"],
        )],
    },
    Page {
        path: "machine rename",
        description: "Give a machine a new name, from any machine with a route to it. Addresses with the old \
             name, such as 'a17@gpu', stop working.",
        alias: None,
        examples: &[direct(
            "Rename machine gpu to lab",
            "facade machine rename gpu lab",
            &["machine", "rename", "gpu", "lab"],
        )],
    },
    Page {
        path: "status",
        description: "Show the Orchestrator's version, Facade home, and settings file. When running, it also \
             shows the daemon and keeper process IDs, active agent count and connected machines. Local status \
             checks for a running service. '--machine' queries another machine and wakes it if needed.",
        alias: None,
        examples: &[
            direct("Check the local Orchestrator", "facade status", &["status"]),
            direct(
                "Check the Orchestrator on gpu",
                "facade status --machine gpu",
                &["status", "--machine", "gpu"],
            ),
        ],
    },
    Page {
        path: "upgrade",
        description: "Install the latest stable version of Facade Code. A compatible running Orchestrator \
             hands over to the new version while its agents keep running.",
        alias: None,
        examples: &[direct(
            "Install the latest stable version",
            "facade upgrade",
            &["upgrade"],
        )],
    },
    Page {
        path: "version",
        description: "Print the version of this command. Run 'facade status' to check whether the running \
             services use a different build.",
        alias: None,
        examples: &[
            direct("Print the version", "facade version", &["version"]),
            direct(
                "Print the version as JSON",
                "facade version --json",
                &["version", "--json"],
            ),
        ],
    },
    Page {
        path: "completion",
        description: "Print a script that lets your shell complete facade's commands and options when you press \
             Tab. Load it as the example for your shell shows.",
        alias: None,
        examples: &[
            piped(
                "Turn on completion in this PowerShell session",
                "facade completion powershell | Out-String | Invoke-Expression",
            ),
            piped(
                "Turn on completion in this Bash session",
                "source <(facade completion bash)",
            ),
            piped(
                "Turn on completion in this Zsh session, after compinit",
                "source <(facade completion zsh)",
            ),
            piped(
                "Turn on completion in this Fish session",
                "facade completion fish | source",
            ),
        ],
    },
];

/// The page of the command at `path`, such as `machine add`.
pub(crate) fn page(path: &str) -> Option<&'static Page> {
    PAGES.iter().find(|page| page.path == path)
}

/// `text` as a heading in clap's style.
fn heading(styles: &clap::builder::Styles, text: &str) -> String {
    let header = styles.get_header();
    format!("{}{text}:{}", header.render(), header.render_reset())
}

/// Dresses a command or subcommand page: the shared layout (summary, usage, alias, description,
/// arguments, options, examples), width and styles. `arguments` replaces clap's Arguments section
/// where a page shows its arguments otherwise than clap would.
pub(crate) fn dress_page(
    command: clap::Command,
    page: &Page,
    arguments: Option<&str>,
) -> clap::Command {
    let styles = command.get_styles().clone();
    let alias = page
        .alias
        .map(|alias| format!("\n{} facade {alias}", heading(&styles, "Alias")))
        .unwrap_or_default();
    let body = match arguments {
        Some(arguments) => format!(
            "{}\n{arguments}\n\n{}\n{{options}}",
            heading(&styles, "Arguments"),
            heading(&styles, "Options")
        ),
        None => "{all-args}".to_string(),
    };
    let template = format!(
        "{{about-with-newline}}\n{{usage-heading}} {{usage}}{alias}\n\n{{before-help}}{body}{{after-help}}"
    );
    let mut examples = heading(&styles, "Examples");
    for (at, example) in page.examples.iter().enumerate() {
        let gap = if at == 0 { "" } else { "\n" };
        let _ = write!(
            examples,
            "\n{gap}  # {}\n  {}",
            example.comment, example.line
        );
    }
    command
        .help_template(StyledStr::from(template))
        .before_help(page.description)
        .after_help(StyledStr::from(examples))
        .max_term_width(MAX_WIDTH)
}

/// Dresses the root page: what Facade is for, usage, the groups with each command's summary, the
/// options, and where to read more.
pub(crate) fn dress_root(command: clap::Command) -> clap::Command {
    let styles = command.get_styles().clone();
    let width = GROUPS
        .iter()
        .flat_map(|(_, names)| names.iter())
        .map(|name| name.len())
        .max()
        .unwrap_or(0);
    let mut groups = String::new();
    for (heading_text, names) in GROUPS {
        let _ = writeln!(groups, "{}", heading(&styles, heading_text));
        for name in *names {
            let summary = command
                .find_subcommand(name)
                .and_then(|sub| sub.get_about())
                .map(|about| about.to_string())
                .unwrap_or_default();
            let _ = writeln!(groups, "  {name:width$}  {summary}");
        }
        groups.push('\n');
    }
    let template = format!(
        "{{before-help}}{{usage-heading}} {{usage}}\n\n{groups}{}\n{{options}}{{after-help}}",
        heading(&styles, "Options")
    );
    command
        .help_template(StyledStr::from(template))
        .before_help(ROOT_INTRODUCTION)
        .after_help(ROOT_FOOTER)
        .max_term_width(MAX_WIDTH)
}
