#!/usr/bin/env bash
# Download the official static 7-Zip for Linux (7zzs — distro builds have RAR
# removed) and vendor it via vendor-7zip.js. Used by release + e2e workflows.
#
# SEVENZIP_TARBALL / SEVENZIP_SHA256 pin an exact build. When the pinned file
# is gone from 7-zip.org (old versions get removed), it falls back to the one
# the download page links — and fails if a hash is pinned for another file.
set -euo pipefail
dest="${RUNNER_TEMP:-/tmp}/7z-linux.tar.xz"
name="${SEVENZIP_TARBALL:-}"
get() { echo "GET ${@: -1}" >&2; curl -fsSL --retry 3 -A "Mozilla/5.0 (X11; Linux x86_64) gamehub-ci" "$@"; }

fetch_named() {  # $1 = file name: 7-zip.org, then the official GitHub releases
  get -o "$dest" "https://www.7-zip.org/a/$1" && return 0
  local ver; ver=$(echo "$1" | sed -E 's/^7z([0-9]{2})([0-9]{2}).*/\1.\2/')
  get -o "$dest" "https://github.com/ip7z/7zip/releases/download/$ver/$1"
}

if [ -z "$name" ] || ! fetch_named "$name"; then
  found=$(get https://www.7-zip.org/download.html 2>/dev/null | grep -o '7z[0-9]*-linux-x64\.tar\.xz' | head -1 || true)
  if [ -z "$found" ]; then
    found=$(get https://api.github.com/repos/ip7z/7zip/releases/latest | grep -o '"name": *"7z[0-9]*-linux-x64\.tar\.xz"' | grep -o '7z[0-9]*-linux-x64\.tar\.xz' | head -1 || true)
  fi
  [ -n "$found" ] || { echo "no Linux 7-Zip build found (7-zip.org or ip7z/7zip releases)"; exit 1; }
  if [ -n "${SEVENZIP_SHA256:-}" ] && [ "$found" != "$name" ]; then
    echo "pinned $name is gone; latest is $found — update SEVENZIP_TARBALL/SEVENZIP_SHA256"; exit 1
  fi
  name="$found"
  fetch_named "$name"
fi
echo "7-Zip Linux build: $name"
sha256sum "$dest"
if [ -n "${SEVENZIP_SHA256:-}" ]; then echo "${SEVENZIP_SHA256}  $dest" | sha256sum -c -; fi
node "$(dirname "$0")/vendor-7zip.js" --linux-tarball "$dest" --require
