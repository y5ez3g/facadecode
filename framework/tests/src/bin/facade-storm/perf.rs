//! What delivery, starts, stops, keys and waiting cost, and the least each could: the measures the
//! storm's specification names T1 to T9, C1 to C4 and M1 to M5. Run it on a machine doing nothing
//! else.

use std::path::Path;
use std::sync::Barrier;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use facade_base::base64;
use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

use crate::client::{self, Mcp};
use crate::judge::summary;
use crate::lab::{Agent, Lab};
use crate::person::{attach, now_us};
use crate::sample::{Over, one, round};
use crate::storm::{self, Shape};
use crate::tape::{Tape, Token, is_facades};

/// How long the daemon gets to settle before it is measured idle.
const SETTLE: Duration = Duration::from_secs(45);

type Part = Box<dyn Fn() -> anyhow::Result<Value>>;

pub fn run(folder: &Path, agents: usize, shared: bool) -> anyhow::Result<()> {
    let mut out = crate::programs();
    out["set"] = json!("perf");
    out["agents"] = json!(agents);
    out["shared"] = json!(shared);
    let parts: [(&str, Part); 6] = [
        ("floors", Box::new(floors)),
        ("cpu_floors", Box::new(cpu_floors)),
        ("one", Box::new(one_agent)),
        ("many", Box::new(move || many_agents(agents))),
        ("growth", Box::new(move || growth(agents))),
        ("cycles", Box::new(move || cycles(30, 4))),
    ];
    let wanted = std::env::var("FACADE_STORM_PARTS").unwrap_or_default();
    for (name, part) in parts {
        if !wanted.is_empty() && !wanted.split(',').any(|each| each == name) {
            continue;
        }
        println!("== {name}");
        match part() {
            Ok(value) => {
                println!("   {value}");
                out[name] = value;
            }
            Err(err) => {
                println!("   could not run: {err:#}");
                out[name] = json!({ "could_not_run": format!("{err:#}") });
            }
        }
        crate::save(folder, &out);
    }
    Ok(())
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// The least each step could take on this machine.
fn floors() -> anyhow::Result<Value> {
    let lab = Lab::fake("floors")?;
    // A call the daemon refuses at once: the pipe both ways and one dispatch.
    let pipe: Vec<f64> = (0..500)
        .map(|_| {
            let began = Instant::now();
            let _ = lab
                .wire
                .request("call", json!({ "op": "none", "args": {} }), secs(5));
            ms(began.elapsed())
        })
        .collect();
    // One row committed as the store commits it, in the same folder.
    let connection = rusqlite::Connection::open(lab.home.folder().join("floor.db"))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.execute("CREATE TABLE t (n INTEGER PRIMARY KEY, text TEXT)", [])?;
    let commit: Vec<f64> = (0..500)
        .map(|_| {
            let began = Instant::now();
            let _ = connection.execute("INSERT INTO t (text) VALUES (?1)", ["x".repeat(200)]);
            ms(began.elapsed())
        })
        .collect();
    // A program in a pseudo console: until it runs, and until it drew.
    let (mut spawned, mut drawn) = (Vec::new(), Vec::new());
    for _ in 0..15 {
        let mut command = lab.home.command(&test_binaries().fakecli);
        let began = Instant::now();
        let term = TestTerminal::spawn(&mut command, 120, 30);
        spawned.push(ms(began.elapsed()));
        term.wait_for_bytes(0, "❯".as_bytes(), secs(10));
        drawn.push(ms(began.elapsed()));
    }
    Ok(json!({
        "pipe_ms": summary(pipe), "commit_ms": summary(commit),
        "spawn_in_console_ms": summary(spawned), "fake_cli_drawn_ms": summary(drawn),
    }))
}

/// The processor this process spends on `count` runs of `each`, in milliseconds for one.
fn cpu_of(count: usize, mut each: impl FnMut()) -> f64 {
    let pid = std::process::id() as i32;
    let before = one(pid).cpu_s;
    for _ in 0..count {
        each();
    }
    (one(pid).cpu_s - before) * 1000.0 / count as f64
}

/// What feeding `pieces` to a screen costs, and what reading the input after each piece adds. One row
/// for the least a daemon can do with a CLI's output.
fn parse_cost(pieces: &[Vec<u8>], rule: &str) -> anyhow::Result<Value> {
    let rule = facade_rules::find(rule)
        .map_err(anyhow::Error::msg)?
        .context("a rule")?;
    let bytes: usize = pieces.iter().map(Vec::len).sum();
    anyhow::ensure!(bytes > 0, "no bytes were recorded");
    // Enough of them that the clock of processor time tells.
    let times = (12_000_000 / bytes).clamp(1, 3000);
    let feed = cpu_of(times, || {
        let mut screen = facade_screen::Screen::new(120, 30, 200);
        for piece in pieces {
            screen.feed(piece);
        }
        std::hint::black_box(screen.view());
    });
    let read = cpu_of(times.div_ceil(4), || {
        let mut screen = facade_screen::Screen::new(120, 30, 200);
        for piece in pieces {
            screen.feed(piece);
            std::hint::black_box(facade_rules::read_box(&rule.input, &screen.view()));
        }
    });
    let mb = bytes as f64 / 1e6;
    Ok(json!({
        "bytes": bytes, "pieces": pieces.len(),
        "feed_cpu_ms_per_mb": round(feed / mb),
        "feed_and_read_each_piece_cpu_ms_per_mb": round(read / mb),
        "read_one_piece_cpu_us": round((read - feed).max(0.0) * 1000.0 / pieces.len() as f64),
        "feed_cpu_ms": round(feed), "feed_and_read_cpu_ms": round(read),
    }))
}

/// The least processor a delivery could cost: one commit, and the parse of what the CLI draws for it.
/// `FACADE_STORM_FRAMES` names real CLIs' recordings: `cli=messages=file`, parted by semicolons.
fn cpu_floors() -> anyhow::Result<Value> {
    let lab = Lab::fake("cpu-floors")?;
    let connection = rusqlite::Connection::open(lab.home.folder().join("floor.db"))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.execute("CREATE TABLE t (n INTEGER PRIMARY KEY, text TEXT)", [])?;
    let commit = cpu_of(3000, || {
        let _ = connection.execute("INSERT INTO t (text) VALUES (?1)", ["x".repeat(200)]);
    });

    // The fake CLI's own bytes for one message, as a viewer of it is given them.
    let boss = lab.start_fake("boss", &[])?;
    let sender = lab.start_fake("s01", &[])?;
    lab.wait_ready(&[boss.clone(), sender.clone()], secs(60))?;
    let daemon = lab.home.daemon_pid().context("the daemon")?;
    let mcp = Mcp::managed(&lab.home, &sender.id)?;
    let deliver = |count: usize, name: &str| {
        for n in 0..count {
            let text = format!("{name}-{n:04}");
            storm::send(&mcp, &sender.id, &boss, n, text, "delivery");
        }
    };
    deliver(20, "warm");
    let over = Over::start(daemon);
    deliver(300, "floor");
    let cpu = over.cpu_s() * 1000.0 / 300.0;
    let switches = over.end()["switches_per_s"].clone();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Default::default();
    let seen_in = seen.clone();
    let wire = client::terminal_with(&lab.home.daemon_socket(), move |notice| {
        let params = &notice["params"];
        let change = match params["change"].is_object() {
            true => &params["change"],
            false => params,
        };
        if let Some(bytes) = change["data"]
            .as_str()
            .and_then(|data| base64::decode(data).ok())
        {
            seen_in.lock().unwrap().push(bytes);
        }
    })?;
    wire.request(
        "watch",
        json!({ "topic": "attach", "args": {
            "target": boss.reference, "size": { "cols": 120, "rows": 30 }, "viewer": "storm",
        } }),
        secs(30),
    )?;
    std::thread::sleep(secs(1));
    seen.lock().unwrap().clear();
    let over = Over::start(daemon);
    deliver(100, "seen");
    let cpu_watched = over.cpu_s() * 1000.0 / 100.0;
    std::thread::sleep(Duration::from_millis(300));
    let pieces = seen.lock().unwrap().clone();
    let rule = lab.inspect(&boss)?["rule"]
        .as_str()
        .unwrap_or("claude")
        .to_string();
    let parse = parse_cost(&pieces, &rule)?;
    let floor = commit + parse["feed_cpu_ms"].as_f64().unwrap_or_default() / 100.0;
    let mut out = json!({
        "commit_cpu_ms": round(commit),
        "fake": {
            "daemon_cpu_ms_per_message": round(cpu),
            "daemon_cpu_ms_per_message_with_a_viewer": round(cpu_watched),
            "daemon_switches_per_s": switches,
            "bytes_per_message": parse["bytes"].as_u64().unwrap_or_default() / 100,
            "pieces_per_message": pieces.len() as f64 / 100.0,
            "parse": parse,
            "least_cpu_ms_per_message": round(floor),
            "times_the_least": round(cpu / floor),
        },
        "real": {},
    });
    for named in std::env::var("FACADE_STORM_FRAMES")
        .unwrap_or_default()
        .split(';')
        .filter(|named| !named.is_empty())
    {
        let mut words = named.splitn(3, '=');
        let (Some(cli), Some(count), Some(file)) = (words.next(), words.next(), words.next())
        else {
            continue;
        };
        let messages: f64 = count.parse()?;
        let pieces: Vec<Vec<u8>> = std::fs::read_to_string(file)?
            .lines()
            .filter_map(|line| facade_scenarios::serde_json::from_str::<Value>(line).ok())
            .filter_map(|piece| base64::decode(piece["data"].as_str()?).ok())
            .collect();
        let parse = parse_cost(&pieces, cli)?;
        let feed = parse["feed_cpu_ms"].as_f64().unwrap_or_default();
        out["real"][cli] = json!({
            "messages": messages,
            "bytes_per_message": round(parse["bytes"].as_f64().unwrap_or_default() / messages),
            "pieces_per_message": round(pieces.len() as f64 / messages),
            "parse": parse,
            "least_cpu_ms_per_message": round(commit + feed / messages),
        });
    }
    Ok(out)
}

/// When each message's paste and submission key were read, by the message's name in its text.
fn reads(tape: &Tape, name: &str) -> Option<(u64, u64)> {
    let paste = tape
        .tokens
        .iter()
        .position(|(_, token)| matches!(token, Token::Paste(paste) if paste.text.contains(name)))?;
    let enter = tape.tokens[paste..]
        .iter()
        .find(|(_, token)| *token == Token::Control(b'\r'))?;
    Some((tape.tokens[paste].0, enter.0))
}

fn one_agent() -> anyhow::Result<Value> {
    let lab = Lab::fake("one")?;
    let boss = lab.start_fake("boss", &[("FAKECLI_MOUSE", "1")])?;
    let sender = lab.start_fake("s01", &[])?;
    lab.wait_ready(&[boss.clone(), sender.clone()], secs(60))?;
    let daemon = lab.home.daemon_pid().context("the daemon")?;

    // Sends one at a time to an idle recipient: T1 and T2.
    let mcp = Mcp::managed(&lab.home, &sender.id)?;
    let direct = send_each(&lab, &mcp, &sender, &boss, "direct", 200)?;
    let relay = Mcp::managed_process(&lab.home, &sender.id)?;
    let relayed = send_each(&lab, &relay, &sender, &boss, "relayed", 100)?;
    drop(relay);

    // The processor one delivery costs.
    let over = Over::start(daemon);
    for n in 0..200 {
        storm::send(
            &mcp,
            &sender.id,
            &boss,
            n,
            format!("cpu-{n:04}"),
            "delivery",
        );
    }
    let cpu_per_message = over.cpu_s() * 1000.0 / 200.0;

    let keys = echo(&lab, &boss, 100);
    let raw = raw_keys(&lab, &boss, 200)?;
    Ok(json!({
        "send_direct": direct, "send_through_facade_mcp": relayed,
        "cpu_ms_per_delivered_message": round(cpu_per_message),
        "echo_through_attach_ms": keys, "raw_key_to_cli_ms": raw,
    }))
}

/// `count` sends, each once the last was submitted: what the call took, how long until the paste was
/// read, and how long the paste waited for its key.
fn send_each(
    lab: &Lab,
    mcp: &Mcp,
    sender: &Agent,
    boss: &Agent,
    tag: &str,
    count: usize,
) -> anyhow::Result<Value> {
    let mut called = Vec::new();
    for n in 0..count {
        let name = format!("{tag}-{n:04}.");
        let sent = storm::send(mcp, &sender.id, boss, n, name.clone(), "inbox");
        called.push((name, sent));
        std::thread::sleep(Duration::from_millis(220));
    }
    std::thread::sleep(secs(1));
    let tape = lab.tape(&boss.id);
    let (mut to_paste, mut to_key, mut whole) = (Vec::new(), Vec::new(), Vec::new());
    for (name, sent) in &called {
        if let Some((paste, key)) = reads(&tape, name) {
            to_paste.push(paste.saturating_sub(sent.called_us) as f64 / 1000.0);
            to_key.push(key.saturating_sub(paste) as f64 / 1000.0);
            whole.push(key.saturating_sub(sent.called_us) as f64 / 1000.0);
        }
    }
    Ok(json!({
        "call_ms": summary(called.iter().map(|(_, sent)| sent.took_ms).collect()),
        "called_to_paste_ms": summary(to_paste), "paste_to_key_ms": summary(to_key),
        "called_to_key_ms": summary(whole),
    }))
}

/// Keys typed in an attach's window, each timed until it shows there.
fn echo(lab: &Lab, boss: &Agent, count: usize) -> Value {
    let term = attach(&lab.home, &boss.address);
    std::thread::sleep(secs(1));
    let mut times = Vec::new();
    for n in 0..count {
        let key = [b'a' + (n % 26) as u8];
        let from = term.output_len();
        let began = Instant::now();
        term.send(&key);
        if term.wait_for_bytes(from, &key, secs(2)) {
            times.push(ms(began.elapsed()));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // The draft goes, so that messages can come.
    term.send(b"\x03");
    std::thread::sleep(Duration::from_millis(300));
    summary(times)
}

/// Raw keys, each timed until the CLI read it.
fn raw_keys(lab: &Lab, boss: &Agent, count: usize) -> anyhow::Result<Value> {
    let rpc = client::terminal(&lab.home.daemon_socket())?;
    let before = lab.tape(&boss.id).tokens.len();
    let mut sent = Vec::new();
    for n in 0..count {
        let key = [b'a' + (n % 26) as u8];
        sent.push(now_us());
        rpc.notify(
            "call",
            json!({ "op": "agent.type", "args": { "target": boss.reference,
                "input": { "kind": "raw", "raw": base64::encode(&key) } } }),
        )?;
        std::thread::sleep(Duration::from_millis(15));
    }
    std::thread::sleep(Duration::from_millis(500));
    let read: Vec<u64> = lab.tape(&boss.id).tokens[before..]
        .iter()
        .filter(|(_, token)| matches!(token, Token::Char(_)))
        .map(|(us, _)| *us)
        .collect();
    rpc.notify(
        "call",
        json!({ "op": "agent.type", "args": { "target": boss.reference,
            "input": { "kind": "raw", "raw": base64::encode(b"\x03") } } }),
    )?;
    std::thread::sleep(Duration::from_millis(300));
    Ok(summary(
        sent.iter()
            .zip(read)
            .map(|(sent, read)| read.saturating_sub(*sent) as f64 / 1000.0)
            .collect(),
    ))
}

fn many_agents(agents: usize) -> anyhow::Result<Value> {
    let lab = Lab::fake("many")?;
    let daemon = lab.home.daemon_pid().context("the daemon")?;
    let keeper = lab.home.keeper_pid().context("the keeper")?;
    std::thread::sleep(secs(5));
    let (empty_daemon, empty_keeper) = (one(daemon).private_mb, one(keeper).private_mb);

    // T4: a start's call, alone and with many running. T5: until its first message is submitted.
    let mut all = Vec::new();
    let (mut first_calls, mut last_calls) = (Vec::new(), Vec::new());
    for n in 0..agents {
        let began = Instant::now();
        all.push(lab.start_fake(&format!("w{n:02}"), &[])?);
        let took = ms(began.elapsed());
        if n < 10 {
            first_calls.push(took);
        } else if n + 10 >= agents {
            last_calls.push(took);
        }
    }
    lab.wait_ready(&all, secs(120))?;
    let prompted = prompted_starts(&lab, 10)?;
    all.extend(prompted.1);

    // T9, C1, M1: nobody sends, nobody watches.
    std::thread::sleep(SETTLE);
    let over = Over::start(daemon);
    let keeper_over = Over::start(keeper);
    std::thread::sleep(secs(30));
    let (idle, keeper_idle) = (over.end(), keeper_over.end());
    let per_agent = (one(daemon).private_mb - empty_daemon) / all.len() as f64;
    let relays: Vec<f64> = relay_processes(&lab)
        .iter()
        .map(|pid| one(*pid).private_mb)
        .collect();

    // T8: lists and screens.
    let caller = Mcp::managed(&lab.home, &all[0].id)?;
    let timed = |tool: &str, arguments: Value| -> Value {
        summary(
            (0..100)
                .filter_map(|_| {
                    let began = Instant::now();
                    caller.call(tool, arguments.clone()).ok()?;
                    Some(ms(began.elapsed()))
                })
                .collect(),
        )
    };
    let lists = timed("list_agents", json!({}));
    let screens = timed("read_screen", json!({ "agent": all[1].address }));

    // T3, C2: everyone sends to one at one moment.
    let boss = all[0].clone();
    let senders: Vec<Agent> = all[1..].iter().take(50).cloned().collect();
    let clients: Vec<Mcp> = senders
        .iter()
        .map(|sender| Mcp::managed(&lab.home, &sender.id))
        .collect::<anyhow::Result<_>>()?;
    let mut bursts = Vec::new();
    for round_at in 0..3 {
        bursts.push(burst(&lab, &boss, &senders, &clients, round_at)?);
    }

    // T7: a person's keys while everyone sends.
    let quiet_keys = echo(&lab, &all[2], 60);
    let storming = AtomicBool::new(true);
    let (storm_keys, storm_cpu, storm_sent) = std::thread::scope(|scope| {
        for (n, (sender, mcp)) in senders.iter().zip(&clients).enumerate().skip(3) {
            let (storming, all) = (&storming, &all);
            scope.spawn(move || {
                let mut k = 0usize;
                while storming.load(Ordering::SeqCst) {
                    let to = &all[(n * 7 + k * 13) % all.len()];
                    // The window with the person in it takes none: its keys are timed, not its
                    // messages.
                    if to.id != all[2].id && to.id != sender.id {
                        storm::send(mcp, &sender.id, to, k, format!("storm-{n}-{k}"), "inbox");
                    }
                    k += 1;
                    std::thread::sleep(Duration::from_millis(1000));
                }
            });
        }
        std::thread::sleep(secs(3));
        let over = Over::start(daemon);
        let before = lab.rows().map_or(0, |rows| rows.len());
        let keys = echo(&lab, &all[2], 200);
        std::thread::sleep(secs(20));
        let cpu = over.end();
        let sent = lab.rows().map_or(0, |rows| rows.len()) - before;
        storming.store(false, Ordering::SeqCst);
        (keys, cpu, sent)
    });
    std::thread::sleep(secs(5));

    // T6: stops. M2: what an ended agent leaves.
    let before_stop = one(daemon).private_mb;
    let mut stops = Vec::new();
    for agent in &all {
        let began = Instant::now();
        lab.wire.call(
            "agent.stop",
            json!({ "selection": { "kind": "targets", "targets": [agent.reference] } }),
        )?;
        stops.push(ms(began.elapsed()));
    }
    drop(clients);
    drop(caller);
    std::thread::sleep(secs(70));
    let after = one(daemon);
    Ok(json!({
        "empty_daemon_mb": round(empty_daemon), "empty_keeper_mb": round(empty_keeper),
        "start_call_first_10_ms": summary(first_calls),
        "start_call_last_10_ms": summary(last_calls),
        "first_message_after_drawn_ms": prompted.0,
        "idle_daemon": idle, "idle_keeper": keeper_idle,
        "daemon_mb_per_idle_agent": round(per_agent),
        "keeper_mb_per_agent": round((one(keeper).private_mb - empty_keeper) / all.len() as f64),
        "relay_mb": summary(relays),
        "list_agents_ms": lists, "read_screen_ms": screens,
        "burst_50_to_1": bursts,
        "echo_ms": quiet_keys, "echo_in_storm_ms": storm_keys,
        "storm": { "daemon": storm_cpu, "messages": storm_sent },
        "stop_ms": summary(stops),
        "daemon_mb_before_stops": round(before_stop),
        "daemon_mb_a_minute_after_stops": round(after.private_mb),
        "daemon_mb_per_ended_agent": round((after.private_mb - empty_daemon) / all.len() as f64),
        "wal_mb": round(wal_mb(&lab)),
    }))
}

/// Starts `count` agents one by one with a first message: how long after its CLI drew each message
/// was submitted, and the agents.
fn prompted_starts(lab: &Lab, count: usize) -> anyhow::Result<(Value, Vec<Agent>)> {
    let mut agents = Vec::new();
    let mut times = Vec::new();
    for n in 0..count {
        let began = now_us();
        let mut command = lab.home.command("x");
        command
            .env("FAKECLI_TAPE", &lab.tapes)
            .env("PATH", lab.home.path_with_test_programs());
        let env: std::collections::BTreeMap<String, String> = command
            .get_envs()
            .filter_map(|(name, value)| {
                Some((name.to_str()?.to_string(), value?.to_str()?.to_string()))
            })
            .collect();
        let started = lab.wire.call(
            "agent.start",
            json!({
                "name": format!("p{n:02}"), "cli": "fake", "folder": lab.home.project, "env": env,
                "prompt": format!("first-{n:02}"), "size": { "cols": 120, "rows": 30 },
            }),
        )?;
        let agent = Lab::agent(&started["agent"])?;
        wait_until(secs(30), || !lab.tape(&agent.id).submissions.is_empty());
        let tape = lab.tape(&agent.id);
        if let (Some(drawn), Some(submitted)) = (tape.drawn, tape.submissions.first()) {
            times.push((
                submitted.us.saturating_sub(drawn) as f64 / 1000.0,
                drawn.saturating_sub(began) as f64 / 1000.0,
            ));
        }
        agents.push(agent);
    }
    Ok((
        json!({
            "drawn_to_submitted": summary(times.iter().map(|(after, _)| *after).collect()),
            "call_to_drawn": summary(times.iter().map(|(_, drawn)| *drawn).collect()),
        }),
        agents,
    ))
}

/// Everyone sends one message to `boss` at one moment: when they were all submitted, and what each
/// cost the daemon.
fn burst(
    lab: &Lab,
    boss: &Agent,
    senders: &[Agent],
    clients: &[Mcp],
    round_at: usize,
) -> anyhow::Result<Value> {
    let daemon = lab.home.daemon_pid().context("the daemon")?;
    let barrier = Barrier::new(senders.len());
    let before = lab.tape(&boss.id).submissions.len();
    let over = Over::start(daemon);
    let began = now_us();
    let calls: Vec<f64> = std::thread::scope(|scope| {
        let handles: Vec<_> = senders
            .iter()
            .zip(clients)
            .enumerate()
            .map(|(n, (sender, mcp))| {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    let text = Shape::Short.text(&format!("burst-{round_at}-{n:02}"));
                    storm::send(mcp, &sender.id, boss, n, text, "inbox").took_ms
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or(f64::NAN))
            .collect()
    });
    let wanted = before + senders.len();
    wait_until(secs(40), || lab.tape(&boss.id).submissions.len() >= wanted);
    let cpu = over.cpu_s() * 1000.0;
    let tape = lab.tape(&boss.id);
    let mine: Vec<u64> = tape.submissions[before.min(tape.submissions.len())..]
        .iter()
        .map(|submission| submission.us)
        .collect();
    let gaps: Vec<f64> = mine
        .windows(2)
        .map(|pair| (pair[1] - pair[0]) as f64 / 1000.0)
        .collect();
    // How long each paste waited for its key.
    let stays: Vec<f64> = tape
        .tokens
        .iter()
        .filter(|(us, token)| {
            *us > began && matches!(token, Token::Paste(paste) if is_facades(&paste.text))
        })
        .zip(&mine)
        .map(|((paste, _), key)| key.saturating_sub(*paste) as f64 / 1000.0)
        .collect();
    Ok(json!({
        "submitted": mine.len(), "call_ms": summary(calls),
        "all_submitted_after_ms": round(mine.last().copied().unwrap_or(began).saturating_sub(began) as f64 / 1000.0),
        "between_submissions_ms": summary(gaps), "paste_to_key_ms": summary(stays),
        "daemon_cpu_ms_per_message": round(cpu / senders.len() as f64),
    }))
}

/// 10,000 messages among `agents`, and the daemon's memory as they go.
fn growth(agents: usize) -> anyhow::Result<Value> {
    let lab = Lab::fake("growth")?;
    let daemon = lab.home.daemon_pid().context("the daemon")?;
    let names: Vec<String> = (0..agents).map(|n| format!("g{n:02}")).collect();
    let all = storm::start_many(&lab, &names, &[])?;
    lab.wait_ready(&all, secs(120))?;
    let clients: Vec<Mcp> = all
        .iter()
        .map(|agent| Mcp::managed(&lab.home, &agent.id))
        .collect::<anyhow::Result<_>>()?;
    let each = 10_000 / agents;
    let memory = std::sync::Mutex::new(vec![(0usize, one(daemon).private_mb)]);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let over = Over::start(daemon);
    std::thread::scope(|scope| {
        for (n, (agent, mcp)) in all.iter().zip(&clients).enumerate() {
            let (all, done, memory) = (&all, &done, &memory);
            scope.spawn(move || {
                let to = &all[(n + 1) % all.len()];
                for k in 0..each {
                    let text = Shape::Wide(300).text(&format!("grow-{n:02}-{k:04}"));
                    storm::send(mcp, &agent.id, to, k, text, "delivery");
                    let total = done.fetch_add(1, Ordering::SeqCst) + 1;
                    if total.is_multiple_of(1000) {
                        memory.lock().unwrap().push((total, one(daemon).private_mb));
                    }
                }
            });
        }
    });
    let used = over.end();
    let memory: Vec<Value> = memory
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|(total, mb)| json!([total, round(mb)]))
        .collect();
    let delivered = lab
        .rows()?
        .values()
        .filter(|row| row.status == "success")
        .count();
    let wal_before = wal_mb(&lab);
    std::thread::sleep(secs(30));
    Ok(json!({
        "messages": each * agents, "delivered": delivered, "daemon_mb": memory, "daemon": used,
        "wal_mb_at_end": round(wal_before), "wal_mb_30_s_later": round(wal_mb(&lab)),
        "database_mb": round(
            std::fs::metadata(lab.database()).map_or(0, |file| file.len()) as f64 / 1048576.0
        ),
    }))
}

/// Agents started, each sent a few messages, and stopped, again and again: what each round leaves in
/// the daemon a minute later, so that memory kept for reuse shows apart from memory lost.
fn cycles(agents: usize, rounds: usize) -> anyhow::Result<Value> {
    let lab = Lab::fake("cycles")?;
    let daemon = lab.home.daemon_pid().context("the daemon")?;
    std::thread::sleep(secs(3));
    let mut out = vec![json!({ "empty_mb": round(one(daemon).private_mb) })];
    for n in 0..rounds {
        let names: Vec<String> = (0..agents).map(|k| format!("c{n}-{k:02}")).collect();
        let all = storm::start_many(&lab, &names, &[])?;
        lab.wait_ready(&all, secs(120))?;
        let mcp = Mcp::managed(&lab.home, &all[0].id)?;
        for (k, to) in all[1..].iter().enumerate() {
            storm::send(
                &mcp,
                &all[0].id,
                to,
                k,
                format!("cycle-{n}-{k}"),
                "delivery",
            );
        }
        let running = one(daemon);
        drop(mcp);
        for agent in &all {
            lab.wire.call(
                "agent.stop",
                json!({ "selection": { "kind": "targets", "targets": [agent.reference] } }),
            )?;
        }
        std::thread::sleep(secs(70));
        let after = one(daemon);
        out.push(json!({
            "round": n + 1, "agents": agents, "running_mb": round(running.private_mb),
            "a_minute_after_stops_mb": round(after.private_mb),
            "handles_running": running.handles, "handles_after": after.handles,
            "threads_running": running.threads, "threads_after": after.threads,
        }));
        println!("   {}", out.last().expect("a round"));
    }
    Ok(Value::Array(out))
}

/// What each question a viewer asks costs the daemon of a home under test: its own processor time for a
/// hundred of them, and how long each takes.
pub fn cost(home: &Path) -> anyhow::Result<()> {
    let wire = client::terminal(&facade_base::paths::daemon_socket_for(home)?)?;
    let pid = wire.call("daemon.status", json!({})).ok();
    println!("{pid:?}");
    let agents = wire.call("agent.list", json!({}))?;
    let count = agents["agents"].as_array().map_or(0, Vec::len);
    println!("{count} agents");
    for agent in agents["agents"].as_array().cloned().unwrap_or_default() {
        let target = agent["reference"].clone();
        for (op, args) in [
            ("agent.inspect", json!({ "target": target })),
            ("agent.screen", json!({ "target": target, "lines": 60 })),
        ] {
            let mut times = Vec::new();
            for _ in 0..40 {
                let began = Instant::now();
                let _ = wire.call(op, args.clone());
                times.push(ms(began.elapsed()));
            }
            println!(
                "{} {} {op}: {}",
                agent["address"],
                agent["cli"],
                summary(times)
            );
        }
    }
    Ok(())
}

fn wal_mb(lab: &Lab) -> f64 {
    let mut wal = lab.database().into_os_string();
    wal.push("-wal");
    std::fs::metadata(Path::new(&wal)).map_or(0, |file| file.len()) as f64 / 1048576.0
}

/// The relays the home's CLIs run.
fn relay_processes(lab: &Lab) -> Vec<i32> {
    lab.home
        .processes()
        .into_iter()
        .filter(|pid| {
            program_of(*pid).is_some_and(|program| {
                program
                    .file_stem()
                    .is_some_and(|name| name.eq_ignore_ascii_case("facade-mcp"))
            })
        })
        .collect()
}
