//! Generates JSON Schema, TypeScript types, and protocol references from Rust types.

use std::collections::BTreeSet;

use facade_base::daemon::{
    self, ChangedParams, ClientKind, HelloParams, HelloResult, KeeperInfo, UnwatchParams,
    WatchEndedParams, WatchParams, WatchResult,
};
use facade_base::jsonrpc::{
    ErrorBody, ErrorData, MachineMessage, Notification, Reason, Request, Response, ServerMessage,
};
use facade_base::operations::{CallParams, Operation, OperationVisitor, Topic, TopicVisitor};
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::{keeper, machine, v3};
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
        });
    }
}

pub struct TopicDoc {
    name: &'static str,
    doc: &'static str,
    args: Value,
    snapshot: Value,
    change: Value,
}

pub struct TopicDocs<'a>(&'a mut SchemaRegistry, Vec<TopicDoc>);

impl TopicVisitor for TopicDocs<'_> {
    fn topic<T: Topic>(&mut self) {
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
                "type": "object", "properties": { "op": { "const": op.name }, "args": op.args },
                "required": ["op", "args"],
            })
        })
        .collect();
    json!({ "oneOf": calls })
}

/// Specializes call arguments, watch arguments, snapshots, and changes for each operation or topic.
pub fn specialize_operation_and_topic_schemas(
    definitions: &mut Map<String, Value>,
    ops: &[OperationDoc],
    topics: &[TopicDoc],
) {
    let description = |definitions: &Map<String, Value>, name: &str| {
        definitions
            .get(name)
            .and_then(|schema| schema.get("description"))
            .cloned()
    };
    let call = described(description(definitions, "CallParams"), call_schema(ops));
    definitions.insert("CallParams".into(), call);
    let watches: Vec<Value> = topics
        .iter()
        .map(|topic| {
            // Topics with no arguments may omit the args field.
            let required = if topic
                .args
                .get("$ref")
                .and_then(Value::as_str)
                .is_some_and(|name| name.ends_with("/NoArgs"))
            {
                json!(["topic"])
            } else {
                json!(["topic", "args"])
            };
            json!({
                "type": "object",
                "properties": { "topic": { "const": topic.name }, "args": topic.args },
                "required": required,
            })
        })
        .collect();
    let watch = described(
        description(definitions, "WatchParams"),
        json!({ "oneOf": watches }),
    );
    definitions.insert("WatchParams".into(), watch);
    let snapshots: Vec<Value> = topics.iter().map(|topic| topic.snapshot.clone()).collect();
    let changes: Vec<Value> = topics.iter().map(|topic| topic.change.clone()).collect();
    for (name, field, choices) in [
        ("WatchResult", "snapshot", snapshots),
        ("ChangedParams", "change", changes),
    ] {
        let property = definitions
            .get_mut(name)
            .and_then(|schema| schema.pointer_mut(&format!("/properties/{field}")))
            .expect("expected the schema field");
        *property = described(
            property.get("description").cloned(),
            // The watch ID supplies the topic. Changes such as "removed" can otherwise overlap.
            json!({ "anyOf": choices }),
        );
    }
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
            // A map with string keys and typed values.
            (None, Some(values)) if values.is_object() => {
                format!("{{ readonly [key: string]: {} }}", typescript_type(values))
            }
            // An object with no fields.
            (None, None) => "Record<string, never>".into(),
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
        "export const PROTOCOL = {};\nexport const OLDEST_PROTOCOL = {};\n",
        v3::DAEMON_PROTOCOL_RANGE[1],
        v3::DAEMON_PROTOCOL_RANGE[0],
    ));
    let methods: Vec<&str> = daemon::METHODS.iter().map(|(name, _)| *name).collect();
    out.push_str(&format!(
        "export const METHODS = {} as const;\n",
        json!(methods)
    ));
    out.push_str(&format!(
        "export const TOPICS = {} as const;\n",
        json!(v3::topic_names())
    ));
    out.push_str(&format!(
        "export const OPS = {} as const;\n",
        json!(v3::operation_names())
    ));
    out.push_str(
        "export type Topic = typeof TOPICS[number];\nexport type Operation = keyof Operations;\n\
         export type Operations = V3Operations;\nexport type Topics = V3Topics;\n\
         export type V3Topic = keyof V3Topics;\nexport type V3Operation = keyof V3Operations;\n",
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
        "\n/** Argument and result types for each operation. */\nexport interface V3Operations {\n",
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
         */\nexport interface V3Topics {\n",
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
pub fn reasons(definitions: &Map<String, Value>) -> Vec<(String, String)> {
    let reason = &definitions["Reason"];
    let choices = reason
        .get("oneOf")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("expected documented error reasons: {reason}"));
    choices
        .iter()
        .map(|choice| {
            let name = choice
                .get("const")
                .and_then(Value::as_str)
                .expect("error reason must be a string");
            (
                name.to_string(),
                choice
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect()
}

/// Writes a field table for each object type.
pub fn type_tables(out: &mut String, definitions: &Map<String, Value>) {
    out.push_str("\n## Types\n");
    for (name, schema) in definitions
        .iter()
        .filter(|(name, _)| !name.starts_with("V2"))
    {
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
    reasons: (&str, &[(String, String)]),
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
             | Arguments | Snapshot | Change | Description |\n|---|---|---|---|---|\n",
        );
        for topic in topics {
            out.push_str(&format!(
                "| `{}` | `{}` | `{}` | `{}` | {} |\n",
                topic.name,
                markdown_cell(&typescript_type(&topic.args)),
                markdown_cell(&typescript_type(&topic.snapshot)),
                markdown_cell(&typescript_type(&topic.change)),
                markdown_cell(topic.doc)
            ));
        }
    }
    out.push_str(
        "\n## Operations\n\nOperations available to `call`. Set `op` to the name and `args` to its \
         arguments. Types are defined below.\n\n| Name | Arguments | Result | Description |\n\
         |---|---|---|---|\n",
    );
    for op in ops {
        out.push_str(&format!(
            "| `{}` | `{}` | `{}` | {} |\n",
            op.name,
            markdown_cell(&typescript_type(&op.args)),
            markdown_cell(&typescript_type(&op.result)),
            markdown_cell(op.doc)
        ));
    }
    let (which, reasons) = reasons;
    out.push_str(&format!(
        "\n## Error reasons\n\n{which}\n\n| Reason | When |\n|---|---|\n"
    ));
    for (name, doc) in reasons {
        out.push_str(&format!("| `{name}` | {} |\n", markdown_cell(doc)));
    }
    type_tables(&mut out, definitions);
    out
}

fn reference_to(name: &str) -> Value {
    json!({ "$ref": format!("#/$defs/{name}") })
}

/// Retain the old daemon types used by takeover and the legacy editor fixtures. Ordinary v2
/// operations and topics are no longer advertised.
fn compatibility_definitions(normal: &mut Map<String, Value>) {
    let mut types = SchemaRegistry::new();
    let _ = types.add::<HelloParams>();
    let _ = types.add::<HelloResult>();
    let _ = types.add::<WatchParams>();
    let _ = types.add::<WatchResult>();
    let _ = types.add::<ChangedParams>();
    let _ = types.add::<daemon::AgentStartWireArgs>();
    let _ = types.add::<daemon::AgentStartResult>();
    let _ = types.add::<machine::MachineInfo>();
    let mut calls = OperationDocs(&mut types, Vec::new());
    calls.operation::<daemon::DaemonUpgrade>();
    calls.operation::<machine::AgentList>();
    let calls = calls.1;
    let mut topics = TopicDocs(&mut types, Vec::new());
    topics.topic::<daemon::WindowsTopic>();
    let topics = topics.1;
    let mut legacy = types.definitions();
    specialize_operation_and_topic_schemas(&mut legacy, &calls, &topics);
    let versioned: BTreeSet<String> = legacy
        .iter()
        .filter(|(name, schema)| normal.get(name.as_str()) != Some(*schema))
        .map(|(name, _)| name.clone())
        .collect();
    for (name, mut schema) in legacy {
        if versioned.contains(&name) {
            version_legacy_references(&mut schema, &versioned);
            normal.insert(format!("V2{name}"), schema);
        }
    }
}

fn version_legacy_references(schema: &mut Value, versioned: &BTreeSet<String>) {
    match schema {
        Value::Array(items) => {
            for item in items {
                version_legacy_references(item, versioned);
            }
        }
        Value::Object(fields) => {
            if let Some(reference) = fields.get_mut("$ref")
                && let Some(name) = reference.as_str().and_then(|s| s.strip_prefix("#/$defs/"))
                && versioned.contains(name)
            {
                *reference = Value::String(format!("#/$defs/V2{name}"));
            }
            for field in fields.values_mut() {
                version_legacy_references(field, versioned);
            }
        }
        _ => {}
    }
}

/// Generates the daemon protocol schema, TypeScript types, and reference.
pub fn generate_daemon_files() -> Vec<(&'static str, String)> {
    let mut types = SchemaRegistry::new();
    macro_rules! add {
        ($($t:ty),* $(,)?) => { $( let _ = types.add::<$t>(); )* };
    }
    add!(
        Request,
        Response,
        Notification,
        ServerMessage,
        MachineMessage,
        ErrorBody,
        ErrorData,
        Reason,
        v3::HelloParams,
        ClientKind,
        HelloResult,
        KeeperInfo,
        CallParams,
        WatchParams,
        WatchResult,
        UnwatchParams,
        ChangedParams,
        WatchEndedParams,
        machine::ConnectedParams,
        machine::ConnectFailedParams
    );
    add!(
        ProcessState,
        ProcessExit,
        v3::AgentTarget,
        v3::AgentListRow,
        v3::AdvertiseParams,
        v3::ForwardParams,
        v3::ForwardCall,
        v3::ReadMessagesArgs,
        v3::ReadMessagesResult,
    );
    let mut ops = OperationDocs(&mut types, Vec::new());
    v3::visit_operations(&mut ops);
    let ops = ops.1;
    let mut v3_internal = OperationDocs(&mut types, Vec::new());
    v3::visit_internal_operations(&mut v3_internal);
    let v3_internal = v3_internal.1;
    let mut topics = TopicDocs(&mut types, Vec::new());
    v3::visit_topics(&mut topics);
    let topics = topics.1;
    let mut definitions = types.definitions();
    specialize_operation_and_topic_schemas(&mut definitions, &ops, &topics);
    definitions.insert(
        "V3CallParams".into(),
        call_schema(ops.iter().chain(&v3_internal)),
    );
    definitions
        .get_mut("V3ForwardCall")
        .and_then(|schema| schema.pointer_mut("/properties/call"))
        .expect("forwarded calls have a call field")
        .clone_from(&reference_to("V3CallParams"));
    // The ordinary hello and error envelopes carry v3 fields.
    for (name, legacy_fields) in [
        ("HelloResult", &["window", "agent"][..]),
        ("ErrorData", &["windows", "window_delivery"][..]),
        ("Unavailable", &["window"][..]),
    ] {
        let properties = definitions
            .get_mut(name)
            .and_then(|schema| schema["properties"].as_object_mut())
            .expect("expected the envelope fields");
        for field in legacy_fields {
            properties.remove(*field);
        }
    }
    for name in ["WindowDelivery", "WindowDeliveryFailure", "WindowRef"] {
        definitions.remove(name);
    }
    compatibility_definitions(&mut definitions);
    let aliases: Vec<(String, Value)> = definitions
        .keys()
        .filter_map(|name| {
            let short = name.strip_prefix("V3")?;
            (!definitions.contains_key(short)).then(|| (short.to_owned(), reference_to(name)))
        })
        .collect();
    definitions.extend(aliases);
    definitions.sort_keys();
    let schema = serde_json::to_string_pretty(&json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Facade daemon protocol",
        "description": "The daemon protocol uses JSON-RPC 2.0, one message per line: hello, \
                        call, watch, unwatch, and changed notifications. Clients skip unknown \
                        change kinds.",
        "protocol": v3::DAEMON_PROTOCOL_RANGE[1],
        "oldest_protocol": v3::DAEMON_PROTOCOL_RANGE[0],
        "methods": daemon::METHODS.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        "topics": v3::topic_names(),
        "ops": v3::operation_names(),
        "$defs": definitions,
    }))
    .expect("schema must serialize")
        + "\n";
    let intro = format!(
        "Ordinary daemon protocol version {} (oldest ordinary version {}). See `protocol.schema.json` \
         for JSON Schema and `protocol.ts` for TypeScript types.\n\n\
         [Version 2 takeover and old data](#version-2-takeover-and-old-data) describes the separate \
         compatibility connection.\n\n{}",
        v3::DAEMON_PROTOCOL_RANGE[1],
        v3::DAEMON_PROTOCOL_RANGE[0],
        include_str!("../../src/protocol/guide.md").trim_end()
    );
    let md = render_reference(
        "Facade daemon protocol",
        &intro,
        daemon::METHODS,
        &topics,
        &ops,
        &definitions,
        (
            "The `data.reason` values of the daemon protocol.",
            &reasons(&definitions),
        ),
    );
    vec![
        ("protocol.schema.json", schema),
        ("protocol.ts", typescript_file(&definitions, &ops, &topics)),
        ("PROTOCOL.md", md),
    ]
}

/// The reasons the keeper sends, in its own words.
fn keeper_reasons() -> Vec<(String, String)> {
    [
        (
            "invalid_argument",
            "A malformed request, an unknown operation, a second hello or a call before hello, an \
             empty command, an agent the keeper already holds a CLI for, or a sync whose process \
             is not the one held.",
        ),
        ("not_found", "The keeper holds no CLI for the agent."),
        (
            "unavailable",
            "The PTY, the program, the folder, the CLI's birth, or a copy of the master could not \
             be had.",
        ),
        (
            "protocol_incompatible",
            "The daemon's version range and the keeper's share no version.",
        ),
        (
            "capacity_exceeded",
            "A line is longer than the protocol allows.",
        ),
    ]
    .into_iter()
    .map(|(name, doc)| (name.to_string(), doc.to_string()))
    .collect()
}

/// Generates the keeper protocol reference.
pub fn generate_keeper_reference() -> (&'static str, String) {
    let mut types = SchemaRegistry::new();
    let _ = types.add::<keeper::KeeperHelloParams>();
    let _ = types.add::<keeper::KeeperHelloResult>();
    let _ = types.add::<keeper::KeeperAgentChange>();
    let mut ops = OperationDocs(&mut types, Vec::new());
    keeper::visit_operations(&mut ops);
    let ops = ops.1;
    let definitions = types.definitions();
    let intro = format!(
        r#"Protocol version {} (oldest accepted: {}). Version 1 is frozen: later versions only add optional fields, and every
daemon keeps speaking version 1.

The keeper protocol connects the daemon and the keeper over JSON-RPC 2.0, one message per line, on the keeper's socket,
`keeper-<key>.sock` beside the daemon's, its key reckoned as in the [daemon protocol](PROTOCOL.md). Framing and error reasons are
the same as there. Unknown fields are ignored; an unknown operation is `invalid_argument`.

The keeper is the parent of the CLIs, holds a copy of each CLI's PTY master so a terminal outlives any daemon, and watches the
daemon, which it starts from the launcher and starts again. It runs on one thread.

## Connect

The keeper checks its peer through the kernel as it accepts the connection: its user ID must be this user's, and its process ID
and birth must match the daemon lock's record (`core/daemon.lock`). Any other peer is closed at once. A connection it accepts
replaces the one before. Send `hello` first with the daemon's version range; the keeper answers with its own range and the CLIs
it holds, and each side speaks the highest version both ranges share.

`agent.start` answers with the CLI's PTY master, passed with `SCM_RIGHTS`. `agent.sync` passes a master from the side that has it
to the side that lacks it, one agent at a time: after the daemon restarts, it asks for each CLI's; after a keeper ends, the
daemon gives each to the keeper it starts next.

## CLIs

Once a CLI ends, the keeper sends `changed` where a daemon is connected, reaps the CLI, closes its master and forgets it. Only
the keeper that started a CLI has its exit code or signal; a CLI it holds from `agent.sync` ends without either, and a daemon
that misses the notification finds the agent gone from the next hello.

`agent.stop` sends SIGHUP to the CLI's process group and answers. Once the CLI ends or 3 seconds pass, whichever comes first,
the group gets SIGKILL; a repeated stop keeps the first deadline. A signal needs the group's leader proved by its process ID,
birth and group: an unreaped leader keeps its IDs, and a group whose leader cannot be proved gets no signal. A CLI that ends by
itself leaves alone the processes it left behind, as closing a terminal does. On SIGTERM or SIGINT, the keeper sends SIGKILL to
the groups it is stopping, and exits.

## The daemon

The daemon pings once a second from its hello on. After 15 seconds without a ping, the keeper ends it with SIGKILL. Once the
daemon ends, a keeper holding CLIs starts the launcher's daemon again after a delay that starts at 0.5 seconds and doubles up to
30 seconds, starting over after a daemon that ran 60 seconds; a keeper holding none exits.

For example, to stop agent `a1`:

```json
{{"jsonrpc":"2.0","id":2,"method":"call","params":{{"op":"agent.stop","args":{{"agent":"a1"}}}}}}
```"#,
        keeper::KEEPER_PROTOCOL_VERSION,
        keeper::MIN_KEEPER_PROTOCOL_VERSION
    );
    (
        "KEEPER.md",
        render_reference(
            "Facade keeper protocol",
            &intro,
            keeper::METHODS,
            &[],
            &ops,
            &definitions,
            (
                "The `data.reason` values the keeper sends.",
                &keeper_reasons(),
            ),
        ),
    )
}
