//! Editors: an editor's client lists the folders of its workspace and the Git checkouts of their
//! repositories; the agents it starts outlive its disconnect, a reload and a daemon restart; two
//! editors can attach to one running agent at once; the last editor to resize gives its colors; a
//! worktree a start asks for is made once; and a resume keeps the agent's own folder and session.

use std::path::Path;

use facade_base::api_v1::daemon::{ScreenChange, ScreenSnapshot};
use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;
use facade_screen::Screen;

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

/// A client of an editor, connected to the test's daemon, which it starts where none runs.
fn editor(home: &TestHome) -> DaemonTestClient {
    drop(connect(home));
    let mut wire = DaemonTestClient::open(home);
    let hello = wire.hello("ide", DAEMON_API_VERSIONS, json!({}));
    assert!(hello["result"].is_object(), "{hello}");
    wire
}

/// Starts a shell agent `name` at `folder`, as an editor's client starts one.
fn start_shell(wire: &mut DaemonTestClient, home: &TestHome, folder: &str, name: &str) -> String {
    let args = json!({
        "cli": home.shell_cli(), "args": ["-c", "echo READY; sleep 600"], "name": name,
        "folder": folder, "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path },
        "size": { "cols": 80, "rows": 24 },
    });
    let started = wire.call("agent.start", args);
    started["result"]["agent"]["reference"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{name} did not start: {started}"))
        .to_string()
}

/// The environment an editor gives a start of the test CLI.
fn fake_env(home: &TestHome) -> Value {
    json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log,
    })
}

/// Starts the test CLI as agent `name` at `folder`, and waits for its input box.
fn start_fake(wire: &mut DaemonTestClient, home: &TestHome, folder: &str, name: &str) -> String {
    let args = json!({
        "cli": "fake", "name": name, "folder": folder, "env": fake_env(home),
        "size": { "cols": 80, "rows": 24 },
    });
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["reference"]["agent_id"]
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
        .find(|agent| agent["reference"]["agent_id"] == id)
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
    assert!(alive(&process_identity(pid)), "{id} PID {pid} is alive");
    assert!(wait_for_screen_text(home, id, "READY"), "{id}'s screen");
    (pid, home.screen(id))
}

/// Each location `location.list` gives for the requested folder `source`, as its path and kind.
fn places(listed: &Value, source: &str) -> Vec<(String, String)> {
    listed["result"]["locations"]
        .as_array()
        .unwrap_or_else(|| panic!("{listed}"))
        .iter()
        .filter(|location| location["source_folder"] == source)
        .map(|location| {
            (
                location["path"].as_str().unwrap().to_string(),
                location["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// An editor's folders are locations, and so is every checkout of a repository one of them is in,
/// whichever tool made it: for each folder the editor names, the main checkout first, then the
/// folder where it is another place, then the other worktrees, each place once.
#[test]
fn an_editor_lists_its_folders_and_the_checkouts_of_their_repositories() {
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
    let mut wire = editor(&home);
    let listed = wire.call("location.list", json!({ "folders": folders }));
    let fix = real(&base(&home).join("app-fix"));
    assert_eq!(
        places(&listed, &folders[0]),
        [
            (real(&repo), "main".into()),
            (real(&repo.join("src")), "folder".into()),
            (fix.clone(), "worktree".into()),
        ],
        "{listed}"
    );
    assert_eq!(
        places(&listed, &folders[1]),
        [(real(&notes), "folder".into())],
        "{listed}"
    );
    assert_eq!(
        places(&listed, &folders[2]),
        [(real(&repo), "main".into()), (fix, "worktree".into())],
        "{listed}"
    );
    let locations = &listed["result"]["locations"];
    let locations = locations.as_array().unwrap();
    assert_eq!(locations.len(), 6, "{listed}");
    for location in locations {
        let path = location["path"].as_str().unwrap();
        assert_eq!(
            location["location_id"],
            facade_base::model::machine::location_id(path)
        );
        if location["kind"] == "worktree" {
            assert_eq!(
                location["label"], "fix",
                "a checkout is named by its branch"
            );
        }
    }
    let revised = wire.call("location.list", json!({ "folders": [&folders[1]] }));
    assert_eq!(
        places(&revised, &folders[1]),
        [(real(&notes), "folder".into())]
    );
    assert_eq!(
        revised["result"]["locations"].as_array().unwrap().len(),
        1,
        "{revised}"
    );
}

/// An editor's agents keep running when its connection ends, and a reload finds the same
/// processes and screens.
#[test]
fn an_editor_s_agents_outlive_a_disconnect_and_reload() {
    let home = TestHome::new("windowdisconnect");
    let folder = real(&home.project);
    let mut wire = editor(&home);
    let id = start_shell(&mut wire, &home, &folder, "kept");
    let before = live_agent(&home, &id);
    drop(wire);
    std::thread::sleep(secs(3));
    assert_eq!(live_agent(&home, &id), before);
    let mut reloaded = editor(&home);
    let listed = reloaded.call("agent.list", json!({}));
    assert!(
        listed["result"]["agents"]
            .as_array()
            .is_some_and(|agents| agents
                .iter()
                .any(|row| row["reference"]["agent_id"] == id.as_str())),
        "{listed}"
    );
    assert_eq!(live_agent(&home, &id), before);
}

/// A daemon restart keeps every editor's agents running, whether or not the editor reconnects.
#[test]
fn an_editor_s_agents_outlive_a_daemon_restart() {
    let home = TestHome::new("windowrestart");
    let folder = real(&home.project);
    let mut back = editor(&home);
    let mut gone = editor(&home);
    let kept = start_shell(&mut back, &home, &folder, "kept");
    let away = start_shell(&mut gone, &home, &folder, "away");
    let kept_before = live_agent(&home, &kept);
    let away_before = live_agent(&home, &away);
    let old = home.kill_daemon();
    drop((back, gone));
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    let _reconnected = editor(&home);
    std::thread::sleep(secs(6));
    assert_eq!(live_agent(&home, &kept), kept_before);
    assert_eq!(live_agent(&home, &away), away_before);
}

/// Watches agent `id`'s screen as viewer `viewer` and returns the watch's number with its
/// snapshot.
fn attach(wire: &mut DaemonTestClient, id: &str, viewer: &str) -> (u64, ScreenSnapshot) {
    let watching = wire.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": id, "viewer": viewer } }),
    );
    let watch = watching["result"]["watch"]
        .as_u64()
        .unwrap_or_else(|| panic!("{watching}"));
    let snapshot = facade_scenarios::serde_json::from_value(watching["result"]["snapshot"].clone())
        .unwrap_or_else(|error| panic!("{error}: {watching}"));
    (watch, snapshot)
}

/// Two editors attach to one running agent at once: each sees the same agent and process, and
/// what it shows reaches both. A guest has no terminal to attach to.
#[test]
fn two_editors_attach_to_one_running_agent_at_once() {
    let home = TestHome::new("windowadopt");
    let folder = real(&home.project);
    let mut first = editor(&home);
    let mut second = editor(&home);
    let id = start_fake(&mut first, &home, &folder, "kept");
    let record = agent(&home, &id);
    let first_view = attach(&mut first, &id, "first editor");
    let second_view = attach(&mut second, &id, "second editor");
    type_raw(&mut first, &id, "SHARED");
    for (wire, (watch, snapshot)) in [(&first, first_view), (&second, second_view)] {
        assert_eq!(snapshot.reference.agent_id, id);
        assert_eq!(
            snapshot.reference.machine_id,
            record["reference"]["machine_id"].as_str().unwrap()
        );
        assert_eq!(snapshot.address, record["address"].as_str().unwrap());
        assert!(snapshot.exit.is_none(), "{snapshot:?}");
        let mut screen = Screen::new(snapshot.size.cols, snapshot.size.rows, 0);
        screen.feed(&facade_base::base64::decode(&snapshot.redraw).unwrap());
        let mut received = 0;
        assert!(
            wait_until(secs(10), || {
                for notice in wire.changes(watch).into_iter().skip(received) {
                    received += 1;
                    let change: ScreenChange =
                        facade_scenarios::serde_json::from_value(notice["change"].clone()).unwrap();
                    let data = match change {
                        ScreenChange::Output { data } => data,
                        ScreenChange::Redraw { data, size } => {
                            screen.resize(size.cols, size.rows);
                            data
                        }
                        other => panic!("unexpected screen change: {other:?}"),
                    };
                    screen.feed(&facade_base::base64::decode(&data).unwrap());
                }
                screen
                    .text(screen.rows().into())
                    .iter()
                    .any(|line| line.contains("SHARED"))
            }),
            "the viewer did not see SHARED: {:?}",
            screen.text(screen.rows().into())
        );
    }
    assert_eq!(agent(&home, &id)["pid"], record["pid"]);

    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let roster = guest.call("list_agents", json!({}));
    let address = roster["data"]["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["type"] == "guest"))
        .and_then(|agent| agent["id"].as_str())
        .unwrap_or_else(|| panic!("the connection is no guest: {roster}"))
        .to_string();
    let terminal = "is a Guest without a terminal";
    let check = |operation: &str, refused: Value, why: &str| {
        let message = format!("agent {address} {why}");
        assert_eq!(
            (error_reason(&refused), refused["error"]["message"].as_str()),
            ("unsupported", Some(message.as_str())),
            "{operation}: {refused}"
        );
    };
    let watched = second.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": address } }),
    );
    check("screen watch", watched, terminal);
    for (operation, args, why) in [
        ("agent.screen", json!({ "target": address }), terminal),
        (
            "agent.type",
            json!({ "target": address, "input": { "kind": "text", "text": "hello" } }),
            terminal,
        ),
        (
            "agent.resume",
            json!({ "target": { "kind": "selector", "selector": address }, "size": { "cols": 80, "rows": 24 } }),
            "is a Guest and cannot be resumed",
        ),
        (
            "agent.remove",
            json!({ "target": address }),
            "is a Guest and cannot be removed",
        ),
    ] {
        check(operation, second.call(operation, args), why);
    }
    let stopped = second.call_ok(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [address] } }),
    );
    assert_eq!(stopped["items"][0]["status"], "failed", "{stopped}");
    check(
        "agent.stop",
        json!({ "error": stopped["items"][0]["error"] }),
        "is a Guest and cannot be stopped by Facade",
    );
    let inspected = second.call("agent.inspect", json!({ "target": address }));
    assert_eq!(
        inspected["result"]["input"]["state"], "unknown",
        "{inspected}"
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
        home.path_with_test_programs()
    );
    home.start_facade_with(&[("PATH", &path)]);
    let mut wire = editor(&home);
    let mut env = fake_env(&home);
    env["PATH"] = json!(path);
    let start = |name: &str| {
        json!({
            "op": "agent.start",
            "args": {
                "cli": "fake", "name": name, "folder": real(&repo), "worktree": "review",
                "env": env, "size": { "cols": 80, "rows": 24 },
            },
        })
    };
    let first = wire.send("call", start("one"));
    let second = wire.send("call", start("two"));
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
        refused["error"]["data"]["details"].get("kept").is_none(),
        "it claims nothing it did not make: {refused}"
    );
}

/// Both the command line and an editor can resume a stopped agent: it keeps its number, its
/// folder and its session.
#[test]
fn an_agent_resumes_with_its_own_folder_and_session() {
    let home = TestHome::new("windowresume");
    let nested = home.project.join("app/nested");
    std::fs::create_dir_all(&nested).unwrap();
    let folder = real(&nested);
    let mut first = editor(&home);
    let session = "11111111-2222-4333-8444-555555555555";
    let mut env = fake_env(&home);
    env["FAKECLI_SESSION"] = json!(session);
    // Windows PowerShell, which runs the session hook on Windows, does not start without it.
    #[cfg(windows)]
    {
        env["SystemRoot"] = json!(std::env::var("SystemRoot").unwrap());
    }
    let started = first.call(
        "agent.start",
        json!({
            "cli": "fake", "name": "kept", "folder": folder, "env": env, "size": { "cols": 80, "rows": 24 },
        }),
    );
    let reference = &started["result"]["agent"]["reference"];
    let id = reference["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    assert!(
        wait_until(secs(15), || agent(&home, &id)["session"] == session),
        "{}",
        agent(&home, &id)
    );
    let check = |record: &Value| {
        assert_eq!(record["reference"], *reference, "{record}");
        assert_eq!(record["cwd"], folder, "{record}");
        assert_eq!(record["session"], session, "{record}");
        assert_eq!(record["process"], "running", "{record}");
    };
    home.run_facade_ok(&["stop", &id]);
    assert!(wait_until(secs(15), || !running(&home, &id)));
    home.run_facade_ok(&["resume", "-d", &id]);
    check(&agent(&home, &id));

    home.run_facade_ok(&["stop", &id]);
    assert!(wait_until(secs(15), || !running(&home, &id)));
    let mut other = editor(&home);
    let resumed = other.call(
        "agent.resume",
        json!({ "target": { "kind": "agent", "reference": reference }, "env": env, "size": { "cols": 80, "rows": 24 } }),
    );
    assert!(resumed["result"].is_object(), "{resumed}");
    check(&agent(&home, &id));
}

/// An editor's resize gives the agent its colors, even when it keeps the prior dimensions; the
/// last editor to resize wins, and an attach in a terminal, which gives no colors, leaves them.
#[test]
fn an_agents_colors_follow_the_last_editor_to_resize() {
    let home = TestHome::new("windowcolors");
    let folder = real(&home.project);
    let mut first = editor(&home);
    let id = start_fake(&mut first, &home, &folder, "painter");
    let (first_watch, _) = attach(&mut first, &id, "first editor");
    let resize = |wire: &mut DaemonTestClient, watch: u64, colors: Value| {
        let resized = wire.call(
            "attach.resize",
            json!({ "watch": watch, "size": { "cols": 120, "rows": 40 }, "colors": colors }),
        );
        assert!(resized["result"].is_object(), "{resized}");
    };
    let mut colors =
        json!({ "foreground": "#333333", "background": "#ffffff", "cursor": "#000000" });
    resize(&mut first, first_watch, colors.clone());
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

    colors["background"] = json!("#1e1e1e");
    resize(&mut first, first_watch, colors);
    type_raw(&mut first, &id, "/fake colors\r");
    assert!(wait_for_screen_text(
        &home,
        &id,
        "color 11;rgb:1e1e/1e1e/1e1e st"
    ));

    let mut second = editor(&home);
    let (second_watch, _) = attach(&mut second, &id, "second editor");
    resize(
        &mut second,
        second_watch,
        json!({ "foreground": "#eeeeee", "background": "#225588", "cursor": "#000000" }),
    );
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
                json!({ "topic": "attach", "args": { "target": id } }),
            );
            let screen = &observed["result"]["snapshot"];
            screen["size"] == json!({ "cols": 93, "rows": 31 })
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

/// An editor resize seeds the palette for the first queries after an editor or detached resume.
#[test]
fn an_editors_colors_survive_editor_and_detached_resumes() {
    let home = TestHome::new("resume-editor-colors");
    let transcript = home.folder().join("color-queries");
    let keys = home.folder().join("keys");
    std::fs::write(
        &transcript,
        b"\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07\x1b[c",
    )
    .unwrap();
    let session = "55000000-0000-4000-8000-000000000012";
    let env = [
        ("FAKECLI_SCREEN_FILE", transcript.to_str().unwrap()),
        ("FAKECLI_KEYS", keys.to_str().unwrap()),
        ("FAKECLI_SESSION", session),
    ];
    let worker = home.start_fake_with("painter", &env);
    let mut client = editor(&home);
    let (watch, _) = attach(&mut client, &worker.id, "editor");
    let resized = client.call(
        "attach.resize",
        json!({
            "watch": watch, "size": { "cols": 80, "rows": 24 },
            "colors": { "foreground": "#eeeeee", "background": "#225588", "cursor": "#112233" },
        }),
    );
    assert!(resized["result"].is_object(), "{resized}");
    let wait_for_queries = |expected: &[u8]| {
        assert!(
            wait_until(LOADED_TIMEOUT, || std::fs::read(&keys)
                .is_ok_and(|input| input.ends_with(b"\x1b[?6c"))),
            "{}\n{:?}",
            home.screen(&worker.id),
            std::fs::read(&keys),
        );
        assert_eq!(std::fs::read(&keys).unwrap(), expected);
    };
    wait_for_queries(b"\x1b[?6c");
    assert!(wait_until(
        LOADED_TIMEOUT,
        || agent(&home, &worker.id)["session"] == session
    ));
    let stop = || {
        home.run_facade_ok(&["stop", &worker.id]);
        std::fs::remove_file(&keys).unwrap();
    };
    stop();
    let editor_env: std::collections::BTreeMap<_, _> = home
        .isolating_env()
        .into_iter()
        .chain(env.map(|(key, value)| (key, value.to_string())))
        .collect();
    let resumed = client.call(
        "agent.resume",
        json!({
            "target": { "kind": "selector", "selector": worker.id },
            "env": editor_env,
            "size": { "cols": 80, "rows": 24 },
        }),
    );
    assert!(resumed["result"].is_object(), "{resumed}");
    let expected = b"\x1b]10;rgb:eeee/eeee/eeee\x07\x1b]11;rgb:2222/5555/8888\x1b\\\x1b]12;rgb:1111/2222/3333\x07\x1b[?6c";
    wait_for_queries(expected);
    stop();
    let detached = home
        .command(&test_binaries().facade)
        .args(["resume", "-d", &worker.id])
        .envs(env)
        .output()
        .unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    wait_for_queries(expected);
}
