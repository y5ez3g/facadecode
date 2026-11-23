//! Tests of the command line's help definitions and of the words it prints. The scenario tests
//! in the Framework workspace run the built program.

mod attach;
mod errors;
mod help;
mod output;

use std::time::{Duration, SystemTime};

use facade_base::api_v1::daemon::{AgentInfo, InspectResult};
use serde_json::{Value, json};

/// The one current time of a rendering: 2026-11-17 23:22:01 UTC.
fn now() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_957_721)
}

/// Seconds before the rendering, in protocol time.
fn before(seconds: u64) -> String {
    facade_base::time::iso_time(now() - Duration::from_secs(seconds))
}

/// A running agent the command line started, with field overrides.
fn agent(changes: Value) -> AgentInfo {
    let reference = json!({
        "machine_id": "11111111-1111-4111-8111-111111111111",
        "agent_id": "a3",
    });
    let mut record = json!({
        "reference": reference,
        "address": "a3@laptop",
        "name": "Pixel",
        "type": "managed",
        "cli": "claude",
        "args": [],
        "cwd": "/work/site",
        "pid": 1234,
        "process": "running",
        "size": { "cols": 120, "rows": 30 },
        "created_at": before(120),
        "started_at": before(60),
        "root": reference,
        "yolo": false,
        "state": "working",
        "tools_state": "available",
    });
    for (field, value) in changes.as_object().expect("changes are an object") {
        if value.is_null() {
            record.as_object_mut().unwrap().remove(field);
        } else {
            record[field] = value.clone();
        }
    }
    serde_json::from_value(record).expect("a valid agent record")
}

/// An inspection with a rule and the people watching the terminal.
fn inspection(
    agent: &AgentInfo,
    rule: Option<&str>,
    viewers: &[&str],
    started_by: Option<Value>,
) -> InspectResult {
    serde_json::from_value(json!({
        "agent": agent,
        "rule": rule,
        "input": { "state": "usable", "evidence": "the input frame" },
        "session_tracking": rule.is_some(),
        "viewers": viewers,
        "started_by": started_by,
    }))
    .expect("a valid inspection")
}
