//! What the daemon watches of a guest besides its hooks: the CLI process whose end ends a session,
//! for a CLI with no hook for that end, and the file in which a CLI says its turn ended, for a turn
//! the person cut short.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::process::ProcessIdentity;
use facade_base::unix_process::{Observed, PROC_POLL_INTERVAL, ProcessObservation};
use tokio::sync::mpsc;

use super::roster::{Roster, SessionKey};
use super::{GuestEvent, log};

/// How often the daemon reads a working guest's session file.
const FOLLOW_EVERY: Duration = Duration::from_secs(1);
/// The longest wait between two tries to observe a process.
const MOST_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Watches process `pid` for the end of `key`'s session. A process holds one session of its own
/// at a time: one that joins from it ends those before. A process already gone ends it at once.
pub(super) async fn end_with(
    roster: &Arc<Mutex<Roster>>,
    events: &mpsc::UnboundedSender<GuestEvent>,
    key: SessionKey,
    pid: u32,
) {
    let ended = |(cli, session): SessionKey| {
        let _ = events.send(GuestEvent::Ended { cli, session });
    };
    let birth = tokio::task::spawn_blocking(move || facade_base::unix_process::birth(pid))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    let Some(birth) = birth else {
        return ended(key);
    };
    let identity = ProcessIdentity { pid, birth };
    let before: Vec<SessionKey> = {
        let mut roster = roster.lock().unwrap();
        let before = roster
            .watched
            .iter()
            .filter(|(other, watched)| {
                other.0 == key.0 && other.1 != key.1 && **watched == identity
            })
            .map(|(other, _)| other.clone())
            .collect();
        roster.watched.insert(key.clone(), identity.clone());
        before
    };
    before.into_iter().for_each(ended);
    let (roster, events) = (roster.clone(), events.clone());
    tokio::spawn(async move {
        let label = format!("{} session {}'s process {pid}", key.0, key.1);
        until_ended(&label, &identity).await;
        let still = roster.lock().unwrap().watched.get(&key) == Some(&identity);
        if still {
            let (cli, session) = key;
            let _ = events.send(GuestEvent::Ended { cli, session });
        }
    });
}

/// Returns once the process `identity` names ended: through its descriptor where it has one,
/// otherwise by looking every 250 ms. Permission and resource errors are tried again, never taken
/// for an end.
async fn until_ended(label: &str, identity: &ProcessIdentity) {
    let mut delay = Duration::from_millis(500);
    let observation = loop {
        let opening = identity.clone();
        match tokio::task::spawn_blocking(move || ProcessObservation::open(&opening)).await {
            Ok(Ok(Observed::Ended)) => return,
            Ok(Ok(Observed::Watching(observation))) => break Arc::new(observation),
            Ok(Err(err)) => log(
                "warn",
                &format!("could not observe {label}: {err}; trying again"),
            ),
            Err(err) => log("warn", &format!("could not observe {label}: {err}")),
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(MOST_RETRY_DELAY);
    };
    // SAFETY: the copy stays open, and is the same descriptor, for as long as the AsyncFd owns it.
    let readable = observation
        .descriptor()
        .and_then(|fd| fd.try_clone_to_owned().ok())
        .and_then(|fd| unsafe {
            tokio::io::unix::AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE).ok()
        });
    loop {
        let checking = observation.clone();
        match tokio::task::spawn_blocking(move || checking.ended()).await {
            Ok(Ok(Some(true))) => return,
            Ok(Ok(_)) => {}
            Ok(Err(err)) => log(
                "warn",
                &format!("could not check {label}: {err}; trying again"),
            ),
            Err(err) => log("warn", &format!("could not check {label}: {err}")),
        }
        let Some(fd) = &readable else {
            tokio::time::sleep(PROC_POLL_INTERVAL).await;
            continue;
        };
        match tokio::time::timeout(Duration::from_secs(5), fd.readable()).await {
            Ok(Ok(mut ready)) => ready.clear_ready(),
            Ok(Err(_)) => tokio::time::sleep(PROC_POLL_INTERVAL).await,
            Err(_) => {}
        }
    }
}

/// Follows the turn guest `id` began now, in `session`, whose CLI reports how the session stands
/// in `file`, as Claude Code's `sessions/<pid>.json`. Once a second, while this is still the
/// guest's turn, `idle` written there since the turn began sends [`GuestEvent::TurnIdle`]. A file
/// that is gone, names another session or says something else ends the following.
pub(super) fn follow_turn(
    roster: &Arc<Mutex<Roster>>,
    events: &mpsc::UnboundedSender<GuestEvent>,
    id: &str,
    session: &str,
    file: &str,
) {
    let began = now_millis();
    roster.lock().unwrap().turns.insert(id.to_string(), began);
    let (roster, events) = (roster.clone(), events.clone());
    let (id, session, file) = (id.to_string(), session.to_string(), file.to_string());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(FOLLOW_EVERY).await;
            if roster.lock().unwrap().turns.get(&id) != Some(&began) {
                return;
            }
            match how_it_stands(&file, &session).await {
                Some(Stands::IdleSince(since)) if since > began => {
                    log(
                        "info",
                        &format!("#{id} is idle: its CLI says the turn ended without a hook"),
                    );
                    let _ = events.send(GuestEvent::TurnIdle { id });
                    return;
                }
                Some(_) => {}
                None => return,
            }
        }
    });
}

/// How a CLI's own file says its session stands.
enum Stands {
    /// `idle` since then, in milliseconds since the epoch.
    IdleSince(u64),
    /// A turn under way, waiting or not for the person's answer to a question.
    InTurn,
}

/// How the file at `path` says `session` stands. None where it is gone or cannot be read, names
/// another session, or says something else.
async fn how_it_stands(path: &str, session: &str) -> Option<Stands> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let file: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if file["sessionId"] != session {
        return None;
    }
    match file["status"].as_str()? {
        "idle" => file["statusUpdatedAt"].as_u64().map(Stands::IdleSince),
        "busy" | "waiting" => Some(Stands::InTurn),
        _ => None,
    }
}

/// Now, in milliseconds since the epoch, as Claude Code dates its session's status.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}
