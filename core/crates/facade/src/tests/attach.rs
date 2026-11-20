//! The lines around an attachment: before the screen, while reconnecting, and after the terminal is
//! restored.

use std::path::Path;

use facade_base::process::ProcessExit;
use serde_json::json;

use crate::Opening;
use crate::attach::{
    AttachEnd, RECONNECTING, opening_line, reconnected_line, result_line, unsent_line,
};

fn exit(fields: serde_json::Value) -> Option<ProcessExit> {
    let mut exit = json!({ "at": "2026-11-17T23:21:01.000Z" });
    exit.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    Some(serde_json::from_value(exit).expect("a valid exit"))
}

#[test]
fn the_line_before_the_screen_says_how_to_detach() {
    let pixel = || "Pixel".to_string();
    assert_eq!(
        opening_line(&Opening::Started { name: pixel() }, "a3@devbox"),
        "Started a3@devbox (Pixel). Press Ctrl-] to detach."
    );
    assert_eq!(
        opening_line(&Opening::Resumed { name: pixel() }, "a3@devbox"),
        "Resumed a3@devbox (Pixel). Press Ctrl-] to detach."
    );
    assert_eq!(
        opening_line(&Opening::Attached, "a3@devbox"),
        "Attached to a3@devbox. Press Ctrl-] to detach."
    );
}

#[test]
fn reconnect_rows_say_when_keys_are_discarded_and_how_many_bytes_were_lost() {
    assert_eq!(
        RECONNECTING,
        "Connection lost. Reconnecting. Keys typed while disconnected are not sent."
    );
    assert_eq!(
        reconnected_line(12).as_deref(),
        Some("Keys not sent: 12 bytes.")
    );
    assert_eq!(reconnected_line(0), None);
}

#[test]
fn the_line_after_the_screen_says_how_the_attachment_ended() {
    let logs = Path::new("/home/you/.facade/core/logs");
    let ended = |end: AttachEnd| result_line(&end, "a3", logs);
    assert_eq!(
        ended(AttachEnd::Detached),
        "Detached from a3. Run 'facade attach a3' to return."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(exit(json!({ "code": 0 })))),
        "a3 exited with code 0."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(exit(json!({ "code": 3 })))),
        "a3 exited with code 3."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(exit(json!({ "signal": "SIGKILL" })))),
        "a3 was ended by SIGKILL."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(exit(
            json!({ "reason": "terminal_closed" })
        ))),
        "a3's terminal closed. Its CLI may still be running."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(exit(json!({})))),
        "a3 ended; its exit status is unknown."
    );
    assert_eq!(
        ended(AttachEnd::AgentExited(None)),
        "a3 ended; its exit status is unknown."
    );
    assert_eq!(ended(AttachEnd::Removed), "error: a3 was removed");
    let unreachable = ended(AttachEnd::Unreachable);
    let (error, tip) = unreachable.split_once('\n').expect("an error and a tip");
    assert_eq!(error, "error: could not reconnect to Facade");
    assert!(
        tip.starts_with(&format!("  tip: check '{}", logs.display()))
            && tip.ends_with("' for details"),
        "{tip}"
    );
    assert_eq!(
        ended(AttachEnd::Signal("SIGTERM".to_string())),
        "Attachment ended by SIGTERM."
    );
}

#[test]
fn bytes_typed_but_not_sent_are_counted_last() {
    assert_eq!(
        unsent_line(12).as_deref(),
        Some("warning: 12 bytes you typed were not sent")
    );
    assert_eq!(unsent_line(0), None);
}
