//! The CLIs and names of Facade's settings file (CONFIGURATION-1.4, 2, 3, 4; LIFECYCLE-2.1;
//! CLIS-1.4): `facade start`, `start_agent` and `facade resume` run a CLI as its entry in
//! `facade.json` says - its program, `args`, `env`, `model` and `effort` - an added CLI of a
//! built-in's type as that built-in runs, and one of type `custom` as a program; an entry that is
//! wrong, or turned off, refuses its own starts alone; `cli.list` lists the entries; and an
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

/// Asserts that `message` says `problem` at its place in the settings file, then the CLIs that
/// can start: the test CLI alone.
fn assert_settings_problem(home: &TestHome, message: &Value, problem: &str) {
    let file = facade_base::files::real_path(&home.path.join("facade.json")).unwrap();
    let said = message
        .as_str()
        .and_then(|message| message.strip_prefix(&format!("{}:", file.display())))
        .and_then(|message| message.split_once(": "))
        .map(|(_, said)| said);
    assert_eq!(
        said,
        Some(format!("{problem}\nAvailable CLIs: fake.").as_str()),
        "{message}"
    );
}

/// Waits until the daemon reports the agent `name` with the test CLI's session.
fn has_session(home: &TestHome, name: &str) {
    let session = || home.inspect_agent(name)["agent"]["session"].clone();
    assert!(
        wait_until(secs(10), || session() == SESSION),
        "{name} reported no session: {}",
        session()
    );
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
    let mut args = None;
    assert!(
        wait_until(secs(10), || {
            args = std::fs::read_to_string(file)
                .ok()
                .and_then(|text| facade_scenarios::serde_json::from_str(&text).ok());
            args.is_some()
        }),
        "the CLI did not write a complete argv array to {file}"
    );
    args.unwrap()
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
    let started = facade(home, &["start", "-d", "--name", name, cli], env);
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
    let output = facade(home, &["start", "-d", "--name", "nope", cli], &[]);
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
    let fake = &test_binaries().fakecli;
    settings(
        &home,
        &json!({ "clis": {
        "fake work": entry,
        "missing": { "command": fake },
        "claude": { "type": "fake", "command": fake },
    } }),
    );
    let started = facade(
        &home,
        &["start", "-d", "--name", "worker", "fake work", "--more"],
        &[("WHO", "ada-at-work")],
    );
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        wait_until(secs(30), || home.screen("worker").contains("ada-at-work")),
        "its env, read from the start's: {}",
        home.screen("worker")
    );
    assert_eq!(
        without_wiring(&home, args_in(&file)),
        ["--model", "m1", "--effort", "low", "--flag", "x", "--more"]
    );
    assert_eq!(home.listed_agent("worker").unwrap()["cli"], "fake work");
    let inspected = home.run_facade_ok(&["status", "worker"]);
    assert_eq!(
        status_field(&inspected, "CLI"),
        Some("fake work"),
        "{inspected}"
    );
    let rule = connect(&home).call("agent.inspect", json!({ "target": "worker" }));
    assert_eq!(rule["result"]["rule"], "fake", "{rule}");
    assert!(refused(&home, "missing").contains("clis.missing.type is missing"));
    assert!(
        refused(&home, "claude").contains("clis.claude.type cannot change the claude entry's type")
    );
    assert_eq!(home.agents().len(), 1, "invalid type entries start nothing");
}

/// `args` without the `--mcp-config <file>` the test CLI's rule gives its run: Facade's server, in
/// a file of the run's own.
fn without_wiring(home: &TestHome, mut args: Vec<String>) -> Vec<String> {
    let wiring = args
        .iter()
        .position(|arg| arg == "--mcp-config")
        .expect("the fake CLI's MCP configuration");
    let config = std::path::Path::new(&args[wiring + 1]);
    let runs = home.path.join("core/runs");
    assert!(
        config.starts_with(&runs)
            || config.starts_with(facade_base::files::real_path(&runs).unwrap()),
        "{args:?}"
    );
    assert!(config.is_file(), "{args:?}");
    drop(args.drain(wiring..wiring + 2));
    args
}

/// A CLI of type `custom` runs its `command` and `args` as a program, which Facade gives nothing of
/// its own: no rule, no tools. It takes no messages, so a start with a first prompt is refused
/// before it starts anything.
#[test]
fn a_custom_cli_runs_its_program_as_it_is() {
    let home = TestHome::new("configprogram");
    let file = args_file(&home, "tool");
    let program = test_binaries().fakecli.to_string_lossy().into_owned();
    let entry = json!({
        "type": "custom", "program": program, "args": ["--resume-like", ""],
        "env": { "FAKECLI_ARGS": file },
    });
    settings(&home, &json!({ "clis": { "tool": entry } }));
    let launched = facade(
        &home,
        &[
            "start",
            "-d",
            "--name",
            "tool",
            "tool",
            "--",
            "per-launch value",
        ],
        &[],
    );
    assert!(launched.status.success(), "{}", stderr(&launched));
    assert_eq!(
        args_in(&file),
        ["--resume-like", "", "--", "per-launch value"],
        "configured arguments, including the empty one, precede the launch's exact words"
    );
    let inspected = home.inspect_agent("tool");
    assert_eq!(inspected["agent"]["cli"], "tool");
    assert_eq!(
        (inspected.get("rule"), &inspected["agent"]["tools_state"]),
        (None, &json!("not_injected")),
        "{inspected}"
    );
    let prompted = home.start_with_prompt("prompted", "tool", "hi", &[]);
    assert!(prompted["error"].is_object(), "{prompted}");
    assert!(
        home.listed_agent("prompted").is_none(),
        "nothing started: {prompted}"
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

/// `start_agent` starts a CLI of the settings file by name and honors the requested launch choices.
/// A CLI that takes no effort refuses it. The CLI catalog lists built-ins and added CLIs with their
/// launch choices. The catalog excludes disabled entries and explains malformed ones.
#[test]
fn start_agent_and_the_cli_catalog_use_the_settings_file() {
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
    let started = home.run_facade_ok(&["start", "-d", "--name", "ada", "fake"]);
    let (id, _) = started_ref(&started)
        .split_once('@')
        .expect("start gives an address");
    let cwd = home.listed_agent("ada").unwrap()["folder"].clone();
    let mut ada = McpTestClient::open_configured(&home, id);
    let rows = connect(&home).call("cli.list", json!({}))["result"]["clis"].clone();
    let rows = rows.as_array().unwrap();
    let named: Vec<&str> = rows
        .iter()
        .map(|row| row["cli"].as_str().unwrap())
        .filter(|cli| ["fake", "fake work", "oc", "off", "bad"].contains(cli))
        .collect();
    assert_eq!(named, ["fake", "fake work", "oc", "bad"], "{rows:?}");
    let info = |cli: &str| rows.iter().find(|row| row["cli"] == cli).unwrap();
    assert_eq!(
        info("fake work"),
        &json!({
            "cli": "fake work", "display_name": "fake work", "available": true,
            "overrides": { "model": true, "effort": true },
        })
    );
    assert_eq!(info("oc")["available"], true);
    assert_eq!(info("oc")["overrides"]["effort"], false);
    let bad_row = info("bad");
    assert_eq!(bad_row["available"], false, "{bad_row}");
    let settings_file = facade_base::files::real_path(&home.path.join("facade.json")).unwrap();
    let prefix = format!("{}:", settings_file.display());
    let size = std::fs::read_to_string(&settings_file)
        .unwrap()
        .chars()
        .count();
    let assert_bad_icon = |problem: &Value| {
        let (location, message) = problem
            .as_str()
            .and_then(|problem| problem.strip_prefix(&prefix))
            .and_then(|problem| problem.split_once(": "))
            .unwrap_or_else(|| {
                panic!("settings error starts with the file and position: {problem}")
            });
        let column: usize = location
            .strip_prefix("1:")
            .and_then(|column| column.parse().ok())
            .expect("the column in the one-line settings file");
        assert!(
            (1..=size).contains(&column),
            "column {column} is outside the settings line"
        );
        assert!(
            message.starts_with("clis.bad.icon must be one of"),
            "{problem}"
        );
    };
    assert_bad_icon(&bad_row["problem"]);
    let start = |cli: &str, more: Value| {
        let mut call = json!({ "name": "worker", "cli": cli, "folder": cwd });
        call.as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        call
    };
    let started = ada.call("start_agent", start("fake work", json!({ "model": "m2" })));
    assert_eq!(started["status"], "success", "{started}");
    assert_eq!(
        without_wiring(&home, args_in(&file)),
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
    assert_eq!(bad["reason"], "invalid_settings", "{bad}");
    assert_bad_icon(&bad["message"]);
    let off = ada.call("start_agent", start("off", json!({})));
    assert_eq!(off["reason"], "unavailable", "{off}");
    let off = off["message"].as_str().unwrap_or_default();
    assert!(
        off.contains("off is turned off by clis.off.enabled")
            && off.ends_with("\nAvailable CLIs: fake, fake work, oc."),
        "refused, with the CLIs that can start: {off}"
    );
}

/// A resume runs the CLI with the arguments its start recorded, though the entry's `args` changed
/// since; it refuses an entry that now runs another CLI, and one the file no longer has, rather
/// than run another in its place (CONFIGURATION-3.4).
#[test]
fn a_resume_runs_its_start_s_args_and_refuses_an_entry_retyped_or_gone() {
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
    has_session(&home, "worker");
    home.run_facade_ok(&["stop", "worker"]);
    settings(&home, &entry(json!(["--then"]), "fake"));
    std::fs::remove_file(&file).unwrap();
    let resumed = facade(&home, &["resume", "-d", "worker"], &[]);
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    let args = args_in(&file);
    assert!(
        args.windows(2).any(|pair| pair == ["--resume", SESSION])
            && args.contains(&"--first".to_string())
            && !args.contains(&"--then".to_string()),
        "{args:?}"
    );
    home.run_facade_ok(&["stop", "worker"]);
    let program = test_binaries().fakecli.to_string_lossy().into_owned();
    settings(
        &home,
        &json!({ "clis": { "fake work": { "type": "custom", "command": program } } }),
    );
    let retyped = facade(&home, &["resume", "-d", "worker"], &[]);
    let said = "clis[\"fake work\"] runs a program now, but this conversation is Fake CLI's; it \
                cannot be resumed with it";
    assert!(
        !retyped.status.success() && stderr(&retyped).contains(said),
        "{}",
        stderr(&retyped)
    );
    settings(&home, &json!({}));
    let gone = facade(&home, &["resume", "-d", "worker"], &[]);
    let said = "\"fake work\" is no longer in clis of ";
    assert!(
        !gone.status.success()
            && stderr(&gone).contains(said)
            && stderr(&gone).contains("so this conversation cannot be resumed with it."),
        "{}",
        stderr(&gone)
    );
}

/// An agent started without a name takes an unused name from the machine's `names`, trimmed.
/// With every one taken, it reuses a name from the list. An empty pool uses the built-in names.
#[test]
fn an_agent_started_without_a_name_is_named_from_names() {
    let home = TestHome::new("confignames");
    settings(&home, &json!({ "names": [" Solo ", " Duo "] }));
    home.start_named_fake("sOlO", &[]);
    let start = || {
        let started = facade(&home, &["start", "-d", "fake"], &[]);
        assert!(started.status.success(), "{}", stderr(&started));
        let id = started_id(&stdout(&started));
        home.agent_record(&id).unwrap()["name"].clone()
    };
    assert_eq!(start(), "Duo", "a running agent already has Solo");
    let reused = start();
    assert!(matches!(reused.as_str(), Some("Solo" | "Duo")), "{reused}");
    settings(&home, &json!({ "names": [] }));
    let fallback = start();
    let built_in = include_str!("../../../extension/src/base/names.ts")
        .split_once(" = [")
        .unwrap()
        .1
        .split_once("];")
        .unwrap()
        .0;
    assert!(
        built_in
            .split(',')
            .any(|name| fallback == name.trim().trim_matches('\'')),
        "the Core falls back to a built-in name: {fallback}"
    );
}

#[test]
fn facade_home_selects_only_its_own_settings_and_agents() {
    let left = TestHome::new("config-home-left");
    let right = TestHome::new("config-home-right");
    for (home, name) in [(&left, "Left isolated CLI"), (&right, "Right isolated CLI")] {
        settings(
            home,
            &json!({ "clis": { "fake": { "env": { "FAKECLI_NAME": name } } } }),
        );
        start(home, "worker", "fake", &[]);
    }
    for (home, expected, other) in [
        (&left, "Left isolated CLI", "Right isolated CLI"),
        (&right, "Right isolated CLI", "Left isolated CLI"),
    ] {
        let screen = home.run_facade_ok(&["screen", "worker"]);
        assert!(
            screen.contains(expected) && !screen.contains(other),
            "{screen}"
        );
        assert_eq!(home.agents().len(), 1);
    }
    assert_ne!(
        left.hello_result().unwrap()["machine_id"],
        right.hello_result().unwrap()["machine_id"],
    );

    let mut fallback = TestHome::new("config-home-default");
    fallback.path = fallback.folder().join(".facade");
    start(&fallback, "from-default", "fake", &[]);
    let user = fallback.folder().to_str().unwrap();
    let listing = facade(&fallback, &["list"], &[("HOME", user), ("FACADE_HOME", "")]);
    assert!(listing.status.success(), "{}", stderr(&listing));
    assert!(stdout(&listing).contains("from-default"));

    let relative = facade(&left, &["list"], &[("FACADE_HOME", "relative-state")]);
    assert!(!relative.status.success());
    assert!(stderr(&relative).contains("FACADE_HOME must be an absolute path"));
    assert!(!left.project.join("relative-state").exists());
}

#[test]
fn schema_is_metadata_and_a_non_string_schema_blocks_launch() {
    let home = TestHome::new("configschema");
    let file = args_file(&home, "schema");
    let mut config = json!({ "clis": { "recipe": {
        "type": "custom", "program": test_binaries().fakecli,
        "args": ["--label", "saved setting"], "env": { "FAKECLI_ARGS": file },
    } } });
    settings(&home, &config);
    start(&home, "before-schema", "recipe", &[]);
    let args = args_in(&file);
    assert_eq!(args, ["--label", "saved setting"]);
    std::fs::remove_file(&file).unwrap();
    config["$schema"] = json!("./facade.schema.json");
    settings(&home, &config);
    start(&home, "with-schema", "recipe", &[]);
    assert_eq!(args_in(&file), args);
    config["$schema"] = json!(42);
    settings(&home, &config);
    let error = refused(&home, "recipe");
    assert!(
        error.contains("facade.json:")
            && error.contains("$schema must be a string; received number"),
        "{error}",
    );
    assert_eq!(home.agents().len(), 2);
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
        &[&["start", "-d", "--name", label, label][..], words].concat(),
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

/// MCP names an entry's setting and lookup directory (CONFIGURATION-2.2, 4.1). Shell names the
/// machine and program, distinguishing a PATH search from an explicit path.
#[test]
fn an_entry_s_program_that_cannot_run_is_said_by_its_setting() {
    let home = TestHome::new("configprogram");
    let clis = json!({
        "oc": { "type": "opencode" },
        "named": { "type": "fake", "command": "no-such-cli" },
        "canonical": { "type": "fake", "program": "no-such-cli" },
        "gone": { "type": "fake", "command": "/nope/facade-fakecli" },
    });
    settings(&home, &json!({ "clis": clis }));
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let folder = home.listed_agent("ada").unwrap()["folder"]
        .as_str()
        .unwrap()
        .to_string();
    let machines = connect(&home).call_ok("machine.list", json!({}));
    let machine = machines["machines"][0]["name"]
        .as_str()
        .expect("the local machine name");
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
                "opencode was not found on the PATH of a terminal in {folder}, and clis.oc.program \
                 does not name its location"
            ),
            "opencode was not found on PATH.".to_string(),
        ),
        (
            "named",
            format!(
                "clis.named.command is \"no-such-cli\", which was not found on the PATH of a \
                 terminal in {folder}"
            ),
            "no-such-cli was not found on PATH.".to_string(),
        ),
        (
            "canonical",
            format!(
                "clis.canonical.program is \"no-such-cli\", which was not found on the PATH of a \
                 terminal in {folder}"
            ),
            "no-such-cli was not found on PATH.".to_string(),
        ),
        (
            "gone",
            format!(
                "clis.gone.command is \"/nope/facade-fakecli\", and {gone} is not a program that \
                 can be run"
            ),
            format!("{gone} was not found."),
        ),
    ];
    for (cli, problem, shell_detail) in said {
        let start = json!({ "name": "w", "cli": cli, "folder": folder });
        let mcp = ada.call("start_agent", start);
        assert_eq!(mcp["reason"], "not_found", "{mcp}");
        assert_settings_problem(&home, &mcp["message"], &problem);
        let refused = facade(&home, &["start", "-d", "--name", "nope", cli], &[]);
        assert_eq!(
            (stdout(&refused), stderr(&refused), refused.status.code()),
            (
                String::new(),
                format!("error: Could not start {cli:?} on {machine}. {shell_detail}\n"),
                Some(1),
            ),
            "{cli}"
        );
    }
}

/// An entry its `enabled` turns off is refused with what is wrong where it is wrong: a variable its
/// `env` reads that the agent's environment has not (CONFIGURATION-2.2, 4.1).
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
    let cwd = home.listed_agent("ada").unwrap()["folder"].clone();
    let refused = ada.call(
        "start_agent",
        json!({ "name": "w", "cli": "off reads", "folder": cwd }),
    );
    let said = "clis[\"off reads\"].env.A reads ${env:NOT_SET_FOR_THIS}, but NOT_SET_FOR_THIS is \
                not in the environment it starts with; set it there, or write the value";
    assert_eq!(refused["reason"], "invalid_settings", "{refused}");
    assert_settings_problem(&home, &refused["message"], said);
}

/// A settings file wrong as a whole lists no CLI: its problems, which stand for every start, are
/// said once beside the catalog (CONFIGURATION-4.1).
#[test]
fn a_file_wrong_as_a_whole_lists_no_cli_and_says_its_problems_once() {
    let home = TestHome::new("configwhole");
    home.start_named_fake("ada", &[]);
    settings(&home, &json!({ "yolo": "no" }));
    let mut ada = McpTestClient::open(&home, "a1");
    let catalog = connect(&home).call("cli.list", json!({}))["result"].clone();
    let problem = catalog["settings_problem"].as_str().unwrap_or_default();
    assert!(
        catalog["clis"] == json!([])
            && problem.contains("yolo must be true or false; received string")
            && problem.matches("yolo must be").count() == 1,
        "{catalog}"
    );
    let cwd = home.listed_agent("ada").unwrap()["folder"].clone();
    let refused = ada.call(
        "start_agent",
        json!({ "name": "w", "cli": "fake", "folder": cwd }),
    );
    let message = refused["message"].as_str().unwrap();
    assert!(
        refused["reason"] == "invalid_settings"
            && message.contains("facade.json:1:2: yolo must be true or false; received string")
            && message.matches("yolo must be").count() == 1,
        "{refused}"
    );
}

/// `start_agent` uses configured or explicit model and effort choices and refuses a blank
/// choice or one the CLI cannot set before starting anything.
#[test]
fn start_agent_refuses_a_blank_model_or_effort() {
    let home = TestHome::new("configblank");
    let file = args_file(&home, "choices");
    settings(
        &home,
        &json!({ "clis": { "recipe": {
        "type": "fake", "model": "m1", "effort": "low", "env": { "FAKECLI_ARGS": file },
    }, "custom": { "type": "custom", "program": test_binaries().fakecli } } }),
    );
    home.start_named_fake("ada", &[]);
    let cwd = home.listed_agent("ada").unwrap()["folder"].clone();
    let mut ada = McpTestClient::open(&home, "a1");
    let configured = ada.call(
        "start_agent",
        json!({ "name": "configured", "cli": "recipe", "folder": cwd }),
    );
    assert_eq!(configured["status"], "success", "{configured}");
    assert_eq!(
        without_wiring(&home, args_in(&file)),
        ["--model", "m1", "--effort", "low"]
    );
    std::fs::remove_file(&file).unwrap();
    let override_choices = ada.call(
        "start_agent",
        json!({ "name": "override", "cli": "recipe", "folder": cwd, "model": "m2", "effort": "high" }),
    );
    assert_eq!(override_choices["status"], "success", "{override_choices}");
    assert_eq!(
        without_wiring(&home, args_in(&file)),
        ["--model", "m2", "--effort", "high"]
    );
    let before = home.agents();
    let refused = ada.call(
        "start_agent",
        json!({
            "name": "w", "cli": "fake", "folder": cwd, "model": "  ",
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
    for field in ["model", "effort"] {
        let mut request = json!({ "name": "unsupported", "cli": "custom", "folder": cwd });
        request[field] = json!("explicit");
        let outcome = ada.call("start_agent", request);
        assert_eq!(outcome["reason"], "unsupported", "{outcome}");
        assert_eq!(
            outcome["message"],
            format!("custom takes no explicit {field}; leave `{field}` out to use its default."),
            "{outcome}"
        );
    }
    assert_eq!(home.agents(), before, "nothing started");
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
    let available = || {
        let listed = connect(&home).call_ok("cli.list", json!({}));
        listed["clis"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["available"] == true)
            .map(|row| row["cli"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    settings(&home, &entry(json!({})));
    start(
        &home,
        "worker",
        "fake work",
        &[("FAKECLI_SESSION", SESSION)],
    );
    has_session(&home, "worker");
    home.run_facade_ok(&["stop", "worker"]);
    let before = available();
    assert!(before.iter().any(|cli| cli == "fake work"));
    for (more, said) in [
        (
            json!({ "enabled": false }),
            "fake work is turned off by clis[\"fake work\"].enabled",
        ),
        (
            json!({ "args": [42] }),
            "clis[\"fake work\"].args[0] must be a string; received number",
        ),
    ] {
        settings(&home, &entry(more));
        assert_eq!(
            available(),
            before
                .iter()
                .filter(|cli| *cli != "fake work")
                .cloned()
                .collect::<Vec<_>>(),
            "the changed entry alone stops being available"
        );
        let resumed = facade(&home, &["resume", "-d", "worker"], &[]);
        assert!(
            !resumed.status.success() && stderr(&resumed).contains(said),
            "{}",
            stderr(&resumed)
        );
    }
    start(&home, "unrelated", "fake", &[]);
    settings(&home, &entry(json!({ "enabled": true })));
    assert_eq!(available(), before, "re-enabling restores the same catalog");
    let resumed = facade(&home, &["resume", "-d", "worker"], &[]);
    assert!(resumed.status.success(), "{}", stderr(&resumed));
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
        "conflict": { "type": "fake", "command": fakecli, "program": fakecli },
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
    let launch: Value = home
        .isolating_env()
        .into_iter()
        .map(|(name, value)| (name.to_string(), json!(value)))
        .collect::<facade_scenarios::serde_json::Map<_, _>>()
        .into();
    let rows =
        connect(&home).call("cli.list", json!({ "folder": home.project, "env": launch }))["result"]
            ["clis"]
            .clone();
    for cli in ["fake", "homed", "here"] {
        assert!(
            rows.as_array()
                .unwrap()
                .iter()
                .any(|row| row["cli"] == cli && row["available"] == true),
            "{cli} listed available: {rows}"
        );
    }
    assert!(
        refused(&home, "conflict")
            .contains("clis.conflict.program conflicts with command. Keep program.")
    );
    assert!(home.listed_agent("nope").is_none());
}

/// Shell rejects a blank rename before changing the name. In the API, a blank rename picks a name
/// from the settings.
fn rename_blank_through_api(home: &TestHome, agent: &str, blank: &str) {
    let refused = facade(home, &["rename", agent, blank], &[]);
    assert_eq!(
        (
            stdout(&refused).as_str(),
            stderr(&refused).as_str(),
            refused.status.code()
        ),
        (
            "",
            "error: Agent name cannot be empty.\n\
             Usage: facade rename <AGENT> <NAME>\n\
             Example: facade rename Nova review\n",
            Some(2),
        )
    );
    assert_eq!(home.inspect_agent(agent)["agent"]["name"], agent);
    connect(home).call_ok("agent.rename", json!({ "target": agent, "name": blank }));
}

/// An editor-blank name, including a byte order mark, uses `names` in start and the v3 rename.
#[test]
fn a_name_of_the_editor_s_spaces_alone_is_blank() {
    let home = TestHome::new("configblankname");
    settings(&home, &json!({ "names": ["Solo"] }));
    let started = facade(&home, &["start", "-d", "--name", "\u{feff} ", "fake"], &[]);
    assert!(started.status.success(), "{}", stderr(&started));
    assert_eq!(home.agents()[0]["name"], "Solo", "{:?}", home.agents());
    settings(&home, &json!({ "names": ["Renamed"] }));
    rename_blank_through_api(&home, "Solo", "\u{feff}");
    assert_eq!(home.agents()[0]["name"], "Renamed", "{:?}", home.agents());
}

/// An agent renamed to a blank name, and a guest, are named as a start without a name is: from
/// `names` (LIFECYCLE-2.1).
#[test]
fn a_blank_rename_and_a_guest_are_named_from_names() {
    let home = TestHome::new("confignamed");
    settings(&home, &json!({ "names": ["Renamed"] }));
    home.start_named_fake("ada", &[]);
    rename_blank_through_api(&home, "ada", " ");
    assert!(
        home.agents().iter().any(|agent| agent["name"] == "Renamed"),
        "{:?}",
        home.agents()
    );
    settings(&home, &json!({ "names": ["Guestly"] }));
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let roster = guest.call("list_agents", json!({}));
    assert!(
        roster["data"]["agents"]
            .as_array()
            .is_some_and(|agents| agents
                .iter()
                .any(|agent| agent["type"] == "guest" && agent["name"] == "Guestly")),
        "{roster}"
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
    let boss = home.start_fake("boss");
    let mut boss = McpTestClient::open(&home, &boss.id);
    let mut start = |cli: &str, more: Value| {
        let mut call = json!({
            "name": "w", "cli": cli, "folder": folder, "worktree": format!("{cli}-branch"),
        });
        call.as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        boss.call("start_agent", call)
    };
    for (cli, reason) in [("nope", "not_found"), ("off", "unavailable")] {
        let refused = start(cli, json!({}));
        assert_eq!(refused["reason"], reason, "{refused}");
    }
    assert_eq!(
        start("oc", json!({ "effort": "high" }))["status"],
        "failure"
    );
    settings(&home, &json!({ "yolo": "no" }));
    assert_eq!(start("fake", json!({}))["reason"], "invalid_settings");
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
        &json!({ "clis": {
            "fake work": work,
            "dump": dump,
            "missing": { "type": "custom", "program": SH.as_str(),
                         "env": { "COPY": "${env:FACADE_CI_MISSING_ENV}" } },
        } }),
    );
    let started = facade(
        &home,
        &["start", "-d", "--name", "ada", "fake work"],
        &[("PROVIDER_KEY", "person-key"), ("KEPT", "kept")],
    );
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("work-provider")),
        "{}",
        home.screen("ada")
    );
    let cwd = home.listed_agent("ada").unwrap()["folder"].clone();
    let mut ada = McpTestClient::open(&home, "a1");
    for (name, cli) in [("kid", "fake"), ("dumper", "dump")] {
        let started = ada.call(
            "start_agent",
            json!({ "name": name, "cli": cli, "folder": cwd }),
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
        "{ours:?}"
    );
    let before = home.agents();
    let refused = ada.call(
        "start_agent",
        json!({ "name": "missing", "cli": "missing", "folder": cwd }),
    );
    assert_eq!(refused["reason"], "invalid_settings", "{refused}");
    let message = refused["message"].as_str().unwrap();
    assert!(message.contains("clis.missing.env.COPY reads"));
    assert!(message.contains("FACADE_CI_MISSING_ENV") && !message.contains("sk-work"));
    assert_eq!(home.agents(), before, "missing expansion starts nothing");
}

/// The CLI catalog of a client that gives the environment its agents start with lists the CLIs a
/// start can run there, each found on that environment's `PATH` or not.
#[test]
fn a_client_s_launch_environment_lists_the_clis_it_can_start() {
    let home = TestHome::new("configide");
    let gone = json!({ "type": "fake", "command": "/nowhere/facade-fakecli" });
    settings(&home, &json!({ "clis": { "gone": gone } }));
    let folder = std::fs::canonicalize(&home.project).unwrap();
    let listed = connect(&home).call(
        "cli.list",
        json!({ "folder": folder, "env": { "PATH": home.path_with_test_programs() } }),
    );
    let clis = listed["result"]["clis"].clone();
    let cli = |name: &str| {
        clis.as_array()
            .unwrap_or_else(|| panic!("{listed}"))
            .iter()
            .find(|cli| cli["cli"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("no {name}: {clis}"))
    };
    assert_eq!(cli("fake")["available"], true, "{clis}");
    assert_eq!(cli("gone")["available"], false, "{clis}");
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
        "cli": "gone", "name": "nope", "folder": home.project,
        "env": { "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path },
        "size": { "cols": 80, "rows": 24 },
    });
    let refused = wire.call("agent.start", args);
    assert_eq!(error_reason(&refused), "not_found", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("clis.gone.command")),
        "{refused}"
    );
    assert!(home.agents().is_empty(), "nothing started");
}
