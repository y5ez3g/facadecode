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
    CLOSING_TIME, DAEMON_PROTOCOL_VERSION, DRAIN_TIME, QUIET_TIME, UpgradeArgs, UpgradeResult,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::shared_version;
use tokio::sync::oneshot;

use crate::agent::AgentCommand;
use crate::{Daemon, log};

/// The note in `core/` of a daemon that handed over cleanly: its screen logs hold every byte read.
pub(crate) const CLEAN_END: &str = "clean-end";

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
pub(crate) fn upgrading() -> ErrorBody {
    ErrorBody::new(
        Reason::Upgrading,
        "a newer Facade is taking over; nothing was done; repeat the call once Facade \
         answers again",
    )
}

impl Daemon {
    /// Hands the running Facade over to the build `args` names. Answers once the handover is under
    /// way; a second request meanwhile gets the first one's answer.
    pub(crate) async fn take_over(
        self: &Arc<Self>,
        args: UpgradeArgs,
    ) -> Result<UpgradeResult, ErrorBody> {
        let mut under_way = self.takeover.lock().await;
        if let Some(answer) = under_way.as_ref() {
            return Ok(answer.clone());
        }
        let answer = self.prepare_takeover(&args).await?;
        *under_way = Some(answer.clone());
        // Draining from before the answer: a client's hello after it meets no daemon serving on.
        self.draining.store(true, Ordering::SeqCst);
        tokio::spawn(self.clone().hand_over(args.build));
        Ok(answer)
    }

    /// Checks the build and the protocols, installs the build and points the launchers at it.
    /// A step that fails leaves the running Facade as it was.
    async fn prepare_takeover(&self, args: &UpgradeArgs) -> Result<UpgradeResult, ErrorBody> {
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
        let [low, high] = args.daemon_protocol;
        if !(low..=high).contains(&DAEMON_PROTOCOL_VERSION) {
            return Err(ErrorBody::new(
                Reason::ProtocolIncompatible,
                format!(
                    "{} speaks daemon protocol {low} to {high}, and this Facade, {ours}, speaks \
                     {DAEMON_PROTOCOL_VERSION}: stop the running Facade before switching builds",
                    args.build
                ),
            ));
        }
        let running = self
            .agents()
            .iter()
            .filter(|agent| agent.exit().borrow().is_none())
            .count();
        // The keeper stays while it holds CLIs, so the new build must speak its protocol.
        if running > 0
            && let Some(keeper) = self.runs.keeper_protocol()
            && shared_version(args.keeper_protocol, keeper).is_none()
        {
            let [low, high] = args.keeper_protocol;
            return Err(ErrorBody::new(
                Reason::ProtocolIncompatible,
                format!(
                    "{} speaks keeper protocol {low} to {high}, and the running keeper speaks {} \
                     to {}: this new build needs every agent closed first; close them and try \
                     again",
                    args.build, keeper[0], keeper[1]
                ),
            ));
        }
        let builds: Vec<String> = self
            .runs
            .keeper_info()
            .map(|keeper| keeper.build)
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
        Ok(UpgradeResult {
            from: ours,
            agents: running,
        })
    }

    /// Drains, notes the clean end, tells every connection past hello that `build` takes over,
    /// writes the keys attached terminals sent until they answered, and exits.
    async fn hand_over(self: Arc<Self>, build: String) {
        crate::gate_for_test("upgrade-draining");
        let drain_deadline = tokio::time::Instant::now() + DRAIN_TIME;
        // A paste that began is settled first, its agent reading meanwhile, and no other begins:
        // no message is delivered without its outcome known.
        let mut pastes = Vec::new();
        for agent in self.agents() {
            let (reply, settled) = oneshot::channel();
            if agent.send(AgentCommand::SettlePaste { reply }).await {
                pastes.push(settled);
            }
        }
        self.lifecycle.settle(DRAIN_TIME).await;
        for settled in pastes {
            let _ = tokio::time::timeout_at(drain_deadline, settled).await;
        }
        crate::gate_for_test("upgrade-drained");
        // Every agent stops reading its terminal, so its screen log holds every byte read and the
        // next daemon reads the rest. Where all did in time, the end is clean.
        if self.quiesce().await
            && let Ok(core) = facade_base::paths::core_dir()
        {
            let _ = std::fs::write(core.join(CLEAN_END), facade_base::build_id());
        }
        crate::gate_for_test("upgrade-quiet");
        self.closing_to.send_replace(Some(build));
        self.lifecycle.connections_closed(CLOSING_TIME).await;
        // The keys an attached terminal sent until it answered `closing` reach their agents, which
        // write them before this daemon ends.
        self.lifecycle.settle(QUIET_TIME).await;
        self.quiesce().await;
        crate::gate_for_test("upgrade-before-end");
        crate::lifecycle::finish_and_exit(&self).await
    }

    /// Has every agent write what is queued for it and then read and type no more, within
    /// [`QUIET_TIME`]. Whether every agent did, or had ended.
    async fn quiesce(&self) -> bool {
        let deadline = tokio::time::Instant::now() + QUIET_TIME;
        let mut all_quiet = true;
        for agent in self.agents() {
            let (reply, quiet) = oneshot::channel();
            let quieted = agent.send(AgentCommand::Quiesce { reply }).await
                && matches!(tokio::time::timeout_at(deadline, quiet).await, Ok(Ok(())));
            all_quiet &= quieted || agent.exit().borrow().is_some();
        }
        all_quiet
    }
}
