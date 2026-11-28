use std::collections::VecDeque;
use std::ffi::{CStr, c_void};
use std::ptr::{NonNull, null};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, mpsc};
use std::thread::{self, JoinHandle};

use super::{Arrow, Arrows, CursorEvent, CursorSample};

const CORE_GRAPHICS: &CStr = c"/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const SESSION_STATE: i32 = 0;
const HID_STATE: i32 = 1;
const UP_ARROW: u16 = 126;
const DOWN_ARROW: u16 = 125;
const KEY_DOWN: u32 = 10;
const SCROLL_WHEEL: u32 = 22;
const KEY_CODE: u32 = 9;
const SCROLL_LINES: u32 = 11;
const SCROLL_CONTINUOUS: u32 = 88;
const SCROLL_POINTS: u32 = 96;
// Shift, Control, Option, Command and Fn can produce a different sequence or a host shortcut.
const CURSOR_MODIFIERS: u64 = 0x009e_0000;
const MAX_EVENTS: usize = 256;

type Object = *const c_void;
type Callback = unsafe extern "C" fn(Object, u32, Object, *mut c_void) -> Object;
type KeyState = unsafe extern "C" fn(i32, u16) -> bool;
type ListenAccess = unsafe extern "C" fn() -> bool;
type WatchEvents = unsafe extern "C" fn(i32, u32, u32, u64, Callback, *mut c_void) -> Object;
type ReadField = unsafe extern "C" fn(Object, u32) -> i64;
type ReadFlags = unsafe extern "C" fn(Object) -> u64;

#[repr(C)]
struct SourceContext {
    version: isize,
    info: *mut c_void,
    retain: Option<unsafe extern "C" fn(Object) -> Object>,
    release: Option<unsafe extern "C" fn(Object)>,
    copy_description: Option<unsafe extern "C" fn(Object) -> Object>,
    equal: Option<unsafe extern "C" fn(Object, Object) -> u8>,
    hash: Option<unsafe extern "C" fn(Object) -> usize>,
    schedule: Option<unsafe extern "C" fn(*mut c_void, Object, Object)>,
    cancel: Option<unsafe extern "C" fn(*mut c_void, Object, Object)>,
    perform: unsafe extern "C" fn(*mut c_void),
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: Object;
    fn CFRetain(object: Object) -> Object;
    fn CFRelease(object: Object);
    fn CFMachPortCreateRunLoopSource(allocator: Object, port: Object, order: isize) -> Object;
    fn CFMachPortInvalidate(port: Object);
    fn CFRunLoopGetCurrent() -> Object;
    fn CFRunLoopAddSource(run_loop: Object, source: Object, mode: Object);
    fn CFRunLoopRemoveSource(run_loop: Object, source: Object, mode: Object);
    fn CFRunLoopRun();
    fn CFRunLoopStop(run_loop: Object);
    fn CFRunLoopWakeUp(run_loop: Object);
    fn CFRunLoopSourceCreate(
        allocator: Object,
        order: isize,
        context: *mut SourceContext,
    ) -> Object;
    fn CFRunLoopSourceInvalidate(source: Object);
    fn CFRunLoopSourceSignal(source: Object);
}

struct Quartz {
    key_state: KeyState,
    listen_access: ListenAccess,
    tap: WatchEvents,
    read_field: ReadField,
    flags: ReadFlags,
}

fn quartz() -> Option<&'static Quartz> {
    static QUARTZ: OnceLock<Option<Quartz>> = OnceLock::new();
    QUARTZ
        .get_or_init(|| {
            // SAFETY: the library stays loaded, and each symbol has its declared ABI.
            unsafe {
                let library = libc::dlopen(CORE_GRAPHICS.as_ptr(), libc::RTLD_LAZY);
                let library = NonNull::new(library)?;
                let function = |name: &CStr| {
                    NonNull::new(libc::dlsym(library.as_ptr(), name.as_ptr())).map(NonNull::as_ptr)
                };
                let session: unsafe extern "C" fn() -> Object =
                    std::mem::transmute(function(c"CGSessionCopyCurrentDictionary")?);
                let session = session();
                if session.is_null() {
                    return None;
                }
                CFRelease(session);
                Some(Quartz {
                    key_state: std::mem::transmute::<*mut c_void, KeyState>(function(
                        c"CGEventSourceKeyState",
                    )?),
                    listen_access: std::mem::transmute::<*mut c_void, ListenAccess>(function(
                        c"CGPreflightListenEventAccess",
                    )?),
                    tap: std::mem::transmute::<*mut c_void, WatchEvents>(function(
                        c"CGEventTapCreateForPid",
                    )?),
                    read_field: std::mem::transmute::<*mut c_void, ReadField>(function(
                        c"CGEventGetIntegerValueField",
                    )?),
                    flags: std::mem::transmute::<*mut c_void, ReadFlags>(function(
                        c"CGEventGetFlags",
                    )?),
                })
            }
        })
        .as_ref()
}

pub(super) fn sees_keys() -> bool {
    quartz().is_some()
}

pub(super) fn arrows() -> Arrows {
    let Some(quartz) = quartz() else {
        return Arrows::default();
    };
    // SAFETY: these calls only sample the two arrow keys in the current session.
    let down = |key| unsafe {
        (quartz.key_state)(SESSION_STATE, key) || (quartz.key_state)(HID_STATE, key)
    };
    Arrows {
        up: down(UP_ARROW),
        down: down(DOWN_ARROW),
    }
}

pub(super) struct CursorInput {
    input: EventQueue,
    watches_keys: bool,
    stop: StopSource,
    worker: Option<JoinHandle<()>>,
}

type EventQueue = Arc<Mutex<VecDeque<CursorEvent>>>;

impl CursorInput {
    pub(super) fn new() -> Option<Self> {
        let quartz = quartz()?;
        // A remote or synthetic terminal can declare TERM_PROGRAM, but its host events are
        // not on this process's line of ancestry.
        let program = std::env::var_os("TERM_PROGRAM")?;
        let terminal = program == "Apple_Terminal";
        let pid = super::super::unix_process::ancestors(std::process::id())
            .into_iter()
            .find(|&pid| {
                let Ok(Some(name)) = super::super::unix_process::name(pid) else {
                    return false;
                };
                (terminal && name == "Terminal")
                    || (program == "vscode"
                        && matches!(name.as_str(), "Code" | "Electron" | "Facade Code"))
            })?;
        let pid = pid.try_into().ok()?;
        let input = EventQueue::default();
        let observed = Arc::clone(&input);
        let (ready, started) = mpsc::sync_channel(1);
        // SAFETY: this checks the existing permission without requesting it.
        let watches_keys = unsafe { (quartz.listen_access)() };
        let worker = thread::Builder::new()
            .name("facade-cursor-input".into())
            .spawn(move || {
                let Some(tap) = EventTap::new(quartz, pid, terminal, watches_keys, observed) else {
                    return;
                };
                let Some(stop) = StopSource::new(tap.run_loop) else {
                    return;
                };
                if ready.send(stop).is_ok() {
                    // SAFETY: this worker owns the event tap and its run loop sources.
                    unsafe { CFRunLoopRun() };
                }
            })
            .ok()?;
        let Ok(stop) = started.recv() else {
            let _ = worker.join();
            return None;
        };
        Some(Self {
            input,
            watches_keys,
            stop,
            worker: Some(worker),
        })
    }

    pub(super) fn sample(&self) -> CursorSample {
        let held = if self.watches_keys {
            Arrows::default()
        } else {
            arrows()
        };
        let events = {
            let mut input = self.input.lock().unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut *input).into()
        };
        CursorSample::Observed { events, held }
    }
}

impl Drop for CursorInput {
    fn drop(&mut self) {
        self.stop.signal();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Runs the shutdown callback on the worker, even when the signal arrives before its run loop
/// starts. The handles keep the source and run loop alive until the worker has joined.
struct StopSource {
    source: Object,
    run_loop: Object,
}

// SAFETY: the owned Core Foundation references are used only by thread-safe source and wake calls.
unsafe impl Send for StopSource {}

impl StopSource {
    fn new(run_loop: Object) -> Option<Self> {
        let mut context = SourceContext {
            version: 0,
            info: run_loop.cast_mut(),
            retain: None,
            release: None,
            copy_description: None,
            equal: None,
            hash: None,
            schedule: None,
            cancel: None,
            perform: stop_run_loop,
        };
        // SAFETY: Core Foundation copies the context, and the retained run loop outlives it.
        unsafe {
            let source = CFRunLoopSourceCreate(null(), 0, &mut context);
            if source.is_null() {
                return None;
            }
            CFRetain(run_loop);
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            Some(Self { source, run_loop })
        }
    }

    fn signal(&self) {
        // SAFETY: both references are retained and signaling a run loop source is thread-safe.
        unsafe {
            CFRunLoopSourceSignal(self.source);
            CFRunLoopWakeUp(self.run_loop);
        }
    }
}

impl Drop for StopSource {
    fn drop(&mut self) {
        // SAFETY: the worker has exited or is still creating the source and never used it.
        unsafe {
            CFRunLoopSourceInvalidate(self.source);
            CFRelease(self.source);
            CFRelease(self.run_loop);
        }
    }
}

unsafe extern "C" fn stop_run_loop(info: *mut c_void) {
    // SAFETY: the context carries the retained run loop of the worker.
    unsafe { CFRunLoopStop(info.cast_const()) };
}

struct EventTap {
    port: Object,
    source: Object,
    run_loop: Object,
    _state: Box<EventState>,
}

struct EventState {
    input: EventQueue,
    quartz: &'static Quartz,
    terminal: bool,
}

impl EventTap {
    fn new(
        quartz: &'static Quartz,
        pid: i32,
        terminal: bool,
        watches_keys: bool,
        input: EventQueue,
    ) -> Option<Self> {
        const HEAD_INSERT: u32 = 0;
        const LISTEN_ONLY: u32 = 1;
        let state = Box::new(EventState {
            input,
            quartz,
            terminal,
        });
        let context = (&raw const *state).cast_mut().cast();
        // SAFETY: the context stays allocated, and the source is installed on this thread's
        // run loop. The tap never modifies an event or requests keyboard monitoring access.
        unsafe {
            let mut mask = 1 << SCROLL_WHEEL;
            if watches_keys {
                mask |= 1 << KEY_DOWN;
            }
            let port = (quartz.tap)(pid, HEAD_INSERT, LISTEN_ONLY, mask, observe, context);
            if port.is_null() {
                return None;
            }
            let source = CFMachPortCreateRunLoopSource(null(), port, 0);
            if source.is_null() {
                CFMachPortInvalidate(port);
                CFRelease(port);
                return None;
            }
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            Some(Self {
                port,
                source,
                run_loop,
                _state: state,
            })
        }
    }
}

impl Drop for EventTap {
    fn drop(&mut self) {
        // SAFETY: the port and source were created by this value on the current reader thread.
        unsafe {
            CFRunLoopRemoveSource(self.run_loop, self.source, kCFRunLoopDefaultMode);
            CFMachPortInvalidate(self.port);
            CFRelease(self.source);
            CFRelease(self.port);
        }
    }
}

unsafe extern "C" fn observe(_: Object, kind: u32, event: Object, context: *mut c_void) -> Object {
    // SAFETY: EventTap owns the context for the lifetime of this run-loop source.
    let state = unsafe { &*context.cast::<EventState>() };
    // SAFETY: each field is read only for the type of event it belongs to.
    let observed = unsafe {
        match kind {
            SCROLL_WHEEL => {
                let lines = (state.quartz.read_field)(event, SCROLL_LINES);
                let points = (state.quartz.read_field)(event, SCROLL_POINTS);
                let continuous = (state.quartz.read_field)(event, SCROLL_CONTINUOUS) != 0;
                wheel_event(lines, points, state.terminal, continuous)
            }
            KEY_DOWN if (state.quartz.flags)(event) & CURSOR_MODIFIERS == 0 => {
                match (state.quartz.read_field)(event, KEY_CODE) {
                    key if key == i64::from(UP_ARROW) => Some(CursorEvent::Key(Arrow::Up)),
                    key if key == i64::from(DOWN_ARROW) => Some(CursorEvent::Key(Arrow::Down)),
                    _ => None,
                }
            }
            _ => None,
        }
    };
    if let Some(observed) = observed {
        let mut input = state.input.lock().unwrap_or_else(PoisonError::into_inner);
        if input.len() == MAX_EVENTS {
            input.pop_front();
        }
        input.push_back(observed);
    }
    event
}

fn wheel_event(lines: i64, points: i64, terminal: bool, continuous: bool) -> Option<CursorEvent> {
    let direction = if lines == 0 { points } else { lines };
    let arrow = match direction.signum() {
        1 => Arrow::Up,
        -1 => Arrow::Down,
        _ => return None,
    };
    // Terminal emits one arrow per line, sometimes as separate writes. Xterm.js in VS Code
    // emits one arrow for a wheel event, accumulating smaller motions in its trackpad path
    // before emitting a sequence. A small discrete wheel event can enter that path too.
    const XTERM_TRACKPAD_POINTS: u64 = 50;
    let (count, may_skip) = if terminal {
        (lines.unsigned_abs().max(1), continuous || lines == 0)
    } else {
        (1, points.unsigned_abs() < XTERM_TRACKPAD_POINTS)
    };
    Some(CursorEvent::Wheel {
        arrow,
        count,
        may_skip,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discrete_scroll_has_a_sequence_even_when_the_next_key_is_ready() {
        assert!(matches!(
            wheel_event(24, 240, false, false),
            Some(CursorEvent::Wheel {
                arrow: Arrow::Up,
                count: 1,
                may_skip: false,
            })
        ));
        assert!(matches!(
            wheel_event(24, 240, true, false),
            Some(CursorEvent::Wheel {
                arrow: Arrow::Up,
                count: 24,
                may_skip: false,
            })
        ));
        assert!(matches!(
            wheel_event(-1, -1, false, true),
            Some(CursorEvent::Wheel {
                arrow: Arrow::Down,
                count: 1,
                may_skip: true,
            })
        ));
        assert!(matches!(
            wheel_event(-1, -10, false, false),
            Some(CursorEvent::Wheel {
                arrow: Arrow::Down,
                count: 1,
                may_skip: true,
            })
        ));
    }
}
