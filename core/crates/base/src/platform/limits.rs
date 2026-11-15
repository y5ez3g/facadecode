//! The open-file limit, raised when a service starts.

/// The open-file limits tried, highest first.
const WANTED_OPEN_FILES: [libc::rlim_t; 3] = [65_536, 10_240, 4_096];

/// Raises this process's open-file limit to the first of 65,536, 10,240 and 4,096 the system
/// allows, never lowering it. Every agent holds a PTY descriptor in the keeper and another in the
/// daemon, and the CLIs the keeper starts inherit its limit.
pub fn raise_open_files() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes one rlimit into `limit`.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return;
    }
    for wanted in WANTED_OPEN_FILES.map(|wanted| wanted.min(limit.rlim_max)) {
        if wanted <= limit.rlim_cur {
            return;
        }
        let raised = libc::rlimit {
            rlim_cur: wanted,
            ..limit
        };
        // SAFETY: setrlimit reads one valid rlimit.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0 {
            return;
        }
    }
}
