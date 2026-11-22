//! Shows an agent's terminal in the person's terminal and forwards their keys and size changes.
//! When the connection closes, it reconnects by the agent's stored reference and redraws before
//! resuming input. Keys still waiting or typed while disconnected are discarded and counted.
//!
//! Every end of an attachment restores the person's terminal exactly once and reports the result to
//! stderr. Ctrl-] waits up to one second for the keys typed before it. Termination signals do not wait.

use std::collections::VecDeque;
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use facade_base::api_v1::daemon::{
    AgentInfo, AgentInspect, AgentRef, AgentTarget, AgentTargetArgs, AttachArgs, AttachResizeArgs,
    AttachShellTopic, AttachTopic, MachineQuery, ProcessState, ScreenChange, ScreenSnapshot,
    attach_resize_line, raw_input_line,
};
use facade_base::api_v1::daemon_client::{
    Cut, DaemonClient, takeover_timeout, transient_transport,
};
use facade_base::api_v1::{ErrorBody, ProcessExit, Size, Topic};
use facade_base::console::{
    ConsoleRead, ConsoleReader, ConsoleSignal, ConsoleSignals, VtModes, visible_content_end,
};
use facade_base::paths::ClientSocket;
use facade_base::unix_process::signal_number;
use facade_base::{base64, service, system};
use facade_screen::{ParsedOutput, REDRAW_SCROLLBACK_ROWS, Screen};
use unicode_width::UnicodeWidthChar;

use crate::daemon_client::{ConnectFailure, Reconnect};
use crate::errors::{AgentCommand, agent_failed, agent_label, cause, machine_query_detail};
use crate::{ExitText, Opening, agent_address, single_line};

/// Ctrl-], as plain input and in the kitty keyboard encoding. In win32-input-mode it comes as a
/// key-down record of its character, which [`is_detach_record`] recognizes.
const DETACH_KEYS: [&[u8]; 2] = [b"\x1d", b"\x1b[93;5u"];
/// The longest Ctrl-] waits for the keys typed before it to be sent.
const DETACH_SEND_TIMEOUT: Duration = Duration::from_secs(1);
/// The wait between attempts to reconnect an attached terminal.
const RECONNECT_DELAY: Duration = Duration::from_millis(500);
const RECONNECT_TIMED_OUT: &str = "the terminal did not reconnect in time";
/// The most typed bytes that wait while a connected writer is busy.
const MAX_QUEUED_KEY_BYTES: usize = 1024 * 1024;

/// Whether raw mode is on and the person's terminal still has to be restored.
static RAW_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
/// The console modes entered after raw mode, which the restoration puts back.
static VT_MODES: Mutex<Option<VtModes>> = Mutex::new(None);
/// Held while writing to the person's terminal and while restoring it, so that none of the agent's
/// output lands in the middle of the restoration or after it.
static TERMINAL: Mutex<Display> = Mutex::new(Display {
    shared: None,
    host_alternate: false,
    main_prepared: false,
});

/// The person's terminal size, when both dimensions are nonzero.
pub(crate) fn console_size() -> Option<(u16, u16)> {
    let (cols, rows) = crossterm::terminal::size().ok()?;
    (cols > 0 && rows > 0).then_some((cols, rows))
}

/// Shows the agent's terminal until the person detaches or the agent exits or is removed. Whenever
/// the connection closes, `reconnect` reaches the daemon again and the watch resumes at the
/// agent's stored reference.
/// Returns the command's exit code.
pub(crate) fn attach(
    mut client: DaemonClient,
    target: AgentTarget,
    opening: Opening,
    reconnect: &Reconnect,
) -> anyhow::Result<i32> {
    // A foreground start or resume already used its connection for a call.
    if !matches!(opening, Opening::Attached) && supports_dedicated_watch(&client) {
        drop(client);
        client = connect_before_input(reconnect)?;
    }
    let hostname = system::hostname().unwrap_or_else(|_| client.hello_result.machine_id.clone());
    let viewer = format!("Terminal on {hostname}");
    let address = match &target {
        AgentTarget::Selector(agent) => agent.clone(),
        AgentTarget::Reference(reference) => agent_address(reference, None),
    };
    let allow_ended =
        !matches!(opening, Opening::Attached) && matches!(target, AgentTarget::Reference(_));
    // The person's scrollback stays above the agent's screen, which brings its own.
    let watched = match watch_first(&mut client, &target, &viewer, allow_ended, reconnect) {
        Ok(watched) => watched,
        Err(error) if allow_ended && watch_reason(&error) == Some("ended") => {
            let agent = inspect_agent(&mut client, target);
            let shown = agent.as_ref().map_or_else(
                || single_line(&address),
                |agent| agent_label(Some(&agent.name), &agent.address),
            );
            let end = AttachEnd::AgentExited {
                exit: agent.and_then(|agent| agent.exit),
                status: None,
            };
            let code = end.code();
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(
                stderr,
                "{}\n{}",
                opening_line(&opening, &shown),
                result_line(&end, &shown, &address)
            );
            return Ok(code);
        }
        Err(error) => return Err(opening_error(&address, error)),
    };
    let snapshot = &watched.snapshot;
    let shown = agent_label(snapshot.name.as_deref(), &snapshot.address);
    let input = Arc::new(AgentInput::new(
        snapshot.reference.clone(),
        snapshot.address.clone(),
    ));
    input.lock().agent_name.clone_from(&snapshot.name);
    let screen = ScreenWatch { client, watched };
    // Register before entering raw mode so a termination signal can be handled even during setup.
    let signals = ConsoleSignals::new()?;
    let _ = writeln!(std::io::stderr(), "{}", opening_line(&opening, &shown));
    enter_raw_mode()?;
    follow_signals(signals, input.clone());
    let end = follow_agent(screen, &input, &viewer, reconnect);
    let code = end.as_ref().map_or(1, AttachEnd::code);
    finish_attachment(&input, end);
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
pub(crate) enum AttachEnd {
    Detached,
    AgentExited {
        exit: Option<ProcessExit>,
        status: Option<i32>,
    },
    Removed,
    Unreachable(String),
    Signal(String),
}

impl AttachEnd {
    fn code(&self) -> i32 {
        match self {
            AttachEnd::Detached => 0,
            AttachEnd::AgentExited { exit, status, .. } => {
                status.unwrap_or_else(|| exit.as_ref().map_or(1, exit_code))
            }
            AttachEnd::Removed | AttachEnd::Unreachable(_) => 1,
            AttachEnd::Signal(name) => signal_number(name).map_or(1, |number| 128 + number),
        }
    }
}

/// The line shown before the first redraw.
pub(crate) fn opening_line(opening: &Opening, shown: &str) -> String {
    let began = match opening {
        Opening::Started => format!("Started {shown}."),
        Opening::Resumed => format!("Resumed {shown}."),
        Opening::SavedSession { cli } => {
            format!("Started {shown} from a saved {} session.", single_line(cli))
        }
        Opening::Attached => format!("Attached to {shown}."),
    };
    format!("{began} Press Ctrl+] to detach.")
}

/// The result shown after restoring the person's terminal.
pub(crate) fn result_line(end: &AttachEnd, shown: &str, address: &str) -> String {
    match end {
        AttachEnd::Detached => format!("Detached from {shown}. The agent is still running."),
        AttachEnd::AgentExited {
            exit: Some(exit), ..
        } if exit.code.is_some() => {
            format!("{shown} exited with {}.", ExitText(exit))
        }
        AttachEnd::AgentExited {
            exit: Some(exit), ..
        } if exit.signal.is_some() => {
            format!("{shown} exited on signal {}.", ExitText(exit))
        }
        AttachEnd::AgentExited {
            status: Some(status),
            ..
        } => {
            format!("{shown} exited with status {status}.")
        }
        AttachEnd::AgentExited { .. } => {
            format!("{shown} exited. Facade could not confirm its exit status.")
        }
        AttachEnd::Removed => format!("error: {shown} was removed"),
        AttachEnd::Unreachable(why) => format!("error: {}", lost_connection(shown, address, why)),
        AttachEnd::Signal(name) => format!("Attachment ended by {name}."),
    }
}

fn lost_connection(shown: &str, address: &str, why: &str) -> String {
    format!(
        "Lost connection to {shown}: {}\nReattach with 'facade attach {address}', or check 'facade machine list'.",
        single_line(why)
    )
}

/// Presents a refusal of the first watch using only records visible to this caller.
fn opening_error(address: &str, error: anyhow::Error) -> anyhow::Error {
    let unavailable_address = address.contains('@')
        && matches!(
            watch_reason(&error),
            Some("unavailable" | "ssh_interaction_required")
        )
        && error
            .downcast_ref::<ErrorBody>()
            .and_then(|body| body.data.details.as_ref())
            .and_then(|details| details.get("unanswered"))
            .and_then(serde_json::Value::as_array)
            .is_none_or(Vec::is_empty);
    if unavailable_address || error.is::<Cut>() {
        let address = single_line(address);
        return anyhow::anyhow!(lost_connection(
            &address,
            &address,
            &connection_reason(&error)
        ));
    }
    agent_failed(AgentCommand::Attach, address, error)
}

/// Prefers the current query's SSH diagnostic when the daemon has one.
fn connection_reason(error: &anyhow::Error) -> String {
    machine_connection_reason(error).unwrap_or_else(|| cause(error))
}

fn machine_connection_reason(error: &anyhow::Error) -> Option<String> {
    let body = error.downcast_ref::<ErrorBody>()?;
    let details = body.data.details.as_ref()?;
    if body.data.reason == "ssh_interaction_required" {
        return details.get("message")?.as_str().map(str::to_owned);
    }
    if let Some(machines) = details
        .get("machines")
        .and_then(serde_json::Value::as_array)
        && let [machine] = machines.as_slice()
        && let Ok(machine) = serde_json::from_value::<MachineQuery>(machine.clone())
        && machine.error.is_some()
    {
        return Some(machine_query_detail(&machine));
    }
    details
        .get("machine")?
        .is_object()
        .then(|| body.message.clone())
}

/// The final warning when typed input was left waiting or dropped.
pub(crate) fn unsent_line(unsent: usize) -> Option<String> {
    (unsent > 0).then(|| format!("warning: {unsent} bytes you typed were not sent"))
}

/// The notice after the first redraw on the restored connection.
pub(crate) fn reconnected_line(shown: &str, unsent: usize) -> Option<String> {
    (unsent > 0).then(|| format!(
        "Reconnected to {shown}. {unsent} bytes typed while disconnected were not sent; check the screen and retype if needed."
    ))
}

/// Computes the exit code using the local signal table when an older peer omitted its status.
fn exit_code(exit: &ProcessExit) -> i32 {
    match (exit.code, exit.signal.as_deref()) {
        (Some(code), _) => code,
        (None, Some(name)) => signal_number(name).map_or(1, |number| 128 + number),
        (None, None) => 1,
    }
}

/// A watch on the agent's screen and the connection that owns it.
struct ScreenWatch {
    client: DaemonClient,
    watched: WatchedScreen,
}

struct WatchedScreen {
    watch: u64,
    snapshot: ScreenSnapshot,
    capacity: Option<(u16, u16)>,
    include_scrollback: bool,
}

/// An initial watch refused during takeover starts again with the replacement's hello.
fn watch_first(
    client: &mut DaemonClient,
    target: &AgentTarget,
    viewer: &str,
    allow_ended: bool,
    reconnect: &Reconnect,
) -> anyhow::Result<WatchedScreen> {
    let watched = watch_screen(client, target.clone(), viewer, true, allow_ended);
    if watched
        .as_ref()
        .is_err_and(|error| watch_reason(error) == Some("upgrading"))
    {
        *client = connect_before_input(reconnect)?;
        return watch_screen(client, target.clone(), viewer, true, allow_ended);
    }
    watched
}

fn connect_before_input(reconnect: &Reconnect) -> Result<DaemonClient, ConnectFailure> {
    reconnect(Instant::now() + takeover_timeout(), &|| false, &mut |_| {
        true
    })
}

fn supports_dedicated_watch(client: &DaemonClient) -> bool {
    client
        .hello_result
        .topics
        .iter()
        .any(|topic| topic == AttachShellTopic::NAME)
}

/// Watches the agent's screen. The scrollback comes only on the first watch; after a reconnect
/// the person's terminal already shows it.
fn watch_screen(
    client: &mut DaemonClient,
    target: AgentTarget,
    viewer: &str,
    include_scrollback: bool,
    allow_ended: bool,
) -> anyhow::Result<WatchedScreen> {
    // Attach manages reconnection so input stays bound to the socket and watch that drew the view.
    client.disable_auto_reconnect();
    let capacity = console_size();
    let args = AttachArgs {
        target,
        keep_scrollback: true,
        include_scrollback,
        viewer: Some(viewer.into()),
        allow_ended,
        report_activity: false,
        size: capacity
            .filter(|&(cols, _)| cols >= 2)
            .map(|(cols, rows)| Size { cols, rows }),
    };
    let (watch, snapshot) = if supports_dedicated_watch(client) {
        client.watch::<AttachShellTopic>(args)?
    } else {
        client.watch::<AttachTopic>(args)?
    };
    Ok(WatchedScreen {
        watch,
        snapshot,
        capacity,
        include_scrollback,
    })
}

/// Shows the agent through one connection after another until the attachment ends.
fn follow_agent(
    mut screen: ScreenWatch,
    input: &Arc<AgentInput>,
    viewer: &str,
    reconnect: &Reconnect,
) -> anyhow::Result<AttachEnd> {
    if let Some(end) = show_snapshot(&mut screen, input)? {
        return Ok(end);
    }
    spawn_with(input, AgentInput::send_queued);
    spawn_with(input, read_keys);
    loop {
        let failure = match show_until_closed(&mut screen, input) {
            Ok(Some(end)) => return Ok(end),
            Ok(None) => None,
            Err(error) => Some(error),
        };
        let closing = screen.client.closing.is_some();
        input.disconnected(closing);
        if let Some(mut terminal) = attached_terminal() {
            terminal.shared = None;
        }
        service::mark_for_test("attach-disconnected");
        if input.is_detached() {
            return Ok(AttachEnd::Detached);
        }
        if closing {
            // The old daemon gets only the write already in progress before the reply.
            input.wait_for_write();
            screen.client.respond_to_closing();
        }
        screen = match reconnect_screen(input, viewer, reconnect, failure) {
            Ok(again) => again,
            Err(end) => return Ok(end),
        };
        if let Some(end) = show_snapshot(&mut screen, input)? {
            return Ok(end);
        }
        service::mark_for_test("attach-reconnected");
    }
}

/// Draws the current screen before enabling its connection for keys and size changes.
fn show_snapshot(
    screen: &mut ScreenWatch,
    input: &AgentInput,
) -> anyhow::Result<Option<AttachEnd>> {
    // Keep the redraw, displayed identity and notice together so restoration sees one snapshot.
    let Some(mut terminal) = attached_terminal() else {
        return Ok(Some(AttachEnd::Detached));
    };
    let watched = &mut screen.watched;
    let snapshot = &mut watched.snapshot;
    let grid = (snapshot.size.cols, snapshot.size.rows);
    let capacity = console_size();
    terminal.draw_frame(&snapshot.redraw, grid, capacity, watched.include_scrollback);
    {
        let mut queue = input.lock();
        queue.agent_name.clone_from(&snapshot.name);
        queue.address.clone_from(&snapshot.address);
        queue.reported_size = watched.capacity;
        queue
            .waiting
            .retain(|item| !matches!(item, Outgoing::Resize));
    }
    let status = snapshot.exit_status;
    if snapshot.process == Some(ProcessState::Ended) || snapshot.exit.is_some() || status.is_some()
    {
        return Ok(Some(AttachEnd::AgentExited {
            exit: snapshot.exit.take(),
            status,
        }));
    }
    input.push_resize(capacity);
    let Some(loss) = input.connected(screen.client.writer.try_clone()?, watched.watch) else {
        return Ok(Some(AttachEnd::Detached));
    };
    if loss.queued > 0 || loss.disconnected > 0 {
        let shown = agent_label(snapshot.name.as_deref(), &snapshot.address);
        let queued = (loss.queued > 0).then(|| {
            format!(
                "warning: {} bytes queued before disconnect were not sent",
                loss.queued
            )
        });
        let notice: Vec<String> = reconnected_line(&shown, loss.disconnected)
            .into_iter()
            .chain(queued)
            .collect();
        show_status(&notice.join("\n"));
    }
    Ok(None)
}

/// Draws changes. Returns how the attachment ended, or None when the connection closed.
fn show_until_closed(
    screen: &mut ScreenWatch,
    input: &AgentInput,
) -> anyhow::Result<Option<AttachEnd>> {
    let watch = screen.watched.watch;
    // Changes are keyed by watch ID, and both Attach topics decode the same ScreenChange.
    while let Some(change) = screen.client.next_change::<AttachTopic>(watch)? {
        // Detaching shuts the connection down, whatever the read returned.
        if input.is_detached() {
            return Ok(Some(AttachEnd::Detached));
        }
        return Ok(Some(match change {
            ScreenChange::Output { data } => {
                if let Some(mut terminal) = attached_terminal() {
                    terminal.write_output(&data);
                }
                continue;
            }
            ScreenChange::Redraw { data, size } => {
                if let Some(mut terminal) = attached_terminal() {
                    terminal.draw_frame(&data, (size.cols, size.rows), console_size(), false);
                }
                continue;
            }
            ScreenChange::Activity { .. } | ScreenChange::Unknown => continue,
            ScreenChange::Exit {
                exit, exit_status, ..
            } => AttachEnd::AgentExited {
                exit: Some(exit),
                status: exit_status,
            },
            ScreenChange::Removed => AttachEnd::Removed,
        }));
    }
    Ok(None)
}

/// Reaches the daemon again and watches the same agent. The existing retry delay also applies to
/// an unavailable remote route. All attempts share the time allowed for a daemon handover.
fn reconnect_screen(
    input: &AgentInput,
    viewer: &str,
    reconnect: &Reconnect,
    mut last_failure: Option<anyhow::Error>,
) -> Result<ScreenWatch, AttachEnd> {
    let deadline = Instant::now() + takeover_timeout();
    while !input.is_detached() && Instant::now() < deadline {
        let connection = reconnect(deadline, &|| input.is_detached(), &mut |stream| {
            input.opening(stream)
        });
        if input.is_detached() {
            break;
        }
        let mut client = match connection {
            Ok(client) => client,
            Err(ConnectFailure::Cancelled) => break,
            Err(ConnectFailure::Permanent(error)) => {
                return Err(AttachEnd::Unreachable(connection_reason(&error)));
            }
            Err(ConnectFailure::Timeout(error)) => {
                keep_reconnect_failure(&mut last_failure, error);
                input.wait_before_reconnect(deadline);
                continue;
            }
        };
        let watched = watch_before(&mut client, input.target(), viewer, deadline);
        if input.is_detached() {
            break;
        }
        let error = match watched {
            Ok(watched) => return Ok(ScreenWatch { client, watched }),
            Err(error) => error,
        };
        match watch_reason(&error) {
            Some("not_found") => return Err(AttachEnd::Removed),
            Some("ended") => {
                let exit = set_watch_timeout(&client, deadline)
                    .ok()
                    .and_then(|()| inspect_agent(&mut client, input.target()))
                    .and_then(|agent| agent.exit);
                if input.is_detached() {
                    break;
                }
                return Err(AttachEnd::AgentExited { exit, status: None });
            }
            _ if retryable_watch(&error) => {
                keep_reconnect_failure(&mut last_failure, error);
                input.wait_before_reconnect(deadline);
            }
            _ => return Err(AttachEnd::Unreachable(connection_reason(&error))),
        }
    }
    if input.is_detached() {
        return Err(AttachEnd::Detached);
    }
    let why = last_failure
        .as_ref()
        .filter(|error| !error.is::<Cut>())
        .map_or_else(|| RECONNECT_TIMED_OUT.into(), connection_reason);
    Err(AttachEnd::Unreachable(why))
}

/// A local transport failure must not replace the current diagnostic from the remote machine.
fn keep_reconnect_failure(last: &mut Option<anyhow::Error>, failure: anyhow::Error) {
    if !failure.is::<Cut>()
        && (last.as_ref().and_then(machine_connection_reason).is_none()
            || machine_connection_reason(&failure).is_some())
    {
        *last = Some(failure);
    }
}

/// The remaining reconnect time also applies to the screen request on the new connection.
fn watch_before(
    client: &mut DaemonClient,
    target: AgentTarget,
    viewer: &str,
    deadline: Instant,
) -> anyhow::Result<WatchedScreen> {
    set_watch_timeout(client, deadline)?;
    let watched = watch_screen(client, target, viewer, false, true)?;
    client.writer.set_read_timeout(None)?;
    client.writer.set_write_timeout(None)?;
    Ok(watched)
}

fn set_watch_timeout(client: &DaemonClient, deadline: Instant) -> std::io::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            RECONNECT_TIMED_OUT,
        ));
    }
    client.writer.set_read_timeout(Some(remaining))?;
    client.writer.set_write_timeout(Some(remaining))
}

/// Reads the run's exit record if the watch returned an ended refusal.
fn inspect_agent(client: &mut DaemonClient, target: AgentTarget) -> Option<AgentInfo> {
    client
        .call::<AgentInspect>(AgentTargetArgs { target })
        .ok()
        .map(|inspected| inspected.agent)
}

fn retryable_watch(error: &anyhow::Error) -> bool {
    matches!(
        watch_reason(error),
        Some("unavailable" | "upgrading" | "ssh_interaction_required")
    ) || error.is::<Cut>()
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(transient_transport)
}

/// The daemon's reason for refusing the watch.
fn watch_reason(error: &anyhow::Error) -> Option<&str> {
    error
        .downcast_ref::<ErrorBody>()
        .map(|body| body.data.reason.as_str())
}

/// Queues a resize on each size change; on a termination signal, restores the terminal and exits
/// with 128 plus the signal's number.
fn follow_signals(signals: ConsoleSignals, input: Arc<AgentInput>) {
    std::thread::spawn(move || {
        for signal in signals {
            let (name, number) = match signal {
                ConsoleSignal::Resized => {
                    input.resized();
                    continue;
                }
                ConsoleSignal::Ended { name, number } => (name, number),
            };
            finish_attachment(&input, Ok(AttachEnd::Signal(name.into())));
            // A test holds the exit here, as a loaded machine can, while the agent's output
            // keeps coming.
            service::gate_for_test("attach-restored");
            std::process::exit(128 + number);
        }
    });
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
                    input.resized();
                    continue;
                }
                Ok(ConsoleRead::Wheel {
                    col,
                    row,
                    delta,
                    modifiers,
                }) => {
                    if let Some(terminal) = attached_terminal()
                        && let Some(shared) = &terminal.shared
                        && let Some(keys) = shared.screen.encode_wheel(col, row, delta, modifiers)
                    {
                        input.push_keys(&keys);
                    }
                    continue;
                }
                Ok(ConsoleRead::Keys(read @ 1..)) => read,
                Ok(ConsoleRead::Keys(0)) | Err(_) => break,
            };
            let keys = &buffer[..read];
            let detach_at = detach_position(keys);
            // Keys before Ctrl-] in the same read still go.
            input.push_keys(&keys[..detach_at.unwrap_or(read)]);
            if let Some(at) = detach_at {
                finish_detach_release(&mut console, &keys[at..]);
                break;
            }
        }
    }
    input.detach_after_sending();
}

/// Removes the queued releases of the ConPTY Ctrl-] chord, including a record split by the read.
fn finish_detach_release(console: &mut ConsoleReader, keys: &[u8]) {
    let Some(mut rest) = keys.strip_prefix(b"\x1b[221;27;29;1;8;1_") else {
        return;
    };
    // The bracket key-up may carry either zero or the character from its key-down event.
    for release in [b"\x1b[221;27;0;0;8;1_".as_slice(), b"\x1b[221;27;29;0;8;1_"] {
        if let Some(tail) = rest.strip_prefix(release) {
            rest = tail;
            break;
        }
        if let Some(missing) = release.strip_prefix(rest)
            && console.discard_key_prefix(missing).unwrap_or(false)
        {
            rest = &[];
            break;
        }
    }
    if let Some(missing) = b"\x1b[17;29;0;0;0;1_".strip_prefix(rest)
        && !missing.is_empty()
    {
        let _ = console.discard_key_prefix(missing);
    }
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
    /// The identity of the agent from the first snapshot.
    reference: AgentRef,
    queue: Mutex<InputQueue>,
    /// Wakes the writer for new input, a new connection or the end, and wakes whoever waits for a
    /// write to end.
    wake: Condvar,
}

#[derive(Default)]
struct InputQueue {
    /// Display identity from the snapshot most recently drawn.
    agent_name: Option<String>,
    address: String,
    /// The last capacity sent or queued, initially the watch size.
    reported_size: Option<(u16, u16)>,
    waiting: VecDeque<Outgoing>,
    /// The key bytes in `waiting`.
    waiting_key_bytes: usize,
    /// Typed bytes discarded because the connected queue was full.
    overflow_key_bytes: usize,
    reconnect_loss: ReconnectLoss,
    /// The connection to send on; none while disconnected. A failed write ends it only if it is
    /// still the one the write used.
    connection: Option<InputConnection>,
    /// Whether the writer is sending something it took from `waiting`.
    writing: bool,
    /// A connection opening or finishing a takeover write; detaching shuts it down.
    opening: Option<Arc<ClientSocket>>,
    /// Ctrl-], the end of the person's input or the end of the attachment.
    detached: bool,
}

#[derive(Clone)]
struct InputConnection {
    socket: Arc<ClientSocket>,
    watch: u64,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ReconnectLoss {
    /// Bytes still in the connected queue when the connection closed.
    queued: usize,
    /// Bytes typed while disconnected, before the next full redraw.
    disconnected: usize,
}

impl InputQueue {
    /// Drops input that has not been handed to the old connection.
    fn clear_connection(&mut self) -> Option<Arc<ClientSocket>> {
        self.reconnect_loss.queued += std::mem::take(&mut self.waiting_key_bytes);
        self.waiting.clear();
        self.connection.take().map(|connection| connection.socket)
    }
}

/// Input for the agent, in the order the person made it.
enum Outgoing {
    /// Typed keys.
    Keys(Vec<u8>),
    /// A size change; the size is read when it is sent.
    Resize,
}

impl Outgoing {
    /// The notification for this connection, if it accepts the reported size.
    fn line(self, reference: &AgentRef, watch: u64) -> Option<Vec<u8>> {
        match self {
            Outgoing::Keys(keys) => Some(raw_input_line(reference.clone(), &keys)),
            Outgoing::Resize => {
                let (cols, rows) = console_size().filter(|&(cols, _)| cols >= 2)?;
                Some(attach_resize_line(AttachResizeArgs {
                    watch,
                    size: Size { cols, rows },
                    colors: None,
                }))
            }
        }
    }
}

impl AgentInput {
    fn new(reference: AgentRef, address: String) -> Self {
        AgentInput {
            reference,
            queue: Mutex::new(InputQueue {
                address,
                ..InputQueue::default()
            }),
            wake: Condvar::new(),
        }
    }

    fn target(&self) -> AgentTarget {
        AgentTarget::Reference(self.reference.clone())
    }

    fn lock(&self) -> MutexGuard<'_, InputQueue> {
        self.queue.lock().unwrap()
    }

    fn is_detached(&self) -> bool {
        self.lock().detached
    }

    /// Waits until the retry delay elapses or the person detaches.
    fn wait_before_reconnect(&self, deadline: Instant) {
        let delay = deadline
            .saturating_duration_since(Instant::now())
            .min(RECONNECT_DELAY);
        drop(
            self.wake
                .wait_timeout_while(self.lock(), delay, |queue| !queue.detached)
                .unwrap(),
        );
    }

    /// Refreshes the local drawing and reports capacity independently of the shared grid.
    fn resized(&self) {
        let Some(mut terminal) = attached_terminal() else {
            return;
        };
        let capacity = console_size();
        self.push_resize(capacity);
        if let Some(shared) = &mut terminal.shared
            && shared.capacity != capacity
        {
            shared.capacity = capacity;
            terminal.draw(false, None);
        }
    }

    /// Queues a changed capacity, coalescing repeated console events and waiting resizes.
    fn push_resize(&self, size: Option<(u16, u16)>) {
        let mut queue = self.lock();
        if size.is_none() || queue.reported_size == size {
            return;
        }
        queue.reported_size = size;
        let waits = queue.waiting.iter().any(|o| matches!(o, Outgoing::Resize));
        if !waits {
            queue.waiting.push_back(Outgoing::Resize);
            self.wake.notify_all();
        }
    }

    /// Queues typed keys, or counts them as dropped when disconnected or the queue is full.
    fn push_keys(&self, keys: &[u8]) {
        if keys.is_empty() {
            return;
        }
        let mut queue = self.lock();
        if queue.connection.is_none() {
            queue.reconnect_loss.disconnected += keys.len();
            // The reconnect failure scenario waits for this point before releasing its peer.
            service::mark_for_test("attach-buffered-input");
            return;
        }
        if queue.waiting_key_bytes + keys.len() > MAX_QUEUED_KEY_BYTES {
            queue.overflow_key_bytes += keys.len();
            return;
        }
        queue.waiting_key_bytes += keys.len();
        if let Some(Outgoing::Keys(waiting)) = queue.waiting.back_mut() {
            waiting.extend_from_slice(keys);
        } else {
            queue.waiting.push_back(Outgoing::Keys(keys.to_vec()));
        }
        self.wake.notify_all();
    }

    /// Enables the writer and takes the unsent counts to report after the redraw.
    fn connected(&self, socket: ClientSocket, watch: u64) -> Option<ReconnectLoss> {
        let mut queue = self.lock();
        if queue.detached {
            return None;
        }
        queue.opening = None;
        queue.connection = Some(InputConnection {
            socket: Arc::new(socket),
            watch,
        });
        self.wake.notify_all();
        Some(std::mem::take(&mut queue.reconnect_loss))
    }

    /// Stops handing input to the old connection. A forwarded watch can end while the socket
    /// is open, so only a planned takeover lets its current write finish.
    fn disconnected(&self, closing: bool) {
        let mut queue = self.lock();
        if let Some(connection) = queue.clear_connection() {
            if closing {
                queue.opening = Some(connection);
            } else {
                let _ = connection.shutdown(std::net::Shutdown::Both);
            }
        }
        self.wake.notify_all();
    }

    /// Notes a connection being opened, so that detaching can shut it down. False once the
    /// attachment has ended.
    fn opening(&self, stream: &ClientSocket) -> bool {
        let mut queue = self.lock();
        queue.opening = stream.try_clone().ok().map(Arc::new);
        !queue.detached
    }

    /// Waits until the write in progress, if any, has ended.
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
        let current = queue.connection.as_ref().map(|conn| conn.socket.as_ref());
        for stream in current.into_iter().chain(queue.opening.as_deref()) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        self.wake.notify_all();
    }

    /// Typed bytes still waiting or dropped. Bytes handed to a connection do not count.
    fn unsent_bytes(&self) -> usize {
        let queue = self.lock();
        queue.waiting_key_bytes
            + queue.overflow_key_bytes
            + queue.reconnect_loss.queued
            + queue.reconnect_loss.disconnected
    }

    /// The writer thread: sends the waiting input in order until the attachment ends.
    fn send_queued(&self) {
        while let Some((connection, outgoing)) = self.next_to_send() {
            let sent = match outgoing.line(&self.reference, connection.watch) {
                Some(line) => (&*connection.socket).write_all(&line),
                None => Ok(()),
            };
            let mut queue = self.lock();
            queue.writing = false;
            let still_current = queue
                .connection
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.socket, &connection.socket));
            if sent.is_err() && still_current {
                let _ = queue.clear_connection();
                let _ = connection.socket.shutdown(std::net::Shutdown::Both);
            }
            // Ctrl-] or a takeover may wait for this write.
            self.wake.notify_all();
        }
    }

    /// Waits for input and a connection, then takes the next input with the connection to send it
    /// on. None once the attachment has ended.
    fn next_to_send(&self) -> Option<(InputConnection, Outgoing)> {
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
fn lock_terminal() -> MutexGuard<'static, Display> {
    TERMINAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Takes the person's terminal while it is the attachment's; none once it is restored.
fn attached_terminal() -> Option<MutexGuard<'static, Display>> {
    let terminal = lock_terminal();
    RAW_MODE_ACTIVE.load(SeqCst).then_some(terminal)
}

/// Writes to the person's terminal. The caller holds [`TERMINAL`].
fn write_terminal(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

/// The terminal drawing for the current watch, held under the same lock as its writes.
struct Display {
    shared: Option<SharedScreen>,
    /// The buffer selected on the host, which stays in place when a watch disconnects.
    host_alternate: bool,
    /// Whether a full draw has already made room in main-screen history.
    main_prepared: bool,
}

impl Display {
    fn draw_frame(
        &mut self,
        data: &str,
        grid: (u16, u16),
        capacity: Option<(u16, u16)>,
        include_scrollback: bool,
    ) {
        let Ok(bytes) = base64::decode(data) else {
            return;
        };
        let scrollback = if include_scrollback {
            REDRAW_SCROLLBACK_ROWS
        } else {
            0
        };
        let mut frame = SharedScreen {
            screen: Screen::new(grid.0, grid.1, scrollback),
            capacity,
        };
        let output = frame.screen.feed(&bytes);
        capture_mouse(frame.screen.reports_mouse());
        self.shared = Some(frame);
        self.draw(include_scrollback, Some(&output));
    }

    fn write_output(&mut self, data: &str) {
        let Some(shared) = &mut self.shared else {
            return;
        };
        let Ok(bytes) = base64::decode(data) else {
            return;
        };
        let mouse = shared.screen.reports_mouse();
        let alternate = shared.screen.on_alternate_screen();
        let output = shared.screen.feed(&bytes);
        let reports_mouse = shared.screen.reports_mouse();
        if reports_mouse != mouse {
            capture_mouse(reports_mouse);
        }
        if !fits(shared.grid(), shared.capacity) {
            write_activity(&output);
            return;
        }
        let first_draw = !self.main_prepared && !self.host_alternate;
        if first_draw || alternate != shared.screen.on_alternate_screen() {
            self.draw(first_draw, Some(&output));
        } else if shared.uses_viewport() {
            write_activity(&output);
            write_terminal(&shared.screen.redraw_in_viewport_update());
        } else {
            self.host_alternate = alternate_screen_after(self.host_alternate, &bytes);
            write_terminal(&bytes);
        }
    }

    /// Repaints the selected buffer for a snapshot, a resize or a buffer change.
    fn draw(&mut self, include_scrollback: bool, output: Option<&ParsedOutput>) {
        let Some(shared) = &self.shared else {
            return;
        };
        let alternate = shared.screen.on_alternate_screen();
        let first_main = !alternate && !self.main_prepared;
        // An empty first main screen can be followed by a CLI that only uses the alternate screen.
        let empty_main = first_main && shared.screen.text(1).is_empty();
        if let Some(output) = output {
            if empty_main && output.title_change.is_some() {
                write_terminal(&shared.screen.title_output());
            }
            write_activity(output);
        }
        if !fits(shared.grid(), shared.capacity) {
            if !empty_main {
                show_too_small(shared.grid());
            }
            return;
        }
        if alternate != self.host_alternate {
            write_terminal(if alternate {
                b"\x1b[?1049h"
            } else {
                b"\x1b[?1049l"
            });
            self.host_alternate = alternate;
        }
        if empty_main {
            return;
        }
        if first_main {
            // Scroll from the shell's cursor before any absolute positioning or erasing.
            let rows = shared.capacity.unwrap_or_else(|| shared.grid()).1;
            write_terminal(&b"\r\n".repeat(usize::from(rows)));
            self.main_prepared = true;
        }
        let viewport = shared.uses_viewport();
        write_terminal(
            &shared
                .screen
                .redraw_for_attach(viewport, include_scrollback),
        );
    }

    /// Place the receipt after the last row of text, even when the cursor is already below it.
    fn content_end(&self) -> Option<u16> {
        let shared = self.shared.as_ref().filter(|shared| {
            fits(shared.grid(), shared.capacity) && !shared.screen.on_alternate_screen()
        });
        shared.map_or_else(visible_content_end, |shared| {
            let last_text = shared
                .screen
                .view()
                .rows
                .iter()
                .rposition(|row| row.iter().any(|cell| cell.text != " "))
                .unwrap_or_default();
            Some((last_text + 1) as u16)
        })
    }
}

/// Forwards the CLI's own window activity when rendering replaces the original bytes.
fn write_activity(output: &ParsedOutput) {
    if !output.native_activity.is_empty() {
        write_terminal(&output.native_activity);
    }
}

/// Native capture follows the CLI's mouse reporting mode. The console modes are restored on exit.
fn capture_mouse(enabled: bool) {
    if let Some(modes) = lock_vt_modes().as_ref() {
        let _ = modes.set_mouse_capture(enabled);
    }
}

/// The daemon's grid, replayed at the confirmed size even when it cannot currently be drawn.
struct SharedScreen {
    screen: Screen,
    capacity: Option<(u16, u16)>,
}

impl SharedScreen {
    fn grid(&self) -> (u16, u16) {
        (self.screen.cols(), self.screen.rows())
    }

    fn uses_viewport(&self) -> bool {
        self.capacity.is_some_and(|size| size != self.grid())
    }
}

fn fits((cols, rows): (u16, u16), capacity: Option<(u16, u16)>) -> bool {
    capacity.is_none_or(|(width, height)| width >= cols && height >= rows)
}

fn show_too_small((cols, rows): (u16, u16)) {
    show_status(&format!(
        "The shared layout is {cols}×{rows}. Enlarge this terminal to see the current screen."
    ));
}

/// Tracks host buffer switches in native passthrough, including legacy modes 1047 and 47.
/// The daemon forwards whole sequences.
fn alternate_screen_after(mut alternate: bool, bytes: &[u8]) -> bool {
    let mut rest = bytes;
    while let Some(escape) = rest.iter().position(|&byte| byte == 0x1b) {
        rest = &rest[escape + 1..];
        if rest.first() == Some(&b'c') {
            alternate = false;
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
            alternate = on;
        }
        rest = &params[length + 1..];
    }
    alternate
}

/// Writes the notice to stderr. On a console it uses the bottom rows without scrolling.
/// The caller holds [`TERMINAL`].
fn show_status(note: &str) {
    let mut stderr = std::io::stderr().lock();
    if !stderr.is_terminal() {
        let _ = writeln!(stderr, "{note}");
        return;
    }
    let (cols, rows) = console_size().unwrap_or((80, 24));
    let width = usize::from(cols).saturating_sub(1);
    let lines: Vec<_> = note
        .lines()
        .flat_map(|line| wrap_status(line, width))
        .collect();
    let lines = &lines[lines.len().saturating_sub(usize::from(rows))..];
    let mut output = String::from("\x1b7\x1b[999;1H\x1b[0m");
    if lines.len() > 1 {
        use std::fmt::Write as _;
        let _ = write!(output, "\x1b[{}A", lines.len() - 1);
    }
    output.push_str("\x1b[2K");
    output.push_str(&lines.join("\x1b[1B\r\x1b[2K"));
    output.push_str("\x1b8");
    let _ = stderr.write_all(output.as_bytes());
    let _ = stderr.flush();
}

/// Breaks a console notice at spaces where possible while keeping every word.
fn wrap_status(mut note: &str, width: usize) -> Vec<&str> {
    let mut lines = Vec::new();
    while let Some(first) = note.chars().next() {
        let mut used = 0;
        let end = note
            .char_indices()
            .find_map(|(at, ch)| {
                used += ch.width().unwrap_or(0);
                (used > width).then_some(at)
            })
            .unwrap_or(note.len())
            .max(first.len_utf8());
        let end = if end < note.len() && !note[end..].starts_with(' ') {
            note[..end].rfind(' ').filter(|&at| at > 0).unwrap_or(end)
        } else {
            end
        };
        lines.push(&note[..end]);
        note = note[end..].trim_start_matches(' ');
    }
    lines
}

/// Restores plain text, visible cursor, normal keyboard and keypad modes, wrapping, ASCII charset,
/// and full-screen scrolling. Disables paste, mouse, alternate scroll, focus, win32-input-mode and
/// synchronized-update modes; pops kitty flags and resets modifyOtherKeys. Preserves the cursor
/// position.
const RESTORE_TERMINAL_SEQUENCE: &[u8] =
    b"\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?\
      1006l\x1b[?1007l\x1b[?1015l\x1b[?1004l\x1b[?9001l\x1b[<u\x1b[>4m\x1b[?2026l\x1b[?7h\x1b(B\x0f\x1b7\
      \x1b[r\x1b8";

/// Restores the person's terminal and writes the result and any unsent warning to stderr.
/// Only the first call does anything, so a signal cannot restore a half-restored terminal again.
/// The sequences go out while the console still reads them; then its modes go back, those entered
/// after raw mode first.
fn finish_attachment(input: &AgentInput, end: anyhow::Result<AttachEnd>) {
    let mut terminal = lock_terminal();
    if !RAW_MODE_ACTIVE.swap(false, SeqCst) {
        return;
    }
    let alternate = terminal.host_alternate;
    write_terminal(&restoration(alternate));
    if !alternate && terminal.main_prepared {
        let row = terminal.content_end().unwrap_or(999);
        write_terminal(format!("\x1b[?6l\x1b[{row};1H\r\n").as_bytes());
    }
    terminal.shared = None;
    drop(lock_vt_modes().take());
    let _ = crossterm::terminal::disable_raw_mode();

    let line = match end {
        Ok(end) => {
            let queue = input.lock();
            let shown = agent_label(queue.agent_name.as_deref(), &queue.address);
            result_line(&end, &shown, &queue.address)
        }
        Err(error) => format!("error: attachment failed: {error:#}"),
    };
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
    if let Some(warning) = unsent_line(input.unsent_bytes()) {
        let _ = writeln!(stderr, "{warning}");
    }
}

/// Restores the terminal's display modes and returns from the alternate screen when active.
fn restoration(alternate: bool) -> Vec<u8> {
    // CAN ends any escape sequence the agent's output left open.
    let mut restoration = b"\x18".to_vec();
    if alternate {
        restoration.extend_from_slice(b"\x1b[?1049l");
    }
    restoration.extend_from_slice(RESTORE_TERMINAL_SEQUENCE);
    restoration
}

#[cfg(test)]
mod tests {
    use facade_base::sockets::{self, ServerSocket};
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::*;

    const MACHINE_ID: &str = "11111111-2222-4333-8444-555555555555";
    const WATCH_ID: u64 = 7;

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
        assert_eq!(request["jsonrpc"], "2.0");
        assert_eq!(request["method"], "call");
        assert_eq!(request["params"]["op"], "agent.type");
        assert!(request.get("id").is_none(), "{request}");
        let args = &request["params"]["args"];
        assert_eq!(
            args["target"],
            json!({ "machine_id": MACHINE_ID, "agent_id": "a1" })
        );
        assert_eq!(args["input"]["kind"], "raw");
        base64::decode(args["input"]["raw"].as_str().unwrap()).unwrap()
    }

    /// An input queue with the target fixed by its first snapshot.
    fn input() -> Arc<AgentInput> {
        let reference = AgentRef {
            machine_id: MACHINE_ID.into(),
            agent_id: "a1".into(),
        };
        Arc::new(AgentInput::new(reference, "a1@devbox".into()))
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
    fn queued_keys_and_keys_typed_while_disconnected_are_counted_and_never_replayed() {
        // Leave the writer idle so all the connected keys are still waiting at disconnect.
        let input = input();
        let (old_writer, _old_daemon) = connection();
        assert_eq!(
            input.connected(old_writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
        input.push_keys(&vec![b'x'; MAX_QUEUED_KEY_BYTES]);
        input.push_keys(b"too many");
        input.disconnected(false);
        let offline = "离线".as_bytes();
        input.push_keys(offline);
        assert_eq!(
            input.unsent_bytes(),
            MAX_QUEUED_KEY_BYTES + offline.len() + 8,
            "the final warning would include every unreported byte"
        );
        let (writer, mut daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss {
                queued: MAX_QUEUED_KEY_BYTES,
                disconnected: 6,
            }),
            "the notices distinguish queued bytes from bytes typed while disconnected"
        );
        spawn_with(&input, AgentInput::send_queued);
        input.push_keys(b"online");
        assert_eq!(typed(&mut daemon), b"online");
        assert_eq!(
            input.unsent_bytes(),
            8,
            "only the connected overflow remains for the final warning"
        );
        input.detach();
    }

    #[test]
    fn keys_handed_to_a_lost_connection_are_never_sent_again() {
        let input = input();
        spawn_with(&input, AgentInput::send_queued);
        let (writer, daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
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
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss {
                queued: 0,
                disconnected: 7,
            })
        );
        input.push_keys(b"online");
        assert_eq!(typed(&mut daemon), b"online");
        assert_eq!(input.unsent_bytes(), 0);
        input.detach();
    }

    #[test]
    fn a_blocked_write_never_holds_up_typing_counting_or_detaching() {
        let input = input();
        spawn_with(&input, AgentInput::send_queued);
        // The daemon reads nothing, so the writer soon blocks in a write.
        let (writer, daemon) = connection();
        assert_eq!(
            input.connected(writer, WATCH_ID),
            Some(ReconnectLoss::default())
        );
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
            let now = alternate_screen_after(before, bytes);
            assert_eq!(now, after, "{}", String::from_utf8_lossy(bytes));
        }
    }
}
