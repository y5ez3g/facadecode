# Release

How to make a macOS disk image of Facade Code that opens on somebody else's Mac.

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
3  build/darwin/sign.ts           hardened runtime, per-helper entitlements
4  codesign --verify --deep --strict
5  build/darwin/create-dmg.ts
6  codesign the .dmg itself
7  notarytool submit, then ask every 60 s until Apple answers
8  stapler staple
9  spctl --assess                 the same check Gatekeeper makes on another Mac
```

Steps 3, 5 and the entitlements are the ones CI uses; the script only runs them on a
developer's Mac instead of a build agent.

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
