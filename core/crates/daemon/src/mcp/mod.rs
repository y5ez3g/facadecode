//! The MCP server the daemon runs behind each relay. A relay, `facade-mcp`, opens with a hello that
//! says what its MCP client gave its process: its words, its environment and its folder. After it,
//! every line is an MCP JSON-RPC message, answered here. Each tool call acts for the actor the daemon
//! verified for the relay's connection, and its daemon calls go over a connection bound to that
//! actor.

mod addresses;
mod agent_tools;
mod daemon_calls;
mod envelope;
mod in_flight;
mod inbox_page;
mod lines;
mod message_tools;
mod result_files;
mod schema;
mod terminal_tools;
pub(crate) mod verified;
mod verified_tools;

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use serde::Deserialize;
use serde_json::{Map, Value};

pub(crate) use inbox_page::project_inbox;
pub(crate) use result_files::{clean_results, results_folder};
pub(crate) use verified::{ActorIdentity, ActorServices};

/// The instructions for the managed run that the daemon can verify during initialization.
pub(crate) type ManagedInstructions =
    Box<dyn Fn(Option<&str>) -> Result<Option<String>, ErrorBody> + Send + Sync>;

/// The version of the relay contract this daemon speaks, as a relay's hello names it.
pub(crate) const RELAY_CONTRACT: u32 = 1;

/// The response to a line whose answering failed unexpectedly.
pub(crate) fn internal_error() -> Value {
    lines::internal_error()
}

/// A relay's hello. Its fields are the relay contract's.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RelayHelloParams {
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

impl RelayHelloParams {
    /// The hello in `params`, where it is of the relay contract this daemon speaks.
    pub(crate) fn decode(params: Value) -> Result<RelayHelloParams, ErrorBody> {
        let hello: RelayHelloParams = decode_arguments(params)?;
        if hello.relay != RELAY_CONTRACT {
            let message = format!(
                "this Facade speaks relay contract {RELAY_CONTRACT}, not {}; restart the CLI",
                hello.relay
            );
            return Err(ErrorBody::new(Reason::ProtocolIncompatible, message));
        }
        Ok(hello)
    }

    /// The words after the relay's program.
    pub(crate) fn args(&self) -> &[String] {
        &self.args
    }

    /// The relay's environment.
    pub(crate) fn env(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    /// The folder the relay runs in, where it could read it.
    pub(crate) fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }
}

/// One relay connection, shared by the blocking tasks that answer its lines.
pub(crate) struct Relay {
    hello: RelayHelloParams,
    /// The relay's process and when it started: together they name its calls at every daemon.
    pid: u32,
    birth: String,
    /// The actor its calls act for, and the daemon services that verify and reach it.
    verified: verified::Verified,
    /// Its `send_message` and `read_messages` calls not yet answered.
    sends: in_flight::Sends,
    /// The connection that shows the daemon its actor's tools are there, once they are.
    presence: Mutex<Option<DaemonClient>>,
}

impl Relay {
    /// The relay whose `hello` came from process `pid`, started at `birth`. Its tools reach the
    /// daemon through `services`, as the actor they verify.
    pub(crate) fn of_verified(
        hello: RelayHelloParams,
        pid: u32,
        birth: String,
        services: ActorServices,
    ) -> Relay {
        Relay {
            hello,
            pid,
            birth,
            verified: verified::Verified::new(services),
            sends: in_flight::Sends::default(),
            presence: Mutex::default(),
        }
    }

    /// Whether the relay connected to a daemon before.
    pub(crate) fn reconnect(&self) -> bool {
        self.hello.reconnect
    }

    /// Notes or cancels a call as its line is read, before it waits for a thread. True where the
    /// line needs nothing more, as a cancellation does.
    pub(crate) fn notice(&self, line: &[u8]) -> bool {
        lines::notice(self, line)
    }

    /// The response to `line`, which arrived at `arrived`: none for a notification or a response. It
    /// waits on the daemon, so it runs in a blocking task.
    pub(crate) fn respond_verified(&self, line: &[u8], arrived: Instant) -> Option<Value> {
        lines::respond(self, line, arrived)
    }

    /// Shows the daemon that the verified run's tools are there, from now until the relay's
    /// connection ends. Runs in a blocking task.
    pub(crate) fn hold_verified_presence(&self) {
        self.verified.hold_presence(self);
    }
}

/// The tools as `tools/list` describes them, in order, without a result schema.
static V3_DEFINITIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(facade_base::tools::V3_DEFINITIONS)
        .expect("the v3 tool definitions are JSON")
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
fn validate(
    name: &str,
    given: &Value,
    definitions: &[Value],
) -> Result<(Tool, Map<String, Value>), Value> {
    let found = Tool::named(name).zip(
        definitions
            .iter()
            .find(|definition| definition["name"] == name),
    );
    let Some((tool, definition)) = found else {
        let names: Vec<&str> = definitions
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
    /// A relay whose tools reach no daemon, as unit tests have none.
    pub(crate) fn for_test() -> Relay {
        let hello = RelayHelloParams {
            relay: RELAY_CONTRACT,
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            reconnect: false,
        };
        let services = ActorServices {
            authenticate: Box::new(|_, _, _| Err(ErrorBody::internal("unit tests have no daemon"))),
            connect: Box::new(|_| anyhow::bail!("unit tests have no daemon")),
            read_inbox: Box::new(|_, _, _| Err(ErrorBody::internal("unit tests have no daemon"))),
            managed_instructions: Box::new(|_| Ok(None)),
            ready: Box::new(|_| anyhow::bail!("unit tests have no daemon")),
        };
        Relay {
            hello,
            pid: 7,
            birth: "1".to_string(),
            verified: verified::Verified::new(services),
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

            let hello = RelayHelloParams::decode(request.params.clone()).unwrap();
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
                RelayHelloParams::decode(with_kind)
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
        let names: Vec<&str> = V3_DEFINITIONS
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
        let validate = |args: &Value| super::validate("start_agent", args, &V3_DEFINITIONS);
        let (_, args) = validate(&json!({ "cli": "fake" })).unwrap();
        assert!(!args.contains_key("folder"));
        let (_, args) = validate(&json!({"cli": "fake", "worktree": "review"})).unwrap();
        assert_eq!(args["worktree"], "review");
        for (args, message) in [
            (json!({}), "start_agent requires cli"),
            (
                json!({ "cli": "fake", "args": ["--example"] }),
                "args is not an argument of start_agent",
            ),
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
                json!({ "cli": "fake", "worktree": { "branch": "review", "base_ref": "HEAD" } }),
                "worktree must be a string, not an object",
            ),
            (
                json!({ "cli": "fake", "worktree": "" }),
                "worktree must not be empty",
            ),
            (
                json!({ "cli": "fake", "window": "win-1" }),
                "window is not an argument of start_agent",
            ),
        ] {
            let Err(failure) = validate(&args) else {
                panic!("accepted invalid start_agent arguments: {args}");
            };
            assert_eq!(failure["reason"], "invalid_argument", "{failure}");
            assert_eq!(failure["message"], format!("{message}; nothing was done"));
        }
    }

    #[test]
    fn read_screen_requires_an_agent_and_defaults_lines_to_fifty() {
        let validate = |args: &Value| super::validate("read_screen", args, &V3_DEFINITIONS);
        let (_, arguments) = validate(&json!({ "agent": "a7" })).unwrap();
        assert_eq!(arguments["lines"], 50);
        for lines in [1, 2000] {
            let (_, arguments) = validate(&json!({ "agent": "a7", "lines": lines })).unwrap();
            assert_eq!(arguments["lines"], lines);
        }
        for (given, message) in [
            (
                json!({ "lines": 50 }),
                "read_screen requires agent; nothing was done",
            ),
            (
                json!({ "agent": "a7", "lines": 0 }),
                "lines must be from 1 to 2000, not 0; nothing was done",
            ),
            (
                json!({ "agent": "a7", "lines": 2001 }),
                "lines must be from 1 to 2000, not 2001; nothing was done",
            ),
        ] {
            let Err(failure) = validate(&given) else {
                panic!("accepted invalid read_screen arguments: {given}");
            };
            assert_eq!(failure["reason"], "invalid_argument");
            assert_eq!(failure["message"], message);
        }
    }
}
