//! Antigravity's plugin of Facade's tools, which it reads in a folder it starts in, and the version
//! of Facade core that wrote a plugin.

use serde_json::{Value, json};

use facade_base::system::{SYSTEM, System};

use super::SKILL_FILE;
use super::servers::{Entry, SERVER, agy_entry};
use crate::RUN_CREDENTIAL_ARG;
use crate::formats::{HookArg, encoded_powershell, facade_hook, powershell_word};

/// Where Antigravity reads a folder's plugin of Facade's tools: the only file Facade writes into
/// the person's project.
pub const PLUGIN_FOLDER: &str = ".agents/plugins/facade";

/// The files a plugin of Facade core holds, in any version, each by its path in the plugin's
/// folder: anything else in its folder is not its.
pub const PLUGIN_MEMBERS: &[&str] = &["plugin.json", "mcp_config.json", "hooks.json", SKILL_FILE];

/// The permission rule that lets every tool of the plugin's server run without asking: Antigravity
/// names a plugin's server `<plugin>_<server>`.
pub(super) const ALLOW_TOOLS: &str = "mcp(facade_facade/*)";

/// The managed CLI's launcher reads this variable and removes it from the relay environment.
pub(super) const AGY_RUN_TOKEN: &str = "FACADE_RUN_TOKEN";

/// How the description of a plugin Facade core wrote begins, before the version that wrote it and a
/// colon. The Facade Code extension marks its own differently, so neither takes the other's plugin
/// for its own.
const PLUGIN_MARKER: &str = "Facade core ";

/// Whether a run of `cli` is given Facade's tools by a plugin in the folder it starts in, which the
/// runs there share: Antigravity's.
pub fn uses_folder_plugin(cli: &str) -> bool {
    cli == "agy"
}

/// What the manifest of a plugin `version` writes says of it.
pub(super) fn plugin_description(version: &str) -> String {
    format!(
        "{PLUGIN_MARKER}{version}: start agents, send and read messages, and read or type into \
         agent terminals."
    )
}

/// The files of Antigravity's plugin, each its path in [`PLUGIN_FOLDER`] and its text: its
/// manifest, which names this version; the MCP configuration of Facade's server, `program`; a
/// `PreInvocation` hook that has `facade`, this program, give
/// the model the instructions, as Antigravity shows it no server's; and the skill. The same for
/// every run of this version and Facade home, so that the runs in one folder share it. The server
/// finds the daemon's socket from its Facade home. The launcher takes the current run's relay
/// credential from the CLI's environment, so the files are shared by runs with different credentials.
pub fn plugin_files_v3(program: &str, facade: &str) -> Vec<(String, String)> {
    let (launcher, args) = match SYSTEM {
        System::Windows => windows_launcher(program),
        _ => {
            let script = format!(
                r#"token=${AGY_RUN_TOKEN}
unset {AGY_RUN_TOKEN}
if [ -n "$token" ]; then exec "$1" {RUN_CREDENTIAL_ARG} "$token"; fi
exec "$1""#,
            );
            (
                "/bin/sh".into(),
                vec!["-c".into(), script, "facade-mcp".into(), program.into()],
            )
        }
    };
    let entry = Entry {
        program: &launcher,
        args,
        env: &[],
    };
    let instructions = facade_hook("agy", facade, "instructions", &[HookArg::Word("agy")], []);
    let manifest =
        json!({ "name": SERVER, "description": plugin_description(&facade_base::version()) });
    let servers = json!({ "mcpServers": { SERVER: agy_entry(&entry) } });
    let hooks = json!({
        SERVER: { "PreInvocation": [{ "type": "command", "command": instructions }] },
    });
    let pretty = |value: Value| format!("{value:#}\n");
    vec![
        ("plugin.json".into(), pretty(manifest)),
        ("mcp_config.json".into(), pretty(servers)),
        ("hooks.json".into(), pretty(hooks)),
        (SKILL_FILE.into(), facade_base::skill::text_v3()),
    ]
}

/// Start the relay with inherited handles so PowerShell never handles its MCP bytes.
fn windows_launcher(program: &str) -> (String, Vec<String>) {
    let program = powershell_word(program);
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$token = $env:{AGY_RUN_TOKEN}
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = {program}
$start.UseShellExecute = $false
$start.EnvironmentVariables.Remove('{AGY_RUN_TOKEN}')
if ($token) {{
    if ($token -cnotmatch '^[0-9a-f]{{64}}$') {{ exit 1 }}
    $start.Arguments = "{RUN_CREDENTIAL_ARG} $token"
}}
$child = [System.Diagnostics.Process]::Start($start)
$child.WaitForExit()
exit $child.ExitCode
"#,
    );
    let command = encoded_powershell(&script);
    let mut words = command.split_ascii_whitespace().map(str::to_owned);
    let launcher = words.next().expect("encoded PowerShell names its program");
    (launcher, words.collect())
}

/// The version of Facade core that wrote the plugin whose manifest is `manifest`, each number of
/// it: the manifest names `facade`, and its description begins with core's marker and a version of
/// numbers and dots. None for any other, such as the person's own plugin or the Facade Code
/// extension's.
pub fn plugin_version(manifest: &str) -> Option<Vec<u64>> {
    let manifest: Value = serde_json::from_str(manifest).ok()?;
    let description = manifest["description"]
        .as_str()
        .filter(|_| manifest["name"] == SERVER)?;
    let (version, _) = description.strip_prefix(PLUGIN_MARKER)?.split_once(':')?;
    version
        .split('.')
        .map(|number| number.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plugin's manifest names Facade core and the version that wrote it, which tells core's
    /// plugin from anyone else's.
    #[test]
    fn the_plugin_s_manifest_names_facade_core_and_its_version() {
        let manifest = &plugin_files_v3("/opt/facade-mcp", "/opt/facade")[0].1;
        let version: Vec<u64> = facade_base::VERSION
            .split('.')
            .map(|part| part.parse().unwrap())
            .collect();
        assert_eq!(plugin_version(manifest), Some(version));
        let extension = r#"{ "name": "facade", "description": "The Facade Code tools: start agents, send and read messages, and read or type into agent terminals." }"#;
        let others = [
            extension,
            r#"{ "name": "facade" }"#,
            r#"{ "name": "other", "description": "Facade core 1.0.0: x" }"#,
            r#"{ "name": "facade", "description": "Facade core 1.x: x" }"#,
        ];
        for theirs in others {
            assert_eq!(plugin_version(theirs), None, "{theirs}");
        }
    }
}
