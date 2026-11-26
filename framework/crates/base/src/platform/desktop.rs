//! The keyboard and the pointer of the computer the person sits at, for a program in a terminal that
//! keeps the mouse: it sends the same bytes for an arrow key and for the wheel, and shows its own menu
//! only for a click it does not pass on.

/// Which of the arrow keys that the wheel can stand in for are down.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Arrows {
    pub up: bool,
    pub down: bool,
}

/// Whether [`arrows`] sees the keys the person types here. It does not over SSH, in a terminal that
/// another computer can show, outside a desktop session, or on Linux.
pub fn sees_keys() -> bool {
    // Terminal multiplexers, and VS Code's remote terminals.
    const SHOWN_ELSEWHERE: [&str; 4] = ["TMUX", "STY", "ZELLIJ", "VSCODE_IPC_HOOK_CLI"];
    let shown_elsewhere = SHOWN_ELSEWHERE
        .iter()
        .any(|name| std::env::var_os(name).is_some());
    !super::over_ssh() && !shown_elsewhere && imp::sees_keys()
}

/// The arrow keys down now. None where [`sees_keys`] is false.
pub fn arrows() -> Arrows {
    imp::arrows()
}

/// Whether [`right_click_at`] and [`press_left_at`] work: on macOS, which asks the person for it, once
/// for each terminal app, and this never does.
pub fn clicks() -> bool {
    sees_keys() && imp::clicks()
}

/// Clicks the right button at `at`.
pub fn right_click_at(at: Point) {
    imp::right_click_at(at);
}

/// A place on the desktop, in the coordinates its pointer events use.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Where the pointer is now. None where [`clicks`] is false.
pub fn pointer() -> Option<Point> {
    imp::pointer()
}

/// Presses the left button at `at` and leaves it down, so that the terminal app begins its own
/// selection there while the person drags on: their release ends it.
pub fn press_left_at(at: Point) {
    imp::press_left_at(at);
}

/// Whether the left button is down.
pub fn left_button_down() -> bool {
    imp::left_button_down()
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{CStr, c_void};
    use std::sync::OnceLock;

    use super::Arrows;

    const CORE_GRAPHICS: &CStr = c"/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    /// `kCGEventSourceStateCombinedSessionState`.
    const SESSION_STATE: i32 = 0;
    const UP_ARROW: u16 = 126;
    const DOWN_ARROW: u16 = 125;
    /// `kCGSessionEventTap`.
    const SESSION_EVENT_TAP: u32 = 1;
    const LEFT_MOUSE_DOWN: u32 = 1;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const RIGHT_MOUSE_UP: u32 = 4;
    const LEFT_BUTTON: u32 = 0;
    const RIGHT_BUTTON: u32 = 1;
    /// `kCGMouseEventClickState`.
    const CLICK_STATE: u32 = 1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }

    type Object = *const c_void;
    type CopySession = unsafe extern "C" fn() -> Object;
    type Release = unsafe extern "C" fn(Object);
    type KeyIsDown = unsafe extern "C" fn(state: i32, key: u16) -> bool;
    type ButtonIsDown = unsafe extern "C" fn(state: i32, button: u32) -> bool;
    type MayPost = unsafe extern "C" fn() -> bool;
    type CreateEvent = unsafe extern "C" fn(source: Object) -> Object;
    type Location = unsafe extern "C" fn(event: Object) -> Point;
    type CreateMouseEvent =
        unsafe extern "C" fn(source: Object, kind: u32, at: Point, button: u32) -> Object;
    type SetFlags = unsafe extern "C" fn(event: Object, flags: u64);
    type SetField = unsafe extern "C" fn(event: Object, field: u32, value: i64);
    type Post = unsafe extern "C" fn(tap: u32, event: Object);

    /// The functions of Core Graphics and Core Foundation used here.
    struct Functions {
        key_is_down: KeyIsDown,
        button_is_down: ButtonIsDown,
        may_post: MayPost,
        event: CreateEvent,
        location: Location,
        mouse_event: CreateMouseEvent,
        set_flags: SetFlags,
        set_field: SetField,
        post: Post,
        release: Release,
    }

    pub(super) fn sees_keys() -> bool {
        functions().is_some()
    }

    pub(super) fn arrows() -> Arrows {
        let Some(functions) = functions() else {
            return Arrows::default();
        };
        // SAFETY: the function only reads the session's keyboard state.
        let down = |key| unsafe { (functions.key_is_down)(SESSION_STATE, key) };
        Arrows {
            up: down(UP_ARROW),
            down: down(DOWN_ARROW),
        }
    }

    pub(super) fn clicks() -> bool {
        // SAFETY: the function only reads what the person allowed.
        functions().is_some_and(|functions| unsafe { (functions.may_post)() })
    }

    pub(super) fn right_click_at(at: super::Point) {
        for kind in [RIGHT_MOUSE_DOWN, RIGHT_MOUSE_UP] {
            if !post_mouse(kind, at, RIGHT_BUTTON) {
                return;
            }
        }
    }

    pub(super) fn pointer() -> Option<super::Point> {
        let functions = functions()?;
        // SAFETY: the event made here is checked, read and released here.
        unsafe {
            let now = (functions.event)(std::ptr::null());
            if now.is_null() {
                return None;
            }
            let at = (functions.location)(now);
            (functions.release)(now);
            Some(super::Point { x: at.x, y: at.y })
        }
    }

    pub(super) fn press_left_at(at: super::Point) {
        post_mouse(LEFT_MOUSE_DOWN, at, LEFT_BUTTON);
    }

    pub(super) fn left_button_down() -> bool {
        // SAFETY: the function only reads the session's button state.
        functions().is_some_and(|functions| unsafe {
            (functions.button_is_down)(SESSION_STATE, LEFT_BUTTON)
        })
    }

    /// Posts one single click's event of `kind` for `button` at `at`; false if it could not be made.
    fn post_mouse(kind: u32, at: super::Point, button: u32) -> bool {
        let Some(functions) = functions() else {
            return false;
        };
        let at = Point { x: at.x, y: at.y };
        // SAFETY: the event made here is checked, posted and released here.
        unsafe {
            let event = (functions.mouse_event)(std::ptr::null(), kind, at, button);
            if event.is_null() {
                return false;
            }
            (functions.set_flags)(event, 0);
            (functions.set_field)(event, CLICK_STATE, 1);
            (functions.post)(SESSION_EVENT_TAP, event);
            (functions.release)(event);
        }
        true
    }

    /// The functions, in a desktop session. Their library loads only where a program asks for them.
    fn functions() -> Option<&'static Functions> {
        static FUNCTIONS: OnceLock<Option<Functions>> = OnceLock::new();
        FUNCTIONS
            .get_or_init(|| {
                // SAFETY: the library stays loaded, and each function has the type it is declared
                // with.
                unsafe {
                    let library = libc::dlopen(CORE_GRAPHICS.as_ptr(), libc::RTLD_LAZY);
                    if library.is_null() {
                        return None;
                    }
                    let function = |name: &CStr| {
                        let function = libc::dlsym(library, name.as_ptr());
                        (!function.is_null()).then_some(function)
                    };
                    let copy_session: CopySession =
                        std::mem::transmute(function(c"CGSessionCopyCurrentDictionary")?);
                    let release: Release = std::mem::transmute(function(c"CFRelease")?);
                    let session = copy_session();
                    if session.is_null() {
                        return None;
                    }
                    release(session);
                    Some(Functions {
                        key_is_down: std::mem::transmute::<*mut c_void, KeyIsDown>(function(
                            c"CGEventSourceKeyState",
                        )?),
                        button_is_down: std::mem::transmute::<*mut c_void, ButtonIsDown>(function(
                            c"CGEventSourceButtonState",
                        )?),
                        may_post: std::mem::transmute::<*mut c_void, MayPost>(function(
                            c"CGPreflightPostEventAccess",
                        )?),
                        event: std::mem::transmute::<*mut c_void, CreateEvent>(function(
                            c"CGEventCreate",
                        )?),
                        location: std::mem::transmute::<*mut c_void, Location>(function(
                            c"CGEventGetLocation",
                        )?),
                        mouse_event: std::mem::transmute::<*mut c_void, CreateMouseEvent>(
                            function(c"CGEventCreateMouseEvent")?,
                        ),
                        set_flags: std::mem::transmute::<*mut c_void, SetFlags>(function(
                            c"CGEventSetFlags",
                        )?),
                        set_field: std::mem::transmute::<*mut c_void, SetField>(function(
                            c"CGEventSetIntegerValueField",
                        )?),
                        post: std::mem::transmute::<*mut c_void, Post>(function(c"CGEventPost")?),
                        release,
                    })
                }
            })
            .as_ref()
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::{CStr, c_void};
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    };
    use windows_sys::w;

    use super::Arrows;
    pub(super) use super::no_clicks::{
        clicks, left_button_down, pointer, press_left_at, right_click_at,
    };

    const VK_UP: i32 = 0x26;
    const VK_DOWN: i32 = 0x28;
    const UOI_FLAGS: i32 = 1;
    const WSF_VISIBLE: u32 = 1;

    /// `USEROBJECTFLAGS`.
    #[repr(C)]
    #[derive(Default)]
    struct ObjectFlags {
        inherit: i32,
        reserved: i32,
        flags: u32,
    }

    type Station = unsafe extern "system" fn() -> *mut c_void;
    type Information =
        unsafe extern "system" fn(*mut c_void, i32, *mut c_void, u32, *mut u32) -> i32;
    type KeyState = unsafe extern "system" fn(key: i32) -> i16;

    pub(super) fn sees_keys() -> bool {
        key_state().is_some()
    }

    pub(super) fn arrows() -> Arrows {
        let Some(key_state) = key_state() else {
            return Arrows::default();
        };
        // SAFETY: the function only reads the desktop's keyboard state, whose sign says that the key
        // is down.
        let down = |key| unsafe { key_state(key) } < 0;
        Arrows {
            up: down(VK_UP),
            down: down(VK_DOWN),
        }
    }

    /// `GetAsyncKeyState`, on a desktop that shows windows. Its library loads only where a program
    /// asks for it.
    fn key_state() -> Option<KeyState> {
        static KEY_STATE: OnceLock<Option<KeyState>> = OnceLock::new();
        *KEY_STATE.get_or_init(|| {
            // SAFETY: the library stays loaded, and each function has the type it is declared with.
            unsafe {
                let library =
                    LoadLibraryExW(w!("user32.dll"), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
                if library.is_null() {
                    return None;
                }
                let function = |name: &CStr| GetProcAddress(library, name.as_ptr().cast());
                let station: Station = std::mem::transmute(function(c"GetProcessWindowStation")?);
                let information: Information =
                    std::mem::transmute(function(c"GetUserObjectInformationW")?);
                let mut flags = ObjectFlags::default();
                let read = information(
                    station(),
                    UOI_FLAGS,
                    (&raw mut flags).cast(),
                    size_of::<ObjectFlags>() as u32,
                    null_mut(),
                );
                if read == 0 || flags.flags & WSF_VISIBLE == 0 {
                    return None;
                }
                let key_state: KeyState = std::mem::transmute(function(c"GetAsyncKeyState")?);
                Some(key_state)
            }
        })
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::Arrows;
    pub(super) use super::no_clicks::{
        clicks, left_button_down, pointer, press_left_at, right_click_at,
    };

    pub(super) fn sees_keys() -> bool {
        false
    }

    pub(super) fn arrows() -> Arrows {
        Arrows::default()
    }
}

/// Only Attach in macOS Terminal posts clicks.
#[cfg(not(target_os = "macos"))]
mod no_clicks {
    pub(super) fn clicks() -> bool {
        false
    }

    pub(super) fn right_click_at(_: super::Point) {}

    pub(super) fn pointer() -> Option<super::Point> {
        None
    }

    pub(super) fn press_left_at(_: super::Point) {}

    pub(super) fn left_button_down() -> bool {
        false
    }
}
