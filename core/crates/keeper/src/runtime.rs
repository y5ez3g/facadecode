//! Request checks, launch arguments and timing shared by the Unix and Windows keepers.

#![allow(
    clippy::result_large_err,
    reason = "Keeper requests return the shared API v1 error by value"
)]

use std::collections::BTreeMap;
use std::time::Duration;

use facade_base::api_v1::keeper::{self, KeeperCall, StartArgs, methods};
use facade_base::api_v1::{ApiVersion, ErrorBody, Request};
use facade_base::start::StartCommand;

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
