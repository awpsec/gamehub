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
if [ -z "$name" ] || ! curl -fsSL --retry 3 -o "$dest" "https://www.7-zip.org/a/$name"; then
  found=$(curl -fsSL --retry 3 https://www.7-zip.org/download.html | grep -o '7z[0-9]*-linux-x64\.tar\.xz' | head -1)
  [ -n "$found" ] || { echo "no Linux 7-Zip build linked on 7-zip.org"; exit 1; }
  if [ -n "${SEVENZIP_SHA256:-}" ] && [ "$found" != "$name" ]; then
    echo "pinned $name is gone; 7-zip.org now has $found — update SEVENZIP_TARBALL/SEVENZIP_SHA256"; exit 1
  fi
  name="$found"
  curl -fsSL --retry 3 -o "$dest" "https://www.7-zip.org/a/$name"
fi
echo "7-Zip Linux build: $name"
sha256sum "$dest"
if [ -n "${SEVENZIP_SHA256:-}" ]; then echo "${SEVENZIP_SHA256}  $dest" | sha256sum -c -; fi
node "$(dirname "$0")/vendor-7zip.js" --linux-tarball "$dest" --require
