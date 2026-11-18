//! Windows: an editor window's client describes its window, whose folders and their Git checkouts
//! are where its agents start; its agents outlive a disconnect, reload or daemon restart;
//! a window of the same workspace can reclaim the same logical reference; members can share a
//! running agent and receive its messages to `#human`; a start's location source is independent of
//! membership.

use std::path::Path;

use facade_base::daemon::WindowRef;
use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Runs `git args` in `folder` without the person's own Git settings.
fn git(folder: &Path, args: &[&str]) {
    let done = std::process::Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("LC_ALL", "en_US.UTF-8")
        .output()
        .unwrap();
    assert!(
        done.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&done.stderr)
    );
}

/// A repository in `folder` with one commit on `main`.
fn repository(folder: &Path) {
    std::fs::create_dir_all(folder).unwrap();
    git(folder, &["init", "-q", "-b", "main"]);
    git(
        folder,
        &[
            "-c",
            "user.name=Facade",
            "-c",
            "user.email=facade@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ],
    );
}

/// `path` with symbolic links resolved, as Facade lists locations.
fn real(path: &Path) -> String {
    facade_base::files::real_path(path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// The folder beside the test's Facade home where its repositories and folders go, which the test's
/// cleanup ends the processes of.
fn base(home: &TestHome) -> std::path::PathBuf {
    home.path.parent().unwrap().to_path_buf()
}

/// A local editor window's description.
fn window(id: &str, workspace: Option<&str>, folders: &[String]) -> Value {
    json!({
        "id": id, "label": format!("{id} window"), "environment": "local", "workspace": workspace,
        "folders": folders,
    })
}

/// Starts a shell agent `name` in window `window` at `cwd`, as the window's client starts one.
fn start_shell(
    wire: &mut DaemonTestClient,
    home: &TestHome,
    source: &WindowRef,
    cwd: &str,
    name: &str,
) -> String {
    let args = json!({
        "command": [SH.as_str(), "-c", "echo READY; sleep 600"], "name": name, "cwd": cwd,
        "location_source_window": source, "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path },
        "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} did not start: {started}"))
        .to_string()
}

/// Starts the test CLI as agent `name` in window `window` at `cwd`, and waits for its input box.
fn start_fake(
    wire: &mut DaemonTestClient,
    home: &TestHome,
    source: &WindowRef,
    cwd: &str,
    name: &str,
) -> String {
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log,
    });
    let args = json!({
        "command": ["fake"], "name": name, "cwd": cwd, "location_source_window": source, "env": env, "cols": 80,
        "rows": 24,
    });
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} did not start: {started}"))
        .to_string();
    assert!(
        wait_until(secs(30), || home.screen(name).contains("❯")),
        "{name} did not draw its input box: {}",
        home.screen(name)
    );
    id
}

/// Agent `id`'s record, from the `agents` topic.
fn agent(home: &TestHome, id: &str) -> Value {
    home.agents()
        .into_iter()
        .find(|agent| agent["agent_id"] == id)
        .unwrap_or_else(|| panic!("no agent {id}"))
}

fn running(home: &TestHome, id: &str) -> bool {
    agent(home, id)["process"] == "running"
}

/// A running agent's process and screen, read back by its original number.
fn live_agent(home: &TestHome, id: &str) -> (i32, String) {
    let record = agent(home, id);
    assert_eq!(record["process"], "running", "{record}");
    let pid = record["pid"].as_i64().expect("a running process has a PID") as i32;
    assert!(alive(&process_identity(pid)), "#{id} PID {pid} is alive");
    assert!(wait_for_screen_text(home, id, "READY"), "#{id}'s screen");
    (pid, home.screen(id))
}

/// The windows the `windows` topic lists now.
fn windows(home: &TestHome) -> Vec<Value> {
    let mut wire = connect(home);
    let watching = wire.request("watch", json!({ "topic": "windows" }));
    watching["result"]["snapshot"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| panic!("{watching}"))
}

/// Window `id` as the `windows` topic lists it now.
fn listed(home: &TestHome, id: &str) -> Option<Value> {
    windows(home)
        .into_iter()
        .find(|window| window["window_id"] == id)
}

fn disconnected(home: &TestHome, window: &WindowRef) -> bool {
    listed(home, &window.window_id).is_some_and(|listed| listed["connected"] == false)
}

fn memberships(windows: &[&WindowRef]) -> Value {
    let mut windows = windows.to_vec();
    windows.sort_unstable();
    json!(windows)
}

fn adopt(wire: &mut DaemonTestClient, agent: &str) -> Value {
    let adopted = wire.call("agent.adopt", json!({ "agent": agent }));
    assert_eq!(adopted["result"]["agent_id"], agent, "{adopted}");
    adopted["result"].clone()
}

/// Each location of window `listed` as its path and kind.
fn places(listed: &Value) -> Vec<(String, String)> {
    listed["locations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|location| {
            (
                location["path"].as_str().unwrap().to_string(),
                location["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// An editor window's folders are locations, and so is every checkout of a repository one of them
/// is in, whichever tool made it: the main checkout first, then the folder where it is another
/// place, then the other worktrees, each place once. A new description replaces the old one, and
/// the `windows` topic says so.
#[test]
fn an_editor_window_lists_its_folders_and_the_checkouts_of_their_repositories() {
    let home = TestHome::new("windowfolders");
    let (repo, notes) = (base(&home).join("app"), base(&home).join("notes"));
    repository(&repo);
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::create_dir_all(&notes).unwrap();
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "fix",
            &base(&home).join("app-fix").to_string_lossy(),
        ],
    );
    let folders = vec![real(&repo.join("src")), real(&notes), real(&repo)];
    let (mut wire, binding) = ide_binding(&home, &window("win-1", None, &folders));
    let shown = listed(&home, &binding.window_id).expect("the window is listed");
    assert_eq!(
        (&shown["label"], &shown["environment"], &shown["connected"]),
        (&json!("win-1 window"), &json!("local"), &json!(true))
    );
    assert_eq!(
        places(&shown),
        [
            (real(&repo), "main".into()),
            (real(&repo.join("src")), "folder".into()),
            (real(&base(&home).join("app-fix")), "worktree".into()),
            (real(&notes), "folder".into()),
        ]
    );
    assert_eq!(
        shown["locations"][2]["label"], "fix",
        "a checkout is named by its branch"
    );
    assert_eq!(
        shown["locations"][0]["location_id"],
        json!(facade_base::daemon::location_id(&real(&repo)))
    );
    let mut watcher = connect(&home);
    let watching = watcher.request("watch", json!({ "topic": "windows" }));
    let watch = watching["result"]["watch"].as_u64().unwrap();
    let updated = wire.call("window.update", window("win-1", None, &[real(&notes)]));
    assert_eq!(updated["result"], json!({}), "{updated}");
    assert_eq!(
        places(&listed(&home, &binding.window_id).unwrap()),
        [(real(&notes), "folder".into())]
    );
    assert!(wait_until(secs(5), || watcher.changes(watch).iter().any(
        |change| change["change"]["window"]["folders"] == json!([real(&notes)])
    )));
    let other = wire.call("window.update", window("win-2", None, &[]));
    assert_eq!(
        error_reason(&other),
        "invalid_argument",
        "a client describes its own window only: {other}"
    );
    let mut terminal = connect(&home);
    let refused = terminal.call("window.update", window("win-1", None, &[]));
    assert_eq!(
        error_reason(&refused),
        "invalid_argument",
        "only an ide client describes a window: {refused}"
    );
    let mut nameless = DaemonTestClient::open(&home);
    assert_eq!(
        error_reason(&nameless.hello("ide", DAEMON_RANGE, json!({}))),
        "invalid_argument",
        "an ide client describes its window"
    );
}

/// A disconnected window without a workspace can rebind until recovery. Recovery keeps windows
/// referenced by an agent record as a member or as its location source.
#[test]
fn recovery_removes_only_unreferenced_windows_without_a_workspace() {
    let home = TestHome::new("windowprune");
    let empty = window("win-unused", None, &[]);
    let (unused_wire, unused) = ide_binding(&home, &empty);
    let (member_wire, member) = ide_binding(&home, &window("win-member", None, &[]));
    let folder = real(&home.project);
    let (mut source_wire, source) = ide_binding(
        &home,
        &window("win-source", None, std::slice::from_ref(&folder)),
    );
    let mut terminal = connect(&home);
    let started = terminal.call(
        "agent.start",
        json!({
            "command": [SH.as_str(), "-c", "sleep 600"], "name": "kept", "cwd": folder,
            "window": member, "location_source_window": source,
            "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path },
            "cols": 80, "rows": 24,
        }),
    );
    let record = &started["result"]["agent"];
    let id = record["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("agent did not start: {started}"));
    assert_eq!(record["windows"], memberships(&[&member]), "{record}");
    assert_eq!(record["location_source_window"], json!(source), "{record}");
    let stopped = terminal.call("agent.stop", json!({ "agent": id }));
    assert!(stopped["result"].is_object(), "{stopped}");
    let cleared = source_wire.call("window.update", window("win-source", None, &[]));
    assert_eq!(cleared["result"], json!({}), "{cleared}");

    drop((unused_wire, member_wire, source_wire));
    for reference in [&unused, &member, &source] {
        assert!(
            wait_until(secs(5), || disconnected(&home, reference)),
            "window {} did not stay listed as disconnected: {:?}",
            reference.window_id,
            windows(&home)
        );
    }
    let (reloaded, before_recovery) = ide_binding(&home, &empty);
    assert_eq!(before_recovery, unused);
    drop((reloaded, terminal));
    home.wait_for_idle_exit();

    assert!(
        listed(&home, &unused.window_id).is_none(),
        "recovery removes the unreferenced window"
    );
    for (reference, label) in [
        (&member, "win-member window"),
        (&source, "win-source window"),
    ] {
        let restored =
            listed(&home, &reference.window_id).unwrap_or_else(|| panic!("recovery lost {label}"));
        assert_eq!(restored["connected"], false, "{restored}");
        assert_eq!(restored["label"], label, "{restored}");
    }
    let record = agent(&home, id);
    assert_eq!(record["process"], "ended", "{record}");
    assert_eq!(record["windows"], memberships(&[&member]), "{record}");
    assert_eq!(record["location_source_window"], json!(source), "{record}");
}

/// An editor window's agents keep running when its last connection ends, and a reload attaches
/// to the same processes and screens.
#[test]
fn an_editor_window_s_agents_outlive_a_disconnect_and_reload() {
    let home = TestHome::new("windowdisconnect");
    // Earlier daemons use this setting to shorten their disconnect timer to 1.5 seconds.
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "1500")]);
    let folder = real(&home.project);
    let described = window("win-1", Some("k1"), std::slice::from_ref(&folder));
    let (mut wire, reference) = ide_binding(&home, &described);
    let id = start_shell(&mut wire, &home, &reference, &folder, "kept");
    let before = live_agent(&home, &id);
    let record = agent(&home, &id);
    assert_eq!(record["windows"], memberships(&[&reference]));
    assert_eq!(record["location_source_window"], json!(reference));
    assert_eq!(
        record["location_id"],
        json!(facade_base::daemon::location_id(&folder))
    );
    drop(wire);
    assert!(wait_until(secs(5), || disconnected(&home, &reference)));
    std::thread::sleep(secs(3));
    assert_eq!(live_agent(&home, &id), before);
    assert!(disconnected(&home, &reference));
    let (_reloaded, returned) = ide_binding(&home, &described);
    assert_eq!(
        returned, reference,
        "a reload reuses the instance's logical window"
    );
    assert_eq!(live_agent(&home, &id), before);
    assert_eq!(agent(&home, &id)["windows"], memberships(&[&reference]));
    assert_eq!(
        listed(&home, &reference.window_id).unwrap()["connected"],
        true
    );
}

/// A reopened workspace binds its original logical window without moving its agents; an active
/// second window and the late original instance each get another reference.
#[test]
fn a_reopened_workspace_reclaims_its_logical_window_while_its_next_window_is_separate() {
    let home = TestHome::new("windowrebind");
    // Earlier daemons use this setting to stop agents after 3 seconds without a window.
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "3000")]);
    let folders = vec![real(&home.project)];
    let first_description = window("win-1", Some("workspace"), &folders);
    let (mut first, original) = ide_binding(&home, &first_description);
    let id = start_shell(&mut first, &home, &original, &folders[0], "staying");
    let before = live_agent(&home, &id);
    drop(first);
    assert!(wait_until(secs(5), || disconnected(&home, &original)));
    std::thread::sleep(secs(5));

    let (_reopened, reclaimed) = ide_binding(&home, &window("win-2", Some("workspace"), &folders));
    assert_eq!(reclaimed, original);
    assert_eq!(live_agent(&home, &id), before);
    assert_eq!(agent(&home, &id)["windows"], memberships(&[&original]));

    let (_second, separate) = ide_binding(&home, &window("win-3", Some("workspace"), &folders));
    assert_ne!(
        separate, original,
        "an active window keeps its own reference"
    );
    let (mut late, given) = ide_binding(&home, &first_description);
    assert_ne!(
        given, original,
        "the old instance cannot take its old binding"
    );
    assert_ne!(
        given, separate,
        "the other active window keeps its binding too"
    );
    let mut later = first_description;
    later["label"] = json!("Late editor");
    let reply = late.call("window.update", later);
    assert_eq!(reply["result"], json!({}), "{reply}");
    assert_eq!(
        listed(&home, &given.window_id).unwrap()["label"],
        "Late editor"
    );
    assert_eq!(
        listed(&home, &original.window_id).unwrap()["label"],
        "win-2 window"
    );
    assert_eq!(agent(&home, &id)["windows"], memberships(&[&original]));
    assert_eq!(live_agent(&home, &id), before);
}

/// A daemon restart leaves every editor window disconnected, and their agents keep running whether
/// or not the windows reconnect.
#[test]
fn an_editor_window_s_agents_outlive_a_daemon_restart() {
    let home = TestHome::new("windowrestart");
    // Earlier daemons use this setting to start a 4-second timer at restart for each window.
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "4000")]);
    let folders = vec![real(&home.project)];
    let first = window("win-back", Some("k1"), &folders);
    let second = window("win-gone", Some("k2"), &folders);
    let (mut back, back_ref) = ide_binding(&home, &first);
    let (mut gone, gone_ref) = ide_binding(&home, &second);
    let kept = start_shell(&mut back, &home, &back_ref, &folders[0], "kept");
    let away = start_shell(&mut gone, &home, &gone_ref, &folders[0], "away");
    let kept_before = live_agent(&home, &kept);
    let away_before = live_agent(&home, &away);
    let old = home.kill_daemon();
    drop((back, gone));
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    for (binding, label) in [
        (&back_ref, "win-back window"),
        (&gone_ref, "win-gone window"),
    ] {
        let persisted = listed(&home, &binding.window_id).expect("the logical window is restored");
        assert_eq!(persisted["connected"], false, "{persisted}");
        assert_eq!(persisted["label"], label);
        assert_eq!(persisted["machine_id"], binding.machine_id);
    }
    let (_reconnected, returned) = ide_binding(&home, &first);
    assert_eq!(returned, back_ref);
    std::thread::sleep(secs(6));
    assert_eq!(live_agent(&home, &kept), kept_before);
    assert_eq!(live_agent(&home, &away), away_before);
    assert_eq!(agent(&home, &kept)["windows"], memberships(&[&back_ref]));
    assert_eq!(agent(&home, &away)["windows"], memberships(&[&gone_ref]));
    assert_eq!(
        listed(&home, &back_ref.window_id).unwrap()["connected"],
        true
    );
    assert!(disconnected(&home, &gone_ref));
}

/// Adoption adds a member to the same record and process. Guest records stay in their own window.
#[test]
fn two_editors_share_a_running_agent_after_adoption() {
    let home = TestHome::new("windowadopt");
    let folder = real(&home.project);
    let folders = std::slice::from_ref(&folder);
    let (mut first, origin) = ide_binding(&home, &window("win-1", Some("one"), folders));
    let (mut second, other) = ide_binding(&home, &window("win-2", Some("two"), folders));
    let id = start_shell(&mut first, &home, &origin, &folder, "kept");
    let before = live_agent(&home, &id);
    assert_eq!(
        adopt(&mut second, &id)["windows"],
        memberships(&[&origin, &other])
    );
    for wire in [&mut first, &mut second] {
        let reply = wire.request("watch", json!({ "topic": "agents" }));
        let record = reply["result"]["snapshot"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["agent_id"] == id)
            .unwrap_or_else(|| panic!("no {id} in {reply}"));
        assert_eq!(record["pid"], before.0, "{record}");
        assert_eq!(record["machine_id"], origin.machine_id, "{record}");
        assert_eq!(
            record["windows"],
            memberships(&[&origin, &other]),
            "{record}"
        );
    }
    assert_eq!(live_agent(&home, &id), before);

    let mut guest = McpTestClient::open_guest(&home, "codex", &[]);
    let joined = guest.call_in(
        "list_agents",
        json!({}),
        json!({ "sessionId": "guest-session" }),
    );
    assert_eq!(joined["status"], "success", "{joined}");
    let guest = home
        .agents()
        .into_iter()
        .find(|agent| agent["session"] == "guest-session")
        .expect("the fake guest joined");
    assert_eq!(guest["guest"], true, "{guest}");
    let refused = second.call("agent.adopt", json!({ "agent": guest["agent_id"] }));
    assert_eq!(error_reason(&refused), "refused", "{refused}");
}

/// A message to the person has one number and reaches each member window's current subscription.
#[test]
fn messages_to_the_person_report_each_member_windows_delivery() {
    let home = TestHome::new("windowhuman");
    let folder = real(&home.project);
    let folders = std::slice::from_ref(&folder);
    let (mut first, left) = ide_binding(&home, &window("win-1", Some("one"), folders));
    let (mut second, right) = ide_binding(&home, &window("win-2", Some("two"), folders));
    let id = start_shell(&mut first, &home, &left, &folder, "teller");
    adopt(&mut second, &id);
    let watch = |wire: &mut DaemonTestClient| {
        let response = wire.request("watch", json!({ "topic": "messages" }));
        assert_eq!(
            response["result"]["snapshot"]["messages"],
            json!([]),
            "{response}"
        );
        response["result"]["watch"].as_u64().unwrap()
    };
    let (mine, theirs) = (watch(&mut first), watch(&mut second));
    let mut sender = DaemonTestClient::open(&home);
    let hello = sender.hello("terminal", DAEMON_RANGE, json!({ "agent": id }));
    assert_eq!(hello["result"]["agent"], id, "{hello}");
    let sent = sender.call(
        "agent.send",
        json!({ "to": "#human", "text": "build is green" }),
    );
    let message = &sent["result"];
    let number = message["message_id"].as_str().expect("one message number");
    assert_eq!(
        message["windows"]["delivered"],
        memberships(&[&left, &right]),
        "{sent}"
    );
    assert_eq!(message["windows"]["not_delivered"], json!([]));
    for (wire, watch) in [(&first, mine), (&second, theirs)] {
        assert!(
            wait_until(secs(5), || wire
                .changes(watch)
                .iter()
                .any(|change| change["change"]["message"]["message_id"] == number
                    && change["change"]["message"]["text"] == "build is green")),
            "both subscriptions see message {number}: {:?}",
            wire.changes(watch)
        );
    }
    let reread = first.request(
        "watch",
        json!({ "topic": "messages", "args": { "ids": [number] } }),
    );
    assert_eq!(
        reread["result"]["snapshot"]["messages"][0]["text"],
        "build is green"
    );

    drop(second);
    assert!(wait_until(secs(5), || disconnected(&home, &right)));
    let partial = sender.call(
        "agent.send",
        json!({ "to": "#human", "text": "one window is here" }),
    );
    assert_eq!(
        partial["result"]["windows"]["delivered"],
        memberships(&[&left]),
        "{partial}"
    );
    assert_eq!(
        partial["result"]["windows"]["not_delivered"],
        json!([{ "window": right, "reason": "window_disconnected" }]),
        "{partial}"
    );
    let command = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", &id)
        .args(["send", "#human", "the command reports both outcomes"])
        .output()
        .unwrap();
    assert!(command.status.success(), "{}", stderr(&command));
    let printed = stdout(&command);
    let lines: Vec<_> = printed.lines().collect();
    assert_eq!(lines.len(), 3, "{printed}");
    assert!(
        lines[0].starts_with("#m")
            && lines[0].ends_with("was handed to these window subscriptions"),
        "{printed}"
    );
    assert!(
        lines[1].contains(&left.window_id) && lines[1].contains(&left.machine_id),
        "{printed}"
    );
    assert!(
        lines[2].starts_with("Could not hand the message to")
            && lines[2].contains(&right.window_id)
            && lines[2].contains(&right.machine_id)
            && lines[2].contains("window is disconnected"),
        "{printed}"
    );
    drop(first);
    assert!(wait_until(secs(5), || disconnected(&home, &left)));
    let refused = sender.call(
        "agent.send",
        json!({ "to": "#human", "text": "nobody is here" }),
    );
    assert_eq!(error_reason(&refused), "unavailable", "{refused}");
    let failures = refused["error"]["data"]["windows"].as_array().unwrap();
    assert_eq!(failures.len(), 2, "{refused}");
    for window in [&left, &right] {
        assert!(
            failures.contains(&json!({ "window": window, "reason": "window_disconnected" })),
            "{refused}"
        );
    }
    let kept: i64 = rusqlite::Connection::open(home.path.join("core/facade.db"))
        .unwrap()
        .query_row("SELECT count(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, 3, "only the delivered messages were saved");

    let (mut late, _) = ide_binding(&home, &window("win-3", Some("three"), folders));
    adopt(&mut late, &id);
    watch(&mut late);
}

/// Editor and terminal starts derive their members from their caller. An agent inherits all of its
/// creator's members by default; a chosen member and a location source can be different windows.
#[test]
fn starts_keep_members_and_location_sources_separate() {
    let home = TestHome::new("windowstart");
    let repo = base(&home).join("app");
    repository(&repo);
    std::fs::create_dir_all(base(&home).join("app.worktrees/review")).unwrap();
    let folder = real(&repo);
    let (mut wire, source) = ide_binding(
        &home,
        &window("win-1", Some("one"), std::slice::from_ref(&folder)),
    );
    let boss = start_fake(&mut wire, &home, &source, &folder, "boss");
    let parent = agent(&home, &boss);
    assert_eq!(parent["windows"], memberships(&[&source]));
    assert_eq!(parent["location_source_window"], json!(source));

    let terminal = home.start_named_fake("ordinary-terminal", &[]);
    let terminal = agent(&home, &terminal.id);
    assert_eq!(
        terminal["windows"],
        json!([{ "machine_id": source.machine_id, "window_id": "terminal" }])
    );
    assert!(
        terminal.get("location_source_window").is_none(),
        "{terminal}"
    );

    let outside = wire.call(
        "agent.start",
        json!({
            "command": [SH.as_str()], "cwd": real(&home.project), "location_source_window": source,
            "cols": 80, "rows": 24,
        }),
    );
    assert_eq!(error_reason(&outside), "invalid_argument", "{outside}");
    let (mut peer, away) = ide_binding(
        &home,
        &window("win-away", Some("two"), &[real(&home.project)]),
    );
    adopt(&mut peer, &boss);
    drop(peer);
    assert!(wait_until(secs(5), || disconnected(&home, &away)));

    let output = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", &boss)
        .args(["start", "--name", "child-from-cli", "fake"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let child = agent(&home, &started_id(&stdout(&output)));
    assert_eq!(child["windows"], memberships(&[&source, &away]));
    assert!(child.get("location_source_window").is_none(), "{child}");

    let mut mcp = McpTestClient::open(&home, &boss);
    let inherited = mcp.call(
        "start_agent",
        json!({ "name": "helper", "cli": "fake", "path": folder }),
    );
    assert_eq!(inherited["status"], "success", "{inherited}");
    assert_eq!(inherited["data"]["windows"], memberships(&[&source, &away]));
    assert_eq!(inherited["data"]["machine_id"], source.machine_id);
    let worktree = json!({ "name": "reviewer", "cli": "fake", "path": folder, "worktree": "review",
        "window": away.window_id, "location_source_window": source.window_id });
    let made = mcp.call("start_agent", worktree.clone());
    assert_eq!(made["status"], "success", "{made}");
    let path = real(&base(&home).join("app.worktrees/review-1"));
    assert_eq!(made["data"]["path"], path, "{made}");
    assert_eq!(made["data"]["windows"], memberships(&[&away]));
    let reviewer = home.agent_from_list_json("reviewer").unwrap();
    assert_eq!(reviewer["location_source_window"], json!(source));
    assert_eq!(reviewer["windows"], memberships(&[&away]));
    assert!(
        places(&listed(&home, &source.window_id).unwrap())
            .contains(&(path.clone(), "worktree".into()))
    );

    let again = mcp.call("start_agent", worktree);
    assert!(
        again["message"]
            .as_str()
            .unwrap()
            .starts_with("a branch named review already exists"),
        "{again}"
    );
    let list = mcp.call("list_agents", json!({}));
    let windows = list["data"]["windows"].as_array().unwrap();
    let connected = windows
        .iter()
        .find(|window| window["id"] == source.window_id)
        .unwrap();
    assert_eq!(connected["connected"], true, "{connected}");
    assert!(
        connected["folders"]
            .as_array()
            .unwrap()
            .contains(&json!(path))
    );
    let offline = windows
        .iter()
        .find(|window| window["id"] == away.window_id)
        .unwrap();
    assert_eq!(offline["connected"], false, "{offline}");
    assert_eq!(offline["machine_id"], source.machine_id, "{offline}");
    assert!(
        offline.get("folders").is_none() && offline.get("clis").is_none(),
        "{offline}"
    );
}

/// Two creations of one branch sent together take turns: one makes the worktree, and the other is
/// refused as the branch now exists, claiming nothing it did not make. Git here takes half a second
/// to add a worktree, as a slow disk or a checkout hook makes it.
#[test]
fn two_creations_of_one_branch_never_claim_the_other_s_branch() {
    let home = TestHome::new("worktreerace");
    let repo = base(&home).join("repo");
    repository(&repo);
    let programs = base(&home).join("slowgit");
    std::fs::create_dir_all(&programs).unwrap();
    #[cfg(unix)]
    let git_program = {
        let found = std::process::Command::new(SH.as_str())
            .args(["-c", "command -v git"])
            .output()
            .unwrap();
        String::from_utf8(found.stdout).unwrap().trim().to_string()
    };
    #[cfg(windows)]
    let git_program = git_install()
        .join("cmd")
        .join("git.exe")
        .display()
        .to_string();
    let script = format!(
        "#!/bin/sh\ncase \"$*\" in *\"worktree add\"*) sleep 0.5;; esac\nexec \
         '{git_program}' \"$@\"\n"
    );
    install_script(&programs, "git", &script);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        std::env::var("PATH").unwrap()
    );
    home.start_facade_with(&[("PATH", &path)]);
    let (mut wire, window_ref) = ide_binding(&home, &window("win-1", Some("k1"), &[real(&repo)]));
    let args = json!({ "window_id": window_ref.window_id, "cwd": real(&repo), "branch": "review", "base_ref": "HEAD" });
    let first = wire.send("call", json!({ "op": "worktree.create", "args": args }));
    let second = wire.send("call", json!({ "op": "worktree.create", "args": args }));
    let answers = [
        wire.wait_for_response(first, secs(30)).unwrap(),
        wire.wait_for_response(second, secs(30)).unwrap(),
    ];
    let (made, refused): (Vec<&Value>, Vec<&Value>) = answers
        .iter()
        .partition(|answer| answer["result"].is_object());
    assert_eq!((made.len(), refused.len()), (1, 1), "{answers:?}");
    let refused = refused[0];
    assert_eq!(error_reason(refused), "invalid_argument", "{refused}");
    assert_eq!(
        refused["error"]["message"], "a branch named review already exists",
        "{refused}"
    );
    assert!(
        refused["error"]["data"].get("kept").is_none(),
        "it claims nothing it did not make: {refused}"
    );
}

/// An agent ends once its location is known to be gone: its window no longer has the folder that
/// brought it, or Git no longer lists its worktree and its folder no longer exists. A worktree
/// folder that still exists keeps its agents.
#[test]
fn an_agent_ends_when_its_location_is_gone_from_its_window() {
    let home = TestHome::new("windowremoval");
    let (repo, notes) = (base(&home).join("app"), base(&home).join("notes"));
    repository(&repo);
    std::fs::create_dir_all(&notes).unwrap();
    let (fix, kept) = (base(&home).join("app-fix"), base(&home).join("app-kept"));
    git(
        &repo,
        &["worktree", "add", "-q", "-b", "fix", &fix.to_string_lossy()],
    );
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "kept",
            &kept.to_string_lossy(),
        ],
    );
    let fix_path = real(&fix);
    let folders = vec![real(&repo), real(&notes)];
    let (mut wire, source) = ide_binding(&home, &window("win-1", Some("k1"), &folders));
    let in_notes = start_shell(&mut wire, &home, &source, &real(&notes), "notes");
    #[cfg_attr(windows, allow(unused_variables))]
    let in_fix = start_shell(&mut wire, &home, &source, &fix_path, "fix");
    let in_kept = start_shell(&mut wire, &home, &source, &real(&kept), "kept");
    let in_main = start_shell(&mut wire, &home, &source, &real(&repo), "main");
    let (mut other, _) = ide_binding(&home, &window("win-2", Some("other"), &folders));
    adopt(&mut other, &in_notes);
    let update = other.call(
        "window.update",
        window("win-2", Some("other"), &[real(&repo)]),
    );
    assert_eq!(update["result"], json!({}), "{update}");
    let notes_end = format!("#{in_notes} ends: its location {}", real(&notes));
    assert!(
        !wait_until(secs(1), || home.daemon_log().contains(&notes_end)),
        "a different member's update scheduled a stop: {}",
        home.daemon_log()
    );
    assert!(
        running(&home, &in_notes),
        "a different member's removal does not stop the agent"
    );
    // The kept worktree is no longer registered, but its folder stays: nothing proves it gone.
    std::fs::remove_dir_all(repo.join(".git/worktrees/app-kept")).unwrap();
    assert_eq!(
        wire.call("window.update", window("win-1", Some("k1"), &[real(&repo)]))["result"],
        json!({})
    );
    assert!(
        wait_until(secs(15), || !running(&home, &in_notes)),
        "an agent in a folder the window no longer has ends"
    );
    assert!(
        home.daemon_log().contains(&format!(
            "{notes_end} is gone from window {}",
            source.window_id
        )),
        "missing stop decision for the source window: {}",
        home.daemon_log()
    );
    // Windows deletes no folder a running agent works in: its worktree cannot go while it runs.
    #[cfg(unix)]
    {
        git(&repo, &["worktree", "remove", &fix.to_string_lossy()]);
        // While another folder of the window cannot be read, nothing proves the worktree gone.
        let locked = base(&home).join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        let with_locked = vec![real(&repo), real(&locked)];
        // A folder no one may read is made so by its mode on Unix.
        #[cfg(unix)]
        {
            std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000))
                .unwrap();
            assert_eq!(
                wire.call("window.update", window("win-1", Some("k1"), &with_locked))["result"],
                json!({})
            );
            let problems = listed(&home, &source.window_id).unwrap()["problems"].clone();
            std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            assert!(
                problems[0]
                    .as_str()
                    .is_some_and(|problem| problem.starts_with(&format!(
                        "could not read the Git worktrees of {}",
                        real(&locked)
                    ))),
                "{problems}"
            );
            // An update answers once its read decided which agents end, and logs each one before it
            // answers.
            assert!(
                !home.daemon_log().contains(&format!("#{in_fix} ends")),
                "a failed read proves nothing: {}",
                home.daemon_log()
            );
            assert!(running(&home, &in_fix));
        }
        assert_eq!(
            wire.call("window.update", window("win-1", Some("k1"), &with_locked))["result"],
            json!({})
        );
        assert!(
            wait_until(secs(15), || !running(&home, &in_fix)),
            "an agent in a deleted worktree ends"
        );
    }
    assert!(
        running(&home, &in_kept) && running(&home, &in_main),
        "{}",
        home.daemon_log()
    );
    #[cfg(unix)]
    assert!(
        home.daemon_log().contains(&format!(
            "#{in_fix} ends: its location {fix_path} is gone from window {}",
            source.window_id
        )),
        "{}",
        home.daemon_log()
    );
}

/// Both a terminal and another member can resume a stopped record. Its original location and
/// members stay with the record, even when the member's workspace does not include that location.
#[test]
fn an_agent_resumes_with_its_original_members_and_location() {
    let home = TestHome::new("windowresume");
    let folder = real(&home.project);
    let (mut first, source) = ide_binding(
        &home,
        &window("win-1", Some("k1"), std::slice::from_ref(&folder)),
    );
    let elsewhere = base(&home).join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (mut other, member) = ide_binding(&home, &window("win-2", Some("k2"), &[real(&elsewhere)]));
    let session = "11111111-2222-4333-8444-555555555555";
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log, "FAKECLI_SESSION": session,
    });
    // Windows PowerShell, which runs the session hook on Windows, does not start without it.
    #[cfg(windows)]
    let env = {
        let mut env = env;
        env["SystemRoot"] = json!(std::env::var("SystemRoot").unwrap());
        env
    };
    let started = first.call(
        "agent.start",
        json!({
            "command": ["fake"], "name": "kept", "cwd": folder, "location_source_window": source,
            "env": env, "cols": 80, "rows": 24,
        }),
    );
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"));
    assert!(
        wait_until(secs(15), || agent(&home, id)["session"] == session),
        "{}",
        agent(&home, id)
    );
    adopt(&mut other, id);
    let check = |record: &Value| {
        assert_eq!(record["agent_id"], id, "{record}");
        assert_eq!(record["cwd"], folder, "{record}");
        assert_eq!(record["session"], session, "{record}");
        assert_eq!(
            record["windows"],
            memberships(&[&source, &member]),
            "{record}"
        );
        assert_eq!(record["location_source_window"], json!(source), "{record}");
        assert_eq!(record["process"], "running", "{record}");
    };
    home.run_facade_ok(&["stop", id]);
    assert!(wait_until(secs(15), || !running(&home, id)));
    home.run_facade_ok(&["resume", id]);
    check(&agent(&home, id));

    home.run_facade_ok(&["stop", id]);
    assert!(wait_until(secs(15), || !running(&home, id)));
    let resumed = other.call(
        "agent.resume",
        json!({ "agent": id, "env": env, "cols": 80, "rows": 24 }),
    );
    assert!(resumed["result"].is_object(), "{resumed}");
    check(&resumed["result"]);
    check(&agent(&home, id));
}

/// A message from an agent of another window names that window in its header; one within a window
/// does not. send_message names the window of a recipient in another window.
#[test]
fn a_message_between_windows_names_its_sender_s_window() {
    let home = TestHome::new("windowheader");
    let folders = vec![real(&home.project)];
    let (mut first, origin) = ide_binding(&home, &window("win-1", Some("k1"), &folders));
    let (mut second, peer) = ide_binding(&home, &window("win-2", Some("k2"), &folders));
    let ada = start_fake(&mut first, &home, &origin, &folders[0], "ada");
    start_fake(&mut first, &home, &origin, &folders[0], "bea");
    start_fake(&mut second, &home, &peer, &folders[0], "cal");
    let send = |to: &str, text: &str| {
        home.command(&test_binaries().facade)
            .env("FACADE_AGENT", &ada)
            .args(["send", to, text])
            .output()
            .unwrap()
    };
    assert!(send("cal", "across").status.success());
    assert!(send("bea", "within").status.success());
    assert_eq!(
        home.submitted_messages(),
        [
            format!("📨 Message from ada (#{ada}) · #m1 · From win-1 window\nacross"),
            format!("📨 Message from ada (#{ada}) · #m2\nwithin")
        ]
    );
    drop((first, second));
}

/// A member editor's resize selects its colors, even when it keeps the prior dimensions.
#[test]
fn an_agents_colors_follow_the_last_member_editor_to_resize() {
    let home = TestHome::new("windowcolors");
    let folder = real(&home.project);
    let mut described = window("win-1", Some("k1"), std::slice::from_ref(&folder));
    described["colors"] =
        json!({ "foreground": "#333333", "background": "#ffffff", "cursor": "#000000" });
    let (mut first, window_ref) = ide_binding(&home, &described);
    let id = start_fake(&mut first, &home, &window_ref, &folder, "painter");
    type_raw(&mut first, &id, "/fake colors\r");
    for reply in [
        "color 10;rgb:3333/3333/3333 bel",
        "color 11;rgb:ffff/ffff/ffff st",
        "color 12;rgb:0000/0000/0000 bel",
    ] {
        assert!(
            wait_for_screen_text(&home, &id, reply),
            "{reply}: {}",
            home.screen(&id)
        );
    }

    described["colors"]["background"] = json!("#1e1e1e");
    let updated = first.call("window.update", described);
    assert_eq!(updated["result"], json!({}), "{updated}");
    type_raw(&mut first, &id, "/fake colors\r");
    assert!(wait_for_screen_text(
        &home,
        &id,
        "color 11;rgb:1e1e/1e1e/1e1e st"
    ));

    let mut described = window("win-2", Some("k2"), std::slice::from_ref(&folder));
    described["colors"] =
        json!({ "foreground": "#eeeeee", "background": "#225588", "cursor": "#000000" });
    let (mut second, _) = ide_binding(&home, &described);
    adopt(&mut second, &id);
    for wire in [&mut first, &mut second] {
        let resize = wire.call(
            "agent.resize",
            json!({ "agent": id, "cols": 80, "rows": 24 }),
        );
        assert!(resize["result"].is_object(), "{resize}");
    }
    let theirs = "color 11;rgb:2222/5555/8888 st";
    type_raw(&mut first, &id, "/fake colors\r");
    assert!(
        wait_for_screen_text(&home, &id, theirs),
        "{}",
        home.screen(&id)
    );

    let mut terminal = TestTerminal::spawn(
        home.command(&test_binaries().facade).args(["attach", &id]),
        93,
        31,
    );
    assert!(
        wait_until(secs(10), || {
            let observed = connect(&home).request(
                "watch",
                json!({ "topic": "screen", "args": { "agent": id } }),
            );
            let screen = &observed["result"]["snapshot"];
            screen["cols"] == 93 && screen["rows"] == 31
        }),
        "the terminal attach sets the dimensions"
    );
    let was = home.screen(&id).matches(theirs).count();
    type_raw(&mut first, &id, "/fake colors\r");
    assert!(
        wait_until(secs(10), || home.screen(&id).matches(theirs).count() > was),
        "terminal attach leaves the editor's colors in use: {}",
        home.screen(&id)
    );
    terminal.send(b"\x1d");
    assert!(
        terminal.wait_exit(secs(10)).is_some(),
        "the attach detached"
    );
}

/// In an editor window, a start that continues a session may work in a folder inside one of the
/// window's locations, as "Recent" continues a conversation in the folder it was in: it starts,
/// and its location is the one that holds the folder.
#[test]
fn a_start_in_a_folder_inside_a_location_continues_its_session_there() {
    let home = TestHome::new("windowinside");
    let folder = real(&home.project);
    let nested = home.project.join("app").join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let nested = real(&nested);
    let (mut wire, window_ref) = ide_binding(
        &home,
        &window("win-1", Some("k1"), std::slice::from_ref(&folder)),
    );
    let location =
        listed(&home, &window_ref.window_id).unwrap()["locations"][0]["location_id"].clone();
    let session = "11111111-2222-4333-8444-555555555555";
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log,
    });
    // PowerShell needs SystemRoot to run the session hook on Windows.
    #[cfg(windows)]
    let env = {
        let mut env = env;
        env["SystemRoot"] = json!(std::env::var("SystemRoot").unwrap());
        env
    };
    let args = json!({
        "command": ["fake"], "session": session, "name": "inside", "cwd": nested,
        "location_source_window": window_ref, "env": env, "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    assert!(
        wait_for_screen_text(&home, "inside", &format!("session {session}")),
        "the CLI continued the session: {}",
        home.screen("inside")
    );
    let record = agent(&home, &id);
    assert_eq!(record["cwd"], json!(nested), "{record}");
    assert_eq!(record["location_id"], location, "{record}");
}

/// A reopened workspace lists stopped agents in its original logical window.
#[test]
fn a_reopened_workspace_lists_its_ended_agents_under_the_same_logical_window() {
    let home = TestHome::new("windowended");
    let folders = vec![real(&home.project)];
    let (mut first, original) = ide_binding(&home, &window("win-old", Some("k1"), &folders));
    let id = start_shell(&mut first, &home, &original, &folders[0], "kept");
    let stopped = first.call("agent.stop", json!({ "agent": id }));
    assert!(
        stopped["result"].is_object() && stopped["result"]["already_ended"] != true,
        "{stopped}"
    );
    assert!(
        wait_until(secs(15), || !running(&home, &id)),
        "{}",
        home.daemon_log()
    );
    drop(first);
    assert!(wait_until(secs(5), || disconnected(&home, &original)));
    let (mut later, reclaimed) = ide_binding(&home, &window("win-new", Some("k1"), &folders));
    assert_eq!(reclaimed, original);
    let snapshot = later.request("watch", json!({ "topic": "agents" }));
    let kept = snapshot["result"]["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["agent_id"] == id)
        .unwrap_or_else(|| panic!("no {id} in the first snapshot: {snapshot}"));
    assert_eq!(kept["windows"], memberships(&[&original]), "{kept}");
    assert_eq!(kept["process"], "ended", "{kept}");
}
