//! Daemons that crash while agents start and end: what becomes of a first message, and how often the
//! one who started an agent is told of its end. The processor is full all the while.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

use crate::client::{self, Mcp};
use crate::judge::{Kind, Verdict, Violation, kind, short};
use crate::lab::{Agent, Lab};
use crate::storm::{Hogs, Outcome};

const ROUNDS: usize = 30;
const EACH: usize = 4;

/// Kills the daemon, and connects to the one the keeper starts after it.
fn crash(lab: &mut Lab) -> anyhow::Result<()> {
    let old = lab.home.kill_daemon();
    anyhow::ensure!(
        lab.home
            .wait_for_daemon_after(old, Duration::from_secs(30))
            .is_some(),
        "no daemon came after {old}"
    );
    lab.wire = client::terminal(&lab.home.daemon_socket())?;
    Ok(())
}

fn named(lab: &Lab, name: &str) -> Option<Agent> {
    let listed = lab.wire.call("agent.list", json!({})).ok()?;
    let info = listed["agents"]
        .as_array()?
        .iter()
        .find(|agent| agent["name"] == name)?
        .clone();
    Lab::agent(&info).ok()
}

fn stop(lab: &Lab, agent: &Agent) {
    let _ = lab.wire.call(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [agent.reference] } }),
    );
}

/// The notices `agent`'s CLI was given that name `about`.
fn notices(lab: &Lab, agent: &Agent, about: &str) -> Vec<String> {
    let named = format!("({about})");
    lab.tape(&agent.id)
        .submissions
        .iter()
        .filter_map(|submission| match kind(submission) {
            Kind::Notice(text) if text.contains(&named) => Some(text),
            _ => None,
        })
        .collect()
}

fn outcome(
    name: &str,
    out: &Path,
    lab: &Lab,
    boss: &Agent,
    mut verdict: Verdict,
    began: Instant,
) -> anyhow::Result<Outcome> {
    let folder = out.join(
        name.chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>(),
    );
    lab.keep_evidence(&folder)?;
    crate::storm::stop_all(lab, std::slice::from_ref(boss), &mut verdict);
    Ok(Outcome {
        name: name.into(),
        verdict,
        seconds: began.elapsed().as_secs_f64(),
        evidence: Some(folder),
    })
}

/// Four starts with a first message at a time, the daemon killed at another moment of them each time.
pub fn prompts(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let began = Instant::now();
    let mut lab = Lab::fake("crash-prompts")?;
    let boss = lab.start_fake("boss", &[])?;
    lab.wait_ready(std::slice::from_ref(&boss), Duration::from_secs(60))?;
    let mcp = Mcp::managed_process(&lab.home, &boss.id)?;
    let hogs = Hogs::start(14);
    let mut verdict = Verdict::default();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for round in 0..ROUNDS {
        let delay = Duration::from_millis((round as u64 * 137) % 2600);
        let prompt = |k: usize| format!("z{round:02}-{k} the first line\nthe second\nthe third");
        let answers: Vec<Value> = std::thread::scope(|scope| -> anyhow::Result<Vec<Value>> {
            let calls: Vec<_> = (0..EACH)
                .map(|k| {
                    let (mcp, folder) = (&mcp, &lab.home.project);
                    let text = prompt(k);
                    scope.spawn(move || {
                        mcp.call(
                            "start_agent",
                            json!({
                                "cli": "fake", "name": format!("z{round:02}-{k}"),
                                "folder": folder, "prompt": text,
                            }),
                        )
                        .unwrap_or_else(|err| json!({ "error": format!("{err:#}") }))
                    })
                })
                .collect();
            std::thread::sleep(delay);
            let old = lab.home.kill_daemon();
            lab.home
                .wait_for_daemon_after(old, Duration::from_secs(30))
                .ok_or_else(|| anyhow::anyhow!("no daemon came after {old}"))?;
            Ok(calls
                .into_iter()
                .map(|call| call.join().expect("a start"))
                .collect())
        })?;
        lab.wire = client::terminal(&lab.home.daemon_socket())?;
        let children: Vec<Option<Agent>> = (0..EACH)
            .map(|k| named(&lab, &format!("z{round:02}-{k}")))
            .collect();
        // A first message has 29.5 s; what the one before it left in an input shows after that.
        let first = |agent: &Agent| !lab.tape(&agent.id).submissions.is_empty();
        wait_until(Duration::from_secs(38), || {
            children.iter().flatten().all(first)
        });
        std::thread::sleep(Duration::from_millis(1500));
        for (k, child) in children.iter().enumerate() {
            let Some(child) = child else {
                *counts.entry("no such agent".into()).or_default() += 1;
                continue;
            };
            let tape = lab.tape(&child.id);
            let given: Vec<Kind> = tape.submissions.iter().map(kind).collect();
            let wanted = prompt(k);
            let whole = given
                .iter()
                .filter(|kind| matches!(kind, Kind::Message(_, body) if *body == wanted))
                .count();
            let told = notices(&lab, &boss, &child.address);
            let what = match (given.len(), whole) {
                (1, 1) => "whole, once",
                (0, _) if told.is_empty() => "not submitted, and not told",
                (0, _) => "not submitted, and told",
                (_, 1) => "whole, with something else",
                (_, 0) => "not whole",
                _ => "more than once",
            };
            *counts.entry(what.into()).or_default() += 1;
            if what != "whole, once" && what != "not submitted, and told" {
                verdict.violations.push(Violation {
                    rule: if whole == 0 { "I4" } else { "I2" },
                    what: format!(
                        "round {round}, killed after {} ms, {}: {what}; submitted {:?}; left in its \
                         input {:?}; told {told:?}; the start answered {}",
                        delay.as_millis(),
                        child.id,
                        tape.submissions
                            .iter()
                            .map(|one| short(&format!("{:?}", one.pieces)))
                            .collect::<Vec<_>>(),
                        short(tape.last_box()),
                        answers[k]["status"]
                    ),
                    class: None,
                });
            }
        }
        for child in children.iter().flatten() {
            stop(&lab, child);
        }
        println!("   round {round}: {counts:?}");
    }
    drop(hogs);
    drop(mcp);
    verdict.stats = json!({ "starts": ROUNDS * EACH, "first_messages": counts });
    outcome(name, out, &lab, &boss, verdict, began)
}

/// Agents stopped by a person before their first message, and the daemon killed right after.
pub fn ends(name: &str, out: &Path) -> anyhow::Result<Outcome> {
    let began = Instant::now();
    let mut lab = Lab::fake("crash-ends")?;
    let boss = lab.start_fake("boss", &[])?;
    lab.wait_ready(std::slice::from_ref(&boss), Duration::from_secs(60))?;
    let mcp = Mcp::managed_process(&lab.home, &boss.id)?;
    let hogs = Hogs::start(14);
    let mut verdict = Verdict::default();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for round in 0..ROUNDS {
        let stopped_after = Duration::from_millis((round as u64 * 61) % 900);
        let killed_after = Duration::from_millis((round as u64 * 37) % 400);
        // Whether the daemon is killed at all, and whether the agents had their first message.
        let (kills, prompts) = (round % 3 != 0, round % 2 == 0);
        let mut children = Vec::new();
        for k in 0..EACH {
            let mut arguments = json!({
                "cli": "fake", "name": format!("e{round:02}-{k}"), "folder": lab.home.project,
            });
            if prompts {
                arguments["prompt"] = json!(format!("e{round:02}-{k} never mind"));
            }
            let started = mcp.call("start_agent", arguments)?;
            if started["status"] != "success" {
                *counts.entry("not started".into()).or_default() += 1;
                continue;
            }
            children.extend(named(&lab, &format!("e{round:02}-{k}")));
        }
        std::thread::sleep(stopped_after);
        for child in &children {
            stop(&lab, child);
        }
        std::thread::sleep(killed_after);
        if kills {
            crash(&mut lab)?;
        }
        // Until the one who started them was told of each end, then long enough for a second time.
        wait_until(Duration::from_secs(35), || {
            children
                .iter()
                .all(|child| !notices(&lab, &boss, &child.address).is_empty())
        });
        std::thread::sleep(Duration::from_secs(3));
        for child in &children {
            let told = notices(&lab, &boss, &child.address);
            let what = format!(
                "told {} times{}{}",
                told.len(),
                if kills { ", daemon killed" } else { "" },
                if prompts {
                    ", with a first message"
                } else {
                    ""
                }
            );
            *counts.entry(what).or_default() += 1;
            if told.len() != 1 {
                verdict.violations.push(Violation {
                    rule: "I8",
                    what: format!(
                        "round {round}, stopped {} ms after its start{}: {} was told {} times of \
                         {}: {told:?}",
                        stopped_after.as_millis(),
                        if kills {
                            format!(
                                " and the daemon killed {} ms later",
                                killed_after.as_millis()
                            )
                        } else {
                            String::new()
                        },
                        boss.id,
                        told.len(),
                        child.id
                    ),
                    class: None,
                });
            }
        }
        println!("   round {round}: {counts:?}");
    }
    drop(hogs);
    drop(mcp);
    verdict.stats = json!({ "ended": ROUNDS * EACH, "told": counts });
    outcome(name, out, &lab, &boss, verdict, began)
}
