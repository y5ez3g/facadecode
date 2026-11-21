//! JSON-RPC 2.0 envelopes and bounded line readers.

#![allow(
    clippy::result_large_err,
    reason = "The wire API returns the structured error by value"
)]

use std::fmt;
use std::io::{self, BufRead, Read};
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{DeserializeOwned, IgnoredAny, MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::{Map, Value};

use super::daemon::AgentLabel;
use super::versions::ApiVersions;

pub use crate::jsonrpc::{MAX_LINE_BYTES, encode_line};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
enum JsonRpc {
    #[serde(rename = "2.0")]
    V2,
}

fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}

// Only omission supplies None. A present member must decode as its declared type.
pub(super) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

// Serde structs also accept sequences by default. Wire records must be objects.
pub(super) fn object_only<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    struct Object<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for Object<T> {
        type Value = T;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an object")
        }

        fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<T, M::Error> {
            T::deserialize(MapAccessDeserializer::new(map))
        }
    }

    deserializer.deserialize_map(Object(PhantomData))
}

// Shared result records accept additive fields. Requests opt in to a closed record.
pub(super) fn input_record<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
    fields: &'static [&'static str],
) -> Result<T, D::Error> {
    let object = Map::<String, Value>::deserialize(deserializer)?;
    if let Some(field) = object
        .keys()
        .find(|field| !fields.contains(&field.as_str()))
    {
        return Err(de::Error::unknown_field(field, fields));
    }
    serde_json::from_value(Value::Object(object)).map_err(de::Error::custom)
}

pub(super) fn input_record_schema<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    let mut schema = T::json_schema(generator);
    schema.insert("additionalProperties".into(), Value::Bool(false));
    schema
}

pub(super) fn present_object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    object_only(deserializer).map(Some)
}

pub(super) fn empty_variant<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    NoArgs::deserialize(deserializer).map(|_| ())
}

pub(super) fn object<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
    Map::<String, Value>::deserialize(deserializer).map(Value::Object)
}

pub(super) fn object_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "object" })
}

// A flattened discriminated body contributes fields in its own schema branch.
pub(super) fn strict_flattened_object(schema: &mut Schema) {
    schema.insert("unevaluatedProperties".into(), Value::Bool(false));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Size {
    #[schemars(range(min = 2))]
    pub cols: u16,
    #[schemars(range(min = 1))]
    pub rows: u16,
}

impl<'de> Deserialize<'de> for Size {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            cols: u16,
            rows: u16,
        }

        let Fields { cols, rows } = object_only(deserializer)?;
        if cols < 2 || rows == 0 {
            return Err(de::Error::custom(
                "size requires at least 2 columns and 1 row",
            ));
        }
        Ok(Self { cols, rows })
    }
}

pub(super) fn size_input<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Size, D::Error> {
    input_record(deserializer, &["cols", "rows"])
}

pub(super) fn size_input_schema(generator: &mut SchemaGenerator) -> Schema {
    input_record_schema::<Size>(generator)
}

#[derive(Clone, Copy, Debug, Default, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NoArgs {}

impl<'de> Deserialize<'de> for NoArgs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {}

        object_only::<_, Fields>(deserializer).map(|_| Self {})
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CallParams {
    pub op: String,
    #[serde(deserialize_with = "object")]
    #[schemars(schema_with = "object_schema")]
    pub args: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorBody {
    pub code: i64,
    pub message: String,
    pub data: ErrorData,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorData {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProtocolMismatchDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offered_api_versions: Option<ApiVersions>,
    pub supported_api_versions: ApiVersions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentLabel>>,
}

impl ErrorBody {
    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(-32700, "invalid_argument", message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(-32600, "invalid_argument", message)
    }

    pub fn method_not_found(message: impl Into<String>) -> Self {
        Self::new(-32601, "invalid_argument", message)
    }

    pub fn line_too_long() -> Self {
        Self::new(
            -32000,
            "capacity_exceeded",
            format!("line exceeds the {MAX_LINE_BYTES}-byte limit"),
        )
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(-32602, "invalid_argument", message)
    }

    pub fn protocol_incompatible(
        message: impl Into<String>,
        details: ProtocolMismatchDetails,
    ) -> Self {
        let mut error = Self::new(-32000, "protocol_incompatible", message);
        error.data.details = Some(
            serde_json::to_value(details)
                .and_then(serde_json::from_value)
                .expect("protocol mismatch details must serialize as an object"),
        );
        error
    }

    pub(super) fn new(code: i64, reason: &str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: ErrorData {
                reason: reason.to_owned(),
                details: None,
            },
        }
    }
}

impl fmt::Display for ErrorBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.data.reason)
    }
}

impl std::error::Error for ErrorBody {}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    jsonrpc: JsonRpc,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u64")]
    pub id: Option<u64>,
    pub method: String,
    pub params: Value,
}

impl Request {
    pub fn new(id: Option<u64>, method: &str, params: impl Serialize) -> Self {
        Self {
            jsonrpc: JsonRpc::V2,
            id,
            method: method.to_owned(),
            params: to_json(params),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Notification {
    jsonrpc: JsonRpc,
    pub method: String,
    pub params: Value,
}

impl Notification {
    pub fn new(method: &str, params: impl Serialize) -> Self {
        Self {
            jsonrpc: JsonRpc::V2,
            method: method.to_owned(),
            params: to_json(params),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Response {
    jsonrpc: JsonRpc,
    pub id: Option<u64>,
    #[serde(flatten)]
    pub body: ResponseBody,
}

impl JsonSchema for Response {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Response".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let jsonrpc = generator.subschema_for::<JsonRpc>();
        let error = generator.subschema_for::<ErrorBody>();
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["jsonrpc", "id", "result"],
                    "properties": {
                        "jsonrpc": jsonrpc.clone(),
                        "id": { "type": "integer", "minimum": 0, "maximum": u64::MAX },
                        "result": true
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["jsonrpc", "id", "error"],
                    "properties": {
                        "jsonrpc": jsonrpc,
                        "id": { "type": ["integer", "null"], "minimum": 0, "maximum": u64::MAX },
                        "error": error
                    }
                }
            ]
        })
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResponseBody {
    Result(Value),
    Error(ErrorBody),
}

impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            jsonrpc: JsonRpc,
            id: Value,
            #[serde(default, deserialize_with = "present")]
            result: Option<Value>,
            #[serde(default, deserialize_with = "present")]
            error: Option<ErrorBody>,
        }

        let Fields {
            jsonrpc,
            id,
            result,
            error,
        } = object_only(deserializer)?;
        let id = Option::<u64>::deserialize(id).map_err(de::Error::custom)?;
        let body = match (result, error) {
            (Some(result), None) if id.is_some() => ResponseBody::Result(result),
            (Some(_), None) => {
                return Err(de::Error::custom(
                    "a successful response requires an integer ID",
                ));
            }
            (None, Some(error)) => ResponseBody::Error(error),
            _ => {
                return Err(de::Error::custom(
                    "a response must have exactly one of result and error",
                ));
            }
        };
        Ok(Self { jsonrpc, id, body })
    }
}

impl Response {
    pub fn ok(id: u64, result: impl Serialize) -> Self {
        Self {
            jsonrpc: JsonRpc::V2,
            id: Some(id),
            body: ResponseBody::Result(to_json(result)),
        }
    }

    pub fn failed(id: Option<u64>, error: ErrorBody) -> Self {
        Self {
            jsonrpc: JsonRpc::V2,
            id,
            body: ResponseBody::Error(error),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ServerMessage {
    Response(Response),
    Notification(Notification),
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MachineMessage {
    Request(Request),
    Response(Response),
}

#[derive(Clone, Debug)]
pub struct MalformedRequest {
    pub id: Option<u64>,
    pub error: ErrorBody,
}

#[derive(Clone, Debug)]
pub enum RequestRead {
    Request(Request),
    Malformed(MalformedRequest),
    LineTooLong(ErrorBody),
    Eof,
}

fn read_line(reader: &mut impl BufRead, buffer: &mut Vec<u8>) -> io::Result<()> {
    buffer.clear();
    reader
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', buffer)?;
    Ok(())
}

pub fn read_request<R: BufRead>(reader: &mut R, buffer: &mut Vec<u8>) -> io::Result<RequestRead> {
    read_line(reader, buffer)?;
    Ok(if buffer.is_empty() {
        RequestRead::Eof
    } else if buffer.len() > MAX_LINE_BYTES {
        RequestRead::LineTooLong(ErrorBody::line_too_long())
    } else {
        match parse_request(buffer) {
            Ok(request) => RequestRead::Request(request),
            Err(error) => RequestRead::Malformed(error),
        }
    })
}

fn is_object(line: &[u8]) -> bool {
    line.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{')
}

pub fn parse_request(line: &[u8]) -> Result<Request, MalformedRequest> {
    if line.len() > MAX_LINE_BYTES {
        return Err(MalformedRequest {
            id: None,
            error: ErrorBody::line_too_long(),
        });
    }
    if is_object(line) {
        match serde_json::from_slice(line) {
            Ok(request) => return Ok(request),
            Err(error) if error.is_data() => {}
            Err(error) => {
                return Err(MalformedRequest {
                    id: None,
                    error: ErrorBody::parse_error(format!("not JSON: {error}")),
                });
            }
        }
    }
    if let Err(error) = std::str::from_utf8(line) {
        return Err(MalformedRequest {
            id: None,
            error: ErrorBody::parse_error(format!("not UTF-8: {error}")),
        });
    }
    if let Err(error) = serde_json::from_slice::<IgnoredAny>(line) {
        return Err(MalformedRequest {
            id: None,
            error: ErrorBody::parse_error(format!("not JSON: {error}")),
        });
    }
    Err(MalformedRequest {
        id: if is_object(line) {
            recover_id(line)
        } else {
            None
        },
        error: ErrorBody::invalid_request("not a JSON-RPC 2.0 request"),
    })
}

// Recover only from a complete request object with unambiguous routing fields.
fn recover_id(line: &[u8]) -> Option<u64> {
    #[derive(Deserialize)]
    struct Routing {
        #[serde(rename = "jsonrpc")]
        _jsonrpc: JsonRpc,
        #[serde(rename = "method")]
        _method: String,
        id: u64,
        #[serde(default, deserialize_with = "present")]
        result: Option<IgnoredAny>,
        #[serde(default, deserialize_with = "present")]
        error: Option<IgnoredAny>,
    }

    let routing: Routing = serde_json::from_slice(line).ok()?;
    (routing.result.is_none() && routing.error.is_none()).then_some(routing.id)
}

pub fn read_server_message<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<Option<ServerMessage>> {
    read_message(reader, buffer)
}

pub fn read_machine_message<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<Option<MachineMessage>> {
    read_message(reader, buffer)
}

fn read_message<T: DeserializeOwned>(
    reader: &mut impl BufRead,
    buffer: &mut Vec<u8>,
) -> io::Result<Option<T>> {
    read_line(reader, buffer)?;
    if buffer.is_empty() {
        return Ok(None);
    }
    if buffer.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ErrorBody::line_too_long(),
        ));
    }
    if !is_object(buffer) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a JSON-RPC object",
        ));
    }
    serde_json::from_slice(buffer)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

pub fn decode_arguments<T: DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    if !params.is_object() {
        return Err(ErrorBody::invalid_argument("arguments must be an object"));
    }
    serde_json::from_value(params).map_err(|err| ErrorBody::invalid_argument(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_null_response_id_is_reserved_for_errors() {
        let success = br#"{"jsonrpc":"2.0","id":null,"result":{}}"#;
        assert!(serde_json::from_slice::<Response>(success).is_err());

        let failure = Response::failed(None, ErrorBody::invalid_request("invalid request"));
        let parsed: Response = serde_json::from_slice(&encode_line(&failure)).unwrap();
        assert_eq!(parsed.id, None);
        assert!(matches!(parsed.body, ResponseBody::Error(_)));
    }

    #[test]
    fn additive_fields_in_nested_replies_and_events_are_ignored() {
        use crate::api_v1::daemon::{ScreenChange, ScreenSnapshot, StartResult};
        use serde_json::json;

        let reference = json!({
            "machine_id": "11111111-1111-4111-8111-111111111111",
            "agent_id": "a1",
            "future_field": "label"
        });
        let size = json!({"cols": 80, "rows": 24, "future_field": 1});
        let snapshot: ScreenSnapshot = serde_json::from_value(json!({
            "reference": reference,
            "address": "a1",
            "size": size,
            "redraw": ""
        }))
        .unwrap();
        assert_eq!(snapshot.size, Size { cols: 80, rows: 24 });

        let redraw: ScreenChange = serde_json::from_value(json!({
            "kind": "redraw",
            "size": size,
            "data": ""
        }))
        .unwrap();
        assert!(matches!(
            redraw,
            ScreenChange::Redraw {
                size: Size { cols: 80, rows: 24 },
                ..
            }
        ));

        let result: StartResult = serde_json::from_value(json!({
            "agent": {
                "reference": reference,
                "address": "a1",
                "type": "managed",
                "name": "Nova",
                "cli": "fixture",
                "args": [],
                "cwd": "/work/app",
                "process": "running",
                "size": size,
                "created_at": "2026-11-20T17:00:00.000Z",
                "started_at": "2026-11-20T17:00:00.000Z",
                "root": reference,
                "yolo": false,
                "state": "working",
                "tools_state": "available"
            }
        }))
        .unwrap();
        assert_eq!(result.agent.reference.agent_id, "a1");
    }

    #[test]
    fn those_nested_fields_are_refused_in_requests() {
        use crate::api_v1::{daemon, keeper};
        use serde_json::json;

        let size = json!({"cols": 80, "rows": 24, "future_field": 1});
        let start = daemon::decode_call(
            CallParams {
                op: "agent.start".into(),
                args: json!({"cli": "fixture", "size": size}),
            },
            daemon::ClientKind::Terminal,
        );
        assert_eq!(start.unwrap_err().data.reason, "invalid_argument");

        let watch = daemon::decode_watch(
            daemon::WatchParams {
                topic: "attach".into(),
                args: json!({"target": {"machine_id": "11111111-1111-4111-8111-111111111111", "agent_id": "a1", "future_field": "label"}}),
            },
            daemon::ClientKind::Terminal,
        );
        assert_eq!(watch.unwrap_err().data.reason, "invalid_argument");

        let start = keeper::decode_call(json!({
            "op": "agent.start",
            "args": {"agent_id": "a1", "command": ["fixture"], "env": {}, "cwd": "/work/app", "size": size}
        }));
        assert_eq!(start.unwrap_err().data.reason, "invalid_argument");
    }
}
