//! The words of `facade`'s help: the root page and its groups, each page's description and
//! examples, and the layout every page shares. The summaries are each command's `about` in
//! `cli.rs`, so the root page and the pages cannot disagree.

use clap::builder::StyledStr;
use std::fmt::Write as _;

/// The widest help that wraps to the terminal.
pub(crate) const MAX_WIDTH: usize = 100;

/// What Facade is for, at the top of the root page.
const ROOT_INTRODUCTION: &str = "Facade runs AI coding agents, such as Claude Code and Codex, and lets you work \
     with them as a team. Facade keeps the terminals of the agents it starts, so you can watch them, step in or \
     give them a task. Agents can also start and message one another to share the work.\n\nLearn more at \
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
    ("Messages", &["send", "messages"]),
    (
        "Setup and info",
        &["integration", "status", "version", "completion"],
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
        description: "Start PROGRAM as an agent. In an interactive terminal it opens here; press Ctrl-] to \
             detach and leave it running. Use '--detach' to start it in the background instead.",
        alias: None,
        examples: &[
            direct(
                "Start Claude Code and work with it here",
                "facade start claude",
                &["start", "claude"],
            ),
            direct(
                "Name the agent and pass options to Codex",
                "facade start --name review codex --model gpt-6.2-sol",
                &[
                    "start",
                    "--name",
                    "review",
                    "codex",
                    "--model",
                    "gpt-6.2-sol",
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
        ],
    },
    Page {
        path: "list",
        description: "See what your agents are doing and which ones are waiting for you, oldest first. Ended \
             agents stay listed until you remove them. Sessions that join through an integration are marked as \
             guests.",
        alias: Some("ls"),
        examples: &[
            direct(
                "See which agents are working or waiting for you",
                "facade list",
                &["list"],
            ),
            direct(
                "Print agent IDs, one per line",
                "facade ls -q",
                &["ls", "-q"],
            ),
        ],
    },
    Page {
        path: "attach",
        description: "Watch the agent work and use its terminal here, or see its saved screen if it has already \
             ended. Press Ctrl-] to detach and leave it running. This command exits with the agent's exit code \
             when the agent ends or after showing its saved screen.",
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
        description: "Stop agents that Facade started and keep them in your list. You can still read their \
             screens, remove them or resume a saved session if the CLI supports it.",
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
        description: "Pick up where an ended agent that Facade started left off, with the same ID, name and \
             screen, if its CLI supports resuming and saved a session. In an interactive terminal it opens here; \
             press Ctrl-] to detach and leave it running. Use '--detach' to resume it in the background instead.",
        alias: None,
        examples: &[
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
        description: "Remove agents that Facade started, along with their screens and inboxes. Facade stops any \
             that are still running, and each CLI keeps its saved session.",
        alias: Some("rm"),
        examples: &[
            direct("Remove agent a3", "facade rm a3", &["rm", "a3"]),
            direct("Remove two agents", "facade rm a3 a4", &["rm", "a3", "a4"]),
        ],
    },
    Page {
        path: "rename",
        description: "Give the agent a new name, or pass a space in quotes to let Facade choose one.",
        alias: None,
        examples: &[
            direct(
                "Rename agent a3 to reviewer",
                "facade rename a3 reviewer",
                &["rename", "a3", "reviewer"],
            ),
            direct(
                "Let Facade choose a new name for agent a3",
                "facade rename a3 \" \"",
                &["rename", "a3", " "],
            ),
        ],
    },
    Page {
        path: "inspect",
        description: "See what an agent is doing and what it is waiting for. You can also check its Facade \
             tools, its saved session and the last text submitted to it.",
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
        description: "Print what an agent has shown recently: the last lines of its screen and scrollback as \
             plain text.",
        alias: None,
        examples: &[
            direct(
                "Print agent a3's recent output",
                "facade screen a3",
                &["screen", "a3"],
            ),
            direct(
                "Print the last 200 lines",
                "facade screen -n 200 a3",
                &["screen", "-n", "200", "a3"],
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
        description: "Give an agent a task or ask it a question, as yourself or, in an agent's terminal, as that \
             agent. Facade waits up to 30 seconds to deliver the message to an agent it started; a guest gets it \
             in its inbox at once. A message from an agent to the human goes to each of the agent's editor \
             windows that shows Facade messages.",
        alias: None,
        examples: &[
            direct(
                "Ask agent a3 to review a change",
                "facade send a3 \"Please review the diff in src/parser.rs\"",
                &["send", "a3", "Please review the diff in src/parser.rs"],
            ),
            direct(
                "From an agent in an editor window, tell the human the tests passed",
                "facade send human \"Done: all tests pass\"",
                &["send", "human", "Done: all tests pass"],
            ),
        ],
    },
    Page {
        path: "messages",
        description: "Read up to 100 messages waiting for the agent of this terminal and mark them as delivered. \
             Run this command in an agent's terminal.",
        alias: None,
        examples: &[direct(
            "Read waiting messages in an agent's terminal",
            "facade messages",
            &["messages"],
        )],
    },
    Page {
        path: "integration",
        description: "Use Facade's tools and messages in CLIs you start yourself, outside Facade. Once you add \
             an integration, new sessions of that CLI appear in 'facade list' as guests and keep their own \
             terminals.",
        alias: None,
        examples: &[direct(
            "Let Claude Code sessions you start yourself join Facade",
            "facade integration add claude",
            &["integration", "add", "claude"],
        )],
    },
    Page {
        path: "integration add",
        description: "Let new sessions of this CLI join Facade as guests. Facade updates the CLI's user settings \
             so that those sessions can use its tools and messages. Run this again to bring the settings up to \
             date.",
        alias: None,
        examples: &[direct(
            "Add Facade to Claude Code's settings",
            "facade integration add claude",
            &["integration", "add", "claude"],
        )],
    },
    Page {
        path: "integration remove",
        description: "Remove the settings that let new sessions of this CLI join Facade. Facade keeps any changes \
             you made and shows any settings that need attention.",
        alias: None,
        examples: &[direct(
            "Remove Facade from Claude Code's settings",
            "facade integration remove claude",
            &["integration", "remove", "claude"],
        )],
    },
    Page {
        path: "integration list",
        description: "Check which CLIs are set up to join Facade and which need attention.",
        alias: None,
        examples: &[
            direct(
                "See which CLIs are set up to join Facade",
                "facade integration list",
                &["integration", "list"],
            ),
            direct(
                "Print every integration as JSON",
                "facade integration list --json",
                &["integration", "list", "--json"],
            ),
        ],
    },
    Page {
        path: "status",
        description: "Check whether Facade responds and see its Facade home, where it keeps settings and logs. If \
             it responds, you also see this command's version, Facade's services and the agent count. This \
             command never starts Facade.",
        alias: None,
        examples: &[direct(
            "Check whether Facade responds",
            "facade status",
            &["status"],
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

/// The page of command `path`, such as `integration add`.
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
