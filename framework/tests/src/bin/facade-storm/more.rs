//! Storms with a course of their own: many to many, waits, reads, stops, starts and guests.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use facade_base::base64;
use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

use crate::client::{Mcp, envelope};
use crate::judge::{Read, Sent};
use crate::lab::Agent;
use crate::person::now_us;
use crate::storm::{self, Field, Hogs, Outcome, Shape, message_number};

type Run = fn(&str, &Path) -> anyhow::Result<Outcome>;

/// Every storm with a course of its own, by set.
pub fn set(name: &str) -> Option<Vec<(&'static str, Run)>> {
    Some(match name {
        "x" => vec![
            ("X5 50 agents at random", x5),
            ("X5 50 agents at random, busy cores", x5_hogs),
            ("X4 each other at one moment", x4),
            ("X1 ping-pong of 6 pairs, 20 rounds", x1),
            ("N8 two recipients that send to each other", n8),
        ],
        "z" => vec![
            (
                "Z1 first messages across a crash of the daemon",
                crate::crash::prompts as Run,
            ),
            (
                "Z2 ends across a crash of the daemon",
                crate::crash::ends as Run,
            ),
        ],
        "s" => vec![
            ("S1 10 starts with a first message", s1),
            ("S2 30 starts at one moment", s2),
            ("S5 a first message and five at once after it", s5),
            ("S6 stopped before its first message", s6),
            ("S8 five agents start six each", s8),
            ("S9 starts that cannot be", s9),
        ],
        "k" => vec![
            ("K2 stopped with 20 waiting", k2),
            ("K3 ten stops in a row", k3),
            ("K5 thirty CLIs end at once", k5),
            ("K6 stopped while a message is in its input", k6),
        ],
        "t" => vec![
            ("R1 reads while messages are typed", r1),
            ("R2 pages of 200 messages", r2),
            ("T1 typed text among messages", t1),
            ("T3 lists and screens all the while", t3),
            ("A7 a sender whose own input is held", a7),
        ],
        "w" => vec![
            ("W1 50 waits for delivery", w1),
            ("W2 replies that are waited for", w2),
            ("W8 600 waits at once", w8),
            ("W9 the same call twice", w9),
        ],
        "g" => vec![
            ("G1 guests and agents, both ways", g1),
            ("G3 a guest that does not read", g3),
            ("G6 twenty guests", g6),
            ("G8 two reads of one inbox", g8),
        ],
        _ => return None,
    })
}

/// A small generator: the same storm each time.
struct Random(u64);

impl Random {
    fn next(&mut self, below: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % below.max(1) as u64) as usize
    }
}

fn pause(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn many_to_many(name: &str, out: &Path, hogs: usize) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        format!("50 agents, 40 messages each, {hogs} busy cores"),
    )?;
    let agents = field.start_all("x", 50, &[])?;
    let clients = field.clients(&agents)?;
    let busy = Hogs::start(hogs);
    let barrier = Barrier::new(agents.len());
    std::thread::scope(|scope| {
        for (n, (agent, mcp)) in agents.iter().zip(&clients).enumerate() {
            let (field, agents, barrier) = (&field, &agents, &barrier);
            scope.spawn(move || {
                let mut random = Random(0x9e37_79b9 + n as u64 * 7919);
                barrier.wait();
                for _ in 0..40 {
                    let to = loop {
                        let to = &agents[random.next(agents.len())];
                        if to.id != agent.id {
                            break to;
                        }
                    };
                    field.send(mcp, &agent.id, to, Shape::Short, "inbox");
                    pause(100 + random.next(400) as u64);
                }
            });
        }
    });
    drop(busy);
    field.quiet()?;
    drop(clients);
    field.finish(out)
}

fn x5(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    many_to_many(name, out, 0)
}

fn x5_hogs(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    many_to_many(name, out, 15)
}

/// Eight agents, each of which sends ten to every other at one moment.
fn x4(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(name, "8 agents, 10 to each other".into())?;
    let agents = field.start_all("x", 8, &[])?;
    let clients = field.clients(&agents)?;
    let barrier = Barrier::new(agents.len());
    std::thread::scope(|scope| {
        for (agent, mcp) in agents.iter().zip(&clients) {
            let (field, agents, barrier) = (&field, &agents, &barrier);
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..10 {
                    for to in agents.iter().filter(|to| to.id != agent.id) {
                        field.send(mcp, &agent.id, to, Shape::Short, "inbox");
                    }
                }
            });
        }
    });
    field.quiet()?;
    drop(clients);
    field.finish(out)
}

/// The messages an agent's CLI took that were not seen before: each one's number and body.
fn taken(field: &Field, agent: &Agent, seen: &mut usize) -> Vec<(u64, String)> {
    let submissions = field.lab.tape(&agent.id).submissions;
    let new = submissions
        .iter()
        .skip(*seen)
        .filter_map(|submission| match crate::judge::kind(submission) {
            crate::judge::Kind::Message(number, body) => Some((number, body)),
            _ => None,
        })
        .collect();
    *seen = submissions.len();
    new
}

/// Pairs that answer each other's messages, each a reply to the last.
fn x1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    const ROUNDS: usize = 20;
    let field = Field::new(name, format!("6 pairs, {ROUNDS} rounds, each a reply"))?;
    let agents = field.start_all("x", 12, &[])?;
    let clients = field.clients(&agents)?;
    std::thread::scope(|scope| {
        for pair in 0..6 {
            let (a, b) = (pair * 2, pair * 2 + 1);
            let (field, agents, clients) = (&field, &agents, &clients);
            field.send(
                &clients[a],
                &agents[a].id,
                &agents[b],
                Shape::Short,
                "inbox",
            );
            for (me, other) in [(b, a), (a, b)] {
                scope.spawn(move || {
                    let (mut seen, mut answered) = (0, 0);
                    let until = Instant::now() + Duration::from_secs(120);
                    while answered < ROUNDS && Instant::now() < until {
                        for (number, _) in taken(field, &agents[me], &mut seen) {
                            answered += 1;
                            if answered > ROUNDS {
                                break;
                            }
                            let (seq, text) = field.name_next(&agents[me].id);
                            let sent = storm::send_as(
                                &clients[me],
                                &agents[me].id,
                                &agents[other],
                                seq,
                                text.clone(),
                                "inbox",
                                json!({
                                    "to": agents[other].address, "text": text,
                                    "reply_to": format!("m{number}"),
                                }),
                            );
                            field.note_sent(sent);
                        }
                        pause(15);
                    }
                    if answered < ROUNDS {
                        field.violation(
                            "I15",
                            format!("{} took {answered} of {ROUNDS} in its turn", agents[me].id),
                        );
                    }
                });
            }
        }
    });
    field.quiet()?;
    drop(clients);
    field.finish(out)
}

/// Two recipients, each under 25 senders and sending to the other.
fn n8(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "2 recipients, 20 senders, each 5; both send too".into(),
    )?;
    let bosses = field.start_all("boss", 2, &[])?;
    let senders = field.start_all("s", 20, &[])?;
    let clients = field.clients(&senders)?;
    let boss_clients = field.clients(&bosses)?;
    let barrier = Barrier::new(22);
    std::thread::scope(|scope| {
        for (n, (sender, mcp)) in senders.iter().zip(&clients).enumerate() {
            let (field, bosses, barrier) = (&field, &bosses, &barrier);
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..5 {
                    field.send(mcp, &sender.id, &bosses[n % 2], Shape::Short, "inbox");
                }
            });
        }
        for me in 0..2 {
            let (field, bosses, barrier, mcp) = (&field, &bosses, &barrier, &boss_clients[me]);
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..20 {
                    field.send(mcp, &bosses[me].id, &bosses[1 - me], Shape::Short, "inbox");
                }
            });
        }
    });
    field.quiet()?;
    drop((clients, boss_clients));
    field.finish(out)
}

/// Starts an agent through `lead`'s tools, with `prompt` if any, and takes it into the storm.
fn start_by(
    field: &Field,
    mcp: &Mcp,
    name: &str,
    prompt: Option<&str>,
) -> anyhow::Result<(Agent, f64)> {
    let mut arguments = json!({ "cli": "fake", "name": name, "folder": field.lab.home.project });
    if let Some(prompt) = prompt {
        arguments["prompt"] = json!(prompt);
    }
    let began = Instant::now();
    let started = mcp.call("start_agent", arguments)?;
    let took = began.elapsed().as_secs_f64() * 1000.0;
    anyhow::ensure!(started["status"] == "success", "start_agent: {started}");
    let address = started["data"]["id"].as_str().unwrap_or_default();
    let info = field
        .lab
        .wire
        .call("agent.inspect", json!({ "target": address }))?;
    let agent = crate::lab::Lab::agent(&info["agent"])?;
    field.watch(&agent, 0);
    Ok((agent, took))
}

/// Checks that `agent`'s first submission is `prompt`, once.
fn first_is(field: &Field, agent: &Agent, prompt: &str, timeout: Duration) {
    let took = |field: &Field| -> Vec<String> {
        field
            .lab
            .tape(&agent.id)
            .submissions
            .iter()
            .filter_map(|submission| match crate::judge::kind(submission) {
                crate::judge::Kind::Message(_, body) => Some(body),
                _ => None,
            })
            .collect()
    };
    wait_until(timeout, || !took(field).is_empty());
    let bodies = took(field);
    let times = bodies.iter().filter(|body| *body == prompt).count();
    if bodies.first().map(String::as_str) != Some(prompt) || times != 1 {
        field.violation(
            "I11",
            format!(
                "{}'s first message {prompt:?} was submitted {times} times; its first submission is \
                 {:?}",
                agent.id,
                bodies.first()
            ),
        );
    }
}

fn s1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 starts by an agent, one by one, each with a first message".into(),
    )?;
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    let mut calls = Vec::new();
    let mut agents = Vec::new();
    for n in 0..10 {
        let prompt = format!("first-{n:02} do the thing");
        let (agent, took) = start_by(&field, &mcp, &format!("w{n:02}"), Some(&prompt))?;
        calls.push(took);
        agents.push((agent, prompt));
    }
    for (agent, prompt) in &agents {
        first_is(&field, agent, prompt, Duration::from_secs(40));
    }
    field.note("start_call_ms", crate::judge::summary(calls));
    drop(mcp);
    field.finish(out)
}

fn s2(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "30 starts by one agent at one moment, each with a first message".into(),
    )?;
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    let began = Instant::now();
    let pending: Vec<_> = (0..30)
        .map(|n| {
            let prompt = format!("first-{n:02} do the thing");
            let answer = mcp.begin(
                "start_agent",
                json!({
                    "cli": "fake", "name": format!("w{n:02}"), "folder": field.lab.home.project,
                    "prompt": prompt,
                }),
            );
            (n, prompt, answer)
        })
        .collect();
    let mut calls = Vec::new();
    let mut agents = Vec::new();
    for (n, prompt, answer) in pending {
        let Ok((at, answer)) = answer.recv_timeout(Duration::from_secs(90)) else {
            field.violation("I11", format!("start {n} was never answered"));
            continue;
        };
        calls.push(at.duration_since(began).as_secs_f64() * 1000.0);
        let started = envelope(&answer)?;
        if started["status"] != "success" {
            field.violation("I11", format!("start {n} failed: {started}"));
            continue;
        }
        let info = field
            .lab
            .wire
            .call("agent.inspect", json!({ "target": started["data"]["id"] }))?;
        let agent = crate::lab::Lab::agent(&info["agent"])?;
        field.watch(&agent, 0);
        agents.push((agent, prompt));
    }
    for (agent, prompt) in &agents {
        first_is(&field, agent, prompt, Duration::from_secs(60));
    }
    field.note("answered_after_ms", crate::judge::summary(calls));
    drop(mcp);
    field.finish(out)
}

fn s5(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(name, "8 starts, and five messages right after each".into())?;
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    let mut agents = Vec::new();
    for n in 0..8 {
        let prompt = format!("first-{n:02} do the thing");
        let (agent, _) = start_by(&field, &mcp, &format!("w{n:02}"), Some(&prompt))?;
        for _ in 0..5 {
            field.send(&mcp, &lead.id, &agent, Shape::Short, "inbox");
        }
        agents.push((agent, prompt));
    }
    field.quiet()?;
    for (agent, prompt) in &agents {
        first_is(&field, agent, prompt, Duration::from_secs(40));
    }
    drop(mcp);
    field.finish(out)
}

fn s6(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 agents stopped within 0 to 900 ms of their start".into(),
    )?;
    field.expect_warning("ended before the message was delivered");
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    for n in 0..10u64 {
        let (agent, _) = start_by(&field, &mcp, &format!("w{n:02}"), Some("never mind"))?;
        pause(n * 100);
        field.stop(&agent);
    }
    drop(mcp);
    field.finish(out)
}

fn s8(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(name, "5 agents start 6 each at one moment".into())?;
    let leads = field.start_all("lead", 5, &[])?;
    let clients = field.clients(&leads)?;
    let barrier = Barrier::new(5);
    let started: std::sync::Mutex<Vec<(Agent, String)>> = std::sync::Mutex::default();
    let calls: std::sync::Mutex<Vec<f64>> = std::sync::Mutex::default();
    std::thread::scope(|scope| {
        for (l, mcp) in clients.iter().enumerate() {
            let (field, barrier, started, calls) = (&field, &barrier, &started, &calls);
            scope.spawn(move || {
                barrier.wait();
                for n in 0..6 {
                    let prompt = format!("first-{l}-{n}");
                    match start_by(field, mcp, &format!("w{l}{n}"), Some(&prompt)) {
                        Ok((agent, took)) => {
                            started.lock().unwrap().push((agent, prompt));
                            calls.lock().unwrap().push(took);
                        }
                        Err(err) => field.violation("I11", format!("{err:#}")),
                    }
                }
            });
        }
    });
    for (agent, prompt) in started.into_inner().unwrap().iter() {
        first_is(&field, agent, prompt, Duration::from_secs(60));
    }
    field.note(
        "start_call_ms",
        crate::judge::summary(calls.into_inner().unwrap()),
    );
    drop(clients);
    field.finish(out)
}

fn s9(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "a CLI, a folder and a machine that do not exist".into(),
    )?;
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    let before = field.lab.home.agents().len();
    let missing = field.lab.home.folder().join("no-such-folder");
    for arguments in [
        json!({ "cli": "no-such-cli", "name": "x1" }),
        json!({ "cli": "fake", "name": "x2", "folder": missing }),
        json!({ "cli": "fake", "name": "x3", "machine": "no-such-machine" }),
        json!({ "cli": "fake", "name": "x4", "worktree": "" }),
        json!({ "name": "x5" }),
    ] {
        let answer = mcp.call("start_agent", arguments.clone())?;
        if answer["status"] != "failure" {
            field.violation("I11", format!("{arguments} was answered {answer}"));
            if let Some(address) = answer["data"]["id"].as_str() {
                let info = field
                    .lab
                    .wire
                    .call("agent.inspect", json!({ "target": address }))?;
                field.watch(&crate::lab::Lab::agent(&info["agent"])?, 0);
            }
        } else if answer["message"].as_str().is_none_or(str::is_empty) {
            field.violation("I11", format!("{arguments} failed without words: {answer}"));
        }
    }
    let after = field.lab.home.agents().len();
    if after != before {
        field.violation(
            "I11",
            format!("failed starts left {} records", after - before),
        );
    }
    drop(mcp);
    field.finish(out)
}

/// Senders whose recipient stops while their messages wait for it.
fn k2(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "20 senders, one recipient that holds a draft, then stops".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 20, &[])?;
    let clients = field.clients(&senders)?;
    // A draft, so that all of them wait.
    type_raw(&field, &boss, b"draft")?;
    pause(300);
    std::thread::scope(|scope| {
        for (sender, mcp) in senders.iter().zip(&clients) {
            let (field, boss) = (&field, &boss);
            scope.spawn(move || field.send(mcp, &sender.id, boss, Shape::Short, "inbox"));
        }
    });
    pause(500);
    field.stop(&boss);
    field.quiet()?;
    drop(clients);
    field.finish(out)
}

fn type_raw(field: &Field, agent: &Agent, bytes: &[u8]) -> anyhow::Result<()> {
    field.lab.wire.call(
        "agent.type",
        json!({
            "target": agent.reference,
            "input": { "kind": "raw", "raw": base64::encode(bytes) },
        }),
    )?;
    Ok(())
}

fn k3(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(name, "ten agents stopped one after another".into())?;
    let agents = field.start_all("w", 10, &[])?;
    let took: Vec<f64> = agents.iter().map(|agent| field.stop(agent)).collect();
    field.note("stop_call_ms", crate::judge::summary(took));
    field.finish(out)
}

/// CLIs of one creator that end at one moment: the creator hears of each once.
fn k5(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "30 CLIs started by one agent end by themselves at once".into(),
    )?;
    let lead = field.start("lead", &[])?;
    let mcp = field.client(&lead)?;
    let mut agents = Vec::new();
    for n in 0..30 {
        agents.push(start_by(&field, &mcp, &format!("w{n:02}"), None)?.0);
    }
    field.lab.wait_ready(&agents, Duration::from_secs(60))?;
    for agent in &agents {
        field.note_ended(agent);
    }
    std::thread::scope(|scope| {
        for agent in &agents {
            // Ctrl+D ends the fake CLI where its input is empty.
            let field = &field;
            scope.spawn(move || type_raw(field, agent, b"\x04"));
        }
    });
    pause(3000);
    field.quiet()?;
    let notices: Vec<String> = field
        .lab
        .tape(&lead.id)
        .submissions
        .iter()
        .filter_map(|submission| match crate::judge::kind(submission) {
            crate::judge::Kind::Notice(text) => Some(text),
            _ => None,
        })
        .collect();
    for agent in &agents {
        let named = notices
            .iter()
            .filter(|text| text.contains(&format!("({})", agent.address)))
            .count();
        if named != 1 {
            field.violation(
                "I8",
                format!("{} ended, and its creator got {named} notices", agent.id),
            );
        }
    }
    drop(mcp);
    field.finish(out)
}

/// Stopped within a paste and its key.
fn k6(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "12 recipients stopped 0 to 220 ms after a send to them".into(),
    )?;
    let sender = field.start("s01", &[])?;
    let mcp = field.client(&sender)?;
    for n in 0..12u64 {
        let boss = field.start(&format!("b{n:02}"), &[])?;
        field.send(&mcp, &sender.id, &boss, Shape::Short, "inbox");
        pause(n * 20);
        field.stop(&boss);
    }
    field.quiet()?;
    drop(mcp);
    field.finish(out)
}

/// One `read_messages` call, kept for the judgement.
fn read(field: &Field, mcp: &Mcp, agent: &str, arguments: Value) -> anyhow::Result<Vec<u64>> {
    let filtered = arguments.get("reply_to").is_some();
    let earlier = arguments.get("last").is_some() || arguments.get("after").is_some();
    let began_us = now_us();
    let answer = mcp.call("read_messages", arguments)?;
    let messages = answer["data"]["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let numbers: Vec<u64> = messages
        .iter()
        .filter_map(|message| message["id"].as_str().and_then(message_number))
        .collect();
    if !earlier {
        field.note_read(Read {
            agent: agent.into(),
            began_us,
            ended_us: now_us(),
            filtered,
            numbers: numbers.clone(),
            texts: messages
                .iter()
                .map(|message| message["text"].as_str().unwrap_or_default().to_string())
                .collect(),
        });
    }
    Ok(numbers)
}

fn r1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 senders of 10, and the recipient reads at 20 Hz".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 10, &[])?;
    let clients = field.clients(&senders)?;
    let boss_client = field.client(&boss)?;
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (field, boss, done) = (&field, &boss, &done);
        let reader = scope.spawn(|| -> anyhow::Result<()> {
            while !done.load(Ordering::SeqCst) {
                read(field, &boss_client, &boss.id, json!({}))?;
                pause(50);
            }
            Ok(())
        });
        let sending: Vec<_> = senders
            .iter()
            .zip(&clients)
            .map(|(sender, mcp)| {
                scope.spawn(move || {
                    for _ in 0..10 {
                        field.send(mcp, &sender.id, boss, Shape::Short, "inbox");
                        pause(60);
                    }
                })
            })
            .collect();
        for sending in sending {
            let _ = sending.join();
        }
        let _ = field.quiet();
        done.store(true, Ordering::SeqCst);
        if let Ok(Err(err)) = reader.join() {
            field.violation("I1", format!("a read failed: {err:#}"));
        }
    });
    drop((clients, boss_client));
    field.finish(out)
}

fn r2(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "200 messages, then pages of them with last and after".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 10, &[])?;
    let clients = field.clients(&senders)?;
    let boss_client = field.client(&boss)?;
    let sent: Vec<Sent> = std::thread::scope(|scope| {
        let handles: Vec<_> = senders
            .iter()
            .zip(&clients)
            .map(|(sender, mcp)| {
                let (field, boss) = (&field, &boss);
                scope.spawn(move || {
                    (0..20)
                        .map(|_| field.send(mcp, &sender.id, boss, Shape::Wide(120), "delivery"))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });
    field.quiet()?;
    let wanted: BTreeSet<u64> = sent.iter().filter_map(|sent| sent.number).collect();
    // Every page after the first message, in turn.
    let mut got = Vec::new();
    let mut after = format!("m{}", wanted.iter().next().copied().unwrap_or(1));
    for _ in 0..400 {
        let answer = boss_client.call("read_messages", json!({ "after": after }))?;
        let messages = answer["data"]["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        got.extend(
            messages
                .iter()
                .filter_map(|message| message["id"].as_str().and_then(message_number)),
        );
        match answer["data"]["next_cursor"].as_str() {
            Some(next) => after = next.to_string(),
            None => break,
        }
    }
    let expected: Vec<u64> = wanted.iter().skip(1).copied().collect();
    if got != expected {
        field.violation(
            "I1",
            format!(
                "pages after the first gave {} messages, {} were sent; first unlike: {:?}",
                got.len(),
                expected.len(),
                expected.iter().zip(&got).find(|(a, b)| a != b)
            ),
        );
    }
    let last = read(&field, &boss_client, &boss.id, json!({ "last": 20 }))?;
    let newest: BTreeSet<u64> = wanted.iter().rev().take(20).copied().collect();
    if last.iter().copied().collect::<BTreeSet<_>>() != newest {
        field.violation("I1", format!("the last 20 are {last:?}, not {newest:?}"));
    }
    drop((clients, boss_client));
    field.finish(out)
}

/// Text another agent types and submits, among messages.
fn t1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 senders of 8, and another agent's type_text of 20 lines".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 10, &[])?;
    let typist = field.start("typist", &[])?;
    let clients = field.clients(&senders)?;
    let typist_client = field.client(&typist)?;
    let mut typed = Vec::new();
    std::thread::scope(|scope| {
        for (sender, mcp) in senders.iter().zip(&clients) {
            let (field, boss) = (&field, &boss);
            scope.spawn(move || {
                for _ in 0..8 {
                    field.send(mcp, &sender.id, boss, Shape::Short, "inbox");
                    pause(40);
                }
            });
        }
        for n in 0..20 {
            let line = format!("typed-{n:02} by another agent");
            let answer = typist_client.call(
                "type_text",
                json!({ "agent": boss.address, "text": line, "enter": true }),
            );
            match answer {
                Ok(answer) if answer["status"] == "success" => typed.push(line),
                other => field.violation("I15", format!("type_text: {other:?}")),
            }
            pause(120);
        }
    });
    field.quiet()?;
    pause(500);
    let lines: Vec<String> = field
        .lab
        .tape(&boss.id)
        .submissions
        .iter()
        .filter_map(|submission| match crate::judge::kind(submission) {
            crate::judge::Kind::Person(text) => Some(text),
            _ => None,
        })
        .collect();
    for line in &typed {
        let times = lines.iter().filter(|text| *text == line).count();
        if times != 1 {
            field.violation(
                "I9",
                format!("type_text's {line:?} was submitted {times} times alone"),
            );
        }
    }
    drop((clients, typist_client));
    field.finish(out)
}

fn t3(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "20 senders of 5, and 4 agents that list and read screens at 20 Hz".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 20, &[])?;
    let clients = field.clients(&senders)?;
    let done = AtomicBool::new(false);
    let times: std::sync::Mutex<Vec<f64>> = std::sync::Mutex::default();
    std::thread::scope(|scope| {
        let (field, boss, done, times) = (&field, &boss, &done, &times);
        for mcp in &clients[..4] {
            scope.spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    for (tool, arguments) in [
                        ("list_agents", json!({})),
                        ("read_screen", json!({ "agent": boss.address, "lines": 40 })),
                    ] {
                        let began = Instant::now();
                        match mcp.call(tool, arguments) {
                            Ok(answer) if answer["status"] == "success" => times
                                .lock()
                                .unwrap()
                                .push(began.elapsed().as_secs_f64() * 1000.0),
                            other => field.violation("I12", format!("{tool}: {other:?}")),
                        }
                    }
                    pause(25);
                }
            });
        }
        let sending: Vec<_> = senders
            .iter()
            .zip(&clients)
            .map(|(sender, mcp)| {
                scope.spawn(move || {
                    for _ in 0..5 {
                        field.send(mcp, &sender.id, boss, Shape::Short, "inbox");
                        pause(100);
                    }
                })
            })
            .collect();
        for sending in sending {
            let _ = sending.join();
        }
        let _ = field.quiet();
        done.store(true, Ordering::SeqCst);
    });
    field.note(
        "call_ms",
        crate::judge::summary(times.into_inner().unwrap()),
    );
    drop(clients);
    field.finish(out)
}

/// Senders whose messages fail while a draft holds their own inputs.
fn a7(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "a recipient and 5 of 10 senders hold a draft for 70 s".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 10, &[])?;
    let clients = field.clients(&senders)?;
    for agent in std::iter::once(&boss).chain(&senders[..5]) {
        type_raw(&field, agent, b"a draft")?;
    }
    pause(500);
    std::thread::scope(|scope| {
        for (sender, mcp) in senders.iter().zip(&clients) {
            let (field, boss) = (&field, &boss);
            scope.spawn(move || field.send(mcp, &sender.id, boss, Shape::Short, "inbox"));
        }
    });
    // Past the messages' end, and their notices'.
    field.quiet()?;
    pause(3000);
    for agent in std::iter::once(&boss).chain(&senders[..5]) {
        type_raw(&field, agent, b"\x03")?;
    }
    pause(500);
    drop(clients);
    field.finish(out)
}

fn w1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(name, "50 senders wait for delivery to one recipient".into())?;
    let boss = field.start("boss", &[])?;
    let senders = field.start_all("s", 50, &[])?;
    let clients = field.clients(&senders)?;
    let barrier = Barrier::new(50);
    std::thread::scope(|scope| {
        for (sender, mcp) in senders.iter().zip(&clients) {
            let (field, boss, barrier) = (&field, &boss, &barrier);
            scope.spawn(move || {
                barrier.wait();
                field.send(mcp, &sender.id, boss, Shape::Short, "delivery")
            });
        }
    });
    drop(clients);
    field.finish(out)
}

/// Waits for a reply that a brain of the storm's gives, in time and too late.
fn w2(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 askers of 5 wait for replies; every tenth reply is late".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let askers = field.start_all("s", 10, &[])?;
    let clients = field.clients(&askers)?;
    let boss_client = field.client(&boss)?;
    let done = AtomicBool::new(false);
    let late = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let (field, boss, done, askers, late) = (&field, &boss, &done, &askers, &late);
        let boss_client = &boss_client;
        scope.spawn(move || {
            let mut seen = 0;
            let mut n = 0usize;
            while !done.load(Ordering::SeqCst) {
                for (number, body) in taken(field, boss, &mut seen) {
                    n += 1;
                    let Some(from) = askers.iter().find(|asker| body.contains(&format!("-{} ", asker.id))) else {
                        continue;
                    };
                    if n.is_multiple_of(10) {
                        late.fetch_add(1, Ordering::SeqCst);
                        pause(9000);
                    }
                    let (seq, text) = field.name_next(&boss.id);
                    let sent = storm::send_as(
                        boss_client,
                        &boss.id,
                        from,
                        seq,
                        text.clone(),
                        "inbox",
                        json!({ "to": from.address, "text": text, "reply_to": format!("m{number}") }),
                    );
                    field.note_sent(sent);
                }
                pause(10);
            }
        });
        let asking: Vec<_> = askers
            .iter()
            .zip(&clients)
            .map(|(asker, mcp)| {
                scope.spawn(move || {
                    for _ in 0..5 {
                        let (seq, text) = field.name_next(&asker.id);
                        let text = format!("{text} asks");
                        let answer = mcp.begin(
                            "send_message",
                            json!({
                                "to": boss.address, "text": text, "wait_for": "result",
                                "timeout_seconds": 8,
                            }),
                        );
                        let called_us = now_us();
                        let Ok((_, answer)) = answer.recv_timeout(Duration::from_secs(40)) else {
                            field.violation("I15", format!("{} was never answered", asker.id));
                            continue;
                        };
                        let Ok(envelope) = envelope(&answer) else {
                            continue;
                        };
                        let number = envelope["data"]["id"].as_str().and_then(message_number);
                        let succeeded = envelope["status"] == "success";
                        let reason = envelope["reason"].as_str().unwrap_or("").to_string();
                        if !succeeded && reason != "reply_timeout" {
                            field.violation("I15", format!("{} asked: {envelope}", asker.id));
                        }
                        field.note_sent(Sent {
                            seq,
                            from: asker.id.clone(),
                            from_managed: true,
                            to: boss.id.clone(),
                            text,
                            wait: "result",
                            called_us,
                            answered_us: now_us(),
                            took_ms: 0.0,
                            number,
                            succeeded,
                            said: reason,
                            failure: None,
                            limit_us: crate::judge::LIMIT_US,
                        });
                    }
                })
            })
            .collect();
        for asking in asking {
            let _ = asking.join();
        }
        pause(12_000);
        let _ = field.quiet();
        done.store(true, Ordering::SeqCst);
    });
    field.note("late_replies", json!(late.load(Ordering::SeqCst)));
    drop((clients, boss_client));
    field.finish(out)
}

/// Many waits at once, and how long an ordinary send takes beside them.
fn w8(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "600 waits for delivery to a held recipient, and ordinary sends".into(),
    )?;
    let held = field.start("held", &[])?;
    let other = field.start("other", &[])?;
    let senders = field.start_all("s", 10, &[])?;
    let clients = field.clients(&senders)?;
    type_raw(&field, &held, b"a draft")?;
    pause(300);
    let mut waiting = Vec::new();
    for n in 0..600 {
        let (sender, mcp) = (&senders[n % 10], &clients[n % 10]);
        let (seq, text) = field.name_next(&sender.id);
        let called_us = now_us();
        let answer = mcp.begin(
            "send_message",
            json!({
                "to": held.address, "text": text, "wait_for": "delivery", "timeout_seconds": 20,
            }),
        );
        waiting.push((seq, sender.id.clone(), text, called_us, answer));
    }
    pause(1500);
    // The ordinary calls beside them.
    let mut calls = Vec::new();
    for n in 0..40 {
        let sent = field.send(
            &clients[n % 10],
            &senders[n % 10].id,
            &other,
            Shape::Short,
            "inbox",
        );
        calls.push(sent.took_ms);
        pause(150);
    }
    field.note(
        "send_call_beside_600_waits_ms",
        crate::judge::summary(calls),
    );
    // The held input comes free: what waits goes.
    type_raw(&field, &held, b"\x03")?;
    for (seq, from, text, called_us, answer) in waiting {
        let Ok((_, answer)) = answer.recv_timeout(Duration::from_secs(60)) else {
            field.violation("I15", format!("send {seq} was never answered"));
            continue;
        };
        let envelope = envelope(&answer)?;
        field.note_sent(Sent {
            seq,
            from,
            from_managed: true,
            to: held.id.clone(),
            text,
            wait: "delivery",
            called_us,
            answered_us: now_us(),
            took_ms: 0.0,
            number: envelope["data"]["id"].as_str().and_then(message_number),
            succeeded: envelope["status"] == "success",
            said: envelope["reason"]
                .as_str()
                .unwrap_or("delivered")
                .to_string(),
            failure: (envelope["status"] != "success").then(|| envelope.to_string()),
            limit_us: 19_250_000,
        });
    }
    drop(clients);
    field.finish(out)
}

/// The same call again, as a relay repeats it to the next daemon: one message.
fn w9(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "30 calls of agent.send, each made three times with one request ID".into(),
    )?;
    let boss = field.start("boss", &[])?;
    let mut sent = Vec::new();
    std::thread::scope(|scope| {
        let (field, boss) = (&field, &boss);
        let handles: Vec<_> = (0..30)
            .map(|n| {
                scope.spawn(move || {
                    let (seq, text) = field.name_next("cli");
                    let mut numbers = BTreeSet::new();
                    let called_us = now_us();
                    for _ in 0..3 {
                        let answer = field.lab.wire.call(
                            "agent.send",
                            json!({
                                "to": boss.reference, "text": text, "wait_for": "delivery",
                                "request_id": format!("storm-request-{n}"), "time_left_ms": 25_000,
                            }),
                        );
                        match answer {
                            Ok(answer) => {
                                numbers.extend(answer["id"].as_str().and_then(message_number));
                            }
                            Err(err) => field.violation("I15", format!("agent.send: {err:#}")),
                        }
                    }
                    if numbers.len() != 1 {
                        field.violation("I2", format!("one request ID made {numbers:?}"));
                    }
                    Sent {
                        seq,
                        from: "command_line".into(),
                        from_managed: false,
                        to: boss.id.clone(),
                        text,
                        wait: "delivery",
                        called_us,
                        answered_us: now_us(),
                        took_ms: 0.0,
                        number: numbers.first().copied(),
                        succeeded: true,
                        said: "delivered".into(),
                        failure: None,
                        limit_us: crate::judge::LIMIT_US,
                    }
                })
            })
            .collect();
        for handle in handles {
            if let Ok(one) = handle.join() {
                sent.push(one);
            }
        }
    });
    for one in sent {
        field.note_sent(one);
    }
    field.finish(out)
}

/// A guest of the storm's, as an agent others address.
fn guest(field: &Field, n: usize) -> anyhow::Result<(Agent, Arc<Mcp>)> {
    let session = format!("storm-guest-{n}");
    let mcp = Mcp::guest(
        &field.lab.home,
        "claude",
        &[("CLAUDE_CODE_SESSION_ID", session.as_str())],
    )?;
    // Its first call makes it a guest.
    let listed = mcp.call("list_agents", json!({}))?;
    anyhow::ensure!(listed["status"] == "success", "list_agents: {listed}");
    let address = listed["data"]["you"]
        .as_str()
        .or_else(|| listed["data"]["self"].as_str())
        .or_else(|| listed["data"]["caller"].as_str())
        .map(str::to_string);
    let address = match address {
        Some(address) => address,
        None => {
            // The newest guest listed is this one.
            listed["data"]["agents"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|agent| agent["type"] == "guest")
                .filter_map(|agent| agent["id"].as_str())
                .max_by_key(|id| {
                    id.trim_start_matches('a')
                        .split('@')
                        .next()
                        .and_then(|digits| digits.parse::<u64>().ok())
                })
                .ok_or_else(|| anyhow::anyhow!("no guest is listed: {listed}"))?
                .to_string()
        }
    };
    let id = address.split('@').next().unwrap_or_default().to_string();
    Ok((
        Agent {
            id,
            address,
            reference: Value::Null,
            pid: 0,
        },
        Arc::new(mcp),
    ))
}

/// Keeps `guest` reading until `done`, as its instructions tell it.
fn keep_reading(field: &Field, guest: &Agent, mcp: &Mcp, done: &AtomicBool) {
    while !done.load(Ordering::SeqCst) {
        if let Err(err) = read(field, mcp, &guest.id, json!({ "timeout_seconds": 3 })) {
            field.violation("I14", format!("{}'s read failed: {err:#}", guest.id));
            break;
        }
    }
}

fn guests(name: &str, out: &Path, count: usize, each: usize) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        format!("{count} guests that read, {count} agents, {each} messages of each to each kind"),
    )?;
    let agents = field.start_all("w", count, &[])?;
    let clients = field.clients(&agents)?;
    let guests: Vec<(Agent, Arc<Mcp>)> = (0..count)
        .map(|n| guest(&field, n))
        .collect::<anyhow::Result<_>>()?;
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (field, done, guests, agents) = (&field, &done, &guests, &agents);
        for (guest, mcp) in guests {
            scope.spawn(move || keep_reading(field, guest, mcp, done));
        }
        let mut sending = Vec::new();
        for (n, (guest, mcp)) in guests.iter().enumerate() {
            sending.push(scope.spawn(move || {
                for k in 0..each {
                    for to in [
                        &agents[(n + k) % agents.len()],
                        &guests[(n + k + 1) % guests.len()].0,
                    ] {
                        let mut sent = field.send_unkept(mcp, &guest.id, to, Shape::Short, "inbox");
                        sent.from_managed = false;
                        field.note_sent(sent);
                    }
                    pause(50);
                }
            }));
        }
        for (n, (agent, mcp)) in agents.iter().zip(&clients).enumerate() {
            sending.push(scope.spawn(move || {
                for k in 0..each {
                    let to = &guests[(n + k) % guests.len()].0;
                    field.send(mcp, &agent.id, to, Shape::Short, "inbox");
                    pause(50);
                }
            }));
        }
        for sending in sending {
            let _ = sending.join();
        }
        let _ = field.quiet();
        done.store(true, Ordering::SeqCst);
    });
    drop((clients, guests));
    field.finish(out)
}

fn g1(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    guests(name, out, 3, 10)
}

fn g6(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    guests(name, out, 20, 5)
}

/// A guest that reads nothing for a while: reasonable failures, each told once.
fn g3(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "10 messages to a guest that does not read for 45 s".into(),
    )?;
    let senders = field.start_all("s", 10, &[])?;
    let clients = field.clients(&senders)?;
    let (guest, mcp) = guest(&field, 0)?;
    std::thread::scope(|scope| {
        for (sender, client) in senders.iter().zip(&clients) {
            let (field, guest) = (&field, &guest);
            scope.spawn(move || field.send(client, &sender.id, guest, Shape::Short, "inbox"));
        }
    });
    pause(45_000);
    // It reads again: what comes then arrives at once.
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (field, guest, done, mcp) = (&field, &guest, &done, &mcp);
        scope.spawn(move || keep_reading(field, guest, mcp, done));
        for (sender, client) in senders.iter().zip(&clients) {
            let sent = field.send(client, &sender.id, guest, Shape::Short, "delivery");
            if !sent.succeeded || sent.took_ms > 1000.0 {
                field.violation(
                    "I7",
                    format!(
                        "a guest that reads again took a message after {:.0} ms: {}",
                        sent.took_ms, sent.said
                    ),
                );
            }
        }
        done.store(true, Ordering::SeqCst);
    });
    drop((clients, mcp));
    field.finish(out)
}

/// Two reads of one inbox at once: each message once.
fn g8(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let field = Field::new(
        name,
        "a guest reads its inbox in three calls at once, 60 messages".into(),
    )?;
    let senders = field.start_all("s", 6, &[])?;
    let clients = field.clients(&senders)?;
    let (guest, mcp) = guest(&field, 0)?;
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (field, guest, done, mcp) = (&field, &guest, &done, &mcp);
        for _ in 0..3 {
            scope.spawn(move || keep_reading(field, guest, mcp, done));
        }
        let sending: Vec<_> = senders
            .iter()
            .zip(&clients)
            .map(|(sender, client)| {
                scope.spawn(move || {
                    for _ in 0..10 {
                        field.send(client, &sender.id, guest, Shape::Short, "inbox");
                        pause(30);
                    }
                })
            })
            .collect();
        for sending in sending {
            let _ = sending.join();
        }
        let _ = field.quiet();
        done.store(true, Ordering::SeqCst);
    });
    drop((clients, mcp));
    field.finish(out)
}
