#!/bin/bash
# Clean up launcher symlink / caches on remove.
set -e

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove 'gamehub-client' '/opt/Gamehub/gamehub-client' || true
else
  rm -f '/usr/bin/gamehub-client'
fi

if hash update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
fi
