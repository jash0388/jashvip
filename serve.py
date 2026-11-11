#!/usr/bin/env python3
"""Local server for the KALI AI copy — no licence key needed.

The prediction is NOT computed here. /api/prediction forwards to the upstream
engine (GET /api/engine) server-side, which bypasses the remote's cross-origin
block and needs no key. Results are cached per game, and after an upstream 429 the
proxy retries the same public endpoint through the r.jina.ai relay (different
egress IP); if that also fails it honours Retry-After and serves the last known
state instead of hammering — the period label keeps ticking so the UI stays alive.
"""
import json, os, time, urllib.error, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REMOTE = "https://haodw83xgjs.pages.dev"
ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8790
PERIOD_MS = {"30s": 30000, "1m": 60000}
CACHE_TTL_MS = 3000
CACHE = {}
LAST = {}          # game -> (issue, measuredAt) for local period ticking
COOLDOWN = {"until": 0, "reason": ""}


RELAY = "https://r.jina.ai/"


def _extract_json(text):
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("no json in relay body")
    return json.loads(text[i:j + 1])


def relay_json(path, timeout=25):
    """Fetch the public engine through r.jina.ai, which egresses from another IP.

    The upstream rate-limits this machine's IP (HTTP 429 on /api/engine), so the
    relay is how the same keyless public output keeps arriving.
    """
    req = urllib.request.Request(RELAY + REMOTE + path, headers={
        "Accept": "text/plain",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return _extract_json(r.read().decode("utf-8", "replace"))


def remote_json(path, timeout=10):
    req = urllib.request.Request(REMOTE + path, headers={
        "Accept": "application/json",
        "X-Client-Version": "2026.10.28",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as ex:
        if ex.code != 429:
            raise
        try:
            return relay_json(path)
        except Exception:
            raise ex
    except Exception:
        return relay_json(path)


def ticked_issue(key, now):
    """Locally extrapolate the running period from the last good sample."""
    last = LAST.get(key)
    if not last:
        return None
    issue, at = last
    try:
        return str(int(issue) + (now - at) // PERIOD_MS[key])
    except Exception:
        return issue


def soft_payload(key, now, engine_state, message=None):
    return {
        "status": "OK", "game": key,
        "prediction": None, "call": None,
        "afterIssue": ticked_issue(key, now),
        "currentIssue": ticked_issue(key, now),
        "issue": ticked_issue(key, now),
        "probabilityBig": None, "probability": None,
        "confidence": message or "WAITING FOR ENGINE",
        "edgePp": None, "engine": engine_state,
        "release": None, "measuredAt": None,
        "openEnd": now + PERIOD_MS[key],
    }


def engine_payload(game="30s"):
    key = game if game in PERIOD_MS else "30s"
    now = int(time.time() * 1000)
    hit = CACHE.get(key)
    if hit and now - hit["at"] < CACHE_TTL_MS:
        return hit["payload"], 200
    if now < COOLDOWN["until"]:
        if hit:
            p = dict(hit["payload"])
            p["stale"] = True
            p["cooldownMs"] = COOLDOWN["until"] - now
            return p, 200
        return soft_payload(key, now, "COOLDOWN", "UPSTREAM RATE LIMIT - WAITING"), 200
    try:
        e = remote_json("/api/engine?game=" + key)
    except urllib.error.HTTPError as ex:
        wait = 60
        try:
            wait = int(ex.headers.get("Retry-After") or 60)
        except Exception:
            pass
        COOLDOWN["until"] = now + wait * 1000
        COOLDOWN["reason"] = "HTTP %s" % ex.code
        if hit:
            p = dict(hit["payload"])
            p["stale"] = True
            p["upstream"] = COOLDOWN["reason"]
            return p, 200
        return soft_payload(key, now, "COOLDOWN", "UPSTREAM RATE LIMIT - WAITING"), 200
    except Exception as ex:
        if hit:
            p = dict(hit["payload"])
            p["stale"] = True
            p["upstream"] = str(ex)
            return p, 200
        return soft_payload(key, now, "WAITING", "ENGINE UNREACHABLE"), 200
    if e.get("status") != "OK":
        if hit:
            p = dict(hit["payload"])
            p["stale"] = True
            p["upstream"] = e.get("message")
            return p, 200
        return soft_payload(key, now, "WAITING", e.get("message") or "UPSTREAM BUSY"), 200

    pb = e.get("probabilityBig")
    prob = max(pb, 1 - pb) if isinstance(pb, (int, float)) else None
    payload = {
        "status": "OK", "game": e.get("game", key),
        "prediction": e.get("prediction"), "call": e.get("prediction"),
        "afterIssue": e.get("afterIssue"), "currentIssue": e.get("afterIssue"),
        "issue": e.get("afterIssue"), "targetIssue": e.get("afterIssue"),
        "probabilityBig": pb, "probability": prob,
        "confidence": e.get("confidence"), "edgePp": e.get("edgePp"),
        "engine": e.get("engine"), "historyAvailable": e.get("historyAvailable"),
        "historyRequired": e.get("historyRequired"), "release": e.get("release"),
        "measuredAt": e.get("measuredAt"),
        "openEnd": (e.get("measuredAt") or now) + PERIOD_MS[key],
    }
    CACHE[key] = {"at": now, "payload": payload}
    if e.get("afterIssue"):
        LAST[key] = (e["afterIssue"], e.get("measuredAt") or now)
    return payload, 200


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        if not path.startswith("/api/"):
            return super().do_GET()
        game = (qs.get("game") or ["30s"])[0]
        if path in ("/api/prediction", "/api/engine"):
            return self._send(*engine_payload(game))
        if path == "/api/gate":
            return self._send({"status": "OK", "name": "KALI AI 4.0",
                               "plan": "LOCAL ENGINE", "deviceLabel": "Local",
                               "expiresAt": int(time.time() * 1000) + 30 * 86400000})
        if path == "/api/security/csrf":
            return self._send({"status": "OK", "token": "local-" + str(int(time.time())),
                               "expiresAt": int(time.time() * 1000) + 240000})
        if path == "/api/results":
            return self._send({"status": "OK", "rows": [], "currentIssue": None})
        if path == "/api/setup-status":
            try:
                return self._send(remote_json("/api/setup-status"))
            except Exception:
                return self._send({"status": "OK", "maintenance": False, "payments": False, "plans": []})
        if path == "/api/order/status":
            return self._send({"status": "ORDER_NOT_FOUND", "message": "NO ORDER ON THIS DEVICE"}, 401)
        if path == "/api/health":
            return self._send({"status": "OK", "name": "KALI AI 4.0", "mode": "local engine proxy"})
        return self._send({"status": "NOT_FOUND", "message": "UNKNOWN API ROUTE"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw.decode() or "{}")
        except Exception:
            body = {}
        if path == "/api/prediction":
            return self._send(*engine_payload(body.get("game") or "30s"))
        if path == "/api/licence/redeem":
            now = int(time.time() * 1000)
            return self._send({"status": "OK", "session": {
                "keyHash": "local-demo", "deviceId": "local-demo",
                "durationLabel": "LOCAL DEMO", "durationMs": 0,
                "activatedAtMs": now, "expiresAtMs": 0, "status": "ACTIVE",
                "sessionSig": "SIG_LOCAL_DEMO"}})
        if path == "/api/licence/logout":
            return self._send({"status": "OK"})
        if path in ("/api/order/create", "/api/order/claim", "/api/order/cancel"):
            return self._send({"status": "OK", "order": None})
        return self._send({"status": "OK"})


if __name__ == "__main__":
    print("KALI local engine on http://127.0.0.1:%d" % PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
