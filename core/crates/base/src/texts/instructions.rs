//! What Facade's MCP server tells a model of Facade's tools: in its answer to `initialize`, and, for
//! a CLI that shows its model no server's instructions, in the CLI's own place for them. Three
//! readers get them: an agent Facade ran, a guest in a terminal of its own, and an MCP client that
//! joined as a guest. The sentences they share are written once, here.

use crate::protocol::daemon::{
    AgentInfo, TERMINAL_WINDOW, TERMINAL_WINDOW_LABEL, WindowInfo, display_name,
};

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

/// The place of `agent`, with the name that `windows` give its sole member window.
pub fn place_of<'a>(agent: &'a AgentInfo, windows: &'a [WindowInfo]) -> Place<'a> {
    let window = match agent.windows.as_slice() {
        [] => Some((
            window_name(&agent.machine_id, &agent.window_id, windows),
            agent.window_id.as_str(),
        )),
        [window] => Some((
            window_name(&window.machine_id, &window.window_id, windows),
            window.window_id.as_str(),
        )),
        _ => None,
    };
    Place {
        folder: &agent.cwd,
        location_id: &agent.location_id,
        window,
    }
}

/// The name of window `id` on `machine_id`, or its own ID if it is unlisted.
fn window_name<'a>(machine_id: &str, id: &'a str, windows: &'a [WindowInfo]) -> &'a str {
    if id == TERMINAL_WINDOW {
        return TERMINAL_WINDOW_LABEL;
    }
    match windows
        .iter()
        .find(|listed| listed.machine_id == machine_id && listed.window_id == id)
    {
        Some(listed) => &listed.label,
        None => id,
    }
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
    }
}
