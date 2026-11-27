//! Request checks, launch arguments and timing shared by the Unix and Windows keepers.

#![allow(
    clippy::result_large_err,
    reason = "Keeper requests return the shared API v1 error by value"
)]

use std::collections::BTreeMap;
use std::{
    path::Path,
    time::{Duration, Instant},
};

use facade_base::api_v1::keeper::{self, KeeperCall, StartArgs, StopArgs, methods};
use facade_base::api_v1::{ApiVersion, ErrorBody, Request};
use facade_base::process::ProcessIdentity;
use facade_base::start::StartCommand;
use facade_base::startup::Attempt;

/// From a stop's hang-up to its kill, unless the CLI ends first.
pub(crate) const STOP_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the keeper waits for a ping before it ends the daemon.
pub(crate) const PING_TIMEOUT: Duration = Duration::from_secs(15);
/// The first delay before the keeper starts a daemon again.
pub(crate) const MIN_RESTART_DELAY: Duration = Duration::from_millis(500);
/// The longest delay before the keeper starts a daemon again.
pub(crate) const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);
/// Once a daemon runs this long, the restart delay starts over.
pub(crate) const RESTART_DELAY_RESET: Duration = Duration::from_secs(60);

/// The startup phase belongs to the daemon, even when its supervising keeper changes.
pub(crate) fn watched_startup(
    startup: Option<Attempt>,
    daemon: &ProcessIdentity,
    now: Instant,
) -> (Option<Attempt>, Option<Instant>) {
    let startup = startup.filter(|attempt| attempt.supervises(daemon));
    let last_ping = startup
        .as_ref()
        .is_some_and(|attempt| attempt.keeper_has_first_ping(daemon))
        .then_some(now);
    (startup, last_ping)
}

pub(crate) fn admit_first_ping(startup: Option<&Attempt>, daemon: &ProcessIdentity) -> bool {
    let Some(startup) = startup else { return true };
    match startup.accept_keeper_ping(daemon) {
        Ok(accepted) => accepted,
        Err(error) => {
            crate::log(
                "warn",
                &format!(
                    "could not record the first ping from daemon {}: {error}",
                    daemon.pid
                ),
            );
            false
        }
    }
}

/// Saves positive evidence of a creator stop before acting on the request.
pub(crate) fn accept_creator_stop(
    framework: &Path,
    args: &StopArgs,
    process: &ProcessIdentity,
    stopping: bool,
) -> Result<(), ErrorBody> {
    let Some(creator) = &args.creator_stop else {
        return Ok(());
    };
    if creator != process {
        return Err(ErrorBody::invalid_argument(
            "the stop names another process",
        ));
    }
    let storage_error =
        |error| keeper::project_error(facade_base::model::error::ErrorBody::internal(error));
    if stopping {
        if facade_base::stop_receipt::exists(framework, &args.agent_id, creator)
            .map_err(storage_error)?
        {
            return Ok(());
        }
        return Err(ErrorBody::invalid_argument(
            "the process already has a stop",
        ));
    }
    facade_base::stop_receipt::record(framework, &args.agent_id, creator).map_err(storage_error)
}

/// The resolved start the keeper executes.
pub(crate) struct KeeperStartArgs {
    pub(crate) agent: String,
    pub(crate) launch: StartCommand<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

impl From<StartArgs> for KeeperStartArgs {
    fn from(args: StartArgs) -> Self {
        Self {
            agent: args.agent_id,
            launch: StartCommand::from_words(args.command, args.cwd),
            env: args.env,
            cols: args.size.cols,
            rows: args.size.rows,
        }
    }
}

pub(crate) enum AdmittedRequest {
    Hello(ApiVersion),
    Call(KeeperCall),
    Unknown(String),
}

/// Classifies a request and applies the shared hello and call checks.
pub(crate) fn admit(
    request: Request,
    greeted: bool,
    has_terminal: bool,
) -> Result<AdmittedRequest, ErrorBody> {
    let Request { method, params, .. } = request;
    match method.as_str() {
        methods::HELLO if greeted => Err(ErrorBody::invalid_argument(
            "hello was already received on this connection",
        )),
        methods::HELLO if has_terminal => Err(unexpected_terminal()),
        methods::HELLO => {
            let params = keeper::decode_hello(params)?;
            keeper::select_version(&params.api_versions).map(AdmittedRequest::Hello)
        }
        methods::CALL if !greeted => Err(ErrorBody::invalid_argument("send hello first")),
        methods::CALL => {
            let call = keeper::decode_call(params)?;
            if has_terminal && !matches!(&call, KeeperCall::Sync(_)) {
                return Err(unexpected_terminal());
            }
            Ok(AdmittedRequest::Call(call))
        }
        _ => Ok(AdmittedRequest::Unknown(method)),
    }
}

pub(crate) fn unexpected_terminal() -> ErrorBody {
    ErrorBody::invalid_argument("only agent.sync requests may carry a terminal")
}
