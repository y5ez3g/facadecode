//! `facade integration add`, `remove` and `list`: Facade's entries in a CLI's user configuration,
//! through which the sessions a person starts join as guests. Each test's person has a HOME of
//! their own in the test's folder, and on PATH only a stand-in `claude` and the system's programs,
//! so nothing of this computer's own configuration is read or written.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// A stand-in for Claude Code's own commands that add and remove a user server, which Claude Code
/// keeps in `.claude.json`. It logs each command and, as Claude Code does, refuses to add a server
/// that is there.
const CLAUDE: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$STANDIN_LOG"
config="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
# A value as a JSON string holds it: each \ and " escaped, as a Windows path needs.
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
case "$1 $2" in
"mcp add")
	if grep -q '"facade"' "$config" 2>/dev/null; then
		echo "MCP server facade already exists in user config" >&2
		exit 1
	fi
	shift 5
	env='{}'
	if [ "$1" = "-e" ]; then
		env="{\"${2%%=*}\": \"$(json "${2#*=}")\"}"
		shift 2
	fi
	shift
	command="$(json "$1")"
	shift
	args=""
	for arg in "$@"; do
		args="$args${args:+, }\"$(json "$arg")\""
	done
	printf '{"mcpServers": {"facade": {"type": "stdio", "command": "%s", "args": [%s], "env": %s}}}\n' "$command" "$args" "$env" > "$config"
	;;
"mcp remove")
	printf '{"mcpServers": {}}\n' > "$config"
	;;
esac
"#;

/// The person whose configuration the integration writes.
struct Person {
    home: PathBuf,
    log: PathBuf,
    path: String,
}

impl Person {
    fn new(test: &TestHome) -> Person {
        let base = test.path.parent().unwrap();
        let home = base.join("person");
        assert!(
            home.starts_with(std::env::temp_dir()),
            "the person's HOME must be the test's own: {}",
            home.display()
        );
        let bin = base.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        install_script(&bin, "claude", CLAUDE);
        Person {
            home,
            log: base.join("claude.log"),
            path: format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str()),
        }
    }

    /// A command in the person's environment, for `test`'s Facade home. The CLIs' settings folders
    /// follow the person's HOME, as where neither CLAUDE_CONFIG_DIR nor CODEX_HOME is set: the
    /// test's own settings folders are not the person's.
    fn command(&self, test: &TestHome, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = test.command(program);
        command
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("PATH", &self.path)
            .env("STANDIN_LOG", &self.log);
        // On Windows a CLI's settings are under USERPROFILE and APPDATA, which follow the home.
        command.envs(home_variables(&self.home));
        command
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME");
        command
    }

    fn facade(&self, test: &TestHome, args: &[&str]) -> Output {
        self.command(test, &test_binaries().facade)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    fn facade_ok(&self, test: &TestHome, args: &[&str]) -> String {
        let output = self.facade(test, args);
        assert!(
            output.status.success(),
            "facade {args:?} failed: {}{}",
            stdout(&output),
            stderr(&output)
        );
        stdout(&output)
    }

    /// Runs a hook's shell command as its CLI does, with `input` on standard input.
    fn hook(&self, test: &TestHome, command: &str, input: &Value) -> Output {
        // Claude Code runs its hooks with Git Bash. Muse Code runs its own on Windows as one argument
        // of `%COMSPEC% /C`, quoted the standard way: an encoded PowerShell hook, or a cmd.exe one,
        // which starts with `@"…"` or with `set "FACADE_HOME=…" &&`.
        let for_cmd = command.starts_with("powershell.exe ")
            || command.starts_with('@')
            || command.starts_with("set \"");
        let shell = if cfg!(windows) && for_cmd {
            let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
            let mut cmd = self.command(test, comspec);
            cmd.args(["/C", command]);
            cmd
        } else {
            let mut sh = self.command(test, SH.as_str());
            sh.args(["-c", command]);
            sh
        };
        self.run_hook(shell, input)
    }

    fn run_hook(&self, mut shell: Command, input: &Value) -> Output {
        let mut child = shell
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(
            &mut child.stdin.take().unwrap(),
            input.to_string().as_bytes(),
        )
        .unwrap();
        child.wait_with_output().unwrap()
    }

    /// `name`, a path with `/` between its parts, in the person's home, as the system writes it.
    fn file(&self, name: &str) -> PathBuf {
        name.split('/')
            .fold(self.home.clone(), |path, part| path.join(part))
    }

    fn write(&self, name: &str, text: &str) {
        let file = self.file(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.file(name)).ok()
    }

    fn json(&self, name: &str) -> Value {
        facade_scenarios::serde_json::from_str(
            &self.read(name).unwrap_or_else(|| panic!("no {name}")),
        )
        .unwrap()
    }

    /// The commands the stand-in `claude` ran.
    fn claude_ran(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }
}

/// The line `facade integration` prints for a file's state.
/// The words `facade integration add` or `remove` printed for the part `label`, a settings file or
/// a CLI's own MCP servers: its line is indented two spaces, and the words follow the padded label.
fn part<'a>(said: &'a str, label: &str) -> Option<&'a str> {
    said.lines().find_map(|line| {
        let rest = line.strip_prefix("  ")?.strip_prefix(label)?;
        rest.starts_with("   ").then(|| rest.trim())
    })
}

/// The STATUS and ADDED that `facade integration list` shows for `cli`.
fn listed_as(listed: &str, cli: &str) -> (String, String) {
    let table = Table::parse(listed);
    let row = table
        .row("CLI", cli)
        .unwrap_or_else(|| panic!("{cli} is not listed: {listed}"));
    (
        table.cell(row, "STATUS").to_string(),
        table.cell(row, "ADDED").to_string(),
    )
}

/// The agent whose session is `session`.
fn with_session(test: &TestHome, session: &str) -> Option<Value> {
    let listed: Value =
        facade_scenarios::serde_json::from_str(&stdout(&test.run_facade(&["list", "--json"])))
            .ok()?;
    listed["agents"]
        .as_array()?
        .iter()
        .find(|agent| agent["session"] == session)
        .cloned()
}

/// Claude Code's sessions join through the entries `add` writes: Facade's hooks and the approval of
/// its tools beside the person's settings, and its server through Claude Code's own command. Adding
/// again changes nothing; removing puts the settings back byte for byte, and Claude Code's own
/// command removes the server.
#[test]
fn claude_s_sessions_join_through_what_add_writes_and_remove_puts_it_back() {
    let test = TestHome::new("integrate-claude");
    let person = Person::new(&test);
    let own = r#"{"model":"opus","permissions":{"allow":["Bash(ls)"]}}"#;
    person.write(".claude/settings.json", own);
    person.write(".claude.json", r#"{"mcpServers": {"facade": {"type": "stdio", "command": "/old/facade-mcp", "args": ["--guest", "claude"]}}}"#);
    let settings_file = person.file(".claude/settings.json");
    let listed = person.facade_ok(&test, &["integration", "list"]);
    assert_eq!(
        listed_as(&listed, "claude"),
        ("needs attention".to_string(), String::new()),
        "{listed}"
    );
    let added = person.facade_ok(&test, &["integration", "add", "claude"]);
    let settings_label = settings_file.display().to_string();
    assert!(
        added.starts_with("Added Facade to claude.\n")
            && part(&added, &settings_label) == Some("up to date")
            && part(&added, "Claude Code MCP servers") == Some("up to date"),
        "{added}"
    );
    let settings = person.json(".claude/settings.json");
    assert_eq!(
        (&settings["model"], &settings["permissions"]["allow"]),
        (&json!("opus"), &json!(["Bash(ls)", "mcp__facade"]))
    );
    let (home, launcher) = (
        shell_quoted(&test.path),
        shell_quoted(
            &test
                .path
                .join("core")
                .join("bin")
                .join(program_name("facade")),
        ),
    );
    for (event, name) in [
        ("session-start", "SessionStart"),
        ("prompt", "UserPromptSubmit"),
        ("turn-end", "Stop"),
        ("session-end", "SessionEnd"),
    ] {
        let command = settings["hooks"][name][0]["hooks"][0]["command"]
            .as_str()
            .unwrap_or_default();
        assert_eq!(
            command,
            format!("FACADE_HOME={home} {launcher} hook {event} --cli claude"),
            "the hooks run the launcher"
        );
    }
    let ran = person.claude_ran();
    assert_eq!(
        (ran.len(), ran[0].as_str()),
        (2, "mcp remove --scope user facade"),
        "an older Facade's server goes first: {ran:?}"
    );
    let server = test
        .path
        .join("core")
        .join("bin")
        .join(program_name("facade-mcp"));
    assert_eq!(
        ran[1],
        format!(
            "mcp add --scope user facade -e FACADE_HOME={} -- {} --guest claude",
            test.path.display(),
            server.display()
        ),
        "the launcher"
    );
    assert_eq!(
        person.json(".claude.json")["mcpServers"]["facade"]["args"],
        json!(["--guest", "claude"])
    );
    // A session the person starts joins through the start hook as written, and leaves through the
    // end hook.
    let start = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let joined = person.hook(
        &test,
        start,
        &json!({ "hook_event_name": "SessionStart", "session_id": "s1", "cwd": test.project }),
    );
    assert!(
        stdout(&joined).contains("You are Facade guest #a1"),
        "{joined:?}"
    );
    assert_eq!(
        with_session(&test, "s1").map(|guest| guest["guest"].clone()),
        Some(json!(true))
    );
    let end = settings["hooks"]["SessionEnd"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    assert!(
        person
            .hook(
                &test,
                end,
                &json!({ "hook_event_name": "SessionEnd", "session_id": "s1" })
            )
            .status
            .success()
    );
    assert!(
        wait_until(secs(10), || with_session(&test, "s1").is_none()),
        "the session did not leave"
    );
    // Adding again changes nothing.
    let written = person.read(".claude/settings.json").unwrap();
    person.facade_ok(&test, &["integration", "add", "claude"]);
    assert_eq!(person.read(".claude/settings.json").unwrap(), written);
    assert_eq!(
        person.claude_ran().len(),
        2,
        "Claude Code's command ran again: {:?}",
        person.claude_ran()
    );
    let listed = person.facade_ok(&test, &["integration", "list"]);
    let (status, at) = listed_as(&listed, "claude");
    assert!(status == "added" && at.ends_with(" ago"), "{listed}");
    assert_eq!(
        listed_as(&listed, "codex"),
        ("not added".to_string(), String::new()),
        "{listed}"
    );
    let removed = person.facade_ok(&test, &["integration", "remove", "claude"]);
    assert_eq!(
        person.read(".claude/settings.json").unwrap(),
        own,
        "the settings are back byte for byte"
    );
    assert_eq!(
        person.claude_ran().last().map(String::as_str),
        Some("mcp remove --scope user facade")
    );
    assert_eq!(person.json(".claude.json")["mcpServers"], json!({}));
    assert!(
        removed.starts_with("Removed Facade from claude.\n")
            && part(&removed, &settings_label) == Some("no Facade settings")
            && part(&removed, "Claude Code MCP servers") == Some("no Facade settings")
            && removed.lines().count() == 3,
        "{removed}"
    );
}

/// From a file the person changed since, `remove` takes Facade's entries out and keeps the person's
/// changes. An entry of Facade's the person changed stays, and the answer names it. A settings file
/// reached through a link stays a link.
#[test]
fn remove_keeps_the_person_s_changes_and_names_a_changed_entry_that_stays() {
    let test = TestHome::new("integrate-changed");
    let person = Person::new(&test);
    // The settings file is reached through a link on Unix. Windows makes links only in Developer
    // Mode, so there the person's file is the settings file itself.
    #[cfg(unix)]
    let settings_file = "dotfiles/claude-settings.json";
    #[cfg(windows)]
    let settings_file = ".claude/settings.json";
    person.write(settings_file, "{}\n");
    #[cfg(unix)]
    {
        std::fs::create_dir_all(person.file(".claude")).unwrap();
        std::os::unix::fs::symlink(
            person.file(settings_file),
            person.file(".claude/settings.json"),
        )
        .unwrap();
    }
    person.facade_ok(&test, &["integration", "add", "claude"]);
    #[cfg(unix)]
    assert!(
        person
            .file(".claude/settings.json")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link stays"
    );
    let mut settings = person.json(settings_file);
    settings["hooks"]["Stop"].as_array_mut().unwrap().insert(
        0,
        json!({ "hooks": [{ "type": "command", "command": "say done" }] }),
    );
    settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["timeout"] = json!(5);
    person.write(settings_file, &settings.to_string());
    let removing = person.facade(&test, &["integration", "remove", "claude"]);
    assert!(removing.status.success(), "{removing:?}");
    let (removed, noted) = (stdout(&removing), stderr(&removing));
    let file = person.file(".claude/settings.json");
    assert!(
        noted.contains(&format!(
            "note: {}: Facade's hooks.UserPromptSubmit stays: it changed since it was written\n",
            file.display()
        )),
        "{noted}"
    );
    assert!(
        removed.starts_with("Check claude's settings to confirm removal.\n")
            && part(&removed, &file.display().to_string()) == Some("needs attention"),
        "{removed}"
    );
    let left = person.json(settings_file);
    assert_eq!(
        left["hooks"]["Stop"],
        json!([{ "hooks": [{ "type": "command", "command": "say done" }] }])
    );
    assert_eq!(
        left["hooks"]["UserPromptSubmit"][0]["hooks"][0]["timeout"],
        json!(5)
    );
    assert!(
        left["hooks"].get("SessionStart").is_none()
            && left["hooks"].get("SessionEnd").is_none()
            && left.get("permissions").is_none(),
        "{left}"
    );
    #[cfg(unix)]
    assert!(
        person
            .file(".claude/settings.json")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link stays"
    );
}

/// Codex's, OpenCode's and Pi's entries: Codex's server table at the end of its config, beside the
/// person's text and comments, with its four hooks and a note that Codex asks to review them;
/// OpenCode's server, permission and plugin, in a folder of its own among the person's plugins;
/// Pi's extension. Removing puts back the files the person had and deletes the ones Facade made,
/// with the plugin's folder.
#[test]
fn codex_opencode_and_pi_entries_are_written_and_taken_out() {
    let test = TestHome::new("integrate-others");
    let person = Person::new(&test);
    let own = "# mine\nmodel = \"o3\"\n";
    person.write(".codex/config.toml", own);
    // The mode a file keeps is Unix's: Windows gives Facade's files no mode of their own.
    #[cfg(unix)]
    std::fs::set_permissions(
        person.file(".codex/config.toml"),
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    )
    .unwrap();
    let added = person.facade(&test, &["integration", "add", "codex"]);
    assert!(added.status.success(), "{added:?}");
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(
            &person
                .file(".codex/config.toml")
                .metadata()
                .unwrap()
                .permissions()
        ) & 0o777,
        0o600,
        "the file's mode stays"
    );
    assert!(
        stderr(&added).contains(
            "note: Codex asks you to review new hooks once, when it next starts: approve Facade's \
             for its sessions to join\n"
        ),
        "{added:?}"
    );
    let config = person.read(".codex/config.toml").unwrap();
    assert!(
        // An absolute path: from the root on Unix, from a drive on Windows.
        config.starts_with(&format!(
            "{own}\n[mcp_servers.facade]\ncommand = \"{}",
            if cfg!(windows) { "" } else { "/" }
        )) && config.contains("args = [\"--guest\",\"codex\"]\n"),
        "{config}"
    );
    assert!(
        config.contains("default_tools_approval_mode = \"approve\"\n"),
        "{config}"
    );
    let hooks = person.json(".codex/hooks.json");
    let command = hooks["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    #[cfg(unix)]
    assert!(command.ends_with("/facade' hook turn-end --cli codex"));
    #[cfg(windows)]
    assert!(
        powershell_script(command).is_some_and(|script| {
            script.contains("\\facade.exe' 'hook' 'turn-end' '--cli' 'codex'")
        }),
        "{command}"
    );
    person.write(
        ".config/opencode/plugins/theirs/index.js",
        "export default { id: \"theirs\", setup() {} };\n",
    );
    person.facade_ok(&test, &["integration", "add", "opencode"]);
    let plugin = person
        .read(".config/opencode/plugins/facade/index.js")
        .unwrap();
    assert!(
        plugin.starts_with("// Facade Code: written by `facade integration add`")
            && plugin.contains("\"--cli\", \"opencode\""),
        "{plugin}"
    );
    let opencode = person.json(".config/opencode/opencode.json");
    assert_eq!(
        opencode["mcp"]["facade"]["command"].as_array().unwrap()[1..],
        [json!("--guest"), json!("opencode")]
    );
    assert_eq!(opencode["permission"], json!({ "facade_*": "allow" }));
    person.facade_ok(&test, &["integration", "add", "pi"]);
    let extension = person.read(".pi/agent/extensions/facade.js").unwrap();
    assert!(
        extension.starts_with("// Facade Code: written by `facade integration add`")
            && extension.contains("\"--guest\",\"pi\""),
        "{extension}"
    );
    let listed = person.facade_ok(&test, &["integration", "list"]);
    for cli in ["codex", "opencode", "pi"] {
        assert_eq!(listed_as(&listed, cli).0, "added", "{cli}: {listed}");
    }
    for cli in ["codex", "opencode", "pi"] {
        person.facade_ok(&test, &["integration", "remove", cli]);
    }
    assert_eq!(person.read(".codex/config.toml").as_deref(), Some(own));
    for file in [
        ".codex/hooks.json",
        ".config/opencode/opencode.json",
        ".config/opencode/plugins/facade",
        ".pi/agent/extensions/facade.js",
    ] {
        assert!(!person.file(file).exists(), "{file} stayed");
    }
    assert!(
        person
            .file(".config/opencode/plugins/theirs/index.js")
            .exists(),
        "the person's plugin stays"
    );
    let listed = person.facade_ok(&test, &["integration", "list"]);
    assert!(
        Table::parse(&listed)
            .column("STATUS")
            .iter()
            .all(|status| *status == "not added"),
        "{listed}"
    );
}

/// Muse Code's and Antigravity's entries, and their hooks run as each CLI runs them.
/// - Muse Code's settings gain Facade's server, which names a Facade run's variables by reference,
///   and five hooks beside the person's own. Its start hook joins the session and gives the model
///   its instructions; its approval hook approves Facade's tools in a guest's session too.
/// - Antigravity gets Facade's server, a hook set and the approval of Facade's tools. Its start
///   hook answers a system message step, and its other hooks an empty object. A session ends when
///   the `agy` that ran its hook ends, and a session that joins from the same `agy` ends the one
///   before.
/// - Removing puts the person's settings back byte for byte and deletes the files Facade made.
#[test]
fn muse_and_antigravity_entries_are_written_and_their_hooks_join_and_end_sessions() {
    let test = TestHome::new("integrate-muse-agy");
    let person = Person::new(&test);
    // The help names these two among the CLIs `add` takes, as it names the other four.
    let help = person
        .facade_ok(&test, &["integration", "add", "--help"])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        help.contains("claude, codex, opencode, pi, muse or agy"),
        "{help}"
    );
    let own = "{\n  \"schema_version\": 1,\n  \"model\": \"m\"\n}\n";
    person.write(".config/muse/settings.json", own);
    person.facade_ok(&test, &["integration", "add", "muse"]);
    let settings = person.json(".config/muse/settings.json");
    assert_eq!(settings["model"], "m");
    assert_eq!(
        settings["mcpServers"]["facade"]["args"],
        json!(["--guest", "muse"])
    );
    assert_eq!(
        settings["mcpServers"]["facade"]["env"]["FACADE_AGENT"],
        "${FACADE_AGENT:-}"
    );
    let hook = |event: &str| {
        settings["hooks"][event][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let started = person.hook(
        &test,
        &hook("SessionStart"),
        &json!({ "hook_event_name": "SessionStart", "session_id": "muse-1" }),
    );
    let context: Value = facade_scenarios::serde_json::from_str(&stdout(&started)).unwrap();
    let told = context["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(told.starts_with("You are Facade guest #"), "{told}");
    assert!(
        with_session(&test, "muse-1")
            .is_some_and(|guest| guest["guest"] == true && guest["cli"] == "muse")
    );
    let asks = json!({
        "hook_event_name": "PermissionRequest", "session_id": "muse-1",
        "tool_name": "mcp__facade__send_message",
    });
    let approved: Value = facade_scenarios::serde_json::from_str(&stdout(&person.hook(
        &test,
        &hook("PermissionRequest"),
        &asks,
    )))
    .unwrap();
    assert_eq!(
        approved["hookSpecificOutput"]["decision"]["behavior"], "allow",
        "{approved}"
    );

    person.facade_ok(&test, &["integration", "add", "agy"]);
    assert_eq!(
        person.json(".gemini/config/mcp_config.json")["mcpServers"]["facade"]["args"],
        json!(["--guest", "agy"])
    );
    assert_eq!(
        person.json(".gemini/antigravity-cli/settings.json")["permissions"]["allow"],
        json!(["mcp(facade/*)"])
    );
    let hooks = person.json(".gemini/config/hooks.json");
    let agy_hook = |event: &str| {
        hooks["facade"][event][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    };
    // Antigravity runs its hooks through `sh -c` as its children: here `perl` stands for `agy`, and
    // ends 3 seconds after them.
    // On Windows Antigravity runs them with cmd.exe: there the test CLI stands for it, in its mode
    // that runs hooks.
    let agy = |inputs: &[Value]| {
        #[cfg(unix)]
        let mut command = {
            let script = "for my $i (0 .. $#ARGV / 2) { open(my $h, '|-', '/bin/sh', '-c', \
                          $ARGV[2 * $i]); print $h $ARGV[2 * $i + 1]; close($h); } sleep 3;";
            let mut perl = person.command(&test, "/usr/bin/perl");
            perl.args(["-e", script]);
            perl
        };
        #[cfg(windows)]
        let mut command = {
            let mut fake = person.command(&test, &test_binaries().fakecli);
            fake.env("FAKECLI_HOOKS", "1");
            fake
        };
        for input in inputs {
            command.args([
                agy_hook(input["hookEventName"].as_str().unwrap()),
                input.to_string(),
            ]);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let first =
        json!({ "hookEventName": "SessionStart", "conversationId": "agy-1", "cwd": test.project });
    let output = agy(&[first]).wait_with_output().unwrap();
    let steps: Value = facade_scenarios::serde_json::from_str(&stdout(&output)).unwrap();
    let told = steps["injectSteps"][0]["systemMessage"]["systemMessage"]
        .as_str()
        .unwrap();
    assert!(told.starts_with("You are Facade guest #"), "{told}");
    assert!(
        wait_until(secs(10), || with_session(&test, "agy-1").is_none()),
        "the session ends when its agy ends"
    );
    let prompt =
        json!({ "hookEventName": "PreInvocation", "conversationId": "agy-2", "invocationNum": 1 });
    let next = json!({ "hookEventName": "SessionStart", "conversationId": "agy-3" });
    let running = agy(&[prompt, next]);
    assert!(
        wait_until(secs(10), || with_session(&test, "agy-3").is_some()),
        "the next conversation joins"
    );
    assert!(
        with_session(&test, "agy-2").is_none(),
        "a conversation that joins from the same agy ends the one before"
    );
    let output = running.wait_with_output().unwrap();
    assert!(
        stdout(&output).starts_with("{}\n"),
        "a hook with nothing to say answers an empty object: {}",
        stdout(&output)
    );
    assert!(wait_until(secs(10), || with_session(&test, "agy-3").is_none()));

    person.facade_ok(&test, &["integration", "remove", "muse"]);
    person.facade_ok(&test, &["integration", "remove", "agy"]);
    assert_eq!(
        person.read(".config/muse/settings.json").as_deref(),
        Some(own)
    );
    for file in [
        ".gemini/config/mcp_config.json",
        ".gemini/config/hooks.json",
        ".gemini/antigravity-cli/settings.json",
    ] {
        assert!(!person.file(file).exists(), "{file} stayed");
    }
}

/// An entry of Facade's shape that the person had before `add` is theirs: after they change the
/// file, `remove` takes out what Facade added and leaves it (Core Review's S14). OpenCode's
/// `facade_*` rule here.
#[test]
fn remove_after_a_change_leaves_the_person_s_own_entry_of_facade_s_shape() {
    let test = TestHome::new("integrate-own-rule");
    let person = Person::new(&test);
    person.write(
        ".config/opencode/opencode.json",
        "{\n  \"permission\": {\n    \"facade_*\": \"allow\",\n    \"bash\": \"ask\"\n  }\n}\n",
    );
    person.facade_ok(&test, &["integration", "add", "opencode"]);
    let mut changed = person.json(".config/opencode/opencode.json");
    changed["theme"] = json!("dark");
    person.write(".config/opencode/opencode.json", &changed.to_string());
    person.facade_ok(&test, &["integration", "remove", "opencode"]);
    let left = person.json(".config/opencode/opencode.json");
    assert_eq!(
        left["permission"],
        json!({ "facade_*": "allow", "bash": "ask" }),
        "the person's own rule went: {left}"
    );
    assert!(
        left.get("mcp").is_none() && left["theme"] == "dark",
        "{left}"
    );
}

/// Nothing is written where a file holds a facade entry of the person's own, where Claude Code has
/// a facade server of the person's own or is not on PATH, or for a CLI Facade does not integrate.
#[test]
fn nothing_is_written_where_the_person_has_a_facade_of_their_own() {
    let test = TestHome::new("integrate-refused");
    let person = Person::new(&test);
    person.write(
        ".codex/config.toml",
        "[mcp_servers.facade]\ncommand = \"their-server\"\n",
    );
    let refused = person.facade(&test, &["integration", "add", "codex"]);
    assert!(!refused.status.success(), "{refused:?}");
    let config = person.file(".codex/config.toml");
    assert!(
        stderr(&refused).contains(&format!(
            "{}: it has a facade server of the person's own; nothing was written",
            config.display()
        )),
        "{refused:?}"
    );
    assert!(
        !person.file(".codex/hooks.json").exists(),
        "a file was written"
    );
    person.write(
        ".claude.json",
        r#"{"mcpServers":{"facade":{"type":"stdio","command":"npx","args":["their-facade"]}}}"#,
    );
    let refused = person.facade(&test, &["integration", "add", "claude"]);
    assert!(
        stderr(&refused)
            .contains("Claude Code has a facade server of the person's own; nothing was written"),
        "{refused:?}"
    );
    assert!(
        !person.file(".claude/settings.json").exists() && person.claude_ran().is_empty(),
        "something was written"
    );
    std::fs::remove_file(person.file(".claude.json")).unwrap();
    let mut command = person.command(&test, &test_binaries().facade);
    let without_claude = command
        .args(["integration", "add", "claude"])
        .env("PATH", SYSTEM_PATH.as_str())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        stderr(&without_claude).contains("claude is not on PATH"),
        "{without_claude:?}"
    );
    assert!(
        !person.file(".claude/settings.json").exists(),
        "a file was written"
    );
    let other = person.facade(&test, &["integration", "add", "vim"]);
    assert!(
        other.status.code() == Some(2)
            && stderr(&other).contains("'vim'")
            && stderr(&other).contains("claude, codex, opencode, pi, muse, agy"),
        "{other:?}"
    );
}

/// A path as a shell word, single-quoted, as Facade writes it in a hook. A run Facade starts beside
/// the entries `facade integration add` wrote keeps Facade's tools, the instructions they bring,
/// and Facade's skill, on every CLI the integration lists: what it writes is Facade's own, never a
/// `facade` server of the person's. Each run is the test CLI under its CLI's name, in the person's
/// HOME.
#[test]
fn a_run_beside_the_integration_keeps_facade_s_tools_and_skill() {
    let listed = {
        let test = TestHome::new("beside-list");
        Person::new(&test).facade_ok(&test, &["integration", "list"])
    };
    let table = Table::parse(&listed);
    let clis = table.column("CLI");
    assert_eq!(
        clis,
        ["claude", "codex", "opencode", "pi", "muse", "agy"],
        "the six CLIs Facade's rules know, the test CLI aside: {listed}"
    );
    for cli in clis {
        let test = TestHome::new(&format!("beside-{cli}"));
        let person = Person::new(&test);
        person.facade_ok(&test, &["integration", "add", cli]);
        let programs = test.path.parent().unwrap().join("programs");
        std::fs::create_dir_all(&programs).unwrap();
        install_program(&programs, cli, &test_binaries().fakecli);
        let mut start = person.command(&test, &test_binaries().facade);
        start.env(
            "PATH",
            format!(
                "{}{PATH_SEPARATOR}{}",
                programs.display(),
                test.path_with_test_programs()
            ),
        );
        let started = start
            .args(["start", "--name", "beside", cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        let run = test
            .agent_from_list_json("beside")
            .expect("the run is listed");
        let given = run["tools_state"] != "not_injected" && run["tools_reason"] != "not_given";
        assert!(
            given,
            "{cli}'s run was not given the tools: {run}\n{}",
            test.daemon_log()
        );
        assert!(
            has_the_skill(&test, cli, &run),
            "{cli}'s run was not given Facade's skill: {run}"
        );
    }
}

/// Whether `cli`'s run has Facade's skill where its CLI takes it: Claude Code in the plugin
/// `--plugin-dir` loads, Codex in a file of the run's its session-start hook gives with `--skill`,
/// Muse Code in a file of the run's its instructions hook gives, OpenCode and Pi in a file of the
/// run's, and Antigravity in the plugin in its project.
fn has_the_skill(test: &TestHome, cli: &str, run: &Value) -> bool {
    let runs = test
        .path
        .join("core/runs")
        .join(run["agent_id"].as_str().unwrap());
    let folder = std::fs::read_dir(&runs)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .expect("the run's folder");
    let skill = |file: PathBuf| {
        std::fs::read_to_string(file).is_ok_and(|text| text == facade_base::skill::text())
    };
    let command = command_line_of(run["pid"].as_i64().unwrap() as i32);
    // On Windows with the scripts of its encoded PowerShell hooks, each word quoted `'…'`.
    #[cfg(windows)]
    let command = {
        let scripts: Vec<String> = command
            .match_indices("powershell.exe ")
            .filter_map(|(at, _)| powershell_script(&command[at..]))
            .collect();
        format!("{command} {}", scripts.join(" ")).replace('\'', "")
    };
    match cli {
        "claude" => {
            command.contains("--plugin-dir") && skill(folder.join("plugin/skills/facade/SKILL.md"))
        }
        "codex" => command.contains("--skill") && skill(folder.join("skills/facade/SKILL.md")),
        "muse" => {
            command.contains("hook instructions muse")
                && skill(folder.join("skills/facade/SKILL.md"))
        }
        "opencode" | "pi" => skill(folder.join("skills/facade/SKILL.md")),
        "agy" => skill(
            test.project
                .join(".agents/plugins/facade/skills/facade/SKILL.md"),
        ),
        other => panic!("say where {other}'s run takes Facade's skill"),
    }
}

fn shell_quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
