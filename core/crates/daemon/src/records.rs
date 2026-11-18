//! Agent records: the #aN numbers, the default names, and what a reference names within a client's
//! reach (RULES-2.3, RULES-4.3).
//!
//! Reach decides which agents a client can find, list, read, type into, stop and send to. The
//! person, through an editor window or a `facade` command acting for no agent, reaches every agent,
//! and so does an agent whose run has YOLO on. An agent whose run has YOLO off reaches the agents of
//! its creation tree: those with its root. A name outside reach names nothing; an ID outside reach
//! is refused. Windows, locations and CLIs are not limited by reach.

use std::collections::HashSet;
use std::sync::Mutex;

use facade_base::daemon::{AgentInfo, display_name};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::process::ProcessState;

use crate::HUMAN;
use crate::store::NumberTable;

/// The agents a client reaches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    /// Every agent: the person's reach, and that of an agent whose run has YOLO on.
    All,
    /// The agents of the creation tree whose first agent is `root`: the reach of `agent`, whose run
    /// has YOLO off.
    Tree { agent: String, root: String },
}

impl Reach {
    /// Whether the client reaches the agent `info` describes.
    pub(crate) fn reaches(&self, info: &AgentInfo) -> bool {
        match self {
            Reach::All => true,
            Reach::Tree { root, .. } => &info.root == root,
        }
    }

    /// The refusal of a call about agent `id`, which the client does not reach.
    pub(crate) fn refusal(&self, id: &str) -> ErrorBody {
        let reason = match self {
            Reach::All => String::new(),
            Reach::Tree { agent, .. } => format!(
                ": #{agent}'s run has YOLO off, so it reaches only the agents of its creation tree"
            ),
        };
        ErrorBody::new(
            Reason::Refused,
            format!("#{id} is out of reach{reason}; nothing was done"),
        )
    }
}

/// What a reference names.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Named {
    /// The agent with this ID.
    Agent(String),
    /// The person, who is no agent.
    Person,
}

/// The agent numbers, and the names and records the daemon holds aside: default names picked for
/// starts not listed yet, and agents whose records this version cannot read.
pub(crate) struct Records {
    numbers: NumberTable,
    /// Names picked by `reserve_name` and not yet released.
    reserved: Mutex<HashSet<String>>,
    unreadable: Mutex<HashSet<String>>,
}

impl Records {
    /// Records that hand out numbers from `numbers`, with nothing reserved or unreadable yet.
    pub(crate) fn new(numbers: NumberTable) -> Records {
        Records {
            numbers,
            reserved: Mutex::default(),
            unreadable: Mutex::default(),
        }
    }

    /// The ID of a new agent, such as `a7`: commits the next number on a blocking worker. A start
    /// that fails later still uses its number up, so no ID is ever given twice.
    pub(crate) async fn next_id(&self) -> Result<String, ErrorBody> {
        let numbers = self.numbers.clone();
        let number = tokio::task::spawn_blocking(move || numbers.allocate_number())
            .await
            .map_err(|err| ErrorBody::new(Reason::Internal, err.to_string()))?
            .map_err(|err| ErrorBody::new(Reason::Internal, format!("{err:#}")))?;
        Ok(format!("a{number}"))
    }

    /// Raises the counter so the next agent number is above `given`; one already above stays.
    /// Blocks.
    pub(crate) fn raise_above(&self, given: u64) -> anyhow::Result<()> {
        self.numbers.raise_above(given)
    }

    /// Picks a name for agent `id`, started without one (LIFECYCLE-2.1), and holds it until
    /// `release_name`: at random, one of `names` (the settings file's, else the default names) that
    /// is not in `taken`, the names of the agents in its window, and that no other start holds;
    /// ignoring case and surrounding spaces. Where none is free, the agent's ID, such as `#a7`.
    /// Locks the reserved names; the caller holds the agents lock, which comes first.
    pub(crate) fn reserve_name(
        &self,
        mut taken: Vec<String>,
        id: &str,
        names: Option<&[String]>,
    ) -> String {
        let mut reserved = self.reserved.lock().unwrap();
        taken.extend(reserved.iter().cloned());
        let name = free_name(&taken, names).unwrap_or_else(|| format!("#{id}"));
        reserved.insert(name.clone());
        name
    }

    /// Lets other starts pick `name` again: its agent is listed, or its start failed.
    pub(crate) fn release_name(&self, name: &str) {
        self.reserved.lock().unwrap().remove(name);
    }

    /// Remembers agents whose records this version cannot read, so their runs are left alone.
    pub(crate) fn keep_unreadable(&self, ids: HashSet<String>) {
        self.unreadable.lock().unwrap().extend(ids);
    }

    /// Whether agent `id` has a record this version cannot read.
    pub(crate) fn is_unreadable(&self, id: &str) -> bool {
        self.unreadable.lock().unwrap().contains(id)
    }
}

/// The reach of a client acting for agent `caller`, or for the person where it acts for none.
/// `info` is the caller's, where it is listed; one no longer listed reaches the tree it would be
/// the first of, as the agents it starts then join.
pub(crate) fn reach_of(caller: Option<&str>, info: Option<&AgentInfo>) -> Reach {
    match (caller, info) {
        (None, _) => Reach::All,
        (Some(_), Some(info)) if info.yolo => Reach::All,
        (Some(caller), info) => Reach::Tree {
            agent: caller.to_string(),
            root: info.map_or(caller, |info| info.root.as_str()).to_string(),
        },
    }
}

/// What `reference` names among `agents`, within `reach`. An agent is named by its ID (`a3`, `#a3`
/// or `3`), by a unique name with or without `@`, or by a name and then its ID, such as
/// `@Pixel #a3`, where the ID decides. An ID out of reach is refused; a name only names agents in
/// reach. `#human` names the person, and so do `human` and `@human` while no agent in reach has
/// that name, in any case. With `running_only`, ended agents are left out of names, and a name only
/// ended agents have fails as ended.
pub(crate) fn resolve(
    agents: &[AgentInfo],
    reference: &str,
    reach: &Reach,
    running_only: bool,
) -> Result<Named, ErrorBody> {
    let text = reference.trim();
    let in_reach: Vec<&AgentInfo> = agents.iter().filter(|info| reach.reaches(info)).collect();
    if text.eq_ignore_ascii_case("#human") {
        return Ok(Named::Person);
    }
    if text
        .strip_prefix('@')
        .unwrap_or(text)
        .eq_ignore_ascii_case(HUMAN)
    {
        return person_unless_named(text, &in_reach);
    }
    let id_at_end = id_at_end(reference);
    let id = normalize_agent_reference(id_at_end.unwrap_or(reference));
    if let Some(info) = agents.iter().find(|info| info.agent_id == id) {
        return match reach.reaches(info) {
            true => Ok(Named::Agent(id)),
            false => Err(reach.refusal(&id)),
        };
    }
    if id_at_end.is_some() {
        return Err(no_agent(reference, &in_reach));
    }
    let name = reference.strip_prefix('@').unwrap_or(reference);
    let (live, ended): (Vec<&AgentInfo>, Vec<&AgentInfo>) = in_reach
        .iter()
        .copied()
        .filter(|info| info.name == name)
        .partition(|info| !running_only || info.process != ProcessState::Ended);
    match (live.as_slice(), ended.is_empty()) {
        ([only], _) => Ok(Named::Agent(only.agent_id.clone())),
        ([], true) => Err(no_agent(reference, &in_reach)),
        ([], false) => Err(ErrorBody::new(
            Reason::Ended,
            format!("{reference} ended: #{} takes no messages", ids(&ended)),
        )),
        _ => Err(ErrorBody::new(
            Reason::AmbiguousReference,
            format!("{reference} names several agents; nothing was done; give its ID, such as #a3"),
        )),
    }
}

/// The number of agent ID `id`, such as 3 for `a3`, to sort by; the largest for anything else.
pub(crate) fn agent_number(id: &str) -> u64 {
    let digits = id.strip_prefix('a').unwrap_or("");
    digits.parse().unwrap_or(u64::MAX)
}

/// An agent ID from the ways a person writes one: `a3`, `#a3` and `3` all give `a3`. Anything else
/// loses only a leading `#`.
pub(crate) fn normalize_agent_reference(reference: &str) -> String {
    let rest = reference.strip_prefix('#').unwrap_or(reference);
    match rest.bytes().all(|byte| byte.is_ascii_digit()) && !rest.is_empty() {
        true => format!("a{rest}"),
        false => rest.to_string(),
    }
}

/// `human` or `@human` (`text`) names the person while no agent in reach has that name; otherwise
/// it is ambiguous.
fn person_unless_named(text: &str, in_reach: &[&AgentInfo]) -> Result<Named, ErrorBody> {
    let named: Vec<&AgentInfo> = in_reach
        .iter()
        .copied()
        .filter(|info| info.name.eq_ignore_ascii_case(HUMAN))
        .collect();
    if named.is_empty() {
        return Ok(Named::Person);
    }
    Err(ErrorBody::new(
        Reason::AmbiguousReference,
        format!(
            "{text} names the person and #{}; use #human for the person, or the agent's ID",
            ids(&named)
        ),
    ))
}

/// The failure of a reference that names no agent, listing the agents in reach so the caller can
/// correct it.
fn no_agent(reference: &str, in_reach: &[&AgentInfo]) -> ErrorBody {
    let mut listed: Vec<(u64, String)> = in_reach
        .iter()
        .map(|info| {
            let label = format!("#{} {}", info.agent_id, display_name(&info.name));
            (agent_number(&info.agent_id), label)
        })
        .collect();
    listed.sort();
    let listed: Vec<String> = listed.into_iter().map(|(_, label)| label).collect();
    let message = match listed.is_empty() {
        true => format!("no agent {reference}; nothing was done; no agents are listed"),
        false => format!(
            "no agent {reference}; nothing was done; you can reach {}",
            listed.join(", ")
        ),
    };
    ErrorBody::new(Reason::NotFound, message)
}

/// The IDs of `agents` by number, joined as `a1, #a4` to follow a `#`.
fn ids(agents: &[&AgentInfo]) -> String {
    let mut ids: Vec<&str> = agents.iter().map(|info| info.agent_id.as_str()).collect();
    ids.sort_by_key(|id| agent_number(id));
    ids.join(", #")
}

/// The ID at the end of a reference written as Facade writes an agent, a name and then its ID, such
/// as `#a3` in `@Pixel #a3`.
fn id_at_end(reference: &str) -> Option<&str> {
    let (_, last) = reference.trim().rsplit_once(char::is_whitespace)?;
    let digits = last.strip_prefix("#a")?;
    let is_id = !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
    is_id.then_some(last)
}

/// A name that is in neither `taken` nor empty, from `names`, else from `DEFAULT_NAMES`, at random;
/// names compare without case and surrounding spaces. None where every one is taken.
fn free_name(taken: &[String], names: Option<&[String]>) -> Option<String> {
    let folded = |name: &str| trimmed(name).to_lowercase();
    let taken: HashSet<String> = taken.iter().map(|name| folded(name)).collect();
    let candidates: Vec<&str> = match names {
        Some(names) => names.iter().map(String::as_str).collect(),
        None => DEFAULT_NAMES.to_vec(),
    };
    let free: Vec<&str> = candidates
        .into_iter()
        .map(trimmed)
        .filter(|name| !name.is_empty() && !taken.contains(&name.to_lowercase()))
        .collect();
    let pick = facade_base::random_u64().checked_rem(free.len() as u64)?;
    Some(free[pick as usize].to_string())
}

/// `name` without the spaces the editor trims.
fn trimmed(name: &str) -> &str {
    name.trim_matches(facade_base::settings::is_space)
}

/// The names agents get when they are started without one, shared with
/// `extension/src/base/names.ts`: short ASCII machine terms with distinct three-letter prefixes.
const DEFAULT_NAMES: [&str; 140] = [
    "Abacus", "Alloy", "Anvil", "Arc", "Atom", "Axle", "Baud", "Beacon", "Bit", "Blip", "Bolt",
    "Boson", "Brace", "Buzz", "Byte", "Cable", "Caliper", "Cam", "Capstan", "Chassis", "Chip",
    "Circuit", "Clamp", "Clutch", "Cobalt", "Cog", "Coil", "Compass", "Copper", "Crank", "Crystal",
    "Dial", "Diode", "Dipole", "Drill", "Drone", "Dynamo", "Ember", "Engine", "Fiber", "Filament",
    "Flange", "Flux", "Fuse", "Gadget", "Gauge", "Gear", "Gimbal", "Gizmo", "Glide", "Grommet",
    "Gyro", "Hammer", "Helix", "Hertz", "Hinge", "Hover", "Ion", "Jack", "Jet", "Jolt", "Joule",
    "Kelvin", "Kite", "Knob", "Laser", "Latch", "Lens", "Lever", "Lumen", "Lux", "Magneto", "Mech",
    "Meter", "Modem", "Motor", "Nano", "Neon", "Nibble", "Nickel", "Nova", "Nozzle", "Ohm",
    "Optic", "Orbit", "Photon", "Pilot", "Piston", "Pivot", "Pixel", "Plasma", "Plug", "Prism",
    "Probe", "Pulse", "Pump", "Pylon", "Quark", "Radar", "Ratchet", "Rebar", "Relay", "Rivet",
    "Rocket", "Rotor", "Rover", "Rudder", "Scout", "Sensor", "Servo", "Shaft", "Shuttle", "Solder",
    "Sonar", "Spark", "Spindle", "Spoke", "Spring", "Stator", "Strut", "Stylus", "Throttle",
    "Torque", "Tractor", "Turbo", "Valve", "Vapor", "Visor", "Volt", "Vortex", "Watt", "Wedge",
    "Weld", "Widget", "Winch", "Wrench", "Yoke", "Zap", "Zener", "Zinc",
];

#[cfg(test)]
mod tests {
    use facade_base::daemon::{AgentState, ToolsState};

    use super::*;

    /// Agent `id`, named `name`, started by `creator` in the tree of `root`, its run's YOLO `yolo`.
    fn agent(id: &str, name: &str, creator: Option<&str>, root: &str, yolo: bool) -> AgentInfo {
        AgentInfo {
            agent_id: id.into(),
            name: name.into(),
            cli: "fake".into(),
            cwd: "/w".into(),
            machine_id: String::new(),
            windows: Vec::new(),
            location_source_window: None,
            window_id: "terminal".into(),
            location_id: "loc-1".into(),
            pid: Some(1),
            process: ProcessState::Running,
            cols: Some(80),
            rows: Some(24),
            created_at: "2026-11-12T00:00:00.000Z".into(),
            creator: creator.map(str::to_string),
            creator_machine_id: None,
            root: root.into(),
            root_machine_id: None,
            yolo,
            exit: None,
            session: None,
            state: AgentState::Idle,
            state_detail: None,
            said: None,
            tools_state: ToolsState::NotInjected,
            tools_reason: None,
            guest: false,
        }
    }

    /// Two trees: the person's Ada, her child Bea and grandchild Cy, all YOLO off; and the person's
    /// Dan, YOLO on, and his child Eve, YOLO off, named `human`.
    fn agents() -> Vec<AgentInfo> {
        vec![
            agent("a1", "Ada", None, "a1", false),
            agent("a2", "Bea", Some("a1"), "a1", false),
            agent("a3", "Cy", Some("a2"), "a1", false),
            agent("a4", "Dan", None, "a4", true),
            agent("a5", "human", Some("a4"), "a4", false),
        ]
    }

    /// The reach of `caller` among `agents`.
    fn reach(agents: &[AgentInfo], caller: Option<&str>) -> Reach {
        let info = caller.and_then(|id| agents.iter().find(|info| info.agent_id == id));
        reach_of(caller, info)
    }

    /// The agent `reference` names, from Cy's or another reach.
    fn agent_named(agents: &[AgentInfo], reference: &str, reach: &Reach) -> String {
        match resolve(agents, reference, reach, false) {
            Ok(Named::Agent(id)) => id,
            other => panic!("{reference}: {other:?}"),
        }
    }

    /// An agent whose run has YOLO off reaches its whole creation tree, ancestors, descendants and
    /// siblings alike, and no other; one whose run has YOLO on reaches every agent, and so does the
    /// person. Its tree, not its creator's YOLO, decides.
    #[test]
    fn yolo_off_reaches_the_creation_tree_and_yolo_on_and_the_person_reach_every_agent() {
        let agents = agents();
        let reached = |caller: Option<&str>| {
            let reach = reach(&agents, caller);
            agents
                .iter()
                .filter(|info| reach.reaches(info))
                .map(|info| info.agent_id.clone())
                .collect::<Vec<_>>()
        };
        for caller in ["a1", "a2", "a3"] {
            assert_eq!(reached(Some(caller)), ["a1", "a2", "a3"], "#{caller}");
        }
        assert_eq!(
            reached(Some("a5")),
            ["a4", "a5"],
            "a YOLO-off child of a YOLO-on creator reaches its own tree"
        );
        assert_eq!(reached(Some("a4")), ["a1", "a2", "a3", "a4", "a5"]);
        assert_eq!(reached(None), ["a1", "a2", "a3", "a4", "a5"], "the person");
        assert_eq!(
            reach(&agents, Some("a9")),
            Reach::Tree {
                agent: "a9".into(),
                root: "a9".into()
            },
            "an agent no longer listed"
        );
    }

    /// A reference resolves among the agents in reach: an ID out of reach is refused, saying why, a
    /// name out of reach names nothing and lists only the agents in reach, and `@human` names the
    /// person while no agent in reach has that name.
    #[test]
    fn a_reference_resolves_within_reach() {
        let agents = agents();
        let cy = reach(&agents, Some("a3"));
        assert_eq!(agent_named(&agents, "#a1", &cy), "a1");
        assert_eq!(agent_named(&agents, "@Bea", &cy), "a2");
        let refused = resolve(&agents, "#a4", &cy, false).expect_err("refused");
        assert_eq!(refused.data.reason, Reason::Refused);
        assert_eq!(
            refused.message,
            "#a4 is out of reach: #a3's run has YOLO off, so it reaches only the agents of its \
             creation tree; nothing was done"
        );
        let unknown = resolve(&agents, "@Dan", &cy, false).expect_err("not found");
        assert_eq!(unknown.data.reason, Reason::NotFound);
        assert_eq!(
            unknown.message,
            "no agent @Dan; nothing was done; you can reach #a1 Ada, #a2 Bea, #a3 Cy"
        );
        assert_eq!(
            resolve(&agents, "@human", &cy, true),
            Ok(Named::Person),
            "Eve, named human, is out of reach"
        );
        assert_eq!(
            resolve(&agents, "@human", &Reach::All, true)
                .err()
                .map(|error| error.data.reason),
            Some(Reason::AmbiguousReference)
        );
        assert_eq!(agent_named(&agents, "@Dan", &Reach::All), "a4");
    }

    #[test]
    fn an_agent_is_named_by_its_id_with_or_without_its_hash_or_by_its_number_alone() {
        for reference in ["#a3", "a3", "3"] {
            assert_eq!(normalize_agent_reference(reference), "a3", "{reference}");
        }
        for reference in ["Coil", "a", "#Coil"] {
            assert_eq!(
                normalize_agent_reference(reference),
                reference.trim_start_matches('#'),
                "{reference} is a name"
            );
        }
        assert_eq!(
            (
                agent_number("a3"),
                agent_number("a12"),
                agent_number("Coil")
            ),
            (3, 12, u64::MAX)
        );
    }

    /// A name is one no agent has while one is left, ignoring case and surrounding spaces; with
    /// every one taken, or a list of none, there is none. The settings file's names stand in for
    /// the default ones.
    #[test]
    fn a_name_is_one_no_agent_has_while_one_is_left() {
        let mut taken: Vec<String> = DEFAULT_NAMES[1..]
            .iter()
            .map(|name| format!(" {} ", name.to_uppercase()))
            .collect();
        assert_eq!(
            free_name(&taken, None).as_deref(),
            Some(DEFAULT_NAMES[0]),
            "the unused name, ignoring case and spaces"
        );
        taken.push(DEFAULT_NAMES[0].to_string());
        assert_eq!(free_name(&taken, None), None, "every one taken");
        let names = ["Ada".to_string(), "Bo".to_string()];
        assert_eq!(
            free_name(&["ADA".into()], Some(&names)).as_deref(),
            Some("Bo")
        );
        assert_eq!(free_name(&[], Some(&[])), None, "a list of none");
        // Spaces as the editor has them: a byte order mark is one
        assert_eq!(
            free_name(&["\u{feff}Ada ".into()], Some(&names[..1])),
            None,
            "taken, ignoring the editor's spaces"
        );
    }

    #[test]
    fn the_default_names_are_the_extension_s_list() {
        let source = include_str!("../../../../extension/src/base/names.ts");
        let list = &source[source
            .find("BUILT_IN_NAMES")
            .expect("expected the extension's built-in names")..];
        let list = &list[list.find("= [").expect("expected a names array") + 3..];
        let list = &list[..list.find(']').expect("expected the closing array bracket")];
        let extension: Vec<&str> = list
            .split(',')
            .map(|name| name.trim().trim_matches('\''))
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(
            extension, DEFAULT_NAMES,
            "default names must match the extension in order"
        );
    }
}
