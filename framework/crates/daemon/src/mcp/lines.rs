//! Decodes each MCP line, records its cancellation at ingress, and answers the request.

use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize, de::IgnoredAny};
use serde_json::{Value, json, value::RawValue};

use super::replies::{ReplyTarget, tool_result};
use super::{
    CatalogEvent, Initialization, PresenceStage, Relay, TOOLS, Tool, ToolCall, ToolEntry,
    verified_tools,
};
use crate::delivery::SendTurn;
use crate::lifecycle::RelayLink;
use crate::server::Outbox;

/// The MCP versions this server speaks, newest first.
const MCP_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
const CANCELLED: i64 = -32800;
const CANCELLED_MESSAGE: &str = "the client cancelled this call; nothing was sent";

#[derive(Deserialize)]
struct McpLine {
    #[serde(default, deserialize_with = "present_id")]
    id: Option<Box<RawValue>>,
    #[serde(default)]
    method: Value,
    #[serde(default)]
    params: Value,
    #[serde(default, deserialize_with = "present")]
    result: bool,
    #[serde(default, deserialize_with = "present")]
    error: bool,
}

fn present_id<'de, D: Deserializer<'de>>(input: D) -> Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(input).map(Some)
}

fn present<'de, D: Deserializer<'de>>(input: D) -> Result<bool, D::Error> {
    IgnoredAny::deserialize(input).map(|_| true)
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Replay {
    #[default]
    First,
    Planned,
    Interrupted,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayRequest {
    first_line_ns: u64,
    replay: Replay,
    cancelled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayFrame {
    relay_request: RelayRequest,
    request: McpLine,
}

impl RelayRequest {
    fn first_arrival(&self, local_arrival: Instant) -> Instant {
        let age = Duration::from_nanos(
            facade_base::unix_process::monotonic_now().saturating_sub(self.first_line_ns),
        );
        Instant::now()
            .checked_sub(age)
            .unwrap_or(local_arrival)
            .min(local_arrival)
    }
}

#[derive(Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Serialize)]
pub(super) struct Response {
    jsonrpc: &'static str,
    /// The exact ID token accepted from the client. Old relays compare its spelling.
    id: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

impl Response {
    pub(super) fn ok(id: Box<RawValue>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<Box<RawValue>>, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }

    pub(super) fn into_line(self) -> Vec<u8> {
        let mut line = serde_json::to_vec(&self).expect("an MCP response serializes");
        line.push(b'\n');
        line
    }
}

pub(super) fn internal_error(id: Option<Box<RawValue>>) -> Vec<u8> {
    Response::error(
        id,
        INTERNAL_ERROR,
        "internal error: facade-mcp could not answer this request",
    )
    .into_line()
}

pub(super) enum Prepared {
    Answer(Response),
    Request {
        id: Box<RawValue>,
        method: String,
        params: Value,
        call: ToolCall,
        send_turn: Option<SendTurn>,
    },
}

impl Prepared {
    pub(super) fn id(&self) -> Option<Box<RawValue>> {
        match self {
            Self::Answer(reply) => reply.id.clone(),
            Self::Request { id, .. } => Some(id.clone()),
        }
    }
}

/// Read the line once, noting the waiting calls and their cancellations before scheduling work.
pub(super) fn prepare(relay: &Relay, line: &[u8], arrived: Instant) -> Option<Prepared> {
    let invalid =
        |code, message: String| Some(Prepared::Answer(Response::error(None, code, message)));
    let line = line.trim_ascii();
    let (parsed, context) = if line.starts_with(br#"{"relay_request":"#) {
        let frame: RelayFrame = match serde_json::from_slice(line) {
            Ok(frame) => frame,
            Err(error) => return invalid(PARSE_ERROR, format!("not a relay request: {error}")),
        };
        (frame.request, Some(frame.relay_request))
    } else if line.first() == Some(&b'{') {
        match serde_json::from_slice(line) {
            Ok(request) => (request, None),
            Err(error) => return invalid(PARSE_ERROR, format!("not JSON: {error}")),
        }
    } else {
        match serde_json::from_slice::<Value>(line) {
            Ok(Value::Array(batch)) => {
                for entry in batch {
                    if entry.get("id").is_none()
                        && entry["method"].as_str() == Some("notifications/cancelled")
                    {
                        cancel(relay, &entry["params"]);
                    }
                }
                return invalid(
                    INVALID_REQUEST,
                    "batches are not supported; send one request per line".into(),
                );
            }
            Ok(_) => return invalid(INVALID_REQUEST, "not a JSON-RPC message".into()),
            Err(error) => return invalid(PARSE_ERROR, format!("not JSON: {error}")),
        }
    };

    let method = parsed.method.as_str();
    let id_value = parsed.id.as_ref().and_then(|token| {
        serde_json::from_str::<Value>(token.get())
            .ok()
            .filter(is_id)
    });
    let Some(method) = method else {
        if parsed.result || parsed.error {
            return None;
        }
        let id = parsed.id.filter(|_| id_value.is_some());
        return Some(Prepared::Answer(Response::error(
            id,
            INVALID_REQUEST,
            "the request names no method",
        )));
    };
    let Some(id) = parsed.id else {
        if method == "notifications/cancelled" {
            cancel(relay, &parsed.params);
        }
        return None;
    };
    let Some(id_value) = id_value else {
        return invalid(
            INVALID_REQUEST,
            "the request's id is neither a string nor a number".into(),
        );
    };
    let replay = context.as_ref().map_or(Replay::First, |frame| frame.replay);
    let arrived = context
        .as_ref()
        .map_or(arrived, |frame| frame.first_arrival(arrived));
    let action = (method == "tools/call")
        .then(|| parsed.params["name"].as_str())
        .flatten()
        .and_then(ToolEntry::named)
        .map(|tool| tool.action);
    let cancelled = matches!(action, Some(Tool::SendMessage | Tool::ReadMessages))
        .then(|| context.is_some_and(|frame| frame.cancelled));
    let Some(registration) = relay.requests.register(id_value.to_string(), cancelled) else {
        return invalid(
            INVALID_REQUEST,
            "a request with this ID is still in flight".into(),
        );
    };
    let mut call = ToolCall::of(relay, &id_value, arrived, replay);
    call.registration = Some(registration);
    let send_turn = matches!(action, Some(Tool::SendMessage)).then(|| relay.send_order.next());
    Some(Prepared::Request {
        id,
        method: method.to_string(),
        params: parsed.params,
        call,
        send_turn,
    })
}

fn is_id(id: &Value) -> bool {
    id.is_string() || id.is_number()
}

fn cancel(relay: &Relay, params: &Value) {
    if let Some(id) = params.get("requestId") {
        relay.requests.cancel(&id.to_string());
    }
}

/// A JSON-RPC error's code and message.
type Refused = (i64, String);

pub(super) async fn respond(
    relay: &Relay,
    request: Prepared,
    output: Option<(Outbox, std::sync::Arc<RelayLink>)>,
) -> Option<Response> {
    let (id, method, params, mut call, send_turn) = match request {
        Prepared::Answer(reply) => return Some(reply),
        Prepared::Request {
            id,
            method,
            params,
            call,
            send_turn,
        } => (id, method, params, call, send_turn),
    };
    let answer = match method.as_str() {
        "initialize" => initialize(relay, &params).await,
        "ping" => Ok(json!({})),
        "tools/list" => Ok(list_tools(relay, params.get("_meta")).await),
        "tools/call" => {
            call.output = output.map(|(outbox, link)| ReplyTarget::new(outbox, link, id.clone()));
            call_tool(relay, params, &call, send_turn).await?
        }
        method => Err((METHOD_NOT_FOUND, format!("no method {method}"))),
    };
    Some(match answer {
        Ok(result) => Response::ok(id, result),
        Err((code, message)) => Response::error(Some(id), code, message),
    })
}

async fn initialize(relay: &Relay, params: &Value) -> Result<Value, Refused> {
    let asked = params["protocolVersion"].as_str();
    let version = MCP_VERSIONS
        .into_iter()
        .find(|known| Some(*known) == asked)
        .unwrap_or(MCP_VERSIONS[0]);
    let Initialization {
        instructions,
        acquire,
    } = relay
        .verified
        .initialize(
            relay,
            params["clientInfo"]["name"].as_str(),
            params.get("_meta"),
        )
        .await
        .map_err(|_| {
            (
                INTERNAL_ERROR,
                "could not load the managed run's instructions".into(),
            )
        })?;
    let instructions = instructions.unwrap_or_else(facade_base::instructions::for_connection);
    let reply = json!({
        "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "facade", "version": facade_base::VERSION },
        "instructions": instructions,
    });
    if let Some(acquire) = acquire {
        relay.acquire_presence(PresenceStage::Initialized, acquire);
    }
    Ok(reply)
}

/// The answer to `tools/list`: the shipped definitions. Every tool returns the same envelope
/// (MCP-1.2), so the catalog omits result schemas.
async fn list_tools(relay: &Relay, meta: Option<&Value>) -> Value {
    crate::gate_for_test("mcp-before-tools-list");
    let tools: Vec<&Value> = TOOLS.iter().map(|entry| &entry.definition).collect();
    let catalog = json!({ "tools": tools });
    relay
        .hold_verified_presence(CatalogEvent::Listed, meta)
        .await;
    catalog
}

async fn call_tool(
    relay: &Relay,
    params: Value,
    call: &ToolCall,
    send_turn: Option<SendTurn>,
) -> Option<Result<Value, Refused>> {
    let Value::Object(mut params) = params else {
        return Some(Err((
            INVALID_PARAMS,
            "tools/call needs an arguments object".into(),
        )));
    };
    let Some(Value::String(name)) = params.shift_remove("name") else {
        let why = "tools/call names its tool with a string name";
        return Some(Err((INVALID_PARAMS, why.to_string())));
    };
    let given = params.shift_remove("arguments").unwrap_or(Value::Null);
    let meta = params.shift_remove("_meta");
    drop(params);
    let result = verified_tools::dispatch(relay, &name, given, call, meta, send_turn).await;
    let result = match result {
        verified_tools::ToolReply::Result(result) => result,
        verified_tools::ToolReply::Answered => return None,
        verified_tools::ToolReply::Cancelled => {
            let message = if name == "read_messages" {
                "the client cancelled this call"
            } else {
                CANCELLED_MESSAGE
            };
            return Some(Err((CANCELLED, message.to_string())));
        }
    };
    if result["reason"] == "upgrading"
        && call
            .output
            .as_ref()
            .is_some_and(|output| output.link.is_sealed())
    {
        // Only the relay can reach the next daemon. Leave this request in its pending list.
        return None;
    }
    Some(Ok(tool_result(result)))
}

#[cfg(test)]
mod tests {
    use facade_base::api_v1::daemon::AgentKind;
    use facade_base::model::agent::AgentRef;

    use super::super::{ActorIdentity, verified::AuthenticatedActor};
    use super::*;

    fn answered(line: &str) -> Value {
        Relay::for_test()
            .respond_verified(line.as_bytes(), Instant::now())
            .expect("an answer")
    }

    /// A relay whose actor is verified, so that its calls get as far as their arguments, and whose
    /// tools must not reach the daemon.
    fn rejecting_relay(receives_terminal_messages: bool) -> Relay {
        let mut relay = Relay::for_test();
        let services = &mut relay.verified.services;
        services.authenticate = Box::new(move |_, _, _| {
            Box::pin(async move {
                Ok(AuthenticatedActor {
                    identity: ActorIdentity {
                        reference: AgentRef {
                            machine_id: "00000000-0000-4000-8000-000000000001".into(),
                            agent_id: "a7".into(),
                        },
                        kind: AgentKind::Managed,
                        receives_terminal_messages,
                    },
                    acquire: None,
                })
            })
        });
        services.call =
            Box::new(|_, _, _, _| panic!("a rejected tool call must not reach the daemon"));
        relay
    }

    #[test]
    fn a_timed_read_is_refused_only_with_terminal_message_delivery() {
        let request = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_messages","arguments":{"timeout_seconds":1}}}"#;
        let arrived = Instant::now() - std::time::Duration::from_secs(2);
        for (terminal_delivery, expected) in [(true, "unsupported"), (false, "timeout")] {
            let answer = rejecting_relay(terminal_delivery)
                .respond_verified(request, arrived)
                .expect("a tool answer");
            assert_eq!(answer["result"]["structuredContent"]["reason"], expected);
        }
    }

    #[test]
    fn initialize_answers_the_version_asked_for_or_the_newest() {
        let answer = answered(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}"#,
        );
        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(
            answer["result"]["capabilities"],
            json!({ "tools": { "listChanged": false } })
        );
        assert_eq!(answer["result"]["serverInfo"]["name"], "facade");
        assert_eq!(
            answer["result"]["instructions"],
            facade_base::instructions::for_connection()
        );
        let newest = answered(
            r#"{"jsonrpc":"2.0","id":"x","method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#,
        );
        assert_eq!(
            (
                newest["id"].as_str(),
                newest["result"]["protocolVersion"].as_str()
            ),
            (Some("x"), Some("2025-11-25"))
        );
        assert_eq!(
            answered(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)["result"],
            json!({})
        );
    }

    /// Tool discovery serves the shipped catalog as is.
    #[test]
    fn the_tool_list_matches_the_shipped_catalog() {
        let answer = answered(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let shipped: Value = serde_json::from_str(facade_base::tools::DEFINITIONS).unwrap();
        assert_eq!(answer["result"]["tools"], shipped);
    }

    #[test]
    fn tools_list_gives_each_tool_its_input_schema_and_no_result_schema() {
        let tools =
            answered(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)["result"]["tools"]
                .clone();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
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
        for tool in tools.as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool.get("outputSchema").is_none(), "{tool}");
            assert!(tool.get("_meta").is_none(), "{tool}");
        }
    }

    /// A tool call's result is the envelope twice: as the text the model reads and as structured
    /// content.
    #[test]
    fn a_tool_result_is_its_envelope_as_text_and_as_structured_content() {
        let relay = rejecting_relay(true);
        let answer = relay
            .respond_verified(
                br##"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"#a2"}}}"##,
                Instant::now(),
            )
            .expect("an answer");
        let result = &answer["result"];
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["reason"], "invalid_argument");
        assert_eq!(
            serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
            result["structuredContent"]
        );
        let no_name = answered(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}"#);
        assert_eq!(no_name["error"]["code"], -32602);

        let rejected = relay
            .respond_verified(
                br##"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_messages","arguments":{"after":"#m4","last":2}}}"##,
                Instant::now(),
            )
            .expect("an answer");
        assert_eq!(rejected["result"]["isError"], true);
        assert_eq!(
            rejected["result"]["structuredContent"],
            json!({
                "status": "failure",
                "reason": "invalid_argument",
                "message": "give after or last, not both; nothing was done",
            })
        );
    }

    #[test]
    fn read_screen_refuses_last_before_connecting_to_the_daemon() {
        let relay = rejecting_relay(true);
        for arguments in [
            json!({ "agent": "#a7", "last": 4 }),
            json!({ "agent": "#a7", "last": 4, "lines": 4 }),
        ] {
            let call = json!({
                "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": { "name": "read_screen", "arguments": arguments },
            });
            let answer = relay
                .respond_verified(call.to_string().as_bytes(), Instant::now())
                .expect("an answer");
            assert_eq!(answer["result"]["isError"], true);
            assert_eq!(
                answer["result"]["structuredContent"],
                json!({
                    "status": "failure",
                    "reason": "invalid_argument",
                    "message": "unknown argument 'last' for read_screen. Use 'lines'; nothing was done",
                })
            );
        }
    }

    #[test]
    fn every_native_managed_call_requires_its_session_evidence() {
        let mut relay = rejecting_relay(true);
        relay.verified.services.authenticate = Box::new(|_, meta, _| {
            Box::pin(async move {
                if meta.and_then(|value| value["nativeSession"].as_str()) != Some("own-session") {
                    return Err(facade_base::model::error::ErrorBody::refused(
                        "this request does not match the relay's managed session",
                    ));
                }
                Ok(AuthenticatedActor {
                    identity: ActorIdentity {
                        reference: AgentRef {
                            machine_id: "00000000-0000-4000-8000-000000000001".into(),
                            agent_id: "a7".into(),
                        },
                        kind: AgentKind::Managed,
                        receives_terminal_messages: true,
                    },
                    acquire: None,
                })
            })
        });
        for (id, meta, reason) in [
            (1, json!({ "nativeSession": "own-session" }), "unsupported"),
            (2, json!({ "nativeSession": "other-session" }), "refused"),
            (3, Value::Null, "refused"),
            (4, json!({ "nativeSession": "own-session" }), "unsupported"),
        ] {
            let mut params = json!({
                "name": "read_messages", "arguments": { "timeout_seconds": 1 },
            });
            if !meta.is_null() {
                params["_meta"] = meta;
            }
            let line = json!({
                "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params,
            });
            let answer = relay
                .respond_verified(line.to_string().as_bytes(), Instant::now())
                .expect("a tool answer");
            assert_eq!(answer["result"]["structuredContent"]["reason"], reason);
        }
    }

    #[test]
    fn malformed_messages_get_json_rpc_errors_and_notifications_nothing() {
        assert_eq!(answered("{nope")["error"]["code"], -32700);
        assert_eq!(answered("[]")["error"]["code"], -32600);
        assert_eq!(answered("7")["error"]["code"], -32600);
        assert_eq!(
            answered(r#"{"jsonrpc":"2.0","id":5}"#)["error"],
            json!({ "code": -32600, "message": "the request names no method" })
        );
        assert_eq!(answered(r#"{"jsonrpc":"2.0","id":5}"#)["id"], 5);
        assert_eq!(
            answered(r#"{"jsonrpc":"2.0","id":[1],"method":"ping"}"#)["error"]["code"],
            -32600
        );
        assert_eq!(
            answered(r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#)["error"],
            json!({ "code": -32601, "message": "no method resources/list" })
        );
        assert!(
            Relay::for_test()
                .respond_verified(
                    br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                    Instant::now(),
                )
                .is_none()
        );
        assert!(
            Relay::for_test()
                .respond_verified(br#"{"jsonrpc":"2.0","id":9,"result":{}}"#, Instant::now())
                .is_none(),
            "a response to nothing asks for nothing"
        );
    }

    #[test]
    fn replies_keep_the_spelling_of_valid_ids_for_a_v1_relay() {
        let relay = Relay::for_test();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (id, method) in [(r#""\u0070age""#, "ping"), ("1.5e2", "no-method")] {
            let request = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}"}}"#);
            let request = prepare(&relay, request.as_bytes(), Instant::now()).unwrap();
            let line = runtime
                .block_on(respond(&relay, request, None))
                .unwrap()
                .into_line();
            assert!(
                std::str::from_utf8(&line)
                    .unwrap()
                    .contains(&format!(r#""id":{id},"#))
            );
        }
    }

    /// MCP took batches out: a batch is refused, whatever it holds.
    #[test]
    fn a_batch_is_refused() {
        let batch = answered(
            r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#,
        );
        assert_eq!(
            batch["error"],
            json!({ "code": -32600, "message": "batches are not supported; send one request per line" })
        );
    }

    /// The reader notes each send_message call as it reads it, and cancels the call a cancellation
    /// names at once, taking the cancellation itself, alone or in a batch; a call already answered,
    /// and any other, are left as they are.
    #[test]
    fn the_reader_notes_send_calls_and_cancels_the_one_a_cancellation_names() {
        let relay = Relay::for_test();
        let notice = |line: String| prepare(&relay, line.as_bytes(), Instant::now()).is_none();
        let call = |id: &str, tool: &str| {
            format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{tool}","arguments":{{}}}}}}"#
            )
        };
        let cancel = |id: &str| {
            format!(
                r#"{{"jsonrpc":"2.0","method":"notifications/cancelled","params":{{"requestId":{id},"reason":"user-cancel"}}}}"#
            )
        };
        let request =
            |id, tool| prepare(&relay, call(id, tool).as_bytes(), Instant::now()).unwrap();
        let first = request(r#""s1""#, "send_message");
        let second = request("71", "send_message");
        let listing = request("72", "list_agents");
        assert!(notice(cancel(r#""s1""#)), "a cancellation needs no thread");
        assert!(
            relay.requests.cancelled(r#""s1""#) && !relay.requests.cancelled("71"),
            "only the call it names"
        );
        assert!(
            !notice(format!("[{}]", cancel("71"))),
            "a batch is answered"
        );
        assert!(relay.requests.cancelled("71"));
        assert!(
            notice(cancel("72")) && !relay.requests.cancelled("72"),
            "another tool's call is not cancelled"
        );
        drop(first);
        assert!(
            notice(cancel(r#""s1""#)) && !relay.requests.cancelled(r#""s1""#),
            "an answered call stays answered"
        );
        drop((second, listing));
    }
    #[test]
    fn duplicate_requests_leave_the_original_registration_and_its_cancellation() {
        let relay = Relay::for_test();
        let original = br#"{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"read_messages","arguments":{}}}"#;
        let duplicate = br#"{"jsonrpc":"2.0","id":12,"method":"ping"}"#;
        let first = prepare(&relay, original, Instant::now()).unwrap();
        let mut replies = [
            prepare(&relay, duplicate, Instant::now()).unwrap(),
            prepare(&relay, original, Instant::now()).unwrap(),
        ];
        for reply in &mut replies {
            let Prepared::Answer(response) = reply else {
                panic!("duplicate request was registered");
            };
            assert!(response.id.is_none());
        }
        drop(replies);
        relay.requests.cancel("12");
        let Prepared::Request { call, .. } = &first else {
            panic!("the original request was not registered");
        };
        assert!(call.cancellation().is_requested());
        drop(first);
        let reused = prepare(&relay, duplicate, Instant::now()).unwrap();
        assert!(matches!(reused, Prepared::Request { .. }));
        assert!(!relay.requests.cancelled("12"));
    }

    #[test]
    fn an_unknown_tool_or_invalid_arguments_do_not_establish_an_actor() {
        let mut relay = Relay::for_test();
        relay.verified.services.authenticate =
            Box::new(|_, _, _| panic!("a malformed call cannot authenticate"));
        for (tool, arguments) in [
            ("unknown_tool", json!({})),
            ("send_message", json!({"text":"hello"})),
        ] {
            let request = json!({"jsonrpc":"2.0","id":8,"method":"tools/call", "params":{
                "name":tool, "arguments":arguments
            }});
            let response = relay
                .respond_verified(request.to_string().as_bytes(), Instant::now())
                .unwrap();
            assert_eq!(response["result"]["structuredContent"]["status"], "failure");
        }
    }
}
