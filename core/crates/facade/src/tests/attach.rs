//! The lines around an attachment: before the screen, while reconnecting, and after the terminal is
//! restored.

use facade_base::process::ProcessExit;
use serde_json::json;

use crate::Opening;
use crate::attach::{AttachEnd, opening_line, reconnected_line, result_line, unsent_line};

fn exit(fields: serde_json::Value) -> Option<ProcessExit> {
    let mut exit = json!({ "at": "2026-11-17T23:21:01.000Z" });
    exit.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    Some(serde_json::from_value(exit).expect("a valid exit"))
}

#[test]
fn the_line_before_the_screen_says_how_to_detach() {
    let pixel = "Pixel (a3@devbox)";
    assert_eq!(
        opening_line(&Opening::Started, pixel),
        "Started Pixel (a3@devbox). Press Ctrl+] to detach."
    );
    assert_eq!(
        opening_line(&Opening::Resumed, pixel),
        "Resumed Pixel (a3@devbox). Press Ctrl+] to detach."
    );
    assert_eq!(
        opening_line(&Opening::Attached, pixel),
        "Attached to Pixel (a3@devbox). Press Ctrl+] to detach."
    );
}

#[test]
fn reconnect_rows_say_when_keys_are_discarded_and_how_many_bytes_were_lost() {
    let agent = "Pixel (a3@devbox)";
    assert_eq!(
        reconnected_line(agent, 12).as_deref(),
        Some(
            "Reconnected to Pixel (a3@devbox). 12 bytes typed while disconnected were not sent; \
             check the screen and retype if needed."
        )
    );
    assert_eq!(reconnected_line(agent, 0), None);
}

#[test]
fn the_line_after_the_screen_says_how_the_attachment_ended() {
    let ended = |end: AttachEnd| result_line(&end, "Pixel (a3@devbox)", "a3@devbox");
    let agent_exited = |exit| ended(AttachEnd::AgentExited { exit, status: None });
    assert_eq!(
        ended(AttachEnd::Detached),
        "Detached from Pixel (a3@devbox). The agent is still running.\nReattach with 'facade attach a3@devbox'."
    );
    assert_eq!(
        agent_exited(exit(json!({ "code": 0 }))),
        "Pixel (a3@devbox) exited with code 0."
    );
    assert_eq!(
        agent_exited(exit(json!({ "code": 3 }))),
        "Pixel (a3@devbox) exited with code 3."
    );
    assert_eq!(
        agent_exited(exit(json!({ "signal": "SIGKILL" }))),
        "Pixel (a3@devbox) exited on signal SIGKILL."
    );
    assert_eq!(
        agent_exited(exit(json!({ "reason": "terminal_closed" }))),
        "Pixel (a3@devbox) exited. Facade could not confirm its exit status."
    );
    assert_eq!(
        agent_exited(exit(json!({}))),
        "Pixel (a3@devbox) exited. Facade could not confirm its exit status."
    );
    assert_eq!(
        agent_exited(None),
        "Pixel (a3@devbox) exited. Facade could not confirm its exit status."
    );
    assert_eq!(
        ended(AttachEnd::Removed),
        "error: Pixel (a3@devbox) was removed"
    );
    assert_eq!(
        ended(AttachEnd::Unreachable("ssh: Connection timed out".into())),
        "error: Lost connection to Pixel (a3@devbox): ssh: Connection timed out\n\
         Reattach with 'facade attach a3@devbox', or check 'facade machine list'."
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
