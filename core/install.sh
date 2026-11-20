#!/bin/sh
set -eu
umask 077

fail() { printf 'facade install: %s\n' "$*" >&2; exit 1; }

version=
package=
root="${HOME:?HOME is required}/.local"
add_path=true
activate=true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|--package|--install-root)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value."
            case "$1" in
                --version) version=$2 ;;
                --package) package=$2 ;;
                --install-root) root=$2 ;;
            esac
            shift
            ;;
        --no-path) add_path=false ;;
        --no-activate) activate=false ;;
        --help)
            printf '%s\n' 'Usage: install.sh [--version X.Y.Z] [--package ARCHIVE] [--install-root DIRECTORY] [--no-path] [--no-activate]'
            exit 0 ;;
        *) fail "Unknown argument $1. Use --help." ;;
    esac
    shift
done
case "$root" in /*) ;; *) fail 'The install root must be an absolute path.' ;; esac
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
asset="facade-core-$os-$arch.tar.gz"
valid_version() {
    case "$1" in *[!0-9.]*) return 1 ;; esac
    printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}
download() { curl --proto '=https' --proto-redir '=https' -fsSL "$@"; }
[ -z "$version" ] || valid_version "$version" || fail 'Use a release version such as 0.1.6.'

data="$root/share/facade"
bin="$root/bin"
versions="$data/versions"
mkdir -p "$versions"
work=$(mktemp -d "$versions/.install.XXXXXX")
work_name=${work##*/}
trap 'rm -rf -- "${versions:?}/${work_name:?}"' 0
trap 'exit 1' HUP INT TERM

if [ -n "$package" ]; then
    cp -- "$package" "$work/$asset"
    cp -- "$(dirname -- "$package")/SHA256SUMS" "$work/SHA256SUMS"
else
    if [ -z "$version" ]; then
        version=$(download "$releases/latest/download/facade-core-version.txt") ||
            fail 'Could not find the latest stable Facade release with standalone packages.'
        valid_version "$version" || fail 'The stable release did not provide a valid version.'
    fi
    release="$releases/download/extension%2F$version"
    download "$release/SHA256SUMS" -o "$work/SHA256SUMS" ||
        fail "Could not download the checksums for Facade $version."
    download "$release/$asset" -o "$work/$asset" ||
        fail "Could not download $asset for Facade $version."
fi
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$work/SHA256SUMS")
if [ "$os" = darwin ]; then
    actual=$(shasum -a 256 "$work/$asset")
else
    actual=$(sha256sum "$work/$asset")
fi
[ "${actual%% *}" = "$expected" ] || fail "SHA-256 verification failed for $asset."

stage="$work/payload"
mkdir "$stage"
tar -xzf "$work/$asset" -C "$stage"
build=$(cat "$stage/VERSION")
valid_version "$build" || fail 'The package did not provide a valid version.'
[ -z "$version" ] || [ "$build" = "$version" ] || fail "Expected Facade $version, found $build in the package."
for program in facade facade-mcp; do
    [ -f "$stage/$program" ] || fail "The package has no $program."
    chmod 755 "$stage/$program"
done

destination="$versions/$build"
if [ -e "$destination" ]; then
    for program in facade facade-mcp; do
        cmp -s "$stage/$program" "$destination/$program" ||
            fail "Facade $build already exists with different files in $destination."
    done
else
    mv -- "$stage" "$destination"
fi

mkdir -p "$bin"
for program in facade facade-mcp; do
    launcher="$bin/$program"
    target="../share/facade/current/$program"
    if [ -e "$launcher" ] || [ -L "$launcher" ]; then
        [ "$(readlink "$launcher" || :)" = "$target" ] || fail "$launcher is already used by another installation. Move it first."
    fi
done
if [ -e "$data/current" ] && [ ! -L "$data/current" ]; then
    fail "$data/current is already used by another installation. Move it first."
fi

if "$activate"; then
    "$destination/facade" daemon --takeover
fi

# One switch selects the two programs together. Do not follow a directory symlink.
ln -s "versions/$build" "$work/current"
if [ "$os" = darwin ]; then
    mv -fh -- "$work/current" "$data/current"
else
    mv -fT -- "$work/current" "$data/current"
fi
for program in facade facade-mcp; do
    [ -L "$bin/$program" ] || ln -s "../share/facade/current/$program" "$bin/$program"
done

if "$add_path"; then
    # Add the same shell statement to login and interactive profiles once.
    escaped=$(printf '%s\n' "$bin" | sed "s/'/'\\\\''/g")
    path_line="case \":\$PATH:\" in *:'$escaped':*) ;; *) export PATH=\"\$PATH\":'$escaped' ;; esac"
    add_to_profile() {
        if ! grep -Fqx -- "$2" "$1" 2>/dev/null; then
            printf '\n%s\n' "$2" >> "$1"
        fi
    }
    add_to_profile "$HOME/.profile" "$path_line"
    for profile in "$HOME/.bash_profile" "$HOME/.bash_login"; do
        if [ -f "$profile" ]; then
            add_to_profile "$profile" "$path_line"
            break
        fi
    done
    add_to_profile "$HOME/.bashrc" "$path_line"
    add_to_profile "${ZDOTDIR:-$HOME}/.zshrc" "$path_line"
    if command -v fish >/dev/null 2>&1; then
        fish_config="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d"
        fish_path=$(printf '%s\n' "$bin" | sed "s/[\\\\']/\\\\&/g")
        mkdir -p "$fish_config"
        add_to_profile "$fish_config/facade.fish" "fish_add_path --path --append '$fish_path'"
    fi
    case ":$PATH:" in
        *:"$bin":*) ;;
        *) printf 'Open a new terminal to use facade and facade-mcp.\n' ;;
    esac
fi
printf 'Installed Facade %s in %s.\n' "$build" "$bin"
