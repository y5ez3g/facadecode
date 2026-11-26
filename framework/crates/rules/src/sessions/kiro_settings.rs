//! Location of the effective Kiro V3 app configuration.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::system::env_var;

pub(crate) fn kiro_config_root(
    home: Option<&Path>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let override_path = env_var(env, "KIRO_HOME").map(|path| Path::new(path.trim()));
    override_path
        .filter(|path| {
            path.is_absolute()
                && path.parent().is_some()
                && home.is_none_or(|home| !home.starts_with(path))
        })
        .map(Path::to_path_buf)
        .or_else(|| home.map(|home| home.join(".kiro")))
}
