//! A newer Facade taking over while every agent runs on (`daemon.upgrade`): a command of a newer
//! build that finds this daemon asks it to hand over.
//!
//! 1. Check: the build must be newer and speak this daemon's protocol, and where the keeper holds
//!    CLIs, the running keeper's protocol too, since that keeper stays while it holds any.
//! 2. Install the new build and point the launchers at it.
//! 3. Drain: new calls answer `upgrading`; an attached terminal's keys go on; calls under way get
//!    up to [`DRAIN_TIME`], but sends do not wait, as the store keeps their messages for the next
//!    daemon; a message whose paste began is settled first.
//! 4. Note the clean end, so that the next daemon asks no CLI to redraw; say `closing` on every
//!    connection past hello; exit. The keeper starts the daemon again from the launcher, which is
//!    the new build now.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use facade_base::daemon::{
    CLOSING_TIME, DRAIN_TIME, DaemonUpgradeArgs, DaemonUpgradeResult, QUIET_TIME,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::shared_version;
use facade_base::v3::DAEMON_PROTOCOL_RANGE;
use tokio::sync::watch;

use super::{Lifecycle, LifecycleActivity};
use crate::log;

/// The note in `core/` of a daemon that handed over cleanly: its screen logs hold every byte read.
const CLEAN_END: &str = "clean-end";

/// Whether the daemon before this one handed over cleanly, as its note said.
static HANDED_OVER_CLEANLY: AtomicBool = AtomicBool::new(false);

/// Takes the clean-end note of the daemon before, if it left one: each screen log is then whole,
/// so recovery asks no CLI to redraw, and what the CLIs wrote meanwhile waits in their terminals.
pub(crate) fn take_clean_end(core: &Path) {
    if std::fs::remove_file(core.join(CLEAN_END)).is_ok() {
        HANDED_OVER_CLEANLY.store(true, Ordering::SeqCst);
    }
}

/// Whether the daemon before this one handed over cleanly.
pub(crate) fn handed_over_cleanly() -> bool {
    HANDED_OVER_CLEANLY.load(Ordering::SeqCst)
}

/// The refusal of a call that comes while a newer Facade takes over: nothing was done.
fn upgrading() -> ErrorBody {
    ErrorBody::new(
        Reason::Upgrading,
        "a newer Facade is taking over; nothing was done; repeat the call once Facade \
         answers again",
    )
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
        let answer = Self::prepare_takeover(&args, activity.as_ref()).await?;
        *under_way = Some(answer.clone());
        // Draining from before the answer: a client's hello after it meets no daemon serving on.
        self.draining.store(true, Ordering::SeqCst);
        tokio::spawn(self.clone().hand_over(args.build, activity));
        Ok(answer)
    }

    /// Checks the build and the protocols, installs the build and points the launchers at it.
    /// A step that fails leaves the running Facade as it was.
    async fn prepare_takeover(
        args: &DaemonUpgradeArgs,
        activity: &impl LifecycleActivity,
    ) -> Result<DaemonUpgradeResult, ErrorBody> {
        let ours = facade_base::build_id();
        if !facade_base::takes_over(&args.build, &ours) {
            let same_version = facade_base::version_of(&args.build).is_some()
                && facade_base::version_of(&args.build) == facade_base::version_of(&ours);
            let why = if same_version {
                format!(
                    "{} is of this Facade's own version, {ours}: builds of one version do not \
                     take over from each other",
                    args.build
                )
            } else {
                format!("{} is not newer than this Facade, {ours}", args.build)
            };
            return Err(ErrorBody::refused(why));
        }
        if shared_version(args.daemon_protocol_range, DAEMON_PROTOCOL_RANGE).is_none() {
            let [low, high] = args.daemon_protocol_range;
            let [ours_low, ours_high] = DAEMON_PROTOCOL_RANGE;
            return Err(ErrorBody::new(
                Reason::IncompatibleProtocol,
                format!(
                    "{} can take over daemon protocols {low} to {high}, and this Facade, {ours}, \
                     serves {ours_low} to {ours_high}. Stop the running Facade before switching builds.",
                    args.build
                ),
            ));
        }
        // The keeper stays while it holds CLIs, so the new build must speak its protocol.
        if let Some(keeper) = activity.keeper_protocol_range()
            && shared_version(args.keeper_protocol_range, keeper).is_none()
        {
            let agents = activity.running_managed_agents();
            if !agents.is_empty() {
                let [low, high] = args.keeper_protocol_range;
                let [keeper_low, keeper_high] = keeper;
                let addresses = agents
                    .iter()
                    .map(|agent| agent.address.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut error = ErrorBody::new(
                    Reason::IncompatibleProtocol,
                    format!(
                        "{} speaks keeper protocol {low} to {high}, and the running keeper speaks \
                         {keeper_low} to {keeper_high}. Stop the running agents {addresses} and try again.",
                        args.build
                    ),
                );
                error.data.agents = agents;
                return Err(error);
            }
        }
        let running = activity.running_count();
        let builds: Vec<String> = activity
            .keeper_build()
            .into_iter()
            .chain([ours.clone()])
            .collect();
        let (program, build) = (args.program.clone(), args.build.clone());
        crate::blocking(move || {
            facade_base::programs::install(Path::new(&program), &build)?;
            facade_base::programs::point_launchers_at(&build, &builds)
        })
        .await
        .map_err(|error| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("could not install {}: {}", args.program, error.message),
            )
        })?;
        log(
            "info",
            &format!(
                "handing over to build {}; {} run on",
                args.build,
                facade_base::daemon::agents_word(running)
            ),
        );
        Ok(DaemonUpgradeResult {
            from: ours,
            agent_count: running,
        })
    }

    /// Drains, notes the clean end, tells every connection past hello that `build` takes over,
    /// writes the keys attached terminals sent until they answered, and exits.
    async fn hand_over(self: Arc<Self>, build: String, activity: Arc<impl LifecycleActivity>) {
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
            && let Ok(core) = facade_base::paths::core_dir()
        {
            let _ = std::fs::write(core.join(CLEAN_END), facade_base::build_id());
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
