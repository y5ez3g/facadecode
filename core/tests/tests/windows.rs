//! Windows: an editor window's client describes its window, whose folders and their Git checkouts
//! are where its agents start; its agents outlive a reload or a daemon restart and end after its
//! grace; a window of the same workspace takes them over; the person is told what an agent of an
//! editor window sends to `#human`; `start_agent` starts in a window's location, making a worktree
//! there first where asked; and a message between windows names its sender's window.

use std::path::Path;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// The grace the daemon gives a window that went, in milliseconds, in these tests.
const GRACE_MS: &str = "1500";

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
    window: &str,
    cwd: &str,
    name: &str,
) -> String {
    let args = json!({
        "command": [SH.as_str(), "-c", "echo READY; sleep 600"], "name": name, "cwd": cwd,
        "window_id": window, "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path },
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
    window: &str,
    cwd: &str,
    name: &str,
) -> String {
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log,
    });
    let args = json!({
        "command": ["fake"], "name": name, "cwd": cwd, "window_id": window, "env": env, "cols": 80,
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
    let mut wire = ide(&home, &window("win-1", Some("k1"), &folders));
    let shown = listed(&home, "win-1").expect("the window is listed");
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
    let updated = wire.call(
        "window.update",
        window("win-1", Some("k1"), &[real(&notes)]),
    );
    assert_eq!(updated["result"], json!({}), "{updated}");
    assert_eq!(
        places(&listed(&home, "win-1").unwrap()),
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
        error_reason(&nameless.hello("ide", [1, 1], json!({}))),
        "invalid_argument",
        "an ide client describes its window"
    );
    drop(wire);
    assert!(
        wait_until(secs(10), || listed(&home, "win-1").is_none()),
        "a window with no agents goes with its last connection"
    );
}

/// An editor window's agents outlive a reload: a connection of the same window within its grace
/// keeps them. Once the window stays away for its grace, its running agents end as a stop ends
/// them, and their records stay.
#[test]
fn an_editor_window_s_agents_outlive_a_reload_and_end_after_its_grace() {
    let home = TestHome::new("windowgrace");
    home.start_facade_with(&[
        ("FACADE_TEST_GRACE_MS", GRACE_MS),
        ("FACADE_TEST_GATES", "grace-window-back"),
    ]);
    let folders = vec![real(&home.project)];
    let mut wire = ide(&home, &window("win-1", Some("k1"), &folders));
    let id = start_shell(&mut wire, &home, "win-1", &real(&home.project), "kept");
    assert_eq!(
        (
            &agent(&home, &id)["window_id"],
            &agent(&home, &id)["location_id"]
        ),
        (
            &json!("win-1"),
            &json!(facade_base::daemon::location_id(&real(&home.project)))
        )
    );
    drop(wire);
    assert!(
        wait_until(secs(5), || listed(&home, "win-1")
            .is_some_and(|window| window["connected"] == false)),
        "the window waits, not connected"
    );
    let reloaded = ide(&home, &window("win-1", Some("k1"), &folders));
    home.wait_for_gate("grace-window-back");
    assert!(
        running(&home, &id),
        "a reload within the grace keeps the window's agents"
    );
    drop(reloaded);
    assert!(
        wait_until(secs(15), || !running(&home, &id)),
        "{}",
        home.daemon_log()
    );
    let ended = agent(&home, &id);
    assert_eq!(
        (&ended["state"], &ended["state_detail"]["how"]),
        (&json!("ended"), &json!("stopped")),
        "{ended}"
    );
    assert!(
        home.daemon_log()
            .contains("window win-1 did not come back within"),
        "{}",
        home.daemon_log()
    );
    assert!(
        wait_until(secs(5), || listed(&home, "win-1").is_none()),
        "the window goes once its agents ended"
    );
}

/// A window of the same workspace takes over the agents of a window in its grace, as a reload does;
/// the first window, back, has none of them. It never takes the agents of a window that is still
/// connected.
#[test]
fn a_window_of_the_same_workspace_takes_over_the_agents_of_one_that_went() {
    let home = TestHome::new("windowtakeover");
    home.start_facade_with(&[
        ("FACADE_TEST_GRACE_MS", "3000"),
        ("FACADE_TEST_GATES", "grace-window-back"),
    ]);
    let folders = vec![real(&home.project)];
    let mut first = ide(&home, &window("win-1", Some("k"), &folders));
    let id = start_shell(&mut first, &home, "win-1", &real(&home.project), "moving");
    drop(first);
    assert!(wait_until(secs(5), || listed(&home, "win-1")
        .is_some_and(|window| window["connected"] == false)));
    let second = ide(&home, &window("win-2", Some("k"), &folders));
    assert_eq!(
        agent(&home, &id)["window_id"],
        "win-2",
        "the second window took the agent over"
    );
    assert!(
        listed(&home, "win-1").is_none(),
        "the first window went with its agents"
    );
    home.wait_for_gate("grace-window-back");
    assert!(
        running(&home, &id),
        "the first window's grace no longer ends the agent"
    );
    let third = ide(&home, &window("win-3", Some("k"), &folders));
    assert_eq!(
        agent(&home, &id)["window_id"],
        "win-2",
        "a window still connected keeps its agents"
    );
    let back = ide(&home, &window("win-1", Some("other"), &folders));
    assert_eq!(
        home.agents()
            .iter()
            .filter(|agent| agent["window_id"] == "win-1")
            .count(),
        0,
        "the first window, back, has none"
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    assert_eq!(
        agent(&home, &id)["window_id"],
        "win-2",
        "the takeover is kept across a restart"
    );
    drop((second, third, back));
}

/// A daemon restart is a lost connection to every editor window, never a close: a window that
/// connects again keeps its agents, and one that never comes back ends them once its grace, counted
/// from the restart, runs out.
#[test]
fn a_daemon_restart_gives_each_window_its_grace_from_the_restart() {
    let home = TestHome::new("windowrestart");
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "4000")]);
    let folders = vec![real(&home.project)];
    let (mut back, mut gone) = (
        ide(&home, &window("win-back", Some("k1"), &folders)),
        ide(&home, &window("win-gone", Some("k2"), &folders)),
    );
    let kept = start_shell(&mut back, &home, "win-back", &real(&home.project), "kept");
    let ended = start_shell(&mut gone, &home, "win-gone", &real(&home.project), "ended");
    let old = home.kill_daemon();
    drop((back, gone));
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    let restarted = std::time::Instant::now();
    let reconnected = ide(&home, &window("win-back", Some("k1"), &folders));
    assert!(
        running(&home, &kept) && running(&home, &ended),
        "nothing ends at the restart"
    );
    assert_eq!(
        listed(&home, "win-gone").map(|window| window["label"].clone()),
        Some(json!("win-gone window")),
        "its name is kept"
    );
    // The editor windows' rows: the terminal window's holds its YOLO alone.
    let stored = || -> Vec<String> {
        let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
        let mut rows = store
            .prepare(
                "SELECT window_id FROM windows WHERE window_id != 'terminal' ORDER BY window_id",
            )
            .unwrap();
        rows.query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(
        stored(),
        ["win-back", "win-gone"],
        "a window that holds agents keeps its description for the next restart"
    );
    assert!(
        wait_until(secs(20), || !running(&home, &ended)),
        "{}",
        home.daemon_log()
    );
    assert!(
        wait_until(secs(5), || stored() == ["win-back"]),
        "a window goes with its agents: {:?}",
        stored()
    );
    assert!(
        restarted.elapsed() >= std::time::Duration::from_millis(3500),
        "the grace counts from the restart: {:?}",
        restarted.elapsed()
    );
    assert!(
        running(&home, &kept),
        "the window that came back keeps its agents"
    );
    drop(reconnected);
}

/// What an agent of an editor window sends to `#human` goes to that window's `messages` watch and
/// is delivered as it does, and stays readable by its ID. Another window's watch never sees it.
/// Without a watch of its window, the send is refused and nothing is kept.
#[test]
fn the_person_is_told_in_the_sending_agent_s_own_window() {
    let home = TestHome::new("windowhuman");
    let folders = vec![real(&home.project)];
    let mut wire = ide(&home, &window("win-1", Some("k1"), &folders));
    let mut other = ide(&home, &window("win-2", Some("k2"), &folders));
    let id = start_shell(&mut wire, &home, "win-1", &real(&home.project), "teller");
    let mine = wire.request("watch", json!({ "topic": "messages" }));
    let theirs = other.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        (
            &mine["result"]["snapshot"]["messages"],
            &theirs["result"]["snapshot"]["messages"]
        ),
        (&json!([]), &json!([]))
    );
    let (mine, theirs) = (
        mine["result"]["watch"].as_u64().unwrap(),
        theirs["result"]["watch"].as_u64().unwrap(),
    );
    let told = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", &id)
        .args(["send", "#human", "build is green"])
        .output()
        .unwrap();
    assert_eq!(
        stdout(&told).trim(),
        "#m1 was handed to the person's editor window",
        "{}",
        stderr(&told)
    );
    assert!(wait_until(secs(5), || wire.changes(mine).iter().any(
        |change| change["change"]["message"]["text"] == "build is green"
    )));
    let message = wire.changes(mine)[0]["change"]["message"].clone();
    assert_eq!(
        (
            &message["from"],
            &message["to"],
            &message["delivery"]["delivered_via"]
        ),
        (&json!(id), &json!("human"), &json!("notified"))
    );
    assert_eq!(message["delivery"]["status"], "success");
    assert!(
        other.changes(theirs).is_empty(),
        "another window is never told"
    );
    let reread = wire.request(
        "watch",
        json!({ "topic": "messages", "args": { "ids": ["m1"] } }),
    );
    assert_eq!(
        reread["result"]["snapshot"]["messages"][0]["text"], "build is green",
        "a message to the person reads back by its ID"
    );
    for watch in [mine, reread["result"]["watch"].as_u64().unwrap()] {
        assert_eq!(
            wire.request("unwatch", json!({ "watch": watch }))["result"],
            json!({})
        );
    }
    let refused = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", &id)
        .args(["send", "#human", "nobody hears"])
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert!(
        stderr(&refused).contains("no editor shows #")
            && stderr(&refused).contains("the person cannot be told"),
        "{}",
        stderr(&refused)
    );
    let numbers: i64 = rusqlite::Connection::open(home.path.join("core/facade.db"))
        .unwrap()
        .query_row("SELECT count(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(numbers, 1, "a refused message is not kept");
}

/// start_agent starts in a location of a window, refuses a location that window does not have and a
/// window that is not there, and makes a worktree beside the main checkout first where asked, at
/// the next free folder, saying it made it. A branch that exists fails before anything changes.
/// list_agents shows the windows, their locations, and the agents in them.
#[test]
fn start_agent_starts_in_a_window_s_location_and_makes_a_worktree_there_where_asked() {
    let home = TestHome::new("windowstart");
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "60000")]);
    let repo = base(&home).join("app");
    repository(&repo);
    std::fs::create_dir_all(base(&home).join("app.worktrees/review")).unwrap();
    let mut wire = ide(&home, &window("win-1", Some("k1"), &[real(&repo)]));
    let boss = start_fake(&mut wire, &home, "win-1", &real(&repo), "boss");
    let outside = json!({
        "command": [SH.as_str()], "cwd": real(&home.project), "window_id": "win-1", "cols": 80,
        "rows": 24,
    });
    let refused = wire.call("agent.start", outside);
    assert_eq!(
        error_reason(&refused),
        "invalid_argument",
        "a folder that is not a location of the window: {refused}"
    );
    let absent = json!({
        "command": [SH.as_str()], "cwd": real(&repo), "window_id": "win-none", "cols": 80, "rows": 24,
    });
    assert_eq!(
        error_reason(&wire.call("agent.start", absent)),
        "unavailable",
        "a window that is not there"
    );
    let mut away = ide(
        &home,
        &window("win-away", Some("k2"), &[real(&home.project)]),
    );
    start_shell(
        &mut away,
        &home,
        "win-away",
        &real(&home.project),
        "waiting",
    );
    drop(away);
    let mut mcp = McpTestClient::open(&home, &boss);
    let instructions = mcp.request("initialize", json!({}))["result"]["instructions"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        instructions.contains("in window \"win-1 window\" (window win-1)"),
        "{instructions}"
    );
    let folder = real(&repo);
    let start = |extra: Value| {
        let mut args =
            json!({ "name": "helper", "cli": "fake", "window": "win-1", "path": folder });
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        args
    };
    let started = mcp.call("start_agent", start(json!({})));
    assert_eq!(
        (&started["data"]["window"], &started["data"]["path"]),
        (&json!("win-1"), &json!(folder)),
        "{started}"
    );
    let made = mcp.call(
        "start_agent",
        start(json!({ "name": "reviewer", "worktree": "review" })),
    );
    let path = real(&base(&home).join("app.worktrees/review-1"));
    assert_eq!(made["data"]["path"], json!(path), "{made}");
    assert!(
        places(&listed(&home, "win-1").unwrap()).contains(&(path.clone(), "worktree".into())),
        "the worktree is a location now"
    );
    let again = mcp.call("start_agent", start(json!({ "worktree": "review" })));
    assert!(
        again["message"]
            .as_str()
            .unwrap()
            .starts_with("a branch named review already exists"),
        "{again}"
    );
    let elsewhere = mcp.call(
        "start_agent",
        json!({ "name": "x", "cli": "fake", "window": "win-1", "path": real(&home.project) }),
    );
    assert_eq!(elsewhere["reason"], "invalid_argument", "{elsewhere}");
    let gone = mcp.call(
        "start_agent",
        json!({ "name": "x", "cli": "fake", "window": "win-away", "path": folder }),
    );
    assert_eq!(gone["reason"], "unavailable", "{gone}");
    let list = mcp.call("list_agents", json!({}));
    let windows = list["data"]["windows"].as_array().unwrap();
    assert_eq!(
        windows
            .iter()
            .map(|window| window["id"].clone())
            .collect::<Vec<_>>(),
        [json!("win-1")],
        "a window that is not there is not listed"
    );
    assert!(
        windows[0]["folders"]
            .as_array()
            .unwrap()
            .contains(&json!(path)),
        "an agent can work in the worktree: {list}"
    );
    let reviewer = list["data"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["name"] == "reviewer")
        .cloned()
        .unwrap();
    assert_eq!(
        (&reviewer["window"], &reviewer["path"]),
        (&json!("win-1"), &json!(path))
    );
    drop(wire);
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
    let mut wire = ide(&home, &window("win-1", Some("k1"), &[real(&repo)]));
    let args =
        json!({ "window_id": "win-1", "cwd": real(&repo), "branch": "review", "base_ref": "HEAD" });
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
    let mut wire = ide(&home, &window("win-1", Some("k1"), &folders));
    let in_notes = start_shell(&mut wire, &home, "win-1", &real(&notes), "notes");
    #[cfg_attr(windows, allow(unused_variables))]
    let in_fix = start_shell(&mut wire, &home, "win-1", &fix_path, "fix");
    let in_kept = start_shell(&mut wire, &home, "win-1", &real(&kept), "kept");
    let in_main = start_shell(&mut wire, &home, "win-1", &real(&repo), "main");
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
            let problems = listed(&home, "win-1").unwrap()["problems"].clone();
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
            "#{in_fix} ends: its location {fix_path} is gone from window win-1"
        )),
        "{}",
        home.daemon_log()
    );
}

/// An agent resumes in the window of the client that resumes it, in its own folder: `facade resume`
/// in the terminal window, an editor window's client in that window, which must have the folder
/// among its locations. So an editor window's agent that its window's grace ended runs again in a
/// window the lists show.
#[test]
fn an_agent_resumes_in_the_window_of_the_client_that_resumes_it() {
    let home = TestHome::new("windowresume");
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", GRACE_MS)]);
    let folder = real(&home.project);
    let mut wire = ide(
        &home,
        &window("win-1", Some("k1"), std::slice::from_ref(&folder)),
    );
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log, "FAKECLI_SESSION": "11111111-2222-4333-8444-555555555555",
    });
    let args = json!({
        "command": ["fake"], "name": "kept", "cwd": folder, "window_id": "win-1", "env": env,
        "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    assert!(
        wait_until(secs(15), || agent(&home, &id)["session"].is_string()),
        "{}",
        agent(&home, &id)
    );
    drop(wire);
    assert!(
        wait_until(secs(15), || !running(&home, &id)),
        "the window's grace ends it: {}",
        home.daemon_log()
    );
    assert!(
        wait_until(secs(5), || listed(&home, "win-1").is_none()),
        "the window went"
    );
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["resume", "kept"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(
        wait_until(secs(15), || running(&home, &id)),
        "{}",
        agent(&home, &id)
    );
    assert_eq!(
        agent(&home, &id)["window_id"],
        "terminal",
        "resumed from a terminal, in the terminal window"
    );
    let terminal = listed(&home, "terminal")
        .expect("the terminal window, listed while it holds a running agent");
    assert_eq!(
        places(&terminal),
        [(folder.clone(), "folder".to_string())],
        "{terminal}"
    );
    home.run_facade_ok(&["stop", "kept"]);
    let other = base(&home).join("other");
    std::fs::create_dir_all(&other).unwrap();
    let mut elsewhere = ide(&home, &window("win-2", Some("k2"), &[real(&other)]));
    let resume = json!({ "agent": id, "window_id": "win-2", "env": env, "cols": 80, "rows": 24 });
    let refused = elsewhere.call("agent.resume", resume);
    assert_eq!(
        error_reason(&refused),
        "invalid_argument",
        "a window without the agent's folder: {refused}"
    );
    assert!(!running(&home, &id), "nothing started");
    let mut here = ide(
        &home,
        &window("win-3", Some("k3"), std::slice::from_ref(&folder)),
    );
    let resume = json!({ "agent": id, "window_id": "win-3", "env": env, "cols": 80, "rows": 24 });
    let resumed = here.call("agent.resume", resume);
    assert_eq!(
        resumed["result"]["window_id"], "win-3",
        "resumed by an editor window, in that window: {resumed}"
    );
    assert_eq!(agent(&home, &id)["window_id"], "win-3");
    drop(elsewhere);
}

/// A message from an agent of another window names that window in its header; one within a window
/// does not. send_message names the window of a recipient in another window.
#[test]
fn a_message_between_windows_names_its_sender_s_window() {
    let home = TestHome::new("windowheader");
    let folders = vec![real(&home.project)];
    let mut first = ide(&home, &window("win-1", Some("k1"), &folders));
    let mut second = ide(&home, &window("win-2", Some("k2"), &folders));
    let ada = start_fake(&mut first, &home, "win-1", &real(&home.project), "ada");
    start_fake(&mut first, &home, "win-1", &real(&home.project), "bea");
    start_fake(&mut second, &home, "win-2", &real(&home.project), "cal");
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

/// An editor window's agents reply to their CLI's color queries with the window's colors, each
/// reply ended as its query was; after `window.update`, with the new colors.
#[test]
fn an_editor_window_s_agents_answer_color_queries_with_its_colors() {
    let home = TestHome::new("windowcolors");
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", GRACE_MS)]);
    let folder = real(&home.project);
    let mut described = window("win-1", Some("k1"), std::slice::from_ref(&folder));
    described["colors"] =
        json!({ "foreground": "#333333", "background": "#ffffff", "cursor": "#000000" });
    let mut wire = ide(&home, &described);
    let id = start_fake(&mut wire, &home, "win-1", &folder, "painter");
    type_raw(&mut wire, &id, "/fake colors\r");
    for reply in [
        "color 10;rgb:3333/3333/3333 bel",
        "color 11;rgb:ffff/ffff/ffff st",
        "color 12;rgb:0000/0000/0000 bel",
    ] {
        assert!(
            wait_for_screen_text(&home, "painter", reply),
            "{reply}: {}",
            home.screen("painter")
        );
    }
    described["colors"]["background"] = json!("#1e1e1e");
    let updated = wire.call("window.update", described);
    assert_eq!(updated["result"], json!({}), "{updated}");
    type_raw(&mut wire, &id, "/fake colors\r");
    assert!(
        wait_for_screen_text(&home, "painter", "color 11;rgb:1e1e/1e1e/1e1e st"),
        "the new background: {}",
        home.screen("painter")
    );
}

/// In an editor window, a start that continues a session may work in a folder inside one of the
/// window's locations, as "Recent" continues a conversation in the folder it was in: it starts,
/// and its location is the one that holds the folder.
#[test]
fn a_start_in_a_folder_inside_a_location_continues_its_session_there() {
    let home = TestHome::new("windowinside");
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", GRACE_MS)]);
    let folder = real(&home.project);
    let nested = home.project.join("app").join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let nested = real(&nested);
    let mut wire = ide(
        &home,
        &window("win-1", Some("k1"), std::slice::from_ref(&folder)),
    );
    let location = listed(&home, "win-1").unwrap()["locations"][0]["location_id"].clone();
    let session = "11111111-2222-4333-8444-555555555555";
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log,
    });
    let args = json!({
        "command": ["fake"], "session": session, "name": "inside", "cwd": nested,
        "window_id": "win-1", "env": env, "cols": 80, "rows": 24,
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
