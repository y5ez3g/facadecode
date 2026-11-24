//! Base64 encoding for terminal bytes in JSON. A byte chunk can contain a partial UTF-8 character.

use ::base64::Engine;
use ::base64::engine::general_purpose::STANDARD;

pub fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn decode(text: &str) -> anyhow::Result<Vec<u8>> {
    STANDARD.decode(text).map_err(Into::into)
}
