#!/usr/bin/env bash
# MultiDSH Android M2.1 — build the WebView client APK on test-linux-a WITHOUT Gradle.
#
# Manual toolchain (all from ~/android-sdk + ~/jdk11home, see setup-env.sh):
#   aapt2 compile -> build/res.zip           (res/: launcher icons, network security config)
#   aapt2 link    -> resources/manifest/assets APK
#   javac         -> .class
#   d8            -> classes.dex
#   zip           -> inject classes.dex into the APK
#   zipalign      -> 4-byte alignment
#   apksigner     -> debug signature
#
# Version: 0.2.0 (kept in sync with AndroidManifest.xml and MainActivity.APP_VERSION).
# No AndroidX, no Gradle, Java 8 source/target.
#
# Debuggability: the checked-in AndroidManifest.xml is NOT debuggable, and the normal
# build below produces a non-debuggable APK (debug keystore signing is only for
# sideloading). Pass DEBUG=1 to additionally link a temporary manifest copy with
# android:debuggable="true" (needed for the --es js smoke hook and WebView remote
# debugging on the emulator); that APK gets the *-debug.apk suffix.
#
# Usage (on test-linux-a):
#   bash ~/multidsh-android/build.sh             # non-debuggable APK
#   DEBUG=1 bash ~/multidsh-android/build.sh     # debuggable APK for emulator smoke tests
# Output:
#   ~/multidsh-android/dist/multidsh-android-0.2.0.apk
#   ~/multidsh-android/dist/multidsh-android-0.2.0-debug.apk   (only with DEBUG=1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
JH="${JAVA_HOME_JDK:-$HOME/jdk11home}"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
OUT="$ROOT/build"
DIST="$ROOT/dist"
APP_VERSION="0.2.0"
DEBUG="${DEBUG:-0}"
if [ "$DEBUG" = "1" ]; then
  APK_NAME="multidsh-android-${APP_VERSION}-debug.apk"
else
  APK_NAME="multidsh-android-${APP_VERSION}.apk"
fi

log() { printf '[build] %s\n' "$*"; }
die() { printf '[build] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- sanity
[ -x "$BT/aapt2" ]                || die "aapt2 missing: $BT/aapt2 (run setup-env.sh)"
[ -f "$BT/d8" ]                   || die "d8 missing: $BT/d8 (run setup-env.sh)"
[ -x "$BT/zipalign" ]             || die "zipalign missing: $BT/zipalign"
[ -f "$BT/apksigner" ]            || die "apksigner missing: $BT/apksigner"
[ -x "$JH/bin/javac" ]            || die "javac missing: $JH/bin/javac (run setup-env.sh)"
[ -f "$ANDROID_JAR" ]             || die "android.jar missing: $ANDROID_JAR"
[ -f "$ROOT/AndroidManifest.xml" ] || die "AndroidManifest.xml missing"
[ -d "$ROOT/assets" ]             || die "assets/ missing"
[ -d "$ROOT/res" ]                || die "res/ missing (launcher icon + network security config)"
[ -f "$ROOT/assets/multidsh/index.html" ] || die "assets/multidsh/index.html missing"
JAVA_BIN="$(command -v java || true)"
[ -n "$JAVA_BIN" ]                || die "java not on PATH"
if [ "$DEBUG" = "1" ]; then
  command -v sed >/dev/null 2>&1  || die "sed required for DEBUG=1 manifest injection"
fi
export PATH="$JH/bin:$PATH"

log "version=$APP_VERSION debuggable=$([ "$DEBUG" = "1" ] && echo yes || echo no)"
log "output=$APK_NAME"
log "SDK=$SDK"
log "build-tools=$("$BT/aapt2" version 2>&1 | tr '\n' ' ')"
log "javac=$("$JH/bin/javac" -version 2>&1)"
log "java=$("$JAVA_BIN" -version 2>&1 | head -1)"

case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) die "unexpected host arch: $(uname -m)" ;;
esac

# ---------------------------------------------------------------- clean
rm -rf "$OUT" "$DIST"
mkdir -p "$OUT/classes" "$OUT/dex" "$DIST"

# The checked-in manifest stays non-debuggable. DEBUG=1 links a throwaway copy that adds
# android:debuggable="true", which is what enables the --es js smoke hook and WebView
# remote debugging through ApplicationInfo.FLAG_DEBUGGABLE at runtime.
MANIFEST="$ROOT/AndroidManifest.xml"
if [ "$DEBUG" = "1" ]; then
  MANIFEST="$OUT/AndroidManifest-debug.xml"
  sed 's|<application|<application android:debuggable="true"|' \
    "$ROOT/AndroidManifest.xml" > "$MANIFEST"
  grep -q 'android:debuggable="true"' "$MANIFEST" \
    || die "failed to inject android:debuggable into the debug manifest copy"
  log "DEBUG=1: linking a debuggable manifest copy (emulator smoke tests only)"
fi

# ---------------------------------------------------------------- 1. aapt2 compile
log "1/7 aapt2 compile (res/ -> build/res.zip)"
"$BT/aapt2" compile --dir "$ROOT/res" -o "$OUT/res.zip"
[ -f "$OUT/res.zip" ] || die "aapt2 compile did not produce res.zip"

# ---------------------------------------------------------------- 2. aapt2 link
# aapt2 accepts compiled resources either through the historical -R option or as
# positional inputs (the form shown in the command-line build docs). Try -R first and
# fall back so the script works across build-tools revisions.
link_apk() {
  "$BT/aapt2" link \
    -o "$OUT/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$MANIFEST" \
    -A "$ROOT/assets" \
    "$@" \
    --auto-add-overlay
}
log "2/7 aapt2 link (manifest + assets + compiled resources)"
if [ -f "$OUT/res.zip" ]; then
  if ! link_apk -R "$OUT/res.zip"; then
    log "aapt2 link -R res.zip failed; retrying with res.zip as a positional input"
    rm -f "$OUT/base.apk"
    link_apk "$OUT/res.zip"
  fi
else
  rm -f "$OUT/base.apk"
  link_apk
fi
[ -f "$OUT/base.apk" ] || die "aapt2 link did not produce base.apk"

# ---------------------------------------------------------------- 3. javac
log "3/7 javac (Java 8 bytecode, android.jar as bootclasspath)"
find "$ROOT/src" -name '*.java' | sort > "$OUT/sources.txt"
cat "$OUT/sources.txt"
"$JH/bin/javac" \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -classpath "$ANDROID_JAR" \
  -encoding UTF-8 \
  -d "$OUT/classes" \
  @"$OUT/sources.txt"

# ---------------------------------------------------------------- 4. d8
log "4/7 d8 -> classes.dex"
find "$OUT/classes" -name '*.class' | sort > "$OUT/classes.txt"
"$BT/d8" \
  --lib "$ANDROID_JAR" \
  --min-api 26 \
  --release \
  --output "$OUT/dex" \
  $(cat "$OUT/classes.txt")
[ -f "$OUT/dex/classes.dex" ] || die "d8 did not produce classes.dex"

# ---------------------------------------------------------------- 5. inject dex
log "5/7 inject classes.dex into APK"
if command -v zip >/dev/null 2>&1; then
  ( cd "$OUT/dex" && zip -q -X "$OUT/base.apk" classes.dex )
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT/base.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
else
  die "neither zip nor python3 available to inject classes.dex"
fi
unzip -l "$OUT/base.apk" | tail -20

# ---------------------------------------------------------------- 6. zipalign
log "6/7 zipalign -f 4"
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"

# ---------------------------------------------------------------- 7. sign
KEYSTORE="$ROOT/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  log "7/7 generating debug keystore"
  KTOOL="$(command -v keytool || echo /usr/lib/jvm/java-11-openjdk-amd64/bin/keytool)"
  [ -x "$KTOOL" ] || die "keytool not found"
  "$KTOOL" -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
log "7/7 apksigner sign (debug keystore)"
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --min-sdk-version 26 --max-sdk-version 34 \
  --out "$DIST/$APK_NAME" \
  "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$DIST/$APK_NAME"

log "APK: $DIST/$APK_NAME ($(stat -c %s "$DIST/$APK_NAME") bytes)"
# Capture badging first: piping aapt2 straight into head/grep can trip pipefail via SIGPIPE.
BADGING="$("$BT/aapt2" dump badging "$DIST/$APK_NAME")"
printf '%s\n' "$BADGING" | sed -n '1,10p'
if grep -q '^application-debuggable' <<< "$BADGING"; then
  log "debuggable=yes (debug hook + WebView remote debugging enabled; do NOT ship this APK)"
else
  log "debuggable=no (normal sideload build; debug hook + WebView remote debugging disabled)"
fi
log "DONE"
