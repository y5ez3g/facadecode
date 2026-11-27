use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use sha2::{Digest, Sha256};

use super::files::{self, Access, Scratch, TextFile};
use super::{SshMode, os, protected_login_options, ssh_login_args, strict_login_args};

const KEY_FILE: &str = "id_ed25519";
const PUBLIC_KEY_FILE: &str = "id_ed25519.pub";
const MAX_KEY_BYTES: usize = 16 * 1024;
const MAX_PROOF_BYTES: usize = 1024 * 1024;

pub struct DedicatedIdentity {
    pub key_path: PathBuf,
    pub public_key: String,
}

/// Creates one private identity per Facade home and derives its public key on reuse.
pub fn dedicated_identity(home: &Path) -> anyhow::Result<DedicatedIdentity> {
    let directory = files::credentials_dir(home)?;
    let key_path = directory.join(KEY_FILE);
    let _lock = files::lock(&directory.join("identity.lock"), Access::Account)?;
    let public_key = match fs::symlink_metadata(&key_path) {
        Ok(_) => read_identity(&key_path)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let scratch = Scratch::new(&directory)?;
            let generated = scratch.path().join(KEY_FILE);
            let status = Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-C", "Facade", "-f"])
                .arg(&generated)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .status()
                .context("starting ssh-keygen to create the Facade Code Framework SSH identity")?;
            ensure!(
                status.success(),
                "ssh-keygen could not create the Facade Code Framework SSH identity"
            );
            os::protect_private_key(&generated)?;
            let public_key = read_identity(&generated)?;
            fs::rename(&generated, &key_path)?;
            public_key
        }
        Err(error) => return Err(error.into()),
    };
    let public_path = directory.join(PUBLIC_KEY_FILE);
    let mut persisted = TextFile::read(&public_path)?;
    let public_line = format!("{public_key}\n").into_bytes();
    if persisted.bytes != public_line {
        persisted.bytes = public_line;
        persisted.write(&public_path, Access::Account)?;
    }
    Ok(DedicatedIdentity {
        key_path,
        public_key,
    })
}

fn read_identity(path: &Path) -> anyhow::Result<String> {
    os::check_private(path, false)?;
    ensure!(
        fs::metadata(path)?.len() <= MAX_KEY_BYTES as u64,
        "the Facade Code Framework SSH private key is too large"
    );
    let mut child = Command::new("ssh-keygen")
        .args(["-y", "-P", "", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .context("starting ssh-keygen to validate the Facade Code Framework SSH identity")?;
    let mut output = Vec::new();
    let read = child
        .stdout
        .take()
        .expect("ssh-keygen stdout was piped")
        .take(MAX_KEY_BYTES as u64 + 1)
        .read_to_end(&mut output);
    let status = child.wait()?;
    read?;
    ensure!(
        status.success() && output.len() <= MAX_KEY_BYTES,
        "ssh-keygen could not validate the Facade Code Framework SSH identity {}",
        path.display()
    );
    let key = PublicKey::parse(std::str::from_utf8(&output)?.trim_end_matches(['\r', '\n']))?;
    ensure!(
        key.kind == "ssh-ed25519",
        "the Facade Code Framework SSH identity must be Ed25519"
    );
    Ok(key.line())
}

pub struct SshKeyProof {
    _scratch: Scratch,
    log_path: PathBuf,
    fingerprint: String,
}

impl SshKeyProof {
    pub fn new(home: &Path, identity: &DedicatedIdentity) -> anyhow::Result<Self> {
        let key = PublicKey::parse(&identity.public_key)?;
        ensure!(
            key.kind == "ssh-ed25519",
            "the Facade Code Framework SSH identity must be Ed25519"
        );
        let fingerprint = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(&key.blob))
        );
        let scratch = Scratch::new(&files::credentials_dir(home)?)?;
        let log_path = scratch.path().join("proof.log");
        os::create_file(&log_path, Access::Account)?;
        Ok(Self {
            _scratch: scratch,
            log_path,
            fingerprint,
        })
    }

    /// Complete OpenSSH login argv for this independent proof attempt.
    pub fn login_args(&self, args: &[String]) -> anyhow::Result<Vec<OsString>> {
        let args = protected_login_options(args, "Eqvy")?;
        let args = strict_login_args(&args, None)?;
        let mut words = vec![
            OsString::from("-o"),
            OsString::from("LogLevel=DEBUG3"),
            OsString::from("-o"),
            OsString::from("FingerprintHash=sha256"),
            OsString::from("-E"),
            self.log_path.clone().into_os_string(),
        ];
        words.extend(ssh_login_args(&args, SshMode::Saved, None)?);
        Ok(words)
    }

    /// Requires the signed public-key request for this fingerprint to complete authentication.
    pub fn verify(&self) -> anyhow::Result<()> {
        let log = files::read_limited(&self.log_path, MAX_PROOF_BYTES)?;
        let log = String::from_utf8_lossy(&log);
        let mut signing = false;
        let mut signed_request = false;
        let mut accepted = false;
        for record in log.split_inclusive('\n') {
            if !record.ends_with('\n') {
                break;
            }
            let line = record.trim_end_matches(['\n', '\r']);
            if let Some(key) = line.strip_prefix("debug3: sign_and_send_pubkey: signing using ") {
                signing = key.split_once(' ') == Some(("ssh-ed25519", &self.fingerprint));
            } else if line.starts_with("debug1: Offering public key: ")
                || line.starts_with("debug1: Trying private key: ")
            {
                signing = false;
            } else if line == "debug3: send packet: type 50" {
                signed_request = std::mem::take(&mut signing);
                accepted = false;
            } else if line == "debug3: receive packet: type 51" {
                signing = false;
                signed_request = false;
                accepted = false;
            } else if line == "debug3: receive packet: type 52" {
                accepted = std::mem::take(&mut signed_request);
            } else if line.starts_with("Authenticated to ") {
                if accepted && line.ends_with(" using \"publickey\".") {
                    return Ok(());
                }
                break;
            }
        }
        anyhow::bail!(
            "OpenSSH did not prove that the dedicated Facade Code Framework SSH key ({}) completed public-key authentication",
            self.fingerprint
        )
    }
}

pub(super) struct PublicKey<'a> {
    pub(super) kind: &'a str,
    encoded: &'a str,
    blob: Vec<u8>,
}

impl<'a> PublicKey<'a> {
    pub(super) fn parse(input: &'a str) -> anyhow::Result<Self> {
        ensure!(
            input.len() <= MAX_KEY_BYTES && !input.contains(['\0', '\r', '\n']),
            "expected one bounded SSH public key"
        );
        let mut fields = input.split_ascii_whitespace();
        let kind = fields.next().context("missing SSH public key type")?;
        let encoded = fields.next().context("missing SSH public key data")?;
        let blob = STANDARD
            .decode(encoded)
            .context("invalid SSH public key base64")?;
        let mut wire = blob.as_slice();
        ensure!(
            wire_field(&mut wire) == Some(kind.as_bytes()),
            "SSH public key type does not match its data"
        );
        let valid = match kind {
            "ssh-ed25519" => wire_field(&mut wire).is_some_and(|key| key.len() == 32),
            "ssh-rsa" => {
                positive_mpint(wire_field(&mut wire)) && positive_mpint(wire_field(&mut wire))
            }
            "ecdsa-sha2-nistp256" => ecdsa(&mut wire, b"nistp256", 65),
            "ecdsa-sha2-nistp384" => ecdsa(&mut wire, b"nistp384", 97),
            "ecdsa-sha2-nistp521" => ecdsa(&mut wire, b"nistp521", 133),
            _ => false,
        };
        ensure!(
            valid && wire.is_empty(),
            "invalid or unsupported SSH public key"
        );
        Ok(Self {
            kind,
            encoded,
            blob,
        })
    }

    pub(super) fn line(&self) -> String {
        format!("{} {}", self.kind, self.encoded)
    }

    pub(super) fn matches(&self, kind: &[u8], encoded: &[u8]) -> bool {
        self.kind.as_bytes() == kind && self.encoded.as_bytes() == encoded
    }
}

fn wire_field<'a>(wire: &mut &'a [u8]) -> Option<&'a [u8]> {
    let (length, rest) = wire.split_first_chunk::<4>()?;
    let (field, rest) = rest.split_at_checked(u32::from_be_bytes(*length) as usize)?;
    *wire = rest;
    Some(field)
}

fn positive_mpint(field: Option<&[u8]>) -> bool {
    match field {
        Some([0, next, ..]) => next & 0x80 != 0,
        Some([first, ..]) => *first != 0 && first & 0x80 == 0,
        _ => false,
    }
}

fn ecdsa(wire: &mut &[u8], curve: &[u8], length: usize) -> bool {
    wire_field(wire) == Some(curve)
        && wire_field(wire).is_some_and(|point| point.len() == length && point[0] == 4)
}

pub fn host_public_keys() -> anyhow::Result<Vec<String>> {
    let mut directory = os::host_key_directory()?;
    if cfg!(debug_assertions)
        && let Some(fixture) = std::env::var_os("FACADE_TEST_SSH_HOST_KEYS")
    {
        directory = PathBuf::from(fixture);
        ensure!(
            directory.is_absolute(),
            "FACADE_TEST_SSH_HOST_KEYS must be absolute"
        );
    }
    let mut keys = Vec::new();
    for kind in ["ed25519", "ecdsa", "rsa"] {
        let path = directory.join(format!("ssh_host_{kind}_key.pub"));
        let bytes = match files::read_limited(&path, MAX_KEY_BYTES) {
            Ok(bytes) => bytes,
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        };
        let key = std::str::from_utf8(&bytes)?.trim_end_matches(['\r', '\n']);
        keys.push(
            PublicKey::parse(key)
                .with_context(|| format!("reading {}", path.display()))?
                .line(),
        );
    }
    ensure!(
        !keys.is_empty(),
        "no OpenSSH host public keys found in {}",
        directory.display()
    );
    Ok(keys)
}

pub struct HostTrust {
    path: PathBuf,
    added: Option<NativeAppend>,
}

/// The installation may have written trust entries whose cleanup could not be confirmed.
#[derive(Debug)]
pub struct HostTrustCleanupUnconfirmed;

impl fmt::Display for HostTrustCleanupUnconfirmed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("could not confirm cleanup of the appended known_hosts records")
    }
}

impl std::error::Error for HostTrustCleanupUnconfirmed {}

impl HostTrust {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn rollback(self) -> anyhow::Result<()> {
        let Some(append) = self.added else {
            return Ok(());
        };
        check_native_known_hosts(&self.path)?;
        let _lock = host_trust_lock(&self.path)?;
        append.erase(&self.path)
    }
}

struct NativeAppend {
    identity: os::KnownHostsFileId,
    start: u64,
    bytes: Vec<u8>,
}

impl NativeAppend {
    fn confirm(&self, file: &mut fs::File) -> anyhow::Result<Vec<u8>> {
        ensure!(
            os::known_hosts_file_id(file)? == self.identity,
            "the native known_hosts file changed"
        );
        file.seek(SeekFrom::Start(self.start))?;
        let mut record = vec![0; self.bytes.len()];
        file.read_exact(&mut record)?;
        ensure!(
            record == self.bytes,
            "the appended known_hosts record changed"
        );
        Ok(record)
    }

    fn erase(&self, path: &Path) -> anyhow::Result<()> {
        check_native_known_hosts(path)?;
        let mut file = fs::OpenOptions::new().read(true).write(true).open(path)?;
        let mut record = self.confirm(&mut file)?;
        ensure_current_file(path, self.identity)?;
        let mut start = self.start;
        for line in record.split_inclusive_mut(|&byte| byte == b'\n') {
            let end = line.trim_ascii_end().len();
            if end != 0 {
                // Keep the record a comment until the rest of it is confirmed blank. A short
                // write cannot turn a suffix of the old record into active trust.
                file.seek(SeekFrom::Start(start))?;
                file.write_all(b"#")?;
                line[..end].fill(b' ');
                file.write_all(&line[1..end])?;
                file.seek(SeekFrom::Start(start))?;
                let mut comment = vec![0; end];
                file.read_exact(&mut comment)?;
                ensure!(
                    comment[0] == b'#' && comment[1..] == line[1..end],
                    "could not confirm blanking of the known_hosts record"
                );
                file.seek(SeekFrom::Start(start))?;
                file.write_all(b" ")?;
            }
            start += line.len() as u64;
        }
        file.sync_data()?;
        ensure_current_file(path, self.identity)?;
        file.seek(SeekFrom::Start(self.start))?;
        let mut erased = vec![0; record.len()];
        file.read_exact(&mut erased)?;
        ensure!(
            erased == record,
            "could not confirm erasure of the known_hosts record"
        );
        Ok(())
    }
}

/// Adds host keys received on the authenticated forward channel after an unknown-host result.
pub fn trust_host_keys(
    ssh_args: &[String],
    address: IpAddr,
    keys: &[String],
) -> anyhow::Result<HostTrust> {
    ensure!(!keys.is_empty(), "no SSH host public keys supplied");
    let keys = keys
        .iter()
        .map(|key| PublicKey::parse(key))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let ssh_dir = os::user_ssh_directory()?;
    let (host, path, hashed) = native_known_hosts(ssh_args, address, &ssh_dir)?;
    let result = append_host_keys(&ssh_dir, &host, &path, &keys, hashed);
    result.with_context(|| format!(
        "cannot update {} for the SSH return connection. Verify the return host in your configured SSH trust and retry",
        path.display()
    ))
}

fn append_host_keys(
    ssh_dir: &Path,
    host: &str,
    path: &Path,
    keys: &[PublicKey<'_>],
    hashed: bool,
) -> anyhow::Result<HostTrust> {
    files::ensure_directory(ssh_dir, Access::Account)?;
    check_known_hosts_parent(ssh_dir, path)?;
    let _lock = host_trust_lock(path)?;
    if let Err(error) = os::create_file(path, Access::Account)
        && error.kind() != io::ErrorKind::AlreadyExists
    {
        return Err(error.into());
    }
    os::check_known_hosts_access(path, false)?;
    let identity = os::known_hosts_file_id(&fs::File::open(path)?)?;
    // Some OpenSSH builds share reads only. Run keygen without an open write handle.
    let mut bytes = new_host_records(host, path, keys, hashed)?;
    if bytes.is_empty() {
        return Ok(HostTrust {
            path: path.to_owned(),
            added: None,
        });
    }
    let mut file = fs::OpenOptions::new().read(true).append(true).open(path)?;
    ensure!(
        os::known_hosts_file_id(&file)? == identity,
        "the native known_hosts file changed"
    );
    if file.metadata()?.len() != 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            bytes.insert(0, b'\n');
        }
    }
    ensure_current_file(path, identity)?;
    // One native append write keeps complete records together even across other appenders.
    let count = loop {
        match file.write(&bytes) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => break result?,
        }
    };
    ensure!(count != 0, "could not write the native known_hosts append");
    let complete = count == bytes.len();
    bytes.truncate(count);
    let end = file
        .stream_position()
        .context("could not confirm the appended known_hosts location")
        .context(HostTrustCleanupUnconfirmed)?;
    let start = end
        .checked_sub(count as u64)
        .context("could not confirm the appended known_hosts location")
        .context(HostTrustCleanupUnconfirmed)?;
    let synced = file.sync_data();
    drop(file);
    let append = NativeAppend {
        identity,
        start,
        bytes,
    };
    let confirmation = (|| {
        ensure!(complete, "could not complete the native known_hosts append");
        synced.context("syncing the native known_hosts append")?;
        append.confirm(&mut fs::File::open(path)?)?;
        Ok(())
    })();
    if let Err(error) = confirmation {
        return match append.erase(path) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup
                .context(format!(
                    "rolling back a failed known_hosts append ({error:#})"
                ))
                .context(HostTrustCleanupUnconfirmed)),
        };
    }
    Ok(HostTrust {
        path: path.to_owned(),
        added: Some(append),
    })
}

fn new_host_records(
    host: &str,
    path: &Path,
    keys: &[PublicKey<'_>],
    hashed: bool,
) -> anyhow::Result<Vec<u8>> {
    let lookup = super::super::programs::command("ssh-keygen")
        .args(["-F", host, "-f"])
        .arg(path)
        .output()
        .context("checking existing native known_hosts records")?;
    ensure!(
        lookup.status.success()
            || (lookup.status.code() == Some(1)
                && lookup.stderr.is_empty()
                && lookup.stdout.is_empty()),
        "ssh-keygen could not check existing native known_hosts records"
    );
    let nonce = crate::random_u64();
    let mut entries = Vec::new();
    for key in keys {
        if lookup.stdout.split(|&byte| byte == b'\n').any(|line| {
            let mut fields = line
                .split(|byte| byte.is_ascii_whitespace())
                .filter(|field| !field.is_empty());
            fields
                .next()
                .is_some_and(|name| !name.starts_with(b"#") && !name.starts_with(b"@"))
                && fields
                    .next()
                    .zip(fields.next())
                    .is_some_and(|(kind, encoded)| key.matches(kind, encoded))
        }) {
            continue;
        }
        let entry = format!("{host} {} facade-return-{nonce:016x}\n", key.line()).into_bytes();
        if !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    let bytes = entries.concat();
    if !hashed || bytes.is_empty() {
        return Ok(bytes);
    }
    let scratch = Scratch::new(path.parent().expect("a native known_hosts parent"))?;
    let input = scratch.path().join("known_hosts");
    os::create_file(&input, Access::Account)?.write_all(&bytes)?;
    let status = super::super::programs::command("ssh-keygen")
        .args(["-q", "-H", "-f"])
        .arg(&input)
        .stdin(Stdio::null())
        .output()
        .context("hashing the native known_hosts records")?;
    ensure!(
        status.status.success(),
        "ssh-keygen could not hash the new known_hosts records"
    );
    let result = files::read_limited(&input, bytes.len() + 128 * entries.len())?;
    ensure!(
        result.ends_with(b"\n")
            && result.split_inclusive(|&byte| byte == b'\n').count() == entries.len()
            && result
                .split_inclusive(|&byte| byte == b'\n')
                .all(|line| line.starts_with(b"|1|")),
        "ssh-keygen did not produce the expected hashed known_hosts records"
    );
    Ok(result)
}

fn ensure_current_file(path: &Path, identity: os::KnownHostsFileId) -> anyhow::Result<()> {
    let current = fs::File::open(path)?;
    ensure!(
        os::known_hosts_file_id(&current)? == identity,
        "the native known_hosts file changed"
    );
    Ok(())
}

const TRUST_LOCK: &str = ".facade-known-hosts.lock";

fn host_trust_lock(path: &Path) -> io::Result<fs::File> {
    files::lock(&path.with_file_name(TRUST_LOCK), Access::Account)
}

fn native_known_hosts(
    ssh_args: &[String],
    address: IpAddr,
    ssh_dir: &Path,
) -> anyhow::Result<(String, PathBuf, bool)> {
    let diagnostic = "cannot locate a safe configured user known_hosts file for the exact SSH return address. Verify the return host in your configured SSH trust and retry";
    let args = protected_login_options(ssh_args, "E")?;
    let output = super::super::programs::command("ssh")
        .arg("-G")
        .args(ssh_login_args(&args, SshMode::Saved, None)?)
        .stdin(Stdio::null())
        .output()
        .context("reading the return connection's OpenSSH configuration")?;
    ensure!(output.status.success(), "{diagnostic}");
    let config = std::str::from_utf8(&output.stdout).context(diagnostic)?;
    let option = |name: &str| {
        config.lines().find_map(|line| {
            let (key, value) = line.split_once(' ')?;
            (key == name).then_some(value)
        })
    };
    let host = option("hostname").context(diagnostic)?;
    ensure!(
        host.parse::<IpAddr>().ok() == Some(address)
            && option("port") == Some("22")
            && option("hostkeyalias").is_none(),
        "{diagnostic}"
    );
    let configured = option("userknownhostsfile").context(diagnostic)?;
    let path = user_known_hosts_file(configured, ssh_dir).context(diagnostic)?;
    let hashed = match option("hashknownhosts") {
        Some("true" | "yes") => true,
        Some("false" | "no") => false,
        _ => anyhow::bail!("could not determine OpenSSH HashKnownHosts for the return connection"),
    };
    Ok((host.to_owned(), path, hashed))
}

fn user_known_hosts_file(configured: &str, ssh_dir: &Path) -> anyhow::Result<PathBuf> {
    // OpenSSH's dump joins the list without quoting. Recognize the stock pair as a whole,
    // and accept a single literal path. An ambiguous custom list needs native enrollment.
    let default = ssh_dir.join("known_hosts");
    let home = ssh_dir
        .parent()
        .expect("an SSH directory has a parent")
        .display();
    let path = if configured == format!("{home}/.ssh/known_hosts {home}/.ssh/known_hosts2")
        || configured
            == format!(
                "{} {}",
                default.display(),
                ssh_dir.join("known_hosts2").display()
            ) {
        default
    } else if let Some(relative) = configured.strip_prefix("~/.ssh/") {
        ensure!(
            os::tilde_ssh_directory()? == ssh_dir,
            "SSH and the current account use different home directories"
        );
        if relative == "known_hosts ~/.ssh/known_hosts2" {
            default
        } else {
            ssh_dir.join(relative)
        }
    } else {
        PathBuf::from(configured)
    };
    known_hosts_relative(ssh_dir, &path)?;
    Ok(path)
}

fn known_hosts_relative<'a>(ssh_dir: &Path, path: &'a Path) -> anyhow::Result<&'a Path> {
    let relative = path.strip_prefix(ssh_dir)?;
    ensure!(
        path.is_absolute()
            && path.file_name().is_some_and(|name| name != TRUST_LOCK)
            && path.to_str().is_some_and(|name| !name.contains(['%', '$']) && !name.chars().any(char::is_control))
            && !relative.as_os_str().is_empty()
            && relative.components().all(|component| matches!(component, Component::Normal(name)
                if name.to_str().is_some_and(|name| !name.contains(':') && !name.chars().any(char::is_whitespace)))),
        "expected a literal known_hosts file under the SSH account's .ssh directory"
    );
    Ok(relative)
}

fn check_known_hosts_parent(ssh_dir: &Path, path: &Path) -> anyhow::Result<()> {
    let relative = known_hosts_relative(ssh_dir, path)?;
    let mut parent = ssh_dir.to_owned();
    os::check_known_hosts_access(&parent, true)?;
    for component in relative
        .parent()
        .expect("a known hosts basename")
        .components()
    {
        parent.push(component);
        os::check_known_hosts_access(&parent, true)?;
    }
    Ok(())
}

pub(super) fn check_native_known_hosts(path: &Path) -> anyhow::Result<()> {
    check_known_hosts_parent(&os::user_ssh_directory()?, path)?;
    os::check_known_hosts_access(path, false)
}
