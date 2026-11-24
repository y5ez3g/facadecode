//! Shared JSON line encoding and runtime argument decoding.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::model::error::ErrorBody;

pub use crate::line::MAX_LINE_BYTES;

/// Encodes a message as JSON followed by a newline.
pub fn encode_line<T: Serialize>(value: &T) -> Vec<u8> {
    let mut line = Vec::new();
    serde_json::to_writer(&mut line, value).expect("protocol value must serialize");
    line.push(b'\n');
    line
}

/// Decodes operation arguments into their declared type.
pub fn decode_arguments<T: DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    serde_json::from_value(params).map_err(|err| ErrorBody::invalid_argument(err.to_string()))
}
