//! Validates each reference example against its endpoint schema, tracking the request or watch
//! that selects the concrete result or change type. No services or operating-system handles are opened.

use std::collections::{HashMap, HashSet};

use facade_base::api_v1::{self, Notification, Response, daemon, keeper};
use serde_json::{Value, json};

const DAEMON_GUIDE: &str = include_str!("../../../protocol/PROTOCOL.md");
const KEEPER_GUIDE: &str = include_str!("../../../protocol/KEEPER.md");

struct Schema(Value);

impl Schema {
    fn named(&self, name: &str, value: &Value) -> Result<(), String> {
        self.check(&json!({"$ref": format!("#/$defs/{name}")}), value)
            .map_err(|error| format!("{name}: {error}"))
    }

    /// Enforces the shape keywords emitted by the protocol generator. Fails on an unsupported
    /// constraint so adding a new keyword cannot silently weaken the example checks.
    fn check(&self, schema: &Value, value: &Value) -> Result<(), String> {
        self.evaluate(schema, value).map(|_| ())
    }

    /// Collect the names evaluated at this object location for `unevaluatedProperties`.
    fn evaluate<'a>(&self, schema: &Value, value: &'a Value) -> Result<HashSet<&'a str>, String> {
        let fields = match schema {
            Value::Bool(true) => return Ok(HashSet::new()),
            Value::Bool(false) => return Err(format!("{value} is forbidden")),
            Value::Object(fields) => fields,
            _ => panic!("invalid schema: {schema}"),
        };
        let mut evaluated = HashSet::new();
        for (key, constraint) in fields {
            match key.as_str() {
                "$schema"
                | "$defs"
                | "title"
                | "description"
                | "default"
                | "format"
                | "api_versions"
                | "x-facade"
                | "unevaluatedProperties" => {}
                "$ref" => {
                    let path = constraint.as_str().unwrap().strip_prefix('#').unwrap();
                    evaluated.extend(self.evaluate(
                        self.0.pointer(path).expect("missing schema reference"),
                        value,
                    )?);
                }
                "type" => {
                    let matches = |kind: &Value| match kind.as_str().unwrap() {
                        "object" => value.is_object(),
                        "array" => value.is_array(),
                        "string" => value.is_string(),
                        "integer" => value.is_i64() || value.is_u64(),
                        "number" => value.is_number(),
                        "boolean" => value.is_boolean(),
                        "null" => value.is_null(),
                        kind => panic!("unsupported type {kind}"),
                    };
                    let valid = constraint
                        .as_array()
                        .map_or_else(|| matches(constraint), |kinds| kinds.iter().any(matches));
                    if !valid {
                        return Err(format!("expected {constraint}, got {value}"));
                    }
                }
                "const" if value != constraint => {
                    return Err(format!("expected {constraint}, got {value}"));
                }
                "enum" if !constraint.as_array().unwrap().contains(value) => {
                    return Err(format!("{value} is outside {constraint}"));
                }
                "const" | "enum" => {}
                "allOf" => {
                    for part in constraint.as_array().unwrap() {
                        evaluated.extend(self.evaluate(part, value)?);
                    }
                }
                "anyOf" | "oneOf" => {
                    let options = constraint.as_array().unwrap();
                    let results: Vec<_> = options
                        .iter()
                        .map(|part| self.evaluate(part, value))
                        .collect();
                    let matches = results.iter().filter(|part| part.is_ok()).count();
                    if matches == 0 || key == "oneOf" && matches != 1 {
                        let errors = results
                            .into_iter()
                            .filter_map(Result::err)
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(format!("{matches} matches for {key} on {value} ({errors})"));
                    }
                    evaluated.extend(results.into_iter().filter_map(Result::ok).flatten());
                }
                "not" if self.check(constraint, value).is_ok() => {
                    return Err(format!(
                        "{value} also matches forbidden schema {constraint}"
                    ));
                }
                "not" => {}
                "required" => {
                    if let Some(object) = value.as_object() {
                        for name in constraint.as_array().unwrap() {
                            let name = name.as_str().unwrap();
                            if !object.contains_key(name) {
                                return Err(format!("missing {name} in {value}"));
                            }
                        }
                    }
                }
                "properties" => {
                    if let Some(object) = value.as_object() {
                        for (name, property) in constraint.as_object().unwrap() {
                            if let Some((member_name, member)) = object.get_key_value(name) {
                                self.check(property, member)
                                    .map_err(|error| format!("{name}: {error}"))?;
                                evaluated.insert(member_name.as_str());
                            }
                        }
                    }
                }
                "additionalProperties" => {
                    if let Some(object) = value.as_object() {
                        for (name, member) in object {
                            if schema["properties"].get(name).is_none() {
                                self.check(constraint, member)
                                    .map_err(|error| format!("{name}: {error}"))?;
                                evaluated.insert(name.as_str());
                            }
                        }
                    }
                }
                "items" => {
                    if let Some(items) = value.as_array() {
                        for (index, item) in items.iter().enumerate() {
                            self.check(constraint, item)
                                .map_err(|error| format!("item {index}: {error}"))?;
                        }
                    }
                }
                "minItems" | "maxItems" | "minLength" | "maxLength" | "minimum" | "maximum" => {
                    // Keep integer comparisons exact, including both endpoints' u64 IDs.
                    let number = match key.as_str() {
                        "minItems" | "maxItems" => {
                            value.as_array().map(|items| items.len() as i128)
                        }
                        "minLength" | "maxLength" => {
                            value.as_str().map(|s| s.chars().count() as i128)
                        }
                        _ => integer(value),
                    };
                    let bound = integer(constraint).expect("expected integer bound");
                    if number.is_some_and(|n| {
                        if key.starts_with("min") {
                            n < bound
                        } else {
                            n > bound
                        }
                    }) {
                        return Err(format!("{value} violates {key} {constraint}"));
                    }
                }
                unsupported => panic!("unhandled schema constraint {unsupported}"),
            }
        }
        if let (Some(constraint), Some(object)) =
            (fields.get("unevaluatedProperties"), value.as_object())
        {
            for (name, member) in object {
                if evaluated.insert(name.as_str()) {
                    self.check(constraint, member)
                        .map_err(|error| format!("{name}: {error}"))?;
                }
            }
        }
        Ok(evaluated)
    }
}

fn integer(value: &Value) -> Option<i128> {
    value
        .as_u64()
        .map(i128::from)
        .or_else(|| value.as_i64().map(i128::from))
}

#[derive(Clone, Copy)]
enum Lane {
    Local,
    Machine,
    Relay,
    Keeper,
    WindowsKeeper,
}

impl Lane {
    fn is_keeper(self) -> bool {
        matches!(self, Self::Keeper | Self::WindowsKeeper)
    }

    fn read(name: &str) -> Self {
        match name {
            "daemon-local" => Self::Local,
            "daemon-machine" => Self::Machine,
            "relay" => Self::Relay,
            "keeper" => Self::Keeper,
            "keeper-windows" => Self::WindowsKeeper,
            _ => panic!("unknown example lane {name}"),
        }
    }
}

#[derive(Default)]
struct Exchange {
    requests: HashMap<u64, Value>,
    watches: HashMap<u64, String>,
}

impl Exchange {
    fn frame(&mut self, schema: &Schema, lane: Lane, line: &Value) -> Result<(), String> {
        if line.get("terminal").is_some() && !matches!(lane, Lane::WindowsKeeper) {
            return Err("the terminal member requires an authenticated Windows keeper link".into());
        }
        schema.check(&schema.0, line)?;
        if !matches!(lane, Lane::Relay) {
            check_wire_codec(line)?;
        }
        if let Some(method) = line["method"].as_str() {
            if let Some(id) = line["id"].as_u64() {
                let definition = match lane {
                    Lane::Local => "LocalClientRequest",
                    Lane::Machine => "MachineRequest",
                    Lane::Relay => "RelayHelloRequest",
                    Lane::WindowsKeeper if line.get("terminal").is_some() => "WindowsSyncRequest",
                    Lane::Keeper | Lane::WindowsKeeper => "KeeperRequest",
                };
                schema.named(definition, line)?;
                if self.requests.insert(id, line.clone()).is_some() {
                    return Err(format!("request ID {id} is already in flight"));
                }
            } else {
                self.notification(schema, lane, method, line)?;
            }
        } else if let Some(id) = line["id"].as_u64() {
            let request = self
                .requests
                .remove(&id)
                .ok_or_else(|| format!("response has no request with ID {id}"))?;
            if line.get("error").is_some() {
                if request["method"] == "hello"
                    && !matches!(lane, Lane::Relay)
                    && line["error"]["data"]["reason"] == "protocol_incompatible"
                {
                    let supported = &line["error"]["data"]["details"]["supported_api_versions"];
                    schema.named("ProtocolMismatchDetails", &line["error"]["data"]["details"])?;
                    if line["error"]["code"] != -32000 {
                        return Err("a disjoint offer must use the Facade error code".into());
                    }
                    if supported != &schema.0["api_versions"] {
                        return Err(format!("version refusal advertises {supported}"));
                    }
                    if request["params"]["api_versions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|version| supported.as_array().unwrap().contains(version))
                    {
                        return Err("version refusal follows an offer with a common version".into());
                    }
                }
                schema.named("ErrorResponse", line)?;
            } else {
                self.result(schema, lane, &request, line)?;
            }
        } else {
            schema.named("ErrorResponse", line)?;
        }
        Ok(())
    }

    fn notification(
        &mut self,
        schema: &Schema,
        lane: Lane,
        method: &str,
        line: &Value,
    ) -> Result<(), String> {
        let definition = match lane {
            Lane::Local
                if matches!(method, "call" | "cancel")
                    || method == "closing" && line["params"].get("build").is_none() =>
            {
                "LocalClientNotification"
            }
            Lane::Local => "DaemonNotification",
            Lane::Machine => "MachineNotification",
            Lane::Keeper | Lane::WindowsKeeper => "KeeperNotification",
            Lane::Relay if method == "closing" && line["params"].get("build").is_some() => {
                "DaemonNotification"
            }
            Lane::Relay if method == "closing" => "LocalClientNotification",
            Lane::Relay => return Err("unexpected relay notification".into()),
        };
        schema.named(definition, line)?;
        if !lane.is_keeper() && matches!(method, "changed" | "watch_ended") {
            let params = &line["params"];
            let watch = params["watch"].as_u64().unwrap();
            let topic = self
                .watches
                .get(&watch)
                .ok_or_else(|| format!("unrecognized watch {watch}"))?;
            if method == "changed" {
                let change = &schema.0["x-facade"]["topics"][topic]["change"];
                schema.check(change, &params["change"])?;
            } else {
                self.watches.remove(&watch);
            }
        }
        Ok(())
    }

    fn result(
        &mut self,
        schema: &Schema,
        lane: Lane,
        request: &Value,
        line: &Value,
    ) -> Result<(), String> {
        if matches!(lane, Lane::Relay) {
            return schema.named("RelayHelloResponse", line);
        }
        let method = request["method"].as_str().unwrap();
        let params = &request["params"];
        let result = &line["result"];
        let operation = if method == "call" {
            params["op"].as_str()
        } else {
            None
        };
        let definition = if line.get("terminal").is_some() {
            match operation {
                Some("agent.start") => "WindowsStartResponse",
                Some("agent.sync") if request.get("terminal").is_none() => "WindowsSyncResponse",
                _ => {
                    return Err(format!(
                        "a terminal cannot accompany the response to {request}"
                    ));
                }
            }
        } else {
            "SuccessResponse"
        };
        schema.named(definition, line)?;
        match method {
            "hello" => {
                if lane.is_keeper() {
                    schema.named("HelloResult", result)?;
                } else {
                    schema.named("DaemonHelloResult", result)?;
                    let kind = serde_json::from_value(params["kind"].clone()).unwrap();
                    if result["ops"] != json!(daemon::operation_names(kind))
                        || result["topics"] != json!(daemon::topic_names(kind))
                    {
                        return Err("the hello catalog differs from the typed registry".into());
                    }
                    if matches!(lane, Lane::Machine) != result.get("machine").is_some() {
                        return Err(
                            "hello result has the wrong machine projection for the lane".into()
                        );
                    }
                }
                let supported = schema.0["api_versions"].as_array().unwrap();
                let selected = params["api_versions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|offered| supported.contains(offered))
                    .max_by_key(|offered| offered.as_u64().unwrap());
                if selected != Some(&result["api_version"]) {
                    return Err("hello result differs from the highest common version".into());
                }
            }
            "call" => self.call_result(schema, operation.unwrap(), result)?,
            "forward" if params["method"] == "call" => {
                self.call_result(schema, params["params"]["op"].as_str().unwrap(), result)?;
            }
            "watch" | "forward" => {
                let (topic, envelope) = if method == "forward" {
                    (&params["params"]["topic"], "ForwardWatchResult")
                } else {
                    (&params["topic"], "WatchResult")
                };
                schema.named(envelope, result)?;
                if method == "watch" && result.get("view").is_some() {
                    return Err("a public watch result cannot carry the holder view".into());
                }
                let topic = topic.as_str().unwrap();
                let snapshot = &schema.0["x-facade"]["topics"][topic]["snapshot"];
                schema.check(snapshot, &result["snapshot"])?;
                let watch = result["watch"].as_u64().unwrap();
                if self.watches.insert(watch, topic.into()).is_some() {
                    return Err(format!("watch ID {watch} is already subscribed"));
                }
            }
            "unwatch" => {
                let watch = params["watch"].as_u64().unwrap();
                self.watches
                    .remove(&watch)
                    .ok_or_else(|| format!("unrecognized watch {watch}"))?;
                schema.named("EmptyResult", result)?;
            }
            "advertise" | "cancel" => schema.named("EmptyResult", result)?,
            _ => return Err(format!("unknown example method {method}")),
        }
        Ok(())
    }

    fn call_result(&self, schema: &Schema, op: &str, value: &Value) -> Result<(), String> {
        let result = &schema.0["x-facade"]["operations"][op]["result"];
        schema
            .check(result, value)
            .map_err(|error| format!("result for {op}: {error}"))
    }
}

fn check_wire_codec(line: &Value) -> Result<(), String> {
    let mut frame = line.clone();
    // The Windows schema has already checked the authenticated transport member before this
    // point. The codec in production sees only the frame after resource extraction.
    frame.as_object_mut().unwrap().remove("terminal");
    if frame.get("method").is_none() {
        serde_json::from_value::<Response>(frame).map_err(|error| error.to_string())?;
    } else if frame.get("id").is_none() {
        serde_json::from_value::<Notification>(frame).map_err(|error| error.to_string())?;
    } else {
        api_v1::parse_request(frame.to_string().as_bytes())
            .map_err(|error| error.error.to_string())?;
    }
    Ok(())
}

fn check_examples(schema: &Schema, guide: &str) -> usize {
    let mut example = None;
    let mut count = 0;
    let mut windows_resources = 0;
    for (index, line) in guide.lines().enumerate() {
        if let Some(name) = line.strip_prefix("```jsonl ") {
            assert!(example.is_none(), "nested example at line {}", index + 1);
            example = Some((Lane::read(name), Exchange::default()));
        } else if line == "```" {
            if let Some((_, exchange)) = example.take() {
                assert!(
                    exchange.requests.is_empty(),
                    "unanswered request at line {}",
                    index + 1
                );
            }
        } else if let Some((lane, exchange)) = &mut example {
            let parsed = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("line {} is invalid JSON: {error}", index + 1));
            exchange
                .frame(schema, *lane, &parsed)
                .unwrap_or_else(|error| panic!("line {}: {error}\n{line}", index + 1));
            count += 1;
            if parsed.get("terminal").is_some() {
                windows_resources += 1;
            }
        }
    }
    assert!(example.is_none(), "unterminated example");
    assert!(count > 0, "no examples checked");
    windows_resources
}

#[test]
fn daemon_examples_match_the_published_schema() {
    let schema = Schema(
        serde_json::from_str(include_str!("../../../protocol/protocol.schema.json")).unwrap(),
    );
    assert_eq!(
        schema.0["api_versions"],
        json!(daemon::SUPPORTED_API_VERSIONS)
    );
    check_examples(&schema, DAEMON_GUIDE);
}

#[test]
fn flattened_forward_rejects_unevaluated_fields() {
    let schema = Schema(
        serde_json::from_str(include_str!("../../../protocol/protocol.schema.json")).unwrap(),
    );
    let mut frame: Value = serde_json::from_str(
        DAEMON_GUIDE
            .lines()
            .find(|line| line.contains(r#""method":"forward""#))
            .unwrap(),
    )
    .unwrap();
    schema.named("MachineRequest", &frame).unwrap();
    frame["params"]["unexpected"] = json!(true);
    assert!(
        schema
            .named("MachineRequest", &frame)
            .unwrap_err()
            .contains("unexpected: true is forbidden")
    );
}

#[test]
fn advertise_is_limited_to_machine_requests_and_notifications() {
    let schema = Schema(
        serde_json::from_str(include_str!("../../../protocol/protocol.schema.json")).unwrap(),
    );
    let mut advertise = json!({"jsonrpc":"2.0","method":"advertise","params":{"machines":[]}});
    schema.named("MachineNotification", &advertise).unwrap();
    assert!(schema.named("LocalClientNotification", &advertise).is_err());
    assert!(schema.named("DaemonNotification", &advertise).is_err());
    advertise["id"] = json!(2);
    schema.named("MachineRequest", &advertise).unwrap();
    assert!(schema.named("LocalClientRequest", &advertise).is_err());
    assert!(schema.named("MachineNotification", &advertise).is_err());
}

#[test]
fn forwarded_start_receipt_has_strict_references_and_size() {
    let schema = Schema(
        serde_json::from_str(include_str!("../../../protocol/protocol.schema.json")).unwrap(),
    );
    let op = "internal.deliver_start_result";
    let args_schema = &schema.0["x-facade"]["operations"][op]["args"];
    let at = "2026-11-20T17:00:00.000Z";
    let machine = "11111111-1111-4111-8111-111111111111";
    let recipient = json!({"machine_id": machine, "agent_id": "a1"});
    let agent = json!({"machine_id": machine, "agent_id": "a2"});
    let delivery = json!({"status":"success", "text_written":"full"});
    let canonical = json!({
        "recipient": recipient,
        "message": {
            "message_id":"m4", "message_ref":{"machine_id":machine, "message_id":"m4"},
            "from":"facade", "to":"a1", "text":"Nova started.", "at":at, "delivery":delivery,
            "result": {
                "agent": {
                    "reference":agent, "address":"a2@devbox", "type":"managed", "name":"Nova",
                    "cli":"fake", "args":[], "cwd":"/work", "process":"running",
                    "size":{"cols":80, "rows":24}, "created_at":at, "started_at":at,
                    "creator":recipient, "root":recipient, "yolo":false, "state":"starting",
                    "tools_state":"connecting"
                },
                "prompt":{"message_id":"m3", "delivery":delivery}
            }
        }
    });
    schema.check(args_schema, &canonical).unwrap();
    let mut call = api_v1::CallParams {
        op: op.into(),
        args: canonical.clone(),
    };
    daemon::decode_call(call.clone(), daemon::ClientKind::Machine).unwrap();
    call.args["message"]
        .as_object_mut()
        .unwrap()
        .remove("result");
    schema.check(args_schema, &call.args).unwrap();
    daemon::decode_call(call.clone(), daemon::ClientKind::Machine).unwrap();

    for path in [
        "/message_ref",
        "/result/agent/reference",
        "/result/agent/creator",
        "/result/agent/root",
        "/result/agent/size",
    ] {
        call.args = canonical.clone();
        call.args["message"].pointer_mut(path).unwrap()["future_field"] = json!(true);
        assert!(schema.check(args_schema, &call.args).is_err(), "{path}");
        let error = daemon::decode_call(call.clone(), daemon::ClientKind::Machine).unwrap_err();
        assert_eq!(
            (error.code, error.data.reason.as_str()),
            (-32602, "invalid_argument"),
            "{path}"
        );
        schema.named("Message", &call.args["message"]).unwrap();
        serde_json::from_value::<daemon::Message>(call.args["message"].clone()).unwrap();
    }

    let outcome = &canonical["message"]["result"];
    let mut agent = outcome["agent"].clone();
    agent["size"]["future_field"] = json!(true);
    for invalid in [json!([agent, outcome["prompt"]]), Value::Null] {
        call.args = canonical.clone();
        call.args["message"]["result"] = invalid;
        assert!(schema.check(args_schema, &call.args).is_err());
        let error = daemon::decode_call(call.clone(), daemon::ClientKind::Machine).unwrap_err();
        assert_eq!(
            (error.code, error.data.reason.as_str()),
            (-32602, "invalid_argument")
        );
    }
}

#[test]
fn keeper_examples_match_the_published_schema() {
    let schema =
        Schema(serde_json::from_str(include_str!("../../../protocol/keeper.schema.json")).unwrap());
    assert_eq!(
        schema.0["api_versions"],
        json!(keeper::SUPPORTED_API_VERSIONS)
    );
    assert!(
        check_examples(&schema, KEEPER_GUIDE) > 0,
        "missing authenticated Windows terminal fixture"
    );
}
