//! Tests of the command line's help definitions and of the words it prints, on the renderers
//! themselves: no Facade runs. The scenario tests in `core/tests` run the built program.

mod attach;
mod errors;
mod help;
mod output;

use std::time::{Duration, SystemTime};

use facade_base::daemon::{AgentInfo, AgentInspectResult, InputInfo};
use serde_json::{Value, json};

/// The one current time of a rendering: 2026-11-17 23:22:01 UTC.
fn now() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_957_721)
}

/// `seconds` before [`now`], as the protocol writes a time.
fn before(seconds: u64) -> String {
    let at = now() - Duration::from_secs(seconds);
    facade_base::time::iso_time(at)
}

/// An agent record: a running claude agent the human started, with `changes` over its fields.
fn agent(changes: Value) -> AgentInfo {
    let mut record = json!({
        "agent_id": "a3",
        "name": "Pixel",
        "cli": "claude",
        "cwd": "/work/site",
        "machine_id": "m-1",
        "windows": [{ "machine_id": "m-1", "window_id": "terminal" }],
        "location_id": "loc-1",
        "pid": 1234,
        "process": "running",
        "cols": 120,
        "rows": 30,
        "created_at": before(120),
        "root": "a3",
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

/// An input box in `state`, with `hidden` draft rows where given.
fn input(state: &str, hidden: Option<(u32, u32)>) -> InputInfo {
    let mut input = json!({ "state": state, "evidence": "the input frame" });
    if let Some((above, below)) = hidden {
        input["hidden"] = json!({ "above": above, "below": below });
    }
    serde_json::from_value(input).expect("a valid input")
}

/// An inspection of `agent`, started by `rule`.
fn inspection(
    agent: &AgentInfo,
    rule: Option<&str>,
    input: InputInfo,
    tracking: bool,
) -> AgentInspectResult {
    serde_json::from_value(json!({
        "agent": agent,
        "rule": rule,
        "input": input,
        "session_tracking": tracking,
    }))
    .expect("a valid inspection")
}
