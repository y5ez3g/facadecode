//! Random bytes from the operating system.

/// Eight random bytes read from `/dev/urandom`, which macOS and Linux (glibc and musl) all have,
/// for keys and names nobody may guess. Panics if the system cannot give them, which a supported
/// system never fails to, as the standard library does for its own keys.
#[cfg(unix)]
pub fn random_u64() -> u64 {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    if let Err(error) =
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))
    {
        panic!("no random bytes from /dev/urandom: {error}");
    }
    u64::from_ne_bytes(bytes)
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
