//! What every storm of fake CLIs is made of: a home, its agents, what they send, the person in a
//! recipient's window, and the judgement at the end.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use facade_base::base64;
use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

use crate::client::{Mcp, envelope};
use crate::judge::{self, Case, Kind, Read, Sent, Verdict, Violation, Window};
use crate::lab::{Agent, Lab, Row};
use crate::person::{Did, Habit, Person, Way, now_us};

/// When a sender sends its next message.
#[derive(Clone, Copy, Debug)]
pub enum Pace {
    /// Once its last was answered.
    Answered,
    /// This many milliseconds after its last.
    Every(u64),
}

/// What a message says, besides the name that finds it again.
#[derive(Clone, Copy, Debug)]
pub enum Shape {
    Short,
    Lines(usize),
    Wide(usize),
    Chinese(usize),
}

impl Shape {
    pub fn text(self, name: &str) -> String {
        match self {
            Shape::Short => format!("{name} says hello"),
            Shape::Lines(lines) => (0..lines)
                .map(|line| format!("{name} line {line:03}"))
                .collect::<Vec<_>>()
                .join("\n"),
            Shape::Wide(chars) => format!("{name} ")
                .chars()
                .chain("abcdefghijklmnopqrstuvwxyz0123456789 ".chars().cycle())
                .take(chars)
                .collect::<String>()
                .trim_end()
                .to_string(),
            Shape::Chinese(chars) => format!("{name} ")
                .chars()
                .chain("消息必须投递到人的输入一个键都不能丢".chars().cycle())
                .take(chars)
                .collect(),
        }
    }
}

/// Senders that send to one recipient, and people in its window.
#[derive(Clone, Debug)]
pub struct Spec {
    pub name: String,
    pub senders: usize,
    pub per_sender: usize,
    pub pace: Pace,
    pub shape: Shape,
    /// `inbox`, or `delivery` with a 30 second wait.
    pub wait: &'static str,
    /// The person whose keys are followed to the CLI.
    pub person: Option<(Habit, Way)>,
    /// People who type nothing.
    pub others: Vec<(Habit, Way)>,
    /// The recipient's extra variables.
    pub env: Vec<(&'static str, String)>,
    pub draw_ms: u64,
    /// Threads that keep a core busy each.
    pub hogs: usize,
    /// How long the people stay at least.
    pub stay: Duration,
}

impl Spec {
    pub fn new(name: &str) -> Spec {
        Spec {
            name: name.into(),
            senders: 50,
            per_sender: 1,
            pace: Pace::Answered,
            shape: Shape::Short,
            wait: "inbox",
            person: None,
            others: Vec::new(),
            env: Vec::new(),
            draw_ms: 0,
            hogs: 0,
            stay: Duration::ZERO,
        }
    }
}

pub struct Outcome {
    pub name: String,
    pub verdict: Verdict,
    pub seconds: f64,
    pub evidence: Option<PathBuf>,
}

impl Outcome {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name, "seconds": (self.seconds * 10.0).round() / 10.0,
            "violations": self.verdict.violations.iter().map(Violation::to_json).collect::<Vec<_>>(),
            "reasonable": self.verdict.reasonable,
            "owner_in": self.verdict.strangers, "stats": self.verdict.stats,
            "evidence": self.evidence.as_ref().map(|path| path.display().to_string()),
        })
    }
}

/// The least time one message takes in the fake CLI's input: its settle time, its frame and what the
/// store writes.
pub const FAKE_SERVICE_MS: u64 = 86;
/// How many agents start at once.
const STARTING: usize = 8;

/// Starts fake CLIs named `names`, several at a time, in their order.
pub fn start_many(lab: &Lab, names: &[String], env: &[(&str, &str)]) -> anyhow::Result<Vec<Agent>> {
    let next = AtomicUsize::new(0);
    let started: Mutex<Vec<(usize, anyhow::Result<Agent>)>> = Mutex::default();
    std::thread::scope(|scope| {
        for _ in 0..STARTING.min(names.len()) {
            scope.spawn(|| {
                loop {
                    let at = next.fetch_add(1, Ordering::SeqCst);
                    let Some(name) = names.get(at) else { break };
                    let agent = lab.start_fake(name, env);
                    started.lock().unwrap().push((at, agent));
                }
            });
        }
    });
    let mut started = started.into_inner().unwrap();
    started.sort_by_key(|(at, _)| *at);
    started.into_iter().map(|(_, agent)| agent).collect()
}

/// The number in a message's address, such as 42 of `m42@devbox`.
pub fn message_number(address: &str) -> Option<u64> {
    address
        .strip_prefix('m')
        .and_then(|id| id.split('@').next())
        .and_then(|digits| digits.parse().ok())
}

/// One send, and what its sender saw of it.
pub fn send(
    mcp: &Mcp,
    from: &str,
    to: &Agent,
    seq: usize,
    text: String,
    wait: &'static str,
) -> Sent {
    let mut arguments = json!({ "to": to.address, "text": text });
    if wait != "inbox" {
        arguments["wait_for"] = json!(wait);
        arguments["timeout_seconds"] = json!(30);
    }
    send_as(mcp, from, to, seq, text, wait, arguments)
}

/// [`send`] with the arguments given.
pub fn send_as(
    mcp: &Mcp,
    from: &str,
    to: &Agent,
    seq: usize,
    text: String,
    wait: &'static str,
    arguments: Value,
) -> Sent {
    let began = Instant::now();
    let called_us = now_us();
    let answer = mcp
        .begin("send_message", arguments)
        .recv_timeout(Duration::from_secs(60));
    let mut sent = Sent {
        seq,
        from: from.to_string(),
        from_managed: true,
        to: to.id.clone(),
        text,
        wait,
        called_us,
        answered_us: 0,
        took_ms: 0.0,
        number: None,
        succeeded: false,
        said: "no answer".into(),
        failure: None,
    };
    let Ok((at, answer)) = answer else {
        sent.took_ms = began.elapsed().as_secs_f64() * 1000.0;
        return sent;
    };
    sent.took_ms = at.duration_since(began).as_secs_f64() * 1000.0;
    sent.answered_us = now_us();
    let Ok(envelope) = envelope(&answer) else {
        sent.said = answer.to_string();
        sent.failure = Some(answer.to_string());
        return sent;
    };
    sent.number = envelope["data"]["id"].as_str().and_then(message_number);
    sent.succeeded = envelope["status"] == "success";
    if sent.succeeded {
        sent.said = envelope["data"]["delivery"]
            .as_str()
            .unwrap_or_default()
            .to_string();
    } else {
        sent.said = envelope["error"]["reason"]
            .as_str()
            .or_else(|| envelope["error"].as_str())
            .unwrap_or("failure")
            .to_string();
        sent.failure = Some(envelope.to_string());
    }
    sent
}

/// Notes viewers of an agent beyond the storm's own: a person of the owner's.
pub struct Strangers {
    seen: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Strangers {
    pub fn watch(lab: &Lab, agent: &Agent, expected: usize) -> anyhow::Result<Strangers> {
        let wire = crate::client::terminal(&lab.home.daemon_socket())?;
        let (seen, stop) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        let (seen_in, stop_in, reference) = (seen.clone(), stop.clone(), agent.reference.clone());
        let thread = std::thread::spawn(move || {
            while !stop_in.load(Ordering::SeqCst) {
                if let Ok(info) = wire.call("agent.inspect", json!({ "target": reference })) {
                    let viewers = info["viewers"].as_array().map_or(0, Vec::len);
                    if viewers > expected {
                        seen_in.fetch_add(1, Ordering::SeqCst);
                    }
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        });
        Ok(Strangers {
            seen,
            stop,
            thread: Some(thread),
        })
    }

    pub fn end(mut self) -> usize {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.seen.load(Ordering::SeqCst)
    }
}

/// Threads that keep a core busy each, until dropped.
pub struct Hogs(Arc<AtomicBool>);

impl Hogs {
    pub fn start(count: usize) -> Hogs {
        let stop = Arc::new(AtomicBool::new(false));
        for _ in 0..count {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    for _ in 0..10_000 {
                        n = std::hint::black_box(n.wrapping_mul(31).wrapping_add(7));
                    }
                }
            });
        }
        Hogs(stop)
    }
}

impl Drop for Hogs {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Lines of the services' logs that are warnings or worse.
pub fn warnings(home: &TestHome) -> Vec<String> {
    home.daemon_log()
        .lines()
        .chain(home.keeper_log().lines())
        .filter(|line| {
            line.contains("] warn:") || line.contains("] error:") || line.contains("panicked")
        })
        .map(str::to_string)
        .collect()
}

/// What a name becomes as a file's.
fn file_name(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

/// One storm under way: its home, and everything the judgement needs.
pub struct Field {
    pub name: String,
    pub lab: Lab,
    /// What the report says the storm was.
    shape: String,
    began: Instant,
    agents: Mutex<Vec<Agent>>,
    sent: Mutex<Vec<Sent>>,
    seq: AtomicUsize,
    found: Mutex<Vec<Violation>>,
    people: Mutex<HashMap<String, Did>>,
    draws: Mutex<HashMap<String, u64>>,
    strangers: Mutex<HashMap<String, usize>>,
    /// Agents the storm stopped, or whose CLI it ended, and when.
    ended: Mutex<HashMap<String, u64>>,
    reads: Mutex<Vec<Read>>,
    expected_warnings: Mutex<Vec<&'static str>>,
    notes: Mutex<BTreeMap<String, Value>>,
}

impl Field {
    pub fn new(name: &str, shape: String) -> anyhow::Result<Field> {
        let lab = Lab::fake(&file_name(name))?;
        println!("   home {}", lab.home.path.display());
        Ok(Field {
            name: name.into(),
            lab,
            shape,
            began: Instant::now(),
            agents: Mutex::default(),
            sent: Mutex::default(),
            seq: AtomicUsize::new(0),
            found: Mutex::default(),
            people: Mutex::default(),
            draws: Mutex::default(),
            strangers: Mutex::default(),
            ended: Mutex::default(),
            reads: Mutex::default(),
            expected_warnings: Mutex::default(),
            notes: Mutex::default(),
        })
    }

    /// Takes `agent` into the judgement.
    pub fn watch(&self, agent: &Agent, draw_ms: u64) {
        self.agents.lock().unwrap().push(agent.clone());
        self.draws.lock().unwrap().insert(agent.id.clone(), draw_ms);
    }

    /// Starts a fake CLI and waits until its input is empty.
    pub fn start(&self, name: &str, env: &[(&str, &str)]) -> anyhow::Result<Agent> {
        let agent = self.lab.start_fake(name, env)?;
        self.watch(&agent, 0);
        self.lab
            .wait_ready(std::slice::from_ref(&agent), Duration::from_secs(60))?;
        Ok(agent)
    }

    /// Starts `prefix01` to `prefix<count>` and waits until each one's input is empty.
    pub fn start_all(
        &self,
        prefix: &str,
        count: usize,
        env: &[(&str, &str)],
    ) -> anyhow::Result<Vec<Agent>> {
        let names: Vec<String> = (1..=count).map(|n| format!("{prefix}{n:02}")).collect();
        let agents = start_many(&self.lab, &names, env)?;
        for agent in &agents {
            self.watch(agent, 0);
        }
        if !agents.is_empty() {
            self.lab.wait_ready(&agents, Duration::from_secs(120))?;
        }
        Ok(agents)
    }

    pub fn client(&self, agent: &Agent) -> anyhow::Result<Mcp> {
        Mcp::managed(&self.lab.home, &agent.id).with_context(|| format!("{}'s MCP", agent.id))
    }

    pub fn clients(&self, agents: &[Agent]) -> anyhow::Result<Vec<Mcp>> {
        agents.iter().map(|agent| self.client(agent)).collect()
    }

    /// The next message's place in the storm, and its name.
    pub fn name_next(&self, from: &str) -> (usize, String) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        (seq, format!("storm-{seq:05}-{from}"))
    }

    /// Sends one message of `shape` and keeps what became of the call.
    pub fn send(
        &self,
        mcp: &Mcp,
        from: &str,
        to: &Agent,
        shape: Shape,
        wait: &'static str,
    ) -> Sent {
        let (seq, name) = self.name_next(from);
        self.note_sent(send(mcp, from, to, seq, shape.text(&name), wait))
    }

    /// Keeps a send made another way.
    pub fn note_sent(&self, sent: Sent) -> Sent {
        self.sent.lock().unwrap().push(sent.clone());
        sent
    }

    pub fn note_read(&self, read: Read) {
        self.reads.lock().unwrap().push(read);
    }

    pub fn note_person(&self, agent: &Agent, did: Did) {
        self.people.lock().unwrap().insert(agent.id.clone(), did);
    }

    pub fn note_strangers(&self, agent: &Agent, seen: usize) {
        self.strangers
            .lock()
            .unwrap()
            .insert(agent.id.clone(), seen);
    }

    /// A number the report shows.
    pub fn note(&self, name: &str, value: Value) {
        self.notes.lock().unwrap().insert(name.into(), value);
    }

    /// Says that `agent` ends now, by the storm's own doing.
    pub fn note_ended(&self, agent: &Agent) {
        self.ended
            .lock()
            .unwrap()
            .insert(agent.id.clone(), now_us());
    }

    /// Log lines holding `words` are the storm's own doing.
    pub fn expect_warning(&self, words: &'static str) {
        self.expected_warnings.lock().unwrap().push(words);
    }

    pub fn violation(&self, rule: &'static str, what: String) {
        self.found.lock().unwrap().push(Violation {
            rule,
            what,
            class: None,
        });
    }

    /// Stops `agent` as a person does, and checks that it ended. Returns how long the call took.
    pub fn stop(&self, agent: &Agent) -> f64 {
        self.note_ended(agent);
        let began = Instant::now();
        let stopped = self.lab.wire.call(
            "agent.stop",
            json!({ "selection": { "kind": "targets", "targets": [agent.reference] } }),
        );
        let took = began.elapsed().as_secs_f64() * 1000.0;
        match stopped {
            Ok(stopped) if stopped["items"][0]["status"] == "stopped" => {}
            Ok(stopped) => self.violation("I11", format!("{} did not stop: {stopped}", agent.id)),
            Err(err) => self.violation("I11", format!("{} did not stop: {err:#}", agent.id)),
        }
        took
    }

    /// Waits until no message is under way. Deliveries end by their deadline, whatever happens, and
    /// their notices have as long again.
    pub fn quiet(&self) -> anyhow::Result<()> {
        let until = Instant::now() + Duration::from_secs(70);
        while self.lab.pending()? > 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// Ends the storm: waits until it is quiet, judges it, stops its agents, and keeps the evidence of
    /// one that broke a rule.
    pub fn finish(self, out: &Path) -> anyhow::Result<Outcome> {
        self.quiet()?;
        std::thread::sleep(Duration::from_secs(5));
        let agents = self.agents.lock().unwrap().clone();
        let ended = self.ended.lock().unwrap().clone();
        let people = self.people.lock().unwrap().clone();
        let draws = self.draws.lock().unwrap().clone();
        let strangers = self.strangers.lock().unwrap().clone();
        let mut sent = self.sent.lock().unwrap().clone();
        sent.sort_by_key(|sent| sent.seq);
        let windows: Vec<Window> = agents
            .iter()
            .map(|agent| {
                let draw_ms = draws.get(&agent.id).copied().unwrap_or_default();
                Window {
                    agent: agent.id.clone(),
                    tape: self.lab.tape(&agent.id),
                    person: people.get(&agent.id).cloned(),
                    end_state: match ended.contains_key(&agent.id) {
                        true => "ended".into(),
                        false => self.lab.input_state(agent),
                    },
                    draw_ms,
                    service_ms: FAKE_SERVICE_MS + draw_ms,
                    strangers: strangers.get(&agent.id).copied().unwrap_or_default(),
                    ended_us: ended.get(&agent.id).copied(),
                }
            })
            .collect();
        let rows = self.lab.rows()?;
        let expected = self.expected_warnings.lock().unwrap().clone();
        let warnings: Vec<String> = warnings(&self.lab.home)
            .into_iter()
            .filter(|line| !expected.iter().any(|words| line.contains(words)))
            .collect();
        let mut verdict = judge::judge(&Case {
            sent: &sent,
            rows: &rows,
            windows: &windows,
            reads: &self.reads.lock().unwrap(),
            warnings: &warnings,
            ended_us: now_us(),
        });
        verdict
            .violations
            .extend(self.found.lock().unwrap().drain(..));
        verdict.stats["notes"] = json!(*self.notes.lock().unwrap());
        // What is left in an input goes with the person's next Enter.
        for agent in &agents {
            let left = verdict
                .violations
                .iter()
                .any(|one| one.rule == "I6" && one.what.starts_with(&format!("{}'s", agent.id)));
            if left && !ended.contains_key(&agent.id) {
                press_enter(&self.lab, agent, &rows, &sent, &mut verdict)?;
            }
        }
        let alive: Vec<Agent> = agents
            .iter()
            .filter(|agent| !ended.contains_key(&agent.id))
            .cloned()
            .collect();
        stop_all(&self.lab, &alive, &mut verdict);

        let evidence = if verdict.violations.is_empty() {
            None
        } else {
            let folder = out.join(file_name(&self.name));
            self.lab.keep_evidence(&folder)?;
            let ledger = json!({
                "storm": self.shape,
                "sent": sent.iter().map(Sent::to_json).collect::<Vec<_>>(),
                "people": people
                    .iter()
                    .map(|(agent, did)| (agent.clone(), format!("{did:?}")))
                    .collect::<BTreeMap<_, _>>(),
                "violations": verdict
                    .violations
                    .iter()
                    .map(Violation::to_json)
                    .collect::<Vec<_>>(),
                "stats": verdict.stats,
            });
            std::fs::write(
                folder.join("ledger.json"),
                serde_json::to_string_pretty(&ledger)?,
            )?;
            Some(folder)
        };
        let seconds = self.began.elapsed().as_secs_f64();
        let folder = self.lab.home.folder().to_path_buf();
        let name = self.name;
        drop(self.lab);
        remove_storm_folder(&folder);
        Ok(Outcome {
            name,
            verdict,
            seconds,
            evidence,
        })
    }
}

/// Runs one storm of senders to one recipient.
pub fn run(spec: &Spec, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(&spec.name, format!("{spec:?}"))?;
    let draw = spec.draw_ms.to_string();
    let mut env: Vec<(&str, &str)> = vec![("FAKECLI_MOUSE", "1")];
    if spec.draw_ms > 0 {
        env.push(("FAKECLI_DRAW_MS", &draw));
    }
    env.extend(spec.env.iter().map(|(name, value)| (*name, value.as_str())));
    let (boss, window) = match spec.person {
        Some((_, Way::Started)) => {
            let (boss, window) = field.lab.start_in_window("boss", &env)?;
            (boss, Some(window))
        }
        _ => (field.lab.start_fake("boss", &env)?, None),
    };
    field.watch(&boss, spec.draw_ms);
    let senders = field.start_all("s", spec.senders, &[])?;
    field
        .lab
        .wait_ready(std::slice::from_ref(&boss), Duration::from_secs(60))?;
    let clients = field.clients(&senders)?;

    let begin = |tag: &str, (habit, way): (Habit, Way), window| {
        Person::start(
            &field.lab.home,
            &field.lab.home.daemon_socket(),
            boss.reference.clone(),
            &boss.address,
            tag,
            habit,
            way,
            window,
        )
    };
    let person = spec
        .person
        .map(|person| begin("p", person, window))
        .transpose()?;
    let others = spec
        .others
        .iter()
        .map(|other| begin("q", *other, None))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let viewers = spec
        .person
        .iter()
        .chain(&spec.others)
        .filter(|(_, way)| matches!(way, Way::Attach | Way::Started | Way::Editor))
        .count();
    let strangers = Strangers::watch(&field.lab, &boss, viewers)?;
    std::thread::sleep(Duration::from_millis(500));
    let hogs = Hogs::start(spec.hogs);

    // Every sender sends at one moment.
    let came = Instant::now();
    let barrier = Barrier::new(senders.len().max(1));
    std::thread::scope(|scope| {
        for (sender, mcp) in senders.iter().zip(&clients) {
            let (barrier, field, boss) = (&barrier, &field, &boss);
            scope.spawn(move || {
                barrier.wait();
                let began = Instant::now();
                for k in 0..spec.per_sender {
                    if let Pace::Every(ms) = spec.pace {
                        let due = began + Duration::from_millis(ms) * k as u32;
                        std::thread::sleep(due.saturating_duration_since(Instant::now()));
                    }
                    field.send(mcp, &sender.id, boss, spec.shape, spec.wait);
                }
            });
        }
    });
    field.quiet()?;
    std::thread::sleep(spec.stay.saturating_sub(came.elapsed()));
    drop(hogs);
    if let Some(person) = person {
        field.note_person(&boss, person.end());
    }
    for other in others {
        other.end();
    }
    field.note_strangers(&boss, strangers.end());
    drop(clients);
    field.finish(out)
}

/// Deletes a storm's home, which the storm made under its own temporary folder; what broke a rule was
/// copied out of it before.
fn remove_storm_folder(folder: &Path) {
    let inside = folder.starts_with(std::env::temp_dir())
        && folder
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("fcs-storm-"));
    if inside {
        let _ = std::fs::remove_dir_all(folder);
    }
}

/// Presses Enter once, as a person who sees text left in the input does, and notes failed messages
/// it submits.
fn press_enter(
    lab: &Lab,
    agent: &Agent,
    rows: &BTreeMap<u64, Row>,
    sent: &[Sent],
    verdict: &mut Verdict,
) -> anyhow::Result<()> {
    let before = lab.tape(&agent.id).submissions.len();
    lab.wire.call(
        "agent.type",
        json!({
            "target": agent.reference,
            "input": { "kind": "raw", "raw": base64::encode(b"\r") },
        }),
    )?;
    std::thread::sleep(Duration::from_secs(2));
    for submission in lab.tape(&agent.id).submissions.iter().skip(before) {
        let numbers = match judge::kind(submission) {
            Kind::Message(number, _) => vec![number],
            Kind::Mixed(numbers, _) => numbers,
            _ => Vec::new(),
        };
        for number in numbers {
            let failed = rows
                .get(&number)
                .is_none_or(|row| row.withdrawn || row.status == "failure");
            if failed && sent.iter().any(|sent| sent.number == Some(number)) {
                verdict.violations.push(Violation {
                    rule: "I3",
                    what: format!(
                        "m{number} was reported as failed, and the next Enter in {}'s window \
                         submitted it",
                        agent.id
                    ),
                    class: None,
                });
            }
        }
    }
    Ok(())
}

/// I11: every agent stops, and nothing of theirs stays running.
pub fn stop_all(lab: &Lab, agents: &[Agent], verdict: &mut Verdict) {
    let running: Vec<(&Agent, _)> = agents
        .iter()
        .filter(|agent| agent.pid > 0)
        .map(|agent| (agent, process_identity(agent.pid)))
        .collect();
    for agent in agents {
        let stopped = lab.wire.call(
            "agent.stop",
            json!({ "selection": { "kind": "targets", "targets": [agent.reference] } }),
        );
        let problem = match stopped {
            Ok(stopped) if stopped["items"][0]["status"] == "stopped" => continue,
            Ok(stopped) => stopped.to_string(),
            Err(err) => format!("{err:#}"),
        };
        verdict.violations.push(Violation {
            rule: "I11",
            what: format!("{} did not stop: {problem}", agent.id),
            class: None,
        });
    }
    let gone = wait_until(Duration::from_secs(5), || {
        running.iter().all(|(_, identity)| !alive(identity))
    });
    if !gone {
        let left: Vec<&str> = running
            .iter()
            .filter(|(_, identity)| alive(identity))
            .map(|(agent, _)| agent.id.as_str())
            .collect();
        verdict.violations.push(Violation {
            rule: "I11",
            what: format!("still running 5 s after their stop: {left:?}"),
            class: None,
        });
    }
}
