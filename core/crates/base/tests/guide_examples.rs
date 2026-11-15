//! The protocol guide's examples are messages of this build's protocol. Each line reads as the type
//! its method, operation or topic gives it, which writes back all the line says: no example has a
//! field the types lack or leaves out one they need, and it may leave out one they default. The
//! example `hello` lists this build's topics and operations. A failure names the line to fix in
//! `src/protocol/guide.md`.

use std::collections::HashMap;

use facade_base::daemon::{
    self, CancelParams, ChangedParams, ClosingParams, HelloParams, HelloResult, UnwatchParams,
    WatchParams, WatchResult,
};
use facade_base::jsonrpc::ErrorBody;
use facade_base::operations::{
    CallParams, EmptyResult, Operation, OperationVisitor, Topic, TopicVisitor,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const GUIDE: &str = include_str!("../src/protocol/guide.md");

/// Reads `value` as `T` and writes it back: all `value` says, or why not.
fn reads_as<T: Serialize + DeserializeOwned>(value: &Value) -> Result<(), String> {
    let name = std::any::type_name::<T>()
        .rsplit("::")
        .next()
        .unwrap_or_default();
    let read: T = serde_json::from_value(value.clone())
        .map_err(|err| format!("{value} does not read as {name}: {err}"))?;
    let written = serde_json::to_value(&read).map_err(|err| err.to_string())?;
    if says_all(&written, value) {
        Ok(())
    } else {
        Err(format!(
            "{value} reads as {name}, which writes it back as {written}"
        ))
    }
}

/// Whether `written` says all `example` says: the same values, and each field of an object, beside
/// which it may have fields the example left to their defaults.
fn says_all(written: &Value, example: &Value) -> bool {
    match (written, example) {
        (Value::Object(written), Value::Object(example)) => example.iter().all(|(key, said)| {
            written
                .get(key)
                .is_some_and(|written| says_all(written, said))
        }),
        (Value::Array(written), Value::Array(example)) => {
            written.len() == example.len()
                && written
                    .iter()
                    .zip(example)
                    .all(|(written, said)| says_all(written, said))
        }
        _ => written == example,
    }
}

/// An operation's arguments, or its result, by the operation's name.
struct OperationPart<'a> {
    name: &'a str,
    value: &'a Value,
    result: bool,
    read: Option<Result<(), String>>,
}

impl OperationVisitor for OperationPart<'_> {
    fn operation<O: Operation>(&mut self) {
        if O::NAME == self.name {
            self.read = Some(if self.result {
                reads_as::<O::Result>(self.value)
            } else {
                reads_as::<O::Args>(self.value)
            });
        }
    }
}

fn operation(name: &str, value: &Value, result: bool) -> Result<(), String> {
    let mut part = OperationPart {
        name,
        value,
        result,
        read: None,
    };
    daemon::visit_operations(&mut part);
    part.read
        .unwrap_or_else(|| Err(format!("{name} is no operation of this build")))
}

/// What of a topic a message carries.
enum Of {
    Args,
    Snapshot,
    Change,
}

/// A topic's arguments, snapshot or change, by the topic's name.
struct TopicPart<'a> {
    name: &'a str,
    value: &'a Value,
    of: Of,
    read: Option<Result<(), String>>,
}

impl TopicVisitor for TopicPart<'_> {
    fn topic<T: Topic>(&mut self) {
        if T::NAME == self.name {
            self.read = Some(match self.of {
                Of::Args => reads_as::<T::Args>(self.value),
                Of::Snapshot => reads_as::<T::Snapshot>(self.value),
                Of::Change => reads_as::<T::Change>(self.value),
            });
        }
    }
}

fn topic(name: &str, value: &Value, of: Of) -> Result<(), String> {
    let mut part = TopicPart {
        name,
        value,
        of,
        read: None,
    };
    daemon::visit_topics(&mut part);
    part.read
        .unwrap_or_else(|| Err(format!("{name} is no topic of this build")))
}

/// What the example's earlier lines asked and watched, which later lines answer and change.
#[derive(Default)]
struct Exchange {
    /// Each request's method, and the operation or topic it names.
    asked: HashMap<u64, (String, String)>,
    /// Each watch's topic.
    watched: HashMap<u64, String>,
}

impl Exchange {
    /// Reads a message the client sends.
    fn client_sends(&mut self, message: &Value) -> Result<(), String> {
        let params = &message["params"];
        let (method, named) = match message["method"].as_str() {
            Some("hello") => (
                "hello",
                reads_as::<HelloParams>(params).map(|()| String::new())?,
            ),
            Some("call") => {
                reads_as::<CallParams>(params)?;
                let op = params["op"].as_str().unwrap_or_default();
                (
                    "call",
                    operation(op, &params["args"], false).map(|()| op.to_string())?,
                )
            }
            Some("watch") => {
                reads_as::<WatchParams>(params)?;
                let name = params["topic"].as_str().unwrap_or_default();
                let args = if params["args"].is_null() {
                    Value::Object(Default::default())
                } else {
                    params["args"].clone()
                };
                (
                    "watch",
                    topic(name, &args, Of::Args).map(|()| name.to_string())?,
                )
            }
            Some("unwatch") => (
                "unwatch",
                reads_as::<UnwatchParams>(params).map(|()| String::new())?,
            ),
            Some("cancel") => (
                "cancel",
                reads_as::<CancelParams>(params).map(|()| String::new())?,
            ),
            other => return Err(format!("{other:?} is no method a client sends")),
        };
        if let Some(id) = message.get("id") {
            let id = id
                .as_u64()
                .ok_or_else(|| format!("its ID {id} is not a non-negative integer"))?;
            self.asked.insert(id, (method.to_string(), named));
        }
        Ok(())
    }

    /// Reads a message the daemon sends: an answer to a request of an earlier line, or a
    /// notification.
    fn daemon_sends(&mut self, message: &Value) -> Result<(), String> {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            let (method, named) = self
                .asked
                .get(&id)
                .ok_or_else(|| format!("it answers request {id}, which no earlier line asked"))?;
            if let Some(error) = message.get("error") {
                return reads_as::<ErrorBody>(error);
            }
            let result = &message["result"];
            return match method.as_str() {
                "hello" => {
                    reads_as::<HelloResult>(result)?;
                    let names = |key: &str| {
                        result[key].as_array().map(|names| {
                            names
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                    };
                    let (topics, ops) = (daemon::topic_names(), daemon::operation_names());
                    if names("topics").as_ref() != Some(&topics) {
                        return Err(format!("its topics are not this build's, {topics:?}"));
                    }
                    if names("ops").as_ref() != Some(&ops) {
                        return Err(format!("its ops are not this build's, {ops:?}"));
                    }
                    Ok(())
                }
                "call" => operation(named, result, true),
                "watch" => {
                    reads_as::<WatchResult>(result)?;
                    self.watched
                        .insert(result["watch"].as_u64().unwrap_or_default(), named.clone());
                    topic(named, &result["snapshot"], Of::Snapshot)
                }
                _ => reads_as::<EmptyResult>(result),
            };
        }
        let params = &message["params"];
        match message["method"].as_str() {
            Some("changed") => {
                reads_as::<ChangedParams>(params)?;
                let watch = params["watch"].as_u64().unwrap_or_default();
                let name = self.watched.get(&watch).ok_or_else(|| {
                    format!("it changes watch {watch}, which no earlier line made")
                })?;
                topic(name, &params["change"], Of::Change)
            }
            Some("closing") => reads_as::<ClosingParams>(params),
            other => Err(format!("{other:?} is no notification the daemon sends")),
        }
    }
}

/// The message an example line holds: an arrow's line in a fenced example, `→` from the client and
/// `←` from the daemon, or an inline message in backticks, whose method says who sends it.
fn messages() -> Vec<(usize, bool, &'static str)> {
    let mut found = Vec::new();
    for (at, line) in GUIDE.lines().enumerate() {
        if let Some(message) = line.strip_prefix("→ ") {
            found.push((at + 1, true, message));
        } else if let Some(message) = line.strip_prefix("← ") {
            found.push((at + 1, false, message));
        } else {
            for inline in line
                .split('`')
                .skip(1)
                .step_by(2)
                .filter(|inline| inline.starts_with("{\"jsonrpc\""))
            {
                let from_client = !(inline.contains("\"method\":\"changed\"")
                    || inline.contains("\"method\":\"closing\""));
                found.push((at + 1, from_client, inline));
            }
        }
    }
    found
}

#[test]
fn every_example_message_of_the_guide_is_one_of_this_protocol() {
    let mut exchange = Exchange::default();
    let found = messages();
    assert!(
        found.len() >= 16,
        "the guide's example is gone: {} messages found",
        found.len()
    );
    for (at, from_client, line) in found {
        let message: Value = serde_json::from_str(line)
            .unwrap_or_else(|err| panic!("guide.md:{at}: not JSON ({err}): {line}"));
        let read = if message["jsonrpc"] != "2.0" {
            Err("its jsonrpc is not \"2.0\"".to_string())
        } else if from_client {
            exchange.client_sends(&message)
        } else {
            exchange.daemon_sends(&message)
        };
        if let Err(why) = read {
            panic!(
                "guide.md:{at}: {why}\nEdit the example in crates/base/src/protocol/guide.md, then \
                 write the protocol files again: FACADE_REGENERATE=1 cargo test -p facade-base \
                 --test protocol_files"
            );
        }
    }
}
