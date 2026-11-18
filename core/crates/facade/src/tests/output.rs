//! What the commands print: tables, the words for states, relative times, `inspect`, `status`,
//! integrations and sends.

use std::path::Path;
use std::time::Duration;

use facade_base::daemon::{HelloResult, IntegrationInfo, Message, PartState};
use serde_json::{Value, json};

use super::{agent, before, input, inspection, now};
use crate::commands::{
    ago, input_words, inspect_text, integration_status, integration_text, integrations_text,
    list_text, part_words, quiet_text, sent, state_words, status_text, table, tools_words,
};

/// `text` with each line's trailing spaces removed: the last column's padding is no one's to read.
fn trimmed(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_table_pads_each_column_to_its_widest_cell_and_keeps_each_row_on_one_line() {
    let rows = vec![
        vec!["a3".to_string(), "Pixel".to_string(), "working".to_string()],
        vec![
            "a10".to_string(),
            "名前".to_string(),
            "waiting for you: question".to_string(),
        ],
        vec![
            "a4".to_string(),
            "two\nlines".to_string(),
            "idle\u{1b}".to_string(),
        ],
    ];
    assert_eq!(
        trimmed(&table(&["ID", "NAME", "STATE"], &rows)),
        "ID    NAME        STATE\n\
         a3    Pixel       working\n\
         a10   名前        waiting for you: question\n\
         a4    two lines   idle"
    );
}

#[test]
fn relative_times_read_as_a_person_says_them() {
    let at = |seconds: u64| now() - Duration::from_secs(seconds);
    for (seconds, words) in [
        (12, "12 seconds ago"),
        (61, "1 minute ago"),
        (5 * 60 + 10, "5 minutes ago"),
        (60 * 60 + 5, "about an hour ago"),
        (3 * 3600 + 300, "3 hours ago"),
        (2 * 86400 + 3600, "2 days ago"),
        (21 * 86400 + 3600, "3 weeks ago"),
    ] {
        assert_eq!(ago(at(seconds), now()), words, "{seconds} seconds");
    }
}

#[test]
fn every_state_has_its_words() {
    let ended = |exit: Value, how: &str| json!({ "process": "ended", "state": "ended", "exit": exit, "state_detail": { "how": how } });
    let at = before(60);
    for (changes, words) in [
        (json!({ "state": "starting" }), "starting"),
        (json!({ "state": "working" }), "working"),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "permission", "text": "Run it?" } }),
            "waiting for you: permission",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "question" } }),
            "waiting for you: question",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "auth" } }),
            "waiting for you: sign-in",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "unknown" } }),
            "waiting for you",
        ),
        (json!({ "state": "just_done" }), "turn finished"),
        (json!({ "state": "idle" }), "idle"),
        (
            json!({ "state": "error", "state_detail": { "text": "Out of credits" } }),
            "error",
        ),
        (ended(json!({ "code": 0, "at": at }), "stopped"), "stopped"),
        (
            ended(json!({ "code": 0, "at": at }), "normal"),
            "exited: code 0",
        ),
        (
            ended(json!({ "code": 3, "at": at }), "crashed"),
            "exited: code 3",
        ),
        (
            ended(json!({ "signal": "SIGKILL", "at": at }), "crashed"),
            "ended by SIGKILL",
        ),
        (
            ended(json!({ "reason": "terminal_closed", "at": at }), "unknown"),
            "ended",
        ),
        (json!({ "state": "unknown" }), "unknown"),
    ] {
        assert_eq!(state_words(&agent(changes.clone())), words, "{changes}");
    }
}

#[test]
fn input_tools_and_part_states_have_their_words() {
    assert_eq!(input_words(&input("usable", None)), "empty");
    assert_eq!(input_words(&input("draft", None)), "draft");
    assert_eq!(
        input_words(&input("draft", Some((3, 1)))),
        "draft (3 more lines above, 1 below)"
    );
    assert_eq!(input_words(&input("interaction", None)), "menu or question");
    assert_eq!(input_words(&input("unknown", None)), "unknown");

    let tools = |state: &str| tools_words(&agent(json!({ "tools_state": state })));
    assert_eq!(tools("available"), "available");
    assert_eq!(tools("connecting"), "connecting");
    assert_eq!(tools("not_injected"), "not provided");
    let unavailable = tools_words(&agent(
        json!({ "tools_state": "unavailable", "tools_reason": "disconnected" }),
    ));
    assert!(
        unavailable.starts_with("unavailable: ") && unavailable.len() > "unavailable: ".len(),
        "{unavailable}"
    );

    assert_eq!(part_words(PartState::AsWritten), "up to date");
    assert_eq!(part_words(PartState::Changed), "needs attention");
    assert_eq!(part_words(PartState::Missing), "no Facade settings");
    assert_eq!(part_words(PartState::Unknown), "unknown");
}

/// An integration of `cli` with parts in `states`, added seven days before [`now`] where any part is.
fn integration(cli: &str, states: &[&str]) -> IntegrationInfo {
    let parts: Vec<Value> = states
        .iter()
        .enumerate()
        .map(|(n, state)| json!({ "file": format!("/home/you/.{cli}/file{n}"), "state": state }))
        .collect();
    let mut info = json!({ "cli": cli, "parts": parts });
    if states.contains(&"as_written") || states.contains(&"changed") {
        info["added_at"] = json!(before(7 * 86400 + 60));
    }
    serde_json::from_value(info).expect("a valid integration")
}

#[test]
fn an_integration_s_status_takes_the_first_rule_that_matches() {
    for (states, status) in [
        (&["as_written", "unknown"][..], "unknown"),
        (&["as_written", "as_written"][..], "added"),
        (&["missing", "missing"][..], "not added"),
        (&["as_written", "missing"][..], "needs attention"),
        (&["changed", "as_written"][..], "needs attention"),
    ] {
        assert_eq!(
            integration_status(&integration("claude", states)),
            status,
            "{states:?}"
        );
    }
}

#[test]
fn the_integration_list_is_a_table_with_when_each_was_added() {
    let list = [
        integration("claude", &["as_written", "as_written"]),
        integration("codex", &["missing", "missing"]),
        integration("agy", &["changed", "missing"]),
    ];
    assert_eq!(
        trimmed(&integrations_text(&list, now())),
        "CLI      STATUS            ADDED\n\
         claude   added             7 days ago\n\
         codex    not added\n\
         agy      needs attention   7 days ago"
    );
}

#[test]
fn adding_and_removing_show_each_part() {
    let info: IntegrationInfo = serde_json::from_value(json!({
        "cli": "claude",
        "added_at": before(10),
        "parts": [
            { "file": "/home/you/.claude/settings.json", "state": "as_written" },
            { "file": "claude mcp", "state": "as_written" },
        ],
    }))
    .unwrap();
    assert_eq!(
        trimmed(&integration_text(&info, false)),
        "Added Facade to claude.\n\
        \x20 /home/you/.claude/settings.json   up to date\n\
        \x20 Claude Code MCP servers           up to date"
    );
    let removed: IntegrationInfo = serde_json::from_value(json!({
        "cli": "claude",
        "parts": [
            { "file": "/home/you/.claude/settings.json", "state": "missing" },
            { "file": "claude mcp", "state": "missing" },
        ],
    }))
    .unwrap();
    assert_eq!(
        trimmed(&integration_text(&removed, true)),
        "Removed Facade from claude.\n\
        \x20 /home/you/.claude/settings.json   no Facade settings\n\
        \x20 Claude Code MCP servers           no Facade settings"
    );
    let left: IntegrationInfo = serde_json::from_value(json!({
        "cli": "claude",
        "parts": [
            { "file": "/home/you/.claude/settings.json", "state": "changed" },
            { "file": "claude mcp", "state": "missing" },
        ],
    }))
    .unwrap();
    assert!(
        integration_text(&left, true).starts_with("Check claude's settings to confirm removal.\n"),
        "{}",
        integration_text(&left, true)
    );
}

#[test]
fn the_list_is_one_row_per_agent_and_quiet_prints_ids() {
    let created = |seconds: u64| json!(before(seconds));
    let agents = [
        agent(json!({ "created_at": created(3 * 3600 + 60), "cwd": "D:\\apps\\facadecode" })),
        agent(json!({
            "agent_id": "a4", "name": "Ada", "cli": "codex", "created_at": created(3600 + 60),
            "cwd": "D:\\apps\\facadecode", "state": "waiting_for_you",
            "state_detail": { "kind": "question", "text": "Which one?\nA or B" },
            "said": { "text": "pick one", "from": "human", "at": before(100) },
        })),
        agent(json!({
            "agent_id": "a5", "name": "Plug", "cli": "agy", "created_at": created(5 * 60 + 5),
            "cwd": "D:\\apps\\facadecode", "process": "ended", "state": "ended",
            "exit": { "code": 3, "at": before(60) }, "state_detail": { "how": "crashed" },
        })),
        agent(json!({
            "agent_id": "a6", "name": "Visor", "created_at": created(2 * 60 + 5),
            "cwd": "D:\\work\\site", "state": "idle", "guest": true, "pid": null, "cols": null,
            "rows": null,
        })),
    ];
    assert_eq!(
        trimmed(&list_text(&agents, now())),
        "ID   NAME    CLI              STATE                       CREATED             FOLDER\n\
         a3   Pixel   claude           working                     3 hours ago         D:\\apps\\facadecode\n\
         a4   Ada     codex            waiting for you: question   about an hour ago   D:\\apps\\facadecode\n\
         a5   Plug    agy              exited: code 3              5 minutes ago       D:\\apps\\facadecode\n\
         a6   Visor   claude (guest)   idle                        2 minutes ago       D:\\work\\site"
    );
    assert_eq!(quiet_text(&agents), "a3\na4\na5\na6");
}

#[test]
fn inspect_shows_what_an_agent_is_doing() {
    let pixel = agent(json!({
        "cwd": "D:\\apps\\facadecode",
        "state": "waiting_for_you",
        "state_detail": { "kind": "permission", "text": "Allow Bash(rm -rf build)?" },
        "said": { "text": "fix the build", "from": "human", "at": before(60) },
        "session": "86da4482-2bae-4a45-b193-a5664c19826a",
    }));
    let inspected = inspection(&pixel, Some("claude"), input("usable", None), true);
    assert_eq!(
        trimmed(&inspect_text(&inspected, now())),
        "ID:            a3\n\
         Name:          Pixel\n\
         CLI:           claude\n\
         Folder:        D:\\apps\\facadecode\n\
         Created:       2 minutes ago (2026-11-17 23:20:01 UTC)\n\
         Started by:    human\n\
         Process:       running, pid 1234\n\
         YOLO:          off\n\
         State:         waiting for you: permission\n\
        \x20              Allow Bash(rm -rf build)?\n\
         Facade tools:  available\n\
         Input box:     empty\n\
         Last input:    human, 1 minute ago (2026-11-17 23:21:01 UTC): fix the build\n\
         Session:       86da4482-2bae-4a45-b193-a5664c19826a"
    );
}

/// The value after `label:` on the line it begins, if any.
fn field(text: &str, label: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(label)?.strip_prefix(':'))
        .map(|value| value.trim().to_string())
}

#[test]
fn inspect_names_the_kind_creator_process_and_session_where_they_differ() {
    let shown = |changes: Value, rule: Option<&str>, tracking: bool| {
        inspect_text(
            &inspection(&agent(changes), rule, input("usable", None), tracking),
            now(),
        )
    };
    let added = shown(
        json!({ "cli": "fake work", "creator": "a2", "yolo": true }),
        Some("claude"),
        true,
    );
    assert_eq!(field(&added, "Kind").as_deref(), Some("claude"));
    assert_eq!(field(&added, "Started by").as_deref(), Some("a2"));
    assert_eq!(
        field(&added, "YOLO").as_deref(),
        Some("on: can address every agent")
    );
    assert_eq!(field(&added, "Session").as_deref(), Some("none"));

    let plain = shown(json!({ "cli": "bash" }), None, false);
    assert_eq!(field(&plain, "Kind").as_deref(), Some("plain program"));
    assert_eq!(
        field(&plain, "Session").as_deref(),
        Some("none (not tracked)")
    );

    let same = shown(json!({}), Some("claude"), true);
    assert_eq!(field(&same, "Kind"), None, "{same}");

    let guest = shown(
        json!({ "guest": true, "pid": null, "cols": null, "rows": null }),
        None,
        false,
    );
    assert!(
        field(&guest, "Kind").is_none()
            && field(&guest, "Started by").is_none()
            && field(&guest, "Process").as_deref() == Some("none (guest)"),
        "{guest}"
    );

    let ended = shown(
        json!({
            "process": "ended", "state": "ended", "state_detail": { "how": "normal" },
            "exit": { "code": 0, "at": before(60) },
        }),
        Some("claude"),
        false,
    );
    assert_eq!(
        field(&ended, "Process").as_deref(),
        Some("exited: code 0, 1 minute ago (2026-11-17 23:21:01 UTC)")
    );
}

fn hello(daemon_build: &str, keeper: Option<(u32, &str)>) -> HelloResult {
    let mut hello = json!({
        "protocol": 1, "build": daemon_build, "pid": 16968, "agents": 12,
        "topics": [], "ops": [],
    });
    if let Some((pid, build)) = keeper {
        hello["keeper"] = json!({ "pid": pid, "build": build });
    }
    serde_json::from_value(hello).expect("a valid hello")
}

#[test]
fn status_shows_the_services_and_their_builds_where_they_differ() {
    let home = Path::new("/home/you/.facade");
    // This command is 0.1.6, built from commit abc.
    let (version, build) = ("0.1.6", "0.1.6+abc");
    assert_eq!(
        status_text(
            home,
            Some(&hello(build, Some((16752, build)))),
            version,
            build
        ),
        "Facade is running.\n  Home:      /home/you/.facade\n  Version:   0.1.6\n  Daemon:    pid \
         16968\n  Keeper:    pid 16752\n  Agents:    12"
    );
    let older = status_text(home, Some(&hello("0.1.5", None)), version, build);
    assert!(
        older.contains("\n  Daemon:    pid 16968 (0.1.5)\n")
            && older.contains("\n  Keeper:    none\n"),
        "{older}"
    );
    let silent = status_text(home, None, version, build);
    assert!(
        silent.starts_with("Facade did not respond.\n  Home:      /home/you/.facade"),
        "{silent}"
    );
}

/// A message to `to` whose delivery has `delivery`'s fields.
fn message(to: &str, delivery: Value) -> Message {
    serde_json::from_value(json!({
        "message_id": "m42", "from": "human", "to": to, "text": "hi",
        "at": before(1), "delivery": delivery,
    }))
    .expect("a valid message")
}

#[test]
fn a_send_says_where_the_message_went_or_why_it_did_not() {
    let delivered = |to: &str, via: &str| {
        sent(&message(
            to,
            json!({ "status": "success", "text_written": "full", "delivered_via": via }),
        ))
        .map_err(|problem| problem.to_string())
    };
    assert_eq!(
        delivered("a3", "terminal").as_deref(),
        Ok("m42 delivered to a3")
    );
    assert_eq!(delivered("a3", "read").as_deref(), Ok("m42 read by a3"));
    assert_eq!(
        delivered("human", "notified").as_deref(),
        Ok("m42 delivered to the human's editor window")
    );
    let waiting = sent(&message(
        "a6",
        json!({ "status": "pending", "text_written": "none" }),
    ))
    .map_err(|problem| problem.to_string());
    assert_eq!(waiting.as_deref(), Ok("m42 waiting in a6's inbox"));

    let unconfirmed = sent(&message(
        "a3",
        json!({ "status": "failure", "reason": "submission_unconfirmed", "text_written": "full",
                "enter_written": true }),
    ))
    .expect_err("an unconfirmed delivery fails")
    .to_string();
    assert!(
        unconfirmed.starts_with("error: could not confirm delivery of m42 to a3")
            && unconfirmed.ends_with(
                "\n  tip: run 'facade screen a3' and look for m42 in the input box or recent \
                 output before sending it again"
            ),
        "{unconfirmed}"
    );
    let failed = sent(&message(
        "a3",
        json!({ "status": "failure", "reason": "input_draft", "text_written": "none" }),
    ))
    .expect_err("a held message fails")
    .to_string();
    assert!(
        failed.starts_with("error: m42 was not delivered to a3: ") && !failed.contains('\n'),
        "{failed}"
    );
}
