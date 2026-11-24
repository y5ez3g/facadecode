//! The person in a recipient's window while messages come: through a real `facade attach` in a
//! pseudo console, or through `agent.type`'s raw bytes as an editor's terminal sends them. What the
//! person did is kept, so that every key can be found again in what the CLI read.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use facade_base::base64;
use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

use crate::client::{self, Rpc};

/// Microseconds since 1970, as the tape counts them.
pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_micros() as u64)
        .unwrap_or_default()
}

/// What the person does, until the storm ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Habit {
    /// Attached, and still.
    Watch,
    /// The mouse wheel, this many times a second.
    Wheel { hz: u32 },
    /// Mouse moves, wheel and focus changes, this many a second in all.
    Mouse { hz: u32 },
    /// Lines typed a key at a time, each submitted with Enter, then a pause.
    Lines {
        key_ms: u64,
        chars: usize,
        pause_ms: u64,
    },
    /// A line and its Enter in one write, then a pause.
    LineAtOnce { chars: usize, pause_ms: u64 },
    /// A paste in chunks, then Enter and a pause.
    Paste {
        chars: usize,
        chunk: usize,
        gap_ms: u64,
        pause_ms: u64,
    },
    /// A line typed, left for a while, then submitted.
    HalfLine {
        chars: usize,
        left_ms: u64,
        pause_ms: u64,
    },
    /// Enter and at once another control key, such as Ctrl+C.
    EnterThen { byte: u8, every_ms: u64 },
    /// Enter alone, as a person who sees text in the input may press it.
    Enter { every_ms: u64 },
    /// The window dragged through sizes.
    Resize { every_ms: u64 },
    /// Detaching and attaching again.
    Reattach { every_ms: u64 },
    /// Modifier keys alone, as Windows Terminal reports them.
    Modifiers { hz: u32 },
    /// Lines of Chinese, several characters in one write as an input method gives them.
    Ime { pause_ms: u64 },
    /// Arrows, Tab, Escape, Home and End, this many a second.
    Keys { hz: u32 },
    /// Backspace, this many a second.
    Backspace { hz: u32 },
    /// Has the fake CLI ask something in place of its input, and answers after a while.
    Menu { open_ms: u64, pause_ms: u64 },
    /// [`Habit::Lines`] as Windows Terminal sends keys: each a record as it goes down and another
    /// as it comes up, `hold_ms` later.
    Records {
        hold_ms: u64,
        chars: usize,
        pause_ms: u64,
    },
}

/// Which way the person's bytes go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Way {
    /// `facade attach` in a pseudo console.
    Attach,
    /// The window of the `facade start` that started the agent, which sees all its CLI's console
    /// asked its terminal for, such as key records.
    Started,
    /// Raw bytes alone, with no view.
    Raw,
    /// A view as an editor's terminal shows it, which answers each request for focus reports with
    /// one, as xterm.js does, and raw bytes.
    Editor,
}

/// What the person did, in order.
#[derive(Clone, Debug, Default)]
pub struct Did {
    /// Each printable character typed outside a paste, and when it was sent.
    pub chars: Vec<(char, u64)>,
    /// Lines submitted.
    pub lines: Vec<String>,
    /// Text typed and not submitted when the storm ended.
    pub draft: String,
    /// Enters pressed.
    pub enters: usize,
    /// Pastes, as given.
    pub pastes: Vec<String>,
    /// Keys that type nothing: Backspace, Tab and Escape.
    pub controls: Vec<u8>,
    /// When the person answered a question of the CLI's.
    pub answers: Vec<u64>,
    /// Everything else sent: mouse, focus, modifiers.
    pub others: usize,
    /// Writes of any kind.
    pub writes: usize,
    /// The first write that failed.
    pub failed: Option<String>,
}

enum Keyboard {
    Attach(Box<TestTerminal>),
    Raw(Arc<Rpc>, Value),
    Editor(Arc<Rpc>, Value, u64),
}

pub struct Person {
    did: Arc<Mutex<Did>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<Keyboard>>,
}

pub const COLS: u16 = 120;
pub const ROWS: u16 = 30;

/// Opens `agent`'s window: a `facade attach`, drawn.
pub fn attach(home: &TestHome, address: &str) -> TestTerminal {
    let term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", address]),
        COLS,
        ROWS,
    );
    assert!(
        term.wait_for(Duration::from_secs(30), |text| text.contains('❯')),
        "attach to {address} did not draw its input: {}",
        term.text()
    );
    term
}

impl Person {
    /// `tag` begins each line, so that a line's agent and number can be read from it.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        home: &TestHome,
        socket: &Path,
        reference: Value,
        address: &str,
        tag: &str,
        habit: Habit,
        way: Way,
        window: Option<TestTerminal>,
    ) -> anyhow::Result<Person> {
        let did = Arc::new(Mutex::new(Did::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let mut keyboard = match way {
            Way::Started => Keyboard::Attach(Box::new(window.expect("the start's window"))),
            Way::Attach => Keyboard::Attach(Box::new(attach(home, address))),
            Way::Raw => Keyboard::Raw(Arc::new(client::terminal(socket)?), reference),
            Way::Editor => {
                let (rpc, watch) = editor(socket, &reference, did.clone())?;
                Keyboard::Editor(rpc, reference, watch)
            }
        };
        let (did_in, stop_in, tag) = (did.clone(), stop.clone(), tag.to_string());
        // A copy for the habits that open the window again.
        let reopen = Reopen {
            program: test_binaries().facade.clone(),
            home: home.path.clone(),
            address: address.to_string(),
            envs: home
                .command("x")
                .get_envs()
                .filter_map(|(name, value)| Some((name.to_owned(), value?.to_owned())))
                .collect(),
            folder: home.project.clone(),
        };
        let thread = std::thread::spawn(move || {
            live(&mut keyboard, &reopen, &tag, habit, &did_in, &stop_in);
            keyboard
        });
        Ok(Person {
            did,
            stop,
            thread: Some(thread),
        })
    }

    /// Ends what the person does. Their window closes with the value returned.
    pub fn end(mut self) -> Did {
        self.stop.store(true, Ordering::SeqCst);
        let keyboard = self.thread.take().map(std::thread::JoinHandle::join);
        drop(keyboard);
        self.did.lock().unwrap().clone()
    }
}

/// What opens the window again.
struct Reopen {
    program: std::path::PathBuf,
    home: std::path::PathBuf,
    address: String,
    envs: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    folder: std::path::PathBuf,
}

impl Reopen {
    fn open(&self) -> TestTerminal {
        let mut command = std::process::Command::new(&self.program);
        command
            .args(["attach", &self.address])
            .env_clear()
            .envs(self.envs.iter().map(|(name, value)| (name, value)))
            .env("FACADE_HOME", &self.home)
            .current_dir(&self.folder);
        TestTerminal::spawn(&mut command, COLS, ROWS)
    }
}

impl Keyboard {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Keyboard::Attach(term) => {
                use std::io::Write;
                term.keyboard()
                    .write_all(bytes)
                    .map_err(|err| format!("attach: {err}"))
            }
            Keyboard::Raw(rpc, target) | Keyboard::Editor(rpc, target, _) => {
                type_raw(rpc, target, bytes).map_err(|err| format!("agent.type: {err}"))
            }
        }
    }
}

/// Raw bytes as a notification, as attach and the editor send them.
fn type_raw(rpc: &Rpc, target: &Value, bytes: &[u8]) -> std::io::Result<()> {
    rpc.notify(
        "call",
        json!({
            "op": "agent.type",
            "args": { "target": target, "input": { "kind": "raw", "raw": base64::encode(bytes) } },
        }),
    )
}

/// Opens a view of `target`'s screen that answers each request for focus reports with one, as
/// xterm.js does. Returns the connection and its watch.
fn editor(socket: &Path, target: &Value, did: Arc<Mutex<Did>>) -> anyhow::Result<(Arc<Rpc>, u64)> {
    let (asked, asks) = std::sync::mpsc::channel::<()>();
    let in_snapshot = asked.clone();
    let rpc = client::terminal_with(socket, move |notice| {
        let data = notice["params"]["change"]["data"]
            .as_str()
            .or_else(|| notice["params"]["data"].as_str())
            .and_then(|data| base64::decode(data).ok())
            .unwrap_or_default();
        if asks_for_focus(&data) {
            let _ = asked.send(());
        }
    })?;
    let rpc = Arc::new(rpc);
    let watched = rpc.request(
        "watch",
        json!({ "topic": "attach", "args": {
            "target": target, "size": { "cols": COLS, "rows": ROWS }, "viewer": "storm",
        } }),
        Duration::from_secs(30),
    )?;
    let watch = watched["result"]["watch"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("watch: {watched}"))?;
    let redraw = watched["result"]["snapshot"]["redraw"]
        .as_str()
        .and_then(|data| base64::decode(data).ok())
        .unwrap_or_default();
    if asks_for_focus(&redraw) {
        let _ = in_snapshot.send(());
    }
    drop(in_snapshot);
    let (answering, target) = (rpc.clone(), target.clone());
    std::thread::spawn(move || {
        for () in asks {
            did.lock().unwrap().others += 1;
            let _ = type_raw(&answering, &target, b"\x1b[I");
        }
    });
    Ok((rpc, watch))
}

/// Whether `bytes` turn focus reports on.
fn asks_for_focus(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    text.split("\x1b[?").skip(1).any(|rest| {
        let end = rest.find(|ch: char| !ch.is_ascii_digit() && ch != ';');
        end.is_some_and(|end| {
            rest[end..].starts_with('h') && rest[..end].split(';').any(|mode| mode == "1004")
        })
    })
}

/// The virtual key and scan code a US keyboard gives for `ch`.
fn key_codes(ch: char) -> (u32, u32) {
    const SCANS: [u32; 26] = [
        30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17,
        45, 21, 44,
    ];
    match ch {
        'a'..='z' => {
            let at = ch as u32 - 'a' as u32;
            ('A' as u32 + at, SCANS[at as usize])
        }
        '0' => (0x30, 11),
        '1'..='9' => (ch as u32, ch as u32 - '1' as u32 + 2),
        ' ' => (0x20, 57),
        '-' => (0xbd, 12),
        '\r' => (13, 28),
        _ => (0, 0),
    }
}

/// `ch` going down or coming up, as win32-input-mode reports it.
fn key_record(ch: char, down: bool) -> String {
    let (key, scan) = key_codes(ch);
    format!("\x1b[{key};{scan};{};{};0;1_", ch as u32, u32::from(down))
}

/// Text of a line: its name, then words.
fn line_text(tag: &str, n: usize, chars: usize) -> String {
    let words = "the quick brown fox jumps over the lazy dog ";
    format!("{tag}-{n:04} ")
        .chars()
        .chain(words.chars().cycle())
        .take(chars.max(tag.len() + 6))
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn live(
    keyboard: &mut Keyboard,
    reopen: &Reopen,
    tag: &str,
    habit: Habit,
    did: &Mutex<Did>,
    stop: &AtomicBool,
) {
    let stopped = || stop.load(Ordering::SeqCst);
    let pause = |ms: u64| {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end && !stopped() {
            std::thread::sleep(Duration::from_millis(5).min(end - Instant::now()));
        }
    };
    let send = |keyboard: &mut Keyboard, bytes: &[u8]| -> bool {
        let sent = keyboard.send(bytes);
        let mut did = did.lock().unwrap();
        did.writes += 1;
        if let Err(err) = sent {
            did.failed.get_or_insert(err);
            return false;
        }
        true
    };
    // One typed character or string, noted as it goes.
    let key = |keyboard: &mut Keyboard, text: &str| {
        let us = now_us();
        {
            let mut did = did.lock().unwrap();
            did.chars.extend(text.chars().map(|ch| (ch, us)));
            did.draft.push_str(text);
        }
        send(keyboard, text.as_bytes())
    };
    let enter = |keyboard: &mut Keyboard| {
        {
            let mut did = did.lock().unwrap();
            did.enters += 1;
            let line = std::mem::take(&mut did.draft);
            if !line.is_empty() {
                did.lines.push(line);
            }
        }
        send(keyboard, b"\r")
    };
    let other = |keyboard: &mut Keyboard, bytes: &[u8]| {
        did.lock().unwrap().others += 1;
        send(keyboard, bytes)
    };
    let mut n = 0usize;
    while !stopped() {
        n += 1;
        match habit {
            Habit::Watch => pause(100),
            Habit::Wheel { hz } => {
                let button = if n.is_multiple_of(2) { 64 } else { 65 };
                other(keyboard, format!("\x1b[<{button};20;8M").as_bytes());
                pause(1000 / u64::from(hz));
            }
            Habit::Mouse { hz } => {
                let bytes = match n % 12 {
                    0 => "\x1b[O".to_string(),
                    1 => "\x1b[I".to_string(),
                    2 => "\x1b[<64;20;8M".to_string(),
                    3 => "\x1b[<65;20;8M".to_string(),
                    at => format!("\x1b[<35;{};{}M", 10 + at * 3, 5 + at),
                };
                other(keyboard, bytes.as_bytes());
                pause(1000 / u64::from(hz));
            }
            Habit::Lines {
                key_ms,
                chars,
                pause_ms,
            } => {
                for ch in line_text(tag, n, chars).chars() {
                    key(keyboard, ch.encode_utf8(&mut [0; 4]));
                    // A line begun is finished: the storm's end never cuts one.
                    std::thread::sleep(Duration::from_millis(key_ms));
                }
                enter(keyboard);
                pause(pause_ms);
            }
            Habit::LineAtOnce { chars, pause_ms } => {
                let line = line_text(tag, n, chars);
                let us = now_us();
                {
                    let mut did = did.lock().unwrap();
                    did.chars.extend(line.chars().map(|ch| (ch, us)));
                    did.enters += 1;
                    did.lines.push(line.clone());
                }
                send(keyboard, format!("{line}\r").as_bytes());
                pause(pause_ms);
            }
            Habit::Paste {
                chars,
                chunk,
                gap_ms,
                pause_ms,
            } => {
                let mut text = line_text(&format!("{tag}paste"), n, chars / 2);
                text.push('\n');
                text.push_str(&line_text(tag, n, chars / 2));
                did.lock().unwrap().pastes.push(text.clone());
                let bytes = format!("\x1b[200~{}\x1b[201~", text.replace('\n', "\r"));
                for part in bytes.as_bytes().chunks(chunk.max(1)) {
                    send(keyboard, part);
                    std::thread::sleep(Duration::from_millis(gap_ms));
                }
                did.lock().unwrap().enters += 1;
                send(keyboard, b"\r");
                pause(pause_ms);
            }
            Habit::HalfLine {
                chars,
                left_ms,
                pause_ms,
            } => {
                for ch in line_text(tag, n, chars).chars() {
                    key(keyboard, ch.encode_utf8(&mut [0; 4]));
                    std::thread::sleep(Duration::from_millis(30));
                }
                std::thread::sleep(Duration::from_millis(left_ms));
                enter(keyboard);
                pause(pause_ms);
            }
            Habit::EnterThen { byte, every_ms } => {
                {
                    let mut did = did.lock().unwrap();
                    did.enters += 1;
                    did.controls.push(byte);
                }
                send(keyboard, &[b'\r', byte]);
                pause(every_ms);
            }
            Habit::Enter { every_ms } => {
                enter(keyboard);
                pause(every_ms);
            }
            Habit::Resize { every_ms } => {
                const SIZES: [(u16, u16); 5] =
                    [(120, 30), (100, 24), (80, 20), (60, 15), (110, 28)];
                let (cols, rows) = SIZES[n % SIZES.len()];
                match keyboard {
                    Keyboard::Attach(term) => term.resize(cols, rows),
                    Keyboard::Editor(rpc, _, watch) => {
                        let _ = rpc.notify(
                            "call",
                            json!({ "op": "attach.resize", "args": {
                                "watch": watch, "size": { "cols": cols, "rows": rows },
                            } }),
                        );
                    }
                    Keyboard::Raw(..) => {}
                }
                did.lock().unwrap().others += 1;
                pause(every_ms);
            }
            Habit::Reattach { every_ms } => {
                pause(every_ms);
                if let Keyboard::Attach(term) = keyboard {
                    term.send(b"\x1d");
                    let _ = term.wait_exit(Duration::from_secs(5));
                    **term = reopen.open();
                    did.lock().unwrap().others += 1;
                    std::thread::sleep(Duration::from_millis(every_ms));
                }
            }
            Habit::Modifiers { hz } => {
                // Shift, then Ctrl, then Alt, down and up, as win32-input-mode reports them.
                let bytes = match n % 6 {
                    0 => "\x1b[16;42;0;1;16;1_",
                    1 => "\x1b[16;42;0;0;0;1_",
                    2 => "\x1b[17;29;0;1;8;1_",
                    3 => "\x1b[17;29;0;0;0;1_",
                    4 => "\x1b[18;56;0;1;2;1_",
                    _ => "\x1b[18;56;0;0;0;1_",
                };
                other(keyboard, bytes.as_bytes());
                pause(1000 / u64::from(hz));
            }
            Habit::Ime { pause_ms } => {
                for part in [
                    &format!("{tag}-{n:04} "),
                    "输入法一次",
                    "上屏好几个字",
                    "，人在打",
                ] {
                    key(keyboard, part);
                    std::thread::sleep(Duration::from_millis(250));
                }
                enter(keyboard);
                pause(pause_ms);
            }
            Habit::Keys { hz } => {
                let bytes: &[u8] = match n % 8 {
                    0 => b"\x1b[A",
                    1 => b"\x1b[B",
                    2 => b"\x1b[C",
                    3 => b"\x1b[D",
                    4 => b"\t",
                    5 => b"\x1b",
                    6 => b"\x1b[H",
                    _ => b"\x1b[F",
                };
                if bytes.len() == 1 {
                    did.lock().unwrap().controls.push(bytes[0]);
                }
                other(keyboard, bytes);
                pause(1000 / u64::from(hz));
            }
            Habit::Backspace { hz } => {
                did.lock().unwrap().controls.push(0x7f);
                other(keyboard, b"\x7f");
                pause(1000 / u64::from(hz));
            }
            Habit::Menu { open_ms, pause_ms } => {
                let line = format!("/fake menu {tag}-{n:04}?");
                key(keyboard, &line);
                std::thread::sleep(Duration::from_millis(400));
                enter(keyboard);
                std::thread::sleep(Duration::from_millis(open_ms));
                {
                    let mut did = did.lock().unwrap();
                    did.answers.push(now_us());
                    did.enters += 1;
                }
                send(keyboard, b"\r");
                pause(pause_ms);
            }
            Habit::Records {
                hold_ms,
                chars,
                pause_ms,
            } => {
                let hold = Duration::from_millis(hold_ms);
                for ch in line_text(tag, n, chars).chars() {
                    {
                        let mut did = did.lock().unwrap();
                        did.chars.push((ch, now_us()));
                        did.draft.push(ch);
                    }
                    send(keyboard, key_record(ch, true).as_bytes());
                    std::thread::sleep(hold);
                    other(keyboard, key_record(ch, false).as_bytes());
                }
                {
                    let mut did = did.lock().unwrap();
                    did.enters += 1;
                    let line = std::mem::take(&mut did.draft);
                    did.lines.push(line);
                }
                send(keyboard, key_record('\r', true).as_bytes());
                std::thread::sleep(hold);
                other(keyboard, key_record('\r', false).as_bytes());
                pause(pause_ms);
            }
        }
    }
    // Keys still on their way reach the CLI before the window closes.
    std::thread::sleep(Duration::from_millis(300));
}
