#!/bin/sh
set -eu
umask 077

fail() { printf 'facade install: %s\n' "$*" >&2; exit 1; }

version=
expected_build=
latest_build=
package=
root=${FACADE_HOME:-}
add_path=true
mode=--takeover
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|--expected-build|--package|--install-root)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value."
            case "$1" in
                --version) version=$2 ;;
                --expected-build) expected_build=$2 ;;
                --package) package=$2 ;;
                --install-root) root=$2 ;;
            esac
            shift
            ;;
        --no-path) add_path=false ;;
        --no-activate) mode=--install-only ;;
        --help)
            printf '%s\n' 'Usage: install.sh [--version X.Y.Z] [--expected-build BUILD] [--package ARCHIVE] [--install-root HOME] [--no-path] [--no-activate]'
            exit 0 ;;
        *) fail "Unknown argument $1. Use --help." ;;
    esac
    shift
done
profile_home=${HOME:-${USERPROFILE:-}}
[ -n "$root" ] || root="${profile_home:?HOME or USERPROFILE is required}/.facade"
case "$root" in /*) ;; *) fail 'The Facade home must be an absolute path.' ;; esac
case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail 'This installer supports Linux and macOS. On Windows use install.ps1.' ;;
esac
case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'Facade is available for x64 and arm64.' ;;
esac

releases=https://github.com/y5ez3g/facadecode/releases
mirror=https://facadecode.com
asset="facade-framework-$os-$arch.tar.gz"
valid_version() {
    case "$1" in *[!0-9.]*) return 1 ;; esac
    printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}
valid_build() {
    case "$1" in *[!0-9A-Za-z.+]*) return 1 ;; esac
    printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(\+([0-9]+\.)?[0-9A-Za-z]+)?$'
}
read_build() {
    LC_ALL=C awk '
        NR == 1 { sub(/\r$/, ""); build = $0 }
        END { if (NR != 1 || build == "") exit 1; print build }
    ' "$1"
}
failed_http=-
download() {
    if status=$(curl --disable --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
        -fsL -w '%{http_code}' -o "$2" "$1"); then
        case "$status" in 2[0-9][0-9]) return 0 ;; esac
    fi
    case "$status" in
        [1-5][0-9][0-9]) failed_asset=${1##*/}; failed_http=$status ;;
        *) [ "$failed_http" != - ] || failed_asset=${1##*/} ;;
    esac
    return 1
}
download_package() {
    download "$1/$asset" "$work/$asset" && download "$1/SHA256SUMS" "$work/SHA256SUMS"
}
fail_download() {
    if [ "${FACADE_UPGRADE_REPORT:-}" = 1 ] && [ "${FACADE_UPGRADE_ASSET_REPORT:-}" = 1 ]; then
        printf 'facade-upgrade-asset-error %s %s\n' "$failed_asset" "$failed_http"
    fi
    fail "$@"
}
[ -z "$version" ] || valid_version "$version" || fail 'Use a release version such as 0.1.6.'
[ -z "$expected_build" ] || valid_build "$expected_build" || fail 'Use a valid Facade BUILD for --expected-build.'

bin="${root%/}/framework/bin"
temp=$(cd -P -- "${TMPDIR:-/tmp}" && pwd -P) || fail 'Could not open the temporary directory.'
if [ -d "$root" ]; then
    target_dir=$(cd -P -- "$root" && pwd -P)
    case "$temp/" in "${target_dir%/}/"*) fail 'Use a temporary directory outside the Facade home.' ;; esac
fi
work=$(mktemp -d "$temp/facade-install.XXXXXX")
work_name=${work##*/}
trap 'rm -rf -- "${temp:?}/${work_name:?}"' 0
trap 'exit 1' HUP INT TERM

if [ -n "$package" ]; then
    cp -- "$package" "$work/$asset"
    cp -- "$(dirname -- "$package")/SHA256SUMS" "$work/SHA256SUMS"
else
    if [ -z "$version" ]; then
        version_file="$work/latest-version"
        download "$releases/latest/download/facade-framework-version.txt" "$version_file" ||
            download "$mirror/facade-framework-version.txt" "$version_file" ||
            fail_download 'Could not download the stable Facade version from GitHub or facadecode.com.'
        latest_build=$(read_build "$version_file") && valid_build "$latest_build" ||
            fail 'The stable release did not provide a valid BUILD.'
        version=${latest_build%%+*}
    fi
    if ! download_package "$releases/download/extension%2F$version" &&
        ! download_package "$mirror/releases/$version"; then
        message="Could not download $asset and its checksums for Facade $version from GitHub or facadecode.com."
        if [ -n "${expected_build:-$latest_build}" ]; then
            message="$message Supply the matching release archive with --package."
        fi
        fail_download "$message"
    fi
fi
expected=$(LC_ALL=C awk -v asset="$asset" '
    { sub(/\r$/, "") }
    length($1) != 64 || !/^[0-9a-fA-F]+  [^[:space:]]+$/ { invalid = 1; exit }
    $2 == asset { count++; hash = tolower($1) }
    END { if (invalid || count != 1) exit 1; print hash }
' "$work/SHA256SUMS") || fail "SHA-256 verification failed for $asset."
if [ "$os" = darwin ]; then
    actual=$(shasum -a 256 "$work/$asset")
else
    actual=$(sha256sum "$work/$asset")
fi
[ "${actual%% *}" = "$expected" ] || fail "SHA-256 verification failed for $asset."

stage="$work/payload"
mkdir "$stage"
tar -xzf "$work/$asset" -C "$stage"
build=$(read_build "$stage/VERSION") && valid_build "$build" || fail 'The package did not provide a valid BUILD.'
pin=${expected_build:-$latest_build}
[ -z "$pin" ] || [ "$build" = "$pin" ] ||
    fail "Expected Facade build $pin, found $build in the package. Supply the matching release archive with --package."
[ -z "$version" ] || [ "${build%%+*}" = "$version" ] || fail "Expected Facade $version, found $build in the package."
for program in facade facade-mcp; do
    [ -f "$stage/$program" ] || fail "The package has no $program."
    chmod 755 "$stage/$program"
done

reported=$("$stage/facade" --version) && [ "$reported" = "facade $build" ] ||
    fail "The packaged executable does not report Facade build $build. Supply the matching release archive with --package."

before=
if [ -x "$bin/facade" ]; then
    before=$(FACADE_HOME="$root" "$bin/facade" --version)
fi
FACADE_HOME="$root" "$stage/facade" daemon "$mode"
reported=$(FACADE_HOME="$root" "$bin/facade" --version)
selected=${reported#facade }
[ "$reported" = "facade $selected" ] && valid_build "$selected" ||
    fail 'The home launcher did not report a valid Facade BUILD.'

if [ "$reported" = "$before" ] || [ "$selected" != "$build" ]; then
    printf 'Facade %s is already up to date in %s.\n' "$selected" "$bin"
    exit 0
fi

remove_legacy_programs() {
    legacy_bin="$profile_home/.local/bin"
    legacy_data="$profile_home/.local/share/facade"
    owned=false
    for program in facade facade-mcp; do
        launcher="$legacy_bin/$program"
        if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "../share/facade/current/$program" ]; then
            rm -- "$launcher"
            owned=true
        fi
    done
    if ! "$owned" || [ -L "$legacy_data" ] || [ -L "$legacy_data/versions" ]; then
        return
    fi
    if [ -L "$legacy_data/current" ]; then
        target=$(readlink "$legacy_data/current")
        if [ "${target#versions/}" != "$target" ] && valid_version "${target#versions/}"; then
            rm -- "$legacy_data/current"
        fi
    fi
    for folder in "$legacy_data"/versions/*; do
        [ -d "$folder" ] && [ ! -L "$folder" ] || continue
        version_name=${folder##*/}
        valid_version "$version_name" && [ -f "$folder/VERSION" ] &&
            [ "$(read_build "$folder/VERSION")" = "$version_name" ] || continue
        rm -f -- "$folder/facade" "$folder/facade-mcp" "$folder/VERSION" "$folder/LICENSE.txt"
        rmdir -- "$folder" 2>/dev/null || :
    done
    rmdir -- "$legacy_data/versions" "$legacy_data" 2>/dev/null || :
}

if "$add_path" && [ "${FACADE_UPGRADE_REPORT:-}" != 1 ] && [ -n "$profile_home" ]; then
    # Running each profile puts its most recently selected home first.
    legacy_shell_path_line() {
        escaped=$(printf '%s\n' "$1" | sed "s/'/'\\\\''/g")
        printf '%s\n' "case \":\$PATH:\" in *:'$escaped':*) ;; *) export PATH=\"\$PATH\":'$escaped' ;; esac"
    }
    remove_profile_line() {
        if [ -f "$1" ] && grep -Fqx -- "$2" "$1"; then
            OLD_FACADE_LINE="$2" awk '$0 != ENVIRON["OLD_FACADE_LINE"]' "$1" > "$work/profile"
            cat "$work/profile" > "$1"
        fi
    }
    move_profile_entry() {
        if [ -f "$1" ]; then
            FACADE_PROFILE_ENTRY="$2" awk '
                BEGIN { entry = "\n" ENVIRON["FACADE_PROFILE_ENTRY"] "\n"; profile = "\n" }
                { profile = profile $0 "\n" }
                END {
                    while ((start = index(profile, entry))) {
                        before = substr(profile, 1, start)
                        if (before ~ /\n\n$/) before = substr(before, 1, length(before) - 1)
                        profile = before substr(profile, start + length(entry))
                    }
                    printf "%s", substr(profile, 2)
                }
            ' "$1" > "$work/profile"
            cat "$work/profile" > "$1"
        fi
        printf '\n%s\n' "$2" >> "$1"
    }
    escaped=$(printf '%s\n' "$bin" | sed "s/'/'\\\\''/g")
    path_marker="# Facade PATH for '$escaped'"
    path_lines=$(
        printf '%s\n' "$path_marker" 'export PATH="$(' "    _facade_bin='$escaped'"
        cat <<'PATH_SETUP'
    _facade_path=":${PATH-}:"
    while [ "${_facade_path#*":$_facade_bin:"}" != "$_facade_path" ]; do
        _facade_path=${_facade_path%%":$_facade_bin:"*}:${_facade_path#*":$_facade_bin:"}
    done
    case $_facade_path in
        :) printf '%s' "$_facade_bin" ;;
        *) _facade_path=${_facade_path#:}
           printf '%s:%s' "$_facade_bin" "${_facade_path%:}" ;;
    esac
)"
PATH_SETUP
    )
    old_line=$(legacy_shell_path_line "$profile_home/.local/bin")
    zsh_profile="${ZDOTDIR:-$profile_home}/.zshrc"
    for profile in "$profile_home/.profile" "$profile_home/.bash_profile" "$profile_home/.bash_login" "$profile_home/.bashrc" "$zsh_profile"; do
        remove_profile_line "$profile" "$old_line"
    done
    move_profile_entry "$profile_home/.profile" "$path_lines"
    for profile in "$profile_home/.bash_profile" "$profile_home/.bash_login"; do
        if [ -f "$profile" ]; then
            move_profile_entry "$profile" "$path_lines"
            break
        fi
    done
    move_profile_entry "$profile_home/.bashrc" "$path_lines"
    move_profile_entry "$zsh_profile" "$path_lines"
    fish_path_line() {
        fish_path=$(printf '%s\n' "$1" | sed "s/[\\\\']/\\\\&/g")
        printf '%s\n' "fish_add_path --path $2 '$fish_path'"
    }
    fish_config="${XDG_CONFIG_HOME:-$profile_home/.config}/fish/conf.d"
    remove_profile_line "$fish_config/facade.fish" "$(fish_path_line "$profile_home/.local/bin" --append)"
    if command -v fish >/dev/null 2>&1; then
        mkdir -p "$fish_config"
        move_profile_entry "$fish_config/facade.fish" "$(fish_path_line "$bin" '--prepend --move')"
    fi
    remove_legacy_programs
    case "$PATH:" in
        "$bin":*) ;;
        *) printf 'Open a new terminal to use facade and facade-mcp.\n' ;;
    esac
fi
printf 'Installed Facade %s in %s.\n' "$selected" "$bin"
