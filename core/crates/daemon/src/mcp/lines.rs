//! MCP's JSON-RPC, one message per line: the handshake, `ping`, and the tools, `tools/list` and
//! `tools/call`, which the client can cancel with `notifications/cancelled`. MCP took batches out,
//! so a batch is refused.

use std::time::Instant;

use serde_json::{Value, json};

use super::tool_calls::{self, ToolCall};
use super::{Relay, Serves, guest_sessions, instructions};

/// The MCP versions this server speaks, newest first. It answers with the version the client asks
/// for, or else the newest.
const MCP_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
/// The error a cancelled call is answered with, as LSP names one: MCP names none.
const CANCELLED: i64 = -32800;
const CANCELLED_MESSAGE: &str = "the client cancelled this call; nothing was sent";

/// A JSON-RPC error response.
fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// The response to a line whose answering failed unexpectedly.
pub(super) fn internal_error() -> Value {
    let message = "internal error: facade-mcp could not answer this request";
    error(Value::Null, INTERNAL_ERROR, message)
}

/// What is done with a client's line as it is read, before it waits for a thread: each
/// `send_message` call is noted, so that a cancellation can name it, and the call a
/// `notifications/cancelled` names is cancelled. True where the line needs nothing more, as a
/// cancellation alone does. Other cancellations are ignored.
pub(super) fn notice(relay: &Relay, line: &[u8]) -> bool {
    match serde_json::from_slice::<Value>(line) {
        Ok(Value::Array(batch)) => {
            // A batch is answered with its refusal, but what it cancels is cancelled.
            for message in &batch {
                notice_message(relay, message);
            }
            false
        }
        Ok(message) => notice_message(relay, &message),
        Err(_) => false,
    }
}

fn notice_message(relay: &Relay, message: &Value) -> bool {
    match message["method"].as_str() {
        Some("tools/call") => {
            let id = message.get("id").filter(|id| is_id(id));
            if message["params"]["name"] == "send_message"
                && let Some(id) = id
            {
                relay.sends.note(id.to_string());
            }
            false
        }
        Some("notifications/cancelled") if message.get("id").is_none() => {
            if let Some(id) = message["params"].get("requestId") {
                relay.sends.cancel(&id.to_string());
            }
            true
        }
        _ => false,
    }
}

/// Whether `id` can be a JSON-RPC request's ID.
fn is_id(id: &Value) -> bool {
    id.is_string() || id.is_number()
}

/// The response to one line from the client, which arrived at `arrived`: none for a notification or
/// a response.
pub(super) fn respond(
    relay: &Relay,
    serves: &Serves,
    line: &[u8],
    arrived: Instant,
) -> Option<Value> {
    let message = match serde_json::from_slice::<Value>(line) {
        Ok(message) => message,
        Err(err) => return Some(error(Value::Null, PARSE_ERROR, format!("not JSON: {err}"))),
    };
    let Value::Object(message) = message else {
        let why = if message.is_array() {
            "batches are not supported; send one request per line"
        } else {
            "not a JSON-RPC message"
        };
        return Some(error(Value::Null, INVALID_REQUEST, why));
    };
    let id = message.get("id").filter(|id| is_id(id)).cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        if message.contains_key("result") || message.contains_key("error") {
            return None;
        }
        let id = id.unwrap_or(Value::Null);
        return Some(error(id, INVALID_REQUEST, "the request names no method"));
    };
    // A notification, such as `notifications/initialized`, asks for nothing.
    if !message.contains_key("id") {
        return None;
    }
    let Some(id) = id else {
        let why = "the request's id is neither a string nor a number";
        return Some(error(Value::Null, INVALID_REQUEST, why));
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    let acting_for = relay.acting_for(serves);
    let answered = match method {
        "initialize" => initialize(relay, &acting_for, params),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(list_tools(relay, &acting_for)),
        "tools/call" => call_tool(relay, &acting_for, &id, params, arrived),
        other => Err((METHOD_NOT_FOUND, format!("no method {other}"))),
    };
    Some(match answered {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error(id, code, message),
    })
}

/// A JSON-RPC error's code and message.
type Refused = (i64, String);

/// The answer to `initialize`: the version, the server, and what the model is told as it starts.
fn initialize(relay: &Relay, serves: &Serves, params: &Value) -> Result<Value, Refused> {
    let asked = params["protocolVersion"].as_str();
    let version = MCP_VERSIONS
        .into_iter()
        .find(|known| Some(*known) == asked)
        .unwrap_or(MCP_VERSIONS[0]);
    let client = params["clientInfo"]["name"].as_str();
    let told = instructions::at_start(relay, serves, client)
        .map_err(|error| (error.code, error.message))?;
    let mut result = json!({
        "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "facade", "version": facade_base::VERSION },
    });
    if let Some(told) = told {
        result["instructions"] = json!(told);
    }
    Ok(result)
}

/// The answer to `tools/list`. A server for no one lists none. Each tool is marked to be loaded
/// from the start, under the keys the CLIs' rules name, for the CLIs that otherwise load a server's
/// tools on demand behind a search. No tool lists a result schema: every result is the same
/// envelope (MCP-1.2), and a schema would cost every turn its bytes.
fn list_tools(relay: &Relay, serves: &Serves) -> Value {
    facade_base::service::gate_for_test("mcp-before-tools-list");
    // The client has the tools with this answer, so only now does the daemon learn they are there:
    // a start's prompt or a message it sends next finds them loaded. Unit tests have no daemon.
    if let Serves::Agent(agent) = serves
        && !cfg!(test)
    {
        relay.hold_presence(agent);
    }
    if let Serves::Nobody | Serves::Aside = serves {
        return json!({ "tools": [] });
    }
    let always_load: serde_json::Map<String, Value> = facade_rules::always_load_keys()
        .map(|key| (key.to_string(), Value::Bool(true)))
        .collect();
    let tools: Vec<Value> = tool_calls::definitions()
        .iter()
        .map(|definition| {
            let mut tool = definition.clone();
            tool["_meta"] = Value::Object(always_load.clone());
            tool
        })
        .collect();
    json!({ "tools": tools })
}

/// The answer to `tools/call`: the tool's envelope, as the text the model reads and as structured
/// content. A call its client cancelled, which wrote nothing or whose message Facade withdrew, is
/// answered too, so that every request has one answer and the relay holds no call open; MCP has its
/// client ignore it.
fn call_tool(
    relay: &Relay,
    serves: &Serves,
    id: &Value,
    params: &Value,
    arrived: Instant,
) -> Result<Value, Refused> {
    let Some(name) = params["name"].as_str() else {
        let why = "tools/call names its tool with a string name";
        return Err((INVALID_PARAMS, why.to_string()));
    };
    let call = ToolCall::of(relay, id, arrived);
    let arguments = &params["arguments"];
    let result = match serves {
        Serves::Agent(agent) | Serves::Member(agent) => {
            tool_calls::call(relay, agent, name, arguments, &call)
        }
        Serves::Guest(cli) => match guest_sessions::agent_for_call(relay, cli, &params["_meta"]) {
            Ok(agent) => tool_calls::call(relay, &agent, name, arguments, &call),
            Err(failure) => Some(failure),
        },
        Serves::Nobody => Some(tool_calls::unconfigured()),
        Serves::Aside => Some(tool_calls::aside()),
    };
    relay.sends.finish(&call.key);
    let Some(result) = result else {
        return Err((CANCELLED, CANCELLED_MESSAGE.to_string()));
    };
    Ok(json!({
        "content": [{ "type": "text", "text": result.to_string() }],
        "isError": result["status"] == "failure", "structuredContent": result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(line: &str) -> Value {
        respond(
            &Relay::for_test(&[], &[]),
            &Serves::Agent("a7".into()),
            line.as_bytes(),
            Instant::now(),
        )
        .expect("an answer")
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
        assert!(
            answer["result"]["instructions"]
                .as_str()
                .unwrap()
                .starts_with("You are Facade agent #a7.")
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

    /// A server for no one, before a member joins, lists no tools, and a call does nothing.
    #[test]
    fn a_server_without_its_agent_serves_no_tools() {
        let unconfigured = |line: &str| {
            respond(
                &Relay::for_test(&[], &[]),
                &Serves::Nobody,
                line.as_bytes(),
                Instant::now(),
            )
            .expect("an answer")
        };
        assert_eq!(
            unconfigured(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)["result"],
            json!({ "tools": [] })
        );
        let called = unconfigured(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}"#,
        );
        assert_eq!(
            called["result"]["structuredContent"]["reason"], "configuration_invalid",
            "{called}"
        );
    }

    /// What every turn of every agent pays for stays within its budget: the instructions, which
    /// tell a CLI that lists tools by name alone to load one before calling it, and the tool list.
    #[test]
    fn the_instructions_and_the_tool_list_stay_within_their_budget() {
        let instructions = answered(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        )["result"]["instructions"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            instructions.ends_with(
                "If your tools are listed by name alone, load the one you need before calling it."
            ),
            "{instructions}"
        );
        let listed =
            answered(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)["result"].to_string();
        assert!(
            instructions.len() <= 1_200,
            "the instructions are {} bytes",
            instructions.len()
        );
        assert!(
            listed.len() <= 8_000,
            "the tool list is {} bytes",
            listed.len()
        );
        let skill = facade_base::skill::text();
        assert!(skill.len() <= 3_000, "the skill is {} bytes", skill.len());
    }

    /// The skill gives cross-tool examples and reference alone (MCP-6.2): no sentence of the
    /// initialization, an agent's with and without its place or a guest's of either kind, of a
    /// tool's description or of an argument's is in it.
    #[test]
    fn the_skill_repeats_no_sentence_of_the_instructions_or_the_tools() {
        let skill = facade_base::skill::text();
        let listed =
            answered(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)["result"]["tools"]
                .clone();
        use facade_base::instructions::{Place, Run, for_agent, for_guest};
        let place = || Place {
            window: Some(("app (Workspace)", "win-2")),
            location_id: "loc-7",
            folder: "/work/app",
        };
        let (on, off) = (
            Run {
                place: place(),
                creator: Some(("a2", Some("Ada"))),
                yolo: true,
            },
            Run {
                place: place(),
                creator: None,
                yolo: false,
            },
        );
        let mut texts = vec![
            for_agent("a3", None),
            for_agent("a3", Some(&on)),
            for_agent("a3", Some(&off)),
            for_guest(Some("a3")),
            for_guest(None),
        ];
        for tool in listed.as_array().unwrap() {
            texts.push(tool["description"].as_str().unwrap().to_string());
            let properties = tool["inputSchema"]["properties"].as_object().unwrap();
            texts.extend(
                properties
                    .values()
                    .filter_map(|property| property["description"].as_str().map(str::to_string)),
            );
        }
        let mut sentences = 0;
        for text in &texts {
            for sentence in text
                .split_inclusive(['.', ';', ':'])
                .map(str::trim)
                .filter(|sentence| sentence.len() > 16)
            {
                sentences += 1;
                assert!(
                    !skill.contains(sentence.trim_end_matches(['.', ';', ':'])),
                    "the skill repeats {sentence:?}"
                );
            }
        }
        assert!(sentences > 30, "only {sentences} sentences were compared");
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
            assert_eq!(
                tool["_meta"],
                json!({ "anthropic/alwaysLoad": true, "antigravity/alwaysLoad": true }),
                "loaded from the start by Claude Code and Antigravity"
            );
        }
    }

    /// A tool call's result is the envelope twice: as the text the model reads and as structured
    /// content.
    #[test]
    fn a_tool_result_is_its_envelope_as_text_and_as_structured_content() {
        let answer = answered(
            r##"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"#a2"}}}"##,
        );
        let result = &answer["result"];
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["reason"], "invalid_argument");
        assert_eq!(
            serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
            result["structuredContent"]
        );
        let no_name = answered(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}"#);
        assert_eq!(no_name["error"]["code"], -32602);
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
            respond(
                &Relay::for_test(&[], &[]),
                &Serves::Agent("a7".into()),
                br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                Instant::now()
            )
            .is_none()
        );
        assert!(
            respond(
                &Relay::for_test(&[], &[]),
                &Serves::Agent("a7".into()),
                br#"{"jsonrpc":"2.0","id":9,"result":{}}"#,
                Instant::now()
            )
            .is_none(),
            "a response to nothing asks for nothing"
        );
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
        let relay = Relay::for_test(&[], &[]);
        let notice = |line: String| notice(&relay, line.as_bytes());
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
        assert!(!notice(call(r#""s1""#, "send_message")) && !notice(call("71", "send_message")));
        assert!(!notice(call("72", "list_agents")));
        assert!(notice(cancel(r#""s1""#)), "a cancellation needs no thread");
        assert!(
            relay.sends.cancelled(r#""s1""#) && !relay.sends.cancelled("71"),
            "only the call it names"
        );
        assert!(
            !notice(format!("[{}]", cancel("71"))),
            "a batch is answered"
        );
        assert!(relay.sends.cancelled("71"));
        assert!(
            notice(cancel("72")) && !relay.sends.cancelled("72"),
            "another tool's call is not cancelled"
        );
        relay.sends.finish(r#""s1""#);
        assert!(
            notice(cancel(r#""s1""#)) && !relay.sends.cancelled(r#""s1""#),
            "an answered call stays answered"
        );
        relay.sends.finish("71");
    }
}
