//! OSC 7501, the Program Status Protocol (revision 0.4).
//!
//! With it a program running in a terminal says what it is busy with: `state=working`, or
//! `state=blocked` with `kind=permission|question|auth`, and maybe its own words as `msg=` in
//! base64. It may first ask `OSC 7501 ; ?`, which this terminal always answers. Anything in a
//! report comes from the CLI and is not trusted: past any limit the protocol sets, the whole report
//! is ignored, and the words are only ever text. This terminal ignores reports about one part of a
//! program (those with `id=`) and report titles. A program's earlier reports stop counting after a
//! full reset or when a shell draws its next prompt.

/// The question written into a checkpoint when the CLI has already asked it.
pub(crate) const STATUS_QUERY: &[u8] = b"\x1b]7501;?\x1b\\";

/// Sent back for `OSC 7501 ; ?`.
pub(crate) const STATUS_REPLY: &str =
    "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

const MAX_REPORT_BYTES: usize = 4096;
const MAX_KEY_BYTES: usize = 16;
const MAX_APP_BYTES: usize = 32;
const MAX_ID_BYTES: usize = 128;
const MAX_ID_SEGMENTS: usize = 8;
const MAX_ID_SEGMENT_BYTES: usize = 32;

/// How long a base64 field may be, before and after decoding.
struct Base64Limits {
    encoded: usize,
    decoded: usize,
}

const MSG: Base64Limits = Base64Limits {
    encoded: 2732,
    decoded: 2048,
};
const TITLE: Base64Limits = Base64Limits {
    encoded: 256,
    decoded: 192,
};

/// The state a CLI says it is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportedState {
    Idle,
    Working,
    /// Its turn is over.
    Done,
    /// It needs the person.
    Blocked,
    Error,
}

/// What a blocked CLI needs from the person, named as the protocol names it (`kind=`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Permission,
    Question,
    Auth,
}

/// A status report from the CLI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusReport {
    /// None when the CLI withdraws what it reported before (`state=clear`).
    pub state: Option<ReportedState>,
    /// What it needs, when blocked and it says so.
    pub kind: Option<BlockKind>,
    /// Its words, decoded: up to 2,048 bytes, never a control character.
    pub text: Option<String>,
}

/// One thing the CLI's output says about its status, in output order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusEvent {
    /// `OSC 7501 ; ?`: it asked whether the terminal takes reports, and got a yes.
    Asked,
    Report(StatusReport),
    /// `ESC c`: everything reported so far, and the screen, is gone.
    Reset,
    /// `OSC 133 ; A`: a shell drew its prompt, so the program before it is no longer busy.
    ShellPrompt,
}

/// What the text after `OSC 7501 ;` says, or None when the protocol says to ignore it.
pub(crate) fn status_event(body: &str) -> Option<StatusEvent> {
    match body.trim() {
        "?" => Some(StatusEvent::Asked),
        _ => parse_report(body).map(StatusEvent::Report),
    }
}

/// Whether the text after `OSC` marks the start of a shell prompt: `133;A`, alone or with options.
pub(crate) fn is_shell_prompt(body: &[u8]) -> bool {
    matches!(body.strip_prefix(b"133;A"), Some([] | [b';', ..]))
}

/// The fields of a report that count. Later fields win over earlier ones with the same key.
#[derive(Default)]
struct Fields<'a> {
    state: Option<&'a str>,
    kind: Option<&'a str>,
    words: Option<String>,
    names_a_part: bool,
}

impl<'a> Fields<'a> {
    /// Takes `key=value`. None when the field voids the whole report.
    fn take(&mut self, key: &'a str, value: &'a str) -> Option<()> {
        let base64_charset = |byte: u8| byte.is_ascii_alphanumeric() || b"_.,+/=-".contains(&byte);
        let charset_ok = value.bytes().all(base64_charset);
        let too_long = key.len() > MAX_KEY_BYTES || (key == "app" && value.len() > MAX_APP_BYTES);
        if too_long || (key == "id" && !is_part_id(value)) {
            return None;
        }
        if !charset_ok {
            // Words and titles must be base64; any other field is just skipped.
            return if matches!(key, "msg" | "title") {
                None
            } else {
                Some(())
            };
        }
        if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_lowercase()) {
            return Some(());
        }
        match key {
            "state" => self.state = Some(value),
            "kind" => self.kind = Some(value),
            "id" => self.names_a_part = true,
            "msg" => self.words = Some(decode_text(value, &MSG)?),
            "title" => drop(decode_text(value, &TITLE)?),
            _ => {}
        }
        Some(())
    }
}

/// A report, or None when the protocol says to ignore it: a limit broken, no valid state, or a
/// report about a part of the CLI.
fn parse_report(body: &str) -> Option<StatusReport> {
    if body.len() > MAX_REPORT_BYTES {
        return None;
    }
    let mut fields = Fields::default();
    for field in body.split(':') {
        if let Some((key, value)) = field.split_once('=') {
            fields.take(key.trim(), value.trim())?;
        }
    }
    let state = reported_state(fields.state?)?;
    if fields.names_a_part {
        return None;
    }
    let kind = match (state, fields.kind) {
        (Some(ReportedState::Blocked), Some("permission")) => Some(BlockKind::Permission),
        (Some(ReportedState::Blocked), Some("question")) => Some(BlockKind::Question),
        (Some(ReportedState::Blocked), Some("auth")) => Some(BlockKind::Auth),
        _ => None,
    };
    let text = fields.words.filter(|words| !words.is_empty());
    Some(StatusReport { state, kind, text })
}

/// The state `value` names: `Some(None)` for `clear`, None for no state at all.
fn reported_state(value: &str) -> Option<Option<ReportedState>> {
    Some(Some(match value {
        "clear" => return Some(None),
        "idle" => ReportedState::Idle,
        "working" => ReportedState::Working,
        "done" => ReportedState::Done,
        "blocked" => ReportedState::Blocked,
        "error" => ReportedState::Error,
        _ => return None,
    }))
}

/// Whether `id` is a valid name of a program part: at most 8 `/`-separated segments of 1 to 32
/// letters, digits, `_`, `.`, `+` or `-`, at most 128 bytes in all.
fn is_part_id(id: &str) -> bool {
    let segment_ok = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= MAX_ID_SEGMENT_BYTES
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.+-".contains(&byte))
    };
    let mut segments = 0;
    id.len() <= MAX_ID_BYTES
        && id.split('/').all(|segment| {
            segments += 1;
            segment_ok(segment)
        })
        && segments <= MAX_ID_SEGMENTS
}

/// `value` decoded from base64 as text within `limits`, without control characters.
fn decode_text(value: &str, limits: &Base64Limits) -> Option<String> {
    if value.len() > limits.encoded {
        return None;
    }
    let decoded = decode_base64(value)?;
    if decoded.len() > limits.decoded {
        return None;
    }
    let text = String::from_utf8(decoded).ok()?;
    match text.chars().any(char::is_control) {
        true => None,
        false => Some(text),
    }
}

/// Standard base64, padded or not.
fn decode_base64(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    let digits = value.trim_end_matches('=');
    let padding = value.len() - digits.len();
    let possible = padding <= 2 && digits.len() % 4 != 1;
    possible
        .then(|| STANDARD_NO_PAD.decode(digits).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_names_its_state_kind_and_words() {
        assert_eq!(
            parse_report("state=working"),
            Some(StatusReport {
                state: Some(ReportedState::Working),
                kind: None,
                text: None
            })
        );
        // "Allow edits?" in base64.
        assert_eq!(
            parse_report("app=claude:state=blocked:kind=permission:msg=QWxsb3cgZWRpdHM/"),
            Some(StatusReport {
                state: Some(ReportedState::Blocked),
                kind: Some(BlockKind::Permission),
                text: Some("Allow edits?".into())
            })
        );
        assert_eq!(
            parse_report("state=clear").map(|report| report.state),
            Some(None)
        );
        assert_eq!(
            parse_report("state=idle:kind=question").and_then(|report| report.kind),
            None,
            "only a blocked CLI waits for something"
        );
        assert_eq!(
            parse_report("state=done:msg=").and_then(|report| report.text),
            None,
            "empty words are none"
        );
        assert_eq!(
            parse_report("state=error:msg=IDI=")
                .and_then(|report| report.text)
                .as_deref(),
            Some(" 2"),
            "words are the CLI's, as it sent them"
        );
    }

    #[test]
    fn a_report_that_breaks_a_limit_or_is_about_a_part_is_dropped_whole() {
        for body in [
            "state=sleeping".to_string(),
            "kind=permission".to_string(),
            format!("state=idle:msg={}", "A".repeat(MSG.encoded + 1)),
            // Not base64.
            "state=idle:msg=a".to_string(),
            "state=idle:msg=!!".to_string(),
            "state=idle:title=a b".to_string(),
            // A line break in the words.
            "state=idle:msg=YQpi".to_string(),
            format!("state=idle:title={}", "A".repeat(TITLE.encoded + 1)),
            "state=idle:id=tool/1".to_string(),
            "state=idle:id=a//b".to_string(),
            format!("state=idle:app={}", "a".repeat(MAX_APP_BYTES + 1)),
            format!("state=idle:{}=1", "k".repeat(MAX_KEY_BYTES + 1)),
            format!("state=idle:x={}", "a".repeat(MAX_REPORT_BYTES)),
        ] {
            assert_eq!(parse_report(&body), None, "{}", &body[..body.len().min(60)]);
        }
        assert_eq!(
            parse_report("state=idle:Odd=1:x=a b").map(|report| report.state),
            Some(Some(ReportedState::Idle)),
            "an odd pair is skipped"
        );
    }

    #[test]
    fn base64_decodes_padded_or_not() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64("QWxsb3cgZWRpdHM/").unwrap(), b"Allow edits?");
        assert!(
            decode_base64("a").is_none()
                && decode_base64("aGk===").is_none()
                && decode_base64("a!==").is_none()
        );
    }
}
