//! Real CLIs as recipients: a Facade home of the storm's own with the person's own home folder and
//! logins, the cheapest models, and what each CLI submitted as its own saved session says.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

use crate::client;
use crate::lab::{Agent, Lab};
use crate::person::{COLS, ROWS, now_us};

/// A CLI under test: its entry in the settings, and the cheapest model it has.
#[derive(Clone, Copy, Debug)]
pub struct Cli {
    pub name: &'static str,
    pub model: Option<&'static str>,
    pub effort: Option<&'static str>,
    /// The entry's own words on every start.
    pub args: &'static [&'static str],
    /// The least time one short message takes in its input: its settle time and the store's writes.
    pub service_ms: u64,
}

pub const CLIS: &[Cli] = &[
    Cli {
        name: "claude",
        model: Some("haiku"),
        effort: Some("low"),
        args: &[],
        service_ms: 86,
    },
    Cli {
        name: "codex",
        model: Some("gpt-6-luna"),
        effort: Some("low"),
        args: &[],
        service_ms: 86,
    },
    Cli {
        name: "agy",
        model: Some("gemini-3.8-flash-low"),
        effort: None,
        args: &[],
        service_ms: 176,
    },
    Cli {
        name: "muse",
        model: None,
        effort: None,
        args: &[
            "--disable-approval",
            "--disable-sandbox",
            "--trust-workspace",
            "--provider",
            "echo",
        ],
        service_ms: 256,
    },
    Cli {
        name: "opencode",
        model: None,
        effort: None,
        args: &[],
        service_ms: 86,
    },
    Cli {
        name: "pi",
        model: Some("deepseek-v4.1-flash"),
        effort: Some("off"),
        args: &[],
        service_ms: 86,
    },
];

pub fn cli(name: &str) -> anyhow::Result<&'static Cli> {
    CLIS.iter()
        .find(|cli| cli.name == name)
        .with_context(|| format!("no CLI under test is named {name}"))
}

/// The variables a person's terminal has: this process's, without any run's or Facade's own.
pub fn person_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| {
            let upper = name.to_uppercase();
            !["FACADE", "CLAUDE", "CODEX", "MUSE", "ORCA", "FAKECLI"]
                .iter()
                .any(|prefix| upper.starts_with(prefix))
        })
        .collect()
}

impl Lab {
    /// A home whose agents run real CLIs, under `root`, its daemon running.
    pub fn real(root: &Path, name: &str, work: &Path) -> anyhow::Result<Lab> {
        let folder = root.join(format!("stress-{name}-{}", std::process::id()));
        let home = TestHome {
            path: folder.join("home"),
            project: folder.join("project"),
            fake_log: folder.join("fake.log"),
        };
        facade_base::files::create_private_folder_all(&home.path)?;
        std::fs::create_dir_all(&home.project)?;
        std::fs::create_dir_all(work)?;
        let mut clis = serde_json::Map::new();
        for cli in CLIS {
            if !cli.args.is_empty() {
                clis.insert(cli.name.into(), json!({ "args": cli.args }));
            }
        }
        std::fs::write(
            home.path.join("facade.json"),
            serde_json::to_string_pretty(&json!({ "clis": clis }))?,
        )?;
        let started = std::process::Command::new(&test_binaries().facade)
            .args(["daemon", "--detach"])
            .env_clear()
            .envs(person_env())
            .env("FACADE_HOME", &home.path)
            .current_dir(&home.project)
            .stdin(std::process::Stdio::null())
            .output()?;
        anyhow::ensure!(
            started.status.success(),
            "the daemon did not start: {}",
            stderr(&started)
        );
        anyhow::ensure!(
            wait_until(LOADED_TIMEOUT, || home.hello_result().is_some()),
            "the daemon did not answer"
        );
        let wire = client::terminal(&home.daemon_socket())?;
        let tapes = folder.join("tapes");
        std::fs::create_dir_all(&tapes)?;
        Ok(Lab { home, wire, tapes })
    }

    /// Starts `cli` as agent `name` in a new folder of its own.
    pub fn start_real(
        &self,
        cli: &Cli,
        name: &str,
        folder: &Path,
        prompt: Option<&str>,
    ) -> anyhow::Result<Agent> {
        std::fs::create_dir_all(folder)?;
        if cli.name == "opencode" {
            std::fs::write(
                folder.join("opencode.json"),
                r#"{"$schema":"https://opencode.ai/config.json","model":"opencode/deepseek-v4.1-flash-free"}"#,
            )?;
        }
        let mut args = json!({
            "name": name, "cli": cli.name, "folder": folder, "env": person_env(),
            "size": { "cols": COLS, "rows": ROWS },
        });
        for (key, value) in [
            ("model", cli.model),
            ("effort", cli.effort),
            ("prompt", prompt),
        ] {
            if let Some(value) = value {
                args[key] = json!(value);
            }
        }
        let started = self.wire.call("agent.start", args)?;
        Lab::agent(&started["agent"])
    }
}

/// What an agent's input read as over time, and its state, polled without a view.
pub struct Timeline {
    seen: Arc<Mutex<Vec<(u64, String, String)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Timeline {
    pub fn watch(socket: &Path, reference: &Value, every: Duration) -> anyhow::Result<Timeline> {
        let wire = client::terminal(socket)?;
        let seen: Arc<Mutex<Vec<(u64, String, String)>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (seen_in, stop_in, reference) = (seen.clone(), stop.clone(), reference.clone());
        let thread = std::thread::spawn(move || {
            while !stop_in.load(Ordering::SeqCst) {
                if let Ok(info) = wire.call("agent.inspect", json!({ "target": reference })) {
                    let input = info["input"]["state"].as_str().unwrap_or("").to_string();
                    let state = info["agent"]["state"].as_str().unwrap_or("").to_string();
                    let mut seen = seen_in.lock().unwrap();
                    if seen
                        .last()
                        .is_none_or(|(_, i, s)| *i != input || *s != state)
                    {
                        seen.push((now_us(), input, state));
                    }
                }
                std::thread::sleep(every);
            }
        });
        Ok(Timeline {
            seen,
            stop,
            thread: Some(thread),
        })
    }

    pub fn end(mut self) -> Vec<(u64, String, String)> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.seen.lock().unwrap().clone()
    }
}

/// Files under `roots` written since `since` whose path names `session`.
fn files_of(roots: &[PathBuf], session: &str, since: SystemTime) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders: Vec<PathBuf> = roots.to_vec();
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                folders.push(path);
            } else if path.to_string_lossy().contains(session)
                && meta.modified().is_ok_and(|at| at >= since)
            {
                found.push(path);
            }
        }
    }
    found
}

/// The folders `cli` saves its sessions in.
pub fn session_roots(cli: &str) -> Vec<PathBuf> {
    let home = PathBuf::from(
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .unwrap_or_default(),
    );
    match cli {
        "claude" => vec![home.join(".claude/projects")],
        "codex" => vec![home.join(".codex/sessions")],
        "agy" => vec![home.join(".gemini")],
        "muse" => vec![home.join(".muse"), home.join(".config/muse")],
        "opencode" => vec![home.join(".local/share/opencode")],
        "pi" => vec![home.join(".pi/agent/sessions")],
        _ => Vec::new(),
    }
}

/// Starts each CLI named, sends it one message, and prints its state, its session's files and how
/// long each step took: whether the machine, the models and the logins are what the storms expect.
pub fn smoke(root: &Path, out: &Path, names: &[String]) -> anyhow::Result<Value> {
    let work = root
        .join("work")
        .join("real")
        .join(format!("smoke-{}", std::process::id()));
    let lab = Lab::real(&root.join("homes"), "smoke", &work)?;
    println!("   home {}", lab.home.path.display());
    let listed = lab.wire.call("cli.list", json!({}))?;
    for entry in listed["clis"].as_array().into_iter().flatten() {
        println!("   entry {} available {}", entry["cli"], entry["available"]);
    }
    let sender = lab.start_fake("s01", &[])?;
    lab.wait_ready(std::slice::from_ref(&sender), Duration::from_secs(60))?;
    let mcp = client::Mcp::managed(&lab.home, &sender.id)?;
    let mut report = serde_json::Map::new();
    let mut agents = Vec::new();
    for name in names {
        let cli = cli(name)?;
        let since = SystemTime::now();
        let began = Instant::now();
        let agent = lab.start_real(cli, name, &work.join(name), None)?;
        agents.push(agent.clone());
        let ready = wait_until(Duration::from_secs(90), || {
            lab.input_state(&agent) == "usable"
        });
        let ready_s = began.elapsed().as_secs_f64();
        let sent = crate::storm::send(
            &mcp,
            &sender.id,
            &agent,
            0,
            "storm-smoke: reply with the single word ok and nothing else. Use no tools.".into(),
            "delivery",
        );
        std::thread::sleep(Duration::from_secs(12));
        let info = lab.inspect(&agent)?;
        let session = info["agent"]["session"].as_str().unwrap_or("").to_string();
        let files = if session.is_empty() {
            Vec::new()
        } else {
            files_of(&session_roots(name), &session, since)
        };
        let screen = lab
            .wire
            .call(
                "agent.screen",
                json!({ "target": agent.reference, "lines": 40 }),
            )
            .map(|screen| screen["text"].as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        std::fs::create_dir_all(out)?;
        std::fs::write(out.join(format!("{name}.screen.txt")), &screen)?;
        let one = json!({
            "ready": ready, "ready_s": crate::sample::round(ready_s),
            "send": sent.said, "failure": sent.failure, "send_ms": crate::sample::round(sent.took_ms),
            "state": info["agent"]["state"], "input": info["input"]["state"],
            "model": info["agent"]["model"], "session": session,
            "files": files.iter().map(|file| file.display().to_string()).collect::<Vec<_>>(),
        });
        println!("   {name}: {one}");
        report.insert(name.clone(), one);
    }
    agents.push(sender);
    let mut verdict = crate::judge::Verdict::default();
    crate::storm::stop_all(&lab, &agents, &mut verdict);
    for violation in &verdict.violations {
        println!("   {} {}", violation.rule, violation.what);
    }
    lab.keep_evidence(&out.join("lab"))?;
    Ok(Value::Object(report))
}
