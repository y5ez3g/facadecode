//! Facade's MCP instructions for a Guest or a known managed run.

use crate::model::terminal::display_name;

const MANAGED: &str = r##"If a "📨 Message" needs a reply and has a reply address, call send_message (to=address, reply_to=its number, text=answer). Printed text never reaches the sender. Facade Code runs you as a managed agent. 📨 messages and 🔔 notices arrive as your input.
"📨 Message m42 from Ada (a2@devbox) · in reply to m17" is Ada's m42, answering your m17. A waiting command shows "from command line (#c44@devbox)" and takes one reply. Plain "from command line" has no reply address.
A 🔔 notice comes from Facade, is unnumbered and takes no reply. It reports a delivery problem or says an agent you started needs someone's input or is in Error. When an agent you started ends, even on a normal exit, only you get a notice unless you stopped it yourself. That run can send no further replies. Judge completion from its work.
After you send a message or start an agent, keep working or end your turn. Successful delivery of a message or start prompt produces no notice. Replies arrive on their own, so do not poll read_messages or read_screen. Wait in a send only to confirm delivery or get a linked reply within 30 seconds. If your client has tool search, load the Facade tools you need in one search."##;

/// The instructions for a connection that receives the Guest text at initialization.
pub fn for_connection() -> String {
    r#"Facade Code connects agents. As a Guest, read messages and notices with read_messages and only timeout_seconds 30. send_message takes to and text; to wait for delivery or one reply, add wait_for "delivery" or "result" and timeout_seconds 30.
A connection that Facade cannot verify as a managed agent's joins as a Guest at its first tool call, with an address and an inbox. Where Facade's instructions say you are a managed agent, they apply to calls through that agent's server.
As a Guest, nothing is typed into your input: messages, and notices from "facade", reach you only when you read them, and an unread one is withdrawn, usually within 30 seconds. So start waiting as soon as you expect one, and wait again while you still do. If your client has tool search, load the Facade tools you need in one search."#
        .to_owned()
}

/// The known facts of a managed run that its instructions give.
pub struct ManagedRun<'a> {
    pub folder: &'a str,
    pub machine: &'a str,
    pub creator: Option<Creator<'a>>,
    pub yolo: bool,
}

/// Who started the managed agent, when known.
pub enum Creator<'a> {
    Agent {
        address: &'a str,
        name: Option<&'a str>,
    },
    CommandLine,
    VsCode,
}

/// The instructions for a managed agent whose current run is known.
pub fn for_managed(address: &str, run: &ManagedRun<'_>) -> String {
    let reach = if run.yolo {
        "YOLO is on: your tools reach agents on all reachable machines."
    } else {
        "YOLO is off: your tools reach only your creation tree, its first agent and every agent started under it."
    };
    let creator = match &run.creator {
        Some(Creator::Agent {
            address,
            name: Some(name),
        }) => format!(" by {} ({address})", display_name(name)),
        Some(Creator::Agent {
            address,
            name: None,
        }) => format!(" by {address}"),
        Some(Creator::CommandLine) => " from the command line".into(),
        Some(Creator::VsCode) => " from VS Code".into(),
        None => String::new(),
    };
    format!(
        "{MANAGED}\n{reach} Your address is {address}. You were started{creator} in {} on {}.",
        run.folder, run.machine
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The last line gives the agent's address, creator, folder and machine.
    #[test]
    fn the_instructions_say_where_the_agent_works_and_who_started_it_where_that_is_known() {
        for (creator, expected) in [
            (
                Some(Creator::Agent {
                    address: "a1@devbox",
                    name: Some("Nova"),
                }),
                "You were started by Nova (a1@devbox) in /work/app on devbox.",
            ),
            (
                Some(Creator::Agent {
                    address: "a1@devbox",
                    name: None,
                }),
                "You were started by a1@devbox in /work/app on devbox.",
            ),
            (
                Some(Creator::CommandLine),
                "You were started from the command line in /work/app on devbox.",
            ),
            (
                Some(Creator::VsCode),
                "You were started from VS Code in /work/app on devbox.",
            ),
            (None, "You were started in /work/app on devbox."),
        ] {
            let text = for_managed(
                "a3@devbox",
                &ManagedRun {
                    folder: "/work/app",
                    machine: "devbox",
                    creator,
                    yolo: true,
                },
            );
            assert_eq!(
                text.lines().last().unwrap(),
                format!(
                    "YOLO is on: your tools reach agents on all reachable machines. \
                     Your address is a3@devbox. {expected}"
                )
            );
        }
    }

    /// The instructions say what the agent's tools reach, which its run's YOLO decides.
    #[test]
    fn the_instructions_say_what_the_run_s_yolo_reaches() {
        let mut run = ManagedRun {
            folder: "/work/app",
            machine: "devbox",
            creator: None,
            yolo: true,
        };
        assert!(
            for_managed("a3@devbox", &run)
                .lines()
                .last()
                .unwrap()
                .starts_with("YOLO is on: your tools reach agents on all reachable machines.")
        );
        run.yolo = false;
        assert!(
            for_managed("a3@devbox", &run)
                .lines()
                .last()
                .unwrap()
                .starts_with(
                    "YOLO is off: your tools reach only your creation tree, \
                     its first agent and every agent started under it."
                )
        );
    }

    /// The managed instructions explain what the bell reports.
    #[test]
    fn the_instructions_say_a_bell_is_a_facade_notice() {
        let run = ManagedRun {
            folder: "/work/app",
            machine: "devbox",
            creator: None,
            yolo: false,
        };
        assert_eq!(
            for_managed("a3@devbox", &run).lines().nth(2),
            Some(
                r#"A 🔔 notice comes from Facade, is unnumbered and takes no reply. It reports a delivery problem or says an agent you started needs someone's input or is in Error. When an agent you started ends, even on a normal exit, only you get a notice unless you stopped it yourself. That run can send no further replies. Judge completion from its work."#
            )
        );
    }
}
