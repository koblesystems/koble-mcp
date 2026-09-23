#!/usr/bin/env bash
# Installs koble on macOS or Linux, then runs `koble setup`.
#
#   curl -fsSL https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.sh | bash
#
# KOBLE_VERSION=v0.1.0   install that release instead of the newest
# KOBLE_INSTALL_DIR=...  install somewhere other than ~/.local/bin
# KOBLE_SKIP_SETUP=1     install only; run `koble setup` yourself later
set -euo pipefail

repo="koblesystems/koble-mcp"
dir="${KOBLE_INSTALL_DIR:-$HOME/.local/bin}"
version="${KOBLE_VERSION:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'koble install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this installer is for macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac
asset="koble-$os-$arch"

if [ -z "$version" ]; then
  # The newest full release; before there is one, the newest release candidate.
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)
  [ -n "$version" ] || version=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=1" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$version" ] || fail "could not find a release of $repo"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$repo/releases/download/$version"
say "Downloading koble $version for $os-$arch…"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "release $version has no $asset"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || fail "release $version has no checksums.txt"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }'); fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "the download does not match checksums.txt; nothing was installed"

mkdir -p "$dir"
install -m 755 "$tmp/$asset" "$dir/koble"
say "Installed $dir/koble"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say ""
     say "$dir is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
     say "  export PATH=\"$dir:\$PATH\""
     say "Claude Desktop does not need it; Claude Code does." ;;
esac

if [ -z "${KOBLE_SKIP_SETUP:-}" ] && (exec </dev/tty) 2>/dev/null; then
  say ""
  "$dir/koble" setup </dev/tty
else
  say ""
  say "Next: run  koble setup"
fi
