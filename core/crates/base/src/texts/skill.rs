//! How Facade's eight MCP tools work together. Each runtime's skill accompanies its own tool
//! definitions and instructions. Both skills end in the version that wrote them.

/// How every Facade skill's description begins, which tells a `facade` skill is Facade's
/// (CLIS-2.2).
pub const DESCRIPTION_PREFIX: &str = "How the Facade Code tools work:";

/// The skill's description, which tells a CLI when it applies.
pub const DESCRIPTION: &str = "How the Facade Code tools work: start and stop agents, send and \
                               read Facade messages, and read or type into agent \
                               terminals. Use when you work with other agents through Facade, or a \
                               Facade message or result appears.";

/// What MCP-6.2 has the skill say verbatim: how a model handles a message delivered twice, as
/// Facade does not deduplicate.
pub const REPEATED_MESSAGE: &str = "The same Facade message can arrive more than once. Use its \
                                    message ID to recognize a repeat and do not \
                                    redo work for that same message. A new send call has a new ID, \
                                    even if its text matches. A Facade system result about a \
                                    message is a separate kind of information, not another copy of \
                                    that message's instruction.";

/// The skill's sections before the repeated-message paragraph: the tools, agents and messages.
const BEFORE_REPEATS: &str = "# Facade Code tools

Server `facade` has eight tools: start_agent, list_agents, stop_agent, send_message, read_messages, read_screen,
type_text and press_keys. Each answers with `status`: success, with `data` where it has facts to give, or failure, with
`reason` and a `message` that says what is wrong, whether anything was done, and what to do next.

## Agents

`start_agent({cli: \"codex\", folder: \"/work/app\", name: \"Ada\", prompt: \"Fix the failing parser test.\"})`
starts Codex in that folder with your window membership. Copy its `data.address` to reach it from then on.
Its run takes YOLO from `facade.json`: on, the CLI asks for no approval and has no sandbox; off, it runs as the person
set it up. It can use these tools in either case. `list_agents({})` shows connected and disconnected windows. Connected
windows list launch `locations`, each with a `folder`, and CLI availability in `clis`. The result lists reachable agents, including
ended ones. With YOLO off you reach your creation tree. Copy an agent's `address` into tool calls.

## Messages

`send_message({to: \"#a7@gpu\", text: \"Run the tests again.\"})` types into that agent's terminal under a header that
names you, such as `📨 Message from Max (#a3) · #m42`, then its text. A reply uses the received message address in `reply_to`,
and its header adds `· Reply to #m42`. Messages from the person come from #human. Use #human to notify the person
through the subscriptions of your connected member windows.
A start's prompt is answered later by Facade, not by the agent: `🔔 Ada (#a7) has started. · #m43`, under its own number,
says whether the prompt was passed on, and asks for no reply.
Delivery is finite: a message the recipient's CLI does not take in time fails, and no one tries it again; one to a guest,
a CLI session the person started, waits for its next turn.
`read_messages({})` returns your messages not yet delivered, `read_messages({last: 5})` the five newest, and
`read_messages({after: \"#m42\"})` every one after #m42. You can copy its `address` into `after`.
";

/// The skill's section after the repeated-message paragraph: the terminals.
const AFTER_REPEATS: &str = "## Terminals

`read_screen({agent: \"#a7\", lines: 20})` shows what its CLI shows: a draft, a question, a menu. `type_text` and `press_keys` go
where its cursor is, as `press_keys({agent: \"#a7\", keys: [\"Down\", \"Enter\"]})` picks a menu's second item.
";

const V3_BEFORE_REPEATS: &str = "# Facade Code tools

The Orchestrator's MCP server `facade` offers eight tools. Each result gives `status` and, when
available, `data`. A failure gives a `reason` and a `message` with the outcome and what to do next.

## Agents

`start_agent({cli: \"codex\", machine: \"devbox\", folder: \"/work/app\", name: \"Ada\"})`
starts a managed agent. Copy its `data.id`, such as `a7@devbox`, into other tools. To find an
existing agent, use `list_agents({})`. Its rows correspond to the Shell's `facade list` and
identify each agent as `managed` or `guest`. A full address selects its machine and can wake
that machine if needed. `stop_agent({agent: \"a7@devbox\"})` ends Ada's run on devbox.

When a start includes a first prompt, a separate 🔔 result says whether the prompt reached the
agent. A successful start or message delivery tells you the run started or the message was
received. The agent can send its own reply when it has an answer.

## Messages

`send_message({to: \"a7@devbox\", text: \"Run the tests again.\"})` sends a message. To reply to a
message you received, set `to` to its sender and `reply_to` to its inbox number, such as `m17`.

After sending as a Guest, copy the returned `data.next` tool and arguments. For example, a
receipt with `data.id` equal to `m42@laptop` gives
`read_messages({wait: true, reply_to: \"m42@laptop\"})`. If it returns no reply, use those
arguments again. Delivery fails after 30 seconds if the message is still waiting in the Guest's
inbox.

`read_messages({last: 5})` reads recent inbox history. The response includes the full text of
each returned message. If `data.next_cursor` is present, use it as `after` for the next page
with the same `reply_to` filter if one was used.
";

const V3_AFTER_REPEATS: &str = "## Terminals

`read_screen({agent: \"a7@devbox\", lines: 20})` shows the terminal's last lines in `data.text`.
To answer a menu, read the screen first, then use `press_keys({agent: \"a7@devbox\", keys:
[\"Down\", \"Enter\"]})` if the second item is the one you want. Use `type_text` for text and
its optional `enter` to submit.
";

/// The skill's `SKILL.md`: the frontmatter with `name` and the quoted description, the sections
/// with the repeated-message paragraph between them, and last a line naming the version of Facade
/// core that wrote it.
pub fn text() -> String {
    render(BEFORE_REPEATS, AFTER_REPEATS)
}

/// The skill for clients using the Orchestrator's v3 tools.
pub fn text_v3() -> String {
    render(V3_BEFORE_REPEATS, V3_AFTER_REPEATS)
}

fn render(before_repeats: &str, after_repeats: &str) -> String {
    let description = serde_json::to_string(DESCRIPTION).expect("a string serializes");
    let version = crate::version();
    format!(
        "---\nname: facade\ndescription: {description}\n---\n\n\
         {before_repeats}\n{REPEATED_MESSAGE}\n\n{after_repeats}\n\
         Written by Facade core {version}.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each skill has YAML frontmatter, a separate repeated-message paragraph and a version.
    #[test]
    fn the_skill_has_its_frontmatter_its_paragraph_and_its_version_last() {
        for text in [text(), text_v3()] {
            let (frontmatter, _) = text
                .strip_prefix("---\n")
                .and_then(|rest| rest.split_once("\n---\n"))
                .expect("a frontmatter");
            let lines: Vec<&str> = frontmatter.lines().collect();
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0], "name: facade");
            let description: String =
                serde_json::from_str(lines[1].strip_prefix("description: ").unwrap()).unwrap();
            assert_eq!(description, DESCRIPTION);
            assert!(description.starts_with(DESCRIPTION_PREFIX));
            assert!(
                text.contains(&format!("\n\n{REPEATED_MESSAGE}\n\n")),
                "the paragraph stands alone"
            );
            assert!(text.ends_with(&format!("\nWritten by Facade core {}.\n", crate::VERSION)));
            assert!(!text.contains('\r') && !text.contains('\t'), "plain lines");
        }
    }
}
