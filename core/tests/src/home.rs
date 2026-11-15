//! An isolated Facade home whose processes and files are cleaned up after each test.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::*;

/// What a test's commands take from the environment the tests run in: its temporary folder, its
/// text encoding, and Rust's backtraces. Nothing else reaches them, so no setting of the person's,
/// such as `OPENCODE_CONFIG`, reaches a test.
pub const PASSED_THROUGH: [&str; 5] = ["TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "RUST_BACKTRACE"];

/// The system's folders: besides the test's own, the only ones a test's processes find programs in.
const SYSTEM_FOLDERS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// What keeps a test's agents inside the test: the test's `PATH`, home and CLI settings folders,
/// and the test's folder.
#[derive(Clone, Debug)]
pub struct Isolation {
    /// [`TestHome::isolating_env`].
    pub env: Vec<(&'static str, String)>,
    folder: PathBuf,
}

impl Isolation {
    /// Whether `value` for variable `name` keeps a process inside the test: a `PATH` of the
    /// programs under test, the system's folders and folders of the test's own, and a home or
    /// settings folder inside the test's folder.
    pub fn keeps_inside(&self, name: &str, value: &str) -> bool {
        let inside = |folder: &str| Path::new(folder).starts_with(&self.folder);
        match name {
            "PATH" => {
                let allowed = self
                    .env
                    .iter()
                    .find(|(name, _)| *name == "PATH")
                    .map(|(_, path)| path.as_str())
                    .unwrap_or_default();
                value
                    .split(':')
                    .all(|folder| allowed.split(':').any(|ok| ok == folder) || inside(folder))
            }
            _ => inside(value),
        }
    }

    /// Gives the agent of an `agent.start` or `agent.resume` call the test's variables the call
    /// does not name, and stops the test where it names one that leads outside the test. Other
    /// messages, and arguments a test malforms on purpose, pass as they are.
    pub fn apply(&self, message: &mut Value) {
        if message["method"] != "call"
            || !matches!(
                message["params"]["op"].as_str(),
                Some("agent.start" | "agent.resume")
            )
        {
            return;
        }
        let Some(args) = message["params"]["args"].as_object_mut() else {
            return;
        };
        let Some(env) = args
            .entry("env")
            .or_insert_with(|| json!({}))
            .as_object_mut()
        else {
            return;
        };
        for (name, value) in &self.env {
            match env.get(*name) {
                Some(Value::String(given)) => assert!(
                    self.keeps_inside(name, given),
                    "a test's agent must stay inside the test, but its {name} is {given}"
                ),
                Some(_) => {}
                None => drop(env.insert(name.to_string(), json!(value))),
            }
        }
    }
}

/// An agent started by `facade start`.
#[derive(Clone, Debug)]
pub struct TestAgent {
    /// The agent ID, such as `a1`.
    pub id: String,
    pub pid: i32,
    pub process: facade_base::process::ProcessIdentity,
}

static HOMES: AtomicU64 = AtomicU64::new(0);

/// The agent `facade start` or `facade resume` printed without a terminal: `#a1 pid 123`.
pub fn started_agent(out: &str) -> TestAgent {
    let words: Vec<&str> = out.split_whitespace().collect();
    assert!(
        words.len() >= 3 && words[0].starts_with("#a") && words[1] == "pid",
        "unexpected start output: {out}"
    );
    let pid = words[2].parse().expect("expected a process ID");
    TestAgent {
        process: process_identity(pid),
        id: words[0].trim_start_matches('#').to_string(),
        pid,
    }
}

/// A test's isolated Facade home and cleanup guard.
pub struct TestHome {
    pub path: PathBuf,
    /// The working folder for test agents.
    pub project: PathBuf,
    /// The shared message log for this home's fake CLIs.
    pub fake_log: PathBuf,
}

impl TestHome {
    pub fn new(test: &str) -> TestHome {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or_default();
        let n = HOMES.fetch_add(1, Ordering::Relaxed);
        let base =
            std::env::temp_dir().join(format!("fcs-{test}-{}-{n}-{nanos:x}", std::process::id()));
        let path = base.join("home");
        let project = base.join("project");
        std::fs::create_dir_all(&path).expect("could not create the test Facade home");
        std::fs::create_dir_all(&project).expect("could not create the test project folder");
        if let Some(log) = std::env::var_os("FACADE_SCENARIO_HOME_LOG") {
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .unwrap();
            log.write_all(format!("{}\n", path.display()).as_bytes())
                .unwrap();
        }
        TestHome {
            fake_log: base.join("fake.log"),
            path,
            project,
        }
    }

    /// Installs a debug fault switch in this test home.
    pub fn fault(&self, name: &str, value: &str) {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(self.path.join("core"))
            .unwrap();
        std::fs::write(self.path.join("core").join(name), value).unwrap();
    }

    /// Creates a command for this Facade home, with an environment of [`PASSED_THROUGH`] and the
    /// test's own variables alone.
    pub fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        command.env_clear();
        for name in PASSED_THROUGH {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        // This test's PATH, home and CLI settings folders in place of the person's, which the
        // agents it starts get too.
        command.envs(self.isolating_env());
        command
            .env("FACADE_HOME", &self.path)
            .env("FAKECLI_LOG", &self.fake_log)
            .current_dir(&self.project);
        // A home's programs link to the test binaries: a copy in each test's home would fill the
        // Linux test volume, and macOS checks each fresh copy the first time it runs, for a second
        // or more. The tests of the copy path, which release builds take, remove the switch.
        command.env("FACADE_TEST_LINK_PROGRAMS", "1");
        command
    }

    /// The folder this test owns: its Facade home, its project, and the home of its processes.
    pub fn folder(&self) -> &Path {
        self.path
            .parent()
            .expect("a test's Facade home lies in the test's folder")
    }

    /// The home of this test's processes and agents, inside the test's folder, so that no CLI reads
    /// or writes the person's settings. It holds the folders the CLIs keep their settings in.
    pub fn user_home(&self) -> PathBuf {
        let user = self.folder().join("user");
        for settings in [".config", ".claude", ".codex"] {
            std::fs::create_dir_all(user.join(settings))
                .expect("could not create the test's home folder");
        }
        user
    }

    /// The `PATH` of this test's processes and agents: the programs under test, then the system's
    /// folders. No folder a CLI installs into (~/.local/bin, Homebrew, npm, cargo) is on it, so no
    /// real CLI can start in a test.
    pub fn test_path(&self) -> String {
        let programs = test_binaries()
            .fakecli
            .parent()
            .expect("the programs' folder")
            .display()
            .to_string();
        std::iter::once(programs.as_str())
            .chain(SYSTEM_FOLDERS)
            .collect::<Vec<_>>()
            .join(":")
    }

    /// What keeps a process inside this test: its `PATH`, its home, and the folders the CLIs keep
    /// their settings in.
    pub fn isolating_env(&self) -> Vec<(&'static str, String)> {
        let user = self.user_home();
        let under = |settings: &str| user.join(settings).display().to_string();
        vec![
            ("PATH", self.test_path()),
            ("HOME", user.display().to_string()),
            ("XDG_CONFIG_HOME", under(".config")),
            ("CLAUDE_CONFIG_DIR", under(".claude")),
            ("CODEX_HOME", under(".codex")),
        ]
    }

    /// What keeps the agents this test starts through the protocol inside it.
    pub fn isolation(&self) -> Isolation {
        Isolation {
            env: self.isolating_env(),
            folder: self.folder().to_path_buf(),
        }
    }

    pub fn run_facade(&self, args: &[&str]) -> Output {
        self.command(&test_binaries().facade)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("could not run facade")
    }

    /// Runs `facade <args>`, requires success, and returns stdout.
    pub fn run_facade_ok(&self, args: &[&str]) -> String {
        let output = self.until_started(|| self.run_facade(args));
        assert!(
            output.status.success(),
            "facade {args:?} failed: {}{}",
            stdout(&output),
            stderr(&output)
        );
        stdout(&output)
    }

    /// Runs a `facade` command again while it says the daemon is still starting, or did not start,
    /// within its 10 seconds: a daemon starting on a loaded machine can take longer, the command
    /// did nothing, and the next one finds that daemon. Tests of what such a command says run it
    /// once, with `run_facade`.
    fn until_started(&self, mut run: impl FnMut() -> Output) -> Output {
        let until = std::time::Instant::now() + LOADED_TIMEOUT;
        loop {
            let output = run();
            let starting = [
                "Facade is still starting",
                "the Facade daemon did not start within",
            ]
            .iter()
            .any(|said| stderr(&output).contains(said));
            if output.status.success() || !starting || std::time::Instant::now() >= until {
                return output;
            }
        }
    }

    /// Starts a fake CLI agent in the background.
    pub fn start_fake(&self, name: &str) -> TestAgent {
        self.start_fake_with(name, &[])
    }

    /// Starts a fake CLI agent with extra environment variables, such as `FAKECLI_NAME`.
    pub fn start_fake_with(&self, name: &str, env: &[(&str, &str)]) -> TestAgent {
        let fake = test_binaries().fakecli.to_string_lossy().into_owned();
        self.start_in_background(name, &fake, env)
    }

    /// Starts the fake CLI by its rule's name, `fake`, which finds `facade-fakecli` on the test
    /// programs' `PATH`.
    pub fn start_named_fake(&self, name: &str, env: &[(&str, &str)]) -> TestAgent {
        let mut env = env.to_vec();
        let path = self.path_with_test_programs();
        env.push(("PATH", &path));
        self.start_in_background(name, "fake", &env)
    }

    /// `facade`, run with an empty home folder of the test's own, so that no CLI settings of the
    /// person running the tests are read.
    pub fn facade_in_an_empty_home(&self) -> Command {
        let own = self.project.parent().unwrap().join("home");
        std::fs::create_dir_all(&own).unwrap();
        let mut command = self.command(&test_binaries().facade);
        command
            .env("HOME", &own)
            .env("XDG_CONFIG_HOME", own.join(".config"));
        command
    }

    /// This test's `PATH`, which has the folder of the programs under test first: see
    /// [`TestHome::test_path`].
    pub fn path_with_test_programs(&self) -> String {
        self.test_path()
    }

    /// Runs `facade start --name <name> <cli>` without a terminal and waits for the agent's input
    /// box.
    fn start_in_background(&self, name: &str, cli: &str, env: &[(&str, &str)]) -> TestAgent {
        let mut command = self.command(&test_binaries().facade);
        // Without a terminal, start prints the agent ID; the agent keeps running.
        command
            .args(["start", "--name", name, cli])
            .stdin(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let output = self.until_started(|| command.output().expect("could not run facade"));
        assert!(
            output.status.success(),
            "facade start {name} failed: {}{}",
            stdout(&output),
            stderr(&output)
        );
        let agent = started_agent(&stdout(&output));
        // Allow up to 30 seconds for parallel tests on a busy machine; return as soon as the
        // condition holds.
        assert!(
            wait_until(secs(30), || self.screen(name).contains("❯")),
            "{name} did not draw its input box: {}",
            self.screen(name)
        );
        agent
    }

    /// Finds an agent by name in `facade list --json`.
    pub fn agent_from_list_json(&self, name: &str) -> Option<Value> {
        let listed: Value =
            serde_json::from_str(&stdout(&self.run_facade(&["list", "--json"]))).ok()?;
        listed
            .as_array()?
            .iter()
            .find(|agent| agent["name"] == name)
            .cloned()
    }

    /// Returns the `facade list` row for the named agent.
    pub fn list_line(&self, name: &str) -> Option<String> {
        stdout(&self.run_facade(&["list"]))
            .lines()
            .find(|line| line.starts_with("#a") && line.split_whitespace().nth(1) == Some(name))
            .map(str::to_string)
    }

    pub fn screen(&self, agent: &str) -> String {
        stdout(&self.run_facade(&["screen", agent]))
    }

    /// Reads submitted fake CLI messages in log order.
    pub fn submitted_messages(&self) -> Vec<String> {
        std::fs::read_to_string(&self.fake_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|entry| entry["text"].as_str().map(str::to_string))
            .collect()
    }

    /// Reads the daemon PID from `facade status`, which starts the daemon if needed.
    pub fn daemon_pid(&self) -> Option<i32> {
        let out = stdout(&self.run_facade(&["status"]));
        let words: Vec<&str> = out.split_whitespace().collect();
        words
            .iter()
            .position(|word| *word == "pid")
            .and_then(|at| words.get(at + 1))
            .and_then(|pid| pid.parse().ok())
    }

    /// Finds this test's processes: those whose environment selects its Facade home, and those
    /// working in its folder.
    pub fn processes(&self) -> Vec<i32> {
        let marker = format!("FACADE_HOME={}", self.path.display());
        let out = Command::new("ps")
            .args(["axeww", "-o", "pid=,command="])
            .output()
            .expect("could not run ps");
        stdout(&out)
            .lines()
            .filter(|line| line.split_whitespace().any(|word| word == marker))
            .filter_map(|line| {
                line.split_whitespace()
                    .next()
                    .and_then(|pid| pid.parse().ok())
            })
            .chain(
                self.path
                    .parent()
                    .map(processes_working_in)
                    .unwrap_or_default(),
            )
            .filter(|pid| *pid != std::process::id() as i32)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// The process ID and birth value recorded in `core/<service>.lock`, if the record is complete.
    pub fn lock_record(&self, service: &str) -> Option<(i32, String)> {
        let text = std::fs::read_to_string(self.path.join(format!("core/{service}.lock"))).ok()?;
        let record: Value = serde_json::from_str(text.trim()).ok()?;
        Some((
            record["pid"].as_i64()? as i32,
            record["birth"].as_str()?.to_string(),
        ))
    }

    /// The keeper socket for this Facade home.
    pub fn keeper_socket(&self) -> PathBuf {
        facade_base::paths::keeper_socket_for(&self.path)
            .expect("could not locate the socket folder")
    }

    /// The daemon socket for this Facade home.
    pub fn daemon_socket(&self) -> PathBuf {
        facade_base::paths::daemon_socket_for(&self.path)
            .expect("could not locate the socket folder")
    }
}

impl TestHome {
    /// Stops all processes belonging to this Facade home, preserving its files.
    pub fn kill_home_processes(&self) {
        // Pause the processes before killing them so they cannot react to each other's exits.
        // Repeat until no processes remain, including those started during cleanup.
        for _ in 0..10 {
            let processes = self.processes();
            let identities: Vec<_> = processes.iter().map(|pid| process_identity(*pid)).collect();
            if processes.is_empty() {
                break;
            }
            for pid in &processes {
                send_signal(*pid, libc::SIGSTOP);
            }
            for pid in &processes {
                send_signal(*pid, libc::SIGKILL);
            }
            wait_until(secs(3), || {
                identities.iter().all(|identity| !alive(identity))
            });
        }
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        self.kill_home_processes();
        // Remove sockets left by killed processes.
        let _ = std::fs::remove_file(self.keeper_socket());
        let _ = std::fs::remove_file(self.daemon_socket());
        if std::env::var_os("FACADE_SCENARIO_KEEP").is_none()
            && let Some(base) = self.path.parent()
        {
            let _ = std::fs::remove_dir_all(base);
        }
    }
}

impl TestHome {
    /// Reads daemon details from hello, or None if no daemon responds.
    pub fn hello_result(&self) -> Option<Value> {
        let stream = std::os::unix::net::UnixStream::connect(self.daemon_socket()).ok()?;
        stream.set_read_timeout(Some(secs(5))).ok()?;
        let mut writer = stream.try_clone().ok()?;
        let mut reader = BufReader::new(stream);
        let hello = json!({
            "jsonrpc": "2.0", "id": 1, "method": "hello",
            "params": { "protocol": [1, 1], "build": "test", "kind": "terminal" },
        });
        writer.write_all(format!("{hello}\n").as_bytes()).ok()?;
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let response: Value = serde_json::from_str(&line).ok()?;
        response.get("result").cloned()
    }

    /// The keeper PID reported by the daemon.
    pub fn keeper_pid(&self) -> Option<i32> {
        self.hello_result()
            .and_then(|status| status["keeper"]["pid"].as_i64())
            .map(|pid| pid as i32)
    }

    /// The complete agent list from the `agents` topic.
    pub fn agents(&self) -> Vec<Value> {
        let mut wire = DaemonTestClient::open(self);
        wire.hello("terminal", [1, 1], json!({}));
        let watching = wire.request("watch", json!({ "topic": "agents" }));
        watching["result"]["snapshot"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    /// The agent record matching this name.
    pub fn agent_from_watch(&self, name: &str) -> Option<Value> {
        self.agents()
            .into_iter()
            .find(|agent| agent["name"] == name)
    }

    /// The keeper log content.
    pub fn keeper_log(&self) -> String {
        std::fs::read_to_string(self.path.join("core/logs/keeper.log")).unwrap_or_default()
    }

    /// The daemon log content, from every daemon of this Facade home.
    pub fn daemon_log(&self) -> String {
        std::fs::read_to_string(self.path.join("core/logs/daemon.log")).unwrap_or_default()
    }

    /// Starts the daemon with extra environment variables, which the keeper it starts and every
    /// later daemon inherit, and waits for it to answer.
    pub fn start_facade_with(&self, env: &[(&str, &str)]) {
        let mut command = self.command(&test_binaries().facade);
        command.args(["daemon", "--detach"]).stdin(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let output = command.output().expect("could not run facade");
        assert!(
            output.status.success(),
            "facade daemon --detach failed: {}",
            stderr(&output)
        );
        assert!(
            wait_until(LOADED_TIMEOUT, || self.hello_result().is_some()),
            "the daemon did not start"
        );
    }

    /// Sends SIGKILL to the daemon and returns its process ID.
    pub fn kill_daemon(&self) -> i32 {
        let pid = self
            .hello_result()
            .and_then(|hello| hello["pid"].as_i64())
            .expect("expected a running daemon") as i32;
        send_signal(pid, libc::SIGKILL);
        pid
    }

    /// Waits for a replacement daemon to respond to hello after recovery finishes, for `timeout` or
    /// as long as a loaded machine may take, whichever is longer: each caller waits for one that
    /// has to come. Returns its process ID.
    pub fn wait_for_daemon_after(&self, old: i32, timeout: std::time::Duration) -> Option<i32> {
        let mut found = None;
        wait_until(timeout.max(LOADED_TIMEOUT), || {
            found = self
                .hello_result()
                .and_then(|hello| hello["pid"].as_i64())
                .map(|pid| pid as i32)
                .filter(|pid| *pid != old);
            found.is_some()
        });
        found
    }

    /// The process IDs of the daemons the keeper started, in order, from its log.
    pub fn started_daemons(&self) -> Vec<i32> {
        self.keeper_log()
            .lines()
            .filter_map(|line| {
                line.split("started daemon ")
                    .nth(1)?
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()
            })
            .collect()
    }
}

impl TestHome {
    /// Waits for the task-local boundary marker, without holding up the service's other tasks.
    pub fn wait_for_gate(&self, point: &str) {
        let reached = wait_until(LOADED_TIMEOUT, || {
            self.path.join(format!("core/reached-{point}")).exists()
        });
        // The keeper's log says whether it saw the daemon end, and when it started the next.
        assert!(
            reached,
            "did not reach {point}:\n{}\nThe keeper's log:\n{}",
            self.daemon_log(),
            self.keeper_log()
        );
    }

    pub fn release_gate(&self, point: &str) {
        std::fs::write(self.path.join(format!("core/release-{point}")), "").unwrap();
    }

    /// Waits for both service sockets to disappear, then confirms both processes ended. Starts no
    /// service while waiting. The daemon exits after five idle seconds, and a service removes its
    /// socket as the last thing it does: the waits leave room above both for a loaded machine.
    pub fn wait_for_idle_exit(&self) {
        assert!(
            wait_until(LOADED_TIMEOUT, || !self.daemon_socket().exists()
                && !self.keeper_socket().exists()),
            "services did not exit: {}\n{}",
            self.daemon_log(),
            self.keeper_log()
        );
        for service in ["keeper", "daemon"] {
            if let Some((pid, birth)) = self.lock_record(service) {
                let identity = facade_base::process::ProcessIdentity {
                    pid: pid as u32,
                    birth,
                };
                assert!(
                    wait_until(LOADED_TIMEOUT, || !alive(&identity)),
                    "{service} still runs after its socket disappeared"
                );
            }
        }
    }
}

/// A stand-in for `cli` in `bin` that writes the arguments it was given to the file `argv`, one a
/// line, and waits. It moves the file into place once whole, so a test never reads part of it.
pub fn stand_in(bin: &Path, cli: &str, argv: &Path) {
    std::fs::create_dir_all(bin).unwrap();
    let program = bin.join(cli);
    let script = format!(
        "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\"; done > '{0}.part'\nmv \
         '{0}.part' '{0}'\nexec sleep 600\n",
        argv.display()
    );
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(
        &program,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
}

/// The arguments a stand-in that writes `argv` started with. The file goes, for the next start.
pub fn arguments(argv: &Path) -> Vec<String> {
    assert!(
        wait_until(LOADED_TIMEOUT, || argv.exists()),
        "the stand-in did not start"
    );
    let args = std::fs::read_to_string(argv)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    std::fs::remove_file(argv).unwrap();
    args
}

#[cfg(test)]
mod tests {
    use crate::TestHome;

    /// Cleanup must remove both sockets, including when processes were still running.
    #[test]
    fn a_test_home_s_end_removes_its_sockets() {
        let (keeper, daemon) = {
            let home = TestHome::new("socketsdrop");
            home.start_fake("w1");
            assert!(home.keeper_socket().exists() && home.daemon_socket().exists());
            (home.keeper_socket(), home.daemon_socket())
        };
        assert!(
            !keeper.exists() && !daemon.exists(),
            "sockets remain after Facade home cleanup: keeper {} daemon {}",
            keeper.exists(),
            daemon.exists()
        );
    }
}
