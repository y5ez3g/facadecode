//! A test CLI with an input box, typing, bracketed paste, and submission on Enter. Long pastes
//! appear as placeholders. Each submitted message shows above the input, its first line after `> `
//! and the rest indented, and is logged so tests can check what arrived.
//!
//! Environment: `FAKECLI_LOG` sets the JSON-lines log path; `FAKECLI_SYNC=0` disables synchronized
//! drawing; `FAKECLI_NAME` sets the header name; `FAKECLI_FDS` names a file to which it writes, at
//! start, the descriptors above 2 it was given; `FAKECLI_ARGS` names a file to which it writes, at
//! start, its arguments as a JSON list; `FAKECLI_ENV` names a JSON output file for the variables
//! listed in `FAKECLI_ENV_KEYS` (comma-separated); `FAKECLI_IGNORE_INPUT=1` makes it read no input, so
//! its terminal's input fills up; `FAKECLI_IGNORE_ENTER=1` makes it keep its draft on Enter, as a
//! CLI does that does not take it; `FAKECLI_IGNORE_FIRST_ENTER=1` skips only the first Enter.
//! `FAKECLI_HOOKS=1` makes it run hooks given as arguments
//! instead, as Antigravity runs them (`run_hooks`). On Windows `FAKECLI_IGNORE_CLOSE=<file>` makes
//! it hold its console's closing up and start a child outside the console, writing the child's
//! process ID to `<file>`. `FAKECLI_KEYLOG=<file>` notes when each read of input arrives and when
//! the frame it drew is written (`note_key_time`). `FAKECLI_READ_GATE=<file>` holds input reads
//! until the test creates the file.
//! `FAKECLI_UNANNOUNCED_PASTE=1` accepts bracketed paste without reporting the mode, as seen by
//! a daemon that lost that output in a crash.
//! `FAKECLI_COMPOSER_GATE=<file>` lets keys through while keeping the composer hidden until the test
//! creates the file. `FAKECLI_CURSOR_TRUST=1` shows Cursor's workspace question before its composer.
//! For the stress test, `--flood` writes a line every 10 milliseconds until the agent stops.
//! For the Attach exit test, `--attach-exit` waits for the exact line `finish` and exits with 23.
//!
//! Sessions: `--resume <id>` selects session `<id>`, as `FAKECLI_SESSION=<id>` does for a new
//! start. `FAKECLI_SESSION_HOOK` is the shell command of its session-start hook, which it runs with
//! the selected session at start and for each message `/session <id>` (`/session none` selects
//! none), waiting for each hook to end before going on, as a CLI runs its hooks. On Windows it runs
//! the hook as Muse Code does (`stand_in_shell`). The screen shows `session <id>` for each.
//! `FAKECLI_LOOK=claude` uses Claude Code's prompt gap and reads its SessionStart hook from `--settings` JSON.
//! `FAKECLI_FIRST_HOOK_DELAY_MS` delays the first hook's command by that many milliseconds. With `FAKECLI_TRANSCRIPTS`, a folder, the hook names `<folder>/<id>.jsonl` as
//! the file the session is saved in, which it writes once the session takes its first message, as a
//! CLI saves a session.
//! On Windows, a copy named `codex.exe` reads its SessionStart hooks from `-c hooks=...`, checks
//! their layer keys and trusted hashes, and runs trusted hooks through PowerShell, as Codex does
//! with its default session shell. A copy named `muse.exe` reads its SessionStart hooks from
//! Muse Code's `-c hooks=...` and runs them with the session in `MUSE_SESSION_ID` and without the
//! run's variables (`FACADE_HOME`, `FACADE_AGENT`), and resumes with `resume <id>`; one named
//! `agy.exe` runs the title command of its `--settings` with the conversation, as Antigravity's
//! status line does; both run each command as Muse Code 1.4.14 and Antigravity 1.5.10 do, as one
//! argument of `cmd.exe /C` quoted the standard way (`stand_in_shell`).
//!
//! Status: `FAKECLI_STATUS=1` makes it report what it is doing over OSC 7501, as a CLI does. It
//! first asks whether its terminal takes reports and shows `status reports taken` once answered,
//! then reports idle once it is ready, after `FAKECLI_STATUS_DELAY_MS`. Each message it takes is a
//! turn of `FAKECLI_TURN_MS` (400 by default), working, then idle. `FAKECLI_PROGRESS=1` also emits
//! native progress for each turn. A message starting with `/fake`
//! drives the rest: `/fake block <kind> <words>` waits for the person (`permission`, `question`, or
//! `auth`) and `/fake error <words>` reports an error, each until the next message; `/fake clear`
//! takes its report back; `/fake status <state> [<words>]` reports `<state>`, such as `done`, with
//! those words, and ends the turn; `/fake exit <code>` ends it with that code. `/fake menu <question>` asks
//! from its screen, as a CLI's permission question does: the question and a menu in place of its
//! input, the cursor hidden, until Enter or Escape.
//!
//! Title: `FAKECLI_TITLE=<text>` sets its terminal's title before its first frame, as OpenCode
//! does, and a message `/fake title <text>` sets another; `/fake title` alone sets an empty title.
//! On Windows `FAKECLI_TITLE_FROM_CONSOLE=1` makes it set back its console's title, read with
//! `GetConsoleTitleW`, at start and with each message, as Antigravity does.
//! With status reporting enabled, it sends its first idle report with a query and, once the
//! terminal answers it, sets `<text>` and shows `negotiated title`. `FAKECLI_OWN_GLYPH=<glyph>`
//! makes its initial title `<glyph> <text>`, as Claude Code does run alone.
//!
//! `FAKECLI_LOOK=muse` shows a long paste as Muse 1.4.20 does, `[Pasted Content <n> chars]`.
//! `FAKECLI_CODEX_INPUT=working` draws a Codex input, accepts Tab as submission,
//! and reports Working before the first prompt arrives. On Windows `FAKECLI_CONSOLE_KEYS=1` makes it
//! read its keys as a console gives them, as Codex does there, not as terminal sequences: it knows no
//! paste, its Enter submits, Shift+Enter breaks the line, and it shows a draft of more lines than one
//! as a placeholder for its characters.
//!
//! Hints: `FAKECLI_HINT=<text>` draws `<text>` in color where an empty input starts, the cursor
//! before it, as Muse 1.4.20 draws a hint once a turn has ended: not until `FAKECLI_TURN_MS`
//! after a message it takes; `FAKECLI_DRAFT_AT_START=<text>` starts with `<text>` as
//! a draft in color with the cursor before it, as a draft the person moved the cursor back over;
//! what is typed goes in before it. `FAKECLI_KEYS=<file>` appends every byte it reads to `<file>`.
//! `FAKECLI_SCREEN_FILE=<file>` prints the file's lines before drawing its input. `/fake screen`
//! reads the same file again and sends its terminal sequences before the next draw.
//! `FAKECLI_SIZE_LOG=<file>` records the terminal grid measured in the process, at start and on resize.
//! `FAKECLI_WRAP_TRANSCRIPT=1` writes full transcript lines so the terminal wraps them.
//! `FAKECLI_IGNORE_KEYS` lists keys it ignores, `space` and `backspace`, comma-separated;
//! `FAKECLI_NO_LEADING_SPACE=1` draws no space where its input starts; `FAKECLI_SPACE_SUGGESTS=<text>`
//! draws `<text>` on the row under the input while the input starts with a space, as a CLI that
//! suggests something. `FAKECLI_KIRO_SPACE_DELAY_MS` holds Kiro's empty frame for this long after
//! a Space key before drawing its echo.
//!
//! Colors: `/fake colors` asks its terminal for its foreground, background and cursor colors, as a
//! CLI that picks its colors by the background does: OSC 10 and 12 ended by BEL, OSC 11 by ST. Its
//! screen shows each answer as `color <number>;<color> <bel|st>`, ended as the answer was.
//!
//! Tools: `--mcp-config <file>` gives the CLI Facade's relay command, arguments and environment.
//! It starts the server's MCP session at once and holds it until it ends. Older test launches
//! supply the program through `FAKECLI_MCP`.
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
//!
//! `FAKECLI_LOOK` naming one of `Native` makes it stand in for that CLI: its input, the marks it
//! shows for long pastes, the server its run's own configuration names, its resume option, and the
//! session reports and files it makes, saved under `FAKECLI_TRANSCRIPTS` where it names its file.
//! It fails its start when that configuration is not what the CLI reads. `FAKECLI_MCP_INITIALIZE=<file>`
//! keeps the server's MCP initialize response. `FAKECLI_MCP_TAKEOVER=<folder>` records Devin's
//! relay PID and catalog and roster replies. Its `read-roster` and `read-catalog` files release the
//! corresponding requests on the same connection. `/mcp list` opens Cursor's MCP panel, which Escape closes.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use facade_scenarios::{
    Native, Reporter, mcp_command, option_value, save_cursor_session, save_kiro_session,
};

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

enum InputSegment {
    Text(String),
    Paste { number: usize, text: String },
}

/// The session-start hook the fake CLI was given, if any.
struct SessionHook {
    commands: Vec<String>,
    /// The CLI it stands in for, and how that CLI reports a session.
    native: Option<(Native, Reporter)>,
    #[cfg(windows)]
    stand_in: StandIn,
    /// The delay before the first hook's command, which then becomes zero.
    first_delay: Duration,
    /// The folder the sessions are saved in, where the hook names their files.
    transcripts: Option<std::path::PathBuf>,
}

impl SessionHook {
    /// The file session `id` is saved in, where sessions are saved.
    fn transcript(&self, id: &str) -> Option<std::path::PathBuf> {
        if let Some((native, _)) = &self.native
            && !native.names_its_file()
        {
            return None;
        }
        Some(self.transcripts.as_ref()?.join(format!("{id}.jsonl")))
    }

    /// Runs the hook for session `id`, or for none, and waits for it to end.
    fn report(&mut self, id: Option<&str>, source: &str) {
        if let Some((native, reporter)) = &self.native {
            let saved = id.and_then(|id| self.transcript(id));
            report_natively(*native, reporter, id, source, saved.as_deref());
            return;
        }
        let mut input = serde_json::json!({
            "hook_event_name": "SessionStart", "session_id": id, "source": source,
        });
        // Antigravity's title command is given the conversation shown, empty before there is one.
        #[cfg(windows)]
        if self.stand_in == StandIn::Agy {
            input = serde_json::json!({
                "product": "antigravity", "conversation_id": id.unwrap_or(""), "agent_state": "idle",
            });
        }
        if let Some(transcript) = id.and_then(|id| self.transcript(id)) {
            input["transcript_path"] = serde_json::json!(transcript);
        }
        let input = input.to_string();
        let delay = std::mem::take(&mut self.first_delay);
        // cmd.exe has no sleep: this waits before it starts the hook instead.
        #[cfg(windows)]
        std::thread::sleep(delay);
        for command in &self.commands {
            #[cfg(unix)]
            let command = if delay.is_zero() {
                command.clone()
            } else {
                format!("sleep {}; {command}", delay.as_secs_f64())
            };
            #[cfg(unix)]
            let mut shell = shell_command(&command);
            #[cfg(windows)]
            let mut shell = match self.stand_in {
                StandIn::Codex => {
                    let mut shell = std::process::Command::new(facade_scenarios::powershell());
                    shell.args(["-NoProfile", "-Command", command]);
                    shell
                }
                StandIn::Muse => {
                    let mut shell = stand_in_shell(command);
                    // Muse Code runs its hooks without the run's variables: those reach a hook
                    // only through its command.
                    shell.env_remove("FACADE_HOME").env_remove("FACADE_AGENT");
                    if let Some(id) = id {
                        shell.env("MUSE_SESSION_ID", id);
                    }
                    shell
                }
                StandIn::Agy | StandIn::None => stand_in_shell(command),
            };
            let child = shell
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
}

/// What the fake CLI reports of itself, where it reports.
struct Status {
    /// When it is ready and reports idle the first time.
    ready_at: Option<Instant>,
    /// How long a turn runs.
    turn: Duration,
    /// When the turn running now ends.
    turn_ends: Option<Instant>,
    /// Whether to emit the CLI's own OSC 9;4 progress with each turn.
    progress: bool,
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
    codex_input: bool,
    /// It reads its keys as a console gives them.
    console_keys: bool,
    transcript: Vec<String>,
    wrap_transcript: bool,
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
    /// It shows a long paste as Muse does.
    muse: bool,
    /// It draws the gap Claude Code uses after its prompt.
    claude: bool,
    /// The CLI it stands in for.
    native: Option<Native>,
    /// Oh My Pi's default band, unless the launch's explicit configuration selects Pi.
    omp_band: bool,
    /// It draws what its CLI shows with approvals off.
    yolo: bool,
    /// Antigravity's MCP panel shows.
    panel: bool,
    /// The question `/fake menu` asks in place of the input, until Enter or Escape.
    menu: Option<String>,
    /// The menu hid the cursor, which the next frame of the input shows again.
    cursor_hidden: bool,
    /// A test opens the composer by creating this file.
    composer_gate: Option<PathBuf>,
    /// Cursor's workspace question, and whether the person has answered it.
    cursor_trust: Option<bool>,
    /// When the panel starts the plugin's server: `FAKECLI_PANEL_DELAY_MS` after it opened.
    server_due: Option<Instant>,
    /// The configured server and when it starts, where `FAKECLI_MCP_DELAY_MS` delays it.
    delayed_server: Option<(Command, Instant)>,
    /// The server answered the start of its MCP session.
    server_answered: Arc<AtomicBool>,
    /// The panel was last drawn with the server ready.
    panel_drawn_ready: bool,
    /// A first frame was drawn.
    drawn: bool,
    /// The lines of `FAKECLI_SCREEN_FILE` printed before the first frame.
    printed: usize,
    /// Terminal queries the next frame sends, before it draws.
    queries: Vec<String>,
    /// `FAKECLI_OWN_GLYPH`: the title without its glyph, written once the terminal answers the query
    /// sent with the first idle report; and whether that query went out.
    title_after_answer: Option<(String, bool)>,
    /// `FAKECLI_HINT`: drawn in color where an empty input starts.
    hint: Option<String>,
    /// `FAKECLI_DRAFT_AT_START`: the draft after the cursor, drawn in color.
    after_cursor: String,
    /// `FAKECLI_NO_LEADING_SPACE`: spaces where the input starts are not drawn.
    no_leading_space: bool,
    /// `FAKECLI_SPACE_SUGGESTS`: drawn under the input while it starts with a space.
    space_suggests: Option<String>,
    /// When the hint shows again after a message it took: once the message's turn has ended.
    hint_after: Option<Instant>,
    kiro_space_delay: Duration,
    kiro_space_at: Option<Instant>,
}

impl FakeCli {
    /// Selects session `id`, or none, shows it, and reports it through the session-start hook.
    fn select_session(&mut self, id: Option<&str>, source: &str) {
        if self.native == Some(Native::Cursor)
            && source == "startup"
            && let (Some(id), Ok(user), Ok(cwd)) = (id, user_home(), std::env::current_dir())
        {
            save_cursor_session(&user, id, &cwd, None, false);
        }
        self.transcript
            .push(format!("session {}", id.unwrap_or("none")));
        self.session = id.map(str::to_string);
        if let Some(hook) = self.hook.as_mut() {
            hook.report(id, source);
        }
    }

    /// Saves the selected session's message `text` in its file, where sessions are saved.
    fn save(&self, text: &str) {
        if let (Some(native), Some(id), Ok(user), Ok(cwd)) = (
            self.native,
            self.session.as_deref(),
            user_home(),
            std::env::current_dir(),
        ) {
            match native {
                Native::Kiro => {
                    let arguments: Vec<String> = std::env::args_os()
                        .map(|word| word.to_string_lossy().into_owned())
                        .collect();
                    save_kiro_session(&user, id, &cwd, "", option_value(&arguments, "--agent"));
                }
                Native::Cursor => save_cursor_session(&user, id, &cwd, None, true),
                _ => {}
            }
        }
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
            let new = file.metadata().is_ok_and(|file| file.len() == 0);
            let cwd = std::env::current_dir().unwrap_or_default();
            let saved = match (self.native, self.session.as_deref()) {
                (Some(native), Some(id)) => native.saved(id, text, &cwd, new),
                _ => format!("{}\n", serde_json::json!({ "message": text })),
            };
            let _ = file.write_all(saved.as_bytes());
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
                InputSegment::Text(text) if self.console_keys && text.contains('\n') => {
                    format!("[Pasted Content {} chars]", text.chars().count())
                }
                InputSegment::Text(text) => text.clone(),
                InputSegment::Paste { number, text } if self.native.is_some() => self
                    .native
                    .and_then(|native| native.placeholder(*number, text))
                    .unwrap_or_else(|| text.clone()),
                InputSegment::Paste { text, .. } if self.muse || self.codex_input => {
                    format!("[Pasted Content {} chars]", text.chars().count())
                }
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
        let placeholder = match self.native {
            Some(native) => native.placeholder(self.pastes + 1, &text).is_some(),
            None => text.contains('\n') || text.len() > 400,
        };
        if placeholder {
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
        let text = self.draft_text() + &std::mem::take(&mut self.after_cursor);
        self.draft.clear();
        if self.hint.is_some() {
            let turn = std::env::var("FAKECLI_TURN_MS")
                .ok()
                .and_then(|ms| ms.parse().ok())
                .unwrap_or(400);
            self.hint_after = Some(Instant::now() + Duration::from_millis(turn));
        }
        if text.trim().is_empty() {
            return;
        }
        self.queries.extend(console_title_back());
        // Cursor's panel of MCP servers, which takes no turn.
        if self.native == Some(Native::Cursor) && text.trim() == "/mcp list" {
            self.panel = true;
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
        if let Some(title) = first
            .trim()
            .strip_prefix("/fake title")
            .filter(|rest| rest.is_empty() || rest.starts_with(' '))
        {
            self.queries
                .push(format!("\x1b]2;{}\x07", title.trim_start()));
            return;
        }
        if first.trim() == "/fake colors" {
            self.queries
                .extend(["\x1b]10;?\x07", "\x1b]11;?\x1b\\", "\x1b]12;?\x07"].map(String::from));
            return;
        }
        if first.trim() == "/fake screen" {
            if let Some(file) = std::env::var_os("FAKECLI_SCREEN_FILE")
                && let Ok(frame) = std::fs::read_to_string(file)
            {
                self.queries.push(frame);
            }
            return;
        }
        if first.trim() == "/fake cursor" {
            self.queries.push("\x1b[2;3H\x1b[6n".into());
            return;
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
            (Some("/fake"), Some("status"), Some(state), words) => {
                status.turn_ends = None;
                status.reports.push(report(state, None, words))
            }
            (Some("/fake"), Some("exit"), code, _) => {
                self.exit = Some(code.and_then(|code| code.parse().ok()).unwrap_or(0))
            }
            _ => {
                status.reports.push(report("working", None, None));
                if status.progress {
                    status.reports.push("\x1b]9;4;1;37\x07".into());
                }
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

    /// Starts the configured server once its delay is over.
    fn start_delayed_server(&mut self) {
        if let Some((command, _)) = self
            .delayed_server
            .take_if(|(_, due)| *due <= Instant::now())
        {
            self.server = start_server(command, self.server_answered.clone()).ok();
        }
    }

    /// Starts the plugin's server once the panel's wait for it is over. Returns whether it started.
    fn start_plugin_server(&mut self) -> bool {
        if self.server.is_some() || !self.server_due.is_some_and(|due| due <= Instant::now()) {
            return false;
        }
        self.server_due = None;
        self.server = FakeCli::plugin_file("mcp_config.json")
            .and_then(|config| command_from_config(&config).ok())
            .and_then(|command| start_server(command, self.server_answered.clone()).ok());
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
            let ran = shell_command(command)
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
        if self.kiro_space_at.is_some_and(|at| at <= Instant::now()) {
            self.kiro_space_at = None;
            self.push_text(" ");
            return true;
        }
        if self.hint_after.is_some_and(|at| at <= Instant::now()) {
            self.hint_after = None;
            return true;
        }
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
            if status.progress {
                status.reports.push("\x1b]9;4;0;37\x07".into());
            }
        }
        // A turn that began before it was ready reports for itself.
        if (ready && status.turn_ends.is_none()) || turn_ended {
            status.reports.push(report("idle", None, None));
            if let Some((_, asked @ false)) = self.title_after_answer.as_mut() {
                status.reports.push("\x1b]7501;?\x1b\\".into());
                *asked = true;
            }
            return true;
        }
        false
    }

    fn draw(&mut self, out: &mut impl Write) {
        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
        let (cols, rows) = (cols as usize, rows as usize);
        let mut frame: String = self.queries.drain(..).collect();
        if let Some(status) = self.status.as_mut() {
            frame.extend(status.reports.drain(..));
        }
        if self.sync {
            frame.push_str("\x1b[?2026h");
        }
        // The first frame scrolls what was printed before it up into the scrollback, as a CLI
        // started below earlier output pushes it up. Every frame then erases below the top-left
        // corner: a real CLI's redraws leave no copy of themselves in the scrollback.
        if !std::mem::replace(&mut self.drawn, true) && self.printed > 0 {
            let pushed = self.printed.min(rows.saturating_sub(1));
            frame.push_str(&format!("\x1b[{rows};1H{}", "\n".repeat(pushed)));
        }
        frame.push_str("\x1b[H\x1b[J");
        if self.panel {
            self.panel_drawn_ready = self.server_ready();
            let server = match (self.native, self.panel_drawn_ready) {
                (Some(_), true) => "❯ Facade (plugin) - enabled",
                (Some(_), false) => "❯ Facade (plugin) - connecting",
                (None, true) => ">  ✓ facade_facade  Tools: list_agents",
                (None, false) => ">  ⋯ facade_facade",
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
        if self.composer_gate.is_some() {
            frame.push_str("Starting up\r\n\x1b[?25l");
            self.cursor_hidden = true;
            if self.sync {
                frame.push_str("\x1b[?2026l");
            }
            let _ = out.write_all(frame.as_bytes());
            let _ = out.flush();
            return;
        }
        if let Some(answered) = self.cursor_trust {
            draw_cursor_trust(&mut frame, cols, answered);
            if !answered {
                if self.sync {
                    frame.push_str("\x1b[?2026l");
                }
                let _ = out.write_all(frame.as_bytes());
                let _ = out.flush();
                return;
            }
        }
        frame.push_str(&format!(
            "\x1b[1m{}\x1b[0m \x1b[2m(Facade test CLI)\x1b[0m\r\n",
            self.name
        ));
        let room = rows.saturating_sub(6);
        let start = self.transcript.len().saturating_sub(room);
        for line in &self.transcript[start..] {
            if self.wrap_transcript {
                frame.push_str(line);
            } else {
                frame.push_str(&truncate_chars(line, cols));
            }
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
        if let Some(native) = self.native {
            if native == Native::Cursor {
                self.draw_cursor_input(&mut frame, cols, rows);
            } else if self.omp_band {
                self.draw_omp_band(&mut frame, cols, rows);
            } else {
                self.draw_native_input(native, &mut frame, cols, rows);
            }
            if self.sync {
                frame.push_str("\x1b[?2026l");
            }
            let _ = out.write_all(frame.as_bytes());
            let _ = out.flush();
            return;
        }
        frame.push_str(&format!(
            "\x1b[{};1H\x1b[2m{}\x1b[0m",
            input_row,
            "─".repeat(cols)
        ));
        let shown = self.displayed_draft();
        let (prompt, footer) = if self.agy {
            (">", "? for shortcuts")
        } else if self.codex_input {
            ("›", "  test-model default · /isolated/work")
        } else {
            ("❯", "  Enter to send")
        };
        let shown = if self.no_leading_space {
            shown.trim_start_matches(' ').to_string()
        } else {
            shown
        };
        // Muse 1.4.20 draws its input in this color, a hint and a draft alike.
        let colored = |text: &str| format!("\x1b[38;2;204;211;219m{text}\x1b[0m");
        let mut after = colored(&self.after_cursor);
        if shown.is_empty() && self.after_cursor.is_empty() && self.hint_after.is_none() {
            after = self.hint.as_deref().map(colored).unwrap_or_default();
        }
        let suggestion = self
            .space_suggests
            .as_deref()
            .filter(|_| self.draft_text().starts_with(' '));
        let gap = if self.claude { '\u{a0}' } else { ' ' };
        frame.push_str(&format!(
            "\x1b[{};1H{prompt}{gap}{}{after}",
            input_row + 1,
            truncate_chars(&shown, cols.saturating_sub(2))
        ));
        // A suggestion takes a row under the input, pushing the lower rule onto the footer's.
        let lower = match suggestion {
            Some(suggestion) => {
                frame.push_str(&format!("\x1b[{};1H  {suggestion}", input_row + 2));
                input_row + 3
            }
            None => input_row + 2,
        };
        if !self.codex_input {
            frame.push_str(&format!(
                "\x1b[{};1H\x1b[2m{}\x1b[0m",
                lower,
                "─".repeat(cols)
            ));
        }
        if suggestion.is_none() {
            frame.push_str(&format!("\x1b[{};1H\x1b[2m{footer}\x1b[0m", input_row + 3));
        }
        let cursor_col = 3 + shown.chars().count().min(cols.saturating_sub(3));
        frame.push_str(&format!("\x1b[{};{}H", input_row + 1, cursor_col));
        if self.sync {
            frame.push_str("\x1b[?2026l");
        }
        let _ = out.write_all(frame.as_bytes());
        let _ = out.flush();
    }
}

impl FakeCli {
    /// Oh My Pi 19.1.1's band has a colored status row, colored gutters and no lower rule.
    fn draw_omp_band(&self, frame: &mut String, cols: usize, rows: usize) {
        let draft = self.displayed_draft();
        let lines: Vec<String> = draft
            .split('\n')
            .flat_map(|line| wrapped(line, cols.saturating_sub(4)))
            .collect();
        let shown = &lines[lines.len().saturating_sub(omp_viewport(rows) + 1)..];
        let top = rows.saturating_sub(shown.len());
        frame.push_str(&format!(
            "\x1b[{top};1H\x1b[38;5;75m π  Example model\x1b[39m"
        ));
        for (index, line) in shown.iter().enumerate() {
            let row = top + index + 1;
            let gutter = if index == 0 { "╰─ " } else { "   " };
            frame.push_str(&format!("\x1b[{row};1H\x1b[38;5;75m{gutter}\x1b[39m{line}"));
        }
    }

    /// Cursor 2026.11.22 draws an inverse caret and parks the hidden terminal cursor below its
    /// footer. Its blank composer and an ordinary draft use the recorded prompt and margins.
    fn draw_cursor_input(&self, frame: &mut String, cols: usize, rows: usize) {
        let draft = self.displayed_draft();
        let footer = if draft.is_empty() {
            let first = rows.saturating_sub(5).max(1);
            frame.push_str(&format!(
                "\x1b[{first};1H  \x1b[2m→ \x1b[22m\x1b[7mP\x1b[27m\x1b[2mlan, search, build anything\x1b[22m"
            ));
            first + 3
        } else {
            let starts_below_prompt = !draft.starts_with('/')
                && !draft.starts_with("[Pasted text #")
                && !draft.contains('\n');
            let lines: Vec<_> = draft
                .split('\n')
                .flat_map(|line| wrapped(line, cols.saturating_sub(5)))
                .collect();
            let gap = usize::from(starts_below_prompt);
            let first = rows.saturating_sub(4 + gap + lines.len()).max(1);
            frame.push_str(&format!("\x1b[{first};1H  → "));
            let mut row = first + gap;
            for (index, line) in lines.iter().enumerate() {
                let style = if line.starts_with("[Pasted text #") {
                    "2;36"
                } else {
                    "0"
                };
                frame.push_str(&format!("\x1b[{row};5H\x1b[{style}m{line}\x1b[0m"));
                if index + 1 == lines.len() {
                    frame.push_str("\x1b[7m \x1b[27m");
                }
                row += 1;
            }
            row + 2
        };
        if footer + 2 <= rows {
            frame.push_str(&format!(
                "\x1b[{footer};1H\x1b[2m  Auto\r\n  xxxxxxxxxxxx\x1b[22m\r\n"
            ));
        }
        frame.push_str("\x1b[?25l");
    }

    /// Draws the input of the CLI it stands in for over a status row, and leaves the terminal's own
    /// cursor where the draft ends. Of a draft with more rows than Oh My Pi's viewport it shows the
    /// last ones, with nothing to say so. `FAKECLI_HINT` stands at the right of an empty one of
    /// Oh My Pi's, as its hint on keys does.
    fn draw_native_input(&self, native: Native, frame: &mut String, cols: usize, rows: usize) {
        let prompt = native.prompt(self.yolo);
        let indent = prompt.chars().count();
        let draft = self.displayed_draft();
        let drawn: Vec<String> = draft
            .split('\n')
            .flat_map(|line| wrapped(line, cols.saturating_sub(indent + 1)))
            .collect();
        let most = match native {
            Native::Omp => omp_viewport(rows),
            _ => drawn.len(),
        };
        let shown = &drawn[drawn.len().saturating_sub(most)..];
        let first = rows.saturating_sub(1 + shown.len());
        if native.has_rules() {
            let rule = format!("\x1b[38;5;240m{}\x1b[0m", "─".repeat(cols));
            frame.push_str(&format!("\x1b[{};1H{rule}", first - 1));
            frame.push_str(&format!("\x1b[{};1H{rule}", first + shown.len()));
        }
        frame.push_str(&format!("\x1b[{rows};1H\x1b[2m test model\x1b[0m"));
        if draft.is_empty() {
            let words = native.empty_words();
            let column = indent + 1 + usize::from(native == Native::Kiro);
            frame.push_str(&format!(
                "\x1b[{first};{column}H\x1b[38;5;245m{words}\x1b[0m"
            ));
            if let Some(hint) = self.hint.as_deref().filter(|_| native == Native::Omp) {
                let column = cols.saturating_sub(hint.chars().count());
                frame.push_str(&format!(
                    "\x1b[{first};{column}H\x1b[38;5;240m{hint}\x1b[0m"
                ));
            }
        }
        // The last row goes last, so that the cursor is left at its end whatever its width.
        for (at, row) in shown.iter().enumerate() {
            let before = match at {
                0 => prompt.to_string(),
                _ => " ".repeat(indent),
            };
            // Qoder draws its placeholders in its accent color.
            let style = match native {
                Native::Qoder if row.starts_with("[Pasted Text: ") => "36",
                _ => "0",
            };
            let row = format!("\x1b[{style}m{row}\x1b[0m");
            frame.push_str(&format!("\x1b[{};1H{before}{row}", first + at));
        }
        match native {
            // Kiro draws an inverse blank at the hidden hardware caret. Its hint starts in the
            // next cell and vanishes when the draft takes a space.
            Native::Kiro => frame.push_str("\x1b[7m \x1b[27m\x1b[D\x1b[?25l"),
            // The recorded Qoder caret is hidden even on the input row and has no inverse cell.
            Native::Qoder => frame.push_str("\x1b[?25l"),
            _ => {}
        }
    }
}

/// Sanitized Cursor 2026.11.22 trust frame. After the answer, the box stays above the composer.
fn draw_cursor_trust(frame: &mut String, cols: usize, answered: bool) {
    let width = cols.saturating_sub(6);
    let (option, help) = if answered {
        ("  [a] Trust this workspace", "⏳ Trusting workspace...")
    } else {
        (
            "▶ [a] Trust this workspace",
            "Use arrow keys to navigate, Enter to select, or press the key shown",
        )
    };
    let border = "─".repeat(width);
    frame.push_str(&format!("\x1b[2;1H  ╭{border}╮\r\n"));
    for row in [
        "",
        "  ⚠ Workspace Trust Required",
        "",
        "  Cursor Agent can execute code and access files in this directory.",
        "",
        "  Do you trust the contents of this directory?",
        "",
        "    xxxxxxxxxxxx",
        "",
        "",
        &format!("  {option}"),
        "    [q] Quit",
        "",
        &format!("  {help}"),
        "",
    ] {
        frame.push_str(&format!("  │{row:width$}│\r\n"));
    }
    frame.push_str(&format!("  ╰{border}╯\r\n\x1b[?25l"));
}

/// Reports session `id` as the CLI it stands in for does, and waits for what it runs. A hook gets
/// what the CLI gives it.
fn report_natively(
    native: Native,
    reporter: &Reporter,
    id: Option<&str>,
    source: &str,
    saved: Option<&std::path::Path>,
) {
    let cwd = std::env::current_dir().unwrap_or_default();
    let input = id.and_then(|id| native.hook_input(id, source, &cwd, saved));
    let commands: Vec<Command> = match reporter {
        Reporter::File(file) => {
            let text = id
                .zip(saved)
                .map(|(id, saved)| format!("{id}\n{}\n", saved.display()));
            let _ = write_whole(file, &text.unwrap_or_default());
            return;
        }
        Reporter::Shell(commands) => commands.iter().map(|line| shell_command(line)).collect(),
        Reporter::Programs(programs) => programs
            .iter()
            .map(|words| {
                let mut command = Command::new(&words[0]);
                command.args(&words[1..]);
                command
            })
            .collect(),
    };
    let Some(input) = input else { return };
    for mut command in commands {
        let ran = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();
        let Ok(mut child) = ran else { continue };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.to_string().as_bytes());
        }
        let _ = child.wait_with_output();
    }
}

/// How many text rows Oh My Pi's composer shows in a terminal of `rows`: its interactive-mode.ts
/// `computeEditorMaxHeight`, less the two rules.
fn omp_viewport(rows: usize) -> usize {
    let height = rows.saturating_sub(12).clamp(6, 18);
    height.min(rows.saturating_sub(4)).max(3) - 2
}

/// The fixture only reads the shape from explicit JSON configurations, in the CLI's order.
fn omp_configures_pi(arguments: &[String]) -> bool {
    arguments
        .windows(2)
        .filter(|pair| pair[0] == "--config")
        .filter_map(|pair| std::fs::read(&pair[1]).ok())
        .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter_map(|config| config["composer"]["shape"].as_str().map(str::to_owned))
        .next_back()
        .is_some_and(|shape| shape == "pi")
}

/// `line` in rows of at most `width` columns, a character that is not ASCII counted as two.
fn wrapped(line: &str, width: usize) -> Vec<String> {
    let mut rows = vec![String::new()];
    let mut taken = 0;
    for ch in line.chars() {
        let columns = if ch.is_ascii() { 1 } else { 2 };
        if taken + columns > width {
            rows.push(String::new());
            taken = 0;
        }
        taken += columns;
        rows.last_mut().expect("a row").push(ch);
    }
    rows
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// A submitted message with its Unix timestamp in milliseconds.
fn encode_log_entry(at: u128, text: &str) -> String {
    serde_json::json!({ "at": at as u64, "text": text }).to_string()
}

/// Runs `command` with the shell a CLI runs its hooks with: `/bin/sh`, or on Windows cmd.exe,
/// given the command as written, as Antigravity 1.5.10 runs the hooks of a `hooks.json`.
fn shell_command(command: &str) -> std::process::Command {
    #[cfg(unix)]
    {
        let mut shell = std::process::Command::new("/bin/sh");
        shell.arg("-c").arg(command);
        shell
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut shell = std::process::Command::new("cmd.exe");
        // /s takes the outer quotes off and runs the rest as written.
        shell
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{command}\""));
        shell
    }
}

/// The CLI a copy of the test CLI stands for on Windows, by its name.
#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StandIn {
    None,
    Codex,
    Muse,
    Agy,
}

#[cfg(windows)]
impl StandIn {
    fn of(program: &std::path::Path) -> StandIn {
        let name = program
            .file_stem()
            .map(|name| name.to_string_lossy().to_ascii_lowercase());
        match name.as_deref() {
            Some("codex") => StandIn::Codex,
            Some("muse") => StandIn::Muse,
            Some("agy") => StandIn::Agy,
            _ => StandIn::None,
        }
    }

    /// The session-start commands the CLI it stands for finds in `arguments`.
    fn session_hooks(self, arguments: &[String]) -> Option<Vec<String>> {
        match self {
            StandIn::Codex => codex_session_hooks(arguments),
            StandIn::Muse => muse_session_hooks(arguments),
            StandIn::Agy => agy_title_command(arguments),
            StandIn::None => None,
        }
    }
}

/// With `FAKECLI_TITLE_FROM_CONSOLE=1` on Windows, the title sequence that sets back the title its
/// console has, as Antigravity does: `OSC 0` with what `GetConsoleTitleW` reads, empty or not.
fn console_title_back() -> Option<String> {
    if std::env::var("FAKECLI_TITLE_FROM_CONSOLE").as_deref() != Ok("1") {
        return None;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::GetConsoleTitleW;
        let mut title = vec![0u16; 4096];
        // SAFETY: the buffer holds as many UTF-16 units as the length given.
        let length = unsafe { GetConsoleTitleW(title.as_mut_ptr(), title.len() as u32) };
        let title = String::from_utf16_lossy(&title[..length as usize]);
        Some(format!("\x1b]0;{title}\x07"))
    }
    #[cfg(not(windows))]
    None
}

/// Runs `command` as Muse Code 1.4.14 runs a hook and Antigravity 1.5.10 its title command on
/// Windows: `%COMSPEC% /C` with the command as one argument, quoted the standard way, so that each
/// `"` in it reaches cmd.exe as `\"`.
#[cfg(windows)]
fn stand_in_shell(command: &str) -> std::process::Command {
    let shell = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
    let mut shell = std::process::Command::new(shell);
    shell.args(["/C", command]);
    shell
}

/// The SessionStart commands of Muse Code's `-c hooks=<JSON>`, each group's in order.
#[cfg(windows)]
fn muse_session_hooks(arguments: &[String]) -> Option<Vec<String>> {
    let hooks = arguments.windows(2).find_map(|pair| {
        (pair[0] == "-c")
            .then(|| pair[1].strip_prefix("hooks="))
            .flatten()
    })?;
    let hooks: serde_json::Value = serde_json::from_str(hooks).ok()?;
    let commands = hooks["SessionStart"]
        .as_array()?
        .iter()
        .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
        .filter(|hook| hook["type"] == "command")
        .filter_map(|hook| hook["command"].as_str().map(str::to_string))
        .collect();
    Some(commands)
}

/// The title command of Antigravity's `--settings <file>`, where it is on.
#[cfg(windows)]
fn agy_title_command(arguments: &[String]) -> Option<Vec<String>> {
    let file = arguments
        .windows(2)
        .find_map(|pair| (pair[0] == "--settings").then(|| &pair[1]))?;
    let settings: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let title = &settings["title"];
    if title["type"] != "command" || title["enabled"] == false {
        return None;
    }
    Some(vec![title["command"].as_str()?.to_string()])
}

/// The trusted SessionStart commands in the hooks override Facade gives its Codex stand-in.
#[cfg(windows)]
fn codex_session_hooks(arguments: &[String]) -> Option<Vec<String>> {
    use sha2::{Digest, Sha256};

    let pair = arguments
        .windows(2)
        .find(|pair| pair[0] == "-c" && pair[1].starts_with("hooks="))?;
    let settings: toml::Table = toml::from_str(&pair[1]).ok()?;
    let configured = settings.get("hooks")?;
    let groups = configured.get("SessionStart")?.as_array()?;
    let state = configured.get("state")?.as_table()?;
    let mut commands = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        for (hook_index, hook) in group.get("hooks")?.as_array()?.iter().enumerate() {
            if hook.get("type")?.as_str()? != "command" {
                continue;
            }
            let command = hook
                .get("commandWindows")
                .or_else(|| hook.get("command_windows"))
                .or_else(|| hook.get("command"))?
                .as_str()?;
            let timeout = hook
                .get("timeout")
                .and_then(toml::Value::as_integer)
                .unwrap_or(600)
                .max(1);
            let mut handler = serde_json::json!({
                "async": hook.get("async").and_then(toml::Value::as_bool).unwrap_or(false),
                "command": command,
                "timeout": timeout,
                "type": "command",
            });
            if let Some(status) = hook.get("statusMessage").and_then(toml::Value::as_str) {
                handler["statusMessage"] = serde_json::json!(status);
            }
            if let Some(limit) = hook
                .get("additionalContextLimit")
                .and_then(toml::Value::as_integer)
                .filter(|limit| *limit != 2500)
            {
                handler["additionalContextLimit"] = serde_json::json!(limit);
            }
            let mut definition = serde_json::json!({
                "event_name": "session_start",
                "hooks": [handler],
            });
            if let Some(matcher) = group.get("matcher").and_then(toml::Value::as_str) {
                definition["matcher"] = serde_json::json!(matcher);
            }
            definition.sort_all_objects();
            let digest = Sha256::digest(serde_json::to_vec(&definition).ok()?);
            let hash = format!("sha256:{digest:x}");
            // Codex resolves this synthetic path against C:\, regardless of its session's folder or drive.
            let key =
                format!(r"C:\<session-flags>\config.toml:session_start:{group_index}:{hook_index}");
            let trusted = state.get(&key);
            if trusted
                .and_then(|entry| entry.get("enabled"))
                .and_then(toml::Value::as_bool)
                != Some(false)
                && trusted
                    .and_then(|entry| entry.get("trusted_hash"))
                    .and_then(toml::Value::as_str)
                    == Some(hash.as_str())
            {
                commands.push(command.to_string());
            }
        }
    }
    Some(commands)
}

/// The descriptors above 2 that are open, one number per line.
#[cfg(unix)]
fn open_descriptors() -> String {
    // SAFETY: F_GETFD only reads the descriptor's flags; it fails with EBADF for a closed
    // descriptor.
    (3..1024)
        .filter(|&fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1)
        .map(|fd| format!("{fd}\n"))
        .collect()
}

fn main() -> anyhow::Result<()> {
    #[cfg(windows)]
    if let Some(code) = run_script_beside()? {
        std::process::exit(code);
    }
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--attach-exit")
    {
        std::process::exit(attach_exit()?);
    }
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--flood")
    {
        let mut out = std::io::stdout().lock();
        loop {
            writeln!(
                out,
                "flood {} 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                std::process::id()
            )?;
            out.flush()?;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if std::env::var_os("FAKECLI_HOOKS").is_some() {
        run_hooks();
        return Ok(());
    }
    #[cfg(windows)]
    if std::env::var_os("FAKECLI_SLEEPER").is_some() {
        std::thread::sleep(Duration::from_secs(600));
        return Ok(());
    }
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

fn attach_exit() -> anyhow::Result<i32> {
    crossterm::terminal::enable_raw_mode()?;
    #[cfg(windows)]
    terminal_input()?;
    let mut out = std::io::stdout().lock();
    write!(out, "ATTACH-READY\r\n")?;
    out.flush()?;

    let mut input = Vec::new();
    for byte in std::io::stdin().lock().bytes() {
        match byte? {
            b'\r' | b'\n' if input == b"finish" => {
                write!(out, "ATTACH-FINISHED\r\n")?;
                out.flush()?;
                return Ok(23);
            }
            b'\r' | b'\n' => break,
            byte => input.push(byte),
        }
    }
    write!(
        out,
        "ATTACH-UNEXPECTED-INPUT: {:?}\r\n",
        String::from_utf8_lossy(&input)
    )?;
    out.flush()?;
    Ok(91)
}

fn isolated_home() -> anyhow::Result<PathBuf> {
    std::env::var_os("FACADE_HOME")
        .map(PathBuf::from)
        .context("the fake CLI needs an isolated Facade home")
}

/// The home the CLI it stands in for keeps its sessions in.
fn user_home() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("the fake CLI needs an isolated home")
}

fn command_from_config(config: &serde_json::Value) -> anyhow::Result<Command> {
    let home = isolated_home()?;
    mcp_command(config, &home, |program| Command::new(program))
}

/// The native launch rules supply these relay arguments beside the fixture's program.
fn stand_in_mcp_args(arguments: &[String]) -> anyhow::Result<Vec<String>> {
    if let Some(args) = arguments
        .iter()
        .find_map(|word| word.strip_prefix("mcp_servers.facade.args="))
    {
        return serde_json::from_str(args).context("reading Codex's test relay arguments");
    }
    if let Some(entry) = arguments
        .iter()
        .find_map(|word| word.strip_prefix("mcpServers.facade="))
    {
        let entry: serde_json::Value =
            serde_json::from_str(entry).context("reading Muse Code's test relay entry")?;
        return serde_json::from_value(entry["args"].clone())
            .context("reading Muse Code's test relay arguments");
    }
    if let Ok(config) = std::env::var("OPENCODE_CONFIG_CONTENT") {
        let config: serde_json::Value =
            serde_json::from_str(&config).context("reading OpenCode's test relay entry")?;
        if let Some(words) = config["mcp"]["facade"]["command"].as_array() {
            let words: Vec<String> = serde_json::from_value(words.clone().into())
                .context("reading OpenCode's test relay command")?;
            return Ok(words.into_iter().skip(1).collect());
        }
    }
    let pi = arguments.windows(2).find_map(|pair| {
        let file = std::path::Path::new(&pair[1]);
        (pair[0] == "-e" && file.file_name().is_some_and(|name| name == "facade-pi.mjs"))
            .then_some(file)
    });
    if let Some(file) = pi {
        let home = std::env::var_os("FACADE_HOME")
            .map(PathBuf::from)
            .context("the Pi stand-in needs an isolated Facade home")?;
        anyhow::ensure!(
            file.canonicalize()?
                .starts_with(home.join("framework/runs").canonicalize()?),
            "the Pi stand-in's extension must be in its run directory"
        );
        let extension = std::fs::read_to_string(file)?;
        let entry = extension
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("pi.registerMcpServer(\"facade\", ")
                    .and_then(|line| line.strip_suffix(");"))
            })
            .context("the Pi stand-in has no Facade relay entry")?;
        let entry: serde_json::Value =
            serde_json::from_str(entry).context("reading Pi's test relay entry")?;
        return serde_json::from_value(entry["args"].clone())
            .context("reading Pi's test relay arguments");
    }
    Ok(Vec::new())
}

fn configured_server(
    arguments: &[String],
    native: Option<Native>,
) -> anyhow::Result<Option<Command>> {
    if let Some(native) = native {
        // The server the run's own configuration names, and no other.
        let devin_config = std::env::var_os(if cfg!(windows) {
            "APPDATA"
        } else {
            "XDG_CONFIG_HOME"
        })
        .map(PathBuf::from);
        return native
            .mcp_settings(
                arguments,
                &isolated_home()?,
                &user_home()?,
                &std::env::current_dir()?,
                devin_config.as_deref(),
            )?
            .map(|config| command_from_config(&config))
            .transpose();
    }
    let Some(index) = arguments.iter().rposition(|arg| arg == "--mcp-config") else {
        let Some(program) = std::env::var_os("FAKECLI_MCP") else {
            return Ok(None);
        };
        anyhow::ensure!(
            std::path::Path::new(&program).is_absolute(),
            "FAKECLI_MCP needs an absolute path"
        );
        let mut command = Command::new(program);
        command.args(stand_in_mcp_args(arguments)?);
        return Ok(Some(command));
    };
    let file = arguments
        .get(index + 1)
        .context("--mcp-config needs a file")?;
    let text = std::fs::read_to_string(file)
        .with_context(|| format!("reading the test MCP configuration {file}"))?;
    let config = serde_json::from_str(&text).context("reading the test MCP configuration JSON")?;
    command_from_config(&config).map(Some)
}

/// Starts the configured MCP server and its MCP session, as a CLI does at its start: it initializes the
/// session and asks for the server's tools. `answered` is set once the server answers the session's
/// start. When a test asks for a roster, save the response to its isolated file.
fn start_server(
    mut command: Command,
    answered: Arc<AtomicBool>,
) -> anyhow::Result<std::process::Child> {
    use std::io::BufRead;
    use std::process::Stdio;
    let mut server = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let answers = server.stdout.take().expect("the server's output");
    let roster = std::env::var_os("FAKECLI_MCP_ROSTER").map(PathBuf::from);
    let ask_roster = roster.is_some();
    let initialize = std::env::var_os("FAKECLI_MCP_INITIALIZE").map(PathBuf::from);
    let takeover = std::env::var_os("FAKECLI_MCP_TAKEOVER").map(PathBuf::from);
    let mut receipt = if let Some(folder) = &takeover {
        anyhow::ensure!(
            folder
                .canonicalize()?
                .starts_with(isolated_home()?.canonicalize()?),
            "the takeover probe must stay in its test home"
        );
        let file = folder.join("responses.jsonl");
        let text = format!("{}\n", serde_json::json!({ "relay_pid": server.id() }));
        write_whole(&file, &text)?;
        Some((file, text))
    } else {
        None
    };
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(answers)
            .lines()
            .map_while(Result::ok)
        {
            if line.contains("\"id\":1") && line.contains("\"result\"") {
                if let Some(file) = &initialize {
                    let _ = write_whole(file, &line);
                }
                answered.store(true, Ordering::SeqCst);
            }
            if let Some(file) = &roster
                && serde_json::from_str::<serde_json::Value>(&line)
                    .is_ok_and(|reply| reply["id"] == 3)
            {
                let _ = write_whole(file, &line);
            }
            if let Some((file, text)) = &mut receipt
                && serde_json::from_str::<serde_json::Value>(&line)
                    .is_ok_and(|reply| matches!(reply["id"].as_u64(), Some(2..=4)))
            {
                text.push_str(&line);
                text.push('\n');
                let _ = write_whole(file, text);
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
    let input = server.stdin.as_mut().expect("the server's input");
    input.write_all(session.as_bytes())?;
    if ask_roster {
        writeln!(
            input,
            "{}",
            serde_json::json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "list_agents", "arguments": {} },
            })
        )?;
    }
    if let Some(folder) = takeover {
        // The original handle stays with the relay child after this probe's writes finish.
        #[cfg(unix)]
        let writer = std::os::fd::AsFd::as_fd(input).try_clone_to_owned()?;
        #[cfg(windows)]
        let writer = std::os::windows::io::AsHandle::as_handle(input).try_clone_to_owned()?;
        std::thread::spawn(move || probe_takeover(folder, std::fs::File::from(writer)));
    }
    Ok(server)
}

/// A takeover test requests real responses on the relay's existing stdio connection.
fn probe_takeover(folder: PathBuf, mut input: std::fs::File) -> std::io::Result<()> {
    for (gate, request) in [
        (
            "read-roster",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}"#,
        ),
        (
            "read-catalog",
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#,
        ),
    ] {
        let gate = folder.join(gate);
        if !facade_scenarios::wait_until(Duration::from_secs(180), || gate.is_file()) {
            return Ok(());
        }
        writeln!(input, "{request}")?;
    }
    Ok(())
}

fn run() -> anyhow::Result<()> {
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("FAKECLI_IGNORE_CLOSE") {
        ignore_close(std::path::Path::new(&path))?;
    }
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
    #[cfg(unix)]
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
    if let Some(path) = std::env::var_os("FAKECLI_ENV") {
        let keys = std::env::var("FAKECLI_ENV_KEYS")?;
        let values: std::collections::BTreeMap<_, _> = keys
            .split(',')
            .filter_map(|key| std::env::var(key).ok().map(|value| (key, value)))
            .collect();
        write_whole(
            std::path::Path::new(&path),
            &serde_json::to_string(&values)?,
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
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|word| word.to_string_lossy().into_owned())
        .collect();
    #[cfg(windows)]
    let stand_in = StandIn::of(&std::env::current_exe()?);
    let claude = std::env::var("FAKECLI_LOOK").as_deref() == Ok("claude");
    let native = std::env::var("FAKECLI_LOOK")
        .ok()
        .and_then(|look| Native::of(&look));
    let commands = if claude {
        let settings = arguments
            .windows(2)
            .find_map(|pair| (pair[0] == "--settings").then_some(&pair[1]))
            .context("the Claude fixture expects --settings")?;
        let settings: serde_json::Value = serde_json::from_str(settings)?;
        let hook = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .context("the Claude fixture expects a SessionStart command")?;
        Some(vec![hook.to_string()])
    } else {
        std::env::var("FAKECLI_SESSION_HOOK")
            .ok()
            .map(|command| vec![command])
    };
    #[cfg(windows)]
    let commands = commands.or_else(|| stand_in.session_hooks(&arguments));
    let reporter = match native {
        Some(native) => native
            .reporter(
                &arguments,
                &isolated_home()?,
                &user_home()?,
                &std::env::current_dir()?,
            )?
            .map(|reporter| (native, reporter)),
        None => None,
    };
    let commands = commands.or_else(|| reporter.is_some().then(Vec::new));
    let hook = commands.map(|commands| SessionHook {
        commands,
        native: reporter,
        #[cfg(windows)]
        stand_in,
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
    let codex_input = std::env::var("FAKECLI_CODEX_INPUT").as_deref() == Ok("working");
    let status = std::env::var("FAKECLI_STATUS")
        .is_ok_and(|v| v == "1")
        .then(|| {
            let mut reports = vec!["\x1b]7501;?\x1b\\".into()];
            if codex_input {
                reports.push(report("working", None, None));
            }
            Status {
                ready_at: (!codex_input).then(|| {
                    Instant::now() + milliseconds("FAKECLI_STATUS_DELAY_MS").unwrap_or_default()
                }),
                turn: milliseconds("FAKECLI_TURN_MS").unwrap_or(Duration::from_millis(400)),
                turn_ends: None,
                progress: std::env::var("FAKECLI_PROGRESS").is_ok_and(|v| v == "1"),
                reports,
            }
        });
    let server_answered = Arc::new(AtomicBool::new(false));
    let delay = milliseconds("FAKECLI_MCP_DELAY_MS").unwrap_or_default();
    let (server, delayed_server) = match configured_server(&arguments, native)? {
        Some(command) if delay.is_zero() => {
            (Some(start_server(command, server_answered.clone())?), None)
        }
        Some(command) => (None, Some((command, Instant::now() + delay))),
        None => (None, None),
    };
    let agy = std::env::var("FAKECLI_LOOK").is_ok_and(|look| look == "agy");
    let mut app = FakeCli {
        codex_input,
        console_keys: std::env::var("FAKECLI_CONSOLE_KEYS").is_ok_and(|v| v == "1"),
        claude,
        native,
        omp_band: native == Some(Native::Omp) && !omp_configures_pi(&arguments),
        yolo: std::env::var("FAKECLI_YOLO").is_ok_and(|value| value == "1"),
        transcript: Vec::new(),
        wrap_transcript: std::env::var("FAKECLI_WRAP_TRANSCRIPT").is_ok_and(|value| value == "1"),
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
        muse: std::env::var("FAKECLI_LOOK").is_ok_and(|look| look == "muse"),
        panel: false,
        menu: None,
        cursor_hidden: false,
        composer_gate: std::env::var_os("FAKECLI_COMPOSER_GATE").map(PathBuf::from),
        cursor_trust: (native == Some(Native::Cursor)
            && std::env::var_os("FAKECLI_CURSOR_TRUST").is_some())
        .then_some(false),
        server_due: None,
        delayed_server,
        server_answered,
        panel_drawn_ready: false,
        drawn: false,
        printed: 0,
        queries: std::env::var("FAKECLI_TITLE")
            .map(|title| match std::env::var("FAKECLI_OWN_GLYPH") {
                Ok(glyph) => vec![format!("\x1b]2;{glyph} {title}\x07")],
                Err(_) => vec![format!("\x1b]2;{title}\x07")],
            })
            .unwrap_or_default()
            .into_iter()
            .chain(console_title_back())
            .collect(),
        title_after_answer: std::env::var("FAKECLI_TITLE")
            .ok()
            .filter(|_| std::env::var("FAKECLI_STATUS").as_deref() == Ok("1"))
            .map(|title| (title, false)),
        hint: std::env::var("FAKECLI_HINT").ok(),
        after_cursor: std::env::var("FAKECLI_DRAFT_AT_START").unwrap_or_default(),
        no_leading_space: std::env::var("FAKECLI_NO_LEADING_SPACE").is_ok_and(|v| v == "1"),
        space_suggests: std::env::var("FAKECLI_SPACE_SUGGESTS").ok(),
        hint_after: None,
        kiro_space_delay: Duration::from_millis(
            std::env::var("FAKECLI_KIRO_SPACE_DELAY_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or_default(),
        ),
        kiro_space_at: None,
    };
    let resumed = arguments
        .iter()
        .position(|arg| {
            arg == "--resume"
                || (agy && arg == "--conversation")
                || native.is_some_and(|native| arg == native.resume_option())
        })
        .and_then(|at| arguments.get(at + 1))
        .cloned();
    #[cfg(windows)]
    let resumed = resumed.or_else(|| {
        matches!(stand_in, StandIn::Codex | StandIn::Muse)
            .then(|| {
                arguments
                    .windows(2)
                    .find(|pair| pair[0] == "resume")
                    .map(|pair| pair[1].clone())
            })
            .flatten()
    });
    match (resumed, std::env::var("FAKECLI_SESSION").ok()) {
        (Some(id), _) => app.select_session(Some(&id), "resume"),
        (None, Some(id)) => app.select_session(Some(&id), "startup"),
        (None, None) => {}
    }

    crossterm::terminal::enable_raw_mode()?;
    // A console gives its input as key presses unless asked for terminal sequences; a CLI that reads
    // bytes, pastes included, asks for them.
    #[cfg(windows)]
    if !app.console_keys {
        terminal_input()?;
    }
    let mut out = std::io::stdout();
    if let Some(file) = std::env::var_os("FAKECLI_SCREEN_FILE") {
        for line in std::fs::read_to_string(file)?.lines() {
            write!(out, "{line}\r\n")?;
            app.printed += 1;
        }
    }
    if std::env::var_os("FAKECLI_UNANNOUNCED_PASTE").is_none() {
        let _ = out.write_all(b"\x1b[?2004h");
    }
    app.draw(&mut out);

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reads_input = std::env::var("FAKECLI_IGNORE_INPUT").is_err();
    let mut keys = std::env::var_os("FAKECLI_KEYS").and_then(|path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    });
    let ignored = std::env::var("FAKECLI_IGNORE_KEYS").unwrap_or_default();
    let ignores = |key: &str| ignored.split(',').any(|each| each.trim() == key);
    let (ignore_space, ignore_backspace) = (ignores("space"), ignores("backspace"));
    let takes_enter = std::env::var("FAKECLI_IGNORE_ENTER").is_err();
    let mut ignore_first_enter = std::env::var_os("FAKECLI_IGNORE_FIRST_ENTER").is_some();
    let console_keys = app.console_keys;
    let read_gate = std::env::var_os("FAKECLI_READ_GATE").map(std::path::PathBuf::from);
    std::thread::spawn(move || {
        if !reads_input {
            // Hold the channel open without reading, so the CLI keeps running.
            let _tx = tx;
            loop {
                std::thread::park();
            }
        }
        if let Some(gate) = read_gate {
            while !gate.is_file() {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if console_keys {
            loop {
                let Ok(event) = crossterm::event::read() else {
                    return;
                };
                let Some(bytes) = console_key(event) else {
                    continue;
                };
                if tx.send(bytes).is_err() {
                    return;
                }
            }
        }
        let mut stdin = std::io::stdin();
        let mut buffer = [0u8; 8192];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    note_key_time("in", n);
                    if tx.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut pending: Vec<u8> = Vec::new();
    let mut pasting: Option<Vec<u8>> = None;
    let mut size_log = std::env::var_os("FAKECLI_SIZE_LOG")
        .map(std::fs::File::create)
        .transpose()?;
    let mut last_size = if let Some(log) = size_log.as_mut() {
        let size @ (cols, rows) = crossterm::terminal::size()?;
        writeln!(log, "{cols}x{rows}")?;
        size
    } else {
        crossterm::terminal::size().unwrap_or((80, 24))
    };
    loop {
        let mut dirty = false;
        // Nothing came for a while: an Escape that may begin a paste's start is the key alone, as a
        // terminal reads it.
        let mut quiet = false;
        let mut typed = false;
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) => {
                if let Some(keys) = keys.as_mut() {
                    let _ = keys.write_all(&bytes);
                }
                pending.extend(bytes);
                dirty = true;
                typed = true;
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
                b'a' | b'\r' if app.cursor_trust == Some(false) => {
                    app.cursor_trust = Some(true);
                }
                b'\r' | b'\n' | 0x1b
                    if app.menu.is_some()
                        && !(pending[i] == 0x1b
                            && matches!(pending.get(i + 1), Some(b'[' | b'O'))) =>
                {
                    app.menu = None;
                    dirty = true;
                }
                LINE_BREAK if app.console_keys => app.push_text("\n"),
                b'\r' | b'\n' if ignore_first_enter => ignore_first_enter = false,
                b'\r' | b'\n' if takes_enter => app.submit(),
                b'\t' if app.codex_input && app.menu.is_none() => app.submit(),
                0x7f | 0x08 if ignore_backspace => {}
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
                        if let Some((title, true)) =
                            app.title_after_answer.take_if(|(_, asked)| *asked)
                        {
                            app.queries.push(format!("\x1b]2;{title}\x07"));
                            app.transcript.push("negotiated title".into());
                            dirty = true;
                        }
                    }
                    if [&b"10;"[..], b"11;", b"12;"]
                        .iter()
                        .any(|number| rest.starts_with(number))
                    {
                        let ended = if rest[end] == 0x1b { "st" } else { "bel" };
                        app.transcript.push(format!(
                            "color {} {ended}",
                            String::from_utf8_lossy(&rest[..end])
                        ));
                        dirty = true;
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
                    let text = String::from_utf8_lossy(&pending[start..end]);
                    let text = if ignore_space {
                        text.replace(' ', "")
                    } else {
                        text.into_owned()
                    };
                    if app.native == Some(Native::Kiro)
                        && !app.kiro_space_delay.is_zero()
                        && text == " "
                        && app.draft.is_empty()
                    {
                        app.kiro_space_at = Some(Instant::now() + app.kiro_space_delay);
                    } else if !text.is_empty() {
                        app.push_text(&text);
                    }
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
        if app.composer_gate.as_ref().is_some_and(|gate| gate.exists()) {
            app.composer_gate = None;
            dirty = true;
        }
        app.start_delayed_server();
        dirty |= app.start_plugin_server();
        // The panel shows the server ready once it answered.
        dirty |= app.panel && app.server_ready() != app.panel_drawn_ready;
        let size = crossterm::terminal::size().unwrap_or(last_size);
        if size != last_size {
            last_size = size;
            dirty = true;
            if let Some(log) = size_log.as_mut() {
                let (cols, rows) = size;
                writeln!(log, "{cols}x{rows}")?;
            }
        }
        if dirty
            || app
                .status
                .as_ref()
                .is_some_and(|status| !status.reports.is_empty())
        {
            app.draw(&mut out);
            if typed {
                note_key_time("out", 0);
            }
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

/// What the fake CLI's input loop reads for a Shift+Enter of the console.
const LINE_BREAK: u8 = 0x0e;

/// The byte a console's key press is in the fake CLI's input, for the keys it takes.
fn console_key(event: crossterm::event::Event) -> Option<Vec<u8>> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    let Event::Key(key) = event else {
        return None;
    };
    if key.kind != KeyEventKind::Press {
        return None;
    }
    Some(match key.code {
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => vec![LINE_BREAK],
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::Backspace => vec![0x7f],
        _ => return None,
    })
}

/// Asks the console for its input as terminal sequences (`ENABLE_VIRTUAL_TERMINAL_INPUT`), as a CLI
/// that reads bytes does on Windows: keys, and pastes between their bracketed-paste marks.
#[cfg(windows)]
fn terminal_input() -> std::io::Result<()> {
    use windows_sys::Win32::System::Console::{
        ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE,
        SetConsoleMode,
    };
    // SAFETY: the standard input handle is this process's; the mode is written into a valid u32.
    unsafe {
        let input = GetStdHandle(STD_INPUT_HANDLE);
        let mut mode = 0u32;
        if GetConsoleMode(input, &mut mode) == 0
            || SetConsoleMode(input, mode | ENABLE_VIRTUAL_TERMINAL_INPUT) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// `FAKECLI_IGNORE_CLOSE=<file>` on Windows: the fake CLI holds its console's closing up as long as
/// Windows lets it (its handler does not return), and starts a child outside any console, which no
/// closing reaches, whose process ID it writes to `<file>`. Only ending the CLI's job ends that child.
#[cfg(windows)]
fn ignore_close(child_pid: &std::path::Path) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Console::{CTRL_CLOSE_EVENT, SetConsoleCtrlHandler};
    use windows_sys::Win32::System::Threading::DETACHED_PROCESS;
    unsafe extern "system" fn hold(event: u32) -> windows_sys::core::BOOL {
        if event == CTRL_CLOSE_EVENT {
            std::thread::sleep(Duration::from_secs(60));
        }
        1
    }
    // SAFETY: the handler is a plain function that lives as long as the program.
    if unsafe { SetConsoleCtrlHandler(Some(hold), 1) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let child = std::process::Command::new(std::env::current_exe()?)
        .env("FAKECLI_SLEEPER", "1")
        .creation_flags(DETACHED_PROCESS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    write_whole(child_pid, &child.id().to_string())?;
    Ok(())
}

/// A copy of this program that stands in for a test's shell script on Windows: where `<name>.shell`
/// lies beside it, it runs `<name>.sh` in the shell that file names, with its own arguments and
/// standard streams, and gives its exit code. None where it is the fake CLI itself.
#[cfg(windows)]
fn run_script_beside() -> anyhow::Result<Option<i32>> {
    let program = std::env::current_exe()?;
    let Ok(shell) = std::fs::read_to_string(program.with_extension("shell")) else {
        return Ok(None);
    };
    // An MSYS program reads its command line by rules of its own, which lose quotes inside an
    // argument and expand patterns, braces included (`HEAD^{commit}`). The arguments go through the
    // environment instead, as FAKECLI_ARGC and FAKECLI_ARG_<n>, which the script's first lines put
    // back as its own (`install_script`); and MSYS converts no path-like argument it passes on.
    let mut shell = std::process::Command::new(shell.trim());
    shell
        .arg(program.with_extension("sh"))
        .env("MSYS", "noglob")
        .env("MSYS2_ARG_CONV_EXCL", "*");
    let mut count = 0;
    for (n, arg) in std::env::args_os().skip(1).enumerate() {
        shell.env(format!("FAKECLI_ARG_{}", n + 1), arg);
        count = n + 1;
    }
    let status = shell.env("FAKECLI_ARGC", count.to_string()).status()?;
    Ok(Some(status.code().unwrap_or(1)))
}

/// `FAKECLI_HOOKS=1`: a CLI that runs hooks as its children, as Antigravity does. Its arguments are
/// pairs of a hook's command and its input; it runs each command with the CLI's shell, gives it
/// the input and waits for it, its output going to its own, then ends 3 seconds later.
fn run_hooks() {
    let words: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|word| word.into_string().expect("hook arguments must be UTF-8"))
        .collect();
    for pair in words.chunks(2) {
        let [command, input] = pair else { break };
        let child = shell_command(command)
            .stdin(std::process::Stdio::piped())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(input.as_bytes());
            }
            let _ = child.wait();
        }
    }
    std::thread::sleep(Duration::from_secs(3));
}

/// With `FAKECLI_KEYLOG=<file>`: notes in the file `<what> <microseconds since 1970> <bytes>`, as
/// `in` when a read of its input returns and `out` once the frame that input drew is written, so
/// that a test can split a key's echo into its ways in and out.
fn note_key_time(what: &str, bytes: usize) {
    let Some(path) = std::env::var_os("FAKECLI_KEYLOG") else {
        return;
    };
    let at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_micros())
        .unwrap_or(0);
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(log, "{what} {at} {bytes}");
    }
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
