#!/usr/bin/env bash
# Probe the deployed MultiDSH Directory with plain curl/py — used to tell apart
# "Android client bug" from "Directory behaviour" when the app does not show pending devices.
#
# Usage (on L40): bash tools/directory-probe.sh [DIRECTORY_URL]
set -euo pipefail
DIRECTORY="${1:-https://multidsh.example.com}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== GET /api/health"
curl -sS "$DIRECTORY/api/health"; echo

echo "== POST /api/pools (create pool as owner)"
curl -sS -X POST "$DIRECTORY/api/pools" -H "content-type: application/json" \
  --data '{"name":"probe","deviceName":"probe-owner","platform":"linux"}' > "$TMP/create.json"
python3 - "$TMP/create.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
pool=d["pool"]
print("   poolId:", pool["id"], " joinCode:", pool["joinCode"], " owner:", d["device"]["id"], d["device"]["status"])
open(sys.argv[1]+".env","w").write("%s\n%s\n%s\n" % (pool["id"], pool["joinCode"], d["deviceToken"]))
PY
POOL_ID=$(sed -n 1p "$TMP/create.json.env"); CODE=$(sed -n 2p "$TMP/create.json.env"); TOKEN=$(sed -n 3p "$TMP/create.json.env")

echo "== POST /api/pools/join (second device joins as host, pending expected)"
curl -sS -X POST "$DIRECTORY/api/pools/join" -H "content-type: application/json" \
  --data "{\"code\":\"$CODE\",\"kind\":\"host\",\"name\":\"probe-host\",\"platform\":\"linux\",\"version\":\"0.1.0\",\"publicUrl\":\"http://127.0.0.1:4092\"}" > "$TMP/join.json"
python3 - "$TMP/join.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
dev=d["device"]
print("   deviceId:", dev["id"], " status:", dev["status"], " poolId:", dev["poolId"])
PY
HOST_ID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['device']['id'])" "$TMP/join.json")

echo "== GET /api/pools/<pool>/devices (owner token, no includePending)"
curl -sS "$DIRECTORY/api/pools/$POOL_ID/devices" -H "authorization: Bearer $TOKEN"; echo

echo "== GET /api/pools/<pool>/devices?includePending=1 (owner token)"
curl -sS "$DIRECTORY/api/pools/$POOL_ID/devices?includePending=1" -H "authorization: Bearer $TOKEN"; echo

echo "== GET ...?includePending=true (variant, for comparison)"
curl -sS "$DIRECTORY/api/pools/$POOL_ID/devices?includePending=true" -H "authorization: Bearer $TOKEN"; echo

echo "== POST approve $HOST_ID"
curl -sS -X POST "$DIRECTORY/api/pools/$POOL_ID/devices/$HOST_ID/approve" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" --data '{}'; echo

echo "== GET ...?includePending=1 again"
curl -sS "$DIRECTORY/api/pools/$POOL_ID/devices?includePending=1" -H "authorization: Bearer $TOKEN"; echo

echo "== POST /api/pools/<pool>/pair (hostId=$HOST_ID)"
curl -sS -X POST "$DIRECTORY/api/pools/$POOL_ID/pair" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  --data "{\"hostId\":\"$HOST_ID\"}"; echo
