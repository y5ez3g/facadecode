//! facade-storm: message delivery under load, with a person in the recipient's window, judged
//! message by message and key by key. Not part of `cargo test`; build it optimized with debug
//! assertions, which the fake CLI's rule needs:
//!
//! `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo build --release -p facade-scenarios --bins`
//!
//! `facade-storm --out <folder> [--only <words>] [--repeat <n>] [--senders <n>] [--each <n>] <set>`
//! `facade-storm --out <folder> --cli <rule> --only <screen log> replay`
//!
//! Each storm runs in a Facade home of its own under `TMP`, and what a storm that breaks a rule left
//! (its store, logs, screens, tapes and ledger) is copied to `--out`, with a report for all of them.
//! `FACADE_STORM_ROOT` names the only folder a storm may write in; the program refuses to run with a
//! `TMP` or `FACADE_HOME` outside it, or with `FACADE_AGENT` set. It exits 0 when every storm kept
//! every rule, 1 when one broke one, 2 when a storm could not run, and 3 when it refused to run.

mod client;
mod demo;
mod judge;
mod lab;
mod more;
mod perf;
mod person;
mod real;
mod replay;
mod sample;
mod scenes;
mod storm;
mod tape;

use std::path::{Path, PathBuf};

use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::test_binaries;

struct Options {
    set: String,
    out: PathBuf,
    only: Option<String>,
    repeat: usize,
    senders: Option<usize>,
    each: Option<usize>,
    cli: String,
}

fn options() -> Options {
    let mut options = Options {
        set: String::new(),
        out: PathBuf::new(),
        only: None,
        repeat: 1,
        senders: None,
        each: None,
        cli: "fake".into(),
    };
    let mut args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned());
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| refuse(&format!("{arg} takes a value")))
        };
        let number = |text: String| {
            text.parse()
                .unwrap_or_else(|_| refuse(&format!("not a number: {text}")))
        };
        match arg.as_str() {
            "--out" => options.out = PathBuf::from(value()),
            "--only" => options.only = Some(value()),
            "--repeat" => options.repeat = number(value()),
            "--senders" => options.senders = Some(number(value())),
            "--cli" => options.cli = value(),
            "--each" => options.each = Some(number(value())),
            set if !set.starts_with('-') && options.set.is_empty() => options.set = arg,
            other => refuse(&format!("unknown option {other}")),
        }
    }
    if options.set.is_empty() || options.out.as_os_str().is_empty() {
        refuse("give a set and --out");
    }
    options
}

fn refuse(why: &str) -> ! {
    eprintln!("facade-storm refuses to run: {why}");
    std::process::exit(3);
}

/// A storm never runs where it could reach a home that is not its own.
fn guard(out: &Path) {
    let Some(root) = std::env::var_os("FACADE_STORM_ROOT").map(PathBuf::from) else {
        refuse("FACADE_STORM_ROOT names no folder");
    };
    if std::env::var_os("FACADE_AGENT").is_some() {
        refuse("FACADE_AGENT is set");
    }
    let inside = |path: &Path| {
        let lower = |path: &Path| path.to_string_lossy().replace('/', "\\").to_lowercase();
        let (path, root) = (lower(path), lower(&root));
        path.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
    };
    if let Some(home) = std::env::var_os("FACADE_HOME")
        && !inside(Path::new(&home))
    {
        refuse("FACADE_HOME is outside FACADE_STORM_ROOT");
    }
    if !inside(&std::env::temp_dir()) {
        refuse("TMP is outside FACADE_STORM_ROOT");
    }
    if !inside(out) {
        refuse("--out is outside FACADE_STORM_ROOT");
    }
    // Homes are kept until the storm judged them: a green one is deleted then.
    // SAFETY: no other thread runs yet.
    unsafe {
        std::env::set_var("FACADE_SCENARIO_KEEP", "1");
        std::env::remove_var("FACADE_HOME");
    }
}

fn main() {
    let options = options();
    guard(&options.out);
    std::fs::create_dir_all(&options.out).expect("the folder for the report");
    test_binaries();
    if options.set == "demo" || options.set == "demo-check" {
        let ran = match options.set.as_str() {
            "demo" => demo::run(&options.out),
            _ => demo::check(&options.out),
        };
        if let Err(err) = ran {
            eprintln!("the demo could not run: {err:#}");
            std::process::exit(2);
        }
        return;
    }
    if options.set == "replay" {
        // `--only` names the screen log.
        let log = PathBuf::from(options.only.unwrap_or_default());
        if let Err(err) = replay::run(&log, &options.cli) {
            eprintln!("could not replay {}: {err:#}", log.display());
            std::process::exit(2);
        }
        return;
    }
    if options.set == "smoke" {
        let names: Vec<String> = match &options.only {
            Some(only) => only.split(',').map(str::to_string).collect(),
            None => real::CLIS.iter().map(|cli| cli.name.to_string()).collect(),
        };
        let root = PathBuf::from(std::env::var_os("FACADE_STORM_ROOT").unwrap_or_default());
        match real::smoke(&root, &options.out, &names) {
            Ok(report) => {
                let text = serde_json::to_string_pretty(&report).expect("JSON");
                std::fs::write(options.out.join("smoke.json"), text).expect("the report");
            }
            Err(err) => {
                eprintln!("the smoke test could not run: {err:#}");
                std::process::exit(2);
            }
        }
        return;
    }
    if options.set == "real" {
        real_storms(&options);
    }
    if options.set == "perf" {
        let report = perf::run(options.senders.unwrap_or(50)).unwrap_or_else(|err| {
            eprintln!("the measures could not run: {err:#}");
            std::process::exit(2);
        });
        let text = serde_json::to_string_pretty(&report).expect("JSON");
        std::fs::write(options.out.join("perf.json"), text).expect("the report");
        return;
    }
    let storms = scenes::set(&options.set, options.senders, options.each)
        .unwrap_or_else(|| refuse(&format!("no set is named {}", options.set)));
    let mut outcomes = Vec::new();
    let mut broken = 0usize;
    let mut unable = 0usize;
    for round in 1..=options.repeat {
        for storm in &storms {
            if options
                .only
                .as_ref()
                .is_some_and(|only| !storm.name().contains(only.as_str()))
            {
                continue;
            }
            let name = match options.repeat {
                1 => storm.name().to_string(),
                _ => format!("{} r{round}", storm.name()),
            };
            println!("== {name}");
            match storm.run(&name, &options.out) {
                Ok(outcome) => {
                    print(&outcome);
                    if !outcome.verdict.violations.is_empty() {
                        broken += 1;
                    }
                    outcomes.push(outcome.to_json());
                }
                Err(err) => {
                    unable += 1;
                    println!("   could not run: {err:#}");
                    outcomes.push(json!({ "name": name, "could_not_run": format!("{err:#}") }));
                }
            }
            write_report(&options, &outcomes);
        }
    }
    println!(
        "\n{} storms: {} kept every rule, {broken} broke one, {unable} could not run. Report: {}",
        outcomes.len(),
        outcomes.len() - broken - unable,
        options.out.join("report.json").display()
    );
    std::process::exit(if broken > 0 {
        1
    } else if unable > 0 {
        2
    } else {
        0
    });
}

fn write_report(options: &Options, outcomes: &[Value]) {
    let report = json!({
        "set": options.set, "build": env!("CARGO_PKG_VERSION"), "storms": outcomes,
    });
    let text = serde_json::to_string_pretty(&report).expect("JSON");
    std::fs::write(options.out.join("report.json"), text).expect("the report");
}

/// Runs the storms of real CLIs, and exits.
fn real_storms(options: &Options) -> ! {
    let root = PathBuf::from(std::env::var_os("FACADE_STORM_ROOT").unwrap_or_default());
    let specs = real::specs(options.only.as_deref(), options.senders, options.each);
    let mut outcomes = Vec::new();
    let mut broken = false;
    for round in 1..=options.repeat {
        for spec in &specs {
            let name = match options.repeat {
                1 => spec.name.clone(),
                _ => format!("{} r{round}", spec.name),
            };
            println!("== {name}");
            match real::run(spec, &name, &root, &options.out) {
                Ok(outcome) => {
                    print(&outcome);
                    broken |= !outcome.verdict.violations.is_empty();
                    outcomes.push(outcome.to_json());
                }
                Err(err) => {
                    println!("   could not run: {err:#}");
                    outcomes.push(json!({ "name": name, "could_not_run": format!("{err:#}") }));
                }
            }
            write_report(options, &outcomes);
        }
    }
    std::process::exit(i32::from(broken));
}

/// The outcome for a person to read: how many rules broke, and the first of each.
fn print(outcome: &storm::Outcome) {
    let verdict = &outcome.verdict;
    let stats = &verdict.stats;
    println!(
        "   {:.0} s · sent {} · delivered {} · failed {} (reasonable {}) · submitted after {} ms · send call {} ms",
        outcome.seconds,
        stats["sent"],
        stats["delivered"],
        stats["failed"],
        stats["reasonable"],
        short_summary(&stats["called_to_submitted_ms"]),
        short_summary(&stats["send_call_ms"]),
    );
    for window in stats["windows"].as_array().into_iter().flatten() {
        println!(
            "   {} · longest own text stayed {} ms · keys {}",
            window["agent"].as_str().unwrap_or_default(),
            window["longest_stay_ms"],
            window["keys"]
        );
    }
    if !verdict.strangers.is_empty() {
        println!("   the owner was in: {:?}", verdict.strangers);
    }
    if verdict.violations.is_empty() {
        println!("   PASS");
        return;
    }
    let mut rules: Vec<(&str, Option<&str>)> = verdict
        .violations
        .iter()
        .map(|one| (one.rule, one.class))
        .collect();
    rules.sort_unstable();
    rules.dedup();
    for (rule, class) in rules {
        let these: Vec<_> = verdict
            .violations
            .iter()
            .filter(|one| one.rule == rule && one.class == class)
            .collect();
        println!(
            "   {} {rule}{} ×{}: {}",
            if class.is_some() { "----" } else { "FAIL" },
            class.map(|class| format!(" ({class})")).unwrap_or_default(),
            these.len(),
            these[0].what
        );
    }
    if let Some(evidence) = &outcome.evidence {
        println!("   evidence {}", evidence.display());
    }
}

fn short_summary(summary: &Value) -> String {
    if summary.is_null() {
        return "-".into();
    }
    format!(
        "p50 {} p99 {} max {}",
        summary["p50"], summary["p99"], summary["max"]
    )
}
