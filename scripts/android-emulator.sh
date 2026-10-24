#!/usr/bin/env bash
# MultiDSH — one-shot headless Android emulator for a Linux host with KVM (test-linux-a).
#
# Runs ON the Linux host. The emulator executes inside Docker so that /dev/kvm can
# be passed through to the container without sudo: the SSH user only needs to be in
# the docker group. AVD/SDK state stays in ~/android-sdk and survives restarts.
#
# Typical use from a workstation (no bash needed on Windows):
#   scp multidsh/scripts/android-emulator.sh test-linux-a:~/
#   ssh test-linux-a 'bash ~/android-emulator.sh up'
#   ssh test-linux-a 'bash ~/android-emulator.sh down'          # stop + remove container
#   ssh test-linux-a 'bash ~/android-emulator.sh down --wipe'   # ... and delete AVD state
# or stream it without copying (Git Bash / WSL / Linux):
#   ssh test-linux-a 'bash -s' < multidsh/scripts/android-emulator.sh
#
# Commands:
#   up             install SDK/image if missing, create AVD, boot, wait, screenshot
#   status         container / adb / boot state
#   shot           capture another screenshot to $SDK/boot.png
#   shell          interactive adb shell
#   log            show emulator log
#   down [--wipe]  stop + remove emulator container; --wipe also deletes AVD/home
#   dockerfile     print the Dockerfile used for the emulator image
#
# Environment overrides:
#   SDK_ROOT       SDK directory                                (default: $HOME/android-sdk)
#   AVD_NAME       AVD name                                     (default: multidsh34)
#   AVD_DEVICE     avdmanager device profile (screen size etc.) (default: pixel_5)
#   API            Android API level                            (default: 34)
#   IMAGE          docker image tag                             (default: multidsh/android-emulator:34)
#   BASE_IMAGE     docker base image (Docker Hub is blocked)    (default: docker.m.daocloud.io/library/ubuntu:22.04)
#   KVM_GID        gid of /dev/kvm                              (default: auto-detect)
#   BOOT_TIMEOUT   seconds to wait for sys.boot_completed       (default: 420)
#
# No credentials are stored in this file: SSH uses key-based auth.
set -euo pipefail

SDK="${SDK_ROOT:-$HOME/android-sdk}"
AVD_NAME="${AVD_NAME:-multidsh34}"
AVD_DEVICE="${AVD_DEVICE:-pixel_5}"
API="${API:-34}"
IMAGE="${IMAGE:-multidsh/android-emulator:34}"
BASE_IMAGE="${BASE_IMAGE:-docker.m.daocloud.io/library/ubuntu:22.04}"
KVM_GID="${KVM_GID:-}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-420}"
CONTAINER="${CONTAINER:-multidsh-emulator}"
AVD_ARGS="-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -no-snapshot -camera-back none -camera-front none -netdelay none -netspeed full"

export ANDROID_SDK_ROOT="$SDK" ANDROID_HOME="$SDK"
export ANDROID_AVD_HOME="$SDK/avd" ANDROID_USER_HOME="$SDK/home"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; }

kvm_gid() {
  [ -n "$KVM_GID" ] || KVM_GID=$(stat -c %g /dev/kvm)
  printf '%s' "$KVM_GID"
}

read -r -d '' DOCKERFILE_TEXT <<'DOCKER_EOF' || true
# MultiDSH Android headless emulator image.
# The base image comes from a Docker Hub mirror because registry-1.docker.io is
# unreachable from test-linux-a; override it with BASE_IMAGE=... when needed.
FROM __BASE_IMAGE__

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/sdk \
    ANDROID_HOME=/sdk \
    PATH=/sdk/cmdline-tools/latest/bin:/sdk/platform-tools:/sdk/emulator:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        curl unzip xz-utils ca-certificates procps \
        libpulse0 libnss3 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
        libxi6 libxtst6 libxrandr2 libxinerama1 libxfixes3 libxrender1 \
        libgl1 libglu1-mesa libgbm1 libegl1 libepoxy0 libdrm2 \
        libxkbcommon0 libxkbcommon-x11-0 \
        libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
        libxcb-render-util0 libxcb-shape0 libxcb-xkb1 \
        libasound2 libdbus-1-3 libcups2 libgtk-3-0 \
        libfontconfig1 libfreetype6 libsm6 libice6 libxt6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Runtime user matches the host account (uid 1000) so files in the mounted SDK
# directory stay host-owned. At run time --group-add <kvm gid> grants /dev/kvm.
RUN useradd -m -u 1000 -s /bin/bash builder || true
WORKDIR /sdk
USER 1000:1000
DOCKER_EOF
DOCKERFILE_TEXT="${DOCKERFILE_TEXT//__BASE_IMAGE__/$BASE_IMAGE}"

usage() { sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | sed '$d'; }

ensure_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "docker image $IMAGE present"
    return 0
  fi
  log "building docker image $IMAGE (base: $BASE_IMAGE)"
  local ctx=/tmp/multidsh-android-image
  rm -rf "$ctx"; mkdir -p "$ctx" "$SDK"
  printf '%s\n' "$DOCKERFILE_TEXT" > "$ctx/Dockerfile"
  docker build -t "$IMAGE" "$ctx" >"$SDK/build.log" 2>&1 || { tail -30 "$SDK/build.log"; die "docker build failed"; }
  log "image built: $(docker image inspect -f '{{.Size}}' "$IMAGE") bytes"
}

sdk_ready() {
  [ -x "$SDK/emulator/emulator" ] && [ -x "$SDK/platform-tools/adb" ] \
    && [ -d "$SDK/system-images/android-$API/google_apis/x86_64" ]
}

ensure_sdk() {
  mkdir -p "$SDK/avd" "$SDK/home" "$SDK/dl"
  if sdk_ready; then
    log "Android SDK ready: $("$SDK/emulator/emulator" -version 2>/dev/null | head -1)"
    return 0
  fi
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    log "downloading command-line tools from dl.google.com"
    curl -sSL -o "$SDK/dl/cmdline-tools.zip" \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    rm -rf "$SDK/cmdline-tools" /tmp/multidsh-ct; mkdir -p /tmp/multidsh-ct
    unzip -q "$SDK/dl/cmdline-tools.zip" -d /tmp/multidsh-ct
    mkdir -p "$SDK/cmdline-tools"
    mv /tmp/multidsh-ct/cmdline-tools "$SDK/cmdline-tools/latest"
  fi
  log "installing platform-tools, emulator, platforms;android-$API, system-images;android-$API;google_apis;x86_64"
  cat > "$SDK/install-sdk.sh" <<EOS
#!/bin/bash
set -e
export ANDROID_SDK_ROOT=/sdk ANDROID_HOME=/sdk
export ANDROID_AVD_HOME=/sdk/avd ANDROID_USER_HOME=/sdk/home
export PATH=/sdk/cmdline-tools/latest/bin:/sdk/platform-tools:/sdk/emulator:\$PATH
yes | sdkmanager --sdk_root=/sdk --licenses >/dev/null 2>&1 || true
sdkmanager --sdk_root=/sdk --install "platform-tools" "emulator" "platforms;android-$API" \\
  "system-images;android-$API;google_apis;x86_64"
EOS
  chmod +x "$SDK/install-sdk.sh"
  docker run --rm --user "$(id -u):$(id -g)" -v "$SDK:/sdk" \
    -e ANDROID_SDK_ROOT=/sdk "$IMAGE" /sdk/install-sdk.sh >"$SDK/sdk-install.log" 2>&1 \
    || { tail -30 "$SDK/sdk-install.log"; die "sdkmanager failed"; }
  log "SDK installed ($(du -sh "$SDK" | cut -f1))"
}

ensure_avd() {
  if [ -f "$SDK/avd/$AVD_NAME.avd/config.ini" ]; then
    log "AVD $AVD_NAME present"
    return 0
  fi
  log "creating AVD $AVD_NAME (system-images;android-$API;google_apis;x86_64, device=$AVD_DEVICE)"
  docker run --rm --user "$(id -u):$(id -g)" -v "$SDK:/sdk" \
    -e ANDROID_SDK_ROOT=/sdk -e ANDROID_AVD_HOME=/sdk/avd -e ANDROID_USER_HOME=/sdk/home \
    --entrypoint bash "$IMAGE" -lc \
    "echo no | avdmanager create avd -n '$AVD_NAME' -k 'system-images;android-$API;google_apis;x86_64' --device '$AVD_DEVICE' --force" \
    >"$SDK/avd-create.log" 2>&1 || { tail -20 "$SDK/avd-create.log"; die "avdmanager failed"; }
}

start_emulator() {
  running && { log "emulator container already running"; return 0; }
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # A killed container can leave QEMU lock files behind; they make the next boot
  # fail with "Running multiple emulators with the same AVD".
  rm -f "$SDK/avd/$AVD_NAME.avd/"*.lock 2>/dev/null || true
  log "starting headless emulator (avd=$AVD_NAME, kvm gid=$(kvm_gid), network=${NETWORK:-bridge})"
  local net_args=()
  if [ "${NETWORK:-bridge}" = "host" ]; then
    # Host networking: adb server listens on the host's 127.0.0.1:5555, so a
    # laptop can `ssh -L 5555:127.0.0.1:5555` and drive adb/screencap remotely.
    net_args=(--network host)
  fi
  docker run -d --name "$CONTAINER" \
    --device /dev/kvm --group-add "$(kvm_gid)" --user "$(id -u):$(id -g)" \
    "${net_args[@]}" \
    -v "$SDK:/sdk" -e ANDROID_SDK_ROOT=/sdk -e ANDROID_AVD_HOME=/sdk/avd \
    -e ANDROID_USER_HOME=/sdk/home \
    --entrypoint bash "$IMAGE" -lc \
    "adb start-server >/dev/null 2>&1; exec emulator -avd '$AVD_NAME' $AVD_ARGS" >/dev/null
  log "container $CONTAINER started"
}

wait_boot() {
  log "waiting for adb device + sys.boot_completed=1 (timeout ${BOOT_TIMEOUT}s)"
  docker exec "$CONTAINER" adb wait-for-device >/dev/null 2>&1 || true
  local i=0 b=""
  while [ "$i" -lt "$BOOT_TIMEOUT" ]; do
    running || { docker logs --tail 40 "$CONTAINER" 2>&1; die "emulator container exited"; }
    b=$(docker exec "$CONTAINER" adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || true)
    if [ "$b" = "1" ]; then
      log "sys.boot_completed=1 after ${i}s"
      docker exec "$CONTAINER" adb shell input keyevent 82 >/dev/null 2>&1 || true
      printf '  Android %s (API %s) / %s\n' \
        "$(docker exec "$CONTAINER" adb shell getprop ro.build.version.release | tr -d '\r')" \
        "$(docker exec "$CONTAINER" adb shell getprop ro.build.version.sdk | tr -d '\r')" \
        "$(docker exec "$CONTAINER" adb shell getprop ro.product.model | tr -d '\r')"
      return 0
    fi
    sleep 5; i=$((i + 5))
    [ $((i % 30)) -eq 0 ] && log "  ... ${i}s boot_completed='${b}'"
  done
  docker logs --tail 40 "$CONTAINER" 2>&1
  die "boot timed out after ${BOOT_TIMEOUT}s"
}

shot() {
  running || die "container not running"
  log "capturing screenshot"
  docker exec "$CONTAINER" sh -c 'adb exec-out screencap -p > /sdk/boot.png'
  docker exec "$CONTAINER" ls -l /sdk/boot.png
  log "screenshot -> $SDK/boot.png"
}

cmd="${1:-up}"
case "$cmd" in
  up)         ensure_image; ensure_sdk; ensure_avd; start_emulator; wait_boot; shot ;;
  status)
    if running; then
      echo "container: running ($(docker inspect -f '{{.State.Status}} {{.Created}}' "$CONTAINER"))"
      docker exec "$CONTAINER" adb devices
      printf 'sys.boot_completed=%s\n' \
        "$(docker exec "$CONTAINER" adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    else echo "container: not running"; fi ;;
  shot)       shot ;;
  shell)      docker exec -it "$CONTAINER" adb shell ;;
  log)        docker logs --tail 100 "$CONTAINER" 2>&1 ;;
  dockerfile) printf '%s\n' "$DOCKERFILE_TEXT" ;;
  down)
    docker exec "$CONTAINER" adb kill-server >/dev/null 2>&1 || true
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    log "emulator container removed"
    if [ "${2:-}" = "--wipe" ]; then rm -rf "$SDK/avd" "$SDK/home"; log "AVD state wiped"; fi ;;
  -h|--help|help) usage ;;
  *) echo "unknown command: $cmd (try --help)" >&2; exit 2 ;;
esac
