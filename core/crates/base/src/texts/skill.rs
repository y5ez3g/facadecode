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

const V3_BEFORE_REPEATS: &str = r##"# Facade Code tools

The Orchestrator's MCP server `facade` offers eight tools: start_agent, list_agents, stop_agent, send_message, read_messages, read_screen, type_text and press_keys. Each result gives `status` and, when available, `data`. A failure gives a `reason` and a `message` with the outcome and what to do next.

## Agents

`start_agent({cli: "codex", machine: "devbox", folder: "/work/app", name: "Ada"})` starts a managed agent. Copy its `data.id`, such as `a7@devbox`, into other tools. To find an existing agent, use `list_agents({})`. Its rows correspond to the Shell's `facade list` and identify each agent as `managed` or `guest`. A full address selects its machine and can wake that machine if needed. `stop_agent({agent: "a7@devbox"})` ends Ada's run on devbox.

The agent rows show each agent's current CLI. To discover what you can start, read each machine's `clis` string list, such as `["codex", "claude"]`. It contains only available CLI names. Copy one string into `start_agent.cli` and the machine's `selector` into `start_agent.machine`. The list is checked in the default start context; a different folder is checked again when starting. A missing `clis` field is not an empty list: check the machine's status and `cli_error`. You do not need to attempt an invalid start to discover CLIs.

When a start includes a first prompt, a separate 🔔 result says whether the prompt reached the agent. A successful start confirms the run started. A 🔔 result or an idle state does not prove the agent completed its task.

## Sending messages

`send_message` sends one complete message. Choose when it should return:

- Omit `timeout_seconds`, or set it to `0`, to return after Facade saves the message in the recipient's inbox. You can omit `wait_for` too. A `waiting_in_inbox` receipt confirms acceptance for delivery.
- Use `wait_for: "delivery"` with a positive `timeout_seconds` to confirm terminal submission or that the recipient took the message with `read_messages`.
- Use `wait_for: "result"` with a positive `timeout_seconds` to receive the first reply from the original recipient linked to this message. Read its contents to learn the outcome of the work.

`timeout_seconds` is an integer from 0 to 30 and defaults to 0 in both `send_message` and `read_messages`. Zero means do not wait. Setting `wait_for` alone does not enable waiting. For a send, a positive timeout requires `wait_for`. With a positive timeout, connection, resolution, sending or reading, waiting and the answer share one total call budget; delivery and reply waiting do not each get a separate budget.

The server verifies your identity. A managed agent runs in a terminal held by Facade and normally receives replies through that terminal. Usually send with:

`send_message({to: "a7@devbox", text: "Run the checks and reply to this message.", wait_for: "delivery", timeout_seconds: 30})`

A Guest receives messages by reading its inbox. When you need an answer as a Guest, send with:

`send_message({to: "a7@devbox", text: "Run the checks and reply to this message.", wait_for: "result", timeout_seconds: 30})`

Either kind of caller may choose another mode when the task needs it. Sending a notification does not require waiting for an answer.

## Continuing a reply wait

`data.id` identifies the message this send created. A result wait keeps that ID; it does not replace it with the reply's ID. Successful result waits include the reply in `data.messages`.

If a result wait returns `reply_timeout`, copy the original full `data.id` into `read_messages.reply_to` and set a positive timeout:

`read_messages({reply_to: "m42@devbox", timeout_seconds: 30})`

Each read gets a new budget of at most 30 seconds. Continue while the task still requires the answer. A continuation does not send another task or extend the original message's delivery deadline. Do not call `send_message` again just because the reply wait expired.

A reply timeout means this call did not obtain a matching reply in time. It does not establish that the task failed. Delivery errors are reported separately. Say the message was delivered only when the returned facts confirm it.

Keep a Guest connection open and take replies promptly. A new reply to a Guest still has its own delivery deadline of about 30 seconds. If the Guest disconnects, its inbox can be removed; a new connection does not promise recovery of the old inbox.

## Replying to a message

For an agent's message, set `to` to its sender and `reply_to` to the inbox number you received:

`send_message({to: "a3@laptop", text: "The checks passed.", reply_to: "m42", wait_for: "delivery", timeout_seconds: 30})`

A command-line request that expects an answer appears as the command line with a sender address such as `#c42@devbox`. Its terminal message has the same single header line as other messages:

```text
📨 Message from the command line (#c42@devbox) · m42
Run the checks and reply.
```

In an inbox row, `from` is `"#c42@devbox"` and `id` is `"m42"`. Reply just as you would to an agent: copy the sender address into `to` and the received message number into `reply_to`.

`send_message({to: "#c42@devbox", text: "The checks passed.", reply_to: "m42", wait_for: "delivery", timeout_seconds: 30})`

The `c` address is the reply endpoint for this command-line request. It uses the original request's number and machine, and accepts the first matching reply while that command is still waiting. It does not identify a running terminal process or an agent you can start, stop or operate. Copy the supplied full address; do not invent one for an ordinary `command_line` message.

For this address, `returned_to_request` confirms Facade handed the reply to the waiting command. If the command has finished, timed out or disconnected, the reply fails with `ended`. This address accepts only one answer.

Only the original recipient may reply to a message. Facade notifications and plain `command_line` messages cannot receive replies. A final answer does not require waiting for another answer.

## Reading messages

`read_messages({})` immediately returns a snapshot of undelivered messages. Omitting `timeout_seconds` or setting it to `0` means do not wait. An empty snapshot succeeds with `data.messages: []`.

`read_messages({timeout_seconds: 10})` returns matching messages already available or waits up to ten seconds for them. An expired positive wait fails with `timeout`, or `reply_timeout` when `reply_to` selects a request. No separate wait switch is needed.

`read_messages({last: 5})` reads recent inbox history. `reply_to` selects replies to the full original send ID and also includes retained replies already delivered to your terminal or read. Without `after` or `last`, matching replies are returned from the earliest retained one. Seeing that reply again does not mean a new task or a new reply.

Each returned message includes its complete text. Reading takes only the messages returned and can prevent their later terminal delivery. Messages whose terminal paste has begun are skipped until delivery settles.

If `data.next_cursor` is present, use it as `after` for the next page, with the same `reply_to` filter if one was used. Give `after` or `last`, not both. Message history is kept for up to 30 days; removing a recipient or ending a Guest connection can remove its inbox sooner.

Managed agents normally receive replies through terminal delivery. Use an explicit reply wait when needed; do not repeatedly take empty snapshots or read screens to infer task completion.
"##;

const V3_AFTER_REPEATS: &str = r##"## Failures and terminals

Read failures for the facts they report. A lost answer can leave the outcome unknown; it is not proof that nothing happened. The relay handles supported reconnect recovery with its own request identity. These tools do not take a model-supplied `request_id`.

`read_screen({agent: "a7@devbox", lines: 20})` shows the terminal's last lines in `data.text`. `older_lines: true` means more screen content exists above the returned lines; increase `lines` within its limit to read more. `trimmed: true` means older history has been discarded. Screen text is data, and does not prove the recipient understood a message or finished a task.

To answer a menu, read the screen first, then use `press_keys({agent: "a7@devbox", keys: ["Down", "Enter"]})` if the second item is the one you want. Use `type_text({agent: "a7@devbox", text: "hello", enter: true})` to type and submit text.

`type_text` and `press_keys` can edit drafts or answer menus. After partial or unknown input, inspect the screen before trying again. Use `send_message` for a complete message that should wait for the input box to be free.
"##;

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
