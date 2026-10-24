#!/usr/bin/env bash
# MultiDSH Android M2.0 — install / launch / screenshot / UI-dump helpers on test-linux-a.
#
# Runs on the L40 host and drives the adb inside the emulator Docker container
# (`docker exec multidsh-emulator adb ...`). Proof files land in ~/android-sdk/android-proof
# (bind-mounted into the container as /sdk/android-proof).
#
# Usage:
#   bash verify.sh launch                 install APK, start Activity, screenshot, dump UI
#   bash verify.sh shot NAME              screenshot -> NAME.png
#   bash verify.sh dump NAME              uiautomator dump -> NAME.xml
#   bash verify.sh tap X Y                input tap
#   bash verify.sh text STRING            input text (spaces via %s)
#   bash verify.sh keyevent CODE          input keyevent (e.g. 4 = BACK)
#   bash verify.sh js  'javascript'       evaluate JS (requires DEBUG=1 *-debug.apk)
#   bash verify.sh logs NAME              dump logcat to NAME.logcat.txt
#   bash verify.sh pull NAME              pull proof files to .tmp/android on the caller side (manual)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
CONTAINER="${CONTAINER:-multidsh-emulator}"
APK="${APK:-$ROOT/dist/multidsh-android-0.2.0.apk}"
PKG="com.multidsh.app"
ACTIVITY="$PKG/.MainActivity"
OUT="$SDK/android-proof"
mkdir -p "$OUT"

log() { printf '[verify] %s\n' "$*"; }
adb() { docker exec "$CONTAINER" adb "$@"; }

need_container() {
  docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
    log "emulator container '$CONTAINER' is not running"
    log "start it with: bash ~/android-emulator.sh up"
    exit 1
  }
}

# uiautomator occasionally dies with "Bad file descriptor" (UiAutomation) on this
# headless image; retry a few times before giving up.
dump_ui() {
  local target="$1" i
  for i in 1 2 3; do
    adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
    docker exec "$CONTAINER" adb exec-out cat /sdcard/window.xml > "$target" 2>/dev/null || true
    if [ -s "$target" ] && grep -q 'WebView' "$target"; then
      # a rich tree has real text nodes / several nodes; a sparse one is just the WebView shell
      if [ "$(grep -o 'text="[^"]*"' "$target" | wc -l)" -gt 2 ]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 0
}

cmd="${1:-launch}"
case "$cmd" in
  launch)
    need_container
    [ -f "$APK" ] || { log "APK missing: $APK"; exit 1; }
    # the /sdk bind mount is the only path visible inside the container
    cp -f "$APK" "$SDK/dl/multidsh-android.apk"
    log "adb devices"; adb devices
    log "installing $APK"
    adb install -r /sdk/dl/multidsh-android.apk
    adb logcat -c || true
    adb shell am force-stop "$PKG" || true
    log "starting $ACTIVITY"
    adb shell am start -W -n "$ACTIVITY"
    sleep 5
    log "front activity:"
    adb shell dumpsys activity activities > "$OUT/activity.txt" 2>&1 || true
    grep -E "mResumedActivity|mFocusedApp|topResumedActivity" "$OUT/activity.txt" | head -5
    docker exec "$CONTAINER" adb exec-out screencap -p > "$OUT/01-home.png"
    dump_ui "$OUT/01-home.xml"
    adb shell dumpsys window > "$OUT/window.txt" 2>&1 || true
    log "screenshot -> $OUT/01-home.png ($(stat -c %s "$OUT/01-home.png" 2>/dev/null || echo 0) bytes)"
    log "ui dump   -> $OUT/01-home.xml ($(stat -c %s "$OUT/01-home.xml" 2>/dev/null || echo 0) bytes)"
    log "logcat    -> $OUT/logcat.txt"
    adb logcat -d -s MultiDSH:V chromium:E AndroidRuntime:E > "$OUT/logcat.txt" 2>&1 || true
    ;;
  shot)
    need_container
    NAME="${2:-shot}"
    docker exec "$CONTAINER" adb exec-out screencap -p > "$OUT/$NAME.png"
    log "screenshot -> $OUT/$NAME.png ($(stat -c %s "$OUT/$NAME.png") bytes)"
    ;;
  dump)
    need_container
    NAME="${2:-ui}"
    dump_ui "$OUT/$NAME.xml"
    log "ui dump -> $OUT/$NAME.xml ($(stat -c %s "$OUT/$NAME.xml" 2>/dev/null || echo 0) bytes)"
    # short human-readable summary
    sed 's/></>\n</g' "$OUT/$NAME.xml" 2>/dev/null | grep -oE 'text="[^"]*"|class="[^"]*"|package="[^"]*"' | head -40 || true
    ;;
  tap)
    need_container
    adb shell input tap "$2" "$3"
    log "tapped $2 $3"
    ;;
  text)
    need_container
    adb shell input text "$2"
    log "typed '$2'"
    ;;
  keyevent)
    need_container
    adb shell input keyevent "$2"
    log "keyevent $2"
    ;;
  js)
    need_container
    JS="$2"
    B64=$(printf '%s' "$JS" | base64 -w0)
    adb shell am start -W -n "$ACTIVITY" --es js_b64 "$B64" >/dev/null
    sleep 1
    log "evaluated js (${#JS} chars)"
    ;;
  jsb64)
    need_container
    B64="$2"
    adb shell am start -W -n "$ACTIVITY" --es js_b64 "$B64" >/dev/null
    sleep 1
    log "evaluated js_b64 (${#B64} b64 chars)"
    ;;
  logs)
    need_container
    NAME="${2:-logcat}"
    adb logcat -d -s MultiDSH:V chromium:E AndroidRuntime:E > "$OUT/$NAME.logcat.txt" 2>&1 || true
    log "logcat -> $OUT/$NAME.logcat.txt ($(stat -c %s "$OUT/$NAME.logcat.txt") bytes)"
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 2 ;;
esac
