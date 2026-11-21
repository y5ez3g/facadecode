//! Attach and screen wire types.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use super::super::frame::{
    Request, Size, encode_line, present, present_object, size_input, size_input_schema,
};
use super::{
    AgentRef, AgentTarget, AgentType, AgentTypeArgs, AttachResize, CallParams, ScreenBuffer,
    TerminalInput, methods,
};
use crate::operations::Operation;
use crate::process::ProcessExit;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Running,
    Ended,
    #[serde(other)]
    Unknown,
}

impl From<crate::process::ProcessState> for ProcessState {
    fn from(state: crate::process::ProcessState) -> Self {
        match state {
            crate::process::ProcessState::Running => Self::Running,
            crate::process::ProcessState::Ended => Self::Ended,
            crate::process::ProcessState::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachArgs {
    pub target: AgentTarget,
    #[serde(
        default,
        deserialize_with = "optional_size_input",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Option<Size>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub viewer: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_scrollback: bool,
    #[serde(default = "include_scrollback_by_default")]
    pub include_scrollback: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_ended: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub report_activity: bool,
}

fn include_scrollback_by_default() -> bool {
    true
}

fn optional_size_input<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Size>, D::Error> {
    size_input(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachResizeArgs {
    pub watch: u64,
    #[serde(deserialize_with = "size_input")]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Size,
    #[serde(
        default,
        deserialize_with = "present_object",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "TerminalColors")]
    pub colors: Option<TerminalColors>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TerminalColors {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub foreground: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub background: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenSnapshot {
    pub reference: AgentRef,
    pub address: String,
    pub size: Size,
    pub redraw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenText {
    pub reference: AgentRef,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub process: ProcessState,
    pub observed_at: String,
    pub buffer: ScreenBuffer,
    pub text: String,
    pub line_count: u32,
    pub older_lines: bool,
    pub trimmed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScreenChange {
    Output {
        data: String,
    },
    Redraw {
        size: Size,
        data: String,
    },
    Activity {
        working: bool,
    },
    Exit {
        exit: ProcessExit,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_status: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_hint: Option<String>,
    },
    Removed,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

pub fn attach_resize_line(args: AttachResizeArgs) -> Vec<u8> {
    call_line::<AttachResize>(args)
}

pub fn raw_input_line(reference: AgentRef, bytes: &[u8]) -> Vec<u8> {
    call_line::<AgentType>(AgentTypeArgs {
        target: AgentTarget::Reference(reference),
        input: TerminalInput::Raw {
            raw: crate::base64::encode(bytes),
        },
    })
}

fn call_line<O: Operation>(args: O::Args) -> Vec<u8> {
    encode_line(&Request::new(
        None,
        methods::CALL,
        CallParams {
            op: O::NAME.to_owned(),
            args: serde_json::to_value(args).expect("operation arguments must serialize"),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_unknown_screen_change_does_not_hide_the_next_change() {
        let screen: Vec<ScreenChange> = serde_json::from_value(
            json!([{ "kind": "resized", "cols": 80 }, { "kind": "removed" }]),
        )
        .unwrap();
        assert_eq!(screen, vec![ScreenChange::Unknown, ScreenChange::Removed]);
    }

    #[test]
    fn a_screen_watch_includes_scrollback_unless_asked_not_to() {
        let args: AttachArgs = serde_json::from_value(json!({ "target": "a1" })).unwrap();
        assert!(args.include_scrollback && !args.keep_scrollback);
        let args: AttachArgs = serde_json::from_value(
            json!({ "target": "a1", "keep_scrollback": true, "include_scrollback": false }),
        )
        .unwrap();
        assert!(!args.include_scrollback && args.keep_scrollback);
    }

    #[test]
    fn screen_changes_omit_absent_exit_details_and_carry_their_kind() {
        let exit = ProcessExit {
            code: Some(0),
            signal: None,
            reason: None,
            at: "2026-11-09T17:22:05.123Z".into(),
        };
        assert_eq!(
            serde_json::to_value(ScreenChange::Exit {
                exit,
                exit_status: None,
                resume_hint: None,
            })
            .unwrap(),
            json!({ "kind": "exit", "exit": { "code": 0, "at": "2026-11-09T17:22:05.123Z" } })
        );
        assert_eq!(
            serde_json::to_value(ScreenChange::Output {
                data: "aGk=".into()
            })
            .unwrap(),
            json!({ "kind": "output", "data": "aGk=" })
        );
    }
}
