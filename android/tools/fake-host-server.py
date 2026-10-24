#!/usr/bin/env python3
"""Minimal fake MultiDSH *host sidecar* used only to verify the Android client's
pair flow (M2.0). It is NOT the real DSH UI and does not validate the pair nonce.

Behaviour (matches PROTOCOL.md §4 enough for the WebView test):
  GET /__fleet/pair?nonce=... -> 303 Location: /host-ui?token=demo-dsh-token
                                Set-Cookie: dsh-auth-token=demo-cookie-123; Path=/; HttpOnly
  GET /host-ui?token=...      -> 200 HTML if the dsh-auth-* cookie came back, else 400
  every request (incl. the Cookie header) is appended to the request log as JSON lines

Usage on ZJU-L40:
  nohup python3 tools/fake-host-server.py 4090 > ~/fake-host/server.log 2>&1 &
  cat ~/fake-host/requests.log
"""
import http.server
import json
import os
import sys
import time
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4090
LOG = os.path.expanduser("~/fake-host/requests.log")
COOKIE = "dsh-auth-token=demo-cookie-123"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep stdout quiet; the JSON log is the evidence
        pass

    def record(self):
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "t": round(time.time(), 3),
                    "method": self.command,
                    "path": self.path,
                    "cookie": self.headers.get("Cookie"),
                }) + "\n")
        except Exception:
            pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        self.record()

        if u.path == "/__fleet/pair":
            self.send_response(303)
            self.send_header("Location", "/host-ui?token=demo-dsh-token")
            self.send_header("Set-Cookie", COOKIE + "; Path=/; HttpOnly")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        if u.path == "/host-ui":
            cookie = self.headers.get("Cookie") or ""
            ok = COOKIE in cookie
            body = (
                "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                "</head><body style='background:#0b1220;color:#cfe8ff;font-family:sans-serif;padding:20px'>"
                "<h2>MultiDSH host (mock sidecar)</h2>"
                "<p>token query: " + (q.get("token", [""])[0] or "(none)") + "</p>"
                "<p>Cookie header seen: " + (cookie or "(none)") + "</p>"
                "<p style='font-size:20px'>"
                + ("PAIR-OK: 303 followed + dsh-auth-* cookie stored by WebView" if ok
                   else "PAIR-FAIL: cookie missing")
                + "</p>"
                "<p style='color:#8aa'>mock host for verifying the Android pair/WebView flow; "
                "not the real DSH UI.</p></body></html>"
            )
            raw = body.encode("utf-8")
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print("fake host on 0.0.0.0:%d log=%s" % (PORT, LOG), flush=True)
        httpd.serve_forever()
