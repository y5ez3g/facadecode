//! The Shell presentation of daemon results and the underlying roster wire format.

use std::collections::HashMap;

use facade_base::api_v1::daemon::{
    AgentListEntry, AgentListResult, AttachmentInfo, AttachmentKind, SendResult, StatusResult,
};
use serde_json::{Value, json};
use unicode_width::UnicodeWidthStr;

use super::{agent, before, inspection, now};
use crate::commands::{age, inspect_text, list_text, sleeping_text, state_words, status_text};
use crate::errors::{delivery_receipt, machine_query_unanswered};
use crate::{TableLayout, render_table, table};

/// Remove the last column's padding from each line.
fn trimmed(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_v1_roster_keeps_public_rows_stable_references_and_machine_query_states() {
    let wire_rows = json!([{
        "reference": { "agent_id": "a3", "machine_id": "401b070c-c174-4c94-abb1-cd1efda7a62b" },
        "address": "a3@peer", "name": "Pixel", "type": "managed",
        "state": "working", "cli": "claude", "title": "Review",
        "folder": "/work/site", "started_at": before(60),
    }]);

    for (state, status) in [
        ("online", "answered"),
        ("online", "timed_out"),
        ("online", "error"),
        ("connecting", "unavailable"),
        ("disconnected", "unavailable"),
        ("sleeping", "unavailable"),
        ("unreachable", "unavailable"),
        ("ssh_interaction_required", "unavailable"),
    ] {
        let mut machine = json!({
            "machine_id": "401b070c-c174-4c94-abb1-cd1efda7a62b",
            "short_id": "401b070c",
            "name": "peer",
            "selector": "peer",
            "state": state,
            "status": status,
        });
        if state == "online" {
            machine["build"] = json!("0.1.6+test");
        } else {
            machine["last_seen"] = json!(before(60));
        }
        if state == "unreachable" || state == "ssh_interaction_required" {
            machine["ssh_error"] = json!("Could not connect");
        }
        let wire = json!({ "agents": wire_rows, "machines": [machine] });
        let list: AgentListResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&list).unwrap(), wire);
        assert_eq!(
            machine_query_unanswered(&list.machines[0]),
            status != "answered" && state != "sleeping",
        );
    }
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
fn a_narrow_resume_table_fits_wide_session_names_and_keeps_the_full_session_ref() {
    let headers = [
        "NAME",
        "REFERENCE",
        "STATE",
        "CLI",
        "TYPE",
        "WORKING DIRECTORY",
        "UPDATED",
        "SESSION",
    ];
    let reference = "01234567-1234-4000-8000-000000000001";
    let folder = "/work/a/deep/working/directory/for/the/saved/session";
    let session_name = "会话🚀".repeat(15);
    let row = [
        "-",
        reference,
        "Saved",
        "claude",
        "Session",
        folder,
        "16d ago",
        &session_name,
    ];
    let rows = [row.map(str::to_owned).to_vec()];
    let terminal = render_table(&headers, &rows, TableLayout::Roster(Some(119)));
    assert!(terminal.lines().all(|row| row.width() <= 119), "{terminal}");
    assert!(
        terminal.contains(reference) && terminal.ends_with('…'),
        "{terminal}"
    );
    let pipe = render_table(&headers, &rows, TableLayout::Roster(None));
    assert!(pipe.contains(reference) && pipe.contains(folder), "{pipe}");
    let session_name = pipe.rsplit("   ").next().unwrap();
    assert!(
        session_name.ends_with('…') && session_name.width() <= 40,
        "{session_name}"
    );
}

#[test]
fn age_uses_whole_minutes_hours_or_days() {
    for (seconds, words) in [
        (12, "0m ago"),
        (61, "1m ago"),
        (5 * 60 + 10, "5m ago"),
        (60 * 60 + 5, "1h ago"),
        (3 * 3600 + 300, "3h ago"),
        (2 * 86400 + 3600, "2d ago"),
        (21 * 86400 + 3600, "21d ago"),
    ] {
        assert_eq!(age(&before(seconds), now()), words, "{seconds} seconds");
    }
}

#[test]
fn every_state_has_its_words() {
    let ended = |exit: Value, how: &str| json!({ "process": "ended", "state": "ended", "exit": exit, "state_detail": { "how": how } });
    let at = before(60);
    for (changes, words) in [
        (json!({ "state": "starting" }), "Starting"),
        (json!({ "state": "working" }), "Working"),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "permission", "text": "Run it?" } }),
            "Waiting for you (permission: Run it?)",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "question" } }),
            "Waiting for you (question)",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "auth" } }),
            "Waiting for you (sign-in)",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "unknown" } }),
            "Waiting for you",
        ),
        (json!({ "state": "just_done" }), "Just done"),
        (json!({ "state": "idle" }), "Idle"),
        (
            json!({ "state": "error", "state_detail": { "text": "Out of credits" } }),
            "Error (Out of credits)",
        ),
        (
            ended(json!({ "code": 0, "at": at }), "stopped"),
            "Ended (stopped by Facade Code Framework)",
        ),
        (
            ended(json!({ "code": 0, "at": at }), "normal"),
            "Ended (code 0)",
        ),
        (
            ended(json!({ "code": 3, "at": at }), "crashed"),
            "Ended (code 3)",
        ),
        (
            ended(json!({ "signal": "SIGKILL", "at": at }), "crashed"),
            "Ended (signal SIGKILL)",
        ),
        (
            ended(json!({ "reason": "terminal_closed", "at": at }), "unknown"),
            "Ended",
        ),
        (json!({ "state": "unknown" }), "Unknown"),
        (json!({ "type": "guest", "state": "online" }), "Online"),
    ] {
        assert_eq!(state_words(&agent(changes.clone())), words, "{changes}");
    }
}

#[test]
fn the_list_is_one_row_per_agent_with_a_copyable_ref() {
    let session_name = "A session with forty visible characters and some more";
    let rows: Vec<AgentListEntry> = serde_json::from_value(json!([
        {
            "reference": { "agent_id": "a5", "machine_id": "11111111-1111-4111-8111-111111111111" },
            "address": "a5@laptop", "name": "Visor", "type": "guest", "state": "online",
            "cli": "agent", "folder": "/work/site", "started_at": before(60),
        },
        {
            "reference": { "agent_id": "a3", "machine_id": "22222222-2222-4222-8222-222222222222" },
            "address": "a3@devbox", "name": "Pixel", "type": "managed", "state": "working",
            "cli": "claude", "title": "Terminal title", "session_name": session_name,
            "folder": "/work/site", "started_at": before(120),
        },
        {
            "reference": { "agent_id": "a4", "machine_id": "22222222-2222-4222-8222-222222222222" },
            "address": "a4@devbox", "name": "Ada", "type": "managed", "state": "waiting_for_you",
            "cli": "codex", "session_name": "  ", "folder": "/work/site", "started_at": before(300),
        },
    ]))
    .unwrap();
    assert_eq!(
        trimmed(&list_text(&rows, now())),
        "NAME    REFERENCE   STATE             CLI      TYPE      WORKING DIRECTORY   STARTED   SESSION\n\
         Visor   a5@laptop   Online            agent    Guest     -                   1m ago    -\n\
         Pixel   a3@devbox   Working           claude   Managed   /work/site          2m ago    A session with forty visible characters…\n\
         Ada     a4@devbox   Waiting for you   codex    Managed   /work/site          5m ago    -"
    );
}

/// The value after a field's label.
fn field(text: &str, label: &str) -> Option<String> {
    text.lines()
        .find_map(|line| {
            line.strip_prefix(label)
                .filter(|value| value.starts_with("  "))
        })
        .map(|value| value.trim().to_string())
}

#[test]
fn inspect_shows_the_agents_process_and_launch_facts() {
    let pixel = agent(json!({
        "cwd": "D:\\apps\\facadecode",
        "state": "waiting_for_you",
        "state_detail": { "kind": "permission", "text": "Allow the build?" },
        "args": ["--flag", "two words"],
        "title": "Review Shell output",
        "model": "sonnet",
        "effort": "high",
        "session": "86da4482-2bae-4a45-b193-a5664c19826a",
        "yolo": true,
    }));
    let mut inspected = inspection(
        &pixel,
        Some("claude"),
        &["temporary workspace", "Terminal on original hostname"],
        Some(json!({ "kind": "command_line" })),
    );
    inspected.attachments = vec![
        AttachmentInfo {
            kind: AttachmentKind::VsCode,
            machine_id: "devbox-id".into(),
        },
        AttachmentInfo {
            kind: AttachmentKind::Shell,
            machine_id: "laptop-id".into(),
        },
    ];
    let machine_names = HashMap::from([("laptop-id".into(), "laptop".into())]);
    inspected.launch_command = Some(r#""C:\Tools\claude.exe" --flag "two words""#.into());
    inspected.session_name = Some("Greeting".into());
    let text = inspect_text(&inspected, &machine_names);
    assert_eq!(text.lines().next(), Some("Pixel (a3@laptop)"));
    let fields = [
        ("State", "Waiting for you (permission: Allow the build?)"),
        ("CLI", "claude"),
        ("PID", "1234"),
        ("Working directory", "D:\\apps\\facadecode"),
        (
            "Launch command",
            r#""C:\Tools\claude.exe" --flag "two words""#,
        ),
        ("Type", "Managed"),
        ("Machine", "laptop"),
        ("Session", "Greeting"),
        ("Session ID", "86da4482-2bae-4a45-b193-a5664c19826a"),
        ("Started by", "Shell"),
        ("Attached in", "VS Code, Shell (laptop)"),
        ("YOLO", "on"),
    ];
    assert_eq!(
        text.lines().filter(|line| !line.is_empty()).count(),
        fields.len() + 1
    );
    for (label, expected) in fields {
        assert_eq!(field(&text, label).as_deref(), Some(expected), "{text}");
    }
    inspected.attachments.clear();
    inspected.session_name = None;
    let legacy = inspect_text(&inspected, &machine_names);
    assert_eq!(
        field(&legacy, "Attached in").as_deref(),
        Some("temporary workspace, Terminal on original hostname")
    );
    assert_eq!(field(&legacy, "Session").as_deref(), Some("-"));
    assert_eq!(
        field(&legacy, "Session ID").as_deref(),
        pixel.session.as_deref()
    );
}

#[test]
fn inspect_describes_custom_programs_guests_and_ended_agents() {
    let shown = |changes: Value, rule: Option<&str>, started_by: Option<Value>| {
        inspect_text(
            &inspection(&agent(changes), rule, &[], started_by),
            &HashMap::new(),
        )
    };
    let added = shown(
        json!({
            "cli": "fake work", "yolo": true,
            "creator": { "agent_id": "a2", "machine_id": "22222222-2222-4222-8222-222222222222" },
        }),
        Some("claude"),
        Some(json!({ "kind": "agent", "address": "a2@devbox" })),
    );
    assert_eq!(field(&added, "CLI").as_deref(), Some("fake work"));
    assert_eq!(field(&added, "Started by").as_deref(), Some("a2@devbox"));
    assert_eq!(field(&added, "YOLO").as_deref(), Some("on"));
    assert_eq!(field(&added, "Session").as_deref(), Some("-"));
    assert_eq!(field(&added, "Session ID").as_deref(), Some("-"));

    let custom = shown(
        json!({ "cli": "build tool" }),
        None,
        Some(json!({ "kind": "vs_code" })),
    );
    assert_eq!(field(&custom, "CLI").as_deref(), Some("build tool"));
    assert_eq!(field(&custom, "Started by").as_deref(), Some("VS Code"));
    assert_eq!(field(&custom, "Launch command").as_deref(), Some("-"));
    assert_eq!(field(&custom, "Session").as_deref(), Some("-"));

    let guest = shown(
        json!({
            "type": "guest", "cli": "agent", "state": "online",
            "pid": null, "size": null,
        }),
        None,
        None,
    );
    assert_eq!(field(&guest, "Type").as_deref(), Some("Guest"));
    assert_eq!(field(&guest, "CLI").as_deref(), Some("agent"));
    for label in [
        "Started by",
        "PID",
        "Working directory",
        "Launch command",
        "Attached in",
    ] {
        assert_eq!(field(&guest, label).as_deref(), Some("-"), "{guest}");
    }

    let ended = shown(
        json!({
            "process": "ended", "state": "ended", "state_detail": { "how": "normal" },
            "exit": { "code": 0, "at": before(60) },
        }),
        Some("claude"),
        None,
    );
    assert_eq!(field(&ended, "State").as_deref(), Some("Ended (code 0)"));
    assert_eq!(field(&ended, "PID").as_deref(), Some("-"));
}

#[test]
fn status_shows_settings_services_and_each_machine_s_clis() {
    let (home, settings, build) = (
        "/home/you/.facade",
        "/home/you/.facade/facade.json",
        "0.1.6+abc",
    );
    let mut status: StatusResult = serde_json::from_value(json!({
        "home": home,
        "settings_file": settings,
        "build": build,
        "daemon_pid": 16968,
        "keeper_pid": 16752,
        "agent_count": 12,
        "machines": [
            { "machine_id": "peer-id", "short_id": "peer", "name": "peer",
              "selector": "peer", "state": "online", "status": "answered" },
            { "machine_id": "dim-id", "short_id": "dim", "name": "dim",
              "selector": "dim", "state": "sleeping", "status": "unavailable" },
            { "machine_id": "link-id", "short_id": "link", "name": "devbox",
              "selector": "devbox", "state": "online", "status": "answered" },
        ],
    }))
    .unwrap();
    let launcher = "/home/you/.facade/framework/bin/facade-mcp";
    let clis = ["claude, codex".to_owned(), "claude".to_owned()];
    let text = status_text(&status, &clis, "peer-id", "0.1.6", launcher);
    assert_eq!(
        text,
        "Facade Code Framework 0.1.6+abc is running on peer.\nCLI version         0.1.6\nActive agents       12\n\n\
         Home                /home/you/.facade\nSettings            /home/you/.facade/facade.json\n\
         Daemon PID          16968\nKeeper PID          16752\n\n\
         Guest MCP           Add \"/home/you/.facade/framework/bin/facade-mcp\" as a stdio server.\n\n\
         Available CLIs\npeer                claude, codex\ndevbox              claude"
    );
    status.build = "0.1.5".into();
    status.keeper_pid = None;
    let text = status_text(&status, &clis, "peer-id", "0.1.6", launcher);
    assert_eq!(
        text.lines().next(),
        Some("Facade Code Framework 0.1.5 is running on peer.")
    );
    assert_eq!(field(&text, "CLI version").as_deref(), Some("0.1.6"));
    assert_eq!(field(&text, "Keeper PID").as_deref(), Some("-"));
    let sleeping = sleeping_text("claude, codex", home, settings, "0.1.6", launcher, "laptop");
    assert!(
        sleeping.ends_with("\n\nAvailable CLIs\nlaptop              claude, codex"),
        "{sleeping}"
    );
    assert!(sleeping.starts_with("Facade Code Framework 0.1.6 is not running on "));
    assert_eq!(field(&sleeping, "Home").as_deref(), Some(home));
    assert_eq!(field(&sleeping, "Settings").as_deref(), Some(settings));
    for label in ["Active agents", "Daemon PID", "Keeper PID"] {
        assert_eq!(field(&sleeping, label).as_deref(), Some("-"), "{sleeping}");
    }
    assert_eq!(field(&sleeping, "Guest MCP"), field(&text, "Guest MCP"));
}

fn receipt(delivery: Value) -> SendResult {
    serde_json::from_value(json!({
        "id": "m42@peer",
        "recipient": {
            "reference": { "agent_id": "a3", "machine_id": "peer-id" },
            "address": "a3@peer", "type": "managed", "name": "Pixel", "cli": "claude",
            "state": "idle", "resumable": false,
        },
        "message": {
            "message_id": "m42", "from": "command_line", "to": "a3", "text": "hi",
            "at": before(1), "delivery": delivery,
        },
    }))
    .expect("a valid send result")
}

#[test]
fn waiting_for_delivery_prints_a_success_receipt_after_delivery() {
    for via in ["terminal", "read"] {
        let result = receipt(json!({
            "status": "success", "text_written": "full", "delivered_via": via
        }));
        assert_eq!(
            delivery_receipt(&result, "a3@peer", 30).unwrap(),
            "Delivered m42@peer to Pixel (a3@peer)."
        );
    }
    let waiting = delivery_receipt(
        &receipt(json!({ "status": "pending", "text_written": "none" })),
        "a3@peer",
        30,
    )
    .expect_err("a pending delivery has no successful receipt");
    assert!(
        waiting
            .to_string()
            .starts_with("error: Could not deliver m42@peer to Pixel (a3@peer).")
    );
    let unconfirmed = delivery_receipt(
        &receipt(json!({
            "status": "failure", "reason": "submission_unconfirmed", "text_written": "full",
            "enter_written": true,
        })),
        "a3@peer",
        30,
    )
    .expect_err("an unconfirmed delivery fails");
    assert_eq!(
        unconfirmed.to_string(),
        "error: Could not confirm delivery of m42@peer to Pixel (a3@peer).\n\
         Check the terminal with 'facade attach a3@peer' or 'facade screen a3@peer' before sending it again."
    );
    let failed = delivery_receipt(
        &receipt(json!({
            "status": "failure", "reason": "input_draft", "text_written": "none"
        })),
        "a3@peer",
        30,
    )
    .expect_err("a held message fails");
    assert_eq!(
        failed.to_string(),
        "error: Could not deliver m42@peer to Pixel (a3@peer). Its terminal has an unfinished draft.\n\
         Open it with 'facade attach a3@peer'. Submit or clear the draft, then try again."
    );
}
