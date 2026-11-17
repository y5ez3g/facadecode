//! The CLIs and names of Facade's settings file (CONFIGURATION-1.4, 2, 3, 4; LIFECYCLE-2.1;
//! CLIS-1.4): `facade start`, `start_agent` and `facade resume` run a CLI as its entry in
//! `facade.json` says - its program, `args`, `env`, `model` and `effort` - an added CLI of a
//! built-in's type as that built-in runs, and one of type `custom` as a program; an entry that is
//! wrong, or turned off, refuses its own starts alone; `list_agents` lists the entries; and an
//! agent started without a name is named from `names`. The test CLI's rule, `fake`, is a built-in
//! of the test build.

use std::process::{Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

const SESSION: &str = "86da4482-2bae-4a45-b193-a5664c19826a";

/// Writes Facade's settings file, `facade.json` in the test's Facade home, as `settings`.
fn settings(home: &TestHome, settings: &Value) {
    std::fs::create_dir_all(&home.path).unwrap();
    std::fs::write(home.path.join("facade.json"), settings.to_string()).unwrap();
}

/// The file the test CLI writes its arguments to, by its `FAKECLI_ARGS`: one for each `label`.
fn args_file(home: &TestHome, label: &str) -> String {
    home.project
        .parent()
        .unwrap()
        .join(format!("{label}.args"))
        .to_string_lossy()
        .into_owned()
}

/// The arguments the test CLI wrote to `file` as it started, once it did.
fn args_in(file: &str) -> Vec<String> {
    assert!(
        wait_until(secs(10), || std::path::Path::new(file).exists()),
        "the CLI wrote no arguments to {file}"
    );
    facade_scenarios::serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// Runs `facade <args>` without a terminal, with the test programs on `PATH` and `env`.
fn facade(home: &TestHome, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = home.command(&test_binaries().facade);
    command
        .env("PATH", home.path_with_test_programs())
        .args(args)
        .stdin(Stdio::null());
    for (name, value) in env {
        command.env(name, value);
    }
    command.output().unwrap()
}

/// Starts the CLI `cli` of the settings file as agent `name`, and waits for the test CLI's input
/// box.
fn start(home: &TestHome, name: &str, cli: &str, env: &[(&str, &str)]) {
    let started = facade(home, &["start", "--name", name, cli], env);
    assert!(
        started.status.success(),
        "facade start {cli} failed: {}",
        stderr(&started)
    );
    assert!(
        wait_until(secs(30), || home.screen(name).contains("❯")),
        "{name} did not draw its input box: {}",
        home.screen(name)
    );
}

/// A start of `cli` that is refused, with what it says.
fn refused(home: &TestHome, cli: &str) -> String {
    let output = facade(home, &["start", "--name", "nope", cli], &[]);
    assert!(!output.status.success(), "facade start {cli} started");
    stderr(&output)
}

/// An added CLI of a built-in's type runs as that built-in does, as its entry says: its model and
/// effort in the CLI's own spelling, then its `args`, then the start's own words; its `env` over
/// the start's environment, each `${env:NAME}` read from that. The agent records the entry's name
/// as its CLI, and the built-in's rule as its rule.
#[test]
fn an_added_cli_of_a_built_in_s_type_starts_as_its_entry_says() {
    let home = TestHome::new("configadded");
    let file = args_file(&home, "work");
    let entry = json!({
        "type": "fake", "args": ["--flag", "x"],
        "env": { "FAKECLI_NAME": "${env:WHO}", "FAKECLI_ARGS": file }, "model": "m1",
        "effort": "low",
    });
    settings(&home, &json!({ "clis": { "fake work": entry } }));
    let started = facade(
        &home,
        &["start", "--name", "worker", "fake work", "--more"],
        &[("WHO", "ada-at-work")],
    );
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        wait_until(secs(30), || home.screen("worker").contains("ada-at-work")),
        "its env, read from the start's: {}",
        home.screen("worker")
    );
    assert_eq!(
        args_in(&file),
        ["--model", "m1", "--effort", "low", "--flag", "x", "--more"]
    );
    assert_eq!(
        home.agent_from_list_json("worker").unwrap()["cli"],
        "fake work"
    );
    let inspected = home.run_facade_ok(&["inspect", "worker"]);
    assert!(
        inspected
            .lines()
            .next()
            .is_some_and(|first| first.contains(": fake work, "))
            && inspected.contains("Rule: fake"),
        "{inspected}"
    );
}

/// A CLI of type `custom` runs its `command` and `args` as a program, which Facade gives nothing of
/// its own: no rule, no tools.
#[test]
fn a_custom_cli_runs_its_program_as_it_is() {
    let home = TestHome::new("configprogram");
    let file = args_file(&home, "tool");
    let program = test_binaries().fakecli.to_string_lossy().into_owned();
    let entry = json!({
        "type": "custom", "command": program, "args": ["--resume-like", ""],
        "env": { "FAKECLI_ARGS": file },
    });
    settings(&home, &json!({ "clis": { "tool": entry } }));
    start(&home, "tool", "tool", &[]);
    assert_eq!(
        args_in(&file),
        ["--resume-like", ""],
        "its own arguments, an empty one too, as they are"
    );
    let inspected = home.run_facade_ok(&["inspect", "tool", "--json"]);
    let inspected: Value = facade_scenarios::serde_json::from_str(&inspected).unwrap();
    assert_eq!(
        (
            inspected.get("rule"),
            &inspected["agent"]["cli"],
            &inspected["agent"]["tools_state"]
        ),
        (None, &json!("tool"), &json!("not_injected")),
        "{inspected}"
    );
    // Facade reads no input of a program's: it starts with a first message all the same, which
    // fails as unsupported (CONFIGURATION-2.3).
    let prompted = facade(
        &home,
        &["start", "--name", "prompted", "--prompt", "hi", "tool"],
        &[],
    );
    assert!(prompted.status.success(), "{}", stderr(&prompted));
    let reason = || {
        let store = rusqlite::Connection::open(home.path.join("core/facade.db")).ok()?;
        store
            .query_row("SELECT reason FROM messages WHERE number = 1", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .ok()
            .flatten()
    };
    assert!(
        wait_until(secs(10), || reason().as_deref() == Some("unsupported")),
        "{:?}",
        reason()
    );
}

/// An entry that is wrong refuses its own starts, saying what is wrong in the editor's words, and
/// so does one whose `env` reads a variable the start's environment has not; an entry turned off is
/// refused, saying so. Every other CLI starts.
#[test]
fn an_entry_wrong_or_turned_off_refuses_its_own_starts_alone() {
    let home = TestHome::new("configrefused");
    let clis = json!({
        "fake": { "args": [42] }, "off": { "type": "fake", "enabled": false },
        "reads": { "type": "fake", "env": { "A": "${env:NOT_SET_FOR_THIS}" } },
        "fine": { "type": "fake" },
    });
    settings(&home, &json!({ "clis": clis }));
    assert!(refused(&home, "fake").contains("clis.fake.args[0] must be a string; received number"));
    assert!(refused(&home, "off").contains("off is turned off by clis.off.enabled"));
    let said = "clis.reads.env.A reads ${env:NOT_SET_FOR_THIS}, but NOT_SET_FOR_THIS is not in the \
                environment it starts with; set it there, or write the value";
    assert!(refused(&home, "reads").contains(said));
    start(&home, "fine", "fine", &[]);
    assert_eq!(
        home.agents().len(),
        1,
        "the one that is right started alone"
    );
}

/// `start_agent` starts a CLI of the settings file by its name, its own model and effort over its
/// entry's, each on its own; a CLI that takes no effort refuses one as `unsupported`, in the tool's
/// words. `list_agents` lists the built-ins, then the added CLIs, each with what a start can
/// choose; one turned off is left out, and one that is wrong is listed with what is wrong.
#[test]
fn start_agent_and_list_agents_name_the_clis_of_the_settings_file() {
    let home = TestHome::new("configmcp");
    let file = args_file(&home, "mcp");
    let clis = json!({
        "fake work": {
            "type": "fake", "env": { "FAKECLI_ARGS": file }, "model": "m1", "effort": "low",
        },
        "off": { "type": "fake", "enabled": false },
        "oc": { "type": "opencode", "command": test_binaries().fakecli },
        "bad": { "type": "fake", "icon": "facade-cyan" },
    });
    settings(&home, &json!({ "clis": clis }));
    home.start_named_fake("ada", &[]);
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let mut ada = McpTestClient::open(&home, "a1");
    let rows = ada.call("list_agents", json!({}))["data"]["windows"][0]["clis"].clone();
    let named: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|cli| ["fake", "fake work", "oc", "off", "bad"].contains(cli))
        .collect();
    assert_eq!(named, ["fake", "fake work", "oc"], "{rows}");
    let start = |cli: &str, more: Value| {
        let mut call = json!({ "name": "worker", "cli": cli, "window": "terminal", "path": cwd });
        call.as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        call
    };
    let started = ada.call("start_agent", start("fake work", json!({ "model": "m2" })));
    assert_eq!(started["status"], "success", "{started}");
    assert_eq!(
        args_in(&file),
        ["--model", "m2", "--effort", "low"],
        "the start's model, the entry's effort"
    );
    let oc = ada.call("start_agent", start("oc", json!({ "effort": "high" })));
    assert!(
        oc["message"]
            .as_str()
            .unwrap()
            .starts_with("oc takes no explicit effort; leave `effort` out to use its default."),
        "{oc}"
    );
    let bad = ada.call("start_agent", start("bad", json!({})));
    assert!(
        bad["message"]
            .as_str()
            .unwrap()
            .starts_with("bad cannot start in window terminal: clis.bad.icon must be one of"),
        "{bad}"
    );
    let off = ada.call("start_agent", start("off", json!({})));
    assert!(
        off["message"]
            .as_str()
            .unwrap()
            .starts_with("window terminal starts no CLI off;"),
        "{off}"
    );
}

/// A resume runs the entry the agent ran as the settings file has it now, its `args` too; it
/// refuses an entry that now runs another CLI, and one the file no longer has, rather than run
/// another in its place (CONFIGURATION-3.4).
#[test]
fn a_resume_runs_the_entry_as_it_is_now_and_refuses_one_retyped_or_gone() {
    let home = TestHome::new("configresume");
    let file = args_file(&home, "resume");
    let entry = |args: Value, kind: &str| {
        json!({
            "clis": {
                "fake work": { "type": kind, "args": args, "env": { "FAKECLI_ARGS": file } },
            },
        })
    };
    settings(&home, &entry(json!(["--first"]), "fake"));
    start(
        &home,
        "worker",
        "fake work",
        &[("FAKECLI_SESSION", SESSION)],
    );
    assert!(wait_until(secs(10), || home
        .agent_from_list_json("worker")
        .is_some_and(|agent| agent["session"] == SESSION)));
    home.run_facade_ok(&["stop", "worker"]);
    settings(&home, &entry(json!(["--then"]), "fake"));
    std::fs::remove_file(&file).unwrap();
    let resumed = facade(&home, &["resume", "worker"], &[]);
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    let args = args_in(&file);
    assert!(
        args.windows(2).any(|pair| pair == ["--resume", SESSION])
            && args.contains(&"--then".to_string())
            && !args.contains(&"--first".to_string()),
        "{args:?}"
    );
    home.run_facade_ok(&["stop", "worker"]);
    let program = test_binaries().fakecli.to_string_lossy().into_owned();
    settings(
        &home,
        &json!({ "clis": { "fake work": { "type": "custom", "command": program } } }),
    );
    let retyped = facade(&home, &["resume", "worker"], &[]);
    let said = "clis[\"fake work\"] runs a program now, but this conversation is Fake CLI's; it \
                cannot be resumed with it (unsupported)";
    assert!(
        !retyped.status.success() && stderr(&retyped).contains(said),
        "{}",
        stderr(&retyped)
    );
    settings(&home, &json!({}));
    let gone = facade(&home, &["resume", "worker"], &[]);
    let said = "\"fake work\" is no longer in clis of ";
    assert!(
        !gone.status.success()
            && stderr(&gone).contains(said)
            && stderr(&gone).contains("so this conversation cannot be resumed with it."),
        "{}",
        stderr(&gone)
    );
}

/// An agent started without a name is named from the settings file's `names`, trimmed: one no agent
/// of its window has; with every one taken, by its ID (LIFECYCLE-2.1).
#[test]
fn an_agent_started_without_a_name_is_named_from_names() {
    let home = TestHome::new("confignames");
    settings(&home, &json!({ "names": [" Solo "] }));
    for _ in 0..2 {
        let started = facade(&home, &["start", "fake"], &[]);
        assert!(started.status.success(), "{}", stderr(&started));
    }
    let names: Vec<String> = home
        .agents()
        .iter()
        .map(|agent| agent["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["Solo", "#a2"]);
}

/// Runs `facade start --name <label> <label> <words>` of an entry of `kind`'s type named `label`,
/// the test CLI its `command`, as `entry` says, and gives the arguments the test CLI started with.
fn started_with(
    home: &TestHome,
    label: &str,
    kind: &str,
    entry: Value,
    words: &[&str],
) -> Vec<String> {
    let file = args_file(home, label);
    let mut entry = entry;
    entry["type"] = json!(kind);
    entry["command"] = json!(test_binaries().fakecli);
    entry["env"] = json!({ "FAKECLI_ARGS": file });
    settings(home, &json!({ "clis": { label: entry } }));
    let started = facade(
        home,
        &[&["start", "--name", label, label][..], words].concat(),
        &[],
    );
    assert!(started.status.success(), "{label}: {}", stderr(&started));
    args_in(&file)
}

/// A model or an effort among the words after the CLI's name in `facade start` is the start's own,
/// read in every spelling the CLI takes: it wins over the entry's, which is then not added, so the
/// CLI gets one such option (CONFIGURATION-3.3). Codex refuses a second `--model`. The entry's
/// choice that the words leave stays.
#[test]
fn a_model_or_effort_in_a_start_s_own_words_wins_over_its_entry_s() {
    let home = TestHome::new("configchoice");
    let cases: [(&str, Value, &[&str], &[&str]); 5] = [
        (
            "claude",
            json!({ "model": "m1", "effort": "e1" }),
            &["--model", "m2"],
            &["--model"],
        ),
        (
            "codex",
            json!({ "model": "m1" }),
            &["-m", "m2"],
            &["--model", "-m"],
        ),
        (
            "agy",
            json!({ "model": "m1", "effort": "e1" }),
            &["-model", "m2"],
            &["--model", "-model"],
        ),
        (
            "muse",
            json!({ "model": "m1", "effort": "e1" }),
            &["--effort", "high"],
            &["--effort", "--reasoning-effort"],
        ),
        (
            "pi",
            json!({ "model": "m1", "effort": "e1" }),
            &["--thinking", "off"],
            &["--thinking"],
        ),
    ];
    for (kind, entry, words, options) in cases {
        let args = started_with(&home, &format!("{kind}-own"), kind, entry, words);
        let chosen = args
            .iter()
            .filter(|arg| options.contains(&arg.as_str()))
            .count();
        // Muse Code takes an effort from Facade as a `-c reasoning_effort=` override
        let overridden = args.iter().any(|arg| arg.starts_with("reasoning_effort="));
        assert_eq!(
            (chosen, overridden),
            (1, false),
            "{kind}, the start's alone: {args:?}"
        );
        assert!(
            args.windows(words.len()).any(|found| found == words),
            "{kind}, the start's words as they were: {args:?}"
        );
    }
    // The entry's choice the words leave stays: Claude Code's effort
    let claude = args_in(&args_file(&home, "claude-own"));
    assert!(
        claude.windows(2).any(|pair| pair == ["--effort", "e1"]),
        "{claude:?}"
    );
}

/// An entry's `args` are read as its CLI reads them where Facade merges them with its own
/// (CLIS-3.1, 3.4): Antigravity's `-settings` is its `--settings`, merged into the one the run
/// gets, and Claude Code's `--append-system-prompt` keeps its text, which looks like `--settings`.
#[test]
fn an_entry_s_args_are_merged_as_their_cli_reads_them() {
    let home = TestHome::new("configmerge");
    let agy = started_with(
        &home,
        "agy-one",
        "agy",
        json!({ "args": ["-settings", "{\"theme\": \"light\"}"] }),
        &[],
    );
    let settings: Vec<&String> = agy
        .iter()
        .filter(|arg| arg.trim_start_matches('-').starts_with("settings"))
        .collect();
    assert_eq!(settings, ["--settings"], "{agy:?}");
    // The merged settings reach it in the run's file, which the argument names.
    let file = &agy[agy.iter().position(|arg| arg == "--settings").unwrap() + 1];
    let merged: Value =
        facade_scenarios::serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    assert_eq!(merged["theme"], "light", "{merged}");
    let claude = started_with(
        &home,
        "claude-one",
        "claude",
        json!({ "args": ["--append-system-prompt", "--settings={\"a\": 1}"] }),
        &[],
    );
    let prompt = claude
        .iter()
        .position(|arg| arg == "--append-system-prompt")
        .map(|at| claude[at + 1].as_str());
    assert_eq!(prompt, Some("--settings={\"a\": 1}"), "{claude:?}");
}

/// An entry's program that cannot run where it starts is said by its setting, the same in
/// `list_agents` and in a start, which it refuses as `not_found` (CONFIGURATION-2.2, 4.1): a
/// built-in's not on the `PATH`, a name not on it, and a path to no program.
#[test]
fn an_entry_s_program_that_cannot_run_is_said_by_its_setting() {
    let home = TestHome::new("configprogram");
    let clis = json!({
        "oc": { "type": "opencode" }, "named": { "type": "fake", "command": "no-such-cli" },
        "gone": { "type": "fake", "command": "/nope/facade-fakecli" },
    });
    settings(&home, &json!({ "clis": clis }));
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let folder = home.agent_from_list_json("ada").unwrap()["cwd"]
        .as_str()
        .unwrap()
        .to_string();
    // A path from the root names the drive of the folder it runs in on Windows.
    #[cfg(unix)]
    let gone = "/nope/facade-fakecli".to_string();
    #[cfg(windows)]
    let gone = format!(
        "{}/nope/facade-fakecli",
        &home.project.display().to_string()[..2]
    );
    let said = [
        (
            "oc",
            format!(
                "opencode was not found on the PATH of a terminal in {folder}, and clis.oc.command \
                 does not name its location"
            ),
        ),
        (
            "named",
            format!(
                "clis.named.command is \"no-such-cli\", which was not found on the PATH of a \
                 terminal in {folder}"
            ),
        ),
        (
            "gone",
            format!(
                "clis.gone.command is \"/nope/facade-fakecli\", and {gone} is not a program that \
                 can be run"
            ),
        ),
    ];
    for (cli, problem) in said {
        let start = json!({ "name": "w", "cli": cli, "window": "terminal", "path": folder });
        let mcp = ada.call("start_agent", start);
        assert_eq!(
            mcp["message"],
            format!("{cli} cannot start in window terminal: {problem}; nothing was started"),
            "{mcp}"
        );
        let refused = refused(&home, cli);
        assert!(
            refused.contains(&format!("{problem} (not_found)")),
            "{refused}"
        );
    }
}

/// An entry its `enabled` turns off is left out of `list_agents` while it is right, and listed with
/// what is wrong where it is not: a variable its `env` reads that the agent's environment has not
/// too (CONFIGURATION-2.2, 4.1).
#[test]
fn a_turned_off_entry_that_is_wrong_is_listed_with_what_is_wrong() {
    let home = TestHome::new("configoffwrong");
    let clis = json!({
        "off": { "type": "fake", "enabled": false },
        "off reads": {
            "type": "fake", "enabled": false, "env": { "A": "${env:NOT_SET_FOR_THIS}" },
        },
    });
    settings(&home, &json!({ "clis": clis }));
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let refused = ada.call(
        "start_agent",
        json!({ "name": "w", "cli": "off reads", "window": "terminal", "path": cwd }),
    );
    let said = "clis[\"off reads\"].env.A reads ${env:NOT_SET_FOR_THIS}, but NOT_SET_FOR_THIS is \
                not in the environment it starts with; set it there, or write the value";
    assert_eq!(
        refused["message"],
        format!("off reads cannot start in window terminal: {said}; nothing was started"),
        "{refused}"
    );
}

/// A settings file wrong as a whole lists no CLI: its problems, which stand for every start, are
/// said once among the window's (CONFIGURATION-4.1), and what was read of the window stays
/// `complete`.
#[test]
fn a_file_wrong_as_a_whole_lists_no_cli_and_says_its_problems_once() {
    let home = TestHome::new("configwhole");
    home.start_named_fake("ada", &[]);
    settings(&home, &json!({ "yolo": "no" }));
    let mut ada = McpTestClient::open(&home, "a1");
    let window = ada.call("list_agents", json!({}))["data"]["windows"][0].clone();
    assert_eq!(window["clis"], json!([]), "{window}");
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let refused = ada.call(
        "start_agent",
        json!({ "name": "w", "cli": "fake", "window": "terminal", "path": cwd }),
    );
    let message = refused["message"].as_str().unwrap();
    assert!(
        refused["reason"] == "configuration_invalid"
            && message.contains("facade.json:1:2: yolo must be true or false; received string")
            && message.matches("yolo must be").count() == 1,
        "{refused}"
    );
}

/// `start_agent` refuses a model or an effort that is blank, in its tool's words, and starts
/// nothing.
#[test]
fn start_agent_refuses_a_blank_model_or_effort() {
    let home = TestHome::new("configblank");
    home.start_named_fake("ada", &[]);
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let mut ada = McpTestClient::open(&home, "a1");
    let refused = ada.call(
        "start_agent",
        json!({
            "name": "w", "cli": "fake", "window": "terminal", "path": cwd, "model": "  ",
            "effort": "\u{feff}",
        }),
    );
    let said = "model must not be blank; leave it out for the CLI's own; effort must not be \
                blank; leave it out for the CLI's own; nothing was done";
    assert_eq!(
        (&refused["reason"], &refused["message"]),
        (&json!("invalid_argument"), &json!(said)),
        "{refused}"
    );
    assert_eq!(home.agents().len(), 1, "nothing started");
}

/// A resume refuses an entry that is now turned off, or wrong, as a start does (CONFIGURATION-3.4).
#[test]
fn a_resume_refuses_an_entry_turned_off_or_wrong() {
    let home = TestHome::new("configresumeoff");
    let entry = |more: Value| {
        let mut entry = json!({ "type": "fake" });
        entry
            .as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        json!({ "clis": { "fake work": entry } })
    };
    settings(&home, &entry(json!({})));
    start(
        &home,
        "worker",
        "fake work",
        &[("FAKECLI_SESSION", SESSION)],
    );
    assert!(wait_until(secs(10), || home
        .agent_from_list_json("worker")
        .is_some_and(|agent| agent["session"] == SESSION)));
    home.run_facade_ok(&["stop", "worker"]);
    for (more, said) in [
        (
            json!({ "enabled": false }),
            "fake work is turned off by clis[\"fake work\"].enabled (unavailable)",
        ),
        (
            json!({ "args": [42] }),
            "clis[\"fake work\"].args[0] must be a string; received number (configuration_invalid)",
        ),
    ] {
        settings(&home, &entry(more));
        let resumed = facade(&home, &["resume", "worker"], &[]);
        assert!(
            !resumed.status.success() && stderr(&resumed).contains(said),
            "{}",
            stderr(&resumed)
        );
    }
}

/// An entry of a built-in's type runs its own `command` in place of the built-in's program; one
/// under `~/` is in the home of the environment it starts with, and a relative one is from the
/// agent's folder (CONFIGURATION-2.2).
#[test]
fn an_entry_s_command_runs_in_place_of_its_type_s_program() {
    let home = TestHome::new("configcommand");
    let fakecli = test_binaries().fakecli.clone();
    install_program(&home.user_home().join("bin"), "home-fakecli", &fakecli);
    install_program(&home.project.join("rel"), "rel-fakecli", &fakecli);
    let marker = home.project.parent().unwrap().join("wrapper.ran");
    let wrapper = install_script(
        home.project.parent().unwrap(),
        "wrapper",
        &format!(
            "#!/bin/sh\necho ran > '{}'\nexec '{}' \"$@\"\n",
            marker.display(),
            fakecli.display()
        ),
    );
    let clis = json!({
        "fake": { "command": wrapper },
        "homed": { "type": "fake", "command": "~/bin/home-fakecli" },
        "here": { "type": "fake", "command": "rel/rel-fakecli" },
    });
    settings(&home, &json!({ "clis": clis }));
    start(&home, "w", "fake", &[]);
    assert!(
        wait_until(secs(10), || marker.exists()),
        "the entry's command did not run"
    );
    for (name, cli) in [("h", "homed"), ("r", "here")] {
        start(&home, name, cli, &[]);
    }
    let mut w = McpTestClient::open(&home, "a1");
    let rows = w.call("list_agents", json!({}))["data"]["windows"][0]["clis"].clone();
    for cli in ["fake", "homed", "here"] {
        assert!(
            rows.as_array().unwrap().iter().any(|row| row == cli),
            "{cli} listed available: {rows}"
        );
    }
}

/// A name from `names` is one no agent of the agent's own window has: an agent of another window
/// with it does not take it (LIFECYCLE-2.1).
#[test]
fn a_name_from_names_is_one_no_agent_of_its_window_has() {
    let home = TestHome::new("configwindows");
    settings(&home, &json!({ "names": ["Solo"] }));
    let folder = facade_base::files::real_path(&home.project)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut window = ide(
        &home,
        &json!({
            "id": "win-1", "label": "win-1 window", "environment": "local", "workspace": null,
            "folders": [folder],
        }),
    );
    let env = json!({ "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path });
    let start = json!({
        "command": ["fake"], "cwd": folder, "window_id": "win-1", "env": env, "cols": 80,
        "rows": 24,
    });
    assert_eq!(
        window.call("agent.start", start.clone())["result"]["agent"]["name"],
        "Solo"
    );
    assert_eq!(
        window.call("agent.start", start)["result"]["agent"]["name"],
        "#a2",
        "every name of the list taken in its window"
    );
    let terminal = facade(&home, &["start", "fake"], &[]);
    assert!(terminal.status.success(), "{}", stderr(&terminal));
    let names: Vec<(String, String)> = home
        .agents()
        .iter()
        .map(|agent| {
            (
                agent["window_id"].as_str().unwrap().into(),
                agent["name"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert!(
        names.contains(&("terminal".into(), "Solo".into())),
        "the terminal window's first agent takes it: {names:?}"
    );
}

/// A name of spaces alone is blank, by the spaces the editor trims, a byte order mark among them: a
/// start and a rename given one name the agent from `names` (LIFECYCLE-2.1).
#[test]
fn a_name_of_the_editor_s_spaces_alone_is_blank() {
    let home = TestHome::new("configblankname");
    settings(&home, &json!({ "names": ["Solo"] }));
    let started = facade(&home, &["start", "--name", "\u{feff} ", "fake"], &[]);
    assert!(started.status.success(), "{}", stderr(&started));
    assert_eq!(home.agents()[0]["name"], "Solo", "{:?}", home.agents());
    settings(&home, &json!({ "names": ["Renamed"] }));
    home.run_facade_ok(&["rename", "Solo", "\u{feff}"]);
    assert_eq!(home.agents()[0]["name"], "Renamed", "{:?}", home.agents());
}

/// An agent renamed to a blank name, and a guest of a CLI the person started, are named as a start
/// without a name is: from `names` (LIFECYCLE-2.1).
#[test]
fn a_blank_rename_and_a_guest_are_named_from_names() {
    let home = TestHome::new("confignamed");
    settings(&home, &json!({ "names": ["Renamed"] }));
    home.start_named_fake("ada", &[]);
    home.run_facade_ok(&["rename", "ada", " "]);
    assert!(
        home.agents().iter().any(|agent| agent["name"] == "Renamed"),
        "{:?}",
        home.agents()
    );
    settings(&home, &json!({ "names": ["Guestly"] }));
    let _wire = connect(&home);
    let mut hook = home.command(&test_binaries().facade);
    hook.args(["hook", "session-start", "--cli", "claude"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut joining = hook.spawn().unwrap();
    let input = json!({ "hook_event_name": "SessionStart", "session_id": "s1" }).to_string();
    std::io::Write::write_all(&mut joining.stdin.take().unwrap(), input.as_bytes()).unwrap();
    assert!(joining.wait().unwrap().success());
    assert!(
        home.agents()
            .iter()
            .any(|agent| agent["session"] == "s1" && agent["name"] == "Guestly"),
        "{:?}",
        home.agents()
    );
}

/// A start that its settings refuse makes no worktree, though it asks for one: what does not depend
/// on the new folder is checked before Git makes it (CLIS-4.2). So are a name no CLI of the file
/// has, which is said at the location the start asked for, an entry turned off, an effort its CLI
/// takes none of, and a settings file wrong as a whole.
#[test]
fn a_start_its_settings_refuse_makes_no_worktree() {
    let home = TestHome::new("configworktree");
    let git = |folder: &std::path::Path, args: &[&str]| {
        let done = std::process::Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            done.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&done.stderr)
        );
        String::from_utf8_lossy(&done.stdout).into_owned()
    };
    settings(
        &home,
        &json!({
            "clis": { "off": { "type": "fake", "enabled": false }, "oc": { "type": "opencode" } },
        }),
    );
    let repo = home.path.parent().unwrap().join("app");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(
        &repo,
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
    let repo = facade_base::files::real_path(&repo).unwrap();
    let folder = repo.to_string_lossy().into_owned();
    let mut window = ide(
        &home,
        &json!({
            "id": "win-1", "label": "win-1 window", "environment": "local", "workspace": "k1",
            "folders": [folder],
        }),
    );
    let env = json!({ "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path });
    let boss = window.call(
        "agent.start",
        json!({
            "command": ["fake"], "name": "boss", "cwd": folder, "window_id": "win-1", "env": env,
            "cols": 80, "rows": 24,
        }),
    );
    let mut boss =
        McpTestClient::open(&home, boss["result"]["agent"]["agent_id"].as_str().unwrap());
    let mut start = |cli: &str, more: Value| {
        let mut call = json!({
            "name": "w", "cli": cli, "window": "win-1", "path": folder,
            "worktree": format!("{cli}-branch"),
        });
        call.as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        boss.call("start_agent", call)
    };
    assert_eq!(start("nope", json!({}))["reason"], "invalid_argument");
    assert_eq!(start("off", json!({}))["reason"], "invalid_argument");
    assert_eq!(
        start("oc", json!({ "effort": "high" }))["status"],
        "failure"
    );
    settings(&home, &json!({ "yolo": "no" }));
    assert_eq!(start("fake", json!({}))["reason"], "configuration_invalid");
    assert_eq!(
        git(&repo, &["worktree", "list"]).lines().count(),
        1,
        "no worktree made"
    );
    assert_eq!(
        git(&repo, &["branch", "--list"]).lines().count(),
        1,
        "no branch made"
    );
}

/// A `custom` entry `dump` whose program writes its environment to a file once it starts, and that
/// file: each line `NAME=value`.
fn dumper(home: &TestHome) -> (Value, std::path::PathBuf) {
    let dumped = home.project.parent().unwrap().join("dumped.env");
    let script = format!(
        "env > '{0}.partial' && mv '{0}.partial' '{0}'; exec sleep 600",
        dumped.display()
    );
    (
        json!({
            "type": "custom", "command": SH.as_str(), "args": ["-c", script],
            "env": { "COPY": "${env:PROVIDER_KEY}" },
        }),
        dumped,
    )
}

/// The variables of a file `dumper` wrote, once it did.
fn dumped(file: &std::path::Path) -> Vec<String> {
    assert!(
        wait_until(secs(30), || file.exists()),
        "the program wrote no environment to {}",
        file.display()
    );
    std::fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

/// An agent inherits the environment of the agent that starts it from its tools, as a shell started
/// from another inherits its variables: what the creator's entry set or removed reaches the CLIs it
/// starts, and their own entries apply on top (CONFIGURATION-2.1, 3.2).
#[test]
fn an_agent_starts_agents_with_its_own_environment() {
    let home = TestHome::new("configenvtools");
    let (dump, file) = dumper(&home);
    let work = json!({
        "type": "fake",
        "env": { "FAKECLI_NAME": "work-provider", "PROVIDER_KEY": "sk-work", "KEPT": null },
    });
    settings(
        &home,
        &json!({ "clis": { "fake work": work, "dump": dump } }),
    );
    let started = facade(
        &home,
        &["start", "--name", "ada", "fake work"],
        &[("PROVIDER_KEY", "person-key"), ("KEPT", "kept")],
    );
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("work-provider")),
        "{}",
        home.screen("ada")
    );
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let mut ada = McpTestClient::open(&home, "a1");
    for (name, cli) in [("kid", "fake"), ("dumper", "dump")] {
        let started = ada.call(
            "start_agent",
            json!({ "name": name, "cli": cli, "window": "terminal", "path": cwd }),
        );
        assert_eq!(started["status"], "success", "{started}");
    }
    assert!(
        wait_until(secs(30), || home.screen("kid").contains("work-provider")),
        "kid inherits ada's FAKECLI_NAME: {}",
        home.screen("kid")
    );
    let env = dumped(&file);
    let mut ours: Vec<&str> = env
        .iter()
        .map(String::as_str)
        .filter(|line| {
            ["PROVIDER_KEY=", "COPY=", "KEPT=", "FAKECLI_NAME="]
                .iter()
                .any(|name| line.starts_with(name))
        })
        .collect();
    ours.sort_unstable();
    assert_eq!(
        ours,
        [
            "COPY=sk-work",
            "FAKECLI_NAME=work-provider",
            "PROVIDER_KEY=sk-work"
        ],
        "{env:?}"
    );
}

/// An editor window that gives the environment its agents start with lists, to its own client,
/// the CLIs a start can run there, each found on that environment's `PATH` or not. A window that
/// gives none lists no CLIs.
#[test]
fn an_editor_window_s_environment_lists_the_clis_it_can_start() {
    let home = TestHome::new("configide");
    let gone = json!({ "type": "fake", "command": "/nowhere/facade-fakecli" });
    settings(&home, &json!({ "clis": { "gone": gone } }));
    let folder = std::fs::canonicalize(&home.project).unwrap();
    let window = |id: &str| {
        json!({
            "id": id, "label": format!("{id} window"), "environment": "local", "workspace": id,
            "folders": [folder],
        })
    };
    let mut described = window("win-env");
    described["env"] = json!({ "PATH": home.path_with_test_programs() });
    let mut editor = ide(&home, &described);
    let _bare = ide(&home, &window("win-bare"));
    let watching = editor.request("watch", json!({ "topic": "windows" }));
    let listed = |id: &str| {
        watching["result"]["snapshot"]
            .as_array()
            .unwrap_or_else(|| panic!("{watching}"))
            .iter()
            .find(|listed| listed["window_id"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("no window {id}: {watching}"))
    };
    let clis = listed("win-env")["clis"].clone();
    let cli = |name: &str| {
        clis.as_array()
            .unwrap_or_else(|| panic!("{clis}"))
            .iter()
            .find(|cli| cli["cli"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("no {name}: {clis}"))
    };
    assert_eq!(cli("fake")["available"], true, "{clis}");
    assert_eq!(cli("gone")["available"], false, "{clis}");
    assert!(
        listed("win-bare").get("clis").is_none(),
        "{}",
        listed("win-bare")
    );
}

/// A start that an entry of the settings file refuses names the entry in the error's data, so that
/// an editor can offer to open the file.
#[test]
fn a_start_an_entry_refuses_names_the_entry() {
    let home = TestHome::new("configentry");
    let gone = json!({ "type": "fake", "command": "/nowhere/facade-fakecli" });
    settings(&home, &json!({ "clis": { "gone": gone } }));
    let mut wire = connect(&home);
    let args = json!({
        "command": ["gone"], "name": "nope", "cwd": home.project,
        "env": { "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path },
        "cols": 80, "rows": 24,
    });
    let refused = wire.call("agent.start", args);
    assert_eq!(refused["error"]["data"]["entry"], "gone", "{refused}");
    assert!(home.agents().is_empty(), "nothing started");
}
