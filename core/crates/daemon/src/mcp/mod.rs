//! The MCP server the daemon runs behind each relay. A relay, `facade-mcp`, opens with a hello that
//! says what its MCP client gave its process: its words, its environment and its folder. After it,
//! every line is an MCP JSON-RPC message, answered here. Each tool becomes daemon protocol calls,
//! made over a connection of the call's own that the daemon serves exactly as it serves its socket,
//! so a tool passes the same checks as any client.
//!
//! A relay serves one of four: the agent Facade started it for (`FACADE_AGENT`), the sessions of a
//! CLI the person started (`--guest <cli>`), a member (any other MCP client, which joins as a guest
//! when it initializes), or no one.

mod addresses;
mod agent_tools;
mod daemon_calls;
mod envelope;
mod guest_sessions;
mod in_flight;
mod instructions;
mod lines;
mod message_tools;
mod result_files;
mod schema;
mod terminal_tools;

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use facade_base::daemon_client::{DaemonClient, Identity};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use serde::Deserialize;
use serde_json::{Map, Value};

pub(crate) use result_files::{clean_results, results_folder};

/// The version of the relay contract this daemon speaks, as a relay's hello names it.
pub(crate) const RELAY_CONTRACT: u32 = 1;

/// Opens a connection to the daemon for an identity; None while the daemon hands over to a newer
/// build and takes no new client.
pub(crate) type Connect =
    Box<dyn Fn(&Identity) -> anyhow::Result<Option<DaemonClient>> + Send + Sync>;

/// Lists an MCP client that no one else serves as a member, by the name it gives in `initialize`
/// (`clientInfo.name`), and answers its agent ID, such as `a7`.
pub(crate) type JoinMember = Box<dyn Fn(Option<&str>) -> Result<String, ErrorBody> + Send + Sync>;

/// The response to a line whose answering failed unexpectedly.
pub(crate) fn internal_error() -> Value {
    lines::internal_error()
}

/// Whom a relay's server acts for.
#[derive(Clone)]
pub(crate) enum Serves {
    /// The agent Facade started, as `FACADE_AGENT` names it.
    Agent(String),
    /// The sessions of CLI `cli` that are no Facade run's own, each call acting for the session it
    /// names: `facade-mcp --guest <cli>`.
    Guest(String),
    /// A member: an MCP client listed as a guest for as long as its relay is connected.
    Member(String),
    /// No one yet. A client that initializes joins as a member; until then it serves no tools.
    Nobody,
    /// No one, beside the server of the Facade run whose own session it is in: a guest's server
    /// where that run has a server of its own. It serves no tools, and a call says why.
    Aside,
}

/// A relay's hello. Its fields are the relay contract's.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayHelloParams {
    /// The relay contract version the relay speaks.
    relay: u32,
    /// The words after its program, such as `--guest codex`.
    args: Vec<String>,
    /// The variables of its environment that are UTF-8.
    env: BTreeMap<String, String>,
    /// The folder it runs in, where it could read it.
    cwd: Option<String>,
    /// It connected to a daemon before, so its client has the tools already.
    reconnect: bool,
}

/// One relay connection, shared by the blocking tasks that answer its lines.
pub(crate) struct Relay {
    hello: RelayHelloParams,
    /// The relay's process and when it started: together they name its calls at every daemon.
    pid: u32,
    birth: String,
    connect: Connect,
    join: JoinMember,
    /// The member this relay serves, once it joined or the daemon found it again.
    member: Mutex<Option<String>>,
    /// Its `send_message` calls not yet answered.
    sends: in_flight::Sends,
    /// The connection that shows the daemon its agent's tools are there, once they are.
    presence: Mutex<Option<DaemonClient>>,
}

impl Relay {
    /// The relay whose hello `params` came from process `pid`, started at `birth`. Its tools reach
    /// the daemon through `connect`; an MCP client no one else serves joins through `join`.
    pub(crate) fn of(
        params: Value,
        pid: u32,
        birth: String,
        connect: Connect,
        join: JoinMember,
    ) -> Result<Relay, ErrorBody> {
        let hello: RelayHelloParams = decode_arguments(params)?;
        if hello.relay != RELAY_CONTRACT {
            let message = format!(
                "this Facade speaks relay contract {RELAY_CONTRACT}, not {}; restart the CLI",
                hello.relay
            );
            return Err(ErrorBody::new(Reason::ProtocolIncompatible, message));
        }
        Ok(Relay {
            hello,
            pid,
            birth,
            connect,
            join,
            member: Mutex::default(),
            sends: in_flight::Sends::default(),
            presence: Mutex::default(),
        })
    }

    /// Whether the relay connected to a daemon before.
    pub(crate) fn reconnect(&self) -> bool {
        self.hello.reconnect
    }

    /// Whom the server acts for, as the relay's words and environment say: the sessions of a CLI
    /// with `--guest <cli>`, else the agent `FACADE_AGENT` names, else no one. It may ask the
    /// daemon, so it runs in a blocking task.
    pub(crate) fn serves(&self) -> Serves {
        let args = &self.hello.args;
        let guest_of = args
            .iter()
            .position(|word| word == "--guest")
            .and_then(|at| args.get(at + 1))
            .filter(|cli| facade_base::daemon::is_session_id(cli));
        if let Some(cli) = guest_of {
            return guest_sessions::serves(self, cli);
        }
        match self.variable("FACADE_AGENT") {
            Some(agent) => Serves::Agent(agent.to_string()),
            None => Serves::Nobody,
        }
    }

    /// Serves member `id` from now on: the daemon found the member this relay joined as before it
    /// restarted.
    pub(crate) fn serve_member(&self, id: String) {
        *self.member.lock().unwrap_or_else(PoisonError::into_inner) = Some(id);
    }

    /// Notes or cancels a call as its line is read, before it waits for a thread. True where the
    /// line needs nothing more, as a cancellation does.
    pub(crate) fn notice(&self, line: &[u8]) -> bool {
        lines::notice(self, line)
    }

    /// The response to `line`, which arrived at `arrived`, from a relay whose server acts for
    /// `serves`: none for a notification or a response. It waits on the daemon, so it runs in a
    /// blocking task.
    pub(crate) fn respond(&self, serves: &Serves, line: &[u8], arrived: Instant) -> Option<Value> {
        lines::respond(self, serves, line, arrived, &DEFINITIONS, dispatch_tool)
    }

    /// Shows the daemon that `agent`'s tools are there, from now until the relay's connection ends,
    /// by holding a connection as the agent's MCP server. Runs in a blocking task.
    pub(crate) fn hold_presence(&self, agent: &str) {
        let mut presence = self.presence.lock().unwrap_or_else(PoisonError::into_inner);
        if presence.is_none() {
            match (self.connect)(&daemon_calls::as_agent(agent)) {
                Ok(held) => *presence = held,
                Err(err) => facade_base::log::write(
                    "facade-mcp",
                    "warn",
                    &format!("could not show that #{agent}'s tools are there: {err:#}"),
                ),
            }
        }
    }

    /// Whom the server acts for now: the member, once one joined on a relay that served no one.
    fn acting_for(&self, serves: &Serves) -> Serves {
        let member = self.member.lock().unwrap_or_else(PoisonError::into_inner);
        match (serves, member.as_ref()) {
            (Serves::Nobody, Some(id)) => Serves::Member(id.clone()),
            _ => serves.clone(),
        }
    }

    /// The member this relay serves, joining first where it has none. Held while it joins, so one
    /// relay joins once.
    fn member_or_join(&self, client: Option<&str>) -> Result<String, ErrorBody> {
        let mut member = self.member.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(id) = member.as_ref() {
            return Ok(id.clone());
        }
        let id = (self.join)(client)?;
        *member = Some(id.clone());
        Ok(id)
    }

    /// The relay's environment variable `name`, where it is set and not empty.
    fn variable(&self, name: &str) -> Option<&str> {
        self.hello
            .env
            .get(name)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    }
}

/// The tools as `tools/list` describes them, in order, without a result schema.
static DEFINITIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(facade_base::tools::DEFINITIONS).expect("the tool definitions are JSON")
});

#[derive(Clone, Copy)]
enum Tool {
    StartAgent,
    ListAgents,
    StopAgent,
    SendMessage,
    ReadMessages,
    ReadScreen,
    TypeText,
    PressKeys,
}

impl Tool {
    fn named(name: &str) -> Option<Tool> {
        Some(match name {
            "start_agent" => Tool::StartAgent,
            "list_agents" => Tool::ListAgents,
            "stop_agent" => Tool::StopAgent,
            "send_message" => Tool::SendMessage,
            "read_messages" => Tool::ReadMessages,
            "read_screen" => Tool::ReadScreen,
            "type_text" => Tool::TypeText,
            "press_keys" => Tool::PressKeys,
            _ => return None,
        })
    }

    /// The checks beyond the input schema, made before anything is done.
    fn check(self, arguments: &Map<String, Value>, problems: &mut Problems) {
        match self {
            Tool::StartAgent => agent_tools::check_start(arguments, problems),
            Tool::SendMessage => message_tools::check_send(arguments, problems),
            Tool::ReadMessages => message_tools::check_read(arguments, problems),
            Tool::TypeText => terminal_tools::check_text(arguments, problems),
            Tool::PressKeys => terminal_tools::check_keys(arguments, problems),
            Tool::ListAgents | Tool::StopAgent | Tool::ReadScreen => {}
        }
    }
}

/// A `tools/call` as its client made it.
struct ToolCall {
    /// Its JSON-RPC ID as a later result names it: the string itself, or the number written out.
    id: String,
    /// Its JSON-RPC ID as JSON text, as the client's cancellation names it.
    key: String,
    /// When its line arrived, before it waited for a thread: a send's 30 seconds count from then.
    arrived: Instant,
    /// The request ID it goes to the daemon with, where the model gives none: the relay's process
    /// and the call's ID, the same at every daemon, so that a call the relay gives the next daemon
    /// repeats what the first did.
    request_id: String,
}

impl ToolCall {
    fn of(relay: &Relay, id: &Value, arrived: Instant) -> ToolCall {
        let key = id.to_string();
        ToolCall {
            id: id.as_str().map_or_else(|| key.clone(), str::to_string),
            request_id: format!("facade-{}-{}-{key}", relay.pid, relay.birth),
            key,
            arrived,
        }
    }
}

/// The problems found in one call's arguments.
#[derive(Debug, Default)]
struct Problems {
    missing: Vec<String>,
    others: Vec<String>,
}

impl Problems {
    /// Notes a problem other than a missing argument.
    fn add(&mut self, problem: impl Into<String>) {
        self.others.push(problem.into());
    }

    /// Names an extra argument and gives the replacement for a renamed one.
    fn add_unknown_argument(&mut self, tool: &str, key: &str) {
        match (tool, key) {
            ("read_screen", "last") => {
                self.add("unknown argument 'last' for read_screen. Use 'lines'")
            }
            ("start_agent", "path") => {
                self.add("unknown argument 'path' for start_agent. Use 'folder'")
            }
            ("start_agent", "location_id") => self.add(
                "unknown argument 'location_id' for start_agent. Use 'folder' from list_agents",
            ),
            _ => self.add(format!("{key} is not an argument of {tool}")),
        }
    }

    fn total(&self) -> usize {
        self.missing.len() + self.others.len()
    }

    /// The `invalid_argument` failure of a call to `tool` that names every problem.
    fn into_failure(self, tool: &str) -> Option<Value> {
        if self.total() == 0 {
            return None;
        }
        let mut words = Vec::with_capacity(self.total() + 2);
        if !self.missing.is_empty() {
            words.push(format!("{tool} requires {}", self.missing.join(", ")));
        }
        words.extend(self.others);
        words.push("nothing was done".to_string());
        Some(envelope::failure("invalid_argument", words.join("; ")))
    }
}

/// Reads the arguments as the tool's schema describes them, then checks the tool's extra rules.
fn validate_tool(name: &str, given: &Value) -> Result<(Tool, Map<String, Value>), Value> {
    let found = Tool::named(name).zip(
        DEFINITIONS
            .iter()
            .find(|definition| definition["name"] == name),
    );
    let Some((tool, definition)) = found else {
        let names: Vec<&str> = DEFINITIONS
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect();
        let message = format!("no tool {name}; the tools are {}", names.join(", "));
        return Err(envelope::failure("unsupported", message));
    };
    let mut problems = Problems::default();
    let arguments = schema::read_arguments(name, &definition["inputSchema"], given, &mut problems);
    tool.check(&arguments, &mut problems);
    if let Some(failure) = problems.into_failure(name) {
        return Err(failure);
    }
    Ok((tool, arguments))
}

/// Checks a tool call and runs it on a connection of its own. A cancelled send may return None.
fn dispatch_tool(
    relay: &Relay,
    agent: &str,
    name: &str,
    given: &Value,
    call: &ToolCall,
) -> Option<Value> {
    let (tool, arguments) = match validate_tool(name, given) {
        Ok(checked) => checked,
        Err(failure) => return Some(failure),
    };
    // A send connects within its own 30 seconds.
    if let Tool::SendMessage = tool {
        return message_tools::send(relay, agent, &arguments, call);
    }
    let mut client = match daemon_calls::open_as_agent(relay, agent) {
        Ok(client) => client,
        Err(failure) => return Some(failure),
    };
    let client = &mut client;
    Some(match tool {
        Tool::StartAgent => agent_tools::start(client, agent, &arguments, call),
        Tool::ListAgents => agent_tools::list(client),
        Tool::StopAgent => agent_tools::stop(client, &arguments),
        Tool::ReadMessages => message_tools::read(client, &arguments),
        Tool::ReadScreen => terminal_tools::read_screen(client, &arguments),
        Tool::TypeText => terminal_tools::type_text(client, &arguments),
        Tool::PressKeys => terminal_tools::press_keys(client, &arguments),
        Tool::SendMessage => unreachable!("a send was made above"),
    })
}

/// The string argument `key`, which the schema checked, or an empty one where it is optional and
/// left out.
fn text(arguments: &Map<String, Value>, key: &str) -> String {
    optional(arguments, key).unwrap_or_default()
}

/// The string argument `key`, where it was given.
fn optional(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
impl Relay {
    /// A relay with `args` and `env` whose tools reach no daemon, as unit tests have none.
    pub(crate) fn for_test(args: &[&str], env: &[(&str, &str)]) -> Relay {
        let hello = RelayHelloParams {
            relay: RELAY_CONTRACT,
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: env
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            cwd: None,
            reconnect: false,
        };
        Relay {
            hello,
            pid: 7,
            birth: "1".to_string(),
            connect: Box::new(|_| anyhow::bail!("unit tests have no daemon")),
            join: Box::new(|_| Err(ErrorBody::internal("unit tests have no daemon"))),
            member: Mutex::default(),
            sends: in_flight::Sends::default(),
            presence: Mutex::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::{ClientKind, HelloParams, methods};
    use facade_base::jsonrpc::Request;
    use serde_json::json;

    use super::*;

    #[test]
    fn relay_v1_frames_are_separate_from_the_mcp_client_identity() {
        let mut frames = include_str!("../../../relay/tests/fixtures/relay-hello.jsonl").lines();
        for (cwd, reconnect) in [(Some("/work folder"), false), (None, true)] {
            let request: Request = serde_json::from_str(frames.next().unwrap()).unwrap();
            assert_eq!(request.id, Some(1));
            assert_eq!(request.method, methods::HELLO);
            assert!(crate::server::is_relay_hello(&request.params));

            let hello: RelayHelloParams = decode_arguments(request.params.clone()).unwrap();
            assert_eq!(hello.relay, RELAY_CONTRACT);
            assert_eq!(hello.args, ["--guest", "codex"]);
            assert_eq!(
                hello.env.get("FACADE_TEST_VALUE").map(String::as_str),
                Some("line\n\"quoted\" ☃")
            );
            assert_eq!(hello.cwd.as_deref(), cwd);
            assert_eq!(hello.reconnect, reconnect);

            let mut with_kind = request.params;
            with_kind["kind"] = json!("mcp");
            assert!(
                decode_arguments::<RelayHelloParams>(with_kind)
                    .is_err_and(|error| error.data.reason == Reason::InvalidArgument)
            );
        }
        assert!(frames.next().is_none());

        let ordinary = json!({
            "protocol": [2, 2], "build": "test", "kind": "mcp", "agent": "a1",
        });
        assert!(!crate::server::is_relay_hello(&ordinary));
        let hello: HelloParams = decode_arguments(ordinary).unwrap();
        assert_eq!(hello.kind, ClientKind::Mcp);
    }

    #[test]
    fn the_tools_are_the_eight_in_their_order() {
        let names: Vec<&str> = DEFINITIONS
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            [
                "start_agent",
                "list_agents",
                "stop_agent",
                "send_message",
                "read_messages",
                "read_screen",
                "type_text",
                "press_keys"
            ]
        );
    }

    #[test]
    fn start_agent_checks_folder_and_worktree_before_dispatch() {
        let (_, args) = validate_tool("start_agent", &json!({ "cli": "fake" })).unwrap();
        assert!(!args.contains_key("folder"));
        for (args, base) in [
            (
                json!({ "cli": "fake", "worktree": { "branch": "review" } }),
                "HEAD",
            ),
            (
                json!({ "cli": "fake", "worktree": { "branch": "review", "base_ref": "v1" } }),
                "v1",
            ),
        ] {
            let (_, args) = validate_tool("start_agent", &args).unwrap();
            assert_eq!(
                args["worktree"],
                json!({ "branch": "review", "base_ref": base })
            );
        }
        for (args, message) in [
            (json!({}), "start_agent requires cli"),
            (
                json!({ "cli": "fake", "path": ".", "folder": "." }),
                "unknown argument 'path' for start_agent. Use 'folder'",
            ),
            (
                json!({ "cli": "fake", "location_id": "loc-7" }),
                "unknown argument 'location_id' for start_agent. Use 'folder' from list_agents",
            ),
            (
                json!({ "cli": "fake", "folder": "" }),
                "folder must not be empty",
            ),
            (
                json!({ "cli": "fake", "worktree": "review" }),
                r#"worktree must be an object. Use {"branch": "topic"}"#,
            ),
            (
                json!({ "cli": "fake", "worktree": r#"{"branch":"review"}"# }),
                r#"worktree must be an object. Use {"branch": "topic"}"#,
            ),
            (
                json!({ "cli": "fake", "worktree": {} }),
                "start_agent requires worktree.branch",
            ),
            (
                json!({ "cli": "fake", "worktree": { "branch": "" } }),
                "worktree.branch must not be empty",
            ),
            (
                json!({ "cli": "fake", "worktree": { "branch": "review", "base_ref": "" } }),
                "worktree.base_ref must not be empty",
            ),
            (
                json!({ "cli": "fake", "worktree": { "branch": "review", "path": "." } }),
                "path is not a field of worktree",
            ),
        ] {
            let Err(failure) = validate_tool("start_agent", &args) else {
                panic!("accepted invalid start_agent arguments: {args}");
            };
            assert_eq!(failure["reason"], "invalid_argument", "{failure}");
            assert_eq!(failure["message"], format!("{message}; nothing was done"));
        }
    }

    #[test]
    fn read_screen_requires_an_agent_and_defaults_lines_to_fifty() {
        let (_, arguments) = validate_tool("read_screen", &json!({ "agent": "#a7" })).unwrap();
        assert_eq!(arguments["lines"], 50);
        for lines in [1, 2000] {
            let (_, arguments) =
                validate_tool("read_screen", &json!({ "agent": "#a7", "lines": lines })).unwrap();
            assert_eq!(arguments["lines"], lines);
        }
        for (given, message) in [
            (
                json!({ "lines": 50 }),
                "read_screen requires agent; nothing was done",
            ),
            (
                json!({ "agent": "#a7", "lines": 0 }),
                "lines must be from 1 to 2000, not 0; nothing was done",
            ),
            (
                json!({ "agent": "#a7", "lines": 2001 }),
                "lines must be from 1 to 2000, not 2001; nothing was done",
            ),
        ] {
            let Err(failure) = validate_tool("read_screen", &given) else {
                panic!("accepted invalid read_screen arguments: {given}");
            };
            assert_eq!(failure["reason"], "invalid_argument");
            assert_eq!(failure["message"], message);
        }
    }
}
