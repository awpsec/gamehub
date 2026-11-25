#!/bin/bash
# Refresh desktop/icon caches after Gamehub .deb install so the app appears
# in GNOME/KDE/etc. application menus with a visible icon.
set -e

# Symlink CLI launcher (same behavior electron-builder's default postinst uses)
if type update-alternatives >/dev/null 2>&1; then
  if [ -L '/usr/bin/gamehub-client' ] && [ -e '/usr/bin/gamehub-client' ] \
    && [ "$(readlink '/usr/bin/gamehub-client')" != '/etc/alternatives/gamehub-client' ]; then
    rm -f '/usr/bin/gamehub-client'
  fi
  update-alternatives --install '/usr/bin/gamehub-client' 'gamehub-client' '/opt/Gamehub/gamehub-client' 100 \
    || ln -sf '/opt/Gamehub/gamehub-client' '/usr/bin/gamehub-client'
else
  ln -sf '/opt/Gamehub/gamehub-client' '/usr/bin/gamehub-client'
fi

# SUID chrome-sandbox for Electron
chmod 4755 '/opt/Gamehub/chrome-sandbox' || true

if hash update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

# Critical: without this, icons dropped into hicolor may not show until logout
if hash gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
elif hash update-icon-caches >/dev/null 2>&1; then
  update-icon-caches /usr/share/icons/hicolor || true
fi

# Notify running desktop sessions (best-effort)
if hash xdg-desktop-menu >/dev/null 2>&1; then
  xdg-desktop-menu forceupdate || true
fi
