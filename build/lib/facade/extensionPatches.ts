/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { Transform, type TransformCallback } from 'stream';
import File from 'vinyl';

/**
 * A line Facade Code changes in a built-in extension it does not maintain (REMOTE.md R5): in its pinned version only,
 * in one file, the text found there exactly once, and what it becomes.
 */
export interface IExtensionPatch {
	readonly version: string;
	readonly file: string;
	readonly find: string;
	readonly replace: string;
}

/** macOS's lockf locks the shell's open descriptor, released by the OS when setup exits (REMOTE.md R5). */
const SETUP_LOCK_SH = [
	'  # Facade Code: lockf on macOS locks this shell\'s descriptor until it exits (REMOTE.md R5)',
	'  FD=9',
	'  if ! exec 9<>"$LOCKFILE"; then print_install_results_and_exit 1; fi',
	'  if ! command -v lockf >/dev/null 2>&1; then',
	'    echo "Error: neither flock nor lockf is available for the install lock"',
	'    print_install_results_and_exit 1',
	'  fi',
	'  if ! lockf -s -t 30 "$FD"; then',
	'    echo "Warning: cannot acquire the install lock"',
	'    print_install_results_and_exit 1',
	'  fi',
].join('\n');

/** Windows keeps an exclusive OS file handle until setup has a result; the kernel releases it if setup dies. */
const SETUP_LOCK_PS1 = [
	'# Facade Code: one setup at a time, held by an exclusive file handle until the server listens (REMOTE.md R5)',
	'$LOCK_FILE="$env:TEMP\\facade-server-install.lock"',
	'$script:LOCK_STREAM=$null',
	'for($I = 1; $I -le 30; $I++) {',
	'  try {',
	'    $script:LOCK_STREAM=[System.IO.File]::Open($LOCK_FILE, \'OpenOrCreate\', \'ReadWrite\', \'None\')',
	'    break',
	'  }',
	'  catch {',
	'    sleep 1',
	'  }',
	'}',
	'if(!$script:LOCK_STREAM) {',
	'  "Warning: cannot acquire the install lock"',
	'  printInstallResults 1',
	'  exit 0',
	'}',
	'',
	'# Validate the commit of the installed server against the expected one (DISTRO_COMMIT)',
].join('\n');

/** Windows PowerShell 5.1 ignores HTTP_PROXY and HTTPS_PROXY unless Invoke-RestMethod receives -Proxy explicitly. */
const SETUP_PROXY_PS1 = [
	'  # Facade Code: honor the proxy variables used by curl and wget on Unix hosts (REMOTE.md R5).',
	'  $U=[uri]$SERVER_DOWNLOAD_URL',
	'  $P=if($U.Scheme -eq "https"){$env:HTTPS_PROXY}else{$env:HTTP_PROXY}',
	'  if($P) {',
	'    $H=$U.Host.Trim([char[]]"[]").ToLowerInvariant()',
	'    if($H.Contains(":")) {$H=[Net.IPAddress]::Parse($H).ToString()}',
	'    $B=$false',
	'    foreach($E in ($env:NO_PROXY -split ",")) {',
	'      $E=$E.Trim().TrimStart([char]".").Trim([char[]]"[]").ToLowerInvariant()',
	'      if($E.Contains(":")) {try {$E=[Net.IPAddress]::Parse($E).ToString()} catch {}}',
	'      if($E -eq "*" -or ($E -and ($H -eq $E -or $H.EndsWith(".$E")))) {$B=$true;break}',
	'    }',
	'    if(!$B) {$REQUEST_ARGUMENTS.Proxy=$P}',
	'  }',
].join('\n');

/** cmd.exe caps a command at 8191 characters. Write a longer PowerShell setup in bounded pieces over the same SSH connection. */
const WINDOWS_INSTALL_LARGE_COMMAND = String.raw`if(f.length>8191){
  const D=l.replace("$HOME","%USERPROFILE%").replace(/\.ps1$/,"-"+process.pid+"-"+Math.random().toString(36).slice(2)+".ps1");
  const path64=Buffer.from(D,"utf8").toString("base64"),bytes=Buffer.concat([Buffer.from([239,187,191]),Buffer.from(t,"utf8")]);
  const pathPS="$p=[Environment]::ExpandEnvironmentVariables([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+path64+"')));";
  const encoded=ps=>"powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -EncodedCommand "+Buffer.from(ps,"utf16le").toString("base64");
  const write=async ps=>{const c=encoded(ps)+" && echo FacadeInstallWriteOK";if(c.length>8191)throw new g("Command line too long");const r=await e.exec(c);if(!r.stdout.includes("FacadeInstallWriteOK"))throw new g("Writing the Windows server setup script failed: "+r.stderr)};
  try{
    for(let i=0;i<bytes.length;i+=1000){
      const b64=bytes.subarray(i,i+1000).toString("base64");
      const ps=pathPS+"$b=[Convert]::FromBase64String('"+b64+"');"+(i===0?"[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))|Out-Null;[IO.File]::WriteAllBytes($p,$b)":"$s=[IO.File]::Open($p,[IO.FileMode]::Append);try{$s.Write($b,0,$b.Length)}finally{$s.Dispose()}");
      await write(ps)
    }
  }catch(x){try{await e.exec(encoded(pathPS+"Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue"))}catch{}throw x}
  f=encoded(pathPS+"$script=[ScriptBlock]::Create([IO.File]::ReadAllText($p,[Text.Encoding]::UTF8));Remove-Item -LiteralPath $p -Force; & $script")
}`;

/**
 * ssh-config has collected LocalForward lines, but open-remote-ssh's ssh2 path never opens their tunnels. Its native
 * SSH path already reads the same config itself. Feed TCP forwards to the connection's existing tunnel manager; a
 * malformed entry or an occupied local port is logged and leaves the remote connection usable, as OpenSSH's default
 * ExitOnForwardFailure=no does. Local sockets are not handled by that manager.
 */
const LOCAL_FORWARD_SETUP = [
	'if (this.facadeLocalForwards && this.facadeLocalForwards !== this.sshConnection) {',
	'  for (const name of Object.keys(this.facadeLocalForwards.activeTunnels).filter(name => name.startsWith("ssh_config_local_"))) {',
	'    try { void this.facadeLocalForwards.closeTunnel(name).catch(error => this.logger.error(`LocalForward ${name} cleanup failed`, error)); }',
	'    catch (error) { this.logger.error(`LocalForward ${name} cleanup failed`, error); }',
	'  }',
	'}',
	'this.facadeLocalForwards = this.sshConnection instanceof A.default ? this.sshConnection : void 0;',
	'if (this.sshConnection instanceof A.default) {',
	'  for (const rule of [r.LocalForward || []].flat()) {',
	'    const fields = /^(\\S+)\\s+(\\S+)$/.exec(rule.trim());',
	'    const local = fields && /^(?:(\\[[^\\]]+\\]|[^:]+):)?([0-9]+)$/.exec(fields[1]);',
	'    const remote = fields && /^(\\[[^\\]]+\\]|[^:]+):([0-9]+)$/.exec(fields[2]);',
	'    const localPort = local && Number(local[2]);',
	'    const remotePort = remote && Number(remote[2]);',
	'    if (!local || !remote || !localPort || localPort > 65535 || !remotePort || remotePort > 65535) {',
	'      this.logger.error(`Unsupported LocalForward: ${rule}`);',
	'      continue;',
	'    }',
	'    let localAddr = (local[1] || "127.0.0.1").replace(/^\\[|\\]$/g, "");',
	'    if (localAddr === "*") localAddr = "0.0.0.0";',
	'    const remoteAddr = remote[1].replace(/^\\[|\\]$/g, "");',
	'    try {',
	'      await this.sshConnection.addTunnel({ name: `ssh_config_local_${localAddr}_${localPort}`, localAddr, localPort, remoteAddr, remotePort });',
	'      this.logger.info(`LocalForward ${localAddr}:${localPort} => ${remoteAddr}:${remotePort}`);',
	'    } catch (error) {',
	'      this.logger.error(`LocalForward ${rule} failed`, error);',
	'    }',
	'  }',
	'}',
].join('');

/** Each built-in extension's patches, by the extension's name. */
export const extensionPatches: { readonly [name: string]: readonly IExtensionPatch[] } = {
	// Reads the first folder without checking there is one: in a workspace without folders - Facade's default
	// workspace before one is added - it fails to start, and none of its commands exist. open-remote-ssh had the
	// same line until 0.5.0, which changed it the same way.
	'jeanp413.open-remote-wsl': [{ version: '0.0.5', file: 'out/extension.js', find: 'workspaceFolders?.[0].uri', replace: 'workspaceFolders?.[0]?.uri' }],
	'jeanp413.open-remote-ssh': [
		// Looks for the server it started by `ps -o pid,args`, which on macOS lists only processes with a terminal: the
		// server it started is never found, every connection - a reconnection too - starts another, and the window's
		// reconnection is refused by it, its terminals and agents left behind. By the process id it lists it there too;
		// a ps without -p, as BusyBox's, lists what it did
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: 'SERVER_RUNNING_PROCESS="$( ps -o pid,args | grep $SERVER_PID | grep $SERVER_SCRIPT )"', replace: 'SERVER_RUNNING_PROCESS="$( (ps -o pid,args -p $SERVER_PID || ps -o pid,args) | grep $SERVER_PID | grep $SERVER_SCRIPT )"' },
		// Its SSH library fails a channel whose request to forward the agent the host refuses - Windows' OpenSSH server
		// forwards none - so with ForwardAgent set, nothing on such a host runs. OpenSSH goes on without the agent: the
		// refusal, which ssh2 answers with `true`, goes on so; an error of the channel still fails it
		{ version: '0.5.0', file: 'lib/extension.js', find: 'void(r&&t(!0!==n?n:new Error("Unable to request agent forwarding")))', replace: 'void(r&&t(!0!==n?n:void 0))' },
		// ssh-config collects LocalForward lines, but the ssh2 connection never uses them. Normalize the directive's case,
		// let its tunnel manager bind an explicit local address, and open the configured forwards after authentication.
		{ version: '0.5.0', file: 'lib/extension.js', find: 'identityfile:"IdentityFile",include:"Include"', replace: 'identityfile:"IdentityFile",localforward:"LocalForward",include:"Include"' },
		{ version: '0.5.0', file: 'lib/extension.js', find: '.listen(e.localPort,"127.0.0.1")', replace: '.listen(e.localPort,e.localAddr||"127.0.0.1")' },
		{ version: '0.5.0', file: 'lib/extension.js', find: 'await this.sshConnection.connect();const j={};', replace: `await this.sshConnection.connect();${LOCAL_FORWARD_SETUP}const j={};` },
		{ version: '0.5.0', file: 'lib/extension.js', find: 'if(f=`powershell "md -Force ${h}"', replace: 'f=`powershell "md -Force ${h}"' },
		{ version: '0.5.0', file: 'lib/extension.js', find: ',o.trace("Command length (8191 max):",f.length),f.length>8191)throw new g("Command line too long")', replace: `;o.trace("Command length (8191 max):",f.length);${WINDOWS_INSTALL_LARGE_COMMAND}` },
		// Takes its install lock with flock, which macOS lacks, and goes on without one; its Windows setup takes none: two
		// windows connecting at once - a restart reopening both - each find no server and start one, the pid file keeps
		// the one no window uses, which shuts itself down, and the next connection starts a third, the agents left in the
		// other. macOS's lockf holds the same kernel lock through the script's descriptor. The flock branch must also
		// use the person's own server directory: /tmp/server_install.lock can belong to another user on a shared host.
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: 'LOCKFILE="$TMP_DIR/server_install.lock"', replace: 'mkdir -p "$SERVER_DATA_DIR" || print_install_results_and_exit 1\nLOCKFILE="$SERVER_DATA_DIR/.install.flock"' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  echo "Warning: flock not available, skipping install lock"', replace: SETUP_LOCK_SH },
		// A background server must not inherit the descriptor: it outlives the installer and would keep its lock held.
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '--accept-server-license-terms &> $SERVER_LOGFILE &', replace: '--accept-server-license-terms 9>&- &> $SERVER_LOGFILE &' },
		// curl otherwise treats a missing server package's HTTP 404 page as a successful download and reports "corrupted contents".
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: 'curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"', replace: 'curl --fail --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"' },
		// A failed directory change must report the result, and an invalid tarball must stop the main script rather than
		// only exiting a subshell and then falling through to another (possibly successful) result block.
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  pushd "$SERVER_DIR" > /dev/null || exit', replace: '  pushd "$SERVER_DIR" > /dev/null || print_install_results_and_exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  popd > /dev/null || exit', replace: '  popd > /dev/null || print_install_results_and_exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  exec 9<>"$LOCKFILE"', replace: '  if ! exec 9<>"$LOCKFILE"; then print_install_results_and_exit 1; fi' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  mkdir -p $SERVER_DIR || (\n    echo "Error: creating server install directory"\n    print_install_results_and_exit 1\n  )', replace: '  mkdir -p "$SERVER_DIR" || {\n    echo "Error: creating server install directory"\n    print_install_results_and_exit 1\n  }' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  tar -xOf vscode-server.tar.gz > /dev/null 2>&1 || (\n    echo "Error downloaded tarball is corrupt or incomplete"\n    rm -rf vscode-server.tar.gz\n    print_install_results_and_exit 1\n  )', replace: '  tar -xOf vscode-server.tar.gz > /dev/null 2>&1 || {\n    echo "Error downloaded tarball is corrupt or incomplete"\n    rm -rf vscode-server.tar.gz\n    print_install_results_and_exit 1\n  }' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.sh', find: '  tar -xf vscode-server.tar.gz --strip-components 1 || (\n    echo "Error while extracting server contents"\n    rm -rf vscode-server.tar.gz\n    print_install_results_and_exit 1\n  )', replace: '  tar -xf vscode-server.tar.gz --strip-components 1 || {\n    echo "Error while extracting server contents"\n    rm -rf vscode-server.tar.gz\n    print_install_results_and_exit 1\n  }' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '# Validate the commit of the installed server against the expected one (DISTRO_COMMIT)', replace: SETUP_LOCK_PS1 },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  Invoke-RestMethod @REQUEST_ARGUMENTS', replace: `${SETUP_PROXY_PS1}\n\n  Invoke-RestMethod @REQUEST_ARGUMENTS` },
		// Every install failure must emit the same parseable result block as success. PowerShell reports some failures as
		// terminating errors (a bad URL or process launch), while download HTTP errors need ErrorAction=Stop to reach it.
		// A bare `name=` in PowerShell consumes the next line as its value. These initializers must stay empty so early
		// failures never advertise a bogus token, and a server with no listening port cannot look successful.
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '$SERVER_ARCH=\n$SERVER_CONNECTION_TOKEN=\n$SERVER_DOWNLOAD_URL=', replace: '$SERVER_ARCH=""\n$SERVER_CONNECTION_TOKEN=""\n$SERVER_DOWNLOAD_URL=' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '$LISTENING_ON=\n$OS_RELEASE_ID=\n$ARCH=\n$PLATFORM=', replace: '$LISTENING_ON=""\n$OS_RELEASE_ID=""\n$ARCH=""\n$PLATFORM=' },
		// The original three-second startup window can expire before a real Windows server is ready. Closing its
		// SSH setup then ends the server too. Keep polling for thirty seconds, including cold or busy hosts.
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: 'for($I = 1; $I -le 5; $I++) {', replace: 'for($I = 1; $I -le 60; $I++) {' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: 'function printInstallResults($code) {', replace: 'function printInstallResults($code) {\n  $script:INSTALL_RESULT_PRINTED=$true\n  if($script:LOCK_STREAM) { $script:LOCK_STREAM.Close(); $script:LOCK_STREAM=$null }' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '# Test the commit of the installed server against the expected one', replace: 'trap {\n  if(!$script:INSTALL_RESULT_PRINTED) {\n    "Error while setting up server: $($_.ToString())"\n    printInstallResults 1\n  }\n  exit 1\n}\n\n# Test the commit of the installed server against the expected one' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    "Error creating server install directory - $($_.ToString())"\n    exit 1', replace: '    "Error creating server install directory - $($_.ToString())"\n    printInstallResults 1\n    exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    "Error creating server install directory"\n    exit 1', replace: '    "Error creating server install directory"\n    printInstallResults 1\n    exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: 'cd $SERVER_DIR', replace: 'cd $SERVER_DIR -ErrorAction Stop' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  # Facade Code: honor the proxy variables used by curl and wget on Unix hosts (REMOTE.md R5).', replace: '  $REQUEST_ARGUMENTS.ErrorAction="Stop"\n  # Facade Code: honor the proxy variables used by curl and wget on Unix hosts (REMOTE.md R5).' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '      "Error downloaded tarball is corrupt or incomplete"\n      exit 1', replace: '      "Error downloaded tarball is corrupt or incomplete"\n      printInstallResults 1\n      exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '      "Error while extracting server contents"\n      exit 1', replace: '      "Error while extracting server contents"\n      printInstallResults 1\n      exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    "Error while installing the server binary"\n    exit 1', replace: '    "Error while installing the server binary"\n    printInstallResults 1\n    exit 1' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  $SERVER_ID = (start @START_ARGUMENTS).ID', replace: '  $SERVER_ID = (start @START_ARGUMENTS -ErrorAction Stop).ID' },
		// 0.5.0's wrong-download branch exits without the result block its parser requires, hiding the actual mismatch.
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    Remove-Item -Recurse -Force "$SERVER_DIR\\*"\n\n    exit 1', replace: '    Remove-Item -Recurse -Force "$SERVER_DIR\\*" -ErrorAction Stop\n\n    printInstallResults 1\n    exit 1' },
		// File cmdlets report access failures as nonterminating errors by default. Without Stop, a locked stale log
		// can still advertise its old port, or an unreadable/empty token can be reported as a successful connection.
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: 'Get-Content -Raw $productJson', replace: 'Get-Content -Raw $productJson -ErrorAction Stop' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  Remove-Item -Recurse -Force "$SERVER_DIR\\*"\n}', replace: '  Remove-Item -Recurse -Force "$SERVER_DIR\\*" -ErrorAction Stop\n}' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    del $SERVER_LOGFILE', replace: '    Remove-Item -LiteralPath $SERVER_LOGFILE -Force -ErrorAction Stop' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    del $SERVER_PIDFILE', replace: '    Remove-Item -LiteralPath $SERVER_PIDFILE -Force -ErrorAction Stop' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '    del $SERVER_TOKENFILE', replace: '    Remove-Item -LiteralPath $SERVER_TOKENFILE -Force -ErrorAction Stop' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"', replace: '  $SERVER_CONNECTION_TOKEN="$(Get-Content -LiteralPath $SERVER_TOKENFILE -ErrorAction Stop)"' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '}\n\nsleep -Milliseconds 500\n\n$SELECT_ARGUMENTS', replace: '}\n\nif([string]::IsNullOrWhiteSpace($SERVER_CONNECTION_TOKEN)) {\n  "Error server token file is empty $SERVER_TOKENFILE"\n  printInstallResults 1\n  exit 1\n}\n\nsleep -Milliseconds 500\n\n$SELECT_ARGUMENTS' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '(Select-String @SELECT_ARGUMENTS).Matches.Groups', replace: '(Select-String @SELECT_ARGUMENTS -ErrorAction Stop).Matches.Groups' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '  Set-Content -NoNewLine "$SERVER_DIR\\product.json"', replace: '  Set-Content -NoNewLine -ErrorAction Stop "$SERVER_DIR\\product.json"' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '(Get-Content -Raw "$SERVER_DIR\\product.json") -replace', replace: '(Get-Content -Raw "$SERVER_DIR\\product.json" -ErrorAction Stop) -replace' },
		{ version: '0.5.0', file: 'src/scripts/server-setup.ps1', find: '# Finish server setup', replace: 'if(!$LISTENING_ON) {\n  "Error: server did not start successfully"\n  printInstallResults 1\n  exit 1\n}\n\n# Finish server setup' }
	]
};

/** How many times `text` is in `contents`. */
function occurrences(contents: string, text: string): number {
	return contents.split(text).length - 1;
}

/**
 * `contents` of `name`'s `file`, at `version`, with its patches applied; a file already patched is left as it is. A
 * patch made for another version, or whose text is not there exactly once, throws, and the package is not made.
 */
export function patchExtensionFile(name: string, version: string, file: string, contents: string): string {
	let patched = contents;
	for (const patch of extensionPatches[name] ?? []) {
		if (patch.file !== file) {
			continue;
		}
		if (patch.version !== version) {
			throw new Error(`${name}: its patch to ${file} is for ${patch.version}, not ${version}; look at the new version again`);
		}

		// One that adds lines beside the line it is found by keeps that line: once there, it is not added again
		const found = occurrences(patched, patch.find);
		if (patch.replace.includes(patch.find) && occurrences(patched, patch.replace) > 0) {
			continue;
		}
		if (found === 1) {
			patched = patched.replace(patch.find, () => patch.replace);
		} else if (found !== 0 || occurrences(patched, patch.replace) === 0) {
			throw new Error(`${name} ${version}: '${patch.find}' is in ${file} ${found} times, not once`);
		}
	}
	return patched;
}

/**
 * Whether `name`'s copy in `folder`, at `version`, has its patches: a copy synced before one was added has not, and is
 * synced again, as a window run from the sources loads it as it is.
 */
export function isExtensionPatched(name: string, version: string, folder: string): boolean {
	for (const patch of extensionPatches[name] ?? []) {
		const file = path.join(folder, patch.file);
		if (!fs.existsSync(file)) {
			return false;
		}
		const contents = fs.readFileSync(file, 'utf8');
		try {
			if (patchExtensionFile(name, version, patch.file, contents) !== contents) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

/** Written in a synced extension's folder once all its files are: a sync cut short leaves none (REMOTE.md R5). */
export const SYNCED_MARK = '.facade-synced';

/**
 * Whether the copy of `name` in `folder` is `version`, written whole - marked with `stamp`, its version and checksum -
 * and patched. Its package.json is written first, so a sync cut short - a download failing, the build stopped - leaves
 * one that its version alone would pass.
 */
export function isSyncedCopyCurrent(folder: string, name: string, version: string, stamp: string): boolean {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
		return manifest.version === version
			&& fs.readFileSync(path.join(folder, SYNCED_MARK), 'utf8') === stamp
			&& isExtensionPatched(name, version, folder);
	} catch {
		return false;
	}
}

/** Marks the copy in `folder` as written whole, with `stamp`; nothing when the sync wrote nothing. */
export function markSyncedCopy(folder: string, stamp: string): void {
	if (fs.existsSync(folder)) {
		fs.writeFileSync(path.join(folder, SYNCED_MARK), stamp);
	}
}

/** All of `file`'s contents: a downloaded extension's files come as streams, unpacked from its VSIX. */
function contentsOf(file: File): Promise<Buffer> {
	if (!file.isStream()) {
		return Promise.resolve(file.isBuffer() ? file.contents : Buffer.alloc(0));
	}
	const chunks: Buffer[] = [];
	return new Promise((resolve, reject) => {
		file.contents.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
		file.contents.on('end', () => resolve(Buffer.concat(chunks)));
		file.contents.on('error', reject);
	});
}

/**
 * Applies `name`'s patches to its files passing through, at `version`, each named relative to the extension's folder
 * or under its name; fails, once they have all passed, when a file it patches was not among them.
 */
export function patchExtension(name: string, version: string): NodeJS.ReadWriteStream {
	const patches = extensionPatches[name] ?? [];
	const seen = new Set<string>();

	return new Transform({
		objectMode: true,
		transform(file: File, _encoding: BufferEncoding, callback: TransformCallback) {
			const relative = file.relative.replace(/\\/g, '/');
			const within = relative.startsWith(`${name}/`) ? relative.slice(name.length + 1) : relative;
			if (file.isNull() || !patches.some(patch => patch.file === within)) {
				callback(null, file);
				return;
			}

			contentsOf(file).then(contents => {
				let patched: string;
				try {
					patched = patchExtensionFile(name, version, within, contents.toString('utf8'));
				} catch (error) {
					callback(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				file.contents = Buffer.from(patched);
				seen.add(within);
				callback(null, file);
			}, error => callback(error));
		},
		flush(callback: TransformCallback) {
			const missing = patches.filter(patch => !seen.has(patch.file)).map(patch => patch.file);
			callback(missing.length ? new Error(`${name} ${version}: ${missing.join(', ')} was not there to patch`) : null);
		}
	});
}
