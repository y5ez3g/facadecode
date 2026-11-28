//! The MCP server the daemon runs behind each relay. A relay, `facade-mcp`, opens with a hello that
//! says what its MCP client gave its process: its words, its environment and its folder. After it,
//! every line is an MCP JSON-RPC message, answered here. Each tool call acts for the actor the daemon
//! verified for the relay's connection, using the daemon's operation admission and dispatch.

mod addresses;
mod agent_tools;
mod daemon_calls;
mod envelope;
mod in_flight;
mod inbox_page;
mod lines;
mod message_tools;
mod replies;
mod result_files;
mod schema;
mod terminal_tools;
pub(crate) mod verified;
mod verified_tools;

use std::collections::BTreeMap;
use std::future::poll_fn;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::task::Poll;
use std::time::Instant;

use crate::delivery::SendOrder;
use crate::lifecycle::RelayLink;
use crate::server::Outbox;
use facade_base::jsonrpc::decode_arguments;
use facade_base::model::error::{ErrorBody, Reason};
use serde::Deserialize;
use serde_json::{Map, Value};

pub(crate) use inbox_page::project_inbox;
pub(crate) use replies::{InboxAnswer, InboxOutput};
pub(crate) use result_files::{clean_results, results_folder};
pub(crate) use verified::{ActorIdentity, ActorServices, DiscoverClis, ReadReply};

pub(crate) type PresenceLease = Box<dyn Send + Sync>;

/// Grants a prepared lease while the relay is open. Preparation does any verification and I/O.
pub(crate) type AcquirePresence = Box<dyn FnOnce() -> Option<PresenceLease> + Send>;

pub(crate) struct Initialization {
    pub(crate) instructions: Option<String>,
    pub(crate) acquire: Option<AcquirePresence>,
}

#[derive(Clone, Copy)]
pub(crate) enum CatalogEvent {
    Listed,
    Reconnect,
}

/// The version of the relay contract this daemon speaks, as a relay's hello names it.
pub(crate) const RELAY_CONTRACT: u32 = 1;

/// The response to a line whose answering failed unexpectedly.
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
            return Err(ErrorBody::new(Reason::IncompatibleProtocol, message));
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

    /// Whether this stdio relay has already opened a daemon connection.
    pub(crate) fn reconnect(&self) -> bool {
        self.reconnect
    }
}

/// One relay connection, shared by the tasks that answer its lines.
pub(crate) struct Relay {
    hello: RelayHelloParams,
    /// The relay's process and when it started: together they name its calls at every daemon.
    pid: u32,
    birth: String,
    /// The actor its calls act for, and the daemon services that verify and reach it.
    verified: verified::Verified,
    /// Request IDs not yet answered. Message calls can receive cancellations.
    requests: in_flight::Requests,
    send_order: Arc<SendOrder>,
    /// The leases held by the open transport. Closing takes the entire value.
    presence: Mutex<Option<Presence>>,
}

#[derive(Default)]
struct Presence {
    initialized: Option<PresenceLease>,
    listed: Option<PresenceLease>,
    catalog_seen: bool,
}

enum PresenceStage {
    Initialized,
    Listed,
    Authenticated,
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
            requests: in_flight::Requests::default(),
            send_order: Arc::default(),
            presence: Mutex::new(Some(Presence::default())),
        }
    }

    pub(crate) fn with_actor_queries(
        mut self,
        read_reply: ReadReply,
        discover_clis: DiscoverClis,
    ) -> Self {
        self.verified.read_reply = Some(read_reply);
        self.verified.discover_clis = Some(discover_clis);
        self
    }

    /// Whether the relay connected to a daemon before.
    pub(crate) fn reconnect(&self) -> bool {
        self.hello.reconnect()
    }

    /// Reads a line and applies any cancellation before the next line is taken.
    pub(crate) fn take(
        self: &Arc<Self>,
        line: &[u8],
        arrived: Instant,
        outbox: Outbox,
        link: Arc<RelayLink>,
    ) -> Option<crate::server::RelayResponse> {
        let request = lines::prepare(self, line, arrived)?;
        let id = request.id();
        let relay = self.clone();
        Some(Box::pin(async move {
            let response = {
                let responding = lines::respond(&relay, request, Some((outbox, link)));
                tokio::pin!(responding);
                poll_fn(|cx| {
                    match catch_unwind(AssertUnwindSafe(|| responding.as_mut().poll(cx))) {
                        Ok(polled) => polled.map(Ok),
                        Err(panic) => Poll::Ready(Err(panic)),
                    }
                })
                .await
            };
            match response {
                Ok(answer) => answer.map(lines::Response::into_line),
                Err(_) => Some(lines::internal_error(id)),
            }
        }))
    }

    pub(crate) async fn settle_cancelled(&self) {
        self.requests.settle_cancelled().await;
    }

    #[cfg(test)]
    fn respond_verified(&self, line: &[u8], arrived: Instant) -> Option<Value> {
        let request = lines::prepare(self, line, arrived)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let reply = runtime.block_on(lines::respond(self, request, None))?;
        Some(serde_json::from_slice(&reply.into_line()).unwrap())
    }

    /// Holds verified catalog presence until the relay's connection ends.
    pub(crate) async fn hold_verified_presence(&self, event: CatalogEvent, meta: Option<&Value>) {
        {
            let mut presence = self.presence.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(open) = presence.as_mut() else {
                return;
            };
            if matches!(event, CatalogEvent::Listed) {
                open.catalog_seen = true;
            }
            if open.listed.is_some() {
                return;
            }
        }
        if let Some(acquire) = self.verified.prepare_presence(self, event, meta).await {
            self.acquire_presence(PresenceStage::Listed, acquire);
        }
    }

    fn acquire_presence(&self, stage: PresenceStage, acquire: AcquirePresence) {
        let mut presence = self.presence.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(open) = presence.as_mut() else {
            return;
        };
        let held = match stage {
            PresenceStage::Initialized => &mut open.initialized,
            PresenceStage::Listed => &mut open.listed,
            // A client can keep its catalog across a daemon change. Only the first verified
            // call after reconnect can renew that presence when the hello had no session proof.
            PresenceStage::Authenticated if open.catalog_seen || self.reconnect() => {
                &mut open.listed
            }
            PresenceStage::Authenticated => return,
        };
        if held.is_none() {
            *held = acquire();
        }
    }

    /// Prevents further acquisition and releases both leases outside the lock.
    pub(crate) fn close_presence(&self) {
        let held = self
            .presence
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(held);
    }
}

/// The tools in catalog order, each bound to its action by the definition's name.
static TOOLS: LazyLock<Vec<ToolEntry>> = LazyLock::new(|| {
    let definitions: Vec<Value> = serde_json::from_str(facade_base::tools::DEFINITIONS)
        .expect("the tool definitions are JSON");
    definitions
        .into_iter()
        .map(|definition| ToolEntry {
            action: Tool::deserialize(&definition["name"]).expect("the tool has a known action"),
            definition,
        })
        .collect()
});

struct ToolEntry {
    action: Tool,
    definition: Value,
}

impl ToolEntry {
    fn named(name: &str) -> Option<&'static Self> {
        TOOLS.iter().find(|entry| entry.definition["name"] == name)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
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
    /// Owns its in-flight ID and its cancellation signal, where it has one.
    registration: Option<in_flight::Registration>,
    /// When its line arrived. Tool deadlines start here.
    arrived: Instant,
    replay: lines::Replay,
    /// The request ID it goes to the daemon with, where the model gives none: the relay's process
    /// and the call's ID, the same at every daemon, so that a call the relay gives the next daemon
    /// repeats what the first did.
    request_id: String,
    output: Option<replies::ReplyTarget>,
}

impl ToolCall {
    fn of(relay: &Relay, id: &Value, arrived: Instant, replay: lines::Replay) -> ToolCall {
        let key = id.to_string();
        ToolCall {
            id: id.as_str().map_or_else(|| key.clone(), str::to_string),
            request_id: format!("facade-{}-{}-{key}", relay.pid, relay.birth),
            registration: None,
            arrived,
            replay,
            output: None,
        }
    }

    fn cancellation(&self) -> crate::Cancel {
        self.registration.as_ref().map_or_else(
            crate::Cancel::default,
            in_flight::Registration::cancellation,
        )
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
fn validate(name: &str, given: &Value) -> Result<(Tool, Map<String, Value>), Value> {
    let Some(entry) = ToolEntry::named(name) else {
        let names: Vec<&str> = TOOLS
            .iter()
            .filter_map(|entry| entry.definition["name"].as_str())
            .collect();
        let message = format!("no tool {name}; the tools are {}", names.join(", "));
        return Err(envelope::failure("unsupported", message));
    };
    let mut problems = Problems::default();
    let arguments =
        schema::read_arguments(name, &entry.definition["inputSchema"], given, &mut problems);
    entry.action.check(&arguments, &mut problems);
    if let Some(failure) = problems.into_failure(name) {
        return Err(failure);
    }
    Ok((entry.action, arguments))
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
            authenticate: Box::new(|_, _, _| {
                Box::pin(async { Err(ErrorBody::internal("unit tests have no daemon")) })
            }),
            call: Box::new(|_, _, _, _| Box::pin(async { panic!("unit tests have no daemon") })),
            read_inbox: Box::new(|_, _, _, _| {
                Box::pin(async { Err(ErrorBody::internal("unit tests have no daemon")) })
            }),
            managed_instructions: Box::new(|_, _| {
                Box::pin(async {
                    Ok(Initialization {
                        instructions: None,
                        acquire: None,
                    })
                })
            }),
            ready: Box::new(|_, _, _| {
                Box::pin(async { anyhow::bail!("unit tests have no daemon") })
            }),
        };
        Relay::of_verified(hello, 7, "1".to_string(), services)
    }
}

#[cfg(test)]
mod tests {
    use facade_base::api_v1::daemon::{ClientKind, decode_hello};
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn a_later_verified_actor_can_hold_tools_after_the_relay_serves_its_catalog() {
        let mut relay = Relay::for_test();
        relay.verified.services.ready = Box::new(|_, _, _| Box::pin(async { Ok(None) }));
        let lease = Arc::new(());
        let acquire = || {
            let lease = lease.clone();
            Box::new(move || -> Option<PresenceLease> { Some(Box::new(lease)) })
        };
        relay.acquire_presence(PresenceStage::Authenticated, acquire());
        assert_eq!(Arc::strong_count(&lease), 1);

        relay
            .hold_verified_presence(CatalogEvent::Listed, None)
            .await;
        relay.acquire_presence(PresenceStage::Authenticated, acquire());
        relay.acquire_presence(PresenceStage::Authenticated, acquire());
        assert_eq!(Arc::strong_count(&lease), 2);

        relay.close_presence();
        relay.acquire_presence(PresenceStage::Authenticated, acquire());
        assert_eq!(Arc::strong_count(&lease), 1);
    }

    #[tokio::test]
    async fn a_verified_call_renews_catalog_presence_after_reconnect() {
        let mut relay = Relay::for_test();
        relay.hello.reconnect = true;
        relay.verified.services.ready = Box::new(|_, _, _| Box::pin(async { Ok(None) }));
        let lease = Arc::new(());
        relay
            .hold_verified_presence(CatalogEvent::Reconnect, None)
            .await;
        assert_eq!(Arc::strong_count(&lease), 1);

        let proof = lease.clone();
        relay.acquire_presence(
            PresenceStage::Authenticated,
            Box::new(move || Some(Box::new(proof))),
        );
        assert_eq!(Arc::strong_count(&lease), 2);
        relay.close_presence();
        assert_eq!(Arc::strong_count(&lease), 1);
    }

    #[test]
    fn relay_v1_frames_are_separate_from_the_mcp_client_identity() {
        let mut frames = include_str!("../../../relay/tests/fixtures/relay-hello.jsonl").lines();
        for (cwd, reconnect) in [(Some("/work folder"), false), (None, true)] {
            let request: Value = serde_json::from_str(frames.next().unwrap()).unwrap();
            assert_eq!(request["jsonrpc"], "2.0");
            assert_eq!(request["id"], 1);
            assert_eq!(request["method"], "hello");
            let params = &request["params"];
            assert!(crate::server::is_relay_hello(params));

            let hello = RelayHelloParams::decode(params.clone()).unwrap();
            assert_eq!(hello.relay, RELAY_CONTRACT);
            assert_eq!(hello.args, ["--guest", "codex"]);
            assert_eq!(
                hello.env.get("FACADE_TEST_VALUE").map(String::as_str),
                Some("line\n\"quoted\" ☃")
            );
            assert_eq!(hello.cwd.as_deref(), cwd);
            assert_eq!(hello.reconnect, reconnect);

            let mut with_kind = params.clone();
            with_kind["kind"] = json!("mcp");
            assert!(
                RelayHelloParams::decode(with_kind)
                    .is_err_and(|error| error.data.reason == Reason::InvalidArgument)
            );
        }
        assert!(frames.next().is_none());

        let ordinary = json!({
            "api_versions": [1], "build": "test", "kind": "mcp",
        });
        assert!(!crate::server::is_relay_hello(&ordinary));
        let hello = decode_hello(ordinary).unwrap();
        assert_eq!(hello.kind, ClientKind::Mcp);
    }

    #[test]
    fn the_tools_are_the_eight_in_their_order() {
        let names: Vec<&str> = TOOLS
            .iter()
            .filter_map(|entry| entry.definition["name"].as_str())
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
        let validate = |args: &Value| super::validate("start_agent", args);
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
        let validate = |args: &Value| super::validate("read_screen", args);
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
