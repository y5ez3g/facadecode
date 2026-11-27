//! The normal path of each CLI Facade Code Framework starts by name, with the test CLI standing in for it: it is
//! listed, gets Facade Code Framework's tools and instructions, takes its first message and a
//! message of any writing, reports its session, and is resumed in exactly that session, as is a
//! session saved outside Facade Code Framework. The stand-in reads what the run was given where its CLI reads it
//! and starts nothing when that is missing.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

const FIRST: &str = "019e4482-2bae-7a45-b193-a5664c19826a";
const OUTSIDE: &str = "019e4482-2bae-7a45-b193-a5664c19826b";
const AT: &str = "2026-11-23T00:00:00.000Z";

/// Chinese, an emoji of several code points, a combining mark, and more lines than one.
const ANY_WRITING: &str = "你好，世界 👩‍💻\ncafe\u{301} — “quoted”\n第三行 🇯🇵";

/// What a CLI's run must hold, as its CLI reads it.
struct Provider {
    cli: &'static str,
    display_name: &'static str,
    native: Native,
    /// The words of every launch.
    launch: &'static [&'static str],
    /// The words of a launch with YOLO on, and with it off.
    yolo: [&'static [&'static str]; 2],
    /// The ID of a session of the CLI's, as it spells one.
    id: fn(&str) -> String,
    /// Checks that the run's configuration approves Facade Code Framework's own tools and nothing else.
    approves_only_facade: fn(&Given),
    /// Files of the person's own settings, from their home.
    own_settings: &'static [(&'static str, &'static str)],
    /// Checks that the run keeps the person's own settings, where it gives the CLI a copy.
    keeps_own_settings: fn(&Given),
    /// Saves a session of the project as the CLI does.
    save: fn(&Place, id: &str, name: &str),
}

/// Where a stand-in runs: its home, its project in that home, and the folder for temporary files.
struct Place {
    user: PathBuf,
    project: PathBuf,
    tmp: PathBuf,
}

/// What a run was given.
struct Given<'a> {
    args: &'a [String],
    home: &'a Path,
    user: &'a Path,
    project: &'a Path,
}

impl Given<'_> {
    /// The JSON file the arguments name after `option`.
    fn file(&self, option: &str) -> Value {
        let file = option_value(self.args, option).unwrap();
        facade_scenarios::serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    /// The Facade Code Framework server, as `mcpServers.facade`.
    fn server(&self, provider: &Provider) -> Value {
        let devin_config =
            option_value(self.args, "--config").and_then(|path| Path::new(path).ancestors().nth(2));
        provider
            .native
            .mcp_settings(self.args, self.home, self.user, self.project, devin_config)
            .unwrap()
            .expect("the run's configuration")["mcpServers"]["facade"]
            .clone()
    }

    /// The words that start Facade Code Framework's relay: the server's own, or the run's script's.
    fn relay(&self, provider: &Provider) -> String {
        let server = self.server(provider);
        let words = server["args"].to_string();
        match provider.native {
            Native::Kiro => {
                let args = server["args"].as_array().unwrap();
                #[cfg(unix)]
                let script = args.last().unwrap().as_str().unwrap();
                #[cfg(windows)]
                let script = {
                    let args: Vec<_> = args.iter().map(|word| word.as_str().unwrap()).collect();
                    let program = server["command"].as_str().unwrap();
                    let command = format!("{program} {}", args.join(" "));
                    let decoded = powershell_script(&command).expect("Kiro's encoded launcher");
                    decoded
                        .strip_prefix("& ([scriptblock]::Create([IO.File]::ReadAllText('")
                        .and_then(|path| path.strip_suffix("'))); exit $LASTEXITCODE"))
                        .expect("the launcher reads the private relay script")
                        .replace("''", "'")
                };
                #[cfg(windows)]
                let script = script.as_str();
                let script = in_run_folder(Path::new(script), self.home).unwrap();
                #[cfg(windows)]
                assert_eq!(script.file_name().unwrap(), "kiro-relay.ps1");
                std::fs::read_to_string(script).unwrap()
            }
            _ => words,
        }
    }
}

const UUID: fn(&str) -> String = |id| id.to_string();

const OMP: Provider = Provider {
    cli: "omp",
    display_name: "Oh My Pi",
    native: Native::Omp,
    launch: &[],
    yolo: [
        &["--approval-mode", "yolo"],
        &["--approval-mode", "always-ask"],
    ],
    id: UUID,
    approves_only_facade: |given| {
        let overlay = given.file("--config");
        let mut approved: Vec<&String> = overlay["tools"]["approval"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        let mut wanted: Vec<String> = facade_tools()
            .iter()
            .map(|tool| format!("mcp__facade_managed_facade_{tool}"))
            .collect();
        approved.sort();
        wanted.sort();
        assert_eq!(approved, wanted.iter().collect::<Vec<_>>(), "{overlay}");
        let values = overlay["tools"]["approval"].as_object().unwrap();
        assert!(values.values().all(|value| value == "allow"), "{overlay}");
        assert!(
            overlay["tools"].get("approvalMode").is_none(),
            "{overlay}: the approval mode is the launch's"
        );
        assert!(overlay.get("composer").is_none(), "{overlay}");
    },
    own_settings: &[(".omp/agent/config.yml", "tools:\n  approvalMode: write\n")],
    keeps_own_settings: |_| {},
    save: |place, id, name| {
        save_omp_session(place, id, &omp_session_head(id, &place.project, name, AT));
    },
};

const DEVIN: Provider = Provider {
    cli: "devin",
    display_name: "Devin",
    native: Native::Devin,
    launch: &["--process-model", "in-process"],
    yolo: [&["--permission-mode", "dangerous"], &[]],
    id: UUID,
    approves_only_facade: |given| {
        let config = given.file("--config");
        assert_eq!(
            config["permissions"],
            json!({ "allow": ["Read(docs/**)", "mcp__facade__*"], "deny": ["Exec(rm)"] }),
            "the person's own rules and Facade Code Framework's one"
        );
        let trusts = given
            .args
            .iter()
            .any(|word| word.starts_with("--respect-workspace-trust"));
        assert!(!trusts, "{:?}", given.args);
    },
    own_settings: &[
        (
            ".config/devin/config.json",
            r#"{"theme":"own","permissions":{"allow":["Read(docs/**)"],"deny":["Exec(rm)"]},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"exit 0"}]}]}}"#,
        ),
        (
            ".config/devin/mcp_config.json",
            r#"{"mcpServers":{"own":{"command":"own-server"}}}"#,
        ),
        (".config/devin/models-example.json", "{}"),
        // A folder of another program's in the configuration folder the run stands in for.
        (".config/git/config", "[user]\n\tname = Own\n"),
    ],
    keeps_own_settings: |given| {
        let config = given.file("--config");
        assert_eq!(config["theme"], "own");
        assert_eq!(
            config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "exit 0"
        );
        let file = Path::new(option_value(given.args, "--config").unwrap());
        let servers = std::fs::read_to_string(file.with_file_name("mcp_config.json")).unwrap();
        assert!(servers.contains("own-server"), "{servers}");
        assert_eq!(
            std::fs::read_to_string(file.with_file_name("models-example.json")).unwrap(),
            "{}"
        );
    },
    save: |place, id, name| {
        let folder = place.user.join(if cfg!(windows) {
            "AppData/Local/devin"
        } else {
            ".local/share/devin"
        });
        std::fs::create_dir_all(&folder).unwrap();
        let db = rusqlite::Connection::open(folder.join("sessions.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
             title TEXT, hidden INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL)",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES (?1, ?2, ?3, 0, 1795392000)",
            [id, &place.project.to_string_lossy(), name],
        )
        .unwrap();
    },
};

const QODER: Provider = Provider {
    cli: "qoder",
    display_name: "Qoder",
    native: Native::Qoder,
    launch: &[],
    yolo: [&["--permission-mode", "bypass_permissions"], &[]],
    id: UUID,
    approves_only_facade: |given| {
        let servers = given.file("--mcp-config");
        assert_eq!(servers["mcpServers"].as_object().unwrap().len(), 1);
        assert_eq!(servers["mcpServers"]["facade"]["trust"], true);
        let settings = given.file("--settings");
        assert!(settings["permissions"].is_null(), "{settings}");
        assert_eq!(settings.as_object().unwrap().len(), 1);
    },
    own_settings: &[(
        ".qoder/settings.json",
        r#"{"permissions":{"allow":["Read"]}}"#,
    )],
    keeps_own_settings: |_| {},
    save: |place, id, name| {
        let folder: String = place
            .project
            .to_string_lossy()
            .encode_utf16()
            .map(|unit| match u8::try_from(unit) {
                Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
                _ => '-',
            })
            .collect();
        let folder = place.user.join(".qoder/projects").join(folder);
        std::fs::create_dir_all(&folder).unwrap();
        let user = qoder_record(id, "user", "the first prompt", &place.project);
        let answer = qoder_record(id, "assistant", "the answer", &place.project);
        let title = json!({ "type": "custom-title", "sessionId": id, "customTitle": name });
        std::fs::write(
            folder.join(format!("{id}.jsonl")),
            format!("{user}{answer}{title}\n"),
        )
        .unwrap();
    },
};

const CURSOR: Provider = Provider {
    cli: "agent",
    display_name: "Cursor",
    native: Native::Cursor,
    launch: &[],
    yolo: [&["--force", "--sandbox", "disabled"], &[]],
    id: UUID,
    // Cursor's own permissions decide on every call: the run adds none.
    approves_only_facade: |given| {
        assert!(
            !given
                .args
                .iter()
                .any(|word| word.contains("approve") || word.contains("allow")),
            "{:?}",
            given.args
        );
    },
    own_settings: &[
        (
            ".cursor/mcp.json",
            r#"{"mcpServers":{"own":{"command":"own-server"}}}"#,
        ),
        (
            ".config/cursor/cli-config.json",
            r#"{"permissions":{"allow":[],"deny":["Shell(rm)"]}}"#,
        ),
    ],
    keeps_own_settings: |_| {},
    save: |place, id, name| {
        save_cursor_session(&place.user, id, &place.project, Some(name), true);
    },
};

const KIRO: Provider = Provider {
    cli: "kiro-cli",
    display_name: "Kiro",
    native: Native::Kiro,
    launch: &["chat", "--v3"],
    yolo: [&["--trust-all-tools"], &[]],
    id: |id| format!("sess_{id}"),
    approves_only_facade: |given| {
        let agent = kiro_agent(given.args, given.user, given.project)
            .unwrap()
            .unwrap();
        let name = agent["name"].as_str().unwrap();
        assert_eq!(
            agent["permissions"],
            json!({ "rules": [
                { "capability": "mcp", "match": [format!("{name}/*")], "effect": "allow" },
            ] })
        );
        assert!(
            !agent.to_string().contains("--run-credential"),
            "the workspace's file holds no credential"
        );
    },
    own_settings: &[
        (
            ".kiro/settings/mcp.json",
            r#"{"mcpServers":{"own":{"command":"own-server"}}}"#,
        ),
        ("project/.kiro/agents/own.json", r#"{"name":"own"}"#),
    ],
    keeps_own_settings: |_| {},
    save: |place, id, name| {
        save_kiro_session(&place.user, id, &place.project, name, None);
    },
};

/// Saves Oh My Pi session `id` of the project with the file's `head`.
fn save_omp_session(place: &Place, id: &str, head: &str) {
    // Upstream's session-paths.ts: a folder under the home is named by its path from there.
    let folder = place.user.join(".omp/agent/sessions/-project");
    std::fs::create_dir_all(&folder).unwrap();
    let user = omp_message(1, "user", "the first prompt", AT);
    let answer = omp_message(2, "assistant", "the answer", AT);
    std::fs::write(
        folder.join(format!("2026-11-23T00-00-00-000Z_{id}.jsonl")),
        format!("{head}{user}{answer}"),
    )
    .unwrap();
}

const PROVIDERS: [&Provider; 5] = [&DEVIN, &CURSOR, &KIRO, &QODER, &OMP];

/// The names of the tools Facade Code Framework gives a run.
fn facade_tools() -> Vec<String> {
    let definitions: Vec<Value> =
        facade_scenarios::serde_json::from_str(facade_base::tools::DEFINITIONS).unwrap();
    definitions
        .iter()
        .filter_map(|tool| Some(tool["name"].as_str()?.to_string()))
        .collect()
}

/// A home with the stand-in installed under the CLI's program name.
struct Stand {
    provider: &'static Provider,
    home: TestHome,
    place: Place,
    path: String,
}

impl Stand {
    fn new(provider: &'static Provider, test: &str) -> Stand {
        let home = TestHome::new(&format!("{}-{test}", provider.cli));
        let programs = home.folder().join("programs");
        install_program(&programs, provider.cli, &test_binaries().fakecli);
        let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
        let user = home.user_home();
        std::fs::create_dir_all(user.join("project")).unwrap();
        let place = Place {
            project: facade_base::files::real_path(&user.join("project")).unwrap(),
            tmp: home.folder().join("tmp"),
            user,
        };
        std::fs::create_dir_all(&place.tmp).unwrap();
        Stand {
            provider,
            home,
            place,
            path,
        }
    }

    fn args_file(&self) -> PathBuf {
        self.home.folder().join("stand-in.args")
    }

    fn mcp_initialize_file(&self) -> PathBuf {
        self.home.folder().join("stand-in.initialize")
    }

    fn keys_file(&self) -> PathBuf {
        self.home.folder().join("stand-in.keys")
    }

    /// The variables the stand-in and its CLI's history are read with.
    fn env(&self) -> Vec<(&'static str, String)> {
        let transcripts = self.home.folder().join("transcripts");
        std::fs::create_dir_all(&transcripts).unwrap();
        vec![
            ("PATH", self.path.clone()),
            ("HOME", self.place.user.display().to_string()),
            ("TMPDIR", self.place.tmp.display().to_string()),
            ("FAKECLI_LOOK", self.provider.cli.to_string()),
            ("FAKECLI_HINT", "ctrl+t to change".to_string()),
            ("FAKECLI_ARGS", self.args_file().display().to_string()),
            (
                "FAKECLI_MCP_INITIALIZE",
                self.mcp_initialize_file().display().to_string(),
            ),
            ("FAKECLI_TRANSCRIPTS", transcripts.display().to_string()),
            ("FAKECLI_LOG", self.home.fake_log.display().to_string()),
        ]
    }

    /// The command's isolated launch environment, supplied through the test protocol call.
    fn protocol_env(&self) -> std::collections::BTreeMap<&'static str, String> {
        let mut env = std::collections::BTreeMap::new();
        #[cfg(windows)]
        env.extend(
            PASSED_THROUGH
                .iter()
                .filter_map(|&name| std::env::var(name).ok().map(|value| (name, value))),
        );
        env.extend(self.home.isolating_env());
        env.extend(self.env());
        env
    }

    /// Starts the CLI as `ada` in the project through the protocol, its new session `session`.
    fn start(
        &self,
        session: Option<&str>,
        prompt: Option<&str>,
        (cols, rows): (u16, u16),
    ) -> Value {
        let mut env = self.protocol_env();
        if let Some(session) = session {
            env.insert("FAKECLI_SESSION", session.to_string());
        }
        let mut args = json!({
            "name": "ada", "cli": self.provider.cli, "folder": self.place.project, "env": env,
            "size": { "cols": cols, "rows": rows },
        });
        if let Some(prompt) = prompt {
            args["prompt"] = json!(prompt);
            if self.provider.native == Native::Kiro {
                args["env"]["FAKECLI_KEYS"] = json!(self.keys_file());
                // More than two 100 ms reads, within the existing one-second echo cap.
                args["env"]["FAKECLI_KIRO_SPACE_DELAY_MS"] = json!("450");
            }
        }
        let started = connect(&self.home).call("agent.start", args);
        assert!(started["result"].is_object(), "{started}");
        started["result"]["agent"].clone()
    }

    /// Runs `facade` in the project, as the person does.
    fn facade(&self, args: &[&str], more: &[(&str, &str)]) -> String {
        let output = self.run(args, more);
        assert!(
            output.status.success(),
            "facade {args:?}: {}{}",
            stdout(&output),
            stderr(&output)
        );
        stdout(&output)
    }

    fn run(&self, args: &[&str], more: &[(&str, &str)]) -> std::process::Output {
        self.home
            .command(&test_binaries().facade)
            .envs(self.env())
            .envs(more.iter().copied())
            .current_dir(&self.place.project)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    /// The arguments the stand-in was started with; the file goes, for the next start.
    fn arguments(&self) -> Vec<String> {
        let file = self.args_file();
        let mut args = None;
        assert!(
            wait_until(LOADED_TIMEOUT, || {
                args = std::fs::read_to_string(&file)
                    .ok()
                    .and_then(|text| facade_scenarios::serde_json::from_str(&text).ok());
                args.is_some()
            }),
            "the stand-in did not start: {}",
            self.home.daemon_log()
        );
        std::fs::remove_file(&file).unwrap();
        args.unwrap()
    }

    fn row_of(&self, agent: &Value) -> Value {
        let id = agent["reference"]["agent_id"].as_str().unwrap();
        self.home.agent_record(id).unwrap_or_default()
    }

    fn row(&self, name: &str) -> Value {
        self.home.agent_from_watch(name).unwrap_or_default()
    }

    /// Waits until the agent's record reads `value` at `field`.
    fn reads(&self, name: &str, field: &str, value: &str) {
        assert!(
            wait_until(secs(30), || self.row(name)[field] == value),
            "{}: {field} is not {value}: {}\n{}\n{}",
            self.provider.cli,
            self.row(name),
            self.home.screen(name),
            self.home.daemon_log()
        );
    }

    /// Sends `text` to the agent and requires that the CLI took it once, as it was written.
    fn send(&self, name: &str, text: &str) {
        let before = self.home.submitted_messages().len();
        let sent = self.run(&["send", name, text, "-w"], &[]);
        let received = sent.status.success()
            && wait_until(secs(10), || self.home.submitted_messages().len() > before);
        let taken = self.home.submitted_messages();
        assert!(
            received && taken.len() == before + 1,
            "{}: {}{}\n{taken:?}\n{}\n{}",
            self.provider.cli,
            stdout(&sent),
            stderr(&sent),
            self.home.inspect_agent(name)["input"],
            self.home.screen(name)
        );
        let (_, body) = taken[before].split_once('\n').expect("a header line");
        assert_eq!(body, text);
    }

    /// Checks what a launch with YOLO on or off was given, and that its tools connected through it.
    fn is_wired(&self, name: &str, args: &[String], yolo: bool) {
        let provider = self.provider;
        self.reads(name, "tools_state", "available");
        let given = Given {
            args,
            home: &self.home.path,
            user: &self.place.user,
            project: &self.place.project,
        };
        let [on, off] = provider.yolo;
        let (with, without) = if yolo { (on, off) } else { (off, on) };
        assert_eq!(words_found(args, provider.launch), 1, "{args:?}");
        assert_eq!(words_found(args, with), 1, "{args:?}");
        assert!(
            without.is_empty() || words_found(args, without) == 0,
            "{args:?}"
        );
        assert!(
            given.relay(provider).contains("--run-credential"),
            "{}'s run has a credential of its own",
            provider.cli
        );
        assert!(given.server(provider)["env"]["FACADE_HOME"].is_string());
        let initialize = self.mcp_initialize_file();
        assert!(wait_until(secs(5), || initialize.is_file()));
        let reply: Value =
            facade_scenarios::serde_json::from_str(&std::fs::read_to_string(initialize).unwrap())
                .unwrap();
        let instructions = reply["result"]["instructions"].as_str().unwrap_or_default();
        assert!(instructions.contains("Your address is "), "{reply}");
        let yolo_line = if yolo { "YOLO is on" } else { "YOLO is off" };
        assert!(instructions.contains(yolo_line), "{reply}");
        (provider.approves_only_facade)(&given);
        (provider.keeps_own_settings)(&given);
    }

    /// Writes the person's own settings.
    fn write_own_settings(&self) {
        for (file, text) in self.provider.own_settings {
            let file = self.own_settings_file(file);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
    }

    fn own_settings_file(&self, file: &str) -> PathBuf {
        let file = Path::new(file);
        if cfg!(windows) && self.provider.native == Native::Devin {
            return self.place.user.join("AppData/Roaming").join(
                file.strip_prefix(".config")
                    .expect("Devin's own files are under the configuration root"),
            );
        }
        self.place.user.join(file)
    }
}

/// How many times `words` stand in `args`, one after another.
fn words_found(args: &[String], words: &[&str]) -> usize {
    if words.is_empty() {
        return 1;
    }
    args.windows(words.len())
        .filter(|found| *found == words)
        .count()
}

/// Starts the CLI with a first message, sends it one of any writing, and resumes exactly its
/// session. The person's own settings stay as they wrote them, and the project keeps no file of the
/// run's.
fn starts_takes_messages_and_resumes_its_session(provider: &'static Provider) {
    let stand = Stand::new(provider, "normal");
    stand.write_own_settings();
    let before = files_in(&stand.place.project);
    let session = (provider.id)(FIRST);
    let resume = provider.native.resume_option();

    let agent = stand.start(Some(&session), Some("say hi"), (120, 30));
    assert_eq!(agent["cli"], provider.cli, "{agent}");
    let id = agent["reference"]["agent_id"].clone();
    let args = stand.arguments();
    stand.is_wired("ada", &args, true);
    assert_eq!(words_found(&args, &[resume]), 0, "a new session");
    assert!(
        wait_until(secs(30), || !stand.home.submitted_messages().is_empty()),
        "{}: {}\n{}\n{}",
        provider.cli,
        stand.home.inspect_agent("ada")["input"],
        stand.home.screen("ada"),
        stand.home.daemon_log()
    );
    let first = stand.home.submitted_messages();
    assert_eq!(first.len(), 1, "{first:?}");
    assert!(first[0].ends_with("\nsay hi"), "{first:?}");
    if provider.native == Native::Kiro {
        let keys = std::fs::read(stand.keys_file()).unwrap();
        let paste = keys
            .strip_prefix(b" \x7f\x1b[200~")
            .and_then(|keys| keys.strip_suffix(b"\x1b[201~\r"))
            .unwrap_or_else(|| panic!("expected Space, Backspace, paste, and Enter: {keys:?}"));
        assert!(!paste.contains(&0x1b), "{keys:?}");
    }
    // The CLI saved the session with its first message.
    stand.reads("ada", "session", &session);
    if matches!(
        provider.native,
        Native::Devin | Native::Kiro | Native::Qoder
    ) {
        retry_after_clearing_a_draft(&stand);
    }
    stand.send("ada", ANY_WRITING);
    stand.send("ada", "one line");

    let pid = stand.row("ada")["pid"].clone();
    stand.facade(&["stop", "ada"], &[]);
    keeps_no_file(&stand, &before);
    if provider.native == Native::Cursor {
        let folder = cursor_session(&stand.place.user, &session);
        let meta = cursor_metadata(&folder);
        assert_eq!(meta["hasConversation"], true, "{meta}");
        assert!(meta.get("title").is_none(), "{meta}");
        assert!(folder.join("store.db").is_file());
        for wire in [&mut connect(&stand.home), &mut editor_of(&stand.home)] {
            let items = saved_sessions(wire, &stand.place.project);
            assert_eq!(items.len(), 1, "{items:?}");
            assert_eq!(
                items[0]["target"],
                json!({ "kind": "agent", "reference": agent["reference"] }),
                "{items:?}"
            );
        }
    }
    stand.facade(&["resume", "-d", "ada"], &[]);
    let args = stand.arguments();
    assert_eq!(words_found(&args, &[resume, &session]), 1, "{args:?}");
    assert_eq!(
        args.iter().filter(|word| **word == session).count(),
        1,
        "{args:?}"
    );
    stand.is_wired("ada", &args, true);
    let resumed = stand.row("ada");
    assert_eq!(resumed["reference"]["agent_id"], id, "{resumed}");
    assert_ne!(resumed["pid"], pid, "{resumed}");
    assert!(wait_for_screen_text(
        &stand.home,
        "ada",
        &format!("session {session}")
    ));
    stand.reads("ada", "session", &session);
    stand.send("ada", ANY_WRITING);
    stand.facade(&["stop", "ada"], &[]);
    keeps_no_file(&stand, &before);
    for (file, text) in provider.own_settings {
        let file = stand.own_settings_file(file);
        assert_eq!(std::fs::read_to_string(file).unwrap(), *text);
    }
}

fn retry_after_clearing_a_draft(stand: &Stand) {
    let draft = stand.provider.native.empty_words();
    let mut wire = connect(&stand.home);
    type_raw(&mut wire, "ada", draft);
    assert!(
        wait_until(secs(5), || {
            stand.home.inspect_agent("ada")["input"]["state"] == "draft"
                && stand.home.screen("ada").contains(draft)
        }),
        "{}",
        stand.home.inspect_agent("ada")["input"]
    );
    let before = stand.home.submitted_messages();
    let message = "send this after I clear the draft";
    let held = stand.run(&["send", "ada", message, "-w", "-t", "4"], &[]);
    assert!(
        !held.status.success() && stderr(&held).contains("Its terminal has an unfinished draft."),
        "{}",
        stderr(&held)
    );
    assert_eq!(stand.home.submitted_messages(), before);
    assert!(stand.home.screen("ada").contains(draft));
    type_raw(&mut wire, "ada", "\x03");
    stand.send("ada", message);
}

fn editor_of(home: &TestHome) -> DaemonTestClient {
    let mut wire = DaemonTestClient::open(home);
    let hello = wire.hello("ide", DAEMON_API_VERSIONS, json!({}));
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    wire
}

fn cursor_metadata(folder: &Path) -> Value {
    let meta = std::fs::read_to_string(folder.join("meta.json")).unwrap();
    facade_scenarios::serde_json::from_str(&meta).unwrap()
}

/// The project has the files it had `before` the run, once the run's are gone.
fn keeps_no_file(stand: &Stand, before: &[PathBuf]) {
    assert!(
        wait_until(secs(30), || files_in(&stand.place.project) == before),
        "{:?}\n{}",
        files_in(&stand.place.project),
        stand.home.daemon_log()
    );
}

/// The files in `folder`, from there.
fn files_in(folder: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(folder).unwrap().flatten() {
        match entry.path().is_dir() {
            true => found.extend(files_in(&entry.path())),
            false => found.push(entry.path()),
        }
    }
    found.sort();
    found
}

/// A launch with YOLO off gets its words, and Facade Code Framework's own tools stay the only ones approved.
fn asks_with_yolo_off(provider: &'static Provider) {
    let stand = Stand::new(provider, "asks");
    stand.write_own_settings();
    std::fs::write(stand.home.path.join("facade.json"), r#"{"yolo": false}"#).unwrap();
    stand.start(Some(&(provider.id)(FIRST)), None, (120, 30));
    let args = stand.arguments();
    stand.is_wired("ada", &args, false);
}

/// The sessions of `folder` that can be resumed.
fn saved_sessions(wire: &mut DaemonTestClient, folder: &Path) -> Vec<Value> {
    let list = wire.call_ok(
        "agent.resume_list",
        json!({ "scope": { "kind": "local" }, "folder": folder, "folder_scope": "all" }),
    );
    list["items"].as_array().unwrap().clone()
}

/// A session the person saved outside Facade Code Framework is listed for its folder alone, under its native name,
/// and resumed exactly.
fn resumes_a_session_saved_outside(provider: &'static Provider) {
    resume_external_session(provider, None);
}

fn resume_external_session(provider: &'static Provider, profile: Option<&str>) {
    let stand = Stand::new(provider, "outside");
    let session = (provider.id)(OUTSIDE);
    if let Some(profile) = profile {
        save_kiro_session(
            &stand.place.user,
            &session,
            &stand.place.project,
            "修复构建",
            Some(profile),
        );
    } else {
        (provider.save)(&stand.place, &session, "修复构建");
    }
    stand.facade(&["daemon", "--detach"], &[]);
    let env = stand.protocol_env();
    let mut wire = connect(&stand.home);
    let items = saved_sessions(&mut wire, &stand.place.project);
    assert_eq!(items.len(), 1, "{items:?}\n{}", stand.home.daemon_log());
    let target = items[0]["target"].clone();
    assert_eq!(
        (&target["kind"], &target["cli"], &target["session"]),
        (&json!("session"), &json!(provider.cli), &json!(session))
    );
    assert!(
        items[0].to_string().contains("修复构建"),
        "its native name: {items:?}"
    );
    let other = stand.place.user.join("another");
    std::fs::create_dir_all(&other).unwrap();
    assert_eq!(saved_sessions(&mut wire, &other), Vec::<Value>::new());
    let resumed = wire.call(
        "agent.resume",
        json!({ "target": target, "env": env, "size": { "cols": 120, "rows": 30 } }),
    );
    let agent = &resumed["result"]["agent"];
    assert_eq!(agent["session"], session, "{resumed}");
    let args = stand.arguments();
    let resume = provider.native.resume_option();
    assert_eq!(words_found(&args, &[resume, &session]), 1, "{args:?}");
    if provider.native == Native::Kiro && profile.is_none() {
        // The vendor's own limit: a session keeps the agent it was started with, so one started
        // outside Facade Code Framework has none of Facade Code Framework's tools, and its record says so.
        assert!(
            wait_until(secs(10), || stand.row_of(agent)["tools_state"]
                == "unavailable"),
            "{}",
            stand.row_of(agent)
        );
        assert_eq!(words_found(&args, &["--agent"]), 0, "{args:?}");
    } else {
        if let Some(profile) = profile {
            assert_eq!(option_value(&args, "--agent"), Some(profile));
        }
        assert!(
            wait_until(secs(30), || stand.row_of(agent)["tools_state"]
                == "available"),
            "{}",
            stand.row_of(agent)
        );
    }
}

/// The CLIs are listed under their own names, after those of earlier releases.
#[test]
fn each_cli_is_listed_under_its_name() {
    let home = TestHome::new("providers");
    let clis = connect(&home).call_ok("cli.list", json!({}))["clis"].clone();
    for provider in PROVIDERS {
        let rows: Vec<&Value> = clis
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["cli"] == provider.cli)
            .collect();
        assert_eq!(rows.len(), 1, "{}: {clis}", provider.cli);
        assert_eq!(rows[0]["display_name"], provider.display_name);
    }
    let names: Vec<&str> = PROVIDERS.iter().map(|provider| provider.cli).collect();
    let listed: Vec<&str> = clis
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["cli"].as_str())
        .filter(|cli| *cli != "fake")
        .collect();
    let earlier = ["claude", "codex", "agy", "muse", "opencode", "pi"];
    assert_eq!(
        listed,
        [&earlier[..], &names[..], &["copilot"]].concat(),
        "in this order"
    );
    // What a model reads of the CLIs it can start.
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open_configured(&home, "a1");
    let tools = ada.request("tools/list", json!({}))["result"]["tools"].clone();
    let start = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "start_agent")
        .unwrap();
    let says = start["inputSchema"]["properties"]["cli"]["description"]
        .as_str()
        .unwrap();
    let words: Vec<&str> = says
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
        .collect();
    for cli in listed {
        assert!(words.contains(&cli), "{cli}: {says}");
    }
}

#[test]
fn shell_starts_built_ins_by_their_cli_command_names() {
    for provider in PROVIDERS {
        let stand = Stand::new(provider, "command-name");
        stand.write_own_settings();
        let session = (provider.id)(FIRST);
        stand.facade(
            &["start", "-d", "--name", "ada", provider.cli],
            &[("FAKECLI_SESSION", &session)],
        );
        let args = stand.arguments();
        assert_eq!(stand.row("ada")["cli"], provider.cli);
        stand.is_wired("ada", &args, true);
    }
}

#[test]
fn shell_refuses_retired_built_in_cli_names() {
    let home = TestHome::new("retired-cli-names");
    let programs = home.folder().join("programs");
    let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
    for name in ["agent", "kiro-cli", "qoder"] {
        install_program(&programs, name, &test_binaries().fakecli);
    }
    for name in ["cursor", "cursor-agent", "kiro", "qodercli"] {
        let denied = home
            .command(&test_binaries().facade)
            .args(["start", "-d", name])
            .env("PATH", &path)
            .output()
            .unwrap();
        assert!(!denied.status.success(), "{name}: {}", stdout(&denied));
        let error = stderr(&denied);
        assert!(
            error.contains(&format!("CLI {name:?} is not configured.")),
            "{error}"
        );
    }
}

#[test]
fn devin_starts_takes_messages_and_resumes_its_session() {
    starts_takes_messages_and_resumes_its_session(&DEVIN);
}

#[test]
fn devin_asks_with_yolo_off() {
    asks_with_yolo_off(&DEVIN);
}

#[test]
fn a_session_devin_saved_outside_facade_is_resumed() {
    resumes_a_session_saved_outside(&DEVIN);
}

#[test]
fn messages_of_every_size_reach_devin() {
    messages_of_every_size_arrive(&DEVIN);
}

#[test]
fn cursor_starts_takes_messages_and_resumes_its_session() {
    starts_takes_messages_and_resumes_its_session(&CURSOR);
}

#[test]
fn cursor_cannot_resume_a_startup_id_without_a_saved_conversation() {
    let stand = Stand::new(&CURSOR, "startup-only");
    let agent = stand.start(Some(FIRST), None, (120, 30));
    stand.arguments();
    stand.reads("ada", "session", FIRST);
    let live = stand.home.listed_agent("ada").expect("the running Cursor");
    assert_eq!(live["reference"], agent["reference"], "{live}");
    assert_eq!(stand.row_of(&agent)["process"], "running");
    let folder = cursor_session(&stand.place.user, FIRST);
    let meta = cursor_metadata(&folder);
    assert_eq!(meta["cwd"], json!(stand.place.project), "{meta}");
    assert_eq!(meta["hasConversation"], false, "{meta}");
    assert!(!folder.join("store.db").exists());

    stand.facade(&["stop", "ada"], &[]);
    stand.reads("ada", "process", "ended");
    let ended = stand.row_of(&agent);
    assert_eq!(ended["session"], FIRST, "{ended}");
    assert!(stand.home.submitted_messages().is_empty());
    let mut wire = connect(&stand.home);
    assert!(saved_sessions(&mut wire, &stand.place.project).is_empty());
    assert!(saved_sessions(&mut editor_of(&stand.home), &stand.place.project).is_empty());
    for target in [
        json!({ "kind": "agent", "reference": agent["reference"] }),
        json!({ "kind": "selector", "selector": "ada", "folder": stand.place.project }),
    ] {
        let env = stand.protocol_env();
        let refused = wire.call(
            "agent.resume",
            json!({ "target": target, "env": env, "size": { "cols": 120, "rows": 30 } }),
        );
        assert_eq!(
            refused["error"]["data"]["reason"], "unavailable",
            "{refused}"
        );
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("its CLI has not saved one"),
            "{refused}"
        );
        assert_eq!(stand.row_of(&agent), ended);
        assert!(!stand.args_file().exists(), "Cursor started again");
    }
}

/// The live trust option takes a key. The answered box stays above the drawn cursor, and the
/// composer accepts the first turn while Cursor connects its plugin in the background.
#[test]
fn cursor_accepts_typing_before_its_plugin_connects() {
    let stand = Stand::new(&CURSOR, "trust-and-plugin");
    let keys = stand.home.folder().join("keys");
    let mut command = stand.home.command(&test_binaries().facade);
    command
        .args(["start", "--name", "ada", CURSOR.cli])
        .current_dir(&stand.place.project)
        .envs(stand.env())
        .env("FAKECLI_CURSOR_TRUST", "1")
        .env("FAKECLI_MCP_DELAY_MS", "7000")
        .env("FAKECLI_KEYS", &keys);
    let mut term = TestTerminal::spawn(&mut command, 138, 53);
    let input = || stand.home.inspect_agent("ada")["input"]["state"].clone();
    assert!(
        term.wait_for(LOADED_TIMEOUT, |text| text
            .contains("▶ [a] Trust this workspace")),
        "{}",
        term.text()
    );
    assert!(
        wait_until(secs(5), || input() == "interaction"),
        "{}",
        input()
    );
    term.send(b"a");
    assert!(
        term.wait_for(LOADED_TIMEOUT, |text| text
            .contains("Trusting workspace...")
            && text.contains("Plan, search, build anything")),
        "{}",
        term.text()
    );
    assert_eq!(input(), "usable");
    assert!(
        !term.wait_for_output(secs(1), "MCP Servers"),
        "Cursor opened its MCP pager during startup: {}",
        term.text()
    );
    term.send(b"first-");
    term.send(b"turn\r");
    assert!(
        wait_until(secs(5), || stand.home.submitted_messages()
            == ["first-turn"]),
        "{:?}\n{}",
        stand.home.submitted_messages(),
        term.text()
    );
    assert!(
        !stand.mcp_initialize_file().exists(),
        "the first turn arrived after the plugin connected"
    );
    stand.reads("ada", "tools_state", "available");

    term.send(b"abcd");
    assert!(
        wait_until(secs(5), || input() == "draft"),
        "{}\n{}",
        input(),
        term.text()
    );
    stand.facade(&["send", "ada", "after the draft"], &[]);
    assert!(term.wait_for(secs(5), |text| text.contains("abcd")));
    term.send(b"\r");
    assert!(
        wait_until(LOADED_TIMEOUT, || stand.home.submitted_messages().len()
            == 3),
        "{:?}\n{}",
        stand.home.submitted_messages(),
        term.text()
    );
    let sent = stand.home.submitted_messages();
    assert_eq!(&sent[..2], ["first-turn", "abcd"]);
    assert!(sent[2].ends_with("\nafter the draft"), "{sent:?}");
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(10))
            .is_some_and(|status| status.success())
    );
    let raw = std::fs::read(keys).unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(raw.starts_with("afirst-turn\r"), "{raw:?}");
    assert!(!raw.contains("/mcp list"), "{raw:?}");
}

#[test]
fn cursor_asks_with_yolo_off() {
    asks_with_yolo_off(&CURSOR);
}

#[test]
fn a_session_cursor_saved_outside_facade_is_resumed() {
    resumes_a_session_saved_outside(&CURSOR);
}

#[test]
fn messages_of_every_size_reach_cursor() {
    messages_of_every_size_arrive(&CURSOR);
}

#[test]
fn kiro_starts_takes_messages_and_resumes_its_session() {
    starts_takes_messages_and_resumes_its_session(&KIRO);
}

#[test]
fn a_kiro_session_can_recreate_its_facade_profile_under_a_new_agent() {
    resume_external_session(&KIRO, Some("facade-0123456789abcdef"));
}

#[test]
fn kiro_uses_the_agent_selected_in_workspace_settings() {
    let stand = Stand::new(&KIRO, "workspace-agent");
    let settings = stand.place.project.join(".kiro/settings/cli.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let preferences = r#"{"chat.defaultAgent": "project-reviewer"}"#;
    std::fs::write(&settings, preferences).unwrap();

    let agent = stand.start(None, None, (120, 30));
    let args = stand.arguments();
    assert_eq!(option_value(&args, "--agent"), None, "{args:?}");
    assert_eq!(stand.row_of(&agent)["tools_state"], "unavailable");
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), preferences);
}

#[test]
fn kiro_asks_with_yolo_off() {
    asks_with_yolo_off(&KIRO);
}

#[test]
fn a_session_kiro_saved_outside_facade_is_resumed() {
    resumes_a_session_saved_outside(&KIRO);
}

#[test]
fn messages_of_every_size_reach_kiro() {
    messages_of_every_size_arrive(&KIRO);
}

#[test]
fn qoder_starts_takes_messages_and_resumes_its_session() {
    starts_takes_messages_and_resumes_its_session(&QODER);
}

#[test]
fn qoder_asks_with_yolo_off() {
    asks_with_yolo_off(&QODER);
}

#[test]
fn a_session_qoder_saved_outside_facade_is_resumed() {
    resumes_a_session_saved_outside(&QODER);
}

#[test]
fn messages_of_every_size_reach_qoder() {
    messages_of_every_size_arrive(&QODER);
}

#[test]
fn oh_my_pi_starts_takes_messages_and_resumes_its_session() {
    starts_takes_messages_and_resumes_its_session(&OMP);
}

#[test]
fn oh_my_pi_asks_with_yolo_off() {
    asks_with_yolo_off(&OMP);
}

#[test]
fn a_session_oh_my_pi_saved_outside_facade_is_resumed() {
    resumes_a_session_saved_outside(&OMP);
}

#[test]
fn messages_of_every_size_reach_oh_my_pi() {
    messages_of_every_size_arrive(&OMP);
}

#[test]
fn oh_my_pi_keeps_an_explicit_pi_composer() {
    let stand = Stand::new(&OMP, "pi-composer");
    let config = stand.place.project.join("composer.json");
    let contents = r#"{"composer":{"shape":"pi"}}"#;
    std::fs::write(&config, contents).unwrap();
    stand.facade(
        &[
            "start",
            "-d",
            "--name",
            "ada",
            "omp",
            "--config",
            config.to_str().unwrap(),
        ],
        &[],
    );
    let args = stand.arguments();
    let configs: Vec<_> = args
        .windows(2)
        .filter(|pair| pair[0] == "--config")
        .map(|pair| &pair[1])
        .collect();
    assert_eq!(configs.len(), 2, "{args:?}");
    assert_eq!(configs[0], config.to_str().unwrap());
    let overlay: Value =
        facade_scenarios::serde_json::from_slice(&std::fs::read(configs[1]).unwrap()).unwrap();
    assert!(overlay.get("composer").is_none(), "{overlay}");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), contents);
    stand.reads("ada", "tools_state", "available");
    assert!(wait_for_screen_text(&stand.home, "ada", "────────"));
    stand.send("ada", "typed into the configured composer");
}

/// An Oh My Pi session saved before its name had a line of its own is listed by the name in its
/// header.
#[test]
fn a_session_an_older_oh_my_pi_saved_is_listed() {
    let stand = Stand::new(&OMP, "legacy");
    let head = omp_legacy_session_head(OUTSIDE, &stand.place.project, "旧会话", AT);
    save_omp_session(&stand.place, OUTSIDE, &head);
    stand.facade(&["daemon", "--detach"], &[]);
    let items = saved_sessions(&mut connect(&stand.home), &stand.place.project);
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["target"]["session"], OUTSIDE);
    assert!(items[0].to_string().contains("旧会话"), "{items:?}");
}

/// The extension a run gives Oh My Pi, run with Node where there is one: what it reports on each
/// event is what Facade Code Framework's screen reads, and a session without a file clears the report.
#[test]
fn oh_my_pi_s_extension_reports_its_turns_and_its_session() {
    let stand = Stand::new(&OMP, "extension");
    stand.start(None, None, (120, 30));
    let args = stand.arguments();
    let extension = Path::new(option_value(&args, "--extension").unwrap());
    let report = omp_report_file(&args, &stand.home.path).unwrap().unwrap();
    let saved = stand.home.folder().join("saved.jsonl");
    let run = |events: &str| {
        let script = format!(
            "import load from {};
            const on = {{}};
            load({{ on: (event, handler) => (on[event] ??= []).push(handler) }});
            const ctx = file => ({{ hasUI: true, sessionManager: {{
                getSessionId: () => {}, getSessionFile: () => file }} }});
            const emit = (event, data = {{}}, file = {}) =>
                (on[event] ?? []).forEach(handler => handler(data, ctx(file)));
            {events}",
            json!(format!("file://{}", extension.display())),
            json!(FIRST.to_uppercase()),
            json!(saved),
        );
        stand
            .home
            .command("node")
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .args(["--input-type=module", "-e", &script])
            .output()
    };
    let Ok(output) = run(
        "emit('session_start'); emit('agent_start'); emit('tool_approval_requested');
         emit('tool_approval_resolved');
         emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] });
         emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'error' }] });",
    ) else {
        eprintln!("node is not installed: the extension is not run");
        return;
    };
    assert!(output.status.success(), "{}", stderr(&output));
    let states: Vec<_> = facade_screen::Screen::new(80, 24, 0)
        .feed(&output.stdout)
        .status
        .into_iter()
        .map(|event| match event {
            facade_screen::StatusEvent::Report(report) => (report.state, report.kind),
            other => panic!("{other:?}"),
        })
        .collect();
    use facade_screen::{BlockKind, ReportedState::*};
    assert_eq!(
        states,
        [
            (Some(Idle), None),
            (Some(Working), None),
            (Some(Blocked), Some(BlockKind::Permission)),
            (Some(Working), None),
            (Some(Done), None),
            (Some(Error), None),
        ]
    );
    assert_eq!(
        std::fs::read_to_string(&report).unwrap(),
        format!("{FIRST}\n{}\n", saved.display())
    );
    let output = run("emit('session_switch', {}, null);").unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(std::fs::read_to_string(&report).unwrap(), "");
}

/// A draft that fills Oh My Pi's composer may have rows out of sight, which nothing shows, so
/// Facade Code Framework does not know what it holds: a message waits, and goes in alone once the draft is gone.
#[test]
fn a_draft_that_fills_oh_my_pi_s_composer_is_never_typed_over() {
    // The default band shows 11 content rows at 80 by 24. Two smaller pastes stay visible.
    let stand = Stand::new(&OMP, "full");
    stand.start(None, None, (80, 24));
    stand.reads("ada", "tools_state", "available");
    assert!(wait_for_screen_text(&stand.home, "ada", "╰─"));
    let lines: Vec<String> = (1..=11).map(|line| format!("my line {line}")).collect();
    let paste = format!(
        "\x1b[200~{}\r\x1b[201~\x1b[200~{}\x1b[201~",
        lines[..6].join("\r"),
        lines[6..].join("\r")
    );
    type_raw(&mut connect(&stand.home), "ada", &paste);
    assert!(wait_for_screen_text(&stand.home, "ada", "my line 11"));
    let input = stand.home.inspect_agent("ada")["input"].clone();
    assert_eq!(input["state"], "unknown", "{input}");
    stand.facade(&["send", "ada", "hello"], &[]);
    std::thread::sleep(secs(3));
    assert_eq!(stand.home.submitted_messages(), Vec::<String>::new());
    let screen = stand.home.screen("ada");
    assert!(
        lines.iter().all(|line| screen.contains(line)) && !screen.contains("hello"),
        "{screen}"
    );
    stand.facade(&["type", "ada", "--key", "Ctrl+C"], &[]);
    assert!(
        wait_until(secs(30), || !stand.home.submitted_messages().is_empty()),
        "{}",
        stand.home.screen("ada")
    );
    let taken = stand.home.submitted_messages();
    assert!(
        taken.len() == 1 && taken[0].ends_with("\nhello"),
        "{taken:?}"
    );
}

/// Messages of every size reach the CLI in a small terminal and a large one: those its input shows
/// whole, those that fill it or scroll it, and those it shows as a placeholder.
fn messages_of_every_size_arrive(provider: &'static Provider) {
    let lines = |count: usize| {
        let lines: Vec<String> = (1..=count).map(|line| format!("line {line}")).collect();
        lines.join("\n")
    };
    let words = |characters: usize| {
        let words = "words of a message ".repeat(characters.div_ceil(19));
        words.trim().to_string()
    };
    let mut failed = Vec::new();
    for (size, (cols, rows)) in [("small", (80, 24)), ("large", (120, 50))] {
        for (what, text) in [
            ("3 lines", lines(3)),
            ("8 lines", lines(8)),
            ("9 lines", lines(9)),
            ("20 lines", lines(20)),
            ("500 characters", words(500)),
            ("700 characters", words(700)),
            ("900 characters", words(900)),
            ("2000 characters", words(2000)),
        ] {
            // Devin shows every paste whole, and its frame's height is not known.
            if provider.native == Native::Devin && text.len() > 1000 {
                continue;
            }
            let stand = Stand::new(provider, size);
            stand.start(None, None, (cols, rows));
            stand.reads("ada", "tools_state", "available");
            stand.home.run_facade(&["send", "ada", &text, "-w"]);
            let received = wait_until(secs(10), || !stand.home.submitted_messages().is_empty());
            let taken = stand.home.submitted_messages();
            let whole = received && taken.len() == 1 && taken[0].ends_with(&format!("\n{text}"));
            if !whole {
                let input = stand.home.inspect_agent("ada")["input"].clone();
                failed.push(format!("{what} at {cols}x{rows}: {input}"));
            }
        }
    }
    assert!(failed.is_empty(), "{}: {failed:#?}", provider.cli);
}

/// Devin reads a configuration folder of the run's own, where its commands find the person's other
/// programs' settings. An agent it starts through Facade Code Framework's tools gets the person's folder.
#[cfg(unix)]
#[test]
fn an_agent_devin_starts_gets_the_person_s_configuration_folder() {
    let stand = Stand::new(&DEVIN, "nested");
    stand.write_own_settings();
    let own = stand.place.user.join(".config");
    let printed = stand.home.folder().join("child.env");
    let script = format!(
        "env | awk '/^(XDG_CONFIG_HOME|FACADE_DEVIN_ORIGINAL_CONFIG_HOME)=/' > '{0}.part'; mv '{0}.part' '{0}'; sleep 60",
        printed.display()
    );
    stand
        .home
        .add_custom_cli_with("child-sh", &shell(), &["-c", &script]);
    stand.start(None, None, (120, 30));
    stand.reads("ada", "tools_state", "available");
    let pid = stand.row("ada")["pid"].as_i64().unwrap() as i32;
    let devin = facade_base::unix_process::environment(&process_identity(pid))
        .unwrap()
        .unwrap();
    let run_config = PathBuf::from(&devin["XDG_CONFIG_HOME"]);
    assert_ne!(run_config, own);
    assert_eq!(
        std::fs::read_to_string(run_config.join("git/config")).unwrap(),
        "[user]\n\tname = Own\n"
    );
    let args = stand.arguments();
    let given = Given {
        args: &args,
        home: &stand.home.path,
        user: &stand.place.user,
        project: &stand.place.project,
    };
    let config = json!({ "mcpServers": { "facade": given.server(&DEVIN) } });
    let relay = mcp_command(&config, &stand.home.path, |program| {
        stand.home.command(program)
    });
    let mut tools = McpTestClient::spawn(&stand.home, relay.unwrap());
    let started = tools.call(
        "start_agent",
        json!({ "name": "child", "cli": "child-sh", "folder": stand.place.project }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let checks_environment = || {
        assert!(
            wait_until(secs(30), || printed.exists()),
            "{}",
            stand.home.daemon_log()
        );
        let child = std::fs::read_to_string(&printed).unwrap();
        assert_eq!(child.trim(), format!("XDG_CONFIG_HOME={}", own.display()));
        std::fs::remove_file(&printed).unwrap();
    };
    checks_environment();

    let start = stand
        .home
        .command(&test_binaries().facade)
        .envs(&devin)
        .current_dir(&stand.place.project)
        .args(["start", "-d", "--name", "terminal-child", "child-sh"])
        .output()
        .unwrap();
    assert!(
        start.status.success(),
        "{}{}",
        stdout(&start),
        stderr(&start)
    );
    checks_environment();
}
