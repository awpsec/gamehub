#!/usr/bin/env bash
# Linux twin of make-scene-release.ps1 (no Inno compiler here): a scene-style
# rune-mygame.rar/.r00…/.s0x set holding an ISO with setup.exe + setup-N.bin
# + RUNE/ crack folder. Exercises unpacking and detection with bundled 7zz.
set -euo pipefail
out="$1"; work="$(mktemp -d)"
mkdir -p "$out" "$work/iso/RUNE/Mygame/Binaries/Win64"
head -c 2000000 /dev/urandom > "$work/iso/setup.exe"
for i in 1 2 3; do head -c 15000000 /dev/urandom > "$work/iso/setup-$i.bin"; done
printf '[autorun]\r\nopen=setup.exe\r\n' > "$work/iso/autorun.inf"
head -c 2100000 /dev/urandom > "$work/iso/RUNE/Mygame/Binaries/Win64/Mygame-Win64-Shipping.exe"
echo EMU > "$work/iso/RUNE/Mygame/Binaries/Win64/steam_api64.dll"
genisoimage -quiet -J -R -V MYGAME -o "$work/mygame.iso" "$work/iso"
cd "$out"
rar a -m0 -v400k -vn -ep1 -idq rune-mygame.rar "$work/mygame.iso"
# rar 7 ignores -vn: rename .partNN.rar to old-style names
if ls rune-mygame.part*.rar >/dev/null 2>&1; then
  i=0
  for f in $(ls rune-mygame.part*.rar | sort -V); do
    if [ $i -eq 0 ]; then n=rune-mygame.rar; else k=$((i-1)); n=$(printf 'rune-mygame.%b%02d' "\\x$(printf %x $((114 + k/100)))" $((k%100))); fi
    mv "$f" "$n"; i=$((i+1))
  done
fi
echo "RUNE presents Mygame" > rune-mygame.nfo
ls | wc -l; ls | sort | tail -3
test -f rune-mygame.s00
