//! A guest's hooks: `facade hook session-start --cli <cli>`, `prompt`, `turn-end` and `session-end`
//! report on the session their input names. A session of a CLI the person started joins as a guest,
//! works, ends its turns and leaves, and a command its CLI's session names acts for it. In a run
//! Facade started of the same CLI the hooks do nothing, and they never start Facade or fail.

use std::process::{Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Runs `facade hook <args>` from this test, as a CLI's hook runs it, with `env` set and `input` on
/// standard input.
fn hook(home: &TestHome, args: &[&str], env: &[(&str, &str)], input: &str) -> Output {
    let mut command = home.command(&test_binaries().facade);
    command.arg("hook").args(args).envs(env.iter().copied());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A hook may end before it reads its input, as one in a background job of Claude Code does: a
    // write it no longer takes is no failure.
    let _ = std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes());
    child.wait_with_output().unwrap()
}

/// A hook's input from a CLI: `event` for `session`, with `more`.
fn input(event: &str, session: &str, more: Value) -> String {
    let mut input = json!({ "hook_event_name": event, "session_id": session });
    input
        .as_object_mut()
        .unwrap()
        .extend(more.as_object().cloned().unwrap_or_default());
    input.to_string()
}

/// The JSON a hook printed.
fn printed(output: &Output) -> Value {
    facade_scenarios::serde_json::from_str(stdout(output).trim())
        .unwrap_or_else(|_| panic!("not a hook answer: {output:?}"))
}

/// The record of the agent that has `session`.
fn with_session(home: &TestHome, session: &str) -> Option<Value> {
    let listed: Value =
        facade_scenarios::serde_json::from_str(&stdout(&home.run_facade(&["list", "--json"])))
            .ok()?;
    listed
        .as_array()?
        .iter()
        .find(|agent| agent["session"] == session)
        .cloned()
}

/// A session of a CLI the person started joins as a guest at its start, with the next agent ID and
/// a default name, and its model is told who it is, with Facade's skill after. A send to it answers
/// at once that the message waits, with no deadline. Every prompt that begins a turn makes it
/// `working` and gives its model what waited, even where no turn-end came before, as after an
/// interrupt Claude Code reports nothing for. What comes while it works waits for the turn's end,
/// which makes it `idle` and gives its model that before the turn ends. A turn the person cut short
/// makes it `idle` and gives nothing: the messages wait for the next prompt. Each hand-over
/// delivers what it gives. Its session's end removes it.
#[test]
fn a_session_joins_as_a_guest_works_ends_its_turns_and_leaves() {
    let home = TestHome::new("guest");
    let mut wire = connect(&home);
    let project = home.project.display().to_string();
    let started = hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[],
        &input("SessionStart", "s1", json!({ "cwd": project })),
    );
    assert!(started.status.success(), "{started:?}");
    let context = printed(&started)["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        context.starts_with("You are Facade guest #a1, in a terminal of your own."),
        "{context}"
    );
    let instructions = facade_base::instructions::for_guest(Some("a1"));
    assert_eq!(
        context,
        format!("{instructions}\n\n{}", facade_base::skill::text()),
        "the instructions, then the skill"
    );
    let guest = with_session(&home, "s1").expect("the session did not join");
    assert_eq!(
        (
            &guest["agent_id"],
            &guest["cli"],
            &guest["guest"],
            &guest["state"]
        ),
        (
            &json!("a1"),
            &json!("claude"),
            &json!(true),
            &json!("unknown")
        )
    );
    assert_eq!(guest["cwd"], project);
    // Facade knows no process or terminal of a guest's, so it names none.
    assert!(
        ["pid", "cols", "rows"]
            .iter()
            .all(|fact| guest.get(*fact).is_none()),
        "{guest}"
    );
    // The list marks a guest beside its CLI; inspect shows it has no process of Facade's, and names
    // no creator or kind.
    let table = home.list_table();
    let row = table.row("ID", "a1").expect("a1 is listed");
    assert!(
        table.cell(row, "CLI") == "claude (guest)" && table.cell(row, "FOLDER") == project,
        "{table:?}"
    );
    let inspected = home.run_facade_ok(&["inspect", "a1"]);
    let label = |name: &str| {
        inspected
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .map(str::trim)
    };
    assert!(
        label("ID") == Some("a1")
            && label("CLI") == Some("claude (guest)")
            && label("Process") == Some("none (guest)")
            && label("Kind").is_none()
            && label("Started by").is_none(),
        "{inspected}"
    );
    let sent = wire.call("agent.send", json!({ "to": "a1", "text": "one" }));
    assert_eq!(
        (
            &sent["result"]["delivery"]["status"],
            sent["result"]["delivery"].get("deadline")
        ),
        (&json!("pending"), None),
        "{sent}"
    );
    let prompted = hook(
        &home,
        &["prompt", "--cli", "claude"],
        &[],
        &input("UserPromptSubmit", "s1", json!({})),
    );
    let context = json!({
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "📨 Message from #human · #m1\none",
    });
    assert_eq!(
        printed(&prompted)["hookSpecificOutput"],
        context,
        "{prompted:?}"
    );
    assert!(wait_until(secs(10), || with_session(&home, "s1")
        .is_some_and(|guest| guest["state"] == "working")));
    let state = |wanted: &str| {
        wait_until(secs(10), || {
            with_session(&home, "s1").is_some_and(|guest| guest["state"] == wanted)
        })
    };
    wire.call("agent.send", json!({ "to": "a1", "text": "two" }));
    let ended = hook(
        &home,
        &["turn-end", "--cli", "claude"],
        &[],
        &input("Stop", "s1", json!({ "stop_hook_active": false })),
    );
    assert_eq!(
        printed(&ended),
        json!({ "decision": "block", "reason": "📨 Message from #human · #m2\ntwo" }),
        "{ended:?}"
    );
    assert!(state("idle"));
    // The next turn: nothing waits. The person cuts it short, and Claude Code says it waits for
    // input: the guest goes idle, and the message that came meanwhile waits for the next prompt,
    // which gives it.
    assert!(
        hook(
            &home,
            &["prompt", "--cli", "claude"],
            &[],
            &input("UserPromptSubmit", "s1", json!({}))
        )
        .stdout
        .is_empty()
    );
    assert!(state("working"));
    wire.call("agent.send", json!({ "to": "a1", "text": "three" }));
    let idle = hook(
        &home,
        &["idle", "--cli", "claude"],
        &[],
        &input(
            "Notification",
            "s1",
            json!({ "notification_type": "idle_prompt" }),
        ),
    );
    assert!(idle.status.success() && idle.stdout.is_empty(), "{idle:?}");
    assert!(state("idle"));
    let prompted = hook(
        &home,
        &["prompt", "--cli", "claude"],
        &[],
        &input("UserPromptSubmit", "s1", json!({})),
    );
    assert_eq!(
        printed(&prompted)["hookSpecificOutput"]["additionalContext"],
        "📨 Message from #human · #m3\nthree",
        "{prompted:?}"
    );
    // An interrupt before Claude Code says anything leaves the guest working; the next prompt gives
    // what waits all the same.
    wire.call("agent.send", json!({ "to": "a1", "text": "four" }));
    let prompted = hook(
        &home,
        &["prompt", "--cli", "claude"],
        &[],
        &input("UserPromptSubmit", "s1", json!({})),
    );
    assert_eq!(
        printed(&prompted)["hookSpecificOutput"]["additionalContext"],
        "📨 Message from #human · #m4\nfour",
        "{prompted:?}"
    );
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", [1, 1], json!({ "agent": "a1" }));
    let kept = reader.request(
        "watch",
        json!({ "topic": "messages", "args": { "all": true } }),
    )["result"]["snapshot"]["messages"]
        .clone();
    let delivered: Vec<&Value> = kept
        .as_array()
        .unwrap()
        .iter()
        .map(|message| &message["delivery"]["delivered_via"])
        .collect();
    assert_eq!(delivered, [&json!("read"); 4], "{kept}");
    drop(reader);
    let left = hook(
        &home,
        &["session-end", "--cli", "claude"],
        &[],
        &input("SessionEnd", "s1", json!({})),
    );
    assert!(left.status.success() && left.stdout.is_empty(), "{left:?}");
    assert!(
        wait_until(secs(10), || with_session(&home, "s1").is_none()),
        "the guest stayed after its session ended"
    );
}

/// A listed guest is an agent like any other, working or idle, so it keeps the daemon up: with no
/// client connected and no run, the daemon stays while the guest is listed, and exits after its
/// grace once the guest's session ends.
#[test]
fn a_listed_guest_keeps_the_daemon_up_until_its_session_ends() {
    let home = TestHome::new("guestidle");
    let wire = connect(&home);
    let joined = hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[],
        &input("SessionStart", "s1", json!({})),
    );
    assert!(joined.status.success(), "{joined:?}");
    let daemon = process_identity(
        home.lock_record("daemon")
            .expect("the daemon's lock record")
            .0,
    );
    drop(wire);
    std::thread::sleep(secs(8));
    assert!(
        alive(&daemon),
        "the daemon exited with a guest listed: {}",
        home.daemon_log()
    );
    let left = hook(
        &home,
        &["session-end", "--cli", "claude"],
        &[],
        &input("SessionEnd", "s1", json!({})),
    );
    assert!(left.status.success(), "{left:?}");
    assert!(
        wait_until(secs(12), || !alive(&daemon)),
        "the daemon did not exit once its guest ended: {}",
        home.daemon_log()
    );
}

/// Claude Code runs no hook for a turn the person cuts short, so its prompt hook names Claude
/// Code's own session file, `sessions/<pid>.json` in its configuration folder, and while the guest
/// works the daemon reads it once a second. `idle` written since the turn began makes the guest
/// `idle` and takes nothing: the message that came meanwhile goes with the next prompt. Where the
/// file says `idle` before the turn-end hook comes, that hook still hands over what waits. An
/// `idle` from before the turn began changes nothing, nor does another session's, after which the
/// file is no longer read for that turn.
#[test]
fn a_claude_code_turn_cut_short_ends_as_its_session_file_says() {
    let home = TestHome::new("guestcut");
    let mut wire = connect(&home);
    let config = home.path.join("claude-config");
    // The prompt hook names the file of the process that runs it: this test's.
    let file = config
        .join("sessions")
        .join(format!("{}.json", std::process::id()));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let report = |session: &str, status: &str| {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        std::fs::write(
            &file,
            json!({ "sessionId": session, "status": status, "statusUpdatedAt": at }).to_string(),
        )
        .unwrap();
    };
    let env = [("CLAUDE_CONFIG_DIR", config.to_str().unwrap())];
    let state = || with_session(&home, "s1").map(|guest| guest["state"].clone());
    let reads = |wanted: &str| wait_until(secs(10), || state() == Some(json!(wanted)));
    let prompt = || {
        hook(
            &home,
            &["prompt", "--cli", "claude"],
            &env,
            &input("UserPromptSubmit", "s1", json!({})),
        )
    };
    hook(
        &home,
        &["session-start", "--cli", "claude"],
        &env,
        &input("SessionStart", "s1", json!({})),
    );
    report("s1", "idle");
    prompt();
    assert!(reads("working"));
    std::thread::sleep(secs(3));
    assert_eq!(
        state(),
        Some(json!("working")),
        "an idle from before the turn changes nothing"
    );
    report("s1", "busy");
    wire.call("agent.send", json!({ "to": "a1", "text": "one" }));
    report("s1", "idle");
    assert!(
        reads("idle"),
        "the person cut the turn short: {}",
        home.daemon_log()
    );
    let prompted = prompt();
    assert_eq!(
        printed(&prompted)["hookSpecificOutput"]["additionalContext"],
        "📨 Message from #human · #m1\none",
        "{prompted:?}"
    );
    wire.call("agent.send", json!({ "to": "a1", "text": "two" }));
    report("s1", "idle");
    assert!(reads("idle"));
    let ended = hook(
        &home,
        &["turn-end", "--cli", "claude"],
        &env,
        &input("Stop", "s1", json!({ "stop_hook_active": false })),
    );
    assert_eq!(
        printed(&ended),
        json!({ "decision": "block", "reason": "📨 Message from #human · #m2\ntwo" }),
        "{ended:?}"
    );
    prompt();
    assert!(reads("working"));
    report("s2", "idle");
    std::thread::sleep(secs(3));
    assert_eq!(
        state(),
        Some(json!("working")),
        "another session's file changes nothing"
    );
}

/// A session Facade does not list yet, as one that started before Facade did, joins at its next
/// hook. Two sessions of one CLI are two guests.
#[test]
fn a_session_joins_at_any_hook_and_each_session_is_its_own_guest() {
    let home = TestHome::new("lateguest");
    connect(&home);
    hook(
        &home,
        &["prompt", "--cli", "codex"],
        &[],
        &input("UserPromptSubmit", "early", json!({})),
    );
    hook(
        &home,
        &["session-start", "--cli", "codex"],
        &[],
        &input("SessionStart", "second", json!({})),
    );
    let (early, second) = (
        with_session(&home, "early").expect("early"),
        with_session(&home, "second").expect("second"),
    );
    assert_eq!(
        (&early["agent_id"], &early["state"]),
        (&json!("a1"), &json!("working"))
    );
    assert_eq!(
        (&second["agent_id"], &second["guest"]),
        (&json!("a2"), &json!(true))
    );
    // Antigravity names its conversation, in camelCase; OpenCode's sessions are no UUIDs, and
    // Facade's plugin is given the text alone.
    hook(
        &home,
        &["prompt", "--cli", "agy"],
        &[],
        &json!({ "hookEventName": "PreInvocation", "conversationId": "c0nv-1" }).to_string(),
    );
    assert_eq!(
        with_session(&home, "c0nv-1").expect("the conversation joined")["cli"],
        "agy"
    );
    let opencode = "ses_e3274d49fffen6SKUCQGgsRrNF";
    let started = hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input("session.created", opencode, json!({})),
    );
    assert!(
        stdout(&started).starts_with("You are Facade guest #a4, in a terminal of your own."),
        "{started:?}"
    );
    assert_eq!(
        with_session(&home, opencode).expect("the session joined")["agent_id"],
        "a4"
    );
}

/// Facade's plugin and extension, OpenCode's and Pi's, are given the hand-over as the text alone,
/// which they give their session: with the prompt that begins a turn, and before a turn ends. Every
/// guest is told that its messages and Facade's results reach it only at its next turn, and nothing
/// of a waiter.
#[test]
fn a_plugin_is_given_the_hand_over_as_text() {
    let home = TestHome::new("pluginturns");
    let mut wire = connect(&home);
    let session = "ses_e3274d49fffen6SKUCQGgsRrNF";
    let started = hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input("session.created", session, json!({})),
    );
    assert!(
        stdout(&started)
            .contains("reach you only as your turn ends or with the person's next prompt")
            && !stdout(&started).contains("--wait")
    );
    wire.call("agent.send", json!({ "to": "a1", "text": "one" }));
    let prompted = hook(
        &home,
        &["prompt", "--cli", "opencode"],
        &[],
        &input("session.execution.started", session, json!({})),
    );
    assert_eq!(
        stdout(&prompted),
        "📨 Message from #human · #m1\none\n",
        "{prompted:?}"
    );
    wire.call("agent.send", json!({ "to": "a1", "text": "two" }));
    let ended = hook(
        &home,
        &["turn-end", "--cli", "opencode"],
        &[],
        &input("session.execution.succeeded", session, json!({})),
    );
    assert_eq!(
        stdout(&ended),
        "📨 Message from #human · #m2\ntwo\n",
        "{ended:?}"
    );
    let quiet = hook(
        &home,
        &["turn-end", "--cli", "opencode"],
        &[],
        &input("session.execution.succeeded", session, json!({})),
    );
    assert!(
        quiet.status.success() && quiet.stdout.is_empty(),
        "nothing waits: nothing to say: {quiet:?}"
    );
    let claude = hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[],
        &input("SessionStart", "s2", json!({})),
    );
    let told = printed(&claude)["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        told.contains("reach you only as your turn ends or with the person's next prompt")
            && !told.contains("--wait"),
        "{told}"
    );
}

/// A subagent's session, reported with the session that started it, is part of that session: it
/// acts for that session's guest at its hooks, its tool calls and its commands, its turns leave the
/// guest's state and messages alone, and its end leaves the guest listed. The guest's end takes its
/// parts with it. Antigravity names the whole conversation as `root_conversation_id`.
#[test]
fn a_subagent_s_session_acts_for_its_parent_s_guest() {
    let home = TestHome::new("subagent");
    let mut wire = connect(&home);
    hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input("session.created", "ses_parent", json!({})),
    );
    let child = hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input(
            "session.created",
            "ses_child",
            json!({ "parent_session_id": "ses_parent" }),
        ),
    );
    assert!(
        stdout(&child).starts_with("You are Facade guest #a1,"),
        "{child:?}"
    );
    let told = format!(
        "{}\n\n{}",
        facade_base::instructions::for_guest(Some("a1")),
        facade_base::skill::text()
    );
    assert_eq!(
        stdout(&child).trim_end(),
        told.trim_end(),
        "the child is told its parent's guest, then Facade's skill"
    );
    let joined = wire.request(
        "call",
        json!({
            "op": "hook.session-start", "args": { "cli": "opencode", "session": "ses_child" },
        }),
    );
    assert_eq!(
        joined["result"]["agent_id"], "a1",
        "a tool call of the child acts for the parent's guest: {joined}"
    );
    let mut command_of_child = DaemonTestClient::open(&home);
    let hello = command_of_child.hello("terminal", [1, 1], json!({ "sessions": ["ses_child"] }));
    assert_eq!(hello["result"]["agent"], "a1", "{hello}");
    hook(
        &home,
        &["prompt", "--cli", "opencode"],
        &[],
        &input("session.execution.started", "ses_parent", json!({})),
    );
    assert!(wait_until(secs(10), || with_session(&home, "ses_parent")
        .is_some_and(|guest| guest["state"] == "working")));
    let sent = wire.send(
        "call",
        json!({ "op": "agent.send", "args": { "to": "a1", "text": "for the parent" } }),
    );
    let ended = hook(
        &home,
        &["turn-end", "--cli", "opencode"],
        &[],
        &input("session.execution.succeeded", "ses_child", json!({})),
    );
    assert!(
        ended.status.success() && ended.stdout.is_empty(),
        "the child's turn takes nothing: {ended:?}"
    );
    assert_eq!(
        with_session(&home, "ses_parent").unwrap()["state"],
        "working",
        "the child's turn is not the guest's"
    );
    let parent_ended = hook(
        &home,
        &["turn-end", "--cli", "opencode"],
        &[],
        &input("session.execution.succeeded", "ses_parent", json!({})),
    );
    assert_eq!(
        stdout(&parent_ended),
        "📨 Message from #human · #m1\nfor the parent\n",
        "{parent_ended:?}"
    );
    assert!(wire.wait_for_response(sent, secs(10)).is_some());
    hook(
        &home,
        &["session-end", "--cli", "opencode"],
        &[],
        &input("session.deleted", "ses_child", json!({})),
    );
    assert!(
        with_session(&home, "ses_parent").is_some(),
        "the child's end leaves the guest"
    );
    let agents: Value =
        facade_scenarios::serde_json::from_str(&stdout(&home.run_facade(&["list", "--json"])))
            .unwrap();
    assert_eq!(
        agents.as_array().unwrap().len(),
        1,
        "the child is no guest of its own: {agents}"
    );
    let mut command_of_ended = DaemonTestClient::open(&home);
    let hello = command_of_ended.hello("terminal", [1, 1], json!({ "sessions": ["ses_child"] }));
    assert!(
        hello["result"].get("agent").is_none(),
        "an ended child acts for no one: {hello}"
    );
    drop(command_of_ended);
    hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input(
            "session.created",
            "ses_child2",
            json!({ "parent_session_id": "ses_parent" }),
        ),
    );
    hook(
        &home,
        &["session-start", "--cli", "agy"],
        &[],
        &json!({ "hookEventName": "SessionStart", "conversationId": "root-1" }).to_string(),
    );
    let part = json!({
        "hookEventName": "SessionStart", "conversationId": "sub-1", "rootConversationId": "root-1",
    });
    assert!(
        stdout(&hook(
            &home,
            &["session-start", "--cli", "agy"],
            &[],
            &part.to_string()
        ))
        .contains("You are Facade guest #a2,")
    );
    hook(
        &home,
        &["session-end", "--cli", "opencode"],
        &[],
        &input("session.deleted", "ses_parent", json!({})),
    );
    assert!(wait_until(secs(10), || with_session(&home, "ses_parent").is_none()));
    let again = hook(
        &home,
        &["session-start", "--cli", "opencode"],
        &[],
        &input("session.created", "ses_child2", json!({})),
    );
    assert!(
        stdout(&again).starts_with("You are Facade guest #a3,"),
        "{again:?}"
    );
    assert_eq!(
        with_session(&home, "ses_child2").map(|guest| guest["agent_id"].clone()),
        Some(json!("a3")),
        "the guest's parts went with it"
    );
}

/// A guest outlasts the daemon: a daemon started anew lists it again with its number, reading
/// `unknown`, and its next prompt takes the message that waited for it (Core Review's S19). A guest
/// that Facade last heard from before the machine last started, whose CLI that start ended, ends at
/// the daemon's start with its inbox, as does one not heard from for 30 days.
#[test]
fn a_guest_and_what_waits_for_it_outlast_a_daemon_restart() {
    let home = TestHome::new("guestkept");
    let mut wire = connect(&home);
    for session in ["s1", "s2", "s3"] {
        hook(
            &home,
            &["session-start", "--cli", "claude"],
            &[],
            &input("SessionStart", session, json!({})),
        );
    }
    for guest in ["a1", "a2", "a3"] {
        assert_eq!(
            wire.call(
                "agent.send",
                json!({ "to": guest, "text": format!("for {guest}") })
            )["result"]["delivery"]["status"],
            "pending"
        );
    }
    let month = std::time::SystemTime::now() - std::time::Duration::from_secs(31 * 24 * 60 * 60);
    let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    store
        .execute(
            "UPDATE guests SET heard_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = 'a2'",
            [],
        )
        .unwrap();
    store
        .execute(
            "UPDATE guests SET heard_at = ?1 WHERE agent_id = 'a3'",
            [facade_base::time::iso_time(month)],
        )
        .unwrap();
    drop(wire);
    let old = home.kill_daemon();
    assert!(
        wait_until(secs(10), || home
            .hello_result()
            .is_none_or(|hello| hello["pid"].as_i64() != Some(old as i64))),
        "the daemon stayed"
    );
    connect(&home);
    let kept = with_session(&home, "s1").expect("the guest was kept");
    assert_eq!(
        (&kept["agent_id"], &kept["state"], &kept["guest"]),
        (&json!("a1"), &json!("unknown"), &json!(true)),
        "{kept}"
    );
    assert!(
        with_session(&home, "s2").is_none() && with_session(&home, "s3").is_none(),
        "the guests whose CLIs ended stayed"
    );
    let prompted = hook(
        &home,
        &["prompt", "--cli", "claude"],
        &[],
        &input("UserPromptSubmit", "s1", json!({})),
    );
    assert_eq!(
        printed(&prompted)["hookSpecificOutput"]["additionalContext"],
        "📨 Message from #human · #m1\nfor a1",
        "{prompted:?}"
    );
    let left: i64 = store
        .query_row(
            "SELECT count(*) FROM messages WHERE \"to\" IN ('a2', 'a3')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "their inboxes went with them");
}

/// Antigravity runs its prompt hook before each model call of a turn: only the turn's first,
/// `invocationNum` 1 or none, gives what waits. Its turn-end hook runs for a turn the person
/// cancelled too: the guest goes idle, nothing is handed over, and the next turn's first prompt
/// gives it.
#[test]
fn antigravity_gives_what_waits_at_a_turn_s_first_model_call() {
    let home = TestHome::new("agyturns");
    let mut wire = connect(&home);
    let agy = |event: &str, name: &str, more: Value| {
        let mut input = json!({ "hookEventName": name, "conversationId": "conv-1" });
        input
            .as_object_mut()
            .unwrap()
            .extend(more.as_object().cloned().unwrap_or_default());
        stdout(&hook(
            &home,
            &[event, "--cli", "agy"],
            &[],
            &input.to_string(),
        ))
    };
    agy("session-start", "SessionStart", json!({}));
    let given = |output: &str| {
        facade_scenarios::serde_json::from_str::<Value>(output)
            .unwrap()["injectSteps"][0]["systemMessage"]["systemMessage"]
            .clone()
    };
    assert_eq!(
        agy(
            "prompt",
            "PreInvocation",
            json!({ "invocationNum": 1, "initialNumSteps": 0 })
        ),
        "{}\n",
        "nothing waits"
    );
    wire.call("agent.send", json!({ "to": "a1", "text": "one" }));
    assert_eq!(
        agy(
            "prompt",
            "PreInvocation",
            json!({ "invocationNum": 2, "initialNumSteps": 0 })
        ),
        "{}\n",
        "a later model call of the turn"
    );
    let cancelled = agy(
        "turn-end",
        "Stop",
        json!({ "terminationReason": "USER_CANCELED", "continuationActive": false }),
    );
    assert_eq!(cancelled, "{}\n", "the person's cancel wins");
    assert!(wait_until(secs(10), || with_session(&home, "conv-1")
        .is_some_and(|guest| guest["state"] == "idle")));
    assert_eq!(
        given(&agy(
            "prompt",
            "PreInvocation",
            json!({ "initialNumSteps": 4 })
        )),
        "📨 Message from #human · #m1\none"
    );
}

/// Antigravity has no hook for a session's end, and one `agy` holds one conversation at a time: a
/// conversation that starts in the same `agy` as another ends the one before (Core Review's N21).
/// Here this test's process runs both hooks.
#[test]
fn a_conversation_that_starts_in_the_same_agy_ends_the_one_before() {
    let home = TestHome::new("agyagain");
    connect(&home);
    let start = |conversation: &str| {
        let input =
            json!({ "hookEventName": "SessionStart", "conversationId": conversation }).to_string();
        hook(&home, &["session-start", "--cli", "agy"], &[], &input)
    };
    start("conv-1");
    assert!(
        with_session(&home, "conv-1").is_some(),
        "the first conversation joined"
    );
    start("conv-2");
    assert!(
        wait_until(secs(10), || with_session(&home, "conv-1").is_none()),
        "the conversation before stayed"
    );
    assert!(
        with_session(&home, "conv-2").is_some(),
        "the new one is listed"
    );
}

/// A guest's terminal is not Facade's: reading its screen, typing, resizing, stopping, resuming and
/// removing it are refused, and its inspection says its input cannot be read.
#[test]
fn a_guest_s_terminal_is_not_facade_s() {
    let home = TestHome::new("guestterminal");
    let mut wire = connect(&home);
    hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[],
        &input("SessionStart", "s1", json!({})),
    );
    let refusal = "#a1 runs in a terminal of its own; start it with `facade start` for Facade to \
                   read, type into or stop it";
    for (op, args) in [
        ("agent.screen", json!({ "agent": "a1" })),
        ("agent.type", json!({ "agent": "a1", "text": "hello" })),
        (
            "agent.resize",
            json!({ "agent": "a1", "cols": 80, "rows": 24 }),
        ),
        ("agent.stop", json!({ "agent": "a1" })),
        (
            "agent.resume",
            json!({ "agent": "a1", "env": {}, "cols": 80, "rows": 24 }),
        ),
        ("agent.remove", json!({ "agent": "a1" })),
    ] {
        let refused = wire.call(op, args);
        assert_eq!(
            (error_reason(&refused), refused["error"]["message"].as_str()),
            ("unavailable", Some(refusal)),
            "{op}: {refused}"
        );
    }
    let watched = wire.request(
        "watch",
        json!({ "topic": "screen", "args": { "agent": "a1" } }),
    );
    assert_eq!(error_reason(&watched), "unavailable", "{watched}");
    let inspected = wire.call("agent.inspect", json!({ "agent": "a1" }));
    assert_eq!(
        inspected["result"]["input"]["state"], "unknown",
        "{inspected}"
    );
}

/// A command a guest's model runs acts for the guest, as the session variable its CLI gives it
/// says, ahead of the agent of the terminal it may also run in: `facade messages` reads the guest's
/// inbox, and `facade send` comes from it.
#[test]
fn a_command_acts_for_the_session_its_cli_names() {
    let home = TestHome::new("guestcommand");
    let mut wire = connect(&home);
    let host = start_script(&mut wire, &home, "host", "echo READY; sleep 60");
    hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[("FACADE_AGENT", &host)],
        &input("SessionStart", "s1", json!({})),
    );
    let guest = with_session(&home, "s1")
        .expect("a CLI started in an agent's terminal joins as a guest of its own")["agent_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(guest, host);
    let sent = wire.call(
        "agent.send",
        json!({ "to": guest, "text": "for the guest" }),
    );
    assert_eq!(sent["result"]["delivery"]["status"], "pending", "{sent}");
    let in_session = |args: &[&str]| {
        let mut command = home.command(&test_binaries().facade);
        command
            .env("FACADE_AGENT", &host)
            .env("CLAUDE_CODE_SESSION_ID", "s1")
            .args(args)
            .stdin(Stdio::null());
        command.output().unwrap()
    };
    let mut read = String::new();
    assert!(wait_until(secs(10), || {
        read = stdout(&in_session(&["messages"]));
        !read.is_empty()
    }));
    assert_eq!(read, "📨 Message from #human · #m1\nfor the guest\n");
    // The host's CLI reads no input, so the message stays in its inbox, which says who sent it.
    in_session(&["send", &host, "from the guest"]);
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", [1, 1], json!({ "agent": host }));
    let inbox = reader.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        inbox["result"]["snapshot"]["messages"][0]["from"], guest,
        "{inbox}"
    );
}

/// In a run Facade started, the run reports its own session and its typist delivers: its CLI's
/// hooks do nothing, take nothing and join no guest.
#[test]
fn hooks_do_nothing_in_a_run_facade_started_of_the_same_cli() {
    let home = TestHome::new("ownrun");
    let mut wire = connect(&home);
    let agent = start_script(&mut wire, &home, "plain", "echo READY; sleep 60");
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    assert!(
        !home
            .run_facade(&["send", &agent, "for the typist"])
            .status
            .success()
    );
    let own = [("FACADE_AGENT", agent.as_str())];
    for (event, name) in [
        ("session-start", "SessionStart"),
        ("prompt", "UserPromptSubmit"),
        ("turn-end", "Stop"),
        ("session-end", "SessionEnd"),
    ] {
        let output = hook(
            &home,
            &[event, "--cli", "sh"],
            &own,
            &input(name, "own", json!({ "stop_hook_active": false })),
        );
        assert!(
            output.status.success() && output.stdout.is_empty(),
            "{event}: {output:?}"
        );
    }
    assert!(
        with_session(&home, "own").is_none(),
        "the run's session joined as a guest"
    );
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", [1, 1], json!({ "agent": agent }));
    let left = reader.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        left["result"]["snapshot"]["messages"][0]["message_id"], "m1",
        "the hook took nothing: {left}"
    );
}

/// A hook never starts Facade and never fails its CLI's turn, whatever its input; in a background
/// job of Claude Code it does nothing. A hook exits 0 whatever its variables and words: a variable
/// that is not UTF-8, which JSON cannot carry, is left out of the environment a guest joins with,
/// and a line with a word that is not UTF-8 does nothing.
#[cfg(unix)]
#[test]
fn a_hook_with_a_variable_or_a_word_that_is_not_utf8_exits_0() {
    use std::os::unix::ffi::OsStrExt;
    let home = TestHome::new("notutf8hook");
    connect(&home);
    let not_utf8 = std::ffi::OsStr::from_bytes(b"caf\xe9");
    let run = |words: &[&std::ffi::OsStr], input: &str| {
        let mut command = home.command(&test_binaries().facade);
        command.arg("hook").args(words).env("NOT_UTF8", not_utf8);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes());
        child.wait_with_output().unwrap()
    };
    let claude = ["session-start", "--cli", "claude"].map(std::ffi::OsStr::new);
    let joined = run(&claude, &input("SessionStart", "s1", json!({})));
    assert!(joined.status.success(), "{joined:?}");
    assert!(with_session(&home, "s1").is_some(), "the guest joined");
    let unknown = run(
        &[claude[0], claude[1], claude[2], not_utf8],
        &input("SessionStart", "s2", json!({})),
    );
    assert!(
        unknown.status.success() && unknown.stdout.is_empty(),
        "{unknown:?}"
    );
    assert!(
        with_session(&home, "s2").is_none(),
        "a line this build cannot read did something"
    );
}

#[test]
fn hooks_never_start_facade_and_always_exit_0() {
    let home = TestHome::new("idlehooks");
    for (event, input) in [
        ("turn-end", input("Stop", "s1", json!({}))),
        ("turn-end", "not JSON".into()),
        ("prompt", String::new()),
    ] {
        let output = hook(&home, &[event, "--cli", "claude"], &[], &input);
        assert!(
            output.status.success() && output.stdout.is_empty() && output.stderr.is_empty(),
            "{event}: {output:?}"
        );
    }
    assert!(
        !socket_exists(&home.daemon_socket()),
        "a hook started Facade"
    );
    connect(&home);
    let job = hook(
        &home,
        &["session-start", "--cli", "claude"],
        &[("CLAUDE_JOB_DIR", "/tmp/job")],
        &input("SessionStart", "job", json!({})),
    );
    assert!(job.status.success() && job.stdout.is_empty(), "{job:?}");
    assert!(
        with_session(&home, "job").is_none(),
        "a background job joined as a guest"
    );
}
