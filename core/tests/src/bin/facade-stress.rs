//! facade-stress: Facade core's stress test, the measures and targets of D6.7, with fake CLIs in a
//! Facade home of its own. Not part of `cargo test`; run it from `core/`:
//!
//! `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo run --release -p facade-scenarios --bin
//! facade-stress -- [--agents 100] [--flooders 100] [--large 0] [--json <file>] [--baseline <file>]`
//!
//! Optimized, with debug assertions on: the fake CLI's rule, `fake`, which tells Facade how to
//! read its input box, is only in such builds.
//!
//! For `--agents` fake CLIs: the time to start them all, and until each draws its input box; the
//! daemon's memory, threads and idle CPU, and the keeper's memory; one message from a guest to
//! every agent at once, each response's latency, and each message found in the fake CLIs' log; and
//! keystroke echo through `facade attach` to an agent running `cat`. Then the same keystrokes and
//! messages while `--flooders` more agents print continuously (0 skips them). `--large` agents in
//! a home of their own (0, the default, skips them; macOS gives about 480 terminals unless
//! `kern.tty.ptmx_max` is raised): their start, the daemon's memory and one message to each.
//!
//! Each measure is printed beside its D6.7 target, and `--json` writes them all. `--baseline`
//! compares the run with an earlier `--json` of a run of the same shape on the same kind of
//! machine (D6.9): a measure more than 20% worse, and worse by more than its noise floor, fails.
//! The program exits 1 when a target or the comparison fails, naming what failed, and 2 when the
//! baseline is of another shape.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

/// What each flooding agent runs: a line every 10 ms, forever.
const FLOOD: &str = r#"use Time::HiRes qw(usleep); $|=1; while (1) { print "flood $$ 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\n"; usleep(10000) }"#;

/// How much worse than its baseline a measure may be (D6.9).
const WORSE_BY: f64 = 0.20;

/// The measures a baseline compares, each with its unit and its noise floor: a measure fails once
/// it is more than 20% worse than the baseline and worse by more than its floor, so that a measure
/// near zero, such as an idle CPU of 0.0%, does not fail on noise. Each is worse when higher.
/// Keystroke echo compares by its median, which a loaded machine hardly moves; its p95 is checked
/// against D6.7's 16 ms only.
/// The daemon's threads are reported, not compared: they come and go with its work, 17 to 44 between
/// two runs of the same build.
const COMPARED: &[(&str, &str, f64)] = &[
    ("/start/seconds", "s", 0.5),
    ("/start/ready_seconds", "s", 1.0),
    ("/idle/daemon_mb", "MB", 10.0),
    ("/idle/daemon_cpu_percent", "%", 0.5),
    ("/idle/keeper_mb", "MB", 1.0),
    ("/messages/latency_ms/p95", "ms", 100.0),
    ("/keys/p50", "ms", 1.0),
    ("/flood/daemon_cpu_percent", "%", 5.0),
    ("/flood/daemon_mb", "MB", 20.0),
    ("/flood/keys/p50", "ms", 1.0),
    ("/flood/messages/latency_ms/p95", "ms", 100.0),
    ("/large_run/start/seconds", "s", 1.0),
    ("/large_run/idle/daemon_mb", "MB", 20.0),
    ("/large_run/messages/latency_ms/p95", "ms", 100.0),
];

/// What makes two runs comparable.
const SHAPE: &[&str] = &["agents", "flooders", "large", "os", "arch"];

struct Options {
    agents: usize,
    flooders: usize,
    large: usize,
    json: Option<String>,
    baseline: Option<String>,
}

fn options() -> Options {
    let mut options = Options {
        agents: 100,
        flooders: 100,
        large: 0,
        json: None,
        baseline: None,
    };
    let mut args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned());
    while let Some(arg) = args.next() {
        let mut number = |name: &str| -> usize {
            args.next()
                .and_then(|value| value.parse().ok())
                .unwrap_or_else(|| panic!("{name} takes a number"))
        };
        match arg.as_str() {
            "--agents" => options.agents = number("--agents"),
            "--flooders" => options.flooders = number("--flooders"),
            "--large" => options.large = number("--large"),
            "--json" => options.json = args.next(),
            "--baseline" => options.baseline = args.next(),
            other => {
                panic!("unknown option {other}; see the comment at the top of facade-stress.rs")
            }
        }
    }
    options
}

fn summary(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    let at = |p: f64| {
        values
            .get(((values.len() as f64 * p) as usize).min(values.len().saturating_sub(1)))
            .copied()
            .unwrap_or(f64::NAN)
    };
    json!({ "p50": at(0.5), "p95": at(0.95), "max": values.last().copied().unwrap_or(f64::NAN), "count": values.len() })
}

/// A process's own memory in MB, as macOS's `footprint` counts it.
fn memory_mb(pid: i32) -> f64 {
    let out = Command::new("footprint")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|out| stdout(&out))
        .unwrap_or_default();
    let Some(rest) = out.split("Footprint:").nth(1) else {
        return f64::NAN;
    };
    let mut words = rest.split_whitespace();
    let value: f64 = words
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(f64::NAN);
    match words.next() {
        Some("KB") => value / 1024.0,
        Some("GB") => value * 1024.0,
        _ => value,
    }
}

fn cpu_seconds(pid: i32) -> f64 {
    let out = Command::new("ps")
        .args(["-o", "time=", "-p", &pid.to_string()])
        .output()
        .map(|out| stdout(&out))
        .unwrap_or_default();
    // [[dd-]hh:]mm:ss[.xx]
    out.trim()
        .replace('-', ":")
        .split(':')
        .fold(0.0, |total, part| {
            total * 60.0 + part.parse::<f64>().unwrap_or(0.0)
        })
}

fn cpu_percent(pid: i32, over: Duration) -> f64 {
    let before = cpu_seconds(pid);
    std::thread::sleep(over);
    100.0 * (cpu_seconds(pid) - before) / over.as_secs_f64()
}

fn threads(pid: i32) -> usize {
    let out = Command::new("ps")
        .args(["-M", "-p", &pid.to_string()])
        .output()
        .map(|out| stdout(&out))
        .unwrap_or_default();
    out.lines().count().saturating_sub(1)
}

fn daemon(home: &TestHome) -> i32 {
    home.daemon_pid().expect("the daemon runs")
}

/// Starts agents `prefix0..` running `command` with `facade start`, which returns once each runs;
/// their IDs and names, and how long the commands took.
fn start_many(
    home: &TestHome,
    count: usize,
    prefix: &str,
    command: &[&str],
) -> (Vec<(String, String)>, Duration) {
    let began = Instant::now();
    let agents = (0..count)
        .map(|i| {
            let name = format!("{prefix}{i}");
            let mut args = vec!["start", "--name", &name];
            args.extend_from_slice(command);
            let agent = started_agent(&home.run_facade_ok(&args));
            (agent.id, name)
        })
        .collect();
    (agents, began.elapsed())
}

/// Waits until every agent has drawn its input box: whether they all did.
fn all_ready(home: &TestHome, agents: &[(String, String)]) -> bool {
    let mut waiting: Vec<&String> = agents.iter().map(|(_, name)| name).collect();
    wait_until(secs(120), || {
        waiting.retain(|name| !home.screen(name).contains("❯"));
        waiting.is_empty()
    })
}

/// Starts `count` fake CLIs by their rule's name, and waits for their input boxes.
fn start(home: &TestHome, count: usize) -> (Vec<(String, String)>, Value) {
    let began = Instant::now();
    let (agents, took) = start_many(home, count, "f", &["fake"]);
    let ready = all_ready(home, &agents);
    let report = json!({
        "started": agents.len(), "seconds": took.as_secs_f64(),
        "all_ready": ready, "ready_seconds": began.elapsed().as_secs_f64(),
    });
    println!("started: {report}");
    (agents, report)
}

fn idle(home: &TestHome) -> Value {
    let daemon = daemon(home);
    let keeper = home.keeper_pid().expect("the keeper runs");
    let report = json!({
        "daemon_mb": memory_mb(daemon), "daemon_threads": threads(daemon),
        "daemon_cpu_percent": cpu_percent(daemon, secs(8)), "keeper_mb": memory_mb(keeper),
    });
    println!("idle: {report}");
    report
}

/// One message from `guest` to every agent at once: how many succeeded, each response's latency, and
/// how many the fake CLIs logged as submitted.
fn message_everyone(
    home: &TestHome,
    guest: &mut McpTestClient,
    agents: &[(String, String)],
    tag: &str,
) -> Value {
    let mut pending: Vec<(usize, u64, Instant)> = agents
        .iter()
        .enumerate()
        .map(|(k, (id, _))| {
            let at = Instant::now();
            let params = json!({ "name": "send_message", "arguments": { "to": id, "text": format!("{tag}-{k}") } });
            (k, guest.send("tools/call", params), at)
        })
        .collect();
    let began = Instant::now();
    let mut latencies = Vec::new();
    let mut succeeded = 0;
    while !pending.is_empty() && began.elapsed() < secs(120) {
        pending.retain(|(_, id, at)| match guest.answer(*id, Duration::ZERO) {
            Some(response) => {
                latencies.push(at.elapsed().as_secs_f64() * 1000.0);
                if response["result"]["structuredContent"]["status"] == "success" {
                    succeeded += 1;
                } else {
                    eprintln!("a send failed: {response}");
                }
                false
            }
            None => true,
        });
        std::thread::sleep(Duration::from_millis(1));
    }
    let took = began.elapsed();
    let mut submitted = 0;
    wait_until(secs(10), || {
        // Each message is submitted under the line Facade heads it with.
        let lines: std::collections::HashSet<String> = home
            .submitted_messages()
            .iter()
            .flat_map(|text| text.lines().map(str::to_string).collect::<Vec<_>>())
            .collect();
        submitted = (0..agents.len())
            .filter(|k| lines.contains(&format!("{tag}-{k}")))
            .count();
        submitted == agents.len()
    });
    let report = json!({
        "sent": agents.len(), "succeeded": succeeded, "submitted": submitted,
        "seconds": took.as_secs_f64(), "latency_ms": summary(latencies),
    });
    println!("messages: {report}");
    report
}

/// Keystroke echo through `facade attach`: each key written to the attach's terminal, timed until
/// it comes back.
fn key_latency(home: &TestHome, agent: &str, keys: usize) -> Value {
    let size = nix::pty::Winsize {
        ws_row: 30,
        ws_col: 100,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = nix::pty::openpty(Some(&size), None).expect("a pseudo-terminal");
    let terminal = std::fs::File::from(pty.slave);
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["attach", agent])
        .stdin(terminal.try_clone().unwrap())
        .stdout(terminal.try_clone().unwrap())
        .stderr(terminal);
    // SAFETY: setsid and the controlling-terminal ioctl are async-signal-safe and only touch the
    // child.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY as _, 0);
            Ok(())
        });
    }
    let mut child = command.spawn().expect("attach starts");
    let mut master = std::fs::File::from(pty.master);
    let drain = |master: &mut std::fs::File, how_long: Duration| {
        let end = Instant::now() + how_long;
        while Instant::now() < end {
            read_some(master, Duration::from_millis(20));
        }
    };
    drain(&mut master, Duration::from_millis(1500));
    let mut times = Vec::new();
    for k in 0..keys {
        let key = b'a' + (k % 26) as u8;
        let began = Instant::now();
        master.write_all(&[key]).expect("the terminal takes keys");
        let mut got = Vec::new();
        while !got.contains(&key) && began.elapsed() < secs(2) {
            got.extend(read_some(&mut master, secs(2)));
        }
        times.push(began.elapsed().as_secs_f64() * 1000.0);
        if k % 13 == 12 {
            master.write_all(b"\r").unwrap();
        }
        drain(&mut master, Duration::from_millis(20));
    }
    // Ctrl-] detaches.
    let _ = master.write_all(b"\x1d");
    std::thread::sleep(Duration::from_millis(300));
    // The terminal goes first: a process ending on a terminal nobody reads waits for its output.
    drop(master);
    drop(command);
    let _ = child.kill();
    let _ = child.wait();
    let report = summary(times);
    println!("keystroke echo: {report}");
    report
}

/// What the terminal has for us within `timeout`: nothing once it times out.
fn read_some(master: &mut std::fs::File, timeout: Duration) -> Vec<u8> {
    let mut poll = libc::pollfd {
        fd: master.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid pollfd for the duration of the call.
    let ready = unsafe { libc::poll(&mut poll, 1, timeout.as_millis() as i32) };
    let mut buffer = [0u8; 65536];
    match ready {
        1.. => master
            .read(&mut buffer)
            .map(|n| buffer[..n].to_vec())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn verdict(name: &str, value: f64, limit: f64, unit: &str, failed: &mut Vec<String>) {
    let pass = value.is_finite() && value < limit;
    println!(
        "  {name:<48} {value:>10.2} {unit:<3} target < {limit:.0} {unit}  {}",
        if pass { "PASS" } else { "FAIL" }
    );
    if !pass {
        failed.push(format!(
            "{name}: {value:.2} {unit}, target < {limit:.0} {unit}"
        ));
    }
}

fn check(name: &str, pass: bool, failed: &mut Vec<String>) {
    println!(
        "  {name:<48} {:>18}  {}",
        "",
        if pass { "PASS" } else { "FAIL" }
    );
    if !pass {
        failed.push(name.to_string());
    }
}

/// Whether `baseline` is of a run of this shape on this kind of machine.
fn same_shape(report: &Value, baseline: &Value) -> Result<(), String> {
    for key in SHAPE {
        if baseline[key] != report[key] {
            return Err(format!(
                "the baseline's {key} is {}, this run's {}: compare only runs of the same shape on \
                 the same kind of machine",
                baseline[key], report[key]
            ));
        }
    }
    Ok(())
}

/// The measures of `report` that are worse than `baseline` beyond what D6.9 allows, each named.
fn compare(report: &Value, baseline: &Value) -> Result<Vec<String>, String> {
    same_shape(report, baseline)?;
    let mut worse = Vec::new();
    println!(
        "\n== compared with the baseline (fails beyond {:.0}% worse and the noise floor)",
        WORSE_BY * 100.0
    );
    for (pointer, unit, floor) in COMPARED {
        let (Some(now), Some(then)) = (
            report.pointer(pointer).and_then(Value::as_f64),
            baseline.pointer(pointer).and_then(Value::as_f64),
        ) else {
            continue;
        };
        let allowed = then * (1.0 + WORSE_BY) + floor;
        let pass = now.is_finite() && now <= allowed;
        println!(
            "  {pointer:<48} {now:>10.2} {unit:<3} baseline {then:>8.2}, allowed {allowed:>8.2}  {}",
            if pass { "PASS" } else { "FAIL" }
        );
        if !pass {
            worse.push(format!(
                "{pointer}: {now:.2} {unit}, baseline {then:.2} {unit}, allowed {allowed:.2} {unit}"
            ));
        }
    }
    Ok(worse)
}

fn main() {
    let options = options();
    let mut report = json!({
        "agents": options.agents, "flooders": options.flooders, "large": options.large,
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
    });
    let baseline: Option<Value> = options.baseline.as_ref().map(|path| {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|err| panic!("the baseline {path}: {err}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("the baseline {path} is not JSON: {err}"))
    });
    if let Some(baseline) = &baseline
        && let Err(mismatch) = same_shape(&report, baseline)
    {
        eprintln!("{mismatch}");
        std::process::exit(2);
    }

    println!("== {} fake agents", options.agents);
    let home = TestHome::new("stress");
    let (agents, started) = start(&home, options.agents);
    report["start"] = started;
    std::thread::sleep(secs(5));
    report["idle"] = idle(&home);
    let mut guest =
        McpTestClient::open_guest(&home, "claude", &[("CLAUDE_CODE_SESSION_ID", "stress")]);
    report["messages"] = message_everyone(&home, &mut guest, &agents, "load");
    let (quiet, _) = start_many(&home, 1, "quiet", &["/bin/cat"]);
    let quiet = &quiet[0].0;
    std::thread::sleep(secs(1));
    report["keys"] = key_latency(&home, quiet, 50);
    if options.flooders > 0 {
        println!("== while {} more agents print", options.flooders);
        start_many(
            &home,
            options.flooders,
            "flood",
            &["/usr/bin/perl", "-e", FLOOD],
        );
        std::thread::sleep(secs(3));
        let daemon = daemon(&home);
        report["flood"] = json!({ "daemon_cpu_percent": cpu_percent(daemon, secs(8)) });
        report["flood"]["keys"] = key_latency(&home, quiet, 50);
        report["flood"]["messages"] = message_everyone(&home, &mut guest, &agents, "busy");
        report["flood"]["daemon_mb"] = json!(memory_mb(daemon));
        println!("flood: {}", report["flood"]);
    }
    drop(guest);
    drop(home);

    if options.large > 0 {
        println!("== {} fake agents", options.large);
        let home = TestHome::new("stresslarge");
        let (agents, started) = start(&home, options.large);
        std::thread::sleep(secs(5));
        let mut large = json!({ "start": started, "idle": idle(&home) });
        let mut guest =
            McpTestClient::open_guest(&home, "claude", &[("CLAUDE_CODE_SESSION_ID", "stress")]);
        large["messages"] = message_everyone(&home, &mut guest, &agents, "large");
        report["large_run"] = large;
    }

    println!("\n== D6.7 targets");
    let mut failed: Vec<String> = Vec::new();
    let at = |pointer: &str| {
        report
            .pointer(pointer)
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    let every = |pointer: &str, count: usize| {
        let part = &report.pointer(pointer).cloned().unwrap_or_default();
        part["succeeded"] == count && part["submitted"] == count
    };
    check(
        &format!("{} agents started and drew their input", options.agents),
        report["start"]["all_ready"] == true,
        &mut failed,
    );
    check(
        "every message sent and submitted",
        every("/messages", options.agents),
        &mut failed,
    );
    verdict(
        "message p95",
        at("/messages/latency_ms/p95"),
        1000.0,
        "ms",
        &mut failed,
    );
    verdict(
        "keystroke echo p95",
        at("/keys/p95"),
        16.0,
        "ms",
        &mut failed,
    );
    verdict(
        "idle daemon CPU",
        at("/idle/daemon_cpu_percent"),
        1.0,
        "%",
        &mut failed,
    );
    verdict(
        "idle daemon memory",
        at("/idle/daemon_mb"),
        300.0,
        "MB",
        &mut failed,
    );
    if options.flooders > 0 {
        let flooders = options.flooders;
        check(
            &format!("every message sent and submitted while {flooders} print"),
            every("/flood/messages", options.agents),
            &mut failed,
        );
        verdict(
            &format!("message p95 while {flooders} print"),
            at("/flood/messages/latency_ms/p95"),
            1000.0,
            "ms",
            &mut failed,
        );
        verdict(
            &format!("keystroke echo p95 while {flooders} print"),
            at("/flood/keys/p95"),
            16.0,
            "ms",
            &mut failed,
        );
    }
    if options.large > 0 {
        let large = options.large;
        check(
            &format!("{large} agents started and drew their input"),
            report["large_run"]["start"]["all_ready"] == true,
            &mut failed,
        );
        check(
            &format!("every message sent and submitted at {large}"),
            every("/large_run/messages", large),
            &mut failed,
        );
        verdict(
            &format!("daemon memory at {large} agents"),
            at("/large_run/idle/daemon_mb"),
            1536.0,
            "MB",
            &mut failed,
        );
    }
    if let Some(baseline) = &baseline {
        match compare(&report, baseline) {
            Ok(worse) => failed.extend(worse),
            Err(mismatch) => {
                eprintln!("\n{mismatch}");
                std::process::exit(2);
            }
        }
    }
    report["failed"] = json!(failed);
    if let Some(path) = &options.json {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap())
            .expect("the report is written");
        println!("\nreport written to {path}");
    }
    if !failed.is_empty() {
        eprintln!("\nFAILED:");
        for failure in &failed {
            eprintln!("  {failure}");
        }
        std::process::exit(1);
    }
}
