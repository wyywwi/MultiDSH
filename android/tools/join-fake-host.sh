#!/usr/bin/env bash
# Join a MultiDSH pool as a "host" from the test-linux-a shell — this simulates the second
# device you would normally run the host sidecar on. Used by the M2.0 Android smoke test.
#
# Usage (on L40):
#   bash tools/join-fake-host.sh <8-CHAR-POOL-CODE> [HOST_PUBLIC_URL]
# Default HOST_PUBLIC_URL points at tools/fake-host-server.py on this machine's LAN IP:4090.
set -euo pipefail

CODE="${1:?usage: join-fake-host.sh <POOL_CODE> [PUBLIC_URL]}"
DIRECTORY="${DIRECTORY:-https://multidsh.example.com}"
LAN_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_URL="${2:-http://$LAN_IP:4090}"
NAME="${HOST_NAME:-fake-l40-host}"

echo "directory:   $DIRECTORY"
echo "pool code:   $CODE"
echo "public url:  $PUBLIC_URL"

curl -sS -X POST "$DIRECTORY/api/pools/join" \
  -H "content-type: application/json" \
  --data "{\"code\":\"$CODE\",\"kind\":\"host\",\"name\":\"$NAME\",\"platform\":\"linux\",\"version\":\"0.1.0\",\"publicUrl\":\"$PUBLIC_URL\"}"
echo
