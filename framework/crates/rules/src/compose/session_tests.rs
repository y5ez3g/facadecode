use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;
use crate::find;
use crate::shell_word;
use facade_base::system::{SYSTEM, System};

/// OpenCode's CLI configuration for one start, read after its configuration files.
const OPENCODE_CLI_CONFIG: &str = "OPENCODE_CLI_CONFIG_CONTENT";

const HOOK: &str = "'/opt/facade' hook session-start '/home/.facade/framework/runs/a3/1f/session'";

/// `unix` on Unix, `windows` on Windows.
fn by_system(unix: &str, windows: &str) -> String {
    match SYSTEM {
        System::Unix => unix,
        System::Windows => windows,
    }
    .to_string()
}

/// The session-start hook of `cli`'s runs in these tests, for the shell `cli` runs it with.
fn hook(cli: &str) -> String {
    if SYSTEM == System::Windows && cli != "claude" {
        crate::formats::encoded_powershell(
            "& '/opt/facade' 'hook' 'session-start' '/home/.facade/framework/runs/a3/1f/session'; exit $LASTEXITCODE",
        )
    } else {
        HOOK.to_string()
    }
}

/// `name` in the run folder of these tests, as the system joins it.
fn in_run(name: &str) -> String {
    Path::new("/home/.facade/framework/runs/a3/1f")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// Where the runs of these tests report their session: their hook runs [`HOOK`].
fn report() -> SessionReport<'static> {
    SessionReport {
        facade: "/opt/facade",
        file: Path::new("/home/.facade/framework/runs/a3/1f/session"),
        cwd: Path::new("/nowhere/project"),
    }
}

fn words(line: &[&str]) -> Vec<String> {
    line.iter().map(|word| word.to_string()).collect()
}

fn rule(cli: &str) -> &'static Rule {
    find(cli).unwrap().unwrap()
}

fn settings(launch: &CommandLine) -> Value {
    passed_settings(launch)
}

#[test]
fn a_start_runs_the_program_the_rule_s_arguments_the_hook_then_the_person_s_words() {
    let launch = start_managed_launch_command(
        rule("codex"),
        &words(&["--model", "gpt-6", "fix it"]),
        None,
        None,
        &BTreeMap::new(),
        PERSON,
    );
    let launched = CommandLine {
        command: words(&["codex", "--no-daemon", "--model", "gpt-6", "fix it"]),
        env: Vec::new(),
        launch_env: BTreeMap::new(),
        captures: false,
        files: Vec::new(),
        config_links: Vec::new(),
        plugin: Vec::new(),
        workspace_file: None,
        tools: Tools::NotInjected,
        uses_run_credential: false,
    };
    assert_eq!(launch, launched);
    let launch = start_managed_launch_command(
        rule("fake"),
        &words(&["--resume-like"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert_eq!(launch.command, words(&["facade-fakecli", "--resume-like"]));
    assert_eq!(
        (launch.env, launch.captures),
        (
            vec![("FAKECLI_SESSION_HOOK".to_string(), hook("fake"))],
            true
        )
    );
    assert_eq!(
        HOOK,
        "'/opt/facade' hook session-start '/home/.facade/framework/runs/a3/1f/session'"
    );
    // Without Facade's tools, Muse Code and Antigravity still report their session, through the
    // settings the tools go in.
    let muse = start_managed_launch_command(
        rule("muse"),
        &words(&["x"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    let hooks = json!({
        "SessionStart": [{ "hooks": [{ "type": "command", "command": hook("muse"), "timeout": 5 }] }],
    });
    assert_eq!(
        (muse.command, muse.captures),
        (words(&["muse", "-c", &format!("hooks={hooks}"), "x"]), true)
    );
    let agy = start_managed_launch_command(
        rule("agy"),
        &words(&["x"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    let title = by_system(
        "'/opt/facade' hook title '/home/.facade/framework/runs/a3/1f/session'",
        &crate::formats::encoded_powershell(
            "& '/opt/facade' 'hook' 'title' '/home/.facade/framework/runs/a3/1f/session'; exit $LASTEXITCODE",
        ),
    );
    let settings = json!({ "title": { "type": "command", "enabled": true, "command": title } });
    assert_eq!(self::settings(&agy), settings);
    assert_eq!(
        (agy.command, agy.captures),
        (
            words(&["agy", "--settings", &in_run("settings.json"), "x"]),
            true
        )
    );
}

#[test]
fn a_resume_names_the_session_first_and_keeps_no_words_of_the_earlier_start() {
    let session = "86da4482-2bae-4a45-b193-a5664c19826a";
    let launch = resume_managed_launch_command(
        rule("codex"),
        session,
        &[],
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    )
    .unwrap();
    assert_eq!(
        &launch.command[..4],
        words(&["codex", "resume", session, "--no-daemon"]).as_slice()
    );
    assert_eq!(
        (
            launch.command[4].as_str(),
            launch.command.len(),
            launch.captures
        ),
        ("-c", 6, true)
    );
    let launch = resume_managed_launch_command(
        rule("claude"),
        session,
        &[],
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    )
    .unwrap();
    assert_eq!(
        &launch.command[..3],
        words(&["claude", "--resume", session]).as_slice()
    );
    assert_eq!(
        settings(&launch)["hooks"]["SessionStart"][0]["hooks"][0]["command"],
        HOOK
    );
    let launch = resume_managed_launch_command(
        rule("pi"),
        session,
        &[],
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    )
    .unwrap();
    assert_eq!(
        launch.command,
        words(&[
            "pi",
            "--session",
            session,
            "-e",
            &in_run("facade-session.mjs")
        ])
    );
    let opencode = "ses_2b9cfe1a7dffRm6kVzQe7xXn3d";
    let home = home_environment(Path::new(&by_system("/nowhere", r"C:\nowhere")), &[]);
    let launch = resume_managed_launch_command(
        rule("opencode"),
        opencode,
        &[],
        Some(&report()),
        None,
        &home,
        PERSON,
    )
    .unwrap();
    assert_eq!(
        launch.command,
        words(&["opencode", "--session", opencode, "--standalone"])
    );
    assert!(launch.captures);
}

/// A launch's folder that holds dots, as every `.worktrees` folder does, and quotes.
const YOLO_FOLDER: &str = "/work/app.worktrees/it's \"quoted\"";

/// Each CLI's work arguments and settings when the person launches with YOLO on.
fn yolo_of(cli: &str) -> (Vec<String>, Option<Value>) {
    match cli {
        "claude" => (
            words(&["--dangerously-skip-permissions"]),
            Some(json!({ "sandbox": { "enabled": false } })),
        ),
        "codex" => (words(&["--dangerously-bypass-approvals-and-sandbox"]), None),
        "agy" => (
            words(&["--mode", "accept-edits", "--dangerously-skip-permissions"]),
            Some(json!({ "enableTerminalSandbox": false })),
        ),
        "muse" => (words(&["--disable-approval", "--disable-sandbox"]), None),
        "opencode" => (words(&["--auto"]), None),
        _ => (Vec::new(), None),
    }
}

/// `on`, a launch with YOLO on, less what YOLO added at `at`: its arguments, which must be
/// `added`, and the settings it added to `off`'s, which must be `settings`.
fn without_yolo(
    mut on: CommandLine,
    at: usize,
    off: &CommandLine,
    (added, settings): (Vec<String>, Option<Value>),
) -> CommandLine {
    assert_eq!(
        on.command.drain(at..at + added.len()).collect::<Vec<_>>(),
        added,
        "{:?}",
        on.command
    );
    if let Some(settings) = settings {
        let mut expected = self::settings(off);
        crate::formats::merge_settings(&mut expected, &settings);
        assert_eq!(self::settings(&on), expected);
        let place = on
            .command
            .iter()
            .position(|word| word == "--settings")
            .unwrap();
        on.command[place + 1] = off.command[place + 1].clone();
        on.files = off.files.clone();
    }
    on
}

/// A person start or resume with YOLO adds the rule's work arguments and settings.
#[test]
fn person_yolo_adds_each_cli_s_work_arguments_and_settings() {
    let folder = Path::new(YOLO_FOLDER);
    let session = "019a2b3c-4d5e-4f60-8172-839405a6b7c8";
    for cli in ["claude", "codex", "agy", "muse", "opencode", "pi"] {
        let rule = rule(cli);
        let at = 1 + rule.launch.args.len();
        let off = start_managed_launch_command(
            rule,
            &[],
            Some(&report()),
            None,
            &BTreeMap::new(),
            PERSON,
        );
        let on = start_managed_launch_command(
            rule,
            &[],
            Some(&report()),
            None,
            &BTreeMap::new(),
            LaunchPolicy {
                yolo: Some(folder),
                ..PERSON
            },
        );
        assert_eq!(without_yolo(on, at, &off, yolo_of(cli)), off, "{cli}");
        let at = 1 + rule.resume_args(session).unwrap().len() + rule.launch.args.len();
        let off = resume_managed_launch_command(
            rule,
            session,
            &[],
            Some(&report()),
            None,
            &BTreeMap::new(),
            PERSON,
        )
        .unwrap();
        let on = resume_managed_launch_command(
            rule,
            session,
            &[],
            Some(&report()),
            None,
            &BTreeMap::new(),
            LaunchPolicy {
                yolo: Some(folder),
                ..PERSON
            },
        )
        .unwrap();
        assert_eq!(
            without_yolo(on, at, &off, yolo_of(cli)),
            off,
            "{cli} resumed"
        );
    }
}

/// YOLO's run settings join the person's own: Claude Code's `--settings` of theirs keeps its
/// sandbox's other settings, its own turned off, and Antigravity's trusted folders are theirs,
/// from their settings file, and the launch's, with its terminal sandbox off where they turned
/// it on.
#[test]
fn yolo_s_run_settings_join_the_person_s_own() {
    let folder = Path::new(YOLO_FOLDER);
    let theirs = words(&[
        "--settings",
        r#"{"sandbox": {"enabled": true, "excludedCommands": ["git"]}, "model": "opus"}"#,
    ]);
    let claude = start_managed_launch_command(
        rule("claude"),
        &theirs,
        Some(&report()),
        None,
        &BTreeMap::new(),
        LaunchPolicy {
            origin: LaunchOrigin::Agent,
            yolo: Some(folder),
        },
    );
    let given = settings(&claude);
    assert_eq!(
        (&given["sandbox"], &given["model"]),
        (
            &json!({ "enabled": false, "excludedCommands": ["git"] }),
            &json!("opus")
        ),
        "{given}"
    );
    assert_eq!(given["skipDangerousModePermissionPrompt"], true);
    let home = crate::test_folder::TestFolder::new("rules-yolosettings");
    let saved = home.join(".gemini/antigravity-cli");
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::write(
        saved.join("settings.json"),
        r#"{ "trustedWorkspaces": ["/mine"], "enableTerminalSandbox": true, "theme": "dark" }"#,
    )
    .unwrap();
    let agy = start_managed_launch_command(
        rule("agy"),
        &[],
        Some(&report()),
        None,
        &home_environment(&home, &[]),
        LaunchPolicy {
            origin: LaunchOrigin::Agent,
            yolo: Some(folder),
        },
    );
    assert_eq!(
        settings(&agy)["trustedWorkspaces"],
        json!(["/mine", YOLO_FOLDER])
    );
    assert_eq!(settings(&agy)["enableTerminalSandbox"], false);
    assert!(
        settings(&agy).get("theme").is_none(),
        "only what YOLO adds to goes in"
    );
}

/// An environment whose home is `home`, with `more` set.
fn home_environment(home: &Path, more: &[(&str, &str)]) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = more
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let home = home.to_string_lossy().into_owned();
    environment.insert("HOME".into(), home.clone());
    environment.insert("USERPROFILE".into(), home);
    environment
}

/// The CLI configuration a launch gives OpenCode, if any.
fn opencode_overlay(launch: &CommandLine) -> Option<Value> {
    launch
        .env
        .iter()
        .find(|(name, _)| name == OPENCODE_CLI_CONFIG)
        .map(|(_, text)| serde_json::from_str(text).unwrap())
}

/// OpenCode reports its session through a plugin of the run's, named last in its CLI
/// configuration for the launch, after the plugins of the person's own configuration: their
/// variable's, else their `cli.json`'s, else their older `tui.json`'s, in the `opencode` folder
/// of their `XDG_CONFIG_HOME` where that is a whole path, else of `~/.config`.
#[test]
fn opencode_reports_its_session_through_a_plugin_after_the_person_s_own() {
    let home = crate::test_folder::TestFolder::new("rules-opencodesession");
    let config = home.join(".config/opencode");
    std::fs::create_dir_all(&config).unwrap();
    let ours = json!(in_run("facade-session"));
    let disabled_tabs = json!({ "enabled": false });
    let disabled_tabs_with_mode = json!({ "enabled": false, "mode": "off" });
    let configuration = |environment: &BTreeMap<String, String>| {
        let launch = start_managed_launch_command(
            rule("opencode"),
            &words(&["x"]),
            Some(&report()),
            None,
            environment,
            PERSON,
        );
        opencode_overlay(&launch).map(|overlay| {
            (
                launch.captures,
                overlay["plugins"].clone(),
                overlay["tabs"].clone(),
            )
        })
    };
    assert_eq!(
        configuration(&home_environment(&home, &[])),
        Some((true, json!([ours]), disabled_tabs.clone())),
        "no configuration of the person's"
    );
    std::fs::write(
        config.join("tui.json"),
        r#"{"plugin": [["pkg", {"a": 1}], "other"], "plugin_enabled": {"p": true, "q": false}, "tabs": {"mode": "workspace"}}"#,
    )
    .unwrap();
    let legacy = json!([{ "package": "pkg", "options": { "a": 1 } }, "other", "p", "-q", ours]);
    assert_eq!(
        configuration(&home_environment(&home, &[])),
        Some((true, legacy, disabled_tabs_with_mode.clone())),
        "the older tui.json, as OpenCode reads it"
    );
    std::fs::write(
        config.join("cli.json"),
        "// theirs\n{\"plugins\": [\"theirs\"], \"tabs\": {\"enabled\": true},}",
    )
    .unwrap();
    assert_eq!(
        configuration(&home_environment(&home, &[])),
        Some((true, json!(["theirs", ours]), disabled_tabs.clone())),
        "cli.json goes before tui.json"
    );
    let elsewhere = home.join("settings");
    std::fs::create_dir_all(elsewhere.join("opencode")).unwrap();
    std::fs::write(
        elsewhere.join("opencode/cli.json"),
        r#"{"plugins": ["elsewhere"], "tabs": {"mode": "workspace"}}"#,
    )
    .unwrap();
    let xdg = home_environment(&home, &[("XDG_CONFIG_HOME", elsewhere.to_str().unwrap())]);
    assert_eq!(
        configuration(&xdg),
        Some((
            true,
            json!(["elsewhere", ours]),
            disabled_tabs_with_mode.clone()
        )),
        "their XDG_CONFIG_HOME's"
    );
    let relative = home_environment(&home, &[("XDG_CONFIG_HOME", "settings")]);
    assert_eq!(
        configuration(&relative),
        Some((true, json!(["theirs", ours]), disabled_tabs)),
        "a relative XDG_CONFIG_HOME is not used"
    );
    let variable = home_environment(
        &home,
        &[(
            OPENCODE_CLI_CONFIG,
            r#"{"plugins": ["mine"], "theme": "dark", "tabs": {"enabled": true, "mode": "workspace"}}"#,
        )],
    );
    let launch = start_managed_launch_command(
        rule("opencode"),
        &[],
        Some(&report()),
        None,
        &variable,
        PERSON,
    );
    assert_eq!(
        opencode_overlay(&launch),
        Some(
            json!({ "plugins": ["mine", ours], "theme": "dark", "tabs": disabled_tabs_with_mode })
        ),
        "the variable goes first"
    );
    let (name, package) = &launch.files[0];
    assert_eq!(
        (
            name.as_str(),
            serde_json::from_str::<Value>(package).unwrap()["exports"].clone()
        ),
        (
            "facade-session/package.json",
            json!({ "./tui": "./tui.mjs" })
        )
    );
    assert!(
        launch.files[1]
            .1
            .contains(r#"const file = "/home/.facade/framework/runs/a3/1f/session";"#),
        "{}",
        launch.files[1].1
    );
    // Facade's plugin comes out of the environment a child would start with; the person's stay.
    let mut child: BTreeMap<String, String> = launch.env.iter().cloned().collect();
    rule("opencode").remove_wiring_environment(&mut child);
    assert_eq!(
        serde_json::from_str::<Value>(&child[OPENCODE_CLI_CONFIG]).unwrap(),
        json!({ "plugins": ["mine"], "theme": "dark", "tabs": disabled_tabs_with_mode })
    );
    for (file, text) in [
        ("cli.json", "{not json"),
        ("cli.json", r#"{"plugins": "one"}"#),
    ] {
        std::fs::write(config.join(file), text).unwrap();
        let launch = start_managed_launch_command(
            rule("opencode"),
            &words(&["x"]),
            Some(&report()),
            None,
            &home_environment(&home, &[]),
            PERSON,
        );
        assert!(
            !launch.captures && opencode_overlay(&launch).is_none(),
            "{text}: the person's configuration stays as it is"
        );
    }
}

#[test]
fn pi_reports_its_session_through_an_extension_of_the_run() {
    let launch = start_managed_launch_command(
        rule("pi"),
        &words(&["--model", "m"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert_eq!(
        launch.command,
        words(&["pi", "-e", &in_run("facade-session.mjs"), "--model", "m"])
    );
    let (name, text) = &launch.files[0];
    assert_eq!(name, "facade-session.mjs");
    assert!(
        text.contains(r#"const file = "/home/.facade/framework/runs/a3/1f/session";"#)
            && text.contains("pi.on('session_start'"),
        "{text}"
    );
}

#[test]
fn qoder_reports_the_session_at_start_and_on_a_submitted_prompt() {
    let own = json!({"hooks": {
        "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "mine" }] }]
    }})
    .to_string();
    let words = words(&["--settings", &own]);
    let session = "86da4482-2bae-4a45-b193-a5664c19826a";
    let run = report();
    let start = start_managed_launch_command(
        rule("qoder"),
        &words,
        Some(&run),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    let resume = resume_managed_launch_command(
        rule("qoder"),
        session,
        &words,
        Some(&run),
        None,
        &BTreeMap::new(),
        PERSON,
    )
    .unwrap();
    assert_eq!(resume.command[..3], ["qoder", "--resume", session]);
    for launch in [start, resume] {
        assert!(launch.captures);
        let hooks = &settings(&launch)["hooks"];
        let file = run.file.to_str().unwrap();
        let start = &hooks["SessionStart"][0]["hooks"][0];
        assert_eq!(start["command"], run.facade);
        assert_eq!(start["args"], json!(["hook", "session-start", file]));
        let submit = &hooks["UserPromptSubmit"];
        assert_eq!(submit[0]["hooks"][0]["command"], "mine");
        let capture = &submit[1]["hooks"][0];
        assert_eq!(capture["command"], run.facade);
        assert_eq!(
            capture["args"],
            json!(["hook", "session-prompt", file, "qoder"])
        );
    }
}

#[test]
fn claude_gets_a_session_start_hook_beside_the_person_s_own_settings() {
    let launch = start_managed_launch_command(
        rule("claude"),
        &words(&["--model", "opus"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert_eq!(
        launch.command[..3],
        words(&["claude", "--settings", &launch.command[2]])
    );
    assert_eq!(launch.command[3..], words(&["--model", "opus"]));
    assert_eq!(
        settings(&launch),
        json!({
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": HOOK }] }],
            },
        })
    );
    assert!(launch.captures && launch.env.is_empty());
    // The person's own settings keep their hooks and other keys; Facade's group comes last.
    let own = r#"{"model":"opus","hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"mine"}]}],"Stop":[]}}"#;
    for given in [
        words(&["--settings", own, "go"]),
        words(&[&format!("--settings={own}"), "go"]),
    ] {
        let launch = start_managed_launch_command(
            rule("claude"),
            &given,
            Some(&report()),
            None,
            &BTreeMap::new(),
            PERSON,
        );
        let merged = settings(&launch);
        assert_eq!(merged["model"], "opus");
        assert_eq!(merged["hooks"]["Stop"], json!([]));
        let groups = merged["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(
            groups[0]["hooks"][0]["command"], "mine",
            "the person's group stays first"
        );
        assert_eq!(groups[1]["hooks"][0]["command"], HOOK);
        assert_eq!(
            launch
                .command
                .iter()
                .filter(|word| word.contains("--settings"))
                .count(),
            1,
            "one --settings goes to Claude"
        );
        assert_eq!(launch.command.last().unwrap(), "go");
    }
}

#[test]
fn claude_settings_facade_cannot_read_start_unchanged_without_a_hook() {
    for given in [
        words(&["--settings", "/Users/me/work.json"]),
        words(&["--settings", "{\"hooks\": []}"]),
        words(&["--settings", "{}", "--settings", "{}"]),
        words(&["--settings"]),
    ] {
        let launch = start_managed_launch_command(
            rule("claude"),
            &given,
            Some(&report()),
            None,
            &BTreeMap::new(),
            PERSON,
        );
        assert!(!launch.captures, "{given:?}");
        assert_eq!(
            launch.command[1..],
            given[..],
            "the person's words stay as they were"
        );
    }
    let after_options = words(&["--", "--settings", "{}"]);
    let launch = start_managed_launch_command(
        rule("claude"),
        &after_options,
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert!(
        launch.captures && launch.command.ends_with(&after_options),
        "words after -- are not options"
    );
}

/// Codex's own hash of a hook definition, written out by hand.
fn trusted(hook: &str) -> String {
    let definition = format!(
        r#"{{"event_name":"session_start","hooks":[{{"async":false,"command":{},"timeout":5,"type":"command"}}]}}"#,
        json!(hook)
    );
    format!(
        "sha256:{}",
        Sha256::digest(definition.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn codex_table(launch: &CommandLine) -> toml::Table {
    let at = launch
        .command
        .iter()
        .position(|word| word.starts_with("hooks="))
        .expect("a hooks override");
    assert_eq!(launch.command[at - 1], "-c");
    toml::from_str::<toml::Table>(&launch.command[at].replacen("hooks=", "hooks = ", 1))
        .unwrap()["hooks"]
        .as_table()
        .unwrap()
        .clone()
}

#[test]
fn codex_trusts_its_session_start_hook_by_the_hash_at_its_group_s_place() {
    let launch = start_managed_launch_command(
        rule("codex"),
        &words(&["--model", "gpt-6"]),
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert_eq!(launch.command[..2], words(&["codex", "--no-daemon"]));
    assert_eq!(launch.command[4..], words(&["--model", "gpt-6"]));
    let hooks = codex_table(&launch);
    assert_eq!(
        hooks.keys().collect::<Vec<_>>(),
        ["SessionStart", "state"],
        "only a session-start hook is added"
    );
    let group = &hooks["SessionStart"].as_array().unwrap()[0]["hooks"][0];
    assert_eq!(
        (
            group["command"].as_str(),
            group["timeout"].as_integer(),
            group["type"].as_str()
        ),
        (Some(hook("codex").as_str()), Some(5), Some("command"))
    );
    let key = by_system(
        "/<session-flags>/config.toml:session_start:0:0",
        r"C:\<session-flags>\config.toml:session_start:0:0",
    );
    let trust = &hooks["state"][&key];
    assert_eq!(
        (trust["enabled"].as_bool(), trust["trusted_hash"].as_str()),
        (Some(true), Some(trusted(&hook("codex")).as_str()))
    );
}

#[test]
fn codex_merges_the_person_s_hook_overrides_and_keeps_every_other_word_in_order() {
    let given = words(&[
        "-c",
        "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"mine\"}]}]",
        "--model",
        "gpt-6",
        "--config=hooks.Stop=[{hooks=[{type=\"command\",command=\"stop\"}]}]",
        "-chooks.state.\"x\"=1",
        "-c",
        "model_reasoning_effort=\"high\"",
        "--",
        "-c",
        "hooks={}",
    ]);
    let launch = start_managed_launch_command(
        rule("codex"),
        &given,
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert!(
        !launch.captures,
        "a quoted key is not read, so nothing is taken"
    );
    assert_eq!(launch.command[2..], given[..]);
    let given: Vec<String> = given
        .into_iter()
        .filter(|word| !word.contains("\"x\""))
        .collect();
    let launch = start_managed_launch_command(
        rule("codex"),
        &given,
        Some(&report()),
        None,
        &BTreeMap::new(),
        PERSON,
    );
    assert!(launch.captures);
    assert_eq!(
        launch.command[4..],
        words(&[
            "--model",
            "gpt-6",
            "-c",
            "model_reasoning_effort=\"high\"",
            "--",
            "-c",
            "hooks={}"
        ])
    );
    let hooks = codex_table(&launch);
    let groups = hooks["SessionStart"].as_array().unwrap();
    assert_eq!(
        groups[0]["hooks"][0]["command"].as_str(),
        Some("mine"),
        "the person's group stays first"
    );
    assert_eq!(
        groups[1]["hooks"][0]["command"].as_str(),
        Some(hook("codex").as_str())
    );
    assert_eq!(
        hooks["Stop"].as_array().unwrap()[0]["hooks"][0]["command"].as_str(),
        Some("stop")
    );
    let key = by_system(
        "/<session-flags>/config.toml:session_start:1:0",
        r"C:\<session-flags>\config.toml:session_start:1:0",
    );
    let trust = &hooks["state"][&key];
    assert_eq!(
        trust["trusted_hash"].as_str(),
        Some(trusted(&hook("codex")).as_str()),
        "Facade's group is trusted at its own place"
    );
    assert!(
        hooks["state"]
            .get(by_system(
                "/<session-flags>/config.toml:session_start:0:0",
                r"C:\<session-flags>\config.toml:session_start:0:0",
            ))
            .is_none(),
        "the person's group is not trusted by Facade"
    );
}

#[test]
fn codex_hook_settings_facade_cannot_read_start_unchanged_without_a_hook() {
    for given in [
        words(&["-c", "hooks=[1]"]),
        words(&["-c", "hooks.SessionStart={a=1}"]),
        words(&["-c", "hooks.SessionStart=[{"]),
        words(&["-c", "hooks"]),
        words(&["-c", "hooks.at=1979-05-27T07:32:00Z"]),
        words(&["-c"]),
    ] {
        let launch = start_managed_launch_command(
            rule("codex"),
            &given,
            Some(&report()),
            None,
            &BTreeMap::new(),
            PERSON,
        );
        assert!(!launch.captures, "{given:?}");
        assert_eq!(
            launch.command[2..],
            given[..],
            "the person's words stay as they were"
        );
    }
}

#[test]
fn a_hook_command_s_text_stays_one_word_and_one_toml_string() {
    assert_eq!(shell_word("/a b/it's"), "'/a b/it'\\''s'");
    let report = SessionReport {
        facade: "/x\\\"y\n\u{1}",
        file: Path::new("/s"),
        cwd: Path::new("/"),
    };
    // This path exercises quoting for POSIX hooks.
    if SYSTEM == System::Windows {
        return;
    }
    let hooks = codex_table(&start_managed_launch_command(
        rule("codex"),
        &[],
        Some(&report),
        None,
        &BTreeMap::new(),
        PERSON,
    ));
    assert_eq!(
        hooks["SessionStart"][0]["hooks"][0]["command"].as_str(),
        Some(format!("{} hook session-start '/s'", shell_word(report.facade)).as_str())
    );
    assert_eq!(
        crate::formats::inline_toml(&toml::Value::Float(1.0)).unwrap(),
        "1.0",
        "a float stays a float"
    );
}
