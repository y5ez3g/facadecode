//! Reads the arrow keys on the computer the person sits at. A terminal app that keeps the mouse can
//! send the same bytes for an arrow key and for the wheel.

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

    type Object = *const c_void;
    type CopySession = unsafe extern "C" fn() -> Object;
    type Release = unsafe extern "C" fn(Object);
    type KeyState = unsafe extern "C" fn(state: i32, key: u16) -> bool;

    pub(super) fn sees_keys() -> bool {
        key_state().is_some()
    }

    pub(super) fn arrows() -> Arrows {
        let Some(key_state) = key_state() else {
            return Arrows::default();
        };
        // SAFETY: the function only reads the session's keyboard state.
        let down = |key| unsafe { key_state(SESSION_STATE, key) };
        Arrows {
            up: down(UP_ARROW),
            down: down(DOWN_ARROW),
        }
    }

    /// `CGEventSourceKeyState`, in a desktop session. Its library loads only where a program asks
    /// for it.
    fn key_state() -> Option<KeyState> {
        static KEY_STATE: OnceLock<Option<KeyState>> = OnceLock::new();
        *KEY_STATE.get_or_init(|| {
            // SAFETY: the library stays loaded, and each function has the type it is declared with.
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
                let key_state: KeyState = std::mem::transmute(function(c"CGEventSourceKeyState")?);
                Some(key_state)
            }
        })
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

    pub(super) fn sees_keys() -> bool {
        false
    }

    pub(super) fn arrows() -> Arrows {
        Arrows::default()
    }
}
