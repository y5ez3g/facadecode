//! What Facade's hooks print to each CLI and read from its input: the formats of the hook output
//! each CLI reads, and the keys its hook input names its session and turn with. The `facade hook`
//! commands read the input, talk to the daemon and print; these functions only read and write the
//! formats.

use std::collections::BTreeMap;

use facade_base::daemon::is_session_id;
use facade_base::system::{SYSTEM, System, env_var};
use serde_json::{Value, json};

/// The variable Claude Code sets, not empty, for a background job of a session. The job runs its
/// session's hooks, but its turns are not the session's: a hook that sees it does nothing.
pub const BACKGROUND_JOB_VARIABLE: &str = "CLAUDE_JOB_DIR";

/// The variable Muse Code sets to the session of the run, which also runs the run's hooks for the
/// sessions its subagents start.
const OWN_SESSION_VARIABLE: &str = "MUSE_SESSION_ID";

/// What the hook at a run's start has to work with.
pub struct RunStart<'a> {
    /// The hook's input, read as JSON. None where there was none or it was not JSON.
    pub input: Option<&'a Value>,
    /// The run's own session, as the CLI's environment names it to its hooks.
    pub own_session: Option<&'a str>,
    /// The instructions of the agent the run is, as the run's start wrote them.
    pub instructions: Option<&'a str>,
    /// The skill in the run's folder.
    pub skill: Option<&'a str>,
}

/// What `facade hook instructions <cli>` prints, for a CLI that shows its model no MCP server's
/// instructions. Antigravity gets the instructions for each invocation alone, so that nothing piles
/// up in its conversation, and an empty object without them. Muse Code gets the instructions and
/// the skill as the run's own session starts, not one a subagent of it starts. None where the hook
/// prints nothing.
pub fn run_start_output(cli: &str, start: &RunStart<'_>) -> Option<String> {
    match cli {
        "agy" => Some(match start.instructions {
            Some(instructions) => {
                json!({ "injectSteps": [{ "ephemeralMessage": instructions }] }).to_string()
            }
            None => "{}".to_string(),
        }),
        "muse" => {
            let input = start.input?;
            let starts = input["hook_event_name"] == "SessionStart";
            let own = start
                .own_session
                .is_some_and(|own| input["session_id"].as_str() == Some(own));
            if !starts || !own {
                return None;
            }
            let context = format!("{}\n\n{}", start.instructions?, start.skill?);
            Some(session_start_context(&context))
        }
        _ => None,
    }
}

/// What `facade hook approve <cli>` prints: Muse Code's approval of a call of one of the tools of
/// Facade's server `facade`, which it would otherwise ask the person about. None for any other
/// tool, request or CLI.
pub fn approval_output(cli: &str, input: &Value) -> Option<String> {
    // Muse Code names a server's tool `mcp__<server>__<tool>`.
    let facade_tool = input["tool_name"]
        .as_str()
        .is_some_and(|tool| tool.starts_with("mcp__facade__"));
    let asks = input["hook_event_name"] == "PermissionRequest";
    (cli == "muse" && asks && facade_tool).then(|| {
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" },
            },
        })
        .to_string()
    })
}

/// Whether the prompt hook whose input is `input` begins a turn. Antigravity runs it before each
/// model call of a turn, and only its first begins the turn; the other CLIs run it once a turn.
pub fn begins_turn(cli: &str, input: &Value) -> bool {
    let later_call = input
        .get("invocationNum")
        .and_then(Value::as_u64)
        .is_some_and(|number| number > 1);
    !(cli == "agy" && later_call)
}

/// What a hook with nothing to say prints: an empty object for Antigravity, which reads every hook's
/// output as one, and None, nothing, for the other CLIs.
pub fn empty_output(cli: &str) -> Option<&'static str> {
    (cli == "agy").then_some("{}")
}

/// What a hook prints to give its model `text` at `event`, in `cli`'s format: Claude Code's, Codex's
/// and Muse Code's JSON for the event, Antigravity's system message step, or the text alone for
/// Facade's own plugin and extension.
pub fn context_output(cli: &str, event: &str, text: &str) -> String {
    match cli {
        "claude" | "codex" | "muse" => {
            json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": text } })
                .to_string()
        }
        "agy" => {
            json!({ "injectSteps": [{ "systemMessage": { "systemMessage": text } }] }).to_string()
        }
        _ => text.to_string(),
    }
}

/// What a turn-end hook prints to keep the turn going with `reason`, in `cli`'s format.
pub fn block_output(cli: &str, reason: &str) -> String {
    match cli {
        "claude" | "codex" | "muse" => json!({ "decision": "block", "reason": reason }).to_string(),
        "agy" => json!({ "decision": "continue", "reason": reason }).to_string(),
        _ => reason.to_string(),
    }
}

/// The session a hook's input names.
#[derive(Debug, PartialEq, Eq)]
pub struct NamedSession {
    /// The session's ID.
    pub session: String,
    /// The session it is part of, as a subagent's is. Never the session itself.
    pub parent: Option<String>,
    /// The CLI's working folder, where the input says it.
    pub cwd: Option<String>,
}

/// The session a hook's input names, whichever CLI ran it, as every CLI's keys are read:
/// `session_id`, as Claude Code, Codex, Muse Code and Facade's plugin and extension name it, or
/// Antigravity's `conversationId`; and the session it is part of, as a subagent's is,
/// `parent_session_id` or Antigravity's `rootConversationId`. None where the input names no valid
/// session ID.
pub fn session_of(cli: &str, input: &Value) -> Option<NamedSession> {
    let _ = cli;
    let id_at = |keys: [&str; 2]| {
        let ids = keys.into_iter().filter_map(|key| input.get(key)?.as_str());
        ids.into_iter()
            .find(|id| is_session_id(id))
            .map(str::to_string)
    };
    let session = id_at(["session_id", "conversationId"])?;
    let parent =
        id_at(["parent_session_id", "rootConversationId"]).filter(|parent| *parent != session);
    let cwd = input.get("cwd").and_then(Value::as_str).map(str::to_string);
    Some(NamedSession {
        session,
        parent,
        cwd,
    })
}

/// Whether the turn-end hook whose input is `input` ends a turn the person cut short, as
/// Antigravity's says. Every CLI's input is read for it.
pub fn is_turn_cut_short(cli: &str, input: &Value) -> bool {
    let _ = cli;
    input["terminationReason"] == "USER_CANCELED"
}

/// What `facade hook session-start <file> --skill` prints: `skill` as the context the session
/// starts with, for a CLI that reads no skill file of its own.
pub fn skill_output(skill: &str) -> String {
    session_start_context(skill)
}

/// Whether `session` is the run's own, by the CLI's environment `env`: a CLI that also runs the
/// run's hooks for its subagents' sessions names the run's own there. True where it names none.
pub fn is_run_own_session(env: &BTreeMap<String, String>, session: &str) -> bool {
    env_var(env, OWN_SESSION_VARIABLE)
        .filter(|own| !own.is_empty())
        .is_none_or(|own| own == session)
}

/// The program and arguments that run the person's own title command `command`, with the shell
/// of the CLI that runs title commands, Antigravity: `/bin/sh -c` on Unix, cmd.exe on Windows.
pub fn title_command(command: &str) -> Vec<String> {
    let shell: &[&str] = match SYSTEM {
        System::Unix => &["/bin/sh", "-c"],
        System::Windows => &["cmd.exe", "/d", "/s", "/c"],
    };
    shell
        .iter()
        .copied()
        .chain([command])
        .map(String::from)
        .collect()
}

/// The JSON of a session-start hook that gives the model `context`.
fn session_start_context(context: &str) -> String {
    json!({
        "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": context },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Antigravity reads a hook's context as a system message step, and goes on with a turn at
    /// `decision: continue`.
    #[test]
    fn antigravity_s_hooks_answer_in_its_own_format() {
        assert_eq!(
            context_output("agy", "SessionStart", "hi"),
            json!({ "injectSteps": [{ "systemMessage": { "systemMessage": "hi" } }] }).to_string()
        );
        assert_eq!(
            block_output("agy", "go on"),
            json!({ "decision": "continue", "reason": "go on" }).to_string()
        );
        assert_eq!(
            block_output("muse", "go on"),
            json!({ "decision": "block", "reason": "go on" }).to_string()
        );
    }

    /// A hook names its session as its CLI does: Antigravity in camelCase, with the conversation a
    /// subagent's is part of. A session is no part of itself.
    #[test]
    fn a_hook_names_its_session_as_its_cli_does() {
        let agy = session_of(
            "agy",
            &json!({ "conversationId": "c2", "rootConversationId": "c1", "cwd": "/w" }),
        )
        .unwrap();
        assert_eq!(
            (
                agy.session.as_str(),
                agy.parent.as_deref(),
                agy.cwd.as_deref()
            ),
            ("c2", Some("c1"), Some("/w"))
        );
        let muse = session_of(
            "muse",
            &json!({ "session_id": "s2", "parent_session_id": "s1" }),
        );
        assert_eq!(muse.unwrap().parent.as_deref(), Some("s1"));
        let own = session_of(
            "claude",
            &json!({ "session_id": "s1", "parent_session_id": "s1" }),
        );
        assert_eq!(own.unwrap().parent, None);
        assert!(
            session_of("agy", &json!({ "conversation_id": "c3" })).is_none(),
            "Antigravity's keys are camelCase"
        );
    }
}
