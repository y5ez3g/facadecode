//! The words of a CLI's command line that come from its rule and the person's settings, not from
//! Facade's wiring: what YOLO adds, the model and effort chosen, the session a resume names, and
//! the `clis` entries of `facade.json` that name each CLI. The rules layer puts these together
//! with the wiring's words in `compose`.

mod choices;
pub mod entries;
mod yolo;

pub use choices::Choices;
pub use yolo::{TrustQuestion, YoloRule};

/// Where a rule's `session.resume` takes the session's ID.
const SESSION_ID: &str = "${session_id}";

/// Checks a rule's `session.resume`: it names the session exactly once and nothing else to fill in.
pub(crate) fn check_resume(resume: &[String]) -> Result<(), String> {
    let named: usize = resume
        .iter()
        .map(|arg| arg.matches(SESSION_ID).count())
        .sum();
    let other = resume
        .iter()
        .any(|arg| arg.contains('\0') || arg.replace(SESSION_ID, "").contains("${"));
    if named == 1 && !other {
        return Ok(());
    }
    Err(format!(
        "session.resume must name {SESSION_ID} exactly once and nothing else to fill in"
    ))
}

/// `resume` with `session` in the place it names, as literal text.
pub(crate) fn resume_args(resume: &[String], session: &str) -> Vec<String> {
    resume
        .iter()
        .map(|arg| arg.replacen(SESSION_ID, session, 1))
        .collect()
}
