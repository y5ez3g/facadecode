//! Terminal commands, and which of them start the daemon.

use std::path::Path;

use facade_base::files::real_path;
use facade_scenarios::serde_json::json;
use facade_scenarios::*;

/// Omit non-UTF-8 environment variables and name them on stderr.
#[cfg(unix)]
#[test]
fn start_reports_non_utf8_environment_variables() {
    use std::os::unix::ffi::OsStrExt;
    let home = TestHome::new("nonutf8");
    let output = home
        .command(&test_binaries().facade)
        .args([
            "start",
            "-d",
            "--name",
            "odd",
            home.shell_cli(),
            "-c",
            "sleep 60",
        ])
        .env(
            std::ffi::OsStr::from_bytes(b"ODD"),
            std::ffi::OsStr::from_bytes(b"\xff\xfe"),
        )
        .stdin(std::process::Stdio::null())
        .output()
        .expect("could not run facade");
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stderr(&output).contains("ODD"), "{}", stderr(&output));
}

/// A zero-size terminal must use the default agent size. Windows makes no pseudo console of size
/// zero, so the person's terminal there always has one.
#[cfg(unix)]
#[test]
fn start_uses_default_size_when_terminal_size_is_zero() {
    let home = TestHome::new("nosize");
    let _term = TestTerminal::spawn(
        home.command(&test_binaries().facade).args([
            "start",
            "--name",
            "sized",
            home.shell_cli(),
            "-c",
            "stty size; sleep 60",
        ]),
        0,
        0,
    );
    assert!(
        wait_for_screen_text(&home, "sized", "30 120"),
        "{}",
        home.screen("sized")
    );
}

/// An attached start exits with the agent's code or 128 plus the terminating signal number.
#[test]
fn interactive_start_propagates_process_exit_status() {
    let home = TestHome::new("exitcode");
    // An end by a signal is Unix's alone.
    #[cfg_attr(windows, allow(unused_mut))]
    let mut ends = vec![(
        "a1",
        "printf 'INTERACTIVE-FRAME\n'; sleep 1; \
         printf 'To continue this session, run:\n  demo resume stored-session\n'; exit 3",
        3,
        "exited with code 3.",
    )];
    #[cfg(unix)]
    ends.push((
        "a2",
        "sleep 1; kill -TERM $$",
        128 + libc::SIGTERM,
        "exited on signal SIGTERM.",
    ));
    let sh = home.shell_cli();
    for (id, script, code, ended) in ends {
        let mut term = TestTerminal::spawn(
            home.command(&test_binaries().facade)
                .args(["start", sh, "-c", script]),
            80,
            24,
        );
        let status = term
            .wait_exit(secs(15))
            .unwrap_or_else(|| panic!("{script}: never ended"));
        assert_eq!(status.code(), Some(code), "{script}: {}", term.text());
        let record = home.agent_record(id).expect("recorded");
        let (name, reference) = (
            record["name"].as_str().unwrap(),
            record["address"].as_str().unwrap(),
        );
        let said = format!("{name} ({reference}) {ended}");
        assert!(
            term.wait_for(secs(2), |text| text.contains(&said)),
            "{script}: {}",
            term.text()
        );
        assert_eq!(term.output_count(&said), 1);
        // The agent's text, including the hint it prints on its way out, leaves with its view:
        // the restored text ends with the opening line and the receipt.
        let text = term.text_with_scrollback();
        for shown in [
            "INTERACTIVE-FRAME",
            "To continue this session",
            "demo resume",
        ] {
            assert!(!text.contains(shown), "{script}: {text}");
        }
        let opening = format!("Started {name} ({reference}). Press Ctrl+] to detach.");
        assert!(
            text.trim_end().ends_with(&format!("{opening}\n{said}")),
            "{script}: {text}"
        );
    }
}

#[test]
fn commands_start_list_read_and_stop_agents() {
    let home = TestHome::new("trial");
    let agent = home.start_fake("w1");
    assert_eq!(agent.id, "a1");
    let table = home.list_table();
    assert_eq!(
        table.header,
        [
            "NAME",
            "REF",
            "STATE",
            "CLI",
            "TYPE",
            "WORKING DIRECTORY",
            "STARTED",
            "SESSION"
        ],
        "{table:?}"
    );
    let row = table.row("NAME", "w1").expect("w1 is listed");
    let address = home.agent_record("a1").expect("recorded")["address"].clone();
    let age = table
        .cell(row, "STARTED")
        .strip_suffix("m ago")
        .expect("a recent start");
    assert!(
        table.cell(row, "REF") == address
            && table.cell(row, "TYPE") == "Managed"
            && table.cell(row, "STATE") == "Starting"
            && table.cell(row, "CLI") == "fake"
            && table.cell(row, "SESSION") == "-"
            && !age.is_empty()
            && age.bytes().all(|byte| byte.is_ascii_digit()),
        "{table:?}"
    );
    let started_folder = Path::new(table.cell(row, "WORKING DIRECTORY"));
    assert_eq!(
        real_path(started_folder).unwrap(),
        real_path(&home.project).unwrap(),
        "{table:?}"
    );
    assert!(
        home.screen("w1").contains("fakecli (Facade test CLI)"),
        "{}",
        home.screen("w1")
    );

    // The second agent gets the next number.
    let second = home.start_fake("w2");
    assert_eq!(second.id, "a2");

    home.run_facade_ok(&["stop", "w1"]);
    assert!(
        wait_until(secs(10), || !alive(&agent.process)),
        "w1's process {} still runs",
        agent.pid
    );
    // The list shows running agents alone; inspect shows the stopped one.
    assert!(
        wait_until(secs(5), || home.list_state("w1").is_none()),
        "{:?}",
        home.list_table()
    );
    let inspected = home.run_facade_ok(&["status", "w1"]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State ") && line[5..].trim() == "Stopped"),
        "{inspected}"
    );
    assert!(home.agent_from_watch("w2").expect("w2 is recorded")["process"] == "running");
}

/// `facade list` and `inspect` show a name on one line whatever it holds, and each list column is
/// as wide as its widest cell, so a long name or state shifts no other column.
#[test]
fn list_and_inspect_show_names_on_one_line_in_aligned_columns() {
    let home = TestHome::new("listnames");
    home.start_fake("evil\u{1b}[2J\r\nname");
    home.start_fake("w2");
    let address = home.agent_record("a1").expect("recorded")["address"].clone();
    let list = home.run_facade_ok(&["list"]);
    assert!(!list.contains('\u{1b}') && !list.contains('\r'), "{list:?}");
    let lines: Vec<&str> = list.lines().collect();
    assert_eq!(lines.len(), 3, "a header and one line per agent: {list}");
    let table = Table::parse(&list);
    // The newest start first.
    let name = table.cell(&table.rows[1], "NAME");
    assert!(
        table.cell(&table.rows[1], "REF") == address
            && name.starts_with("evil [2J")
            && name.ends_with("name")
            && table.cell(&table.rows[0], "NAME") == "w2",
        "{list}"
    );
    // Each column begins at the same place on every line: three spaces, then the cell.
    let state_at = lines[0].find("STATE").unwrap();
    assert!(
        lines
            .iter()
            .all(|line| line[..state_at].ends_with("   ") && !line[state_at..].starts_with(' ')),
        "every line's STATE column starts at the same place: {list}"
    );
    let inspected = home.run_facade_ok(&["status", "a1"]);
    let named = inspected.lines().next().unwrap_or_default();
    assert!(
        !inspected.contains('\u{1b}')
            && named.contains("evil [2J")
            && named.ends_with(&format!("name ({})", address.as_str().unwrap())),
        "{inspected}"
    );
}

/// A command whose reader closes before it prints, as `facade list | head -0` does, ends quietly.
#[test]
fn a_command_whose_reader_closes_early_ends_quietly() {
    let home = TestHome::new("closedout");
    let mut listing = home.command(&test_binaries().facade);
    let stdio = std::process::Stdio::piped;
    let mut child = listing
        .arg("list")
        .stdin(std::process::Stdio::null())
        .stdout(stdio())
        .stderr(stdio())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let output = child.wait_with_output().unwrap();
    assert!(!stderr(&output).contains("panicked"), "{}", stderr(&output));
}

/// `facade start` takes its own options before the CLI's name and gives the CLI every word after
/// it, a `--name` of its own among them.
#[test]
fn start_takes_its_options_before_the_cli_and_forwards_every_word_after_it() {
    let home = TestHome::new("passthrough");
    // Use a shell that prints its received arguments.
    let script = "printf 'given:%s\\n' \"$*\"; sleep 60";
    let sh = home.shell_cli();
    let named = home.run_facade_ok(&[
        "start", "-d", "--name", "echoer", sh, "-c", script, "sh", "--model", "x", "--name",
        "its own", "-p",
    ]);
    assert_eq!(started_id(&named), "a1", "{named}");
    assert!(
        wait_until(secs(10), || home
            .screen("echoer")
            .contains("given:--model x --name its own -p")),
        "{}",
        home.screen("echoer")
    );
    // Unnamed agents use unused suggested names while available.
    home.run_facade_ok(&["start", "-d", sh, "-c", "sleep 60"]);
    home.run_facade_ok(&["start", "-d", sh, "-c", "sleep 60"]);
    let table = home.list_table();
    let listed = table.column("NAME");
    assert_eq!(listed.len(), 3, "{listed:?}");
    assert!(
        listed[1] != listed[2]
            && listed[1..]
                .iter()
                .all(|name| name.chars().all(|c| c.is_ascii_alphabetic())),
        "{listed:?}"
    );
}

#[test]
fn commands_resolve_agent_ids_numbers_and_names() {
    let home = TestHome::new("numbers");
    home.start_fake("w1");
    let address = home.agent_record("a1").expect("recorded")["address"]
        .as_str()
        .expect("an address")
        .to_string();
    // An ID, a copyable address or a name. Anything not `a` and a number is a name.
    for reference in ["a1", address.as_str(), "w1"] {
        assert!(
            home.screen(reference).contains("fakecli (Facade test CLI)"),
            "{reference}: {}",
            home.screen(reference)
        );
    }
    let none = home.run_facade(&["screen", "a9"]);
    assert!(
        none.status.code() == Some(1)
            && stderr(&none)
                == "error: No agent or guest matches \"a9\".\nRun 'facade list' to find an agent.\n",
        "{}",
        stderr(&none)
    );
}

/// No real CLI can start in a test, and no agent of a test reads or writes the person's settings: a
/// test's commands get no variable of the environment the tests run in besides [`PASSED_THROUGH`],
/// neither the harness's `PATH` nor an agent's finds `claude`, `codex`, `agy`, `muse`, `opencode`
/// or `pi`, and an agent started with `facade start` and one started through the protocol keep
/// their home and the CLIs' settings folders inside the test. A protocol start that names a home
/// outside the test stops the test.
#[test]
fn no_real_cli_can_start_in_a_test() {
    const CLIS: &str = "claude codex agy muse opencode pi";
    let home = TestHome::new("isolation");
    for path in [home.test_path(), home.path_with_test_programs()] {
        for folder in path.split(PATH_SEPARATOR) {
            for cli in CLIS.split(' ') {
                // Windows finds a program by its name with an extension of PATHEXT, too.
                for program in [cli.to_string(), format!("{cli}.exe"), format!("{cli}.cmd")] {
                    assert!(
                        !std::path::Path::new(folder).join(&program).exists(),
                        "{folder}/{program} can be found from a test's PATH"
                    );
                }
            }
        }
    }
    #[cfg(unix)]
    let given = stdout(
        &home
            .command("/usr/bin/env")
            .output()
            .expect("could not run env"),
    );
    #[cfg(windows)]
    let given = stdout(
        &home
            .command("cmd.exe")
            .args(["/d", "/c", "set"])
            .output()
            .expect("could not run cmd.exe"),
    );
    // Windows can set PROCESSOR_ARCHITECTURE at process creation. cmd.exe supplies PROMPT.
    let startup: &[&str] = if cfg!(windows) {
        &["PROCESSOR_ARCHITECTURE", "PROMPT"]
    } else {
        &[]
    };
    let own = ["FACADE_HOME", "FAKECLI_LOG", "FACADE_TEST_LINK_PROGRAMS"]
        .into_iter()
        .chain(startup.iter().copied())
        .chain(home.isolating_env().into_iter().map(|(name, _)| name));
    let allowed: Vec<&str> = own.chain(PASSED_THROUGH.iter().copied()).collect();
    let unexpected: Vec<_> = given
        .lines()
        .map(|variable| variable.split_once('=').map_or(variable, |(name, _)| name))
        .filter(|name| !allowed.contains(name))
        .collect();
    assert!(
        unexpected.is_empty(),
        "unexpected environment names in a test's command: {unexpected:?}"
    );
    // What each agent finds and is given, written in the project: through sh on Unix; through
    // cmd.exe on Windows, where Git's sh would show its own forms of the paths.
    // Each is a custom program of the test's settings: Facade starts only the CLIs they list.
    #[cfg(unix)]
    let cli = home.shell_cli();
    #[cfg(windows)]
    let cli = {
        let cmd = system_folders()
            .iter()
            .map(|folder| Path::new(folder).join("cmd.exe"))
            .find(|program| program.exists())
            .expect("cmd.exe in a system folder");
        home.add_custom_cli("cmd", &cmd);
        "cmd"
    };
    #[cfg(unix)]
    let script = |name: &str| {
        vec![
            "-c".to_string(),
            format!(
                "for cli in {CLIS}; do command -v \"$cli\"; done > {name}-found.txt; env > \
                 {name}-env.tmp; mv {name}-env.tmp {name}-env.txt; sleep 60"
            ),
        ]
    };
    #[cfg(windows)]
    let script = |name: &str| {
        vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            format!(
                "(for %c in ({CLIS}) do @where %c 2>nul) > {name}-found.txt & set > \
                 {name}-env.tmp & move /y {name}-env.tmp {name}-env.txt >nul & ping -n 61 \
                 127.0.0.1 >nul"
            ),
        ]
    };
    let started = home
        .command(&test_binaries().facade)
        .args(["start", "-d", "--name", "command", cli])
        .args(script("command"))
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let mut wire = connect(&home);
    let path = system_folders().join(PATH_SEPARATOR);
    let wired = wire.call(
        "agent.start",
        json!({
            "cli": cli, "args": script("wire"), "name": "wire", "folder": home.project,
            "env": { "PATH": path, "FACADE_HOME": home.path }, "size": { "cols": 80, "rows": 24 },
        }),
    );
    assert!(
        wired["result"]["agent"]["reference"]["agent_id"].is_string(),
        "{wired}"
    );
    let isolation = home.isolation();
    for name in ["command", "wire"] {
        let written = home.project.join(format!("{name}-env.txt"));
        assert!(
            wait_until(secs(10), || written.exists()),
            "{name} did not write its environment: {}",
            home.screen(name)
        );
        let found =
            std::fs::read_to_string(home.project.join(format!("{name}-found.txt"))).unwrap();
        assert_eq!(found, "", "{name} found a real CLI");
        let env = std::fs::read_to_string(written).unwrap();
        let value = |variable: &str| {
            env.lines()
                .find_map(|line| line.strip_prefix(&format!("{variable}=")))
                .map(str::to_string)
        };
        assert_eq!(
            value("HOME"),
            Some(home.user_home().display().to_string()),
            "{name}'s home"
        );
        for (variable, _) in &isolation.env {
            let given = value(variable).unwrap_or_else(|| panic!("{name} has no {variable}"));
            assert!(
                isolation.keeps_inside(variable, &given),
                "{name}'s {variable} leads outside the test: {given}"
            );
        }
    }
    let outside = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let args = json!({
        "cli": home.shell_cli(), "args": ["-c", "sleep 60"], "name": "outside",
        "folder": home.project,
        "env": { "HOME": outside }, "size": { "cols": 80, "rows": 24 },
    });
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wire.call("agent.start", args)
    }));
    assert!(
        refused.is_err(),
        "the harness let an agent start with the person's home"
    );
}

/// The command line of process `pid`, as `ps` shows it.
#[cfg(unix)]
fn command_of(pid: i32) -> String {
    let ps = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&ps.stdout).trim().to_string()
}

/// A command starts Facade from its build's folder, `core/bin/<build>/`, where it installs its
/// programs first, and the launchers `core/bin/facade` and `core/bin/facade-mcp` point at them. A
/// run's CLI is given the launchers for its MCP server and its hooks, so the current build's
/// programs serve it, whichever that is.
#[cfg(unix)]
#[test]
fn facade_runs_from_its_build_s_folder_and_runs_name_the_launchers() {
    use facade_scenarios::serde_json;

    let home = TestHome::new("programs");
    let args_file = home.project.join("fake-args.json");
    let agent = home.start_named_fake("w1", &[("FAKECLI_ARGS", args_file.to_str().unwrap())]);
    let bin = home.path.join("core").join("bin");
    let build = std::fs::read_link(bin.join("facade"))
        .expect("the launcher")
        .parent()
        .unwrap()
        .to_path_buf();
    for name in ["facade", "facade-mcp"] {
        assert_eq!(
            std::fs::read_link(bin.join(name)).unwrap(),
            build.join(name),
            "the launcher of {name} points at its build's"
        );
        assert!(
            bin.join(&build).join(name).exists(),
            "{name} is installed in {}",
            build.display()
        );
    }
    let daemon = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("the daemon answers") as i32;
    let keeper = home.keeper_pid().expect("the keeper runs");
    // The services start from the launcher, which names this build.
    let program = bin.join("facade");
    for (service, pid) in [("daemon", daemon), ("keeper", keeper)] {
        let command = command_of(pid);
        assert!(
            command.starts_with(&format!("{} {service}", program.display())),
            "the {service} runs {command}"
        );
    }
    let args: Vec<String> = serde_json::from_slice(&std::fs::read(args_file).unwrap()).unwrap();
    let run = facade_rules::run_folder(&home.path.join("core/runs"), &agent.id)
        .expect("the fake CLI has one run directory");
    let config_file = run.join("mcp.json");
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--mcp-config" && Path::new(&pair[1]) == config_file),
        "the CLI is given its run's MCP configuration: {args:?}"
    );
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config_file).unwrap()).unwrap();
    assert_eq!(
        config["mcpServers"]["facade"]["command"],
        bin.join("facade-mcp").display().to_string(),
        "its MCP server is the launcher"
    );
    let identity = facade_base::process::ProcessIdentity {
        pid: agent.pid as u32,
        birth: facade_base::unix_process::birth(agent.pid as u32)
            .unwrap()
            .expect("the CLI runs"),
    };
    let env = facade_base::unix_process::environment(&identity)
        .unwrap()
        .expect("the CLI's environment");
    let hook = env
        .get("FAKECLI_SESSION_HOOK")
        .expect("the CLI is given its session hook");
    assert!(
        hook.starts_with(&format!(
            "'{}' hook session-start ",
            bin.join("facade").display()
        )),
        "its session hook runs the launcher: {hook}"
    );
}

/// Facade's programs and launchers that the person deletes while the daemon runs are put back
/// before a start names them, so the start's CLI gets its tools.
// Windows refuses to delete a program while it runs, so the person cannot delete them there.
#[cfg(unix)]
#[test]
fn programs_deleted_while_facade_runs_are_put_back_before_a_start_names_them() {
    let home = TestHome::new("putback");
    home.start_named_fake("w1", &[]);
    let bin = home.path.join("core").join("bin");
    let build = launcher_build(&home.path).expect("the launchers point at a build");
    std::fs::remove_dir_all(&bin).unwrap();
    // The fake CLI draws once its server answers.
    home.start_named_fake("w2", &[]);
    for name in ["facade", "facade-mcp"] {
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(bin.join(name)).unwrap(),
            std::path::Path::new(&build).join(name),
            "the launcher of {name} is back"
        );
        assert!(
            bin.join(&build).join(program_name(name)).is_file()
                && bin.join(program_name(name)).is_file(),
            "{name} is back in {build}"
        );
    }
    let ready = || {
        home.agent_from_watch("w2")
            .is_some_and(|row| row["tools_state"] == "available")
    };
    assert!(
        wait_until(secs(15), ready),
        "{:?}",
        home.agent_from_watch("w2")
    );
}

/// A daemon of the same build from other bytes, started while the keeper runs the build's programs,
/// installs its own by copy and rename, as release builds are installed: the keeper runs on from
/// the file it started from and takes the new daemon, and an agent that ran before types on. The
/// keeper starts the next daemon from the new file.
#[cfg(unix)]
#[test]
fn programs_installed_again_while_the_keeper_runs_them_are_replaced_by_copy_and_rename() {
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let home = TestHome::new("reinstall");
    let copy = |name: &str, extra: &[u8]| {
        let folder = home.folder().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        for (program, binary) in [
            ("facade", &test_binaries().facade),
            ("facade-mcp", &test_binaries().mcp),
        ] {
            std::fs::copy(binary, folder.join(program)).unwrap();
        }
        // Bytes at its end change the file, not the program.
        std::fs::OpenOptions::new()
            .append(true)
            .open(folder.join("facade"))
            .unwrap()
            .write_all(extra)
            .unwrap();
        folder.join("facade")
    };
    let (first, second) = (
        copy("first", b""),
        copy("second", b"other bytes of this build"),
    );
    let without_switch = |program: &std::path::Path, words: &[&str]| {
        let mut command = home.command(program);
        command
            .args(words)
            .env_remove("FACADE_TEST_LINK_PROGRAMS")
            .stdin(std::process::Stdio::null());
        command
    };
    // macOS checks a program the first time it runs, for a second or more; the second copy's check
    // is not timed below.
    assert!(
        without_switch(&second, &["--version"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let detached = without_switch(&first, &["daemon", "--detach"])
        .output()
        .unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    let agent = home.start_named_fake("w1", &[]);
    let bin = home.path.join("core").join("bin");
    let installed = bin.join(std::fs::read_link(bin.join("facade")).unwrap());
    let keeper = home.keeper_pid().expect("the keeper runs");
    assert!(
        command_of(keeper).starts_with(&format!("{} keeper", bin.join("facade").display())),
        "the keeper runs {}",
        command_of(keeper)
    );
    let (daemon, before) = (
        home.daemon_pid().unwrap(),
        std::fs::metadata(&installed).unwrap().ino(),
    );
    // The keeper is held still meanwhile, so that it starts no daemon of its own before the second
    // copy's.
    pause_process(keeper);
    let ending = process_identity(daemon);
    kill_process(daemon);
    let ended = wait_until(secs(10), || !alive(&ending));
    let said = home.folder().join("second.log");
    let mut serving = without_switch(&second, &["daemon"])
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&said).unwrap())
        .spawn()
        .unwrap();
    let length = std::fs::metadata(&second).unwrap().len();
    let replaced = wait_until(secs(10), || {
        std::fs::metadata(&installed).is_ok_and(|meta| meta.len() == length)
    });
    resume_process(keeper);
    let log = || std::fs::read_to_string(&said).unwrap_or_default();
    assert!(
        ended && replaced,
        "the daemon ended: {ended}; the second copy was installed: {replaced}; {}",
        log()
    );
    assert!(
        wait_until(secs(30), || home.daemon_pid() == Some(serving.id() as i32)),
        "the second copy's daemon serves: {}",
        log()
    );
    assert_eq!(
        std::fs::read(&installed).unwrap(),
        std::fs::read(&second).unwrap(),
        "the build's folder holds the second copy"
    );
    let meta = std::fs::symlink_metadata(&installed).unwrap();
    assert!(
        !meta.file_type().is_symlink()
            && meta.permissions().mode() & 0o777 == 0o700
            && meta.ino() != before,
        "{meta:?}"
    );
    assert_eq!(home.keeper_pid(), Some(keeper), "the keeper runs on");
    type_raw(&mut connect(&home), &agent.id, "after the install\r");
    assert!(
        wait_until(secs(10), || home.submitted_messages()
            == ["after the install"]),
        "{:?}",
        home.submitted_messages()
    );
    let second_daemon = serving.id() as i32;
    kill_process(second_daemon);
    let _ = serving.wait();
    let again = home
        .wait_for_daemon_after(second_daemon, secs(20))
        .expect("the keeper starts the daemon again");
    assert!(
        command_of(again).starts_with(&format!("{} daemon", bin.join("facade").display())),
        "the keeper started {}",
        command_of(again)
    );
}

/// Facade started from a copy of its programs, as a release build is, runs from copies in its
/// build's folder that only this user can use: a daemon `--detach` starts, and the keeper that a
/// daemon started as the copy starts. Once that copy is gone, a run's hook still writes its
/// session, a new run's server starts through its launcher, and the keeper starts a killed daemon
/// again from the build's folder.
#[cfg(unix)]
#[test]
fn facade_started_from_a_copy_runs_on_once_that_copy_is_gone() {
    use std::os::unix::fs::PermissionsExt;
    const SELECTED: &str = "96da4482-2bae-4a45-b193-a5664c19826b";
    let home = TestHome::new("fromcopy");
    let copy = home.folder().join("installed");
    std::fs::create_dir_all(&copy).unwrap();
    for (name, binary) in [
        ("facade", &test_binaries().facade),
        ("facade-mcp", &test_binaries().mcp),
    ] {
        std::fs::copy(binary, copy.join(name)).unwrap();
    }
    let as_copy = |words: &[&str]| {
        let mut command = home.command(copy.join("facade"));
        command
            .args(words)
            .env_remove("FACADE_TEST_LINK_PROGRAMS")
            .stdin(std::process::Stdio::null());
        command
    };
    let detached = as_copy(&["daemon", "--detach"]).output().unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    let bin = home.path.join("core").join("bin");
    let build = bin.join(
        std::fs::read_link(bin.join("facade"))
            .unwrap()
            .parent()
            .unwrap(),
    );
    let program = bin.join("facade");
    let started = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("the daemon answers") as i32;
    assert!(
        command_of(started).starts_with(&format!("{} daemon", program.display())),
        "--detach started {}",
        command_of(started)
    );
    // The next daemon takes the daemon lock once this one has ended: its socket goes first.
    let ending = process_identity(started);
    send_signal(started, libc::SIGTERM);
    assert!(
        wait_until(secs(10), || !alive(&ending)),
        "the daemon did not end"
    );
    // A daemon run as the copy itself starts the keeper from its build's folder.
    let said = home.folder().join("foreground.log");
    let mut foreground = as_copy(&["daemon"])
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&said).unwrap())
        .spawn()
        .unwrap();
    let log = || std::fs::read_to_string(&said).unwrap_or_default();
    // It compares its program with the installed one byte by byte before it serves, which a loaded
    // machine reads slowly.
    assert!(
        wait_until(secs(30), || home.hello_result().is_some()),
        "the daemon did not start: {}",
        log()
    );
    let agent = home.start_named_fake(
        "w1",
        &[("FAKECLI_SESSION", "86da4482-2bae-4a45-b193-a5664c19826a")],
    );
    let keeper = home.keeper_pid().expect("the keeper runs");
    assert!(
        command_of(keeper).starts_with(&format!("{} keeper", program.display())),
        "the keeper runs {}",
        command_of(keeper)
    );
    std::fs::remove_dir_all(&copy).unwrap();
    for path in [
        bin.clone(),
        build.clone(),
        build.join("facade"),
        build.join("facade-mcp"),
    ] {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(
            !meta.file_type().is_symlink() && meta.permissions().mode() & 0o777 == 0o700,
            "{}: {meta:?}",
            path.display()
        );
    }
    type_raw(
        &mut connect(&home),
        &agent.id,
        &format!("/session {SELECTED}\r"),
    );
    let selected = || {
        home.agent_from_watch("w1")
            .is_some_and(|row| row["session"] == SELECTED)
    };
    assert!(
        wait_until(secs(10), selected),
        "the session hook did not write: {:?}",
        home.agent_from_watch("w1")
    );
    home.start_named_fake("w2", &[]);
    let old = home.kill_daemon();
    let _ = foreground.wait();
    let next = home
        .wait_for_daemon_after(old, secs(20))
        .expect("the keeper starts the daemon again");
    assert!(
        command_of(next).starts_with(&format!("{} daemon", program.display())),
        "the next daemon runs {}",
        command_of(next)
    );
}
