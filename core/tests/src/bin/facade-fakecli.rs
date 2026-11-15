//! A test CLI with an input box, typing, bracketed paste, and submission on Enter. Long pastes
//! appear as placeholders. Each submitted message shows above the input, its first line after `> `
//! and the rest indented, and is logged so tests can check what arrived.
//!
//! Environment: `FAKECLI_LOG` sets the JSON-lines log path; `FAKECLI_SYNC=0` disables synchronized
//! drawing; `FAKECLI_NAME` sets the header name; `FAKECLI_FDS` names a file to which it writes, at
//! start, the descriptors above 2 it was given; `FAKECLI_ARGS` names a file to which it writes, at
//! start, its arguments as a JSON list; `FAKECLI_IGNORE_INPUT=1` makes it read no input at all, so
//! its terminal's input fills up; `FAKECLI_IGNORE_ENTER=1` makes it keep its draft on Enter, as a
//! CLI does that does not take it.
//!
//! Sessions: `--resume <id>` selects session `<id>`, as `FAKECLI_SESSION=<id>` does for a new
//! start. `FAKECLI_SESSION_HOOK` is the shell command of its session-start hook, which it runs with
//! the selected session at start and for each message `/session <id>` (`/session none` selects
//! none), waiting for each hook to end before going on, as a CLI runs its hooks. The screen shows
//! `session <id>` for each. `FAKECLI_FIRST_HOOK_DELAY_MS` delays the first hook's command by that
//! many milliseconds. With `FAKECLI_TRANSCRIPTS`, a folder, the hook names `<folder>/<id>.jsonl` as
//! the file the session is saved in, which it writes once the session takes its first message, as a
//! CLI saves a session.
//!
//! Status: `FAKECLI_STATUS=1` makes it report what it is doing over OSC 7501, as a CLI does. It
//! first asks whether its terminal takes reports and shows `status reports taken` once answered,
//! then reports idle once it is ready, after `FAKECLI_STATUS_DELAY_MS`. Each message it takes is a
//! turn of `FAKECLI_TURN_MS` (400 by default), working, then idle. A message starting with `/fake`
//! drives the rest: `/fake block <kind> <words>` waits for the person (`permission`, `question`, or
//! `auth`) and `/fake error <words>` reports an error, each until the next message; `/fake clear`
//! takes its report back; `/fake exit <code>` ends it with that code. `/fake menu <question>` asks
//! from its screen, as a CLI's permission question does: the question and a menu in place of its
//! input, the cursor hidden, until Enter or Escape.
//!
//! Tools: `FAKECLI_MCP` names an MCP server it runs, as a CLI given Facade's tools does: with its
//! own environment, starting the server's MCP session at once and holding it until it ends.
//! `/fake mcp stop` ends the server while the CLI goes on. `FAKECLI_MCP_DELAY_MS` starts it that
//! long after the CLI's start, as a server that starts slowly does.
//!
//! `FAKECLI_LOOK=agy` draws Antigravity's screen as 1.4.12 does: its input frame between two rules
//! after `> `, and its `/mcp` panel. As Antigravity does, it starts the server of the plugin in its
//! folder's `.agents/plugins/facade/` only from that panel, which shows the server ready once
//! started and closes on Escape, and it runs the plugin's `PreInvocation` hook as each message it
//! takes begins a turn, logging what the hook gives the model. The panel shows the server ready
//! once it answered the start of its MCP session, and a turn that begins before that is logged as
//! `turn without Facade's server`. `FAKECLI_PANEL_DELAY_MS` starts the server that long after the
//! panel opens, as a server that starts slowly does.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime};

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

enum InputSegment {
    Text(String),
    Paste { number: usize, text: String },
}

/// The session-start hook the fake CLI was given, if any.
struct SessionHook {
    command: String,
    /// The delay before the first hook's command, which then becomes zero.
    first_delay: Duration,
    /// The folder the sessions are saved in, where the hook names their files.
    transcripts: Option<std::path::PathBuf>,
}

impl SessionHook {
    /// The file session `id` is saved in, where sessions are saved.
    fn transcript(&self, id: &str) -> Option<std::path::PathBuf> {
        Some(self.transcripts.as_ref()?.join(format!("{id}.jsonl")))
    }

    /// Runs the hook for session `id`, or for none, and waits for it to end.
    fn report(&mut self, id: Option<&str>, source: &str) {
        let mut input = serde_json::json!({
            "hook_event_name": "SessionStart", "session_id": id, "source": source,
        });
        if let Some(transcript) = id.and_then(|id| self.transcript(id)) {
            input["transcript_path"] = serde_json::json!(transcript);
        }
        let input = input.to_string();
        let delay = std::mem::take(&mut self.first_delay);
        let command = if delay.is_zero() {
            self.command.clone()
        } else {
            format!("sleep {}; {}", delay.as_secs_f64(), self.command)
        };
        let child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(input.as_bytes());
            }
            let _ = child.wait();
        }
    }
}

/// What the fake CLI reports of itself, where it reports.
struct Status {
    /// When it is ready and reports idle the first time.
    ready_at: Option<Instant>,
    /// How long a turn runs.
    turn: Duration,
    /// When the turn running now ends.
    turn_ends: Option<Instant>,
    /// Reports to write before the next frame.
    reports: Vec<String>,
}

/// One OSC 7501 report: its state, what it waits for, and its words in base64.
fn report(state: &str, kind: Option<&str>, words: Option<&str>) -> String {
    let mut body = format!("state={state}");
    if let Some(kind) = kind {
        body.push_str(&format!(":kind={kind}"));
    }
    if let Some(words) = words.filter(|words| !words.is_empty()) {
        body.push_str(&format!(":msg={}", base64(words.as_bytes())));
    }
    format!("\x1b]7501;{body}\x1b\\")
}

/// Standard base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (at, byte)| {
            n | (u32::from(*byte) << (16 - 8 * at))
        });
        for at in 0..4 {
            out.push(if at <= chunk.len() {
                DIGITS[((n >> (18 - 6 * at)) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

struct FakeCli {
    transcript: Vec<String>,
    draft: Vec<InputSegment>,
    pastes: usize,
    log: Option<std::fs::File>,
    sync: bool,
    name: String,
    hook: Option<SessionHook>,
    status: Option<Status>,
    /// The code a `/fake exit` asked to end with.
    exit: Option<i32>,
    /// The MCP server it runs, until `/fake mcp stop`.
    server: Option<std::process::Child>,
    /// The session selected.
    session: Option<String>,
    /// It draws Antigravity's screen and takes its plugin.
    agy: bool,
    /// Antigravity's MCP panel shows.
    panel: bool,
    /// The question `/fake menu` asks in place of the input, until Enter or Escape.
    menu: Option<String>,
    /// The menu hid the cursor, which the next frame of the input shows again.
    cursor_hidden: bool,
    /// When the panel starts the plugin's server: `FAKECLI_PANEL_DELAY_MS` after it opened.
    server_due: Option<Instant>,
    /// `FAKECLI_MCP`'s server and when it starts, where `FAKECLI_MCP_DELAY_MS` delays it.
    delayed_server: Option<(std::ffi::OsString, Instant)>,
    /// The server answered the start of its MCP session.
    server_answered: Arc<AtomicBool>,
    /// The panel was last drawn with the server ready.
    panel_drawn_ready: bool,
    /// A first frame was drawn.
    drawn: bool,
}

impl FakeCli {
    /// Selects session `id`, or none, shows it, and reports it through the session-start hook.
    fn select_session(&mut self, id: Option<&str>, source: &str) {
        self.transcript
            .push(format!("session {}", id.unwrap_or("none")));
        self.session = id.map(str::to_string);
        if let Some(hook) = self.hook.as_mut() {
            hook.report(id, source);
        }
    }

    /// Saves the selected session's message `text` in its file, where sessions are saved.
    fn save(&self, text: &str) {
        let file = self
            .session
            .as_deref()
            .zip(self.hook.as_ref())
            .and_then(|(id, hook)| hook.transcript(id));
        if let Some(mut file) = file.and_then(|file| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)
                .ok()
        }) {
            let _ = writeln!(file, "{}", serde_json::json!({ "message": text }));
        }
    }

    fn draft_text(&self) -> String {
        self.draft
            .iter()
            .map(|piece| match piece {
                InputSegment::Text(text) => text.clone(),
                InputSegment::Paste { text, .. } => text.clone(),
            })
            .collect()
    }

    fn displayed_draft(&self) -> String {
        self.draft
            .iter()
            .map(|piece| match piece {
                InputSegment::Text(text) => text.clone(),
                InputSegment::Paste { number, text } => {
                    // Antigravity counts a paste's lines; this CLI's own look, those after the
                    // first.
                    let lines = text.split('\n').count();
                    format!(
                        "[Pasted text #{number} +{} lines]",
                        if self.agy { lines } else { lines - 1 }
                    )
                }
            })
            .collect()
    }

    fn push_text(&mut self, text: &str) {
        match self.draft.last_mut() {
            Some(InputSegment::Text(last)) => last.push_str(text),
            _ => self.draft.push(InputSegment::Text(text.to_string())),
        }
    }

    fn paste(&mut self, text: String) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if text.contains('\n') || text.len() > 400 {
            self.pastes += 1;
            self.draft.push(InputSegment::Paste {
                number: self.pastes,
                text,
            });
        } else {
            self.push_text(&text);
        }
    }

    fn backspace(&mut self) {
        match self.draft.last_mut() {
            Some(InputSegment::Text(text)) => {
                text.pop();
                if text.is_empty() {
                    self.draft.pop();
                }
            }
            Some(InputSegment::Paste { .. }) => {
                self.draft.pop();
            }
            None => {}
        }
    }

    fn submit(&mut self) {
        let text = self.draft_text();
        self.draft.clear();
        if text.trim().is_empty() {
            return;
        }
        let mut lines = text.lines();
        let first = lines.next().unwrap_or_default();
        self.transcript.push(format!("> {first}"));
        self.transcript
            .extend(lines.map(|line| format!("  {line}")));
        match first.strip_prefix("/session ") {
            Some(id) => {
                let id = id.trim().to_string();
                self.select_session(Some(id.as_str()).filter(|id| *id != "none"), "clear");
            }
            None => self.save(&text),
        }
        if let Some(log) = self.log.as_mut() {
            let at = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            // Append each log line in one write so concurrent fake CLIs cannot interleave line
            // fragments.
            let _ = log.write_all(format!("{}\n", encode_log_entry(at, &text)).as_bytes());
        }
        if self.agy {
            if first.trim() == "/mcp" {
                self.open_panel();
                return;
            }
            if !self.server_ready() {
                self.log_line("turn without Facade's server");
            }
            self.run_plugin_hook();
        }
        if let Some(question) = first.trim().strip_prefix("/fake menu ") {
            self.menu = Some(question.to_string());
            return;
        }
        if first.trim() == "/fake mcp stop"
            && let Some(mut server) = self.server.take()
        {
            let _ = server.kill();
            let _ = server.wait();
            self.transcript.push("mcp server stopped".into());
        }
        let Some(status) = self.status.as_mut() else {
            return;
        };
        let mut words = first.trim().splitn(4, ' ');
        match (words.next(), words.next(), words.next(), words.next()) {
            (Some("/fake"), Some("block"), Some(kind), rest) => {
                status.reports.push(report("blocked", Some(kind), rest))
            }
            (Some("/fake"), Some("error"), first, rest) => {
                let words: Vec<&str> = [first, rest].into_iter().flatten().collect();
                status
                    .reports
                    .push(report("error", None, Some(&words.join(" "))));
            }
            (Some("/fake"), Some("clear"), _, _) => {
                status.reports.push(report("clear", None, None))
            }
            (Some("/fake"), Some("exit"), code, _) => {
                self.exit = Some(code.and_then(|code| code.parse().ok()).unwrap_or(0))
            }
            _ => {
                status.reports.push(report("working", None, None));
                status.turn_ends = Some(Instant::now() + status.turn);
            }
        }
    }

    /// The plugin in this folder that Antigravity reads.
    fn plugin_file(name: &str) -> Option<serde_json::Value> {
        let text =
            std::fs::read_to_string(std::path::Path::new(".agents/plugins/facade").join(name))
                .ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Opens Antigravity's MCP panel, starting the plugin's server where it runs none yet.
    fn open_panel(&mut self) {
        self.panel = true;
        if self.server.is_none() {
            let delay = std::env::var("FAKECLI_PANEL_DELAY_MS")
                .ok()
                .and_then(|ms| ms.parse().ok())
                .unwrap_or(0);
            self.server_due = Some(Instant::now() + Duration::from_millis(delay));
            self.start_plugin_server();
        }
    }

    /// Starts `FAKECLI_MCP`'s server once its delay is over.
    fn start_delayed_server(&mut self) {
        if let Some((program, _)) = self
            .delayed_server
            .take_if(|(_, due)| *due <= Instant::now())
        {
            self.server = start_server(&program, &[], self.server_answered.clone()).ok();
        }
    }

    /// Starts the plugin's server once the panel's wait for it is over. Returns whether it started.
    fn start_plugin_server(&mut self) -> bool {
        if self.server.is_some() || !self.server_due.is_some_and(|due| due <= Instant::now()) {
            return false;
        }
        self.server_due = None;
        let entry = FakeCli::plugin_file("mcp_config.json")
            .map(|config| config["mcpServers"]["facade"].clone());
        let command = entry.as_ref().and_then(|entry| {
            let command = entry["command"].as_str()?.to_string();
            let args: Vec<String> = entry["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|arg| arg.as_str().map(str::to_string))
                .collect();
            Some((command, args))
        });
        self.server = command.and_then(|(command, args)| {
            start_server(
                std::ffi::OsStr::new(&command),
                &args,
                self.server_answered.clone(),
            )
            .ok()
        });
        self.server.is_some()
    }

    /// The plugin's server runs and answered the start of its MCP session, as Antigravity's panel
    /// shows a server ready.
    fn server_ready(&self) -> bool {
        self.server.is_some() && self.server_answered.load(Ordering::SeqCst)
    }

    /// Runs the plugin's `PreInvocation` hooks with the hook's input, `{}`, and logs what each
    /// gives the model.
    fn run_plugin_hook(&mut self) {
        let Some(hooks) = FakeCli::plugin_file("hooks.json") else {
            return;
        };
        for hook in hooks["facade"]["PreInvocation"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(command) = hook["command"].as_str() else {
                continue;
            };
            let ran = std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn();
            let Ok(mut child) = ran else { continue };
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(b"{}");
            }
            let given = child
                .wait_with_output()
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default();
            self.log_line(&format!("PreInvocation {given}"));
        }
    }

    /// Adds `text` to its log, as it logs each message it takes.
    fn log_line(&mut self, text: &str) {
        if let Some(log) = self.log.as_mut() {
            let at = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = log.write_all(format!("{}\n", encode_log_entry(at, text)).as_bytes());
        }
    }

    /// Reports idle once it is ready and once each turn ends. Returns whether it reported.
    fn tick(&mut self) -> bool {
        let Some(status) = self.status.as_mut() else {
            return false;
        };
        let now = Instant::now();
        let ready = status.ready_at.is_some_and(|at| at <= now);
        let turn_ended = status.turn_ends.is_some_and(|at| at <= now);
        if ready {
            status.ready_at = None;
        }
        if turn_ended {
            status.turn_ends = None;
        }
        // A turn that began before it was ready reports for itself.
        if (ready && status.turn_ends.is_none()) || turn_ended {
            status.reports.push(report("idle", None, None));
            return true;
        }
        false
    }

    fn draw(&mut self, out: &mut impl Write) {
        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
        let (cols, rows) = (cols as usize, rows as usize);
        let mut frame = String::new();
        if let Some(status) = self.status.as_mut() {
            frame.extend(status.reports.drain(..));
        }
        if self.sync {
            frame.push_str("\x1b[?2026h");
        }
        // The first frame clears with ED 2, which a terminal such as Facade's moves up into its
        // scrollback, as a CLI started below earlier output pushes it up. Later frames erase below
        // the top-left corner instead: a real CLI's redraws leave no copy of themselves in the
        // scrollback.
        frame.push_str(if std::mem::replace(&mut self.drawn, true) {
            "\x1b[H\x1b[J"
        } else {
            "\x1b[H\x1b[2J"
        });
        if self.panel {
            self.panel_drawn_ready = self.server_ready();
            let server = if self.panel_drawn_ready {
                ">  ✓ facade_facade  Tools: list_agents"
            } else {
                ">  ⋯ facade_facade"
            };
            frame.push_str(&format!(
                "MCP Servers\r\n\r\n{server}\r\n\r\nesc Exit\x1b[3;1H"
            ));
            if self.sync {
                frame.push_str("\x1b[?2026l");
            }
            let _ = out.write_all(frame.as_bytes());
            let _ = out.flush();
            return;
        }
        frame.push_str(&format!(
            "\x1b[1m{}\x1b[0m \x1b[2m(Facade test CLI)\x1b[0m\r\n",
            self.name
        ));
        let room = rows.saturating_sub(6);
        let start = self.transcript.len().saturating_sub(room);
        for line in &self.transcript[start..] {
            frame.push_str(&truncate_chars(line, cols));
            frame.push_str("\r\n");
        }
        let input_row = rows.saturating_sub(3);
        if let Some(question) = self.menu.as_ref() {
            // A question and its menu, Antigravity's under its look, where the input was; no
            // cursor, as no input shows.
            let (selected, other, hint) = if self.agy {
                (" > Yes", "   No", "   ↑/↓ Navigate · Enter to select")
            } else {
                ("❯ 1. Yes", "  2. No", "  Enter to select")
            };
            for (at, line) in [
                truncate_chars(question, cols).as_str(),
                selected,
                other,
                hint,
            ]
            .into_iter()
            .enumerate()
            {
                frame.push_str(&format!(
                    "\x1b[{};1H{line}",
                    input_row.saturating_sub(1) + at
                ));
            }
            frame.push_str("\x1b[?25l");
            self.cursor_hidden = true;
            if self.sync {
                frame.push_str("\x1b[?2026l");
            }
            let _ = out.write_all(frame.as_bytes());
            let _ = out.flush();
            return;
        }
        if std::mem::take(&mut self.cursor_hidden) {
            frame.push_str("\x1b[?25h");
        }
        frame.push_str(&format!(
            "\x1b[{};1H\x1b[2m{}\x1b[0m",
            input_row,
            "─".repeat(cols)
        ));
        let shown = self.displayed_draft();
        let (prompt, footer) = if self.agy {
            (">", "? for shortcuts")
        } else {
            ("❯", "  Enter to send")
        };
        frame.push_str(&format!(
            "\x1b[{};1H{prompt} {}",
            input_row + 1,
            truncate_chars(&shown, cols.saturating_sub(2))
        ));
        frame.push_str(&format!(
            "\x1b[{};1H\x1b[2m{}\x1b[0m",
            input_row + 2,
            "─".repeat(cols)
        ));
        frame.push_str(&format!("\x1b[{};1H\x1b[2m{footer}\x1b[0m", input_row + 3));
        let cursor_col = 3 + shown.chars().count().min(cols.saturating_sub(3));
        frame.push_str(&format!("\x1b[{};{}H", input_row + 1, cursor_col));
        if self.sync {
            frame.push_str("\x1b[?2026l");
        }
        let _ = out.write_all(frame.as_bytes());
        let _ = out.flush();
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// A submitted message with its Unix timestamp in milliseconds.
fn encode_log_entry(at: u128, text: &str) -> String {
    serde_json::json!({ "at": at as u64, "text": text }).to_string()
}

/// The descriptors above 2 that are open, one number per line.
fn open_descriptors() -> String {
    // SAFETY: F_GETFD only reads the descriptor's flags; it fails with EBADF for a closed
    // descriptor.
    (3..1024)
        .filter(|&fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1)
        .map(|fd| format!("{fd}\n"))
        .collect()
}

fn main() -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if let Some(path) = std::env::var_os("FAKECLI_ZOMBIE_WORKER") {
        let path = std::path::PathBuf::from(path);
        let ready = path.with_extension("ready");
        std::thread::spawn(move || {
            while !path.exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        std::fs::write(ready, "")?;
        // SAFETY: SYS_exit ends only this thread, without unwinding; the worker owns everything it
        // still uses.
        unsafe {
            libc::syscall(libc::SYS_exit, 0);
        }
        unreachable!("SYS_exit does not return");
    }
    run()
}

/// Starts MCP server `program` and its MCP session, as a CLI does at its start: it initializes the
/// session and asks for the server's tools. `answered` is set once the server answers the session's
/// start; the rest of what it answers is read and dropped.
fn start_server(
    program: &std::ffi::OsStr,
    args: &[String],
    answered: Arc<AtomicBool>,
) -> anyhow::Result<std::process::Child> {
    use std::io::BufRead;
    use std::process::Stdio;
    let mut server = std::process::Command::new(program);
    server.args(args);
    let mut server = server
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let answers = server.stdout.take().expect("the server's output");
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(answers)
            .lines()
            .map_while(Result::ok)
        {
            if line.contains("\"id\":1") && line.contains("\"result\"") {
                answered.store(true, Ordering::SeqCst);
            }
        }
    });
    let session = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fakecli","version":"1"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        "\n"
    );
    server
        .stdin
        .as_mut()
        .expect("the server's input")
        .write_all(session.as_bytes())?;
    Ok(server)
}

fn run() -> anyhow::Result<()> {
    if let Some(path) = std::env::var_os("FAKECLI_STARTS") {
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
            "{}",
            std::process::id()
        )?;
    }
    if let Some(path) = std::env::var_os("FAKECLI_FDS") {
        // Before this program opens anything itself.
        std::fs::write(path, open_descriptors())?;
    }
    if let Some(path) = std::env::var_os("FAKECLI_ARGS") {
        write_whole(
            std::path::Path::new(&path),
            &serde_json::to_string(
                &std::env::args_os()
                    .skip(1)
                    .map(|word| word.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            )?,
        )?;
    }
    let log = std::env::var_os("FAKECLI_LOG").and_then(|path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    });
    let sync = std::env::var("FAKECLI_SYNC")
        .map(|v| v != "0")
        .unwrap_or(true);
    let name = std::env::var("FAKECLI_NAME").unwrap_or_else(|_| "fakecli".into());
    let hook = std::env::var("FAKECLI_SESSION_HOOK")
        .ok()
        .map(|command| SessionHook {
            command,
            first_delay: Duration::from_millis(
                std::env::var("FAKECLI_FIRST_HOOK_DELAY_MS")
                    .ok()
                    .and_then(|delay| delay.parse().ok())
                    .unwrap_or(0),
            ),
            transcripts: std::env::var_os("FAKECLI_TRANSCRIPTS").map(std::path::PathBuf::from),
        });
    let milliseconds = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map(Duration::from_millis)
    };
    let status = std::env::var("FAKECLI_STATUS")
        .is_ok_and(|v| v == "1")
        .then(|| Status {
            ready_at: Some(
                Instant::now() + milliseconds("FAKECLI_STATUS_DELAY_MS").unwrap_or_default(),
            ),
            turn: milliseconds("FAKECLI_TURN_MS").unwrap_or(Duration::from_millis(400)),
            turn_ends: None,
            reports: vec!["\x1b]7501;?\x1b\\".into()],
        });
    let server_answered = Arc::new(AtomicBool::new(false));
    let delay = Duration::from_millis(
        std::env::var("FAKECLI_MCP_DELAY_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .unwrap_or(0),
    );
    let (server, delayed_server) = match std::env::var_os("FAKECLI_MCP") {
        Some(program) if delay.is_zero() => (
            Some(start_server(&program, &[], server_answered.clone())?),
            None,
        ),
        Some(program) => (None, Some((program, Instant::now() + delay))),
        None => (None, None),
    };
    let agy = std::env::var("FAKECLI_LOOK").is_ok_and(|look| look == "agy");
    let mut app = FakeCli {
        transcript: Vec::new(),
        draft: Vec::new(),
        pastes: 0,
        log,
        sync,
        name,
        hook,
        status,
        exit: None,
        server,
        session: None,
        agy,
        panel: false,
        menu: None,
        cursor_hidden: false,
        server_due: None,
        delayed_server,
        server_answered,
        panel_drawn_ready: false,
        drawn: false,
    };
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|word| word.to_string_lossy().into_owned())
        .collect();
    let resumed = arguments
        .iter()
        .position(|arg| arg == "--resume")
        .and_then(|at| arguments.get(at + 1))
        .cloned();
    match (resumed, std::env::var("FAKECLI_SESSION").ok()) {
        (Some(id), _) => app.select_session(Some(&id), "resume"),
        (None, Some(id)) => app.select_session(Some(&id), "startup"),
        (None, None) => {}
    }

    crossterm::terminal::enable_raw_mode()?;
    let mut out = std::io::stdout();
    let _ = out.write_all(b"\x1b[?2004h");
    app.draw(&mut out);

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reads_input = std::env::var("FAKECLI_IGNORE_INPUT").is_err();
    let takes_enter = std::env::var("FAKECLI_IGNORE_ENTER").is_err();
    std::thread::spawn(move || {
        if !reads_input {
            // Hold the channel open without reading, so the CLI keeps running.
            let _tx = tx;
            loop {
                std::thread::park();
            }
        }
        let mut stdin = std::io::stdin();
        let mut buffer = [0u8; 8192];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut pending: Vec<u8> = Vec::new();
    let mut pasting: Option<Vec<u8>> = None;
    let mut last_size = crossterm::terminal::size().unwrap_or((80, 24));
    loop {
        let mut dirty = false;
        // Nothing came for a while: an Escape that may begin a paste's start is the key alone, as a
        // terminal reads it.
        let mut quiet = false;
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) => {
                pending.extend(bytes);
                dirty = true;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => quiet = true,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let mut i = 0;
        while i < pending.len() {
            if let Some(paste) = pasting.as_mut() {
                if pending[i..].starts_with(PASTE_END) {
                    let text = String::from_utf8_lossy(paste).into_owned();
                    pasting = None;
                    app.paste(text);
                    i += PASTE_END.len();
                } else if PASTE_END.starts_with(&pending[i..]) {
                    break;
                } else {
                    paste.push(pending[i]);
                    i += 1;
                }
                continue;
            }
            if pending[i..].starts_with(PASTE_START) {
                pasting = Some(Vec::new());
                i += PASTE_START.len();
                continue;
            }
            if pending[i] == 0x1b
                && PASTE_START.starts_with(&pending[i..])
                && !(quiet && pending.len() == i + 1)
            {
                break;
            }
            match pending[i] {
                b'\r' | b'\n' | 0x1b
                    if app.menu.is_some()
                        && !(pending[i] == 0x1b
                            && matches!(pending.get(i + 1), Some(b'[' | b'O'))) =>
                {
                    app.menu = None;
                    dirty = true;
                }
                b'\r' | b'\n' if takes_enter => app.submit(),
                0x7f | 0x08 => app.backspace(),
                0x03 => app.draft.clear(),
                0x04 if app.draft.is_empty() => {
                    crossterm::terminal::disable_raw_mode()?;
                    return Ok(());
                }
                0x1b if pending.get(i + 1) == Some(&b']') => {
                    // A terminal's answer: skip it whole, once it is complete.
                    let rest = &pending[i + 2..];
                    let Some(end) = rest.iter().position(|&byte| byte == 0x07 || byte == 0x1b)
                    else {
                        break;
                    };
                    if rest[end] == 0x1b && rest.get(end + 1).is_none() {
                        break;
                    }
                    if rest.starts_with(b"7501;?") {
                        app.transcript.push("status reports taken".into());
                    }
                    i += 2 + end + if rest[end] == 0x1b { 2 } else { 1 };
                    continue;
                }
                0x1b if app.panel && !matches!(pending.get(i + 1), Some(b'[' | b'O')) => {
                    app.panel = false;
                    dirty = true;
                }
                0x1b => {
                    // Skip the complete key escape sequence.
                    let mut j = i + 1;
                    if j < pending.len() && (pending[j] == b'[' || pending[j] == b'O') {
                        j += 1;
                        while j < pending.len() && !(0x40..=0x7e).contains(&pending[j]) {
                            j += 1;
                        }
                    }
                    i = j.min(pending.len().saturating_sub(1));
                }
                byte if byte >= 0x20 => {
                    let start = i;
                    let mut end = i + 1;
                    while end < pending.len() && pending[end] >= 0x20 && pending[end] != 0x7f {
                        end += 1;
                    }
                    app.push_text(&String::from_utf8_lossy(&pending[start..end]));
                    i = end;
                    continue;
                }
                _ => {}
            }
            i += 1;
        }
        pending.drain(..i);
        if let Some(code) = app.exit {
            crossterm::terminal::disable_raw_mode()?;
            std::process::exit(code);
        }
        dirty |= app.tick();
        app.start_delayed_server();
        dirty |= app.start_plugin_server();
        // The panel shows the server ready once it answered.
        dirty |= app.panel && app.server_ready() != app.panel_drawn_ready;
        let size = crossterm::terminal::size().unwrap_or(last_size);
        if size != last_size {
            last_size = size;
            dirty = true;
        }
        if dirty
            || app
                .status
                .as_ref()
                .is_some_and(|status| !status.reports.is_empty())
        {
            app.draw(&mut out);
        }
    }
    crossterm::terminal::disable_raw_mode()?;
    Ok(())
}

/// Writes `text` to `file` whole: to a file beside it, which then takes its name, so that a test
/// that reads it once it is there finds all of it.
fn write_whole(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    let mut partial = file.as_os_str().to_owned();
    partial.push(".partial");
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, file)
}

#[cfg(test)]
mod tests {
    /// The file is replaced whole, never written in place: a reader that opened it before still
    /// reads what was there.
    #[test]
    fn a_file_written_whole_is_replaced_never_written_in_place() {
        let folder = std::env::temp_dir().join(format!("fakecli-whole-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("x.args");
        std::fs::write(&file, "before").unwrap();
        let mut opened = std::fs::File::open(&file).unwrap();
        super::write_whole(&file, "after").unwrap();
        let mut kept = String::new();
        std::io::Read::read_to_string(&mut opened, &mut kept).unwrap();
        assert_eq!(
            (
                kept.as_str(),
                std::fs::read_to_string(&file).unwrap().as_str()
            ),
            ("before", "after")
        );
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
