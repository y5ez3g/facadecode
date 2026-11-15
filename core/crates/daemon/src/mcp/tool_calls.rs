//! The eight tools: their definitions, and each call checked and then made as daemon calls for the
//! agent the server acts for. Every call opens a connection of its own, so a send that waits for its
//! delivery holds up no other call.

use std::sync::LazyLock;
use std::time::Instant;

use serde_json::{Map, Value};

use super::schema::{Problems, read_arguments};
use super::{Relay, agent_tools, daemon_calls, envelope, message_tools, terminal_tools};

/// The tools as `tools/list` describes them, in order, without a result schema.
static DEFINITIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(facade_base::tools::DEFINITIONS).expect("the tool definitions are JSON")
});

/// The tools' definitions, in order.
pub(super) fn definitions() -> &'static [Value] {
    &DEFINITIONS
}

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
pub(super) struct ToolCall {
    /// Its JSON-RPC ID as a later result names it: the string itself, or the number written out.
    pub(super) id: String,
    /// Its JSON-RPC ID as JSON text, as the client's cancellation names it.
    pub(super) key: String,
    /// When its line arrived, before it waited for a thread: a send's 30 seconds count from then.
    pub(super) arrived: Instant,
    /// The request ID it goes to the daemon with, where the model gives none: the relay's process
    /// and the call's ID, the same at every daemon, so that a call the relay gives the next daemon
    /// repeats what the first did.
    pub(super) request_id: String,
}

impl ToolCall {
    pub(super) fn of(relay: &Relay, id: &Value, arrived: Instant) -> ToolCall {
        let key = id.to_string();
        ToolCall {
            id: id.as_str().map_or_else(|| key.clone(), str::to_string),
            request_id: format!("facade-{}-{}-{key}", relay.pid, relay.birth),
            key,
            arrived,
        }
    }
}

/// Calls tool `name` with `arguments` for `agent` and answers its result: none for a send its
/// client cancelled, which wrote nothing or whose message Facade withdrew.
pub(super) fn call(
    relay: &Relay,
    agent: &str,
    name: &str,
    arguments: &Value,
    call: &ToolCall,
) -> Option<Value> {
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
        return Some(envelope::failure("unsupported", message));
    };
    let mut problems = Problems::default();
    let arguments = read_arguments(name, &definition["inputSchema"], arguments, &mut problems);
    tool.check(&arguments, &mut problems);
    if let Some(failure) = problems.into_failure(name) {
        return Some(failure);
    }
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

/// What a call to a server that acts for no one answers: it serves no tools, so nothing was done.
pub(super) fn unconfigured() -> Value {
    let message = "this Facade server was not started for a Facade agent, so it serves no tools; \
                   nothing was done";
    envelope::failure("configuration_invalid", message)
}

/// What a call to a guest's server that stepped aside in a Facade run's own session answers: the
/// run's own server serves it.
pub(super) fn aside() -> Value {
    let message = "this Facade server serves no tools here: the Facade run it started in has a \
                   server of its own; nothing was done";
    envelope::failure("configuration_invalid", message)
}

/// The string argument `key`, which the schema checked, or an empty one where it is optional and
/// left out.
pub(super) fn text(arguments: &Map<String, Value>, key: &str) -> String {
    optional(arguments, key).unwrap_or_default()
}

/// The string argument `key`, where it was given.
pub(super) fn optional(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tools_are_the_eight_in_their_order() {
        let names: Vec<&str> = definitions()
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
}
