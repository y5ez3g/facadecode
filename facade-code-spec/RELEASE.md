# Release

How to make a copy of Facade Code that opens on somebody else's computer: a disk image for
macOS, an installer for Windows, a `.deb` package for Ubuntu.

# macOS

```sh
npm run release-mac
```

That is the whole of it once the one-time setup below is done. It builds, signs with the
team's Developer ID, packages a `.dmg`, has Apple notarize it, staples the ticket and checks
that Gatekeeper accepts the result. The disk image lands one directory above the repository:

```
../facade-code-darwin-arm64.dmg      what you hand out
../VSCode-darwin-arm64/Facade Code.app
```

⚠️ **Every build has to go through all of it again.** A signature and a notarization ticket
are for the exact bytes they were made over. Rebuild and both are gone.

## What it does

`build/darwin/release-local.ts`, in order:

```
1  find the signing identity      before the build, so a missing one fails in seconds
2  npm run gulp vscode-darwin-<arch>-min          ~8 min
3  check the app has a commit     without one it loads no terminal and no syntax highlighting
4  build/darwin/sign.ts           hardened runtime, per-helper entitlements
5  codesign --verify --deep --strict
6  build/darwin/create-dmg.ts
7  codesign the .dmg itself
8  notarytool submit, then ask every 60 s until Apple answers
9  stapler staple
10 spctl --assess                 the same check Gatekeeper makes on another Mac
```

Steps 4, 6 and the entitlements are the ones CI uses; the script only runs them on a
developer's Mac instead of a build agent. Step 3 is there because nothing else gives a
missing commit away: the build reads it from git's files, and an app without one takes
itself for one run from the sources. A build in a worktree of git's once made such an
app, before `build/lib/git.ts` read worktrees.

## Options

```
npm run release-mac -- --skip-build      sign and package the app already built
npm run release-mac -- --skip-notarize   signed only - fine for your own Mac, not for anyone else's
```

```
CODESIGN_IDENTITY        which identity to sign with; unset, the one "Developer ID Application"
                         identity in the keychain is used, and more than one is an error
NOTARY_KEYCHAIN_PROFILE  the notarytool profile; defaults to facade-notary
NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER
                         an API key used directly instead of the profile
VSCODE_ARCH              arm64 or x64; defaults to this Mac's
```

## Just for yourself

You do not need any of this to run your own build. Build it, then clear the quarantine
flag once:

```sh
npm run gulp vscode-darwin-arm64-min
xattr -cr "../VSCode-darwin-arm64/Facade Code.app"
```

Signing and notarizing matter only for a copy that leaves this machine.

## One-time setup

Two things, both from the Apple Developer account. Neither lives in the repository.

### 1. A Developer ID Application certificate

`Apple Development` certificates, which Xcode makes on its own, **cannot** sign something for
distribution. It has to be `Developer ID Application`, and only the account holder can make one.

```sh
openssl req -new -newkey rsa:2048 -nodes -keyout devid.key -out devid.csr \
  -subj "/emailAddress=<you>/CN=Facade Code Developer ID/C=US"
```

On developer.apple.com → Certificates → + → **Developer ID Application** → **G2 Sub-CA** →
upload `devid.csr` → download `developerID_application.cer`. Then:

```sh
openssl rsa -in devid.key -traditional -out devid.rsa.pem     # see below
security import devid.rsa.pem -k ~/Library/Keychains/login.keychain-db -t priv -f openssl \
  -T /usr/bin/codesign -T /usr/bin/productsign
security import developerID_application.cer -k ~/Library/Keychains/login.keychain-db
security find-identity -v -p codesigning | grep "Developer ID Application"
rm -P devid.key devid.rsa.pem devid.csr
```

⚠️ OpenSSL 3 writes a PKCS#8 key (`BEGIN PRIVATE KEY`), and `security import -f openssl`
refuses it with `Unknown format in import`. The `-traditional` step turns it into the
`BEGIN RSA PRIVATE KEY` it expects.

⚠️ The private key is now only in the login keychain. **Export a backup** (Keychain Access →
My Certificates → the certificate → Export, as a password-protected `.p12`) and keep it
somewhere safe. Lose it and the certificate has to be revoked and made again.

### 2. Credentials for the notary service

An App Store Connect **API key**, not an app-specific password - it does not break when the
Apple ID's password changes, and it cannot be typed wrong.

On appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API.
The first time asks you to **Request Access**; for an individual account it is granted at
once. Then **Generate API Key** with the **Developer** role, and **Download** it.

⚠️ **The `.p8` can be downloaded exactly once.** Move it out of `~/Downloads` straight away:

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_<KEY_ID>.p8 ~/.appstoreconnect/private_keys/
chmod 600 ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8

xcrun notarytool store-credentials facade-notary \
  --key ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 \
  --key-id <KEY_ID> --issuer <ISSUER_ID>
```

The Key ID and the Issuer ID are on the same page as the key.

## When it goes wrong

**"You can't open the application because it may be damaged or incomplete."** Usually not
the build: the copy into `/Applications` was opened before it had finished. Check that
`Contents/MacOS/Facade Code` exists in the installed app; if not, copy it again.

**Notarization stays `In Progress` for hours.** Expected for a Developer ID's **first**
submission - ours took ten and a half hours - and minutes after that. The script keeps asking
for up to 24 hours, and survives the network dropping in between. If it gives up, the
submission is still going on at Apple; it prints the two commands that pick it up again:

```sh
xcrun notarytool info <id> --keychain-profile facade-notary
xcrun stapler staple ../facade-code-darwin-arm64.dmg
```

**Notarization comes back `Invalid`.** The script prints Apple's log, which names every file
it rejected and why. `xcrun notarytool log <id> --keychain-profile facade-notary` fetches it
again.

**`No Keychain password item found for profile: facade-notary`.** Seen once, after the
Mac had been asleep; the cause was not found. Run `store-credentials` above again - it needs
the `.p8`, which is one reason to keep it where it can be found.

**`HTTP status code: 401` from `store-credentials` with an app-specific password.** The
password was made under a different Apple ID than the one given, or the account password
was typed instead. Use the API key.

**`Unknown format in import`.** See the `-traditional` step above.

# Windows

```powershell
npm run release-win
```

Once the one-time setup below is done, that builds, signs every executable in the package,
makes the user installer, signs it and its uninstaller and checks each signature. The
installer lands one directory above the repository:

```
../facade-win32-x64-user-setup.exe     what you hand out
../VSCode-win32-x64/                    what it installs
```

The certificate never comes to this machine. Azure Artifact Signing keeps it: signtool hashes
each file here, sends the digest to Azure and gets the signature back. Signing in with
`az login` is what lets it sign.

⚠️ **Nothing unsigned runs where Smart App Control is on** - not the installer, and not any
`.exe`, `.dll` or `.node` inside the package, which it refuses one by one at run time. There is
no "Run anyway": that is SmartScreen, a different check. Our own development PC has it on, so
even a build for ourselves has to be signed.

## What it does

`build/win32/release-local.ts`, in order:

```
1  find signtool, the Artifact Signing client and the Azure sign-in    before the build
2  npm run gulp vscode-win32-x64-min                ~15 min
3  npm run gulp vscode-win32-x64-inno-updater
4  sign each .exe, .dll and .node signtool does not already accept      ~45 files
5  npm run gulp vscode-win32-x64-user-setup -- --sign                   ~7 min
6  check the installer's signature and copy it out
```

Step 2 runs signtool itself - it takes the signatures off files rcedit is about to rewrite -
and finds it only on `PATH`, which step 1 sees to. Step 4 leaves alone what Electron and
Microsoft signed already; the account has 5,000 signatures a month. In step 5 Inno Setup signs
through `build/win32/sign.ts`, which also signs files on its own: `node build/win32/sign.ts <file>...`.

Every signature is timestamped. Azure's certificate lives three days and is renewed every
day; the timestamp is what keeps a signature valid after that.

## Options

```
npm run release-win -- --skip-build      sign and package the build already in ../VSCode-win32-<arch>
```

```
VSCODE_ARCH                 x64 or arm64; defaults to this PC's
ARTIFACT_SIGNING_ENDPOINT   another Artifact Signing account than ours (below)
ARTIFACT_SIGNING_ACCOUNT
ARTIFACT_SIGNING_PROFILE
ARTIFACT_SIGNING_DLIB       the client's Azure.CodeSigning.Dlib.dll, if not where it installs it
SIGNTOOL                    signtool.exe, if not the newest Windows SDK's
```

## One-time setup

### 1. The build machine

```powershell
winget install Microsoft.AzureCLI
winget install Microsoft.Azure.ArtifactSigningClientTools
az login                     # in a new terminal, so az is on PATH
```

signtool comes with the Windows SDK, which building Facade Code needs anyway. `az login` is
as the Azure account that owns the subscription.

### 2. The Artifact Signing account

Done once, in October 2026. What there is:

```
Account URI          https://eus.codesigning.azure.net/      East US, Basic
Account              facadecode        resource group facadecode
Certificate profile  facadecode        Public Trust
Subject              CN=Yuanzhe Zhang, O=Yuanzhe Zhang, L=Mountain View, S=ca, C=US
```

Windows shows the `CN` as the verified publisher (IDENTITY.md I6). Redoing it, in the Azure
portal, on the account:

1. **Access control (IAM)** → Add role assignment → **Artifact Signing Identity Verifier**,
   to yourself. Without it the identity page greys out New identity.
2. **Identity validations** → switch the list from Organizations to **Individuals** → New
   identity → **Public**. The name and address come from the billing account and cannot be
   changed here; they must match the photo ID. Submit.
3. The status turns **Action Required**; its link opens a QR code for Microsoft Authenticator.
   No email comes. The first time, "Get verified here" takes you to an ID checker - a photo of
   the ID and a selfie - which puts a Verified ID in Authenticator; scan the QR code with it.
   The status turns **Completed**.
4. **Certificate profiles** → Create → **Public Trust**, the validated identity, street and
   postal code left out.
5. **Access control (IAM)** → **Artifact Signing Certificate Profile Signer**, to the account
   `az login` uses.

⚠️ An individual can be validated only as a resident of the United States or Canada.

⚠️ **The identity validation lasts a year** - ours until 14 October 2027. Renew it on the
Identity validations page before then, or signing stops.

## When it goes wrong

**`Not signed in to Azure, or no az command`.** `az login`; if `az` is not found, open a new
terminal - the installer put it on `PATH` for terminals started after it.

**`403` from signtool.** The signed-in account lacks the Certificate Profile Signer role, or
was given it in the last few minutes; role assignments take a while to arrive.

**`spawn signtool.exe ENOENT` after twenty minutes of building.** The gulp task was run on its
own, without signtool on `PATH`. Run `npm run release-win -- --skip-build`; the compiling is
done.

**`Cannot find type definition file for 'node'` in an extension, half a minute in.** A pull
gave an extension dependencies it did not have at the last `npm install`. Run it again at the
root; it installs every extension's.

**The log is full of "error".** Inno Setup lists every file it compresses, `errors.js`
included, and warns that some languages lack its download messages. A good run ends with
`Ready to hand to anyone`.

**Smart App Control still blocks something.** Event Viewer → Applications and Services Logs →
Microsoft → Windows → CodeIntegrity → Operational, events 3033 and 3077, names the file.

# Ubuntu

```sh
export PERL5LIB=<jammy's Dpkg modules>/usr/share/perl5     # once per terminal; see below
export FACADE_DEB_DEPENDENCIES=warn
npm run gulp vscode-linux-x64-min
npm run gulp vscode-linux-x64-prepare-deb
npm run gulp vscode-linux-x64-build-deb
```

The package lands inside the repository, the application one directory above it:

```
.build/linux/deb/amd64/deb/facade_<version>-<timestamp>_amd64.deb     what you hand out
../VSCode-linux-x64/                                                  what it installs
```

⚠️ **Step 2 deletes `.build/linux/deb/amd64` first, the last package with it.** Copy a package
out before running it again.

A `.deb` is not signed: `sudo apt install ./facade_<version>-<timestamp>_amd64.deb` installs it,
and its dependencies with it, on any other Ubuntu.

## What it does

```
1  vscode-linux-x64-min           compile and package the application            ~7 min
2  vscode-linux-x64-prepare-deb   lay out the package, work out its dependencies  ~20 s
3  vscode-linux-x64-build-deb     check the version, compress with xz              ~3 min
```

Step 2 finds the shared libraries each binary needs with Chromium's copy of `dpkg-shlibdeps`,
against the sysroots it downloads (`build/linux/debian/install-sysroot.ts`), and writes them
into `DEBIAN/control` as `Depends`. Step 3 reads the version back against IDENTITY.md's table
before `dpkg-deb` runs.

## One-time setup

Node 24 and `npm install`, as for any build, and `fakeroot` and `dpkg-deb`, which Ubuntu has.

Chromium's `dpkg-shlibdeps.pl` runs on the system's Perl `Dpkg` modules, and Ubuntu's newer than
22.04's no longer fit it. Take 22.04's from its package, unpacked, not installed:

```sh
mkdir -p ~/facade-dpkg-perl && cd ~/facade-dpkg-perl
curl -O https://archive.ubuntu.com/ubuntu/pool/main/d/dpkg/libdpkg-perl_1.21.1ubuntu2.6_all.deb
dpkg-deb -x libdpkg-perl_1.21.1ubuntu2.6_all.deb root
export PERL5LIB=~/facade-dpkg-perl/root/usr/share/perl5
```

## The dependency list

Step 2 compares the dependencies it found with `build/linux/debian/dep-lists.ts`, the list
upstream's CI produces, and by default fails when they differ. A build made here always
differs, for two reasons:

- **No tunnel.** Facade Code ships no `facade-tunnel` (IDENTITY.md), so the dependencies
  upstream's tunnel brings - `libc6 (>= 2.16)`, `libc6 (>= 2.2.5)` - are not there.
- **Native modules built here.** `npm install` compiles them against this machine's glibc and
  libstdc++, not the glibc 2.28 sysroot CI builds against, so they ask for newer ones:
  `libc6 (>= 2.29)`, `libstdc++6 (>= 9)`. The package needs Ubuntu 20.04 or later.

`FACADE_DEB_DEPENDENCIES=warn` prints the difference and goes on, so `Depends` is what this
build's binaries actually need. Read the printed list: anything beyond these two reasons is a
real new dependency.

## When it goes wrong

**`Can't use an undefined value as a HASH reference at .../Dpkg/Shlibs/SymbolFile.pm`.**
`PERL5LIB` is not set in this terminal; see One-time setup.

**`dpkg-shlibdeps.pl: error: cannot read .../bin/facade-tunnel`.** The build predates the
change that leaves the missing tunnel out; pull.

**`The dependencies list has changed.`** `FACADE_DEB_DEPENDENCIES=warn` is not set in this
terminal.
