//! Generates JSON Schema, TypeScript types, and protocol references from Rust types.

use facade_base::api_v1::{self, ApiVersion, EmptyResult, ErrorBody, NoArgs, Operation, Topic};
use facade_base::api_v1::{daemon, keeper};
use facade_base::operations::OperationVisitor;
use schemars::{JsonSchema, SchemaGenerator};
use serde_json::{Map, Value, json};

/// Type schemas collected as reusable definitions.
pub struct SchemaRegistry {
    generator: SchemaGenerator,
}

impl SchemaRegistry {
    pub fn new() -> Self {
        Self {
            generator: SchemaGenerator::default(),
        }
    }

    /// Adds a type and returns its schema reference, or an inline schema for types such as `Vec`.
    pub fn add<T: JsonSchema>(&mut self) -> Value {
        let mut schema = serde_json::to_value(self.generator.subschema_for::<T>())
            .expect("schema must serialize");
        omit_null_from_optional_fields(&mut schema);
        schema
    }

    pub fn definitions(mut self) -> Map<String, Value> {
        let mut definitions: Map<String, Value> =
            self.generator.take_definitions(true).into_iter().collect();
        for schema in definitions.values_mut() {
            omit_null_from_optional_fields(schema);
        }
        definitions.sort_keys();
        definitions
    }
}

/// An operation's documentation and argument and result schemas.
pub struct OperationDoc {
    name: &'static str,
    doc: &'static str,
    args: Value,
    result: Value,
    access: Option<daemon::EntryAccess>,
}

pub struct OperationDocs<'a>(&'a mut SchemaRegistry, Vec<OperationDoc>);

impl OperationVisitor for OperationDocs<'_> {
    fn operation<O: Operation>(&mut self) {
        let (args, result) = (self.0.add::<O::Args>(), self.0.add::<O::Result>());
        self.1.push(OperationDoc {
            name: O::NAME,
            doc: O::DOC,
            args,
            result,
            access: None,
        });
    }
}

impl daemon::DaemonOperationVisitor for OperationDocs<'_> {
    fn operation<O: Operation>(&mut self, access: daemon::EntryAccess) {
        OperationVisitor::operation::<O>(self);
        self.1.last_mut().unwrap().access = Some(access);
    }
}

pub struct TopicDoc {
    name: &'static str,
    doc: &'static str,
    args: Value,
    snapshot: Value,
    change: Value,
    access: daemon::EntryAccess,
}

pub struct TopicDocs<'a>(&'a mut SchemaRegistry, Vec<TopicDoc>);

impl daemon::DaemonTopicVisitor for TopicDocs<'_> {
    fn topic<T: Topic>(&mut self, access: daemon::EntryAccess) {
        let (args, snapshot, change) = (
            self.0.add::<T::Args>(),
            self.0.add::<T::Snapshot>(),
            self.0.add::<T::Change>(),
        );
        self.1.push(TopicDoc {
            name: T::NAME,
            doc: T::DOC,
            args,
            snapshot,
            change,
            access,
        });
    }
}

/// Remove null from optional fields, which are omitted when absent. Keep null for required nullable
/// fields, such as a response ID.
pub fn omit_null_from_optional_fields(schema: &mut Value) {
    if let Some(object) = schema.as_object_mut() {
        if object.get("default") == Some(&Value::Null) {
            object.remove("default");
        }
        let required: Vec<String> = object
            .get("required")
            .and_then(Value::as_array)
            .map(|r| {
                r.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
            for (name, property) in properties.iter_mut() {
                if !required.contains(name) {
                    strip_null(property);
                }
            }
        }
    }
    match schema {
        Value::Object(object) => object.values_mut().for_each(omit_null_from_optional_fields),
        Value::Array(items) => items.iter_mut().for_each(omit_null_from_optional_fields),
        _ => {}
    }
}

/// Removes null from a schema: `T | null` becomes `T`.
pub fn strip_null(schema: &mut Value) {
    if let Some(object) = schema.as_object_mut()
        && object.get("default") == Some(&Value::Null)
    {
        object.remove("default");
    }
    if let Some(types) = schema.get_mut("type").and_then(Value::as_array_mut) {
        types.retain(|kind| kind != "null");
        if types.len() == 1 {
            let one = types[0].clone();
            schema["type"] = one;
        }
    }
    if let Some(choices) = schema.get_mut("anyOf").and_then(Value::as_array_mut) {
        choices.retain(|choice| choice.get("type").is_none_or(|kind| kind != "null"));
        if choices.len() == 1
            && let (Some(one), Some(object)) = (choices.pop(), schema.as_object_mut())
        {
            object.remove("anyOf");
            if let Some(fields) = one.as_object() {
                object.extend(fields.clone());
            }
        }
    }
}

/// Adds the description to a schema when present.
pub fn described(description: Option<Value>, mut schema: Value) -> Value {
    if let (Some(description), Some(object)) = (description, schema.as_object_mut()) {
        object.insert("description".into(), description);
    }
    schema
}

fn call_schema<'a>(ops: impl IntoIterator<Item = &'a OperationDoc>) -> Value {
    let calls: Vec<Value> = ops
        .into_iter()
        .map(|op| {
            json!({
                "type": "object", "additionalProperties": false,
                "properties": { "op": { "const": op.name }, "args": op.args },
                "required": ["op", "args"],
            })
        })
        .collect();
    json!({ "oneOf": calls })
}

fn watch_schema<'a>(topics: impl IntoIterator<Item = &'a TopicDoc>) -> Value {
    let watches: Vec<Value> = topics
        .into_iter()
        .map(|topic| {
            json!({
                "type": "object", "additionalProperties": false,
                "properties": { "topic": { "const": topic.name }, "args": topic.args },
                "required": ["topic", "args"],
            })
        })
        .collect();
    json!({ "oneOf": watches })
}

/// Converts a schema to a TypeScript type. Unsupported schema syntax is an error. Only the schema
/// `true`, which permits any JSON value, becomes `unknown`.
pub fn typescript_type(schema: &Value) -> String {
    if schema == &Value::Bool(false) {
        return "never".into();
    }
    if schema == &Value::Bool(true)
        || schema
            .as_object()
            .is_some_and(|object| object.keys().all(|key| key == "description"))
    {
        return "unknown".into();
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return reference
            .rsplit('/')
            .next()
            .expect("expected a type name in the schema reference")
            .to_string();
    }
    if let Some(choices) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        let mut parts: Vec<String> = choices.iter().map(typescript_type).collect();
        parts.dedup();
        let variants = parts.join(" | ");
        return match schema.get("properties").and_then(Value::as_object) {
            Some(properties) if !properties.is_empty() => {
                format!(
                    "{{ {} }} & ({variants})",
                    typescript_fields(properties, schema).join("; ")
                )
            }
            _ => variants,
        };
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .map(|value| value.to_string().replace('"', "'"))
            .collect::<Vec<_>>()
            .join(" | ");
    }
    if let Some(constant) = schema.get("const") {
        return constant.to_string().replace('"', "'");
    }
    if let Some(kinds) = schema.get("type").and_then(Value::as_array) {
        let one = |kind: &Value| {
            let mut single = schema.clone();
            single["type"] = kind.clone();
            typescript_type(&single)
        };
        return kinds.iter().map(one).collect::<Vec<_>>().join(" | ");
    }
    let kind = schema
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("unsupported schema syntax: {schema}"));
    match kind {
        "null" => "null".into(),
        "string" => "string".into(),
        "integer" | "number" => "number".into(),
        "boolean" => "boolean".into(),
        "array" => {
            let items = schema
                .get("items")
                .unwrap_or_else(|| panic!("array schema has no items: {schema}"));
            let item = typescript_type(items);
            // An array with an exact length becomes a tuple.
            match (
                schema.get("minItems").and_then(Value::as_u64),
                schema.get("maxItems").and_then(Value::as_u64),
            ) {
                (Some(least), Some(most)) if least == most => {
                    format!("[{}]", vec![item; least as usize].join(", "))
                }
                _ if item.contains(' ') => format!("({item})[]"),
                _ => format!("{item}[]"),
            }
        }
        "object" => match (
            schema.get("properties").and_then(Value::as_object),
            schema.get("additionalProperties"),
        ) {
            (Some(properties), _) => {
                format!("{{ {} }}", typescript_fields(properties, schema).join("; "))
            }
            (None, Some(values)) if values.is_object() || values == &Value::Bool(true) => {
                format!("{{ readonly [key: string]: {} }}", typescript_type(values))
            }
            (None, None | Some(Value::Bool(false))) => "Record<string, never>".into(),
            _ => panic!("unsupported object schema: {schema}"),
        },
        other => panic!("unsupported schema type: {other}"),
    }
}

pub fn typescript_fields(properties: &Map<String, Value>, schema: &Value) -> Vec<String> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    properties
        .iter()
        .map(|(name, property)| {
            format!(
                "readonly {name}{}: {}",
                if required.contains(&name.as_str()) {
                    ""
                } else {
                    "?"
                },
                typescript_type(property)
            )
        })
        .collect()
}

pub fn typescript_file(
    definitions: &Map<String, Value>,
    ops: &[OperationDoc],
    topics: &[TopicDoc],
) -> String {
    let mut out = String::from(
        "// Generated from core/crates/base/src by \
         core/crates/base/tests/protocol_files.rs: do not edit.\n\n",
    );
    out.push_str(&format!(
        "export const DAEMON_API_VERSIONS = {} as const;\n\
         export const KEEPER_API_VERSIONS = {} as const;\n",
        json!(daemon::SUPPORTED_API_VERSIONS),
        json!(keeper::SUPPORTED_API_VERSIONS),
    ));
    out.push_str(
        "export type DaemonOperation = keyof DaemonOperations;\n\
         export type DaemonTopic = keyof DaemonTopics;\n",
    );
    for (name, schema) in definitions {
        match schema.get("description").and_then(Value::as_str) {
            Some(description) => out.push_str(&format!(
                "\n/** {} */\n",
                description.replace("*/", "* /").replace('\n', "\n * ")
            )),
            None => out.push('\n'),
        }
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .filter(|_| schema.get("oneOf").is_none() && schema.get("anyOf").is_none());
        match properties {
            Some(properties) => {
                out.push_str(&format!("export interface {name} {{\n"));
                for field in typescript_fields(properties, schema) {
                    out.push_str(&format!("\t{field};\n"));
                }
                out.push_str("}\n");
            }
            None => out.push_str(&format!(
                "export type {name} = {};\n",
                typescript_type(schema)
            )),
        }
    }
    write_typescript_maps(&mut out, ops, topics);
    out
}

fn write_typescript_maps(out: &mut String, ops: &[OperationDoc], topics: &[TopicDoc]) {
    out.push_str(
        "\n/** Argument and result types for each operation. */\nexport interface DaemonOperations {\n",
    );
    for op in ops {
        out.push_str(&format!(
            "\treadonly \"{}\": {{ readonly args: {}; readonly result: {} }};\n",
            op.name,
            typescript_type(&op.args),
            typescript_type(&op.result)
        ));
    }
    out.push_str(
        "}\n\n/** Argument, snapshot, and change types for each topic. Skip unknown change kinds. \
         */\nexport interface DaemonTopics {\n",
    );
    for topic in topics {
        out.push_str(&format!(
            "\treadonly {}: {{ readonly args: {}; readonly snapshot: {}; readonly change: {} }};\n",
            topic.name,
            typescript_type(&topic.args),
            typescript_type(&topic.snapshot),
            typescript_type(&topic.change)
        ));
    }
    out.push_str("}\n");
}

pub fn markdown_cell(text: &str) -> String {
    text.replace('\n', " ").replace('|', "\\|")
}

/// Reads error reasons and their documentation from the `Reason` schema.
/// Writes a field table for each object type.
pub fn type_tables(out: &mut String, definitions: &Map<String, Value>) {
    out.push_str("\n## Types\n");
    for (name, schema) in definitions {
        out.push_str(&format!("\n### {name}\n\n"));
        if let Some(description) = schema.get("description").and_then(Value::as_str) {
            out.push_str(&format!("{}\n\n", description.replace('\n', " ")));
        }
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .filter(|_| schema.get("oneOf").is_none() && schema.get("anyOf").is_none());
        match properties {
            Some(properties) => {
                let required: Vec<&str> = schema
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|r| r.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                out.push_str("| Field | Type | Required | Description |\n|---|---|---|---|\n");
                for (field, property) in properties {
                    let doc = property
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "| `{field}` | `{}` | {} | {} |\n",
                        markdown_cell(&typescript_type(property)),
                        if required.contains(&field.as_str()) {
                            "yes"
                        } else {
                            "no"
                        },
                        markdown_cell(doc)
                    ));
                }
            }
            None => out.push_str(&format!("`{}`\n", markdown_cell(&typescript_type(schema)))),
        }
    }
}

pub fn render_reference(
    title: &str,
    intro: &str,
    methods: &[(&str, &str)],
    topics: &[TopicDoc],
    ops: &[OperationDoc],
    definitions: &Map<String, Value>,
    reasons: &[(&str, &str)],
) -> String {
    let mut out = String::from(
        "<!-- Generated from core/crates/base/src by \
         core/crates/base/tests/protocol_files.rs: do not edit. -->\n\n",
    );
    out.push_str(&format!("# {title}\n\n{intro}\n"));
    out.push_str("\n## Methods\n\n| Name | Description |\n|---|---|\n");
    for (name, doc) in methods {
        out.push_str(&format!("| `{name}` | {} |\n", markdown_cell(doc)));
    }
    if !topics.is_empty() {
        out.push_str(
            "\n## Topics\n\nTopics available to `watch`. Their types are defined below.\n\n| Name \
             | Arguments | Snapshot | Change | Audience | Description |\n|---|---|---|---|---|---|\n",
        );
        for topic in topics {
            out.push_str(&format!(
                "| `{}` | `{}` | `{}` | `{}` | {} | {} |\n",
                topic.name,
                markdown_cell(&typescript_type(&topic.args)),
                markdown_cell(&typescript_type(&topic.snapshot)),
                markdown_cell(&typescript_type(&topic.change)),
                audience(Some(topic.access)),
                markdown_cell(topic.doc)
            ));
        }
    }
    out.push_str(
        "\n## Operations\n\nOperations available to `call`. Set `op` to the name and `args` to its \
         arguments. Types are defined below.\n\n| Name | Arguments | Result | Audience | Description |\n\
         |---|---|---|---|---|\n",
    );
    for op in ops {
        out.push_str(&format!(
            "| `{}` | `{}` | `{}` | {} | {} |\n",
            op.name,
            markdown_cell(&typescript_type(&op.args)),
            markdown_cell(&typescript_type(&op.result)),
            audience(op.access),
            markdown_cell(op.doc)
        ));
    }
    out.push_str("\n## Error reasons\n\n| Reason | When |\n|---|---|\n");
    for (name, doc) in reasons {
        out.push_str(&format!("| `{name}` | {} |\n", markdown_cell(doc)));
    }
    type_tables(&mut out, definitions);
    out
}

fn reference_to(name: &str) -> Value {
    json!({ "$ref": format!("#/$defs/{name}") })
}

fn audience(access: Option<daemon::EntryAccess>) -> String {
    let Some(access) = access else {
        return "authenticated daemon".into();
    };
    let mut kinds = Vec::new();
    for kind in access.local {
        kinds.push(match kind {
            daemon::ClientKind::Terminal => "terminal",
            daemon::ClientKind::Ide => "ide",
            daemon::ClientKind::Mcp => "MCP actor",
            daemon::ClientKind::Machine => "machine",
        });
    }
    if access.forwarded {
        kinds.push("machine forward");
    }
    kinds.join(", ")
}

const DAEMON_METHODS: &[(&str, &str)] = &[
    (
        daemon::methods::HELLO,
        "Negotiate a daemon API version and discover this connection's operations and topics.",
    ),
    (
        daemon::methods::CALL,
        "Invoke a registered operation. Raw agent.type and attach.resize also accept notifications.",
    ),
    (
        daemon::methods::WATCH,
        "Subscribe to a registered topic and return a connection-local watch ID and snapshot.",
    ),
    (
        daemon::methods::UNWATCH,
        "Release a watch and acknowledge the request.",
    ),
    (
        daemon::methods::CANCEL,
        "Request cancellation of an agent.send before the paste starts.",
    ),
    (daemon::methods::CHANGED, "Deliver a change to a watch."),
    (
        daemon::methods::WATCH_ENDED,
        "Report that a watch lost its subscription.",
    ),
    (
        daemon::methods::CLOSING,
        "Announce a replacement build, or acknowledge the announcement with empty params.",
    ),
    (
        daemon::methods::ADVERTISE,
        "Exchange machine routing information on an authenticated peer connection.",
    ),
    (
        daemon::methods::FORWARD,
        "Route a registered call or watch on an authenticated machine connection.",
    ),
    (
        daemon::methods::MACHINE_SLEEPING,
        "Report an authenticated peer's idle exit.",
    ),
    (
        daemon::methods::CONNECTED,
        "Confirm an authorized foreground machine handoff.",
    ),
    (
        daemon::methods::CONNECT_FAILED,
        "Report a foreground machine handoff failure.",
    ),
];

const DAEMON_REASONS: &[(&str, &str)] = &[
    (
        "invalid_argument",
        "A malformed request or invalid parameters. Details may include available_clis.",
    ),
    (
        "not_found",
        "No matching record. Details may include agents and record_removal (expired or removed).",
    ),
    (
        "session_not_found",
        "No matching saved session. Details may include sessions.",
    ),
    (
        "ambiguous_reference",
        "Several objects match. Details may include candidates, agents, machines or sessions.",
    ),
    ("ended", "The agent ended. Details may include agents."),
    (
        "partial_input",
        "Some terminal input was written. Details give text_written and optional enter_written, or keys_sent.",
    ),
    (
        "unavailable",
        "The operation or route is unavailable. Details can describe the execution state and affected targets. \
         The optional `agents: AgentLabel[]` lists only agents already resolved and authorized.",
    ),
    (
        "protocol_incompatible",
        "No usable API version. Details include supported_api_versions and may include offered_api_versions and agents.",
    ),
    (
        "machine_id_conflict",
        "The same machine ID is in use at different paths. Details give machine_id and paths.",
    ),
    (
        "machine_id_mismatch",
        "The authenticated machine ID differs from the expected one. Details give both IDs.",
    ),
    (
        "ssh_interaction_required",
        "SSH needs an interactive repair. Details give message and command.",
    ),
    (
        "capacity_exceeded",
        "The line or a connection budget was exceeded.",
    ),
    ("internal", "The daemon encountered an internal error."),
    (
        "refused",
        "The operation was refused. Details may include a settings entry and `agents: AgentLabel[]` for agents \
         already resolved and authorized. Denials outside the caller's creation tree omit agent labels.",
    ),
    (
        "configuration_invalid",
        "The settings are invalid. Details may name an entry.",
    ),
    ("cancelled", "The send was cancelled before paste started."),
    (
        "worktree_failed",
        "Worktree creation failed. Details may identify the surviving branch or path under kept.",
    ),
    (
        "upgrading",
        "The daemon is handing over and did not begin the operation.",
    ),
    (
        "unsupported",
        "The target or parameter lacks a required capability. Details may include agents.",
    ),
];

const KEEPER_REASONS: &[(&str, &str)] = &[
    (
        "invalid_argument",
        "Invalid framing, handshake order, API versions, parameters or terminal resource.",
    ),
    (
        "not_found",
        "The target is missing, or neither side has its terminal.",
    ),
    (
        "unavailable",
        "The keeper could not start, identify or acquire the CLI or its terminal.",
    ),
    (
        "protocol_incompatible",
        "No common keeper API version. Details give supported_api_versions.",
    ),
    ("capacity_exceeded", "The line exceeded the 64 MiB limit."),
];

fn object(properties: Value) -> Value {
    let required: Vec<_> = properties.as_object().unwrap().keys().collect();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn id_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": u64::MAX })
}

fn request(method: &str, params: Value, with_id: bool) -> Value {
    let mut properties = json!({
        "jsonrpc": { "const": "2.0" },
        "method": { "const": method },
        "params": params,
    });
    if with_id {
        properties["id"] = id_schema();
    }
    object(properties)
}

fn response(result: Value) -> Value {
    object(json!({
        "jsonrpc": { "const": "2.0" },
        "id": id_schema(),
        "result": result,
    }))
}

fn error_response(error: Value) -> Value {
    object(json!({
        "jsonrpc": { "const": "2.0" },
        "id": { "anyOf": [id_schema(), { "type": "null" }] },
        "error": error,
    }))
}

fn with_terminal(mut frame: Value) -> Value {
    frame["properties"]["terminal"] = reference_to("WindowsTerminal");
    frame["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("terminal"));
    frame
}

fn alias(definitions: &mut Map<String, Value>, name: &str, schema: &Value) {
    if schema != &reference_to(name) {
        definitions.insert(name.into(), schema.clone());
    }
}

fn success_types(ops: &[OperationDoc], extra: impl IntoIterator<Item = Value>) -> Value {
    let schemas: Vec<_> = extra
        .into_iter()
        .chain(ops.iter().map(|op| op.result.clone()))
        .collect();
    json!({ "anyOf": schemas })
}

fn topic_variants(topics: &[TopicDoc], pick: impl Fn(&TopicDoc) -> &Value) -> Value {
    json!({ "anyOf": topics.iter().map(pick).collect::<Vec<_>>() })
}

fn specialize_member(
    definitions: &mut Map<String, Value>,
    schema: &Value,
    name: &str,
    values: Value,
) {
    let def_name = schema["$ref"].as_str().unwrap().rsplit('/').next().unwrap();
    let property = &mut definitions.get_mut(def_name).unwrap()["properties"][name];
    *property = described(property.get("description").cloned(), values);
}

fn operation_catalog(ops: &[OperationDoc]) -> Value {
    let mut catalog = Map::new();
    for op in ops {
        let mut entry = json!({ "args": op.args, "result": op.result });
        if let Some(access) = op.access {
            entry["local"] = json!(access.local);
            entry["forwarded"] = json!(access.forwarded);
        }
        catalog.insert(op.name.into(), entry);
    }
    Value::Object(catalog)
}

fn topic_catalog(topics: &[TopicDoc]) -> Value {
    Value::Object(
        topics
            .iter()
            .map(|topic| {
                (
                    topic.name.into(),
                    json!({
                        "args": topic.args, "snapshot": topic.snapshot, "change": topic.change,
                        "local": topic.access.local, "forwarded": topic.access.forwarded,
                    }),
                )
            })
            .collect(),
    )
}

fn schema_file(
    title: &str,
    versions: &[ApiVersion],
    frames: &[&str],
    definitions: &Map<String, Value>,
    catalog: Value,
) -> String {
    serde_json::to_string_pretty(&json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": title,
        "description": "A single JSON-RPC 2.0 frame. Success result and change types are selected \
                        by the corresponding request or watch.",
        "api_versions": versions,
        "anyOf": frames.iter().map(|name| reference_to(name)).collect::<Vec<_>>(),
        "$defs": definitions,
        "x-facade": catalog,
    }))
    .unwrap()
        + "\n"
}

pub fn generate_daemon_files() -> Vec<(&'static str, String)> {
    let mut types = SchemaRegistry::new();
    let hello = types.add::<daemon::HelloParams>();
    let hello_result = types.add::<daemon::HelloResult>();
    let error = types.add::<ErrorBody>();
    let empty = types.add::<EmptyResult>();
    let no_args = types.add::<NoArgs>();
    let watch_result = types.add::<daemon::WatchResult>();
    let forward_watch_result = types.add::<daemon::ForwardWatchResult>();
    let _ = types.add::<daemon::ForwardParams>();
    let unwatch = types.add::<daemon::UnwatchParams>();
    let cancel = types.add::<daemon::CancelParams>();
    let changed = types.add::<daemon::ChangedParams>();
    let watch_ended = types.add::<daemon::WatchEndedParams>();
    let closing = types.add::<daemon::ClosingParams>();
    let advertise = types.add::<daemon::AdvertiseParams>();
    let sleeping = types.add::<daemon::MachineSleepingParams>();
    let connected = types.add::<daemon::ConnectedParams>();
    let connect_failed = types.add::<daemon::ConnectFailedParams>();
    let agent_state = types.add::<daemon::AgentState>();
    let _ = types.add::<api_v1::ProtocolMismatchDetails>();
    let _ = types.add::<api_v1::Request>();
    let _ = types.add::<api_v1::Notification>();
    let _ = types.add::<api_v1::Response>();

    let mut ops = OperationDocs(&mut types, Vec::new());
    daemon::visit_operations(&mut ops);
    let ops = ops.1;
    let mut topics = TopicDocs(&mut types, Vec::new());
    daemon::visit_topics(&mut topics);
    let topics = topics.1;

    let mut definitions = types.definitions();
    alias(&mut definitions, "DaemonHelloParams", &hello);
    alias(&mut definitions, "DaemonHelloResult", &hello_result);
    alias(&mut definitions, "AgentState", &agent_state);
    definitions.insert("CallParams".into(), call_schema(&ops));
    definitions.insert("WatchParams".into(), watch_schema(&topics));
    specialize_member(
        &mut definitions,
        &watch_result,
        "snapshot",
        topic_variants(&topics, |t| &t.snapshot),
    );
    specialize_member(
        &mut definitions,
        &forward_watch_result,
        "snapshot",
        topic_variants(&topics, |t| &t.snapshot),
    );
    specialize_member(
        &mut definitions,
        &changed,
        "change",
        topic_variants(&topics, |t| &t.change),
    );

    // The TypeScript transport reads generic frames before matching the operation or topic.
    // The schema's endpoint-specific frames below enforce the allowed wire shapes.
    definitions.sort_keys();
    let type_definitions = definitions.clone();

    let calls = call_schema(ops.iter().filter(|op| !op.access.unwrap().local.is_empty()));
    let watches = watch_schema(topics.iter().filter(|topic| !topic.access.local.is_empty()));
    let forward_calls = call_schema(ops.iter().filter(|op| op.access.unwrap().forwarded));
    let forward_watches = watch_schema(topics.iter().filter(|topic| topic.access.forwarded));
    // Preserve the derived strict flattened object and specialize each variant's params.
    let mut forwarded = definitions["ForwardParams"].clone();
    for variant in forwarded["oneOf"].as_array_mut().unwrap() {
        variant["properties"]["params"] = match variant["properties"]["method"]["const"].as_str() {
            Some(daemon::methods::CALL) => forward_calls.clone(),
            Some(daemon::methods::WATCH) => forward_watches.clone(),
            _ => unreachable!("forward accepts only a call or watch"),
        };
    }
    let raw = json!({
        "properties": {
            "args": {
                "properties": {
                    "target": { "type": "object" },
                    "input": { "properties": { "kind": { "const": "raw" } } },
                },
            },
        },
    });
    let resize = call_schema(ops.iter().filter(|op| op.name == "attach.resize"));
    let raw_call = call_schema(ops.iter().filter(|op| op.name == "agent.type"));
    let call_notification = json!({ "anyOf": [resize, { "allOf": [raw_call, raw] }] });

    // The relay DTO belongs to the independent outer relay. The relay writes cwd as null when
    // its working directory is unavailable.
    let mut relay = object(json!({
        "relay": { "const": 1 },
        "args": { "type": "array", "items": { "type": "string" } },
        "env": { "type": "object", "additionalProperties": { "type": "string" } },
        "cwd": { "type": ["string", "null"] },
        "reconnect": { "type": "boolean" },
    }));
    relay["required"]
        .as_array_mut()
        .unwrap()
        .retain(|name| name != "cwd");

    definitions.extend(
        [
            ("LocalClientRequest", json!({ "oneOf": [
                request("hello", hello.clone(), true),
                request("call", calls, true),
                request("watch", watches, true),
                request("unwatch", unwatch.clone(), true),
                request("cancel", cancel.clone(), true),
            ] })),
            ("LocalClientNotification", json!({ "oneOf": [
                request("call", call_notification, false),
                request("cancel", cancel.clone(), false),
                request("closing", no_args.clone(), false),
            ] })),
            ("MachineRequest", json!({ "oneOf": [
                request("hello", json!({ "allOf": [hello, { "properties": { "kind": { "const": "machine" } }, "required": ["machine"] }] }), true),
                request("advertise", advertise.clone(), true),
                request("forward", forwarded, true),
                request("unwatch", unwatch, true),
                request("cancel", cancel.clone(), true),
            ] })),
            ("MachineNotification", json!({ "oneOf": [
                request("advertise", advertise, false),
                request("machine.sleeping", sleeping, false),
                request("cancel", cancel, false),
                request("changed", changed.clone(), false),
                request("watch_ended", watch_ended.clone(), false),
            ] })),
            ("DaemonNotification", json!({ "oneOf": [
                request("changed", changed, false),
                request("watch_ended", watch_ended, false),
                request("closing", closing, false),
                request("connected", connected, false),
                request("connect_failed", connect_failed, false),
            ] })),
            ("RelayHelloRequest", request("hello", relay, true)),
            ("RelayHelloResponse", response(object(json!({ "relay": { "const": 1 } })))),
            ("SuccessResponse", response(success_types(&ops, [hello_result, empty, watch_result, forward_watch_result]))),
            ("ErrorResponse", error_response(error)),
        ]
        .into_iter()
        .map(|(name, schema)| (name.to_owned(), schema)),
    );
    definitions.sort_keys();

    let schema = schema_file(
        "Facade daemon API",
        daemon::SUPPORTED_API_VERSIONS,
        &[
            "LocalClientRequest",
            "MachineRequest",
            "SuccessResponse",
            "ErrorResponse",
            "LocalClientNotification",
            "MachineNotification",
            "DaemonNotification",
            "RelayHelloRequest",
            "RelayHelloResponse",
        ],
        &definitions,
        json!({
            "operations": operation_catalog(&ops), "topics": topic_catalog(&topics),
            "methods": DAEMON_METHODS.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        }),
    );
    let intro = daemon_guide();
    let md = render_reference(
        "Facade daemon API",
        &intro,
        DAEMON_METHODS,
        &topics,
        &ops,
        &type_definitions,
        DAEMON_REASONS,
    );
    vec![
        ("protocol.schema.json", schema),
        (
            "protocol.ts",
            typescript_file(&type_definitions, &ops, &topics),
        ),
        ("PROTOCOL.md", md),
    ]
}

fn daemon_guide() -> String {
    include_str!("../../src/protocol/guide.md")
        .trim_end()
        .replace(
            "@DAEMON_API_VERSIONS@",
            &json!(daemon::SUPPORTED_API_VERSIONS).to_string(),
        )
        .replace(
            "@KEEPER_API_VERSIONS@",
            &json!(keeper::SUPPORTED_API_VERSIONS).to_string(),
        )
        .replace(
            "@TERMINAL_OPS@",
            &json!(daemon::operation_names(daemon::ClientKind::Terminal)).to_string(),
        )
        .replace(
            "@TERMINAL_TOPICS@",
            &json!(daemon::topic_names(daemon::ClientKind::Terminal)).to_string(),
        )
        .replace(
            "@MACHINE_OPS@",
            &json!(daemon::operation_names(daemon::ClientKind::Machine)).to_string(),
        )
        .replace(
            "@MACHINE_TOPICS@",
            &json!(daemon::topic_names(daemon::ClientKind::Machine)).to_string(),
        )
}

pub fn generate_keeper_files() -> Vec<(&'static str, String)> {
    let mut types = SchemaRegistry::new();
    let hello = types.add::<keeper::HelloParams>();
    let hello_result = types.add::<keeper::HelloResult>();
    let start_result = types.add::<keeper::StartResult>();
    let error = types.add::<ErrorBody>();
    let empty = types.add::<EmptyResult>();
    let changed = types.add::<keeper::AgentChange>();
    let _ = types.add::<api_v1::ProtocolMismatchDetails>();

    let mut ops = OperationDocs(&mut types, Vec::new());
    keeper::visit_operations(&mut ops);
    let ops = ops.1;
    let mut definitions = types.definitions();
    let mut type_definitions = definitions.clone();
    let sync = call_schema(ops.iter().filter(|op| op.name == "agent.sync"));
    let handle = json!({ "type": "integer", "minimum": 1, "maximum": i64::MAX });
    let mut windows_terminal = object(json!({
        "input": handle, "output": handle, "job": handle, "signal": handle,
    }));
    windows_terminal["required"]
        .as_array_mut()
        .unwrap()
        .retain(|name| name != "signal");
    type_definitions.insert("WindowsTerminal".into(), windows_terminal.clone());
    type_definitions.sort_keys();
    definitions.extend(
        [
            ("KeeperRequest", json!({ "oneOf": [request("hello", hello, true), request("call", call_schema(&ops), true)] })),
            ("KeeperNotification", request("changed", changed, false)),
            ("SuccessResponse", response(success_types(&ops, [hello_result]))),
            ("ErrorResponse", error_response(error)),
            ("WindowsTerminal", windows_terminal),
            ("WindowsSyncRequest", with_terminal(request("call", sync, true))),
            ("WindowsStartResponse", with_terminal(response(start_result))),
            ("WindowsSyncResponse", with_terminal(response(empty))),
        ]
        .into_iter()
        .map(|(name, schema)| (name.to_owned(), schema)),
    );
    // EmptyResult tolerates future result members, so the two Windows responses are selected
    // using the originating operation, not by matching the response's shape alone.
    definitions.sort_keys();
    let schema = schema_file(
        "Facade keeper API",
        keeper::SUPPORTED_API_VERSIONS,
        &[
            "KeeperRequest",
            "KeeperNotification",
            "SuccessResponse",
            "ErrorResponse",
            "WindowsSyncRequest",
            "WindowsStartResponse",
            "WindowsSyncResponse",
        ],
        &definitions,
        json!({
            "operations": operation_catalog(&ops),
            "methods": keeper::METHODS.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        }),
    );
    let intro = include_str!("../../src/protocol/keeper-guide.md")
        .trim_end()
        .replace(
            "@KEEPER_API_VERSIONS@",
            &json!(keeper::SUPPORTED_API_VERSIONS).to_string(),
        );
    let md = render_reference(
        "Facade keeper API",
        &intro,
        keeper::METHODS,
        &[],
        &ops,
        &type_definitions,
        KEEPER_REASONS,
    );
    vec![("keeper.schema.json", schema), ("KEEPER.md", md)]
}
