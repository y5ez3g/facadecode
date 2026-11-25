//! A newer Facade taking over while every agent runs on (`daemon.upgrade`): a command of a newer
//! build that finds this daemon asks it to hand over.
//!
//! 1. Check: the build must be newer and share a daemon API version. While the keeper holds CLIs,
//!    the build must also support that keeper's negotiated API version.
//! 2. Install the build, settle the relay effects and await their closing confirmations. Point
//!    the launchers at the build only after the relay cut is confirmed.
//! 3. Drain: new calls answer `upgrading`; an attached terminal's keys go on; calls under way get
//!    up to [`DRAIN_TIME`], but sends do not wait, as the store keeps their messages for the next
//!    daemon; a message whose paste began is settled first.
//! 4. Note the clean end, so that the next daemon asks no CLI to redraw; say `closing` on every
//!    connection past hello; exit. The keeper starts the daemon again from the launcher, which is
//!    the new build now.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use facade_base::api_v1::daemon::{CLOSING_TIME, DRAIN_TIME, QUIET_TIME};
use facade_base::api_v1::daemon::{DaemonUpgradeArgs, DaemonUpgradeResult, SUPPORTED_API_VERSIONS};
use facade_base::api_v1::{
    ApiVersions, ErrorBody, ErrorData, ProtocolMismatchDetails, highest_common,
};
use facade_base::model::error::Reason;
use tokio::sync::watch;

use super::relays::RelayFreeze;
use super::{Lifecycle, LifecycleActivity};
use crate::log;

/// The note in `framework/` of a daemon that handed over cleanly: its screen logs hold every byte read.
const CLEAN_END: &str = "clean-end";

/// Whether the daemon before this one handed over cleanly, as its note said.
static HANDED_OVER_CLEANLY: AtomicBool = AtomicBool::new(false);

/// Takes the clean-end note of the daemon before, if it left one: each screen log is then whole,
/// so recovery asks no CLI to redraw, and what the CLIs wrote meanwhile waits in their terminals.
pub(crate) fn take_clean_end(framework: &Path) {
    if std::fs::remove_file(framework.join(CLEAN_END)).is_ok() {
        HANDED_OVER_CLEANLY.store(true, Ordering::SeqCst);
    }
}

/// Whether the daemon before this one handed over cleanly.
pub(crate) fn handed_over_cleanly() -> bool {
    HANDED_OVER_CLEANLY.load(Ordering::SeqCst)
}

/// The refusal of a call that comes while a newer Facade takes over: nothing was done.
fn upgrading() -> ErrorBody {
    operation_error(
        Reason::Upgrading,
        "a newer Facade is taking over; nothing was done; repeat the call once Facade \
         answers again",
    )
}

fn operation_error(reason: Reason, message: impl Into<String>) -> ErrorBody {
    ErrorBody {
        code: -32000,
        message: message.into(),
        data: ErrorData {
            reason: reason.as_str().into(),
            details: None,
        },
    }
}

impl Lifecycle {
    pub(crate) fn closing(&self) -> watch::Receiver<Option<String>> {
        self.closing_to.subscribe()
    }

    pub(crate) fn draining(&self) -> Option<ErrorBody> {
        self.draining.load(Ordering::SeqCst).then(upgrading)
    }

    /// Hands the running Facade over to the build `args` names. Answers once the handover is under
    /// way; a second request meanwhile gets the first one's answer.
    pub(crate) async fn take_over(
        self: &Arc<Self>,
        args: DaemonUpgradeArgs,
        activity: Arc<impl LifecycleActivity>,
    ) -> Result<DaemonUpgradeResult, ErrorBody> {
        let mut under_way = self.takeover.lock().await;
        if let Some(answer) = under_way.as_ref() {
            return Ok(answer.clone());
        }
        let (answer, relays) = self.prepare_takeover(&args, activity.as_ref()).await?;
        *under_way = Some(answer.clone());
        // Draining from before the answer: a client's hello after it meets no daemon serving on.
        self.draining.store(true, Ordering::SeqCst);
        tokio::spawn(self.clone().hand_over(args.build, activity, relays));
        Ok(answer)
    }

    /// Checks the build and the protocols, installs the build and points the launchers at it.
    /// A step that fails leaves the running Facade as it was.
    async fn prepare_takeover(
        &self,
        args: &DaemonUpgradeArgs,
        activity: &impl LifecycleActivity,
    ) -> Result<(DaemonUpgradeResult, RelayFreeze), ErrorBody> {
        let ours = facade_base::build_id();
        if !facade_base::takes_over(&args.build, &ours) {
            return Err(operation_error(
                Reason::Refused,
                format!("{} is not newer than this Facade, {ours}", args.build),
            ));
        }
        if highest_common(&args.daemon_api_versions, SUPPORTED_API_VERSIONS).is_none() {
            return Err(ErrorBody::protocol_incompatible(
                format!(
                    "{} supports daemon API versions {:?}, and the running build, {ours}, \
                     supports {SUPPORTED_API_VERSIONS:?}. Stop the running Facade before switching builds",
                    args.build,
                    args.daemon_api_versions.as_slice()
                ),
                ProtocolMismatchDetails {
                    offered_api_versions: Some(args.daemon_api_versions.clone()),
                    supported_api_versions: ApiVersions::new(SUPPORTED_API_VERSIONS.to_vec())
                        .expect("daemon supports at least one API version"),
                    agents: None,
                },
            ));
        }
        let running = activity.running_count();
        // The keeper stays while it holds CLIs, so the new build must speak its protocol.
        if running > 0 {
            let keeper_version = activity.keeper_api_version().ok_or_else(|| {
                operation_error(
                    Reason::Unavailable,
                    "the running keeper's API version is unconfirmed. Try again after the keeper reconnects",
                )
            })?;
            if !args.keeper_api_versions.contains(keeper_version) {
                let agents = activity.running_managed_agents();
                let addresses = agents
                    .iter()
                    .map(|agent| agent.address.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(ErrorBody::protocol_incompatible(
                    format!(
                        "{} supports keeper API versions {:?}, and the running keeper negotiated \
                         version {keeper_version}. Stop the running agents {addresses} and try again",
                        args.build,
                        args.keeper_api_versions.as_slice()
                    ),
                    ProtocolMismatchDetails {
                        offered_api_versions: Some(args.keeper_api_versions.clone()),
                        supported_api_versions: ApiVersions::new(vec![keeper_version])
                            .expect("a negotiated keeper API version is present"),
                        agents: Some(agents),
                    },
                ));
            }
        }
        let builds: Vec<String> = activity
            .keeper_build()
            .into_iter()
            .chain([ours.clone()])
            .collect();
        let (program, build) = (args.program.clone(), args.build.clone());
        let installed = crate::blocking(move || {
            facade_base::programs::stage_for_takeover(Path::new(&program), &build)
        })
        .await
        .map_err(|error| install_error(args, &error))?;
        let relays = self
            .relays
            .prepare(&args.build)
            .await
            .map_err(crate::api::project_error)?;
        let build = args.build.clone();
        crate::blocking(move || {
            facade_base::programs::select_for_takeover(&installed, &build, &builds)
        })
        .await
        .map_err(|error| install_error(args, &error))?;
        log(
            "info",
            &format!(
                "handing over to build {}; {} run on",
                args.build,
                facade_base::model::agent::agents_word(running)
            ),
        );
        Ok((
            DaemonUpgradeResult {
                from: ours,
                agent_count: running as u64,
            },
            relays,
        ))
    }

    /// Drains, notes the clean end, tells every connection past hello that `build` takes over,
    /// writes the keys attached terminals sent until they answered, and exits.
    async fn hand_over(
        self: Arc<Self>,
        build: String,
        activity: Arc<impl LifecycleActivity>,
        _relays: RelayFreeze,
    ) {
        crate::gate_for_test("upgrade-draining");
        let drain_deadline = tokio::time::Instant::now() + DRAIN_TIME;
        // A paste that began is settled first, its agent reading meanwhile, and no other begins:
        // no message is delivered without its outcome known.
        let pastes = activity.settle_pastes().await;
        self.settle(DRAIN_TIME).await;
        for settled in pastes {
            let _ = tokio::time::timeout_at(drain_deadline, settled).await;
        }
        crate::gate_for_test("upgrade-drained");
        // Every agent stops reading its terminal, so its screen log holds every byte read and the
        // next daemon reads the rest. Where all did in time, the end is clean.
        if activity
            .quiet_agents(tokio::time::Instant::now() + QUIET_TIME)
            .await
            && let Ok(framework) = facade_base::paths::framework_dir()
        {
            let _ = std::fs::write(framework.join(CLEAN_END), facade_base::build_id());
        }
        crate::gate_for_test("upgrade-quiet");
        self.closing_to.send_replace(Some(build));
        self.connections_closed(CLOSING_TIME).await;
        // The keys an attached terminal sent until it answered `closing` reach their agents, which
        // write them before this daemon ends.
        self.settle(QUIET_TIME).await;
        activity
            .quiet_agents(tokio::time::Instant::now() + QUIET_TIME)
            .await;
        crate::gate_for_test("upgrade-before-end");
        self.finish_and_exit(activity.as_ref()).await
    }
}

fn install_error(
    args: &DaemonUpgradeArgs,
    error: &facade_base::model::error::ErrorBody,
) -> ErrorBody {
    operation_error(
        Reason::Unavailable,
        format!("could not install {}: {}", args.program, error.message),
    )
}
