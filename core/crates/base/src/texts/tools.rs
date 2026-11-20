//! Facade's eight MCP tools, as `tools/list` lists them.

/// The v2 runtime's tools and input schemas, as a JSON array.
pub const DEFINITIONS: &str = include_str!("tools.json");

/// The Orchestrator's v3 tools and input schemas, as a JSON array.
pub const V3_DEFINITIONS: &str = include_str!("tools.v3.json");
