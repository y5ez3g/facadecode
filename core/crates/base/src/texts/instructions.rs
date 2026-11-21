//! The Orchestrator's MCP instructions for a connection or a known managed run.

use crate::model::terminal::display_name;

const TOOLS: &str = "The Orchestrator's MCP tools start, list and stop agents, exchange messages, \
                     and read or operate managed agents' terminals. \
                     Use an address such as a3@devbox, an agent number such as a3, or a name. \
                     Without a machine, a number or name resolves only on machines that are awake \
                     and reachable.";

const RESULT: &str = "A 🔔 message reports an Orchestrator result.";

/// The instructions for MCP initialization before the connection has a known agent.
pub fn for_connection() -> String {
    format!(
        "{TOOLS} Messages to a Guest are delivered when it takes them with read_messages within \
         30 seconds. After sending as a Guest, use the returned data.next call to wait for the \
         reply. Messages to a managed agent are typed into its terminal. {RESULT}"
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
         typing begins. {RESULT}",
        run.folder, run.machine
    )
}

/// How to name an agent in a call.
const ADDRESS: &str = "Address an agent by its ID, such as #a3, its unique @name, or both.";

/// What a 🔔 brings.
const BELL: &str = "🔔 is Facade's result, not an agent's reply.";

/// What never shows an agent's work is done.
const NOT_DONE: &str = "Starting an agent and delivering a message never prove its work is done.";

/// A guest's instructions: `opening`, who it is and how its messages reach it, then what Facade's
/// tools do for a guest.
fn guest(opening: &str) -> String {
    format!(
        "{opening} Facade's tools start, list and stop the agents on this computer, exchange \
         messages with them, and read and type into the terminals of the agents Facade started. \
         {ADDRESS} {BELL} {NOT_DONE}"
    )
}

/// The instructions for a guest in a terminal of its own: `agent` is its ID, where its session is
/// known as its server starts. Its messages and Facade's results reach it only as its turn ends or
/// with the person's next prompt, so it never promises to report one unprompted.
pub fn for_guest(agent: Option<&str>) -> String {
    let who = match agent {
        Some(agent) => format!("Facade guest #{agent}"),
        None => "a Facade guest".to_string(),
    };
    guest(&format!(
        "You are {who}, in a terminal of your own. Messages and Facade's results reach you only as \
         your turn ends or with the person's next prompt, so never promise to report one unprompted."
    ))
}

/// The instructions for an MCP client that Facade did not start, listed as guest `agent` named
/// `name` while its connection lasts, with `waiting` messages for it: its answer to `initialize`.
/// Its messages reach it only when it reads them, so it reads them now and whenever it expects one.
pub fn for_mcp_client(agent: &str, name: &str, waiting: usize) -> String {
    let name = display_name(name);
    let waits = match waiting {
        0 => "No messages wait".to_string(),
        1 => "1 message waits".to_string(),
        n => format!("{n} messages wait"),
    };
    guest(&format!(
        "You are Facade guest #{agent}, {name}, an MCP client listed while this connection lasts. \
         {waits} for you. Messages and Facade's results reach you only through read_messages, so \
         read them now and whenever you expect one, and never promise to report one unprompted."
    ))
}

/// An agent's whereabouts, which its instructions give so that it can start another agent next to
/// itself without asking.
pub struct Place<'a> {
    /// The name and logical ID of the agent's window, if it has one member window.
    pub window: Option<(&'a str, &'a str)>,
    pub location_id: &'a str,
    pub folder: &'a str,
}

/// The facts of an agent's run that its instructions give: its place, its creator, and its YOLO,
/// which sets how far its tools reach.
pub struct Run<'a> {
    pub place: Place<'a>,
    /// The ID of the agent that started it, with that agent's name where known; none when the
    /// person started it.
    pub creator: Option<(&'a str, Option<&'a str>)>,
    pub yolo: bool,
}

/// The instructions for the CLI of agent `agent`, an ID such as `a3`. Where its `run` is known,
/// the first sentences say where it works and who started it, so that it can start an agent next
/// to itself and answer its creator without asking, and a later one says how far its tools reach.
pub fn for_agent(agent: &str, run: Option<&Run>) -> String {
    let whereabouts = run.map_or_else(String::new, |run| {
        let place = &run.place;
        match place.window {
            Some((name, id)) => format!(
                ", working in {} in window {name:?} (window {id})",
                place.folder
            ),
            None => format!(", working in {}", place.folder),
        }
    });
    let started_by = run.map_or_else(String::new, |run| {
        format!(" Your creator is {}.", creator_name(run.creator))
    });
    let reach = run.map_or_else(String::new, |run| reach_of(run.yolo));
    format!(
        "You are Facade agent #{agent}{whereabouts}.{started_by} These tools start, list and stop \
         the agents on this computer, exchange messages with them, and read and type into their \
         terminals.{reach} {ADDRESS} 📨 brings a complete message, typed into your terminal or \
         returned by read_messages, even after your turn ends. {BELL} {NOT_DONE} Do not poll \
         read_messages or read_screen while you wait: each reads once and does not wait. If your \
         tools are listed by name alone, load the one you need before calling it."
    )
}

/// How an agent's instructions name its creator: by name and ID, by ID alone where its name is
/// unknown, or as the person.
fn creator_name(creator: Option<(&str, Option<&str>)>) -> String {
    match creator {
        None => "the person (#human)".to_string(),
        Some((id, None)) => format!("#{id}"),
        Some((id, Some(name))) => format!("{} (#{id})", display_name(name)),
    }
}

/// The sentence on how far a run's tools reach, which its YOLO sets.
fn reach_of(yolo: bool) -> String {
    let (setting, agents) = match yolo {
        true => ("on", "every agent"),
        false => ("off", "only the agents of your creation tree"),
    };
    format!(" Your run has YOLO {setting}, so they reach {agents}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(creator: Option<(&'static str, Option<&'static str>)>, yolo: bool) -> Run<'static> {
        Run {
            place: Place {
                window: Some(("app (Workspace)", "win-2")),
                location_id: "loc-7",
                folder: "/work/app",
            },
            creator,
            yolo,
        }
    }

    /// The instructions say where the agent works and who started it, where that is known, in their
    /// first sentences, so that it can start an agent beside itself and answer its creator without
    /// asking first.
    #[test]
    fn the_instructions_say_where_the_agent_works_and_who_started_it_where_that_is_known() {
        let placed = for_agent("a3", Some(&run(Some(("a2", Some("Ada"))), true)));
        assert!(
            placed.starts_with(
                "You are Facade agent #a3, working in /work/app in window \"app (Workspace)\" \
                 (window win-2). Your creator is \
                 Ada (#a2). These tools"
            ),
            "{placed}"
        );
        assert!(
            for_agent("a3", Some(&run(Some(("a2", None)), true)))
                .contains(". Your creator is #a2. These tools")
        );
        assert!(
            for_agent("a3", Some(&run(None, true)))
                .contains(". Your creator is the person (#human). These tools")
        );
        assert!(for_agent("a3", None).starts_with("You are Facade agent #a3. These tools"));
        let rest = |text: &str| {
            text.split_once("their terminals.")
                .map(|(_, rest)| rest.to_string())
                .unwrap()
        };
        assert_eq!(
            rest(&placed).replacen(" Your run has YOLO on, so they reach every agent.", "", 1),
            rest(&for_agent("a3", None))
        );

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
        assert!(for_agent("a3", Some(&run(None, true))).contains(
            " their terminals. Your run has YOLO on, so they reach every agent. Address"
        ));
        let off = for_agent("a3", Some(&run(None, false)));
        assert!(
            off.contains(
                " their terminals. Your run has YOLO off, so they reach only the agents of your \
                 creation tree. Address"
            ),
            "{off}"
        );
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

    /// An agent's and a guest's instructions say what 🔔 brings: Facade's result, which is not a
    /// reply of the agent it names.
    #[test]
    fn the_instructions_say_a_bell_is_facade_s_result() {
        assert!(for_agent("a3", None).contains("🔔 is Facade's result, not an agent's reply."));
        assert!(
            for_guest(Some("a3")).contains("🔔 is Facade's result, not an agent's reply."),
            "a guest's start owes it one too"
        );
        assert!(for_connection().ends_with(
            "Messages to a managed agent are typed into its terminal. \
             A 🔔 message reports an Orchestrator result."
        ));
    }
}
