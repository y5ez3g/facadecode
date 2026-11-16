//! Shows an agent's terminal in the person's terminal and forwards their keys and size changes.
//! When the connection closes, it reconnects by agent ID through the reconnect it is given and
//! redraws before sending the keys typed meanwhile. Up to 1 MiB of keys waits; keys that do not fit
//! are counted as unsent.
//!
//! Every end of an attachment restores the person's terminal exactly once and prints its note after
//! the restoration. Ctrl-] waits up to one second for the keys typed before it; termination signals
//! do not wait.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use facade_base::console::{ConsoleRead, ConsoleReader, ConsoleSignal, ConsoleSignals, VtModes};
use facade_base::daemon::{self, ScreenChange, ScreenSnapshot, ScreenTopic};
use facade_base::daemon_client::{DaemonClient, RECONNECT_DELAY};
use facade_base::jsonrpc::{self, ErrorBody, Reason};
use facade_base::operations::{CallParams, Operation};
use facade_base::paths::ClientSocket;
use facade_base::process::ProcessExit;
use facade_base::unix_process::signal_number;
use facade_base::{base64, service};

use crate::ExitText;
use crate::daemon_client::{ConnectFailure, Reconnect};

/// Ctrl-], as plain input and in the kitty keyboard encoding. In win32-input-mode it comes as a
/// key-down record of its character, which [`is_detach_record`] recognizes.
const DETACH_KEYS: [&[u8]; 2] = [b"\x1d", b"\x1b[93;5u"];
/// The longest Ctrl-] waits for the keys typed before it to be sent.
const DETACH_SEND_TIMEOUT: Duration = Duration::from_secs(1);
/// The most typed bytes that wait while there is no connection or the write is blocked.
const MAX_QUEUED_KEY_BYTES: usize = 1024 * 1024;

/// Whether raw mode is on and the person's terminal still has to be restored.
static RAW_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
/// The console modes entered after raw mode, which the restoration puts back.
static VT_MODES: Mutex<Option<VtModes>> = Mutex::new(None);
/// Whether the agent's output has switched to the alternate screen.
static ALTERNATE_SCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Held while writing to the person's terminal and while restoring it, so that none of the agent's
/// output lands in the middle of the restoration or after it.
static TERMINAL: Mutex<()> = Mutex::new(());

/// The person's terminal size, when both dimensions are nonzero.
pub(crate) fn terminal_size() -> Option<(u16, u16)> {
    let (cols, rows) = crossterm::terminal::size().ok()?;
    (cols > 0 && rows > 0).then_some((cols, rows))
}

/// Shows the agent's terminal until the person detaches or the agent exits or is removed. Whenever
/// the connection closes, `reconnect` reaches the daemon again and the watch resumes by agent ID.
/// Returns the command's exit code.
pub(crate) fn attach(
    client: DaemonClient,
    agent: &str,
    reconnect: &Reconnect,
) -> anyhow::Result<i32> {
    let mut client = client;
    // The agent takes the person's size before its snapshot; if it cannot, the watch says why.
    let _ = resize_agent(&mut client, agent);
    // The person's scrollback stays above the agent's screen, which brings its own.
    let screen = watch_screen(client, agent, true)?;
    // Reconnects use the ID, never the name the person typed.
    let input = Arc::new(AgentInput::new(screen.snapshot.agent_id.clone()));
    spawn_with(&input, AgentInput::send_queued);
    // Signal handling comes before raw mode, so that termination restores the terminal.
    follow_signals(input.clone())?;
    enter_raw_mode()?;
    spawn_with(&input, read_keys);
    let (note, code) = match follow_agent(screen, &input, reconnect) {
        Ok(end) => end.note_and_code(),
        Err(error) => (format!("attachment failed: {error:#}"), 1),
    };
    restore_terminal(&with_unsent(note, input.unsent_bytes()));
    input.detach();
    Ok(code)
}

/// Runs `work` on its own thread with the shared input.
fn spawn_with(input: &Arc<AgentInput>, work: fn(&AgentInput)) {
    let input = input.clone();
    std::thread::spawn(move || work(&input));
}

/// Turns raw mode on, then the console modes that make keys travel as bytes; from here on every end
/// of the attachment restores the terminal.
fn enter_raw_mode() -> std::io::Result<()> {
    RAW_MODE_ACTIVE.store(true, SeqCst);
    crossterm::terminal::enable_raw_mode().inspect_err(|_| RAW_MODE_ACTIVE.store(false, SeqCst))?;
    let modes = VtModes::enter().inspect_err(|_| {
        RAW_MODE_ACTIVE.store(false, SeqCst);
        let _ = crossterm::terminal::disable_raw_mode();
    })?;
    *lock_vt_modes() = Some(modes);
    Ok(())
}

/// Takes the console modes to restore, even if an earlier holder panicked.
fn lock_vt_modes() -> MutexGuard<'static, Option<VtModes>> {
    VT_MODES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why an attachment ended.
enum AttachEnd {
    Detached,
    AgentExited(ProcessExit),
    Removed,
    /// A permission, protocol or settings error stops every reconnect.
    Unreachable,
}

impl AttachEnd {
    /// The note for the person and the command's exit code.
    fn note_and_code(&self) -> (String, i32) {
        match self {
            AttachEnd::Detached => ("detached".into(), 0),
            AttachEnd::AgentExited(exit) => {
                let note = if exit.code.is_none() && exit.signal.is_none() {
                    format!("agent ended: {}", ExitText(exit))
                } else {
                    format!("the agent ended with {}", ExitText(exit))
                };
                (note, exit_code(exit))
            }
            AttachEnd::Removed => ("the agent was removed".into(), 1),
            AttachEnd::Unreachable => {
                let logs = facade_base::paths::core_dir().map_or_else(
                    |_| "the Facade logs".into(),
                    |core| core.join("logs").display().to_string(),
                );
                (format!("could not reconnect to Facade; see {logs}"), 1)
            }
        }
    }
}

/// The agent's exit code, 128 plus the number of the signal that ended it, or 1 with neither.
fn exit_code(exit: &ProcessExit) -> i32 {
    match (exit.code, exit.signal.as_deref()) {
        (Some(code), _) => code,
        (None, Some(name)) => signal_number(name).map_or(1, |number| 128 + number),
        (None, None) => 1,
    }
}

/// A watch on the agent's screen: its connection, its number and the snapshot it began with.
struct ScreenWatch {
    client: DaemonClient,
    watch: u64,
    snapshot: ScreenSnapshot,
}

/// Sizes the agent like the person's terminal, if that size is known.
fn resize_agent(client: &mut DaemonClient, agent: &str) -> anyhow::Result<()> {
    if let Some((cols, rows)) = terminal_size() {
        client.call::<daemon::AgentResize>(daemon::ResizeArgs {
            agent: agent.into(),
            cols,
            rows,
        })?;
    }
    Ok(())
}

/// Watches the agent's screen. The scrollback comes only on the first watch; after a reconnect
/// the person's terminal already shows it.
fn watch_screen(
    mut client: DaemonClient,
    agent: &str,
    include_scrollback: bool,
) -> anyhow::Result<ScreenWatch> {
    let args = daemon::ScreenWatchArgs {
        agent: agent.into(),
        keep_scrollback: true,
        include_scrollback,
    };
    let (watch, snapshot) = client.watch::<ScreenTopic>(args)?;
    Ok(ScreenWatch {
        client,
        watch,
        snapshot,
    })
}

/// Shows the agent through one connection after another until the attachment ends.
fn follow_agent(
    mut screen: ScreenWatch,
    input: &AgentInput,
    reconnect: &Reconnect,
) -> anyhow::Result<AttachEnd> {
    loop {
        if let Some(end) = show_until_closed(&mut screen, input)? {
            return Ok(end);
        }
        input.disconnected();
        if input.is_detached() {
            return Ok(AttachEnd::Detached);
        }
        let note = match screen.client.closing.clone() {
            // A newer Facade takes over: the keys handed to this connection go before the
            // response, and keys typed meanwhile wait for the next connection.
            Some(build) => {
                input.wait_for_write();
                screen.client.respond_to_closing();
                format!("Facade {build} takes over; reconnecting")
            }
            None => "connection lost; reconnecting; recent keys may not have arrived".into(),
        };
        show_note(&note);
        screen = match reconnect_screen(input, reconnect) {
            Ok(again) => again,
            Err(end) => return Ok(end),
        };
    }
}

/// Draws the snapshot, lets the input use this connection, and draws the changes. Returns how the
/// attachment ended, or None when the connection closed.
fn show_until_closed(
    screen: &mut ScreenWatch,
    input: &AgentInput,
) -> anyhow::Result<Option<AttachEnd>> {
    write_output(&screen.snapshot.redraw);
    if let Some(exit) = screen.snapshot.exit.take() {
        return Ok(Some(AttachEnd::AgentExited(exit)));
    }
    input.connected(screen.client.writer.try_clone()?);
    let snapshot_size = (screen.snapshot.cols, screen.snapshot.rows);
    if terminal_size().is_some_and(|size| size != snapshot_size) {
        input.push_resize();
    }
    loop {
        let change = screen.client.next_change::<ScreenTopic>(screen.watch);
        // Detaching shuts the connection down, whatever the read returned.
        if input.is_detached() {
            return Ok(Some(AttachEnd::Detached));
        }
        let end = match change {
            Ok(Some(ScreenChange::Output { data } | ScreenChange::Redraw { data, .. })) => {
                write_output(&data);
                continue;
            }
            Ok(Some(ScreenChange::Unknown)) => continue,
            Ok(Some(ScreenChange::Exit { exit })) => AttachEnd::AgentExited(exit),
            Ok(Some(ScreenChange::Removed)) => AttachEnd::Removed,
            Ok(None) | Err(_) => return Ok(None),
        };
        return Ok(Some(end));
    }
}

/// Reaches the daemon again and watches the same agent, trying again after [`RECONNECT_DELAY`]
/// while failures are temporary. Detaching cancels the attempt, hello included. A permission,
/// protocol or settings error, or the agent's removal, ends the attachment.
fn reconnect_screen(input: &AgentInput, reconnect: &Reconnect) -> Result<ScreenWatch, AttachEnd> {
    while !input.is_detached() {
        let mut client =
            match reconnect(&|| input.is_detached(), &mut |stream| input.opening(stream)) {
                Ok(client) => client,
                Err(ConnectFailure::Cancelled) => break,
                Err(ConnectFailure::Permanent(_)) => return Err(AttachEnd::Unreachable),
                Err(ConnectFailure::Timeout(_)) => {
                    std::thread::sleep(RECONNECT_DELAY);
                    continue;
                }
            };
        let watched = resize_agent(&mut client, &input.agent_id)
            .and_then(|()| watch_screen(client, &input.agent_id, false));
        match watched {
            Ok(screen) => return Ok(screen),
            Err(error) if not_found(&error) => return Err(AttachEnd::Removed),
            Err(_) => std::thread::sleep(RECONNECT_DELAY),
        }
    }
    Err(AttachEnd::Detached)
}

/// Whether the daemon refused because the agent does not exist.
fn not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ErrorBody>()
        .is_some_and(|body| body.data.reason == Reason::NotFound)
}

/// Queues a resize on each size change; on a termination signal, restores the terminal and exits
/// with 128 plus the signal's number.
fn follow_signals(input: Arc<AgentInput>) -> anyhow::Result<()> {
    let signals = ConsoleSignals::new()?;
    std::thread::spawn(move || {
        for signal in signals {
            let (name, number) = match signal {
                ConsoleSignal::Resized => {
                    input.push_resize();
                    continue;
                }
                ConsoleSignal::Ended { name, number } => (name, number),
            };
            let note = format!("attachment ended by {name}");
            restore_terminal(&with_unsent(note, input.unsent_bytes()));
            // A test holds the exit here, as a loaded machine can, while the agent's output
            // keeps coming.
            service::gate_for_test("attach-restored");
            std::process::exit(128 + number);
        }
    });
    Ok(())
}

/// The one reader of the person's keys and, where the console reports them with its keys, its size
/// changes: queues keys until Ctrl-] or the end of the input, then ends the attachment once the
/// keys before it are sent.
fn read_keys(input: &AgentInput) {
    let mut buffer = [0u8; 4096];
    if let Ok(mut console) = ConsoleReader::new() {
        loop {
            let read = match console.read(&mut buffer) {
                Ok(ConsoleRead::Resized) => {
                    input.push_resize();
                    continue;
                }
                Ok(ConsoleRead::Keys(read @ 1..)) => read,
                Ok(ConsoleRead::Keys(0)) | Err(_) => break,
            };
            let keys = &buffer[..read];
            let detach_at = detach_position(keys);
            // Keys before Ctrl-] in the same read still go.
            input.push_keys(&keys[..detach_at.unwrap_or(read)]);
            if detach_at.is_some() {
                break;
            }
        }
    }
    input.detach_after_sending();
}

/// Where the first Ctrl-] begins in `keys`, in any of its forms.
fn detach_position(keys: &[u8]) -> Option<usize> {
    let encoded = DETACH_KEYS
        .iter()
        .filter_map(|key| keys.windows(key.len()).position(|window| window == *key));
    let records = (0..keys.len()).filter(|&at| is_detach_record(&keys[at..]));
    encoded.chain(records).min()
}

/// Whether `keys` begins with Ctrl-] going down in win32-input-mode, which the person's console
/// uses once the agent's console host has asked for it: `CSI <vk>;<sc>;29;1;<cs>;<rc>_`, a key-down
/// record of the character 0x1D, whatever the key, scan code and modifier state.
fn is_detach_record(keys: &[u8]) -> bool {
    let Some(record) = keys.strip_prefix(b"\x1b[") else {
        return false;
    };
    let length = record
        .iter()
        .take_while(|&&byte| byte.is_ascii_digit() || byte == b';')
        .count();
    if record.get(length) != Some(&b'_') {
        return false;
    }
    let fields: Vec<&[u8]> = record[..length].split(|&byte| byte == b';').collect();
    fields.len() == 6 && fields[2] == b"29" && fields[3] == b"1"
}

/// The person's input on its way to the agent. Readers queue keys and size changes; one writer
/// thread sends them as notifications on the current connection, without holding the queue while
/// it writes, so a blocked write never holds up typing, signals, detaching or counting.
///
/// At most [`MAX_QUEUED_KEY_BYTES`] wait; keys that do not fit are counted. Keys handed to a
/// connection are never sent again, even when the write fails, since they may have arrived.
struct AgentInput {
    agent_id: String,
    queue: Mutex<InputQueue>,
    /// Wakes the writer for new input, a new connection or the end, and wakes whoever waits for a
    /// write to end.
    wake: Condvar,
}

#[derive(Default)]
struct InputQueue {
    waiting: VecDeque<Outgoing>,
    /// The key bytes in `waiting`.
    waiting_key_bytes: usize,
    /// Typed bytes that did not fit.
    dropped_bytes: usize,
    /// The connection to send on; none while disconnected. A failed write ends it only if it is
    /// still the one the write used.
    connection: Option<Arc<ClientSocket>>,
    /// Whether the writer is sending something it took from `waiting`.
    writing: bool,
    /// A connection being opened; detaching shuts it down so that the reconnect returns.
    opening: Option<ClientSocket>,
    /// Ctrl-], the end of the person's input or the end of the attachment.
    detached: bool,
}

/// Input for the agent, in the order the person made it.
enum Outgoing {
    /// Typed keys.
    Keys(Vec<u8>),
    /// A size change; the size is read when it is sent.
    Resize,
}

impl Outgoing {
    /// The notification that sends this to the agent; none for a resize without a known size.
    fn line(self, agent: &str) -> Option<Vec<u8>> {
        match self {
            Outgoing::Keys(keys) => Some(notification::<daemon::AgentType>(daemon::TypeArgs {
                agent: agent.into(),
                raw: Some(base64::encode(&keys)),
                ..Default::default()
            })),
            Outgoing::Resize => {
                let (cols, rows) = terminal_size()?;
                let args = daemon::ResizeArgs {
                    agent: agent.into(),
                    cols,
                    rows,
                };
                Some(notification::<daemon::AgentResize>(args))
            }
        }
    }
}

/// An operation as a notification line: a call without an ID, which the daemon does not respond to.
fn notification<O: Operation>(args: O::Args) -> Vec<u8> {
    let params = CallParams {
        op: O::NAME.into(),
        args: serde_json::to_value(args).expect("protocol value must serialize"),
    };
    jsonrpc::encode_line(&jsonrpc::Request::new(None, daemon::methods::CALL, params))
}

impl AgentInput {
    fn new(agent_id: String) -> Self {
        AgentInput {
            agent_id,
            queue: Mutex::default(),
            wake: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, InputQueue> {
        self.queue.lock().unwrap()
    }

    fn is_detached(&self) -> bool {
        self.lock().detached
    }

    /// Queues a size change, unless one already waits.
    fn push_resize(&self) {
        let mut queue = self.lock();
        let waits = queue.waiting.iter().any(|o| matches!(o, Outgoing::Resize));
        if !waits {
            queue.waiting.push_back(Outgoing::Resize);
            self.wake.notify_all();
        }
    }

    /// Queues typed keys, or counts them as dropped when they do not fit.
    fn push_keys(&self, keys: &[u8]) {
        if keys.is_empty() {
            return;
        }
        let mut queue = self.lock();
        if queue.waiting_key_bytes + keys.len() > MAX_QUEUED_KEY_BYTES {
            queue.dropped_bytes += keys.len();
            return;
        }
        if queue.connection.is_none() {
            service::mark_for_test("attach-buffered-input");
        }
        queue.waiting_key_bytes += keys.len();
        if let Some(Outgoing::Keys(waiting)) = queue.waiting.back_mut() {
            waiting.extend_from_slice(keys);
        } else {
            queue.waiting.push_back(Outgoing::Keys(keys.to_vec()));
        }
        self.wake.notify_all();
    }

    /// Hands the writer a new connection to send the waiting input on.
    fn connected(&self, connection: ClientSocket) {
        let mut queue = self.lock();
        queue.opening = None;
        queue.connection = Some(Arc::new(connection));
        self.wake.notify_all();
    }

    fn disconnected(&self) {
        self.lock().connection = None;
    }

    /// Notes a connection being opened, so that detaching can shut it down. False once the
    /// attachment has ended.
    fn opening(&self, stream: &ClientSocket) -> bool {
        let mut queue = self.lock();
        queue.opening = stream.try_clone().ok();
        !queue.detached
    }

    /// Waits until the write in progress, if any, has ended. Later input waits for the next
    /// connection.
    fn wait_for_write(&self) {
        let queue = self.lock();
        drop(self.wake.wait_while(queue, |queue| queue.writing).unwrap());
    }

    /// Ends the attachment after Ctrl-], once the keys typed before it are sent or after
    /// [`DETACH_SEND_TIMEOUT`].
    fn detach_after_sending(&self) {
        let sending =
            |q: &mut InputQueue| q.connection.is_some() && (q.writing || !q.waiting.is_empty());
        let (queue, _) = self
            .wake
            .wait_timeout_while(self.lock(), DETACH_SEND_TIMEOUT, sending)
            .unwrap();
        self.end(queue);
    }

    fn detach(&self) {
        self.end(self.lock());
    }

    /// Ends the attachment: shuts down the current connection and any being opened, which wakes
    /// the screen reader and interrupts a blocked write.
    fn end(&self, mut queue: MutexGuard<'_, InputQueue>) {
        queue.detached = true;
        let current = queue.connection.as_deref();
        for stream in current.into_iter().chain(&queue.opening) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        self.wake.notify_all();
    }

    /// Typed bytes still waiting or dropped. Bytes handed to a connection do not count.
    fn unsent_bytes(&self) -> usize {
        let queue = self.lock();
        queue.waiting_key_bytes + queue.dropped_bytes
    }

    /// The writer thread: sends the waiting input in order until the attachment ends.
    fn send_queued(&self) {
        while let Some((connection, outgoing)) = self.next_to_send() {
            let sent = match outgoing.line(&self.agent_id) {
                Some(line) => (&*connection).write_all(&line),
                None => Ok(()),
            };
            let mut queue = self.lock();
            queue.writing = false;
            let still_current = queue
                .connection
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &connection));
            if sent.is_err() && still_current {
                queue.connection = None;
            }
            // Ctrl-] or a takeover may wait for this write.
            self.wake.notify_all();
        }
    }

    /// Waits for input and a connection, then takes the next input with the connection to send it
    /// on. None once the attachment has ended.
    fn next_to_send(&self) -> Option<(Arc<ClientSocket>, Outgoing)> {
        let mut queue = self.lock();
        while !queue.detached {
            if let Some(connection) = queue.connection.clone()
                && let Some(outgoing) = queue.waiting.pop_front()
            {
                if let Outgoing::Keys(keys) = &outgoing {
                    queue.waiting_key_bytes -= keys.len();
                }
                queue.writing = true;
                return Some((connection, outgoing));
            }
            queue = self.wake.wait(queue).unwrap();
        }
        None
    }
}

/// Takes the person's terminal for writing, even if an earlier writer panicked.
fn lock_terminal() -> MutexGuard<'static, ()> {
    TERMINAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Takes the person's terminal while it is the attachment's; none once it is restored.
fn attached_terminal() -> Option<MutexGuard<'static, ()>> {
    let terminal = lock_terminal();
    RAW_MODE_ACTIVE.load(SeqCst).then_some(terminal)
}

/// Writes to the person's terminal. The caller holds [`TERMINAL`].
fn write_terminal(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

/// Writes the agent's terminal bytes, base64 as the daemon sends them, while the person's terminal
/// is the attachment's. After the restoration more output would turn the agent's modes back on and
/// cover the note.
fn write_output(data: &str) {
    let Ok(bytes) = base64::decode(data) else {
        return;
    };
    if let Some(_terminal) = attached_terminal() {
        track_alternate_screen(&bytes);
        write_terminal(&bytes);
    }
}

/// Follows alternate-screen modes 1049, 1047 and 47, also inside combined mode sequences, and the
/// full reset `ESC c`. The daemon forwards whole sequences.
fn track_alternate_screen(bytes: &[u8]) {
    let mut rest = bytes;
    while let Some(escape) = rest.iter().position(|&byte| byte == 0x1b) {
        rest = &rest[escape + 1..];
        if rest.first() == Some(&b'c') {
            ALTERNATE_SCREEN_ACTIVE.store(false, SeqCst);
            continue;
        }
        let Some(params) = rest.strip_prefix(b"[?") else {
            continue;
        };
        let length = params
            .iter()
            .take_while(|&&byte| byte.is_ascii_digit() || byte == b';')
            .count();
        let on = match params.get(length) {
            Some(b'h') => true,
            Some(b'l') => false,
            _ => continue,
        };
        let mut modes = params[..length].split(|&byte| byte == b';');
        if modes.any(|mode| matches!(mode, b"1049" | b"1047" | b"47")) {
            ALTERNATE_SCREEN_ACTIVE.store(on, SeqCst);
        }
        rest = &params[length + 1..];
    }
}

/// Shows a note on the bottom row while reconnecting. It saves and restores the cursor around the
/// note and keeps it narrower than the terminal so that nothing scrolls; the redraw after
/// reconnecting replaces both.
fn show_note(note: &str) {
    let Some(_terminal) = attached_terminal() else {
        return;
    };
    let width = terminal_size().map_or(80, |(cols, _)| usize::from(cols));
    let shown: String = format!("[facade: {note}]")
        .chars()
        .take(width.saturating_sub(1))
        .collect();
    write_terminal(format!("\x1b7\x1b[999;1H\x1b[0m\x1b[2K{shown}\x1b8").as_bytes());
}

/// Restores plain text, visible cursor, normal keyboard and keypad modes, wrapping, ASCII charset,
/// and full-screen scrolling. Disables paste, mouse, focus, win32-input-mode and
/// synchronized-update modes; pops kitty flags and resets modifyOtherKeys. Preserves the cursor
/// position.
const RESTORE_TERMINAL_SEQUENCE: &[u8] =
    b"\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?\
      1006l\x1b[?1015l\x1b[?1004l\x1b[?9001l\x1b[<u\x1b[>4m\x1b[?2026l\x1b[?7h\x1b(B\x0f\x1b7\
      \x1b[r\x1b8";

/// Restores the person's terminal and prints why the attachment ended below the agent's screen.
/// Only the first call does anything, so a signal cannot restore a half-restored terminal again.
/// The sequences go out while the console still reads them; then its modes go back, those entered
/// after raw mode first.
fn restore_terminal(note: &str) {
    let _terminal = lock_terminal();
    if !RAW_MODE_ACTIVE.swap(false, SeqCst) {
        return;
    }
    write_terminal(&restoration(note));
    drop(lock_vt_modes().take());
    let _ = crossterm::terminal::disable_raw_mode();
}

/// What restores the person's terminal, with the note below the agent's screen.
fn restoration(note: &str) -> Vec<u8> {
    // CAN ends any escape sequence the agent's output left open.
    let mut restoration = b"\x18".to_vec();
    if ALTERNATE_SCREEN_ACTIVE.load(SeqCst) {
        restoration.extend_from_slice(b"\x1b[?1049l");
    }
    restoration.extend_from_slice(RESTORE_TERMINAL_SEQUENCE);
    // From the last row, the line feed scrolls the agent's screen up above the note.
    restoration.extend_from_slice(format!("\x1b[999;1H\r\n[facade: {note}]\r\n").as_bytes());
    restoration
}

/// Adds how many typed bytes were not sent, if any.
fn with_unsent(note: String, unsent: usize) -> String {
    match unsent {
        0 => note,
        _ => format!("{note}; {unsent} typed bytes were not sent"),
    }
}

#[cfg(test)]
mod tests {
    use facade_base::sockets::{self, ServerSocket};
    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::*;

    /// The daemon's end of a connection, read on a runtime of its own.
    struct Daemon {
        end: BufReader<ServerSocket>,
        runtime: tokio::runtime::Runtime,
    }

    /// Reads one `agent.type` notification and decodes its keys; fails after 5 seconds.
    fn typed(daemon: &mut Daemon) -> Vec<u8> {
        let mut line = String::new();
        let read = daemon.end.read_line(&mut line);
        let read = daemon
            .runtime
            .block_on(async { tokio::time::timeout(Duration::from_secs(5), read).await });
        read.unwrap().unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            (request["params"]["op"].as_str(), request.get("id")),
            (Some("agent.type"), None),
            "{request}"
        );
        base64::decode(request["params"]["args"]["raw"].as_str().unwrap()).unwrap()
    }

    /// An input queue with its writer thread running.
    fn input() -> Arc<AgentInput> {
        let input = Arc::new(AgentInput::new("a1".into()));
        spawn_with(&input, AgentInput::send_queued);
        input
    }

    /// A connection for the input and the daemon's end of it.
    fn connection() -> (ClientSocket, Daemon) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (writer, end) = {
            let _entered = runtime.enter();
            sockets::pair().unwrap()
        };
        let end = BufReader::new(end);
        (writer, Daemon { end, runtime })
    }

    #[test]
    fn keys_typed_while_disconnected_are_kept_up_to_a_mebibyte_and_sent_once_on_reconnect() {
        let input = input();
        input.push_keys(b"typed offline");
        input.push_keys(&vec![b'x'; MAX_QUEUED_KEY_BYTES - 13]);
        input.push_keys(b"too many");
        assert_eq!(
            input.unsent_bytes(),
            MAX_QUEUED_KEY_BYTES + 8,
            "kept and dropped keys both count as not sent"
        );
        let (writer, mut daemon) = connection();
        input.connected(writer);
        let kept = typed(&mut daemon);
        assert!(
            kept.starts_with(b"typed offline") && kept.len() == MAX_QUEUED_KEY_BYTES,
            "the kept keys arrive in one message, in order"
        );
        input.push_keys(b"online");
        assert_eq!(typed(&mut daemon), b"online");
        assert_eq!(
            input.unsent_bytes(),
            8,
            "the dropped keys stay counted for the final note"
        );
        input.detach();
    }

    #[test]
    fn keys_handed_to_a_lost_connection_are_never_sent_again() {
        let input = input();
        let (writer, daemon) = connection();
        input.connected(writer);
        drop(daemon);
        // The write fails, so whether these keys arrived is unknown: they are neither kept nor
        // counted as unsent.
        input.push_keys(b"maybe delivered");
        let disconnected = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            input.lock().connection.is_none()
        });
        assert!(disconnected, "the failed write ends the connection");
        assert_eq!(input.unsent_bytes(), 0);
        input.push_keys(b"offline");
        let (writer, mut daemon) = connection();
        input.connected(writer);
        assert_eq!(typed(&mut daemon), b"offline");
        input.detach();
    }

    #[test]
    fn a_blocked_write_never_holds_up_typing_counting_or_detaching() {
        let input = input();
        // The daemon reads nothing, so the writer soon blocks in a write.
        let (writer, daemon) = connection();
        input.connected(writer);
        let chunk = vec![b'k'; 64 * 1024];
        let maximum_unsent = 40 * chunk.len();
        let (done, finished) = std::sync::mpsc::channel();
        let work = std::thread::spawn(move || {
            for _ in 0..8 {
                input.push_keys(&chunk);
            }
            std::thread::sleep(Duration::from_millis(300));
            for _ in 0..32 {
                input.push_keys(&chunk);
            }
            let unsent = input.unsent_bytes();
            input.detach();
            done.send(unsent).unwrap();
        });
        let result = finished.recv_timeout(Duration::from_secs(5));
        // Release a blocked write before reporting a failure.
        drop(daemon);
        let unsent = result
            .expect("typing, counting, and detaching did not finish while the write was blocked");
        work.join().unwrap();
        assert!(unsent > 0 && unsent <= maximum_unsent, "{unsent}");
    }

    #[test]
    fn tracks_alternate_screen_modes_and_reset() {
        // The state before, the output, and the state after.
        let cases: [(bool, &[u8], bool); 6] = [
            (false, b"\x1b[?1049h", true),
            (true, b"\x1b[?1049l", false),
            (false, b"text\x1b[?25;1049h more", true),
            (true, b"\x1b[?1049;25l", false),
            (false, b"\x1b[?47hx\x1bc", false),
            (false, b"\x1b[?10490h", false),
        ];
        for (before, bytes, after) in cases {
            ALTERNATE_SCREEN_ACTIVE.store(before, SeqCst);
            track_alternate_screen(bytes);
            let now = ALTERNATE_SCREEN_ACTIVE.load(SeqCst);
            assert_eq!(now, after, "{}", String::from_utf8_lossy(bytes));
        }
    }
}
