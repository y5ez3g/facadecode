use std::path::PathBuf;

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

use super::*;
use crate::formats::{encoded_powershell, encoded_powershell_words, shell_words};
use facade_base::system::{SYSTEM, System};

/// The session-start hook of the runs of these tests.
const HOOK: &str = "'/opt/facade' hook session-start '/home/.facade/core/runs/a3/1f/session'";

/// Antigravity's title command for the runs of these tests, which reports their session.
const TITLE: &str = "'/opt/facade' hook title '/home/.facade/core/runs/a3/1f/session'";

/// `unix` on Unix, `windows` on Windows.
fn by_system(unix: &str, windows: &str) -> String {
    match SYSTEM {
        System::Unix => unix,
        System::Windows => windows,
    }
    .to_string()
}

/// [`HOOK`] for the shell `cli` runs it with.
fn hook_of(cli: &str) -> String {
    if SYSTEM == System::Windows && cli != "claude" {
        encoded_powershell(
            "& '/opt/facade' 'hook' 'session-start' '/home/.facade/core/runs/a3/1f/session'; exit $LASTEXITCODE",
        )
    } else {
        HOOK.to_string()
    }
}

/// [`TITLE`] for the shell Antigravity runs it with.
fn title_hook() -> String {
    by_system(
        TITLE,
        &encoded_powershell(
            "& '/opt/facade' 'hook' 'title' '/home/.facade/core/runs/a3/1f/session'; exit $LASTEXITCODE",
        ),
    )
}

/// `name` in the run folder of these tests, as the system joins it.
fn in_run(name: &str) -> String {
    Path::new("/home/.facade/core/runs/a3/1f")
        .join(name)
        .to_string_lossy()
        .into_owned()
}
use crate::find;
use crate::{
    INSTRUCTIONS_FILE, PLUGIN_MEMBERS, SKILL_FILE, guest_entry_serves_run, runs_start_guest_entry,
};

/// Where the runs of these tests report their session.
fn report() -> crate::SessionReport<'static> {
    let (file, cwd) = (
        std::path::Path::new("/home/.facade/core/runs/a3/1f/session"),
        std::path::Path::new("/nowhere/project"),
    );
    crate::SessionReport {
        facade: "/opt/facade",
        file,
        cwd,
    }
}

fn words(line: &[&str]) -> Vec<String> {
    line.iter().map(|word| word.to_string()).collect()
}

/// Starts `cli` with Facade's server, in an environment holding `environment`.
fn launch(cli: &str, given: &[&str], environment: &[(&str, &str)]) -> CommandLine {
    launch_in(Path::new("/nowhere/project"), cli, given, environment)
}

/// Starts `cli` in `cwd` with Facade's server, in an environment holding `environment`.
fn launch_in(cwd: &Path, cli: &str, given: &[&str], environment: &[(&str, &str)]) -> CommandLine {
    let env = run_variables();
    let folder = PathBuf::from("/home/.facade/core/runs/a3/1f");
    let server = test_server(cwd, &folder, &env);
    let mut environment: BTreeMap<String, String> = environment
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    // The home a test names is the CLIs' home on either system.
    if let Some(home) = environment.get("HOME").cloned() {
        environment.entry("USERPROFILE".into()).or_insert(home);
    }
    start_command_line(
        find(cli).unwrap().unwrap(),
        &words(given),
        Some(&report()),
        Some(&server),
        &environment,
        None,
    )
}

fn test_server<'a>(cwd: &'a Path, folder: &'a Path, env: &'a [(String, String)]) -> Server<'a> {
    Server {
        program: "/opt/facade-mcp",
        env,
        folder,
        instructions: "You are Facade agent #a3.",
        cwd,
        facade: "/opt/facade",
    }
}

/// The variables of the run, which Facade sets in its CLI's environment besides what the launch
/// adds.
fn run_variables() -> [(String, String); 2] {
    [
        ("FACADE_AGENT".to_string(), "a3".to_string()),
        ("FACADE_HOME".to_string(), "/home/.facade".to_string()),
    ]
}

fn after<'a>(launch: &'a CommandLine, word: &str) -> &'a str {
    &launch.command[launch
        .command
        .iter()
        .position(|each| each == word)
        .unwrap_or_else(|| panic!("no {word} in {:?}", launch.command))
        + 1]
}

#[test]
fn claude_gets_a_server_file_of_the_run_its_tools_allowed_and_no_project_facade_server() {
    let launch = launch("claude", &["--model", "opus"], &[]);
    assert_eq!(launch.tools, Tools::Injected);
    assert_eq!(after(&launch, "--mcp-config"), in_run("mcp.json"));
    assert_eq!(after(&launch, "--allowedTools"), "mcp__facade");
    assert_eq!(
        launch.command[launch.command.len() - 2..],
        words(&["--model", "opus"]),
        "the person's words come last"
    );
    let (name, text) = &launch.files[0];
    assert_eq!(name, "mcp.json");
    let config: Value = serde_json::from_str(text).unwrap();
    assert_eq!(
        config["mcpServers"]["facade"],
        json!({
            "type": "stdio", "command": "/opt/facade-mcp", "args": [],
            "env": { "FACADE_AGENT": "a3", "FACADE_HOME": "/home/.facade" },
        })
    );
    let settings: Value = serde_json::from_str(after(&launch, "--settings")).unwrap();
    assert_eq!(settings["disabledMcpjsonServers"], json!(["facade"]));
    let own = launch_with_settings(r#"{"disabledMcpjsonServers":["mine"],"model":"opus"}"#);
    assert_eq!(
        (own["disabledMcpjsonServers"].clone(), own["model"].clone()),
        (json!(["mine", "facade"]), json!("opus")),
        "the person's list keeps its own"
    );
}

fn launch_with_settings(own: &str) -> Value {
    serde_json::from_str(after(
        &launch("claude", &["--settings", own], &[]),
        "--settings",
    ))
    .unwrap()
}

/// Claude Code's `--mcp-config` and `--allowedTools` take every value up to the next option:
/// the person's words never come right after them, so a prompt stays the prompt and never
/// becomes an allowed tool.
#[test]
fn claude_s_options_that_take_many_values_never_take_the_person_s_words() {
    let values = |launch: &CommandLine, option: &str| -> Vec<String> {
        let at = launch
            .command
            .iter()
            .position(|word| word == option)
            .unwrap_or_else(|| panic!("no {option} in {:?}", launch.command));
        launch.command[at + 1..]
            .iter()
            .take_while(|word| !word.starts_with('-'))
            .cloned()
            .collect()
    };
    let started = launch("claude", &["fix the bug"], &[]);
    assert_eq!(
        values(&started, "--allowedTools"),
        ["mcp__facade"],
        "{:?}",
        started.command
    );
    assert_eq!(values(&started, "--mcp-config").len(), 1);
    assert_eq!(started.command.last().unwrap(), "fix the bug");
    // Without the hook's options after them, as where the person's own settings cannot be read,
    // they go after the person's words, before a `--` of theirs.
    let unread = launch(
        "claude",
        &["--settings", "{not json", "fix the bug", "--", "-a prompt"],
        &[],
    );
    assert_eq!(
        values(&unread, "--allowedTools"),
        ["mcp__facade"],
        "{:?}",
        unread.command
    );
    let at = |word: &str| unread.command.iter().position(|each| each == word).unwrap();
    assert!(
        at("fix the bug") < at("--mcp-config") && at("--allowedTools") < at("--"),
        "{:?}",
        unread.command
    );
    assert_eq!(unread.command.last().unwrap(), "-a prompt");
}

#[test]
fn codex_gets_overrides_with_its_tools_approved_and_a_longer_wait_for_the_server() {
    let launch = launch("codex", &["fix it"], &[]);
    let overrides: Vec<&str> = launch
        .command
        .iter()
        .enumerate()
        .filter(|(at, _)| *at > 0 && launch.command[at - 1] == "-c")
        .map(|(_, word)| word.as_str())
        .collect();
    assert!(
        overrides.contains(&r#"mcp_servers.facade.command="/opt/facade-mcp""#),
        "{overrides:?}"
    );
    assert!(
        overrides.contains(
            &r#"mcp_servers.facade.env={"FACADE_AGENT"="a3","FACADE_HOME"="/home/.facade"}"#
        ),
        "{overrides:?}"
    );
    for wanted in [
        "mcp_servers.facade.args=[]",
        "mcp_servers.facade.tool_timeout_sec=3660",
        r#"mcp_servers.facade.default_tools_approval_mode="approve""#,
        "mcp_optional_startup_grace_ms=10000",
    ] {
        assert!(overrides.contains(&wanted), "{wanted} in {overrides:?}");
    }
    assert_eq!(launch.command.last().map(String::as_str), Some("fix it"));
}

#[test]
fn opencode_gets_the_server_in_the_person_s_own_inline_configuration_after_their_rules() {
    let config = |launch: &CommandLine| -> Value {
        serde_json::from_str(
            &launch
                .env
                .iter()
                .find(|(name, _)| name == "OPENCODE_CONFIG_CONTENT")
                .unwrap()
                .1,
        )
        .unwrap()
    };
    let alone = config(&launch("opencode", &[], &[]));
    assert_eq!(
        alone["mcp"]["facade"]["command"],
        json!(["/opt/facade-mcp"])
    );
    assert_eq!(
        (
            alone["mcp"]["facade"]["timeout"].clone(),
            alone["permission"].clone()
        ),
        (json!(3_660_000), json!({ "facade_*": "allow" }))
    );
    let own = config(&launch(
        "opencode",
        &[],
        &[(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"permission":{"*":"ask"},"mcp":{"mine":{"type":"local"}}}"#,
        )],
    ));
    assert_eq!(
        serde_json::to_string(&own["permission"]).unwrap(),
        r#"{"*":"ask","facade_*":"allow"}"#,
        "Facade's rule comes after the person's own"
    );
    assert!(own["mcp"]["mine"].is_object() && own["mcp"]["facade"].is_object());
    // A permission given as one string is one rule for every tool, and Facade's goes after it,
    // as after any rule of the person's, a `facade_*` of theirs too.
    let one = launch(
        "opencode",
        &[],
        &[("OPENCODE_CONFIG_CONTENT", r#"{"permission":"ask"}"#)],
    );
    assert_eq!(
        serde_json::to_string(&config(&one)["permission"]).unwrap(),
        r#"{"*":"ask","facade_*":"allow"}"#
    );
    let mut started: BTreeMap<String, String> =
        one.env.into_iter().chain(run_variables()).collect();
    find("opencode")
        .unwrap()
        .unwrap()
        .remove_wiring_environment(&mut started);
    assert_eq!(
        started["OPENCODE_CONFIG_CONTENT"], r#"{"permission":{"*":"ask"}}"#,
        "which means the same as the string"
    );
    let theirs = config(&launch(
        "opencode",
        &[],
        &[(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"permission":{"facade_*":"deny","*":"deny"}}"#,
        )],
    ));
    assert_eq!(
        serde_json::to_string(&theirs["permission"]).unwrap(),
        r#"{"*":"deny","facade_*":"allow"}"#
    );
    // Read as OpenCode reads it: comments and trailing commas allowed, and a blank one as none.
    let commented = config(&launch(
        "opencode",
        &[],
        &[(
            "OPENCODE_CONFIG_CONTENT",
            "{\n\t// mine\n\t\"permission\": { \"bash\": \"ask\", },\n}",
        )],
    ));
    assert_eq!(
        serde_json::to_string(&commented["permission"]).unwrap(),
        r#"{"bash":"ask","facade_*":"allow"}"#
    );
    let blank = launch("opencode", &[], &[("OPENCODE_CONFIG_CONTENT", " \n")]);
    assert_eq!(
        (&blank.tools, config(&blank)),
        (&Tools::Injected, alone.clone()),
        "a blank one is none"
    );
    let unreadable = launch("opencode", &[], &[("OPENCODE_CONFIG_CONTENT", "{not json")]);
    assert_eq!(
        unreadable.tools,
        Tools::NotGiven("its OPENCODE_CONFIG_CONTENT is not a JSON object Facade can read".into())
    );
    assert!(
        !unreadable
            .env
            .iter()
            .any(|(name, _)| name == "OPENCODE_CONFIG_CONTENT"),
        "the person's own configuration stays as it is"
    );
}

#[test]
fn pi_gets_an_extension_of_the_run_that_registers_the_server_and_its_instructions() {
    let launch = launch("pi", &[], &[]);
    assert_eq!(after(&launch, "-e"), in_run("facade-pi.mjs"));
    let (name, text) = &launch.files[0];
    assert_eq!(name, "facade-pi.mjs");
    assert!(
        text.contains(
            r#"pi.registerMcpServer("facade", {"command":"/opt/facade-mcp","args":[],"env":{"FACADE_AGENT":"a3","FACADE_HOME":"/home/.facade"},"exposure":"direct","timeout":3660,"#,
        ),
        "{text}"
    );
    assert!(
        text.contains(
            r#"event.systemPromptOptions.sections.facade = "You are Facade agent #a3.";"#
        ),
        "{text}"
    );
}

/// Each CLI given Facade's tools is given its skill too, one text, in its place (MCP-6.2):
/// Claude Code a plugin of the run's by `--plugin-dir`, OpenCode a file of the run's last in
/// its `instructions`, Pi a file of the run's its extension's resource-discovery hook gives,
/// Antigravity a member of its plugin, Codex a file of the run's its session-start hook gives,
/// and Muse Code a file of the run's its instructions hook gives after the instructions. A run
/// not given the tools gets none.
#[test]
fn each_cli_given_the_tools_is_given_the_skill_in_its_place() {
    let skill = facade_base::skill::text();
    let file = |launch: &CommandLine, name: &str| {
        launch
            .files
            .iter()
            .find(|(file, _)| file == name)
            .map(|(_, text)| text.clone())
    };
    let claude = launch("claude", &["fix it"], &[]);
    assert_eq!(after(&claude, "--plugin-dir"), in_run("plugin"));
    assert_eq!(
        file(&claude, "plugin/skills/facade/SKILL.md").as_ref(),
        Some(&skill)
    );
    let manifest: Value =
        serde_json::from_str(&file(&claude, "plugin/.claude-plugin/plugin.json").unwrap()).unwrap();
    assert_eq!(manifest["name"], "facade");
    let opencode = launch(
        "opencode",
        &[],
        &[("OPENCODE_CONFIG_CONTENT", r#"{"instructions":["mine.md"]}"#)],
    );
    let config: Value = serde_json::from_str(
        &opencode
            .env
            .iter()
            .find(|(name, _)| name == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1,
    )
    .unwrap();
    assert_eq!(
        config["instructions"],
        json!(["mine.md", in_run("skills/facade/SKILL.md")]),
        "after the person's own"
    );
    assert_eq!(file(&opencode, SKILL_FILE).as_ref(), Some(&skill));
    let mut child: BTreeMap<String, String> =
        opencode.env.into_iter().chain(run_variables()).collect();
    find("opencode")
        .unwrap()
        .unwrap()
        .remove_wiring_environment(&mut child);
    assert_eq!(
        child["OPENCODE_CONFIG_CONTENT"], r#"{"instructions":["mine.md"]}"#,
        "an agent it starts gets the person's alone"
    );
    let unreadable = launch(
        "opencode",
        &[],
        &[("OPENCODE_CONFIG_CONTENT", r#"{"instructions":"mine.md"}"#)],
    );
    assert!(
        matches!(unreadable.tools, Tools::NotGiven(ref why) if why.contains("instructions")),
        "{:?}",
        unreadable.tools
    );
    let pi = launch("pi", &[], &[]);
    assert_eq!(file(&pi, SKILL_FILE).as_ref(), Some(&skill));
    let extension = file(&pi, "facade-pi.mjs").unwrap();
    assert!(
        extension.contains("pi.on('resources_discover'")
            && extension.contains(r#"new URL("./skills/facade/SKILL.md", import.meta.url)"#),
        "{extension}"
    );
    let agy = launch("agy", &[], &[("HOME", "/nowhere/home")]);
    assert_eq!(
        agy.plugin
            .iter()
            .find(|(name, _)| name == SKILL_FILE)
            .map(|(_, text)| text),
        Some(&skill)
    );
    let hooks = |launch: &CommandLine| {
        let setting = launch
            .command
            .iter()
            .find(|word| word.starts_with("hooks="))
            .cloned()
            .unwrap_or_default();
        let table: toml::Table = toml::from_str(&setting).unwrap();
        let command = table["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        encoded_powershell_words(command)
            .or_else(|| shell_words(command))
            .unwrap()
    };
    let codex = launch("codex", &["fix it"], &[]);
    assert!(
        hooks(&codex)
            == words(&[
                "/opt/facade",
                "hook",
                "session-start",
                "/home/.facade/core/runs/a3/1f/session",
                "--skill"
            ]),
        "{:?}",
        hooks(&codex)
    );
    assert_eq!(
        file(&codex, SKILL_FILE).as_ref(),
        Some(&skill),
        "the skill the hook gives, beside the session file"
    );
    let muse = launch("muse", &[], &[("HOME", "/nowhere/home")]);
    assert_eq!(file(&muse, SKILL_FILE).as_ref(), Some(&skill));
    let without = |cli: &str| {
        start_command_line(
            find(cli).unwrap().unwrap(),
            &words(&["fix it"]),
            Some(&report()),
            None,
            &BTreeMap::new(),
            None,
        )
    };
    assert!(
        !hooks(&without("codex")).contains(&"--skill".to_string())
            && hooks(&without("codex")).contains(&"session-start".to_string())
    );
    for cli in ["claude", "opencode", "pi", "agy"] {
        let plain = without(cli);
        assert!(
            plain
                .files
                .iter()
                .chain(&plain.plugin)
                .all(|(name, _)| !name.ends_with("SKILL.md")),
            "{cli}: {:?}",
            plain.files
        );
        assert!(
            !plain.command.iter().any(|word| word == "--plugin-dir"),
            "{cli}"
        );
    }
}

/// Pi's extension gives Pi the run's skill as its resource-discovery hook runs (CLIS-2.2),
/// unless a `facade` skill Pi loaded already holds the same text, which then serves; a loaded
/// one that differs leaves Pi both, and its own diagnostic.
#[test]
fn pi_s_extension_gives_the_run_s_skill_unless_the_same_one_is_loaded() {
    let folder = crate::test_folder::TestFolder::new("rules-piskill");
    for (name, text) in &launch("pi", &[], &[]).files {
        let path = folder.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    let (same, other) = (folder.join("same.md"), folder.join("other.md"));
    std::fs::write(&same, facade_base::skill::text()).unwrap();
    std::fs::write(&other, "---\nname: facade\n---\n").unwrap();
    let script = format!(
        r#"const extension = (await import({module})).default;
			let discover;
			let commands = [];
			extension({{ registerMcpServer: () => {{}}, on: (event, handler) => {{ if (event === 'resources_discover') discover = handler; }}, getCommands: () => commands }});
			const loaded = (path) => [{{ source: 'skill', name: 'skill:facade', sourceInfo: {{ path }} }}];
			const own = JSON.stringify({{ skillPaths: [{own}] }});
			if (JSON.stringify(discover()) !== own) throw new Error('none loaded: ' + JSON.stringify(discover()));
			commands = loaded({other});
			if (JSON.stringify(discover()) !== own) throw new Error('another loaded: ' + JSON.stringify(discover()));
			commands = loaded({same});
			if (discover() !== undefined) throw new Error('the same loaded: ' + JSON.stringify(discover()));"#,
        module = json!(format!("file://{}", folder.join("facade-pi.mjs").display())),
        // Node names the module by its real path.
        own = json!(SKILL_FILE.split('/').fold(
            facade_base::files::real_path(&folder).unwrap(),
            |path, part| path.join(part)
        )),
        other = json!(other),
        same = json!(same),
    );
    crate::test_folder::run_with_node(&script);
}

/// What a launch added to its CLI's environment comes out again, and what the person set stays:
/// the rule's defaults where they still hold, the hook's and the tools' variables, and Facade's
/// server in the person's own OpenCode configuration.
#[test]
fn what_a_launch_added_to_the_environment_comes_out_again() {
    let mine = r#"{"permission":{"*":"ask"},"mcp":{"mine":{"type":"local"}}}"#;
    for (cli, person, adds) in [
        ("claude", vec![("PATH", "/bin")], false),
        ("codex", vec![("PATH", "/bin")], false),
        ("opencode", vec![("PATH", "/bin")], true),
        ("opencode", vec![("OPENCODE_CONFIG_CONTENT", mine)], true),
        ("pi", vec![("PATH", "/bin")], false),
        ("muse", vec![("PATH", "/bin")], false),
        ("agy", vec![("PATH", "/bin")], false),
        ("fake", vec![("PATH", "/bin")], true),
    ] {
        let mut set: BTreeMap<String, String> = person
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        set.extend(run_variables());
        let rule = find(cli).unwrap().unwrap();
        let mut started = set.clone();
        started.extend(launch(cli, &[], &person).env);
        assert_eq!(
            started != set,
            adds,
            "{cli}: what the launch adds: {started:?}"
        );
        rule.remove_wiring_environment(&mut started);
        assert_eq!(started, set, "{cli}");
    }
}

#[test]
fn the_test_cli_runs_the_server_itself() {
    let fake = launch("fake", &[], &[]);
    assert!(
        fake.env
            .contains(&("FAKECLI_MCP".to_string(), "/opt/facade-mcp".to_string()))
            && fake.tools == Tools::Injected
    );
    let without = start_command_line(
        find("claude").unwrap().unwrap(),
        &[],
        Some(&report()),
        None,
        &BTreeMap::new(),
        None,
    );
    assert!(
        without.tools == Tools::NotInjected
            && without.files.is_empty()
            && !without.command.contains(&"--mcp-config".to_string())
    );
}
/// A folder of its own for one test, empty.
fn scratch(test: &str) -> crate::test_folder::TestFolder {
    crate::test_folder::TestFolder::new(&format!("rules-{test}"))
}

fn write(file: PathBuf, text: &str) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

/// The JSON a `-c <key>=<json>` argument of `launch` gives `key`.
fn config(launch: &CommandLine, key: &str) -> Value {
    let prefix = format!("{key}=");
    let given = launch
        .command
        .iter()
        .find_map(|word| word.strip_prefix(prefix.as_str()))
        .unwrap_or_else(|| panic!("no -c {key} in {:?}", launch.command));
    serde_json::from_str(given).unwrap()
}

#[test]
fn muse_code_gets_an_optional_server_by_c_for_the_run_alone_and_a_hook_with_the_instructions() {
    let muse = launch("muse", &["--model", "m"], &[("HOME", "/nowhere/home")]);
    assert_eq!(muse.tools, Tools::Injected);
    let references = json!({ "FACADE_AGENT": "${FACADE_AGENT}", "FACADE_HOME": "${FACADE_HOME}" });
    let entry = json!({
        "command": "/opt/facade-mcp", "args": [], "env": references, "mode": "optional",
    });
    assert_eq!(
        config(&muse, "mcpServers.facade"),
        entry,
        "the run's variables reach it from the CLI's environment"
    );
    let hook = |command: &str| {
        json!({
            "hooks": [{ "type": "command", "command": command, "timeout": 5 }],
        })
    };
    // Muse Code passes its hooks none of the run's variables: the instructions hook names them.
    let ours = hook(&by_system(
        "FACADE_AGENT='a3' FACADE_HOME='/home/.facade' '/opt/facade' hook instructions muse",
        &encoded_powershell(
            "$env:FACADE_AGENT='a3'; $env:FACADE_HOME='/home/.facade'; & '/opt/facade' 'hook' 'instructions' 'muse'; exit $LASTEXITCODE",
        ),
    ));
    let approves = hook(&by_system(
        "'/opt/facade' hook approve muse",
        &encoded_powershell("& '/opt/facade' 'hook' 'approve' 'muse'; exit $LASTEXITCODE"),
    ));
    let session =
        json!({ "hooks": [{ "type": "command", "command": hook_of("muse"), "timeout": 5 }] });
    assert_eq!(
        config(&muse, "hooks"),
        json!({ "SessionStart": [ours, session], "PermissionRequest": [approves] }),
        "Facade's tools approved where Muse Code would ask, and the run's session reported"
    );
    assert_eq!(
        muse.command[muse.command.len() - 2..],
        ["--model", "m"],
        "the person's words come last"
    );
    let given = [
        (
            INSTRUCTIONS_FILE.to_string(),
            "You are Facade agent #a3.".to_string(),
        ),
        (SKILL_FILE.to_string(), facade_base::skill::text()),
    ];
    assert_eq!(
        muse.files, given,
        "the run's instructions and skill, which the hook gives"
    );
    assert!(
        muse.env.is_empty() && muse.plugin.is_empty(),
        "nothing else, written nowhere"
    );

    // The person's own hooks stay, before Facade's: those of their settings file, comments and
    // all, or else those they pass.
    let home = scratch("musehooks");
    let theirs = json!({ "hooks": [{ "type": "command", "command": "mine" }] });
    write(
        home.join(".config/muse/settings.json"),
        &format!(
            "{{\n\t// mine\n\t\"hooks\": {{ \"SessionStart\": [{theirs}], \"Stop\": \
             [{theirs}], }},\n}}\n"
        ),
    );
    let environment = [("HOME", home.to_str().unwrap())];
    let given = config(&launch("muse", &[], &environment), "hooks");
    assert_eq!(
        given,
        json!({
            "SessionStart": [theirs, ours, session], "Stop": [theirs],
            "PermissionRequest": [approves],
        })
    );
    let passed = launch(
        "muse",
        &[
            "-c",
            &format!("hooks={}", json!({ "Stop": [theirs] })),
            "go",
        ],
        &environment,
    );
    assert_eq!(
        config(&passed, "hooks"),
        json!({
            "Stop": [theirs], "SessionStart": [ours, session], "PermissionRequest": [approves],
        })
    );
    assert_eq!(
        passed
            .command
            .iter()
            .filter(|word| word.starts_with("hooks="))
            .count(),
        1,
        "theirs taken in: {:?}",
        passed.command
    );
    assert_eq!(passed.command.last().unwrap(), "go");
    // Hooks Facade cannot read stay as they are, for Muse Code to say what is wrong: the run
    // then has no hook of Facade's.
    let twice = launch("muse", &["-c", "hooks={}", "-c", "hooks={}"], &environment);
    assert_eq!(
        twice
            .command
            .iter()
            .filter(|word| word.starts_with("hooks="))
            .count(),
        2
    );
    write(home.join(".config/muse/settings.json"), "{ \"hooks\": ");
    let unread = launch("muse", &[], &environment);
    assert!(
        unread.tools == Tools::Injected
            && !unread.command.iter().any(|word| word.starts_with("hooks=")),
        "{:?}",
        unread.command
    );
    assert!(!unread.captures, "and reports no session");
    std::fs::remove_dir_all(&home).unwrap();
}

/// Where the person's settings hold Facade's guest entry, beside which Muse Code would refuse a
/// run's own server, that entry serves the run: the run adds no server, and carries none of
/// Facade's guest hooks, which Muse Code would run with none of the run's variables. A
/// `facade-mcp` entry that names no run's agent cannot serve the run, and is in its way.
#[test]
fn muse_code_s_run_is_served_by_facade_s_guest_entry_where_the_settings_hold_it() {
    assert!(guest_entry_serves_run("muse"));
    assert!(
        ["claude", "codex", "opencode", "pi", "agy"]
            .iter()
            .all(|cli| !guest_entry_serves_run(cli))
    );
    assert!(
        ["muse", "agy"]
            .iter()
            .all(|cli| runs_start_guest_entry(cli))
    );
    assert!(
        ["claude", "codex", "opencode", "pi"]
            .iter()
            .all(|cli| !runs_start_guest_entry(cli))
    );
    let home = scratch("museguest");
    let programs = crate::integration::Programs {
        facade: "/opt/facade",
        mcp: "/opt/facade-mcp",
        home: None,
    };
    let settings =
        crate::integration::write(crate::integration::Kind::MuseSettings, None, &programs).unwrap();
    write(home.join(".config/muse/settings.json"), &settings);
    let environment = [("HOME", home.to_str().unwrap())];
    let run = launch("muse", &["go"], &environment);
    assert_eq!(run.tools, Tools::Injected);
    assert!(
        !run.command
            .iter()
            .any(|word| word.starts_with("mcpServers")),
        "no server of the run's own: {:?}",
        run.command
    );
    let hooks = config(&run, "hooks");
    assert_eq!(
        hooks["SessionStart"].as_array().unwrap().len(),
        2,
        "the run's instructions and session report: {hooks}"
    );
    assert_eq!(
        hooks["PermissionRequest"].as_array().unwrap().len(),
        1,
        "the run's approval alone: {hooks}"
    );
    assert!(
        hooks.get("UserPromptSubmit").is_none() && hooks.get("SessionEnd").is_none(),
        "{hooks}"
    );
    // An entry an earlier version wrote names no socket, and is Facade's all the same.
    let mut earlier: Value = serde_json::from_str(&settings).unwrap();
    earlier["mcpServers"]["facade"]["args"] = json!(["--guest", "muse"]);
    write(
        home.join(".config/muse/settings.json"),
        &earlier.to_string(),
    );
    assert_eq!(launch("muse", &[], &environment).tools, Tools::Injected);
    let mut stale: Value = serde_json::from_str(&settings).unwrap();
    stale["mcpServers"]["facade"]["env"] = json!({});
    write(home.join(".config/muse/settings.json"), &stale.to_string());
    assert!(matches!(
        launch("muse", &[], &environment).tools,
        Tools::NotGiven(why) if why.contains("names a facade server")
    ));
    std::fs::remove_dir_all(&home).unwrap();
}

/// Muse Code refuses to run with Facade's server beside a `facade` server of the person's
/// settings or of a project MCP file it reads - in each folder up to the top of the run's
/// repository - and beside a project MCP file it cannot load. Such a run is not given the
/// tools, and no file is changed.
#[test]
fn muse_code_is_not_given_the_tools_beside_a_facade_server_of_its_own_or_a_project_file_it_cannot_load()
 {
    let root = scratch("museconflicts");
    let (home, repository) = (root.join("home"), root.join("repository"));
    let cwd = repository.join("app");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(repository.join(".git")).unwrap();
    let environment = [("HOME", home.to_str().unwrap())];
    let refused = |expected: &str| {
        let launch = launch_in(&cwd, "muse", &[], &environment);
        match &launch.tools {
            Tools::NotGiven(why) => {
                assert!(why.contains(expected), "{why}");
                assert!(
                    !launch
                        .command
                        .iter()
                        .any(|word| word.contains("mcpServers"))
                );
                assert_eq!(
                    config(&launch, "hooks"),
                    json!({
                        "SessionStart": [{ "hooks": [{
                            "type": "command", "command": hook_of("muse"), "timeout": 5
                        }] }]
                    })
                );
            }
            other => panic!("given the tools beside {expected}: {other:?}"),
        }
    };
    let server = r#"{ "mcpServers": { "facade": { "command": "facade-mcp" } } }"#;
    write(
        home.join(".config/muse/settings.json"),
        &format!("// mine\n{server}"),
    );
    refused("settings.json names a facade server");
    std::fs::remove_file(home.join(".config/muse/settings.json")).unwrap();
    for (file, text, expected) in [
        (cwd.join(".mcp.json"), server, "names a facade server"),
        (
            repository.join(".mcp.json"),
            server,
            "names a facade server",
        ),
        (
            cwd.join(".mcp.json"),
            "{ \"mcpServers\": {}, }",
            "is not plain JSON",
        ),
        (cwd.join(".mcp.json"), "\u{feff}{}", "is not plain JSON"),
        (cwd.join(".mcp.json"), "[]", "holds no JSON object"),
        (
            cwd.join(".mcp.json"),
            r#"{ "mcpServers": [] }"#,
            "has an mcpServers that is not a JSON object",
        ),
        (
            cwd.join(".mcp.json"),
            r#"{ "mcpServers": { "mine": { "args": [] } } }"#,
            "names a server \"mine\" with neither a command nor a url",
        ),
    ] {
        write(file.clone(), text);
        refused(expected);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            text,
            "Facade changes nothing"
        );
        std::fs::remove_file(&file).unwrap();
    }
    write(
        cwd.join(".mcp.json"),
        r#"{ "mcpServers": { "mine": { "url": "http://localhost" } } }"#,
    );
    assert_eq!(
        launch_in(&cwd, "muse", &[], &environment).tools,
        Tools::Injected,
        "the person's other servers are no conflict"
    );
    // Outside a repository, Muse Code reads the run's own folder alone.
    std::fs::remove_dir_all(repository.join(".git")).unwrap();
    write(repository.join(".mcp.json"), server);
    assert_eq!(
        launch_in(&cwd, "muse", &[], &environment).tools,
        Tools::Injected
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// A conflicting `facade` server of the person's own, in any configuration the CLI reads, leaves
/// the run without Facade's tools, says why, and stays as it is. Antigravity names a plugin's
/// server after the plugin, so Facade's is `facade_facade`, and its run is given the tools beside a
/// `facade` server. A `facade` server that runs `facade-mcp`, and Pi's guest extension, are
/// Facade's own and change nothing. Pi then starts without Facade's extension, as it would not
/// start beside a second one.
#[test]
fn a_facade_server_of_the_person_s_own_withholds_tools_only_where_it_conflicts() {
    let root = scratch("ownserver");
    let (home, repository) = (root.join("home"), root.join("repository"));
    let cwd = repository.join("app");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(repository.join(".git")).unwrap();
    let environment = [("HOME", home.to_str().unwrap())];
    let refused = |cli: &str, environment: &[(&str, &str)], expected: &str| {
        let launch = launch_in(&cwd, cli, &[], environment);
        match &launch.tools {
            Tools::NotGiven(why) => assert!(
                why.replace('\\', "/")
                    .contains(&expected.replace('\\', "/"))
                    && why.ends_with("the run has no Facade tools"),
                "{cli}: {why}"
            ),
            other => panic!("{cli} given the tools beside {expected}: {other:?}"),
        }
        let tools = |word: &String| {
            word.contains("facade-mcp") || word.ends_with("facade-pi.mjs") || word == "--mcp-config"
        };
        assert!(
            !launch.command.iter().any(tools),
            "{cli}: {:?}",
            launch.command
        );
        assert!(
            launch
                .env
                .iter()
                .all(|(name, _)| name != "OPENCODE_CONFIG_CONTENT"),
            "{cli}: {:?}",
            launch.env
        );
    };
    let given = |cli: &str, environment: &[(&str, &str)]| {
        assert_eq!(
            launch_in(&cwd, cli, &[], environment).tools,
            Tools::Injected,
            "{cli}"
        )
    };
    let mine = r#"{ "command": "mine", "args": [] }"#;
    // A `facade` server that runs facade-mcp is Facade's.
    let facade_mcp = r#"{ "command": "/usr/local/bin/facade-mcp", "args": [] }"#;
    let servers = |key: &str, entry: &str| format!("{{ \"{key}\": {{ \"facade\": {entry} }} }}");

    // Claude Code: its global configuration, the user's servers and the folder's own, and each
    // project file it reads.
    let claude = home.join(".claude.json");
    for text in [
        servers("mcpServers", mine),
        // Claude Code keys its projects with forward slashes on Windows.
        format!(
            "{{ \"projects\": {{ {}: {} }} }}",
            json!(cwd.display().to_string().replace('\\', "/")),
            servers("mcpServers", mine)
        ),
    ] {
        write(claude.clone(), &text);
        refused("claude", &environment, &claude.display().to_string());
        assert_eq!(
            std::fs::read_to_string(&claude).unwrap(),
            text,
            "Facade changes nothing"
        );
    }
    write(claude.clone(), &servers("mcpServers", facade_mcp));
    given("claude", &environment);
    let elsewhere = root.join("claude-config");
    write(elsewhere.join(".claude.json"), &servers("mcpServers", mine));
    refused(
        "claude",
        &[
            ("HOME", home.to_str().unwrap()),
            ("CLAUDE_CONFIG_DIR", elsewhere.to_str().unwrap()),
        ],
        "claude-config/.claude.json",
    );
    write(repository.join(".mcp.json"), &servers("mcpServers", mine));
    refused("claude", &environment, "repository/.mcp.json");
    std::fs::remove_file(repository.join(".mcp.json")).unwrap();

    // Codex: its config.toml.
    write(
        home.join(".codex/config.toml"),
        "model = \"m\"\n\n[mcp_servers.facade]\ncommand = \"mine\"\n",
    );
    refused("codex", &environment, "config.toml");
    write(
        home.join(".codex/config.toml"),
        "[mcp_servers.facade]\ncommand = \"/usr/local/bin/facade-mcp\"\n",
    );
    given("codex", &environment);

    // OpenCode: its global configuration, comments and all, a project one, and the person's own
    // inline configuration.
    let opencode_mine = r#"{ "type": "local", "command": ["mine"] }"#;
    write(
        home.join(".config/opencode/opencode.jsonc"),
        &format!("// mine\n{}", servers("mcp", opencode_mine)),
    );
    refused("opencode", &environment, "opencode.jsonc");
    std::fs::remove_file(home.join(".config/opencode/opencode.jsonc")).unwrap();
    write(cwd.join("opencode.json"), &servers("mcp", opencode_mine));
    refused("opencode", &environment, "app/opencode.json");
    std::fs::remove_file(cwd.join("opencode.json")).unwrap();
    let inline = servers("mcp", opencode_mine);
    refused(
        "opencode",
        &[
            ("HOME", home.to_str().unwrap()),
            ("OPENCODE_CONFIG_CONTENT", &inline),
        ],
        "its OPENCODE_CONFIG_CONTENT",
    );
    write(
        home.join(".config/opencode/opencode.json"),
        &servers(
            "mcp",
            r#"{ "type": "local", "command": ["/usr/local/bin/facade-mcp"] }"#,
        ),
    );
    given("opencode", &environment);

    // Antigravity names the plugin's server facade_facade, so its run is given the tools beside
    // a facade server in its own MCP configuration.
    write(
        home.join(".gemini/config/mcp_config.json"),
        &servers("mcpServers", mine),
    );
    given("agy", &environment);
    std::fs::remove_file(home.join(".gemini/config/mcp_config.json")).unwrap();

    // Pi: an extension it loads, in its agent folder or the project's, that registers `facade`.
    write(
        home.join(".pi/agent/extensions/mine.ts"),
        "export default function (pi) {\n\tpi.registerMcpServer( 'facade', { command: \
         'mine' });\n}\n",
    );
    refused("pi", &environment, "extensions/mine.ts");
    std::fs::remove_file(home.join(".pi/agent/extensions/mine.ts")).unwrap();
    write(
        cwd.join(".pi/extensions/tools/package.json"),
        r#"{ "pi": { "extensions": ["main.js"] } }"#,
    );
    write(
        cwd.join(".pi/extensions/tools/main.js"),
        "pi.registerMcpServer(`facade`, {});\n",
    );
    refused("pi", &environment, "extensions/tools/main.js");
    std::fs::remove_dir_all(cwd.join(".pi")).unwrap();
    write(
        home.join(".pi/agent/extensions/other.js"),
        "pi.registerMcpServer(\"facade-notes\", {});\n",
    );
    given("pi", &environment);
    std::fs::remove_dir_all(&root).unwrap();
}

/// The guest extension `facade integration add pi` writes, as it writes it, registers Facade's
/// server only where Facade did not start Pi: a run beside it is given the tools.
#[test]
fn a_pi_run_beside_the_guest_extension_is_given_the_tools() {
    let root = scratch("piguest");
    let (home, cwd) = (root.join("home"), root.join("app"));
    std::fs::create_dir_all(&cwd).unwrap();
    let programs = crate::integration::Programs {
        facade: "/opt/facade/facade",
        mcp: "/opt/facade/facade-mcp",
        home: None,
    };
    let extension =
        crate::integration::write(crate::integration::Kind::PiExtension, None, &programs).unwrap();
    write(home.join(".pi/agent/extensions/facade.js"), &extension);
    assert_eq!(
        launch_in(&cwd, "pi", &[], &[("HOME", home.to_str().unwrap())]).tools,
        Tools::Injected
    );

    let agent_dir = home.join(".pi/agent");
    let mcp_file = agent_dir.join("mcp.json");
    let guest_config = r#"{"mcpServers":{"facade":{"command":"/opt/facade-mcp","args":[]}}}"#;
    write(mcp_file.clone(), guest_config);
    let environment = BTreeMap::from([(
        "PI_CODING_AGENT_DIR".into(),
        agent_dir.to_str().unwrap().to_owned(),
    )]);
    let report = report();
    let variables = run_variables();
    let credential = "1".repeat(64);
    let relay_args = words(&[crate::RUN_CREDENTIAL_ARG, &credential]);
    let managed = start_managed_launch_command(
        find("pi").unwrap().unwrap(),
        &[],
        Some(&report),
        Some(&ManagedServer {
            server: test_server(&cwd, report.folder(), &variables),
            args: &relay_args,
        }),
        &environment,
        None,
    );
    assert_eq!(managed.tools, Tools::Injected);
    assert!(managed.uses_run_credential);
    assert_eq!(after(&managed, "-e"), in_run("facade-pi.mjs"));
    let extension = &managed
        .files
        .iter()
        .find(|(name, _)| name == "facade-pi.mjs")
        .unwrap()
        .1;
    assert!(extension.contains(r#"pi.registerMcpServer("facade_managed", "#));
    assert!(extension.contains(&format!("\"args\":{}", json!(relay_args))));
    assert_eq!(std::fs::read_to_string(mcp_file).unwrap(), guest_config);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn antigravity_gets_the_plugin_and_its_tools_allowed_beside_the_person_s_own_rules() {
    let agy = launch("agy", &["--model", "m"], &[("HOME", "/nowhere/home")]);
    assert_eq!(agy.tools, Tools::Injected);
    let plugin: BTreeMap<&str, Value> = agy
        .plugin
        .iter()
        .filter(|(name, _)| name.ends_with(".json"))
        .map(|(name, text)| (name.as_str(), serde_json::from_str(text).unwrap()))
        .collect();
    assert_eq!(
        plugin["mcp_config.json"],
        json!({
            "mcpServers": {
                "facade": {
                    "command": "/opt/facade-mcp", "args": [], "env": {},
                },
            },
        }),
        "no run's identity"
    );
    let command = by_system(
        "'/opt/facade' hook instructions agy",
        r#"@"/opt/facade" hook instructions agy"#,
    );
    let hook = json!({ "type": "command", "command": command });
    assert_eq!(
        plugin["hooks.json"],
        json!({ "facade": { "PreInvocation": [hook] } })
    );
    assert_eq!(plugin["plugin.json"]["name"], "facade");
    assert!(
        agy.plugin.iter().all(|(_, text)| text.ends_with("\n")),
        "each file ends its last line"
    );
    assert_eq!(
        agy.plugin
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        PLUGIN_MEMBERS,
        "every member, the skill too"
    );
    let title = json!({ "type": "command", "enabled": true, "command": title_hook() });
    assert_eq!(
        passed_settings(&agy),
        json!({ "permissions": { "allow": ["mcp(facade_facade/*)"] }, "title": title })
    );
    assert_eq!(agy.command[agy.command.len() - 2..], ["--model", "m"]);
    assert!(agy.env.is_empty());
    assert_eq!(
        agy.files[0],
        (
            INSTRUCTIONS_FILE.to_string(),
            "You are Facade agent #a3.".to_string()
        ),
        "the run's instructions, which the hook gives"
    );
    assert_eq!(
        agy.files.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        [INSTRUCTIONS_FILE, "settings.json"],
        "and its settings"
    );

    // `--settings` replaces each key for the session: the person's own rules go in it, from
    // their settings file, comments and all.
    let home = scratch("agysettings");
    let file = home.join(".gemini/antigravity-cli/settings.json");
    write(
        file.clone(),
        "{\n\t\"permissions\": { \"allow\": [\"command(ls)\"], \"deny\": \
         [\"mcp(other_other/*)\"], }, // mine\n\t\"theme\": \"dark\"\n}\n",
    );
    let environment = [("HOME", home.to_str().unwrap())];
    let settings = |launch: &CommandLine| passed_settings(launch);
    let own = json!({
        "permissions": {
            "allow": ["command(ls)", "mcp(facade_facade/*)"], "deny": ["mcp(other_other/*)"],
        },
        "title": title,
    });
    assert_eq!(settings(&launch("agy", &[], &environment)), own);
    // Their own --settings, JSON or a file beside the run, go in it too; their permissions
    // there stand for the file's.
    let cwd = scratch("agyown");
    write(cwd.join("mine.json"), r#"{ "theme": "light" }"#);
    let passed = launch_in(
        &cwd,
        "agy",
        &[
            "--settings",
            r#"{"permissions":{"allow":["read(*)"]}}"#,
            "--settings=mine.json",
            "go",
        ],
        &environment,
    );
    assert_eq!(
        settings(&passed),
        json!({
            "permissions": { "allow": ["read(*)", "mcp(facade_facade/*)"] }, "theme": "light",
            "title": title,
        })
    );
    assert_eq!(
        passed
            .command
            .iter()
            .filter(|word| word.contains("--settings"))
            .count(),
        1,
        "{:?}",
        passed.command
    );
    assert_eq!(passed.command.last().unwrap(), "go");
    // Settings Facade cannot read stay as they are, without Facade's rule.
    let unread = launch_in(&cwd, "agy", &["--settings", "missing.json"], &environment);
    assert_eq!(
        unread.command[unread.command.len() - 2..],
        ["--settings", "missing.json"]
    );
    assert!(!unread.captures, "and reports no session");
    assert_eq!(
        unread
            .command
            .iter()
            .filter(|word| *word == "--settings")
            .count(),
        1
    );

    let rule = find("agy").unwrap().unwrap();
    let report = report();
    let variables = run_variables();
    let server = test_server(&cwd, report.folder(), &variables);
    let environment = BTreeMap::new();
    let first = "1".repeat(64);
    let second = "2".repeat(64);
    let managed = start_managed_launch_command(
        rule,
        &[],
        Some(&report),
        Some(&ManagedServer {
            server,
            args: &words(&[crate::RUN_CREDENTIAL_ARG, &first]),
        }),
        &environment,
        None,
    );
    let resumed = resume_managed_launch_command(
        rule,
        "dc2e7f8d-c453-43f5-8619-d8d49f7c7478",
        &[],
        Some(&report),
        Some(&ManagedServer {
            server,
            args: &words(&[crate::RUN_CREDENTIAL_ARG, &second]),
        }),
        &environment,
        None,
    )
    .unwrap();
    assert!(managed.uses_run_credential && resumed.uses_run_credential);
    assert_eq!(
        managed.plugin,
        crate::plugin_files_v3(server.program, server.facade)
    );
    assert_eq!(managed.plugin, resumed.plugin);
    for (launch, credential) in [(managed, first), (resumed, second)] {
        assert_eq!(launch.env, [("FACADE_RUN_TOKEN".to_owned(), credential)]);
        let mut environment = BTreeMap::from_iter(launch.env);
        rule.remove_wiring_environment(&mut environment);
        assert!(environment.is_empty());
    }

    std::fs::remove_dir_all(&home).unwrap();
    std::fs::remove_dir_all(&cwd).unwrap();
}

/// Antigravity's merged settings, which may hold the person's keys, reach it in a file of the
/// run's, and its command line names only that file (CLIS-3.4).
#[test]
fn antigravity_s_settings_reach_it_in_a_file_of_the_run_s_never_on_its_command_line() {
    let cwd = scratch("agysecret");
    let secret = r#"{ "mcpServers": { "mine": { "env": { "TOKEN": "s3cret" } } } }"#;
    write(cwd.join("mine.json"), secret);
    let agy = launch_in(
        &cwd,
        "agy",
        &["--settings", "mine.json", "go"],
        &[("HOME", "/nowhere/home")],
    );
    assert_eq!(after(&agy, "--settings"), in_run("settings.json"));
    assert!(
        agy.command.iter().all(|word| !word.contains("s3cret")),
        "{:?}",
        agy.command
    );
    assert_eq!(
        passed_settings(&agy)["mcpServers"]["mine"]["env"]["TOKEN"],
        "s3cret"
    );
}

/// The merges read the person's words as their CLI reads them (CLIS-3.1): Antigravity's
/// `-settings` and `-settings=` are its `--settings`, merged into the one Facade passes; Muse
/// Code's `-chooks=` is its `-c hooks=`; Claude Code's; and a `--settings` that is another
/// option's value is that option's, and stays.
#[test]
fn the_merges_read_the_person_s_words_as_their_cli_reads_them() {
    let environment = [("HOME", "/nowhere/home")];
    let named = |launch: &CommandLine, name: &str| {
        launch
            .command
            .iter()
            .filter(|word| word.trim_start_matches('-').starts_with(name))
            .count()
    };
    let settings = |launch: &CommandLine| passed_settings(launch);
    for given in [
        &["-settings", r#"{"theme":"light"}"#][..],
        &[r#"-settings={"theme":"light"}"#],
        &[r#"--settings={"theme":"light"}"#],
    ] {
        let agy = launch("agy", given, &environment);
        assert_eq!(
            (settings(&agy)["theme"].as_str(), named(&agy, "settings")),
            (Some("light"), 1),
            "{given:?}: {:?}",
            agy.command
        );
    }
    let valued = launch(
        "agy",
        &["--project", r#"-settings={"theme":"light"}"#],
        &environment,
    );
    assert!(
        settings(&valued).get("theme").is_none(),
        "{:?}",
        valued.command
    );
    assert_eq!(
        valued.command[valued.command.len() - 2..],
        ["--project", r#"-settings={"theme":"light"}"#]
    );

    let claude = launch(
        "claude",
        &["--append-system-prompt", r#"--settings={"a":1}"#],
        &[],
    );
    assert!(settings(&claude).get("a").is_none(), "{:?}", claude.command);
    assert_eq!(
        claude.command[claude.command.len() - 2..],
        ["--append-system-prompt", r#"--settings={"a":1}"#],
        "the prompt's text stays its own"
    );

    let theirs = json!({ "hooks": [{ "type": "command", "command": "mine" }] });
    let muse = launch(
        "muse",
        &[&format!("-chooks={}", json!({ "Stop": [theirs] })), "go"],
        &environment,
    );
    assert_eq!(
        config(&muse, "hooks")["Stop"],
        json!([theirs]),
        "{:?}",
        muse.command
    );
    assert_eq!(
        (
            named(&muse, "chooks"),
            muse.command.last().map(String::as_str)
        ),
        (0, Some("go")),
        "theirs taken in: {:?}",
        muse.command
    );
}

/// Antigravity reports its conversation through the title command of its `--settings`, whose
/// input names the conversation it shows. The person's own title settings stay, and their own
/// title command, where it is on, runs after Facade's with the same input: from their
/// `--settings`, or else their settings file.
#[test]
fn antigravity_reports_its_conversation_through_its_title_command_and_runs_the_person_s_own() {
    let home = scratch("agytitle");
    let file = home.join(".gemini/antigravity-cli/settings.json");
    let environment = [("HOME", home.to_str().unwrap())];
    let title = |launch: &CommandLine| passed_settings(launch)["title"].clone();
    write(
        file.clone(),
        r#"{ "title": { "type": "command", "command": "echo mine", "refresh": 5 } }"#,
    );
    let theirs = by_system(
        &format!("{TITLE} 'echo mine'"),
        &encoded_powershell(
            "& '/opt/facade' 'hook' 'title' '/home/.facade/core/runs/a3/1f/session' 'echo mine'; exit $LASTEXITCODE",
        ),
    );
    assert_eq!(
        title(&launch("agy", &[], &environment)),
        json!({ "type": "command", "enabled": true, "command": theirs, "refresh": 5 })
    );
    let passed = launch(
        "agy",
        &["--settings", r#"{ "title": { "command": "echo passed" } }"#],
        &environment,
    );
    assert_eq!(
        title(&passed)["command"],
        by_system(
            &format!("{TITLE} 'echo passed'"),
            &encoded_powershell(
                "& '/opt/facade' 'hook' 'title' '/home/.facade/core/runs/a3/1f/session' 'echo passed'; exit $LASTEXITCODE",
            ),
        ),
        "theirs for the session goes first"
    );
    write(
        file,
        r#"{ "title": { "type": "command", "command": "echo off", "enabled": false } }"#,
    );
    assert_eq!(
        title(&launch("agy", &[], &environment))["command"],
        title_hook(),
        "a title command they turned off stays off"
    );
    std::fs::remove_dir_all(&home).unwrap();
}
