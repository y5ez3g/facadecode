//! The places a start can work in, and the worktrees a start creates.

pub(crate) mod locations;

use std::path::Path;

use facade_base::daemon::LocationInfo;
use facade_base::jsonrpc::ErrorBody;

use locations::Creations;

/// Where an agent starts: its folder, and the ID of the location that holds the folder.
pub(crate) struct Destination {
    pub(crate) cwd: String,
    pub(crate) location_id: String,
}

/// The worktree creations under way on this machine.
#[derive(Default)]
pub(crate) struct Windows {
    creations: Creations,
}

impl Windows {
    /// Creates a worktree for a start on this machine. Creations into one `.worktrees` folder
    /// take turns.
    pub(crate) async fn create_local_worktree(
        &self,
        source: &Path,
        branch: &str,
    ) -> Result<LocationInfo, ErrorBody> {
        locations::create_worktree(source, branch, &self.creations).await
    }
}
