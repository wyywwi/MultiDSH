#!/usr/bin/env bash
# One-time setup on test-linux-a (no sudo needed).
#
# The L40 host has the Android SDK (~/android-sdk) with platform-tools, platforms;android-34,
# emulator and the system image, but NOT build-tools and NOT a JDK compiler (only a JRE 11).
# Gradle is unusable there (maven.google.com times out), so this script installs exactly the
# two pieces the manual aapt2/javac/d8 pipeline needs:
#   1) build-tools 34.0.0  -> unzip dl.google.com's official zip (no sdkmanager / JDK 17 needed)
#   2) javac 11            -> `apt-get download` the Debian openjdk-11-jdk-headless .deb and
#                             `dpkg -x` it into ~/jdk11home (host JRE 11 already ships the
#                             jdk.compiler module + lib/modules + lib/ct.sym)
#
# Usage (on L40):  bash ~/multidsh-android/setup-env.sh
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
JH="$HOME/jdk11home"
log() { printf '[setup] %s\n' "$*"; }

# ---------------------------------------------------------------- build-tools
if [ ! -x "$BT/aapt2" ]; then
  log "installing build-tools 34.0.0 into $BT"
  mkdir -p "$SDK/dl" "$SDK/build-tools"
  ZIP="$SDK/dl/build-tools_r34-linux.zip"
  if [ ! -s "$ZIP" ]; then
    log "downloading build-tools_r34-linux.zip from dl.google.com"
    curl -sSL -o "$ZIP" https://dl.google.com/android/repository/build-tools_r34-linux.zip
  fi
  rm -rf /tmp/bt34 && mkdir -p /tmp/bt34
  unzip -q "$ZIP" -d /tmp/bt34
  AAPT2_FOUND=$(find /tmp/bt34 -name aapt2 -type f | head -1)
  [ -n "$AAPT2_FOUND" ] || { echo "aapt2 not found in $ZIP" >&2; exit 1; }
  SRCDIR=$(dirname "$AAPT2_FOUND")
  rm -rf "$BT" && mkdir -p "$BT"
  cp -a "$SRCDIR"/. "$BT"/
  chmod +x "$BT"/aapt2 "$BT"/d8 "$BT"/zipalign "$BT"/apksigner 2>/dev/null || true
else
  log "build-tools 34.0.0 already present"
fi
"$BT/aapt2" version

# ---------------------------------------------------------------- javac
if [ ! -x "$JH/bin/javac" ]; then
  log "building a javac 11 from the Debian jdk-headless .deb (host JRE only has java)"
  mkdir -p "$HOME/jdk11dl"
  if ! ls "$HOME"/jdk11dl/openjdk-11-jdk-headless_*.deb >/dev/null 2>&1; then
    (cd "$HOME/jdk11dl" && apt-get download openjdk-11-jdk-headless)
  fi
  DEB=$(ls "$HOME"/jdk11dl/openjdk-11-jdk-headless_*.deb | head -1)
  rm -rf "$HOME/jdk11extract" && mkdir -p "$HOME/jdk11extract"
  dpkg -x "$DEB" "$HOME/jdk11extract"
  JDKDIR="$HOME/jdk11extract/usr/lib/jvm/java-11-openjdk-amd64"
  SYSDIR="/usr/lib/jvm/java-11-openjdk-amd64"
  rm -rf "$JH" && mkdir -p "$JH/bin"
  # Reuse the installed runtime (lib/modules already contains jdk.compiler, lib/ct.sym exists).
  ln -s "$SYSDIR/lib" "$JH/lib"
  if [ -d "$SYSDIR/conf" ]; then ln -s "$SYSDIR/conf" "$JH/conf"; fi
  if [ -d "$SYSDIR/legal" ]; then ln -s "$SYSDIR/legal" "$JH/legal"; fi
  cp "$JDKDIR/bin/javac" "$JH/bin/javac"
  if [ -d "$JDKDIR/jmods" ]; then cp -a "$JDKDIR/jmods" "$JH/jmods"; fi
else
  log "javac home already present: $JH"
fi
"$JH/bin/javac" -version
log "DONE. build with: bash $HOME/multidsh-android/build.sh"
