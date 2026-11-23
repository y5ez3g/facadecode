//! The Orchestrator's MCP instructions for a connection or a known managed run.

use crate::model::terminal::display_name;

const TOOLS: &str = "The Orchestrator's MCP tools start, list and stop agents, exchange messages, \
                     and read or operate managed agents' terminals. \
                     Use an address such as a3@devbox, an agent number such as a3, or a name. \
                     Without a machine, a number or name resolves only on machines that are awake \
                     and reachable.";

const RESULT: &str = "A 🔔 message reports an Orchestrator result; it is not the recipient's \
                      answer or proof of task completion.";

/// The instructions for MCP initialization before the connection has a known agent.
pub fn for_connection() -> String {
    format!(
        "{TOOLS} The server verifies whether this connection acts for a managed agent or a Guest. \
         Managed agents normally receive messages through their terminals. Guests receive messages \
         through read_messages and should keep their connection open and take messages promptly. \
         timeout_seconds defaults to 0 for both send_message and read_messages: sending confirms \
         inbox acceptance only, and reading returns a snapshot. To wait, set a positive \
         timeout_seconds up to 30. A send also requires wait_for: \"delivery\" or \"result\"; setting \
         wait_for alone does not enable waiting. Managed agents usually use wait_for: \"delivery\" \
         with timeout_seconds: 30. Guests needing an answer should use wait_for: \"result\" with \
         timeout_seconds: 30. A positive timeout is one total call budget. After reply_timeout, \
         continue with read_messages using the original full message ID as reply_to and a positive \
         timeout_seconds; do not resend the task. A replyable command-line request appears as the \
         command line with a sender address such as #c42@devbox, also returned as from in its inbox \
         row. Reply to that sender address with the received message number as reply_to. The c \
         address accepts the first reply while the original command is waiting. {RESULT}"
    )
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
    let creator = match &run.creator {
        Some(Creator::Agent {
            address,
            name: Some(name),
        }) => format!(" You were started by {} ({address}).", display_name(name)),
        Some(Creator::Agent {
            address,
            name: None,
        }) => format!(" You were started by {address}."),
        Some(Creator::CommandLine) => " You were started from the command line.".into(),
        Some(Creator::VsCode) => " You were started from VS Code.".into(),
        None => String::new(),
    };
    let reach = if run.yolo {
        "YOLO is on. Your tools reach agents on all reachable machines."
    } else {
        "YOLO is off. Your tools reach agents in your creation tree."
    };
    format!(
        "You are managed agent {address}, working in {} on machine {}.{creator} {TOOLS} {reach} \
         Messages are typed into your terminal. You can use read_messages to take messages before \
         typing begins. Usually send with wait_for: \"delivery\" and timeout_seconds: 30, then \
         receive replies through normal terminal delivery. timeout_seconds defaults to 0 for both \
         send_message and read_messages: sending confirms inbox acceptance only, and reading returns \
         a snapshot. Setting wait_for alone does not enable waiting. Use wait_for: \"result\" with a \
         positive timeout_seconds when this call needs a linked reply. A positive timeout is one \
         total call budget of at most 30 seconds; a send also requires wait_for. After reply_timeout, \
         continue with read_messages using the original full message ID as reply_to and a positive \
         timeout_seconds; do not resend the task. A replyable command-line request appears as the \
         command line (#c42@devbox) within its single header line. Copy that sender address into to \
         and the received message number into reply_to. The c address accepts the first reply while \
         the original command is waiting. {RESULT}",
        run.folder, run.machine
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instructions say where the agent works and who started it, where that is known, in their
    /// first sentences, so that it can start an agent beside itself and answer its creator without
    /// asking first.
    #[test]
    fn the_instructions_say_where_the_agent_works_and_who_started_it_where_that_is_known() {
        for (creator, expected) in [
            (
                Some(Creator::Agent {
                    address: "a2@laptop",
                    name: Some("Ada"),
                }),
                " You were started by Ada (a2@laptop).",
            ),
            (
                Some(Creator::Agent {
                    address: "a2@laptop",
                    name: None,
                }),
                " You were started by a2@laptop.",
            ),
            (
                Some(Creator::CommandLine),
                " You were started from the command line.",
            ),
            (Some(Creator::VsCode), " You were started from VS Code."),
            (None, ""),
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
                text.split_once(" The Orchestrator's MCP tools").unwrap().0,
                format!(
                    "You are managed agent a3@devbox, working in /work/app on machine devbox.{expected}"
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
                .contains("YOLO is on. Your tools reach agents on all reachable machines.")
        );
        run.yolo = false;
        assert!(
            for_managed("a3@devbox", &run)
                .contains("YOLO is off. Your tools reach agents in your creation tree.")
        );
    }

    /// The connection instructions explain what the bell reports.
    #[test]
    fn the_instructions_say_a_bell_is_facade_s_result() {
        assert!(for_connection().ends_with(
            "A 🔔 message reports an Orchestrator result; it is not the recipient's answer or \
             proof of task completion."
        ));
    }
}
