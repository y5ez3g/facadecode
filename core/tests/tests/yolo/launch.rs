//! The public Shell and MCP entry points choose a managed run's startup policy.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

use super::{real, record, settings};

const CLIS: [&str; 6] = ["claude", "codex", "agy", "muse", "opencode", "pi"];
const UPDATER_KEYS: [&str; 4] = [
    "DISABLE_AUTOUPDATER",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "MUSE_NO_AUTO_UPDATE",
    "OPENCODE_DISABLE_AUTOUPDATE",
];
const UPDATE: &str = "check_for_update_on_startup";
const SESSION: &str = "2f6c0f0e-6a87-4b3d-9d1e-5f0b1e2c3d4a";

struct Capture {
    argv: PathBuf,
    env: PathBuf,
}

impl Capture {
    fn new(home: &TestHome) -> Self {
        Self {
            argv: home.folder().join("launch-argv.json"),
            env: home.folder().join("launch-env.json"),
        }
    }

    fn entry(&self) -> Value {
        let keys = [
            UPDATER_KEYS.as_slice(),
            &[
                "PI_SKIP_VERSION_CHECK",
                "OPENCODE_CONFIG_CONTENT",
                "LAUNCH_QA_MARKER",
            ],
        ]
        .concat()
        .join(",");
        json!({
            "program": test_binaries().fakecli,
            "env": {
                "FAKECLI_ARGS": self.argv, "FAKECLI_ENV": self.env, "FAKECLI_ENV_KEYS": keys,
            },
        })
    }

    fn read(&self) -> (Vec<String>, Value) {
        let take = |file: &Path| {
            assert!(
                wait_until(LOADED_TIMEOUT, || file.is_file()),
                "fake CLI did not write {}",
                file.display()
            );
            let contents = std::fs::read_to_string(file).unwrap();
            std::fs::remove_file(file).unwrap();
            contents
        };
        (
            serde_json::from_str(&take(&self.argv)).unwrap(),
            serde_json::from_str(&take(&self.env)).unwrap(),
        )
    }
}

fn set_clis(home: &TestHome, yolo: bool, clis: &Value) {
    settings(home, &json!({ "yolo": yolo, "clis": clis }).to_string());
}

fn mcp_start(home: &TestHome, tools: &mut McpTestClient, cli: &str, name: &str) {
    let reply = tools.call(
        "start_agent",
        json!({ "cli": cli, "name": name, "folder": home.project }),
    );
    assert_eq!(reply["status"], "success", "{reply}");
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then_some(pair[1].as_str()))
}

fn run_settings(args: &[String]) -> Value {
    let value = option(args, "--settings").expect("CLI receives run settings");
    let text = if value.starts_with('{') {
        value.to_owned()
    } else {
        std::fs::read_to_string(value).unwrap()
    };
    serde_json::from_str(&text).unwrap()
}

/// Read the CLI's actual overrides up to its option terminator.
fn overrides(args: &[String]) -> Vec<(&str, &str)> {
    let mut words = args.iter().map(String::as_str);
    let mut result = Vec::new();
    while let Some(word) = words.next() {
        let given = match word {
            "--" => break,
            "-c" | "--config" => words.next(),
            _ => word
                .strip_prefix("--config=")
                .or_else(|| word.strip_prefix("-c=").or_else(|| word.strip_prefix("-c"))),
        };
        if let Some(pair) = given.and_then(|value| value.split_once('=')) {
            result.push(pair);
        }
    }
    result
}

fn check_cli(home: &TestHome, cli: &str, args: &[String], env: &Value, agent: bool, yolo: bool) {
    let startup = agent && yolo;
    let has = |wanted: &str| args.iter().any(|arg| arg == wanted);
    let work = match cli {
        "claude" | "agy" => &["--dangerously-skip-permissions"][..],
        "codex" => &["--dangerously-bypass-approvals-and-sandbox"],
        "muse" => &["--disable-approval", "--disable-sandbox"],
        "opencode" => &["--auto"],
        _ => &[],
    };
    for &flag in work {
        assert_eq!(has(flag), yolo, "{cli} work flag {flag}");
    }
    let updater = match cli {
        "claude" => Some(("DISABLE_AUTOUPDATER", "1")),
        "agy" => Some(("AGY_CLI_DISABLE_AUTO_UPDATE", "true")),
        "muse" => Some(("MUSE_NO_AUTO_UPDATE", "1")),
        "opencode" => Some(("OPENCODE_DISABLE_AUTOUPDATE", "1")),
        _ => None,
    };
    if let Some((key, value)) = updater {
        assert_eq!(env[key].as_str(), agent.then_some(value), "{cli} {key}");
    }
    let folder = real(&home.project);
    let overrides = overrides(args);
    let config = |key| {
        overrides
            .iter()
            .rev()
            .find_map(|&(given, value)| (given == key).then_some(value))
    };
    match cli {
        "claude" => {
            let settings = run_settings(args);
            assert_eq!(option(args, "--allowedTools"), Some("mcp__facade"));
            assert_eq!(
                settings.get("sandbox"),
                yolo.then_some(&json!({ "enabled": false }))
            );
            assert_eq!(
                settings.get("skipDangerousModePermissionPrompt"),
                startup.then_some(&json!(true))
            );
        }
        "codex" => {
            assert_eq!(
                config("mcp_servers.facade.default_tools_approval_mode"),
                Some("\"approve\"")
            );
            let hook_command = if cfg!(windows) {
                "powershell.exe"
            } else {
                "session-start"
            };
            assert!(
                config("hooks").is_some_and(|hooks| hooks.contains(hook_command)
                    && hooks.contains(":session_start:0:0")
                    && hooks.contains("trusted_hash"))
            );
            let path = if cfg!(windows) {
                folder.to_ascii_lowercase()
            } else {
                folder
            };
            let trust = format!("{{ {} = {{ trust_level = \"trusted\" }} }}", json!(path));
            assert_eq!(config("projects"), startup.then_some(trust.as_str()));
            assert_eq!(config(UPDATE), startup.then_some("false"));
        }
        "agy" => {
            let settings = run_settings(args);
            assert_eq!(
                settings["permissions"]["allow"],
                json!(["mcp(facade_facade/*)"])
            );
            assert_eq!(option(args, "--mode"), yolo.then_some("accept-edits"));
            assert_eq!(
                settings.get("enableTerminalSandbox"),
                yolo.then_some(&json!(false))
            );
            assert_eq!(
                settings.get("trustedWorkspaces"),
                startup.then_some(&json!([folder]))
            );
        }
        "muse" => {
            assert_eq!(has("--trust-workspace"), startup);
            let server: Value = serde_json::from_str(config("mcpServers.facade").unwrap()).unwrap();
            assert_eq!(server["mode"], "optional");
            let hooks: Value = serde_json::from_str(config("hooks").unwrap()).unwrap();
            let approve = hooks["PermissionRequest"][0]["hooks"][0]["command"]
                .as_str()
                .expect("Muse receives Facade's approval hook");
            let command = if let Some(encoded) =
                approve.strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
            {
                let bytes = facade_base::base64::decode(encoded).unwrap();
                let words: Vec<_> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_le_bytes)
                    .collect();
                String::from_utf16(&words).unwrap()
            } else {
                approve.to_owned()
            };
            assert!(command.contains("approve") && command.contains("muse"));
        }
        "opencode" => {
            let settings: Value =
                serde_json::from_str(env["OPENCODE_CONFIG_CONTENT"].as_str().unwrap()).unwrap();
            assert_eq!(settings["permission"], json!({ "facade_*": "allow" }));
        }
        "pi" => {
            assert_eq!(has("--approve"), startup);
            assert_eq!(
                env["PI_SKIP_VERSION_CHECK"].as_str(),
                startup.then_some("1")
            );
            let extension = args
                .windows(2)
                .find_map(|pair| {
                    (pair[0] == "-e" && pair[1].ends_with("facade-pi.mjs")).then_some(&pair[1])
                })
                .expect("Pi gets Facade's MCP extension");
            let extension = std::fs::read_to_string(extension).unwrap();
            assert!(
                extension.contains("registerMcpServer(\"facade\",")
                    && extension.contains("\"exposure\":\"direct\"")
            );
        }
        _ => unreachable!(),
    }
}

fn exercise_starts(agent: bool) {
    let home = TestHome::new("launch-policy");
    let capture = Capture::new(&home);
    let caller = home.start_fake("caller");
    let mut tools = McpTestClient::open(&home, &caller.id);
    let clis: Value = CLIS
        .into_iter()
        .map(|cli| (cli.to_owned(), capture.entry()))
        .collect();
    for yolo in [true, false] {
        set_clis(&home, yolo, &clis);
        for cli in CLIS {
            let name = format!("{cli}-{yolo}");
            if agent {
                mcp_start(&home, &mut tools, cli, &name);
            } else {
                // The Shell invocation takes person policy even with an agent's identity in its env.
                let result = home
                    .command(&test_binaries().facade)
                    .env("FACADE_AGENT", &caller.id)
                    .args(["start", "-d", "--name", &name, cli])
                    .stdin(Stdio::null())
                    .output()
                    .unwrap();
                assert!(result.status.success(), "{name}: {}", stderr(&result));
            }
            let (args, env) = capture.read();
            let run = record(&home, &name);
            assert_eq!(run["yolo"], yolo);
            assert_eq!(run.get("creator").is_some(), agent);
            check_cli(&home, cli, &args, &env, agent, yolo);
            home.run_facade_ok(&["stop", &name]);
        }
    }
}

#[test]
fn shell_starts_apply_work_policy_and_leave_startup_to_the_person() {
    exercise_starts(false);
}

#[test]
fn mcp_starts_apply_updater_policy_in_both_yolo_modes_and_gate_startup() {
    exercise_starts(true);
}

#[test]
fn a_forwarded_mcp_start_keeps_agent_policy_and_uses_the_destination_yolo() {
    let source = TestHome::new("launch-source");
    let destination = TestHome::new("launch-destination");
    let capture = Capture::new(&destination);
    set_clis(&source, true, &json!({}));
    set_clis(&destination, false, &json!({ "claude": capture.entry() }));
    let caller = source.start_fake("caller");

    let mut destination_wire = connect(&destination);
    let welcome = destination.hello_result().unwrap();
    let id = welcome["machine_id"].as_str().unwrap();
    destination.run_facade_ok(&["machine", "rename", id, "launch-peer"]);
    install_machine_ssh(
        &[("launch-source", &source), ("launch-peer", &destination)],
        &test_binaries().facade,
    );
    source.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        destination.path.to_str().unwrap(),
        "launch-peer",
    ]);

    let mut tools = McpTestClient::open(&source, &caller.id);
    let reply = tools.call("start_agent", json!({
        "cli": "claude", "name": "forwarded", "machine": "launch-peer", "folder": destination.project,
    }));
    assert_eq!(reply["status"], "success", "{reply}");
    let (args, env) = capture.read();
    let run = destination_wire.call_ok("agent.inspect", json!({ "target": "forwarded" }));
    assert_eq!(
        run["agent"]["creator"],
        record(&source, "caller")["reference"]
    );
    assert_eq!(run["agent"]["yolo"], false);
    check_cli(&destination, "claude", &args, &env, true, false);
}

#[test]
fn a_managed_callers_environment_reuse_removes_its_generated_updater_switch() {
    let home = TestHome::new("launch-env-reuse");
    let capture = Capture::new(&home);
    let mut claude = capture.entry();
    claude["env"]["LAUNCH_QA_MARKER"] = json!("from-source");
    let mut custom = capture.entry();
    custom["type"] = json!("custom");
    custom["args"] = json!(["--trust-workspace", "native argument"]);
    set_clis(&home, false, &json!({ "claude": claude, "custom": custom }));

    let root = home.start_fake("root");
    let mut root_tools = McpTestClient::open(&home, &root.id);
    mcp_start(&home, &mut root_tools, "claude", "source");
    let (_, source_env) = capture.read();
    let source = record(&home, "source");
    let source_id = source["reference"]["agent_id"].as_str().unwrap();
    let mut source_tools = McpTestClient::open(&home, source_id);
    mcp_start(&home, &mut source_tools, "custom", "child");
    let (args, child_env) = capture.read();

    assert_eq!(args, ["--trust-workspace", "native argument"]);
    assert_eq!(child_env["LAUNCH_QA_MARKER"], "from-source");
    assert_eq!(source_env["DISABLE_AUTOUPDATER"], "1");
    assert!(child_env.get("DISABLE_AUTOUPDATER").is_none());
}

#[test]
fn shell_start_and_resume_from_a_managed_run_keep_only_explicit_updater_values() {
    let home = TestHome::new("launch-shell-environment");
    let capture = Capture::new(&home);
    let root = home.start_fake("root");
    let mut tools = McpTestClient::open(&home, &root.id);
    let mut differences = Vec::new();

    // Each row names the source CLI, its generated switch, and any explicit values set by
    // the source entry, destination start, and destination resume.
    for (name, cli, key, generated, prior, start_value, resume_value) in [
        (
            "claude",
            "claude",
            "DISABLE_AUTOUPDATER",
            "1",
            None,
            Some("0"),
            None,
        ),
        (
            "agy",
            "agy",
            "AGY_CLI_DISABLE_AUTO_UPDATE",
            "true",
            Some("false"),
            None,
            None,
        ),
        (
            "muse",
            "muse",
            "MUSE_NO_AUTO_UPDATE",
            "1",
            None,
            None,
            Some("0"),
        ),
        (
            "opencode",
            "opencode",
            "OPENCODE_DISABLE_AUTOUPDATE",
            "1",
            None,
            None,
            None,
        ),
        ("pi", "pi", "PI_SKIP_VERSION_CHECK", "1", None, None, None),
        (
            "matching",
            "claude",
            "DISABLE_AUTOUPDATER",
            "1",
            Some("1"),
            None,
            None,
        ),
    ] {
        let mut source = capture.entry();
        source["env"]["LAUNCH_QA_MARKER"] = json!(name);
        if let Some(prior) = prior {
            source["env"][key] = json!(prior);
        }
        let configure = |value: Option<&str>| {
            let mut destination = capture.entry();
            destination["env"]["FAKECLI_SESSION"] = json!(SESSION);
            if let Some(value) = value {
                destination["env"][key] = json!(value);
            }
            set_clis(&home, true, &json!({ (cli): source, "fake": destination }));
        };
        configure(None);
        let source_name = format!("source-{name}");
        mcp_start(&home, &mut tools, cli, &source_name);
        let (_, source_capture) = capture.read();
        assert_eq!(source_capture[key], generated, "{source_name}");
        let source_agent = record(&home, &source_name);
        let pid = source_agent["pid"].as_i64().unwrap() as i32;
        let source_env = facade_base::unix_process::environment(&process_identity(pid))
            .unwrap()
            .expect("the source CLI's environment");
        assert_eq!(
            real(Path::new(&source_env["FACADE_HOME"])),
            real(&home.path)
        );

        let person = format!("person-{name}");
        let mut check = |operation: &str, result: &Value, expected: Option<&str>| {
            assert_eq!(result["LAUNCH_QA_MARKER"], name, "{operation} from {name}");
            let actual = result[key].as_str();
            if actual != expected {
                differences.push(format!(
                    "{operation} from {name}: {key} was {actual:?}, expected {expected:?}"
                ));
            }
        };
        for (args, configured) in [
            (vec!["start", "-d", "--name", &person, "fake"], start_value),
            (vec!["resume", "-d", &person], resume_value),
        ] {
            let operation = args[0];
            configure(configured);
            let output = home
                .command(&test_binaries().facade)
                .envs(&source_env)
                .args(args)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{operation} from {name}: {}",
                stderr(&output)
            );
            let (args, result) = capture.read();
            check(operation, &result, configured.or(prior));
            if operation == "resume" {
                assert_eq!(option(&args, "--resume"), Some(SESSION));
            }
            assert!(wait_until(
                LOADED_TIMEOUT,
                || record(&home, &person)["session"] == SESSION
            ));
            home.run_facade_ok(&["stop", &person]);
        }

        if name == "matching" {
            let id = source_agent["reference"]["agent_id"].as_str().unwrap();
            let mut source_tools = McpTestClient::open(&home, id);
            mcp_start(&home, &mut source_tools, "fake", "matching-mcp-child");
            let (_, result) = capture.read();
            check("MCP start", &result, Some(generated));
        }
        home.run_facade_ok(&["stop", &source_name]);
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

const MODEL: &str = "gpt-5.6-luna";
const HUMAN_OVERRIDES: [&str; 10] = [
    "-c",
    "check_for_update_on_startup=true",
    "-cfoo=1",
    "-ccheck_for_update_on_startup=true",
    "--config",
    "check_for_update_on_startup=true",
    "--config=bar=2",
    "--config=check_for_update_on_startup=true",
    "-c=check_for_update_on_startup=true",
    "-c=baz=3",
];

#[test]
fn codex_preserves_explicit_update_options_except_under_agent_yolo() {
    let home = TestHome::new("codex-launch-options");
    let capture = Capture::new(&home);
    let mut codex = capture.entry();
    codex["args"] = json!(HUMAN_OVERRIDES);
    codex["model"] = json!(MODEL);
    let caller = home.start_fake("caller");
    let mut tools = McpTestClient::open(&home, &caller.id);
    let config_file = home.user_home().join(".codex/config.toml");
    let written = format!("model = \"{MODEL}\"\ncheck_for_update_on_startup = true\n");
    std::fs::write(&config_file, &written).unwrap();

    for (name, yolo) in [
        ("agent-off", false),
        ("person-on", true),
        ("agent-on", true),
    ] {
        set_clis(&home, yolo, &json!({ "codex": codex }));
        if name == "person-on" {
            home.run_facade_ok(&[
                "start",
                "-d",
                "--name",
                name,
                "codex",
                "--",
                "--config=check_for_update_on_startup=false",
            ]);
        } else {
            mcp_start(&home, &mut tools, "codex", name);
        }
        let (argv, _) = capture.read();
        assert_eq!(option(&argv, "--model"), Some(MODEL));
        let overrides = overrides(&argv);
        let untouched: Vec<_> = overrides
            .iter()
            .copied()
            .filter(|(key, _)| matches!(*key, "foo" | "bar" | "baz"))
            .collect();
        assert_eq!(untouched, [("foo", "1"), ("bar", "2"), ("baz", "3")]);
        let updates: Vec<_> = overrides
            .iter()
            .filter_map(|&(key, value)| (key == UPDATE).then_some(value))
            .collect();
        let migration = overrides.iter().find_map(|&(key, value)| {
            (key == "notice.model_migrations" || key.starts_with("notice.model_migrations."))
                .then_some((key, value))
        });
        if name == "agent-on" {
            assert_eq!(
                updates.last().copied(),
                Some("false"),
                "agent YOLO takes precedence"
            );
            assert!(
                overrides.iter().any(|&(key, value)| {
                    (key == "notice.model_migrations"
                        && value
                            .split_whitespace()
                            .collect::<String>()
                            .contains(&format!("\"{MODEL}\"=\"gpt-6-luna\"")))
                        || (key.starts_with("notice.model_migrations.")
                            && key.contains(MODEL)
                            && value == "\"gpt-6-luna\"")
                }),
                "Codex receives its model migration acknowledgement: {migration:?}"
            );
        } else {
            assert_eq!(updates, ["true"; 5], "{name} honors all explicit spellings");
            assert!(
                migration.is_none(),
                "{name} leaves the native notice enabled"
            );
        }
        if name == "person-on" {
            let delimiter = argv.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(
                &argv[delimiter..],
                ["--", "--config=check_for_update_on_startup=false"]
            );
        }
        home.run_facade_ok(&["stop", name]);
    }
    assert_eq!(std::fs::read_to_string(config_file).unwrap(), written);

    codex["args"] = json!(["--config=projects={}"]);
    set_clis(&home, true, &json!({ "codex": codex }));
    let rejected = tools.call("start_agent", json!({ "cli": "codex", "name": "reserved" }));
    assert_eq!(rejected["reason"], "invalid_settings", "{rejected}");
    assert!(
        rejected["message"].as_str().unwrap().contains("projects"),
        "{rejected}"
    );
}

#[test]
fn reopening_an_agent_started_by_mcp_uses_person_policy_and_keeps_its_creator() {
    let home = TestHome::new("launch-resume-agent");
    let capture = Capture::new(&home);
    set_clis(&home, true, &json!({ "claude": capture.entry() }));
    let caller = home.start_fake("caller");
    let mut tools = McpTestClient::open(&home, &caller.id);
    mcp_start(&home, &mut tools, "claude", "worker");
    let (first_args, _) = capture.read();
    let first_settings = run_settings(&first_args);
    let id = record(&home, "worker")["reference"]["agent_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = facade_rules::run_folder(&home.path.join("core/runs"), &id).unwrap();
    let mut hook = home
        .command(&test_binaries().facade)
        .args(["hook", "session-start"])
        .arg(run.join("session"))
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    write!(
        hook.stdin.take().unwrap(),
        "{}",
        json!({
            "hook_event_name": "SessionStart", "session_id": SESSION,
        })
    )
    .unwrap();
    let reported = hook.wait_with_output().unwrap();
    assert!(reported.status.success(), "{}", stderr(&reported));
    assert!(wait_until(
        LOADED_TIMEOUT,
        || record(&home, "worker")["session"] == SESSION
    ));
    let first = record(&home, "worker");
    home.run_facade_ok(&["stop", "worker"]);

    let output = home
        .command(&test_binaries().facade)
        .env("DISABLE_AUTOUPDATER", "0")
        .args(["resume", "-d", "worker"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let (args, env) = capture.read();
    let resumed = record(&home, "worker");

    assert_eq!(first["creator"], record(&home, "caller")["reference"]);
    assert_eq!(resumed["reference"], first["reference"]);
    assert_eq!(resumed["creator"], first["creator"]);
    assert_eq!(resumed["session"], SESSION);
    assert_eq!(option(&args, "--resume"), Some(SESSION));
    assert!(
        args.iter()
            .any(|word| word == "--dangerously-skip-permissions")
    );
    assert_eq!(option(&args, "--allowedTools"), Some("mcp__facade"));
    let run = run_settings(&args);
    assert_eq!(run["sandbox"], json!({ "enabled": false }));
    assert!(run.get("skipDangerousModePermissionPrompt").is_none());
    assert_eq!(env["DISABLE_AUTOUPDATER"], "0");
    assert_eq!(first_settings["skipDangerousModePermissionPrompt"], true);
}

#[test]
fn opening_a_native_saved_session_as_a_new_agent_uses_person_policy() {
    let home = TestHome::new("launch-resume-native");
    let capture = Capture::new(&home);
    set_clis(&home, true, &json!({ "codex": capture.entry() }));
    let sessions = home.user_home().join(".codex/sessions/2026/11/01");
    std::fs::create_dir_all(&sessions).unwrap();
    let history = json!({
        "type": "session_meta", "payload": { "id": SESSION, "cwd": real(&home.project) },
    });
    std::fs::write(
        sessions.join(format!("rollout-{SESSION}.jsonl")),
        format!("{history}\n"),
    )
    .unwrap();

    let env: BTreeMap<_, _> = home.isolating_env().into_iter().collect();
    let resumed = connect(&home).call_ok("agent.resume", json!({
        "target": { "kind": "selector", "selector": format!("codex:{SESSION}"), "folder": home.project },
        "env": env, "size": { "cols": 80, "rows": 24 },
    }));
    let (args, env) = capture.read();
    assert_eq!(resumed["from_saved_session"], true, "{resumed}");
    assert_eq!(resumed["agent"]["session"], SESSION);
    assert!(resumed["agent"].get("creator").is_none());
    assert_eq!(&args[..2], ["resume", SESSION]);
    check_cli(&home, "codex", &args, &env, false, true);

    // Native resume composition must also accept an explicit update decision from the entry.
    let address = resumed["agent"]["address"].as_str().unwrap();
    home.run_facade_ok(&["stop", address]);
    home.remove_agent(address);
    let mut codex = capture.entry();
    codex["args"] = json!(HUMAN_OVERRIDES);
    set_clis(&home, true, &json!({ "codex": codex }));
    home.run_facade_ok(&["resume", "-d", &format!("codex:{SESSION}")]);
    let (args, _) = capture.read();
    let updates: Vec<_> = overrides(&args)
        .into_iter()
        .filter_map(|(key, value)| (key == UPDATE).then_some(value))
        .collect();
    assert_eq!(updates, ["true"; 5]);
}
