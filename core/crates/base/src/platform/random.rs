//! Random bytes from the operating system.

/// Eight random bytes from the operating system, for keys and names nobody may guess. Panics if
/// the system cannot give them, which a supported system never fails to, as the standard library
/// does for its own keys.
#[cfg(unix)]
pub fn random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    // SAFETY: the buffer holds the 8 bytes asked for.
    match unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } {
        0 => u64::from_ne_bytes(bytes),
        _ => panic!("no random bytes: {}", std::io::Error::last_os_error()),
    }
}

/// Eight random bytes from the operating system, for keys and names nobody may guess. Panics if
/// the system cannot give them, which a supported system never fails to, as the standard library
/// does for its own keys.
#[cfg(windows)]
pub fn random_u64() -> u64 {
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut bytes = [0u8; 8];
    // SAFETY: the buffer holds the 8 bytes asked for; no algorithm handle is needed with the
    // system's preferred generator.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    match status {
        0 => u64::from_ne_bytes(bytes),
        _ => panic!("no random bytes: NTSTATUS {status:#x}"),
    }
}
