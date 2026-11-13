"use strict";
/**
 * sov — local server for the Electron overlay.
 *
 * A faithful port of standalone/server.py's HTTP contract to Node's
 * built-in http module (no dependencies). It serves the prebuilt React
 * frontend from dist/ and the Spotify OAuth callback on 127.0.0.1:8888:
 *
 *   GET  /api/health        -> {"ok": true} (no secret needed)
 *   GET  /api/config        -> {clientId, source, redirectUri, build}
 *                              — requires the per-launch secret (the app
 *                              sends it; the callback's /api/config
 *                              fallback fetch will 403 in the browser,
 *                              which is fine — the normal callback path
 *                              gets the Client ID from /api/login-state,
 *                              and the fallback only ever ran when the
 *                              login was already stale)
 *   POST /api/login-state   -> store the PKCE verifier/state (memory only)
 *                              — requires the per-launch secret
 *   GET  /api/login-state?state=… -> hand the verifier out once (single-use)
 *                              (no secret: the browser callback reads it;
 *                              consuming a state also records it, so the
 *                              later token POST can be bound to it)
 *   POST /api/tokens        -> store finished tokens (memory only) — must
 *                              carry the OAuth `state` of a recently
 *                              consumed login-state (10 min TTL)
 *   GET  /api/tokens        -> the tokens the app polls for — SINGLE-USE:
 *                              the first successful read clears them
 *   DELETE /api/tokens      -> clear the handoff once the app saved them
 *                              — requires the per-launch secret
 *   GET  /callback          -> the login page (callback.html, byte-identical
 *                              to server.py's CALLBACK_HTML)
 *   GET  /…                 -> static files from dist/ ("/" serves index.html)
 *
 * Local-server hardening (Phase 1 item 4):
 *   * Host validation — every request whose Host header isn't
 *     127.0.0.1:8888 or localhost:8888 gets 403. This blocks DNS
 *     rebinding (a foreign hostname resolving to 127.0.0.1).
 *   * No Access-Control-Allow-Origin header is ever sent, so a foreign
 *     origin cannot read any response even when it names 127.0.0.1
 *     directly. Every response also carries X-Content-Type-Options:
 *     nosniff and a Content-Security-Policy (see cspFor()).
 *   * POSTs must carry Content-Type: application/json (415 otherwise).
 *   * Per-launch secret — crypto.randomBytes at server creation, never
 *     logged or written to disk. It is injected into the served
 *     index.html in memory (window.__SOV_SECRET__) and must be sent
 *     as X-Sov-Secret on POST /api/login-state, GET /api/config,
 *     GET /api/tokens and DELETE /api/tokens. GET /api/health is exempt
 *     (App.tsx polls it and must keep working untouched), and the
 *     browser callback flow (GET /api/login-state, POST /api/tokens)
 *     is exempt because the default browser has no secret — the token
 *     POST is bound to the OAuth state instead (see above).
 *   * GET /api/tokens is single-use: the first successful read clears
 *     the handoff. Tradeoff: if the app reads the tokens but fails to
 *     import them (e.g. storage unavailable), the login is lost and
 *     the user must press Connect again — accepted, because a
 *     re-readable handoff lets any local process harvest tokens.
 *
 * The redirect URI is http://127.0.0.1:8888/callback — registered in the
 * user's Spotify dashboard; it must not change.
 *
 * No Client ID, token or secret is stored in this file. The Client ID is
 * read from ~/.spotify_overlay.json (the same file the old Python overlay
 * saved it to) and handed to the frontend through /api/config. Tokens
 * live in memory only, expire after 10 minutes, and are never logged
 * and never written to disk. The server only listens on 127.0.0.1.
 *
 * This module has no Electron dependency, so it can be smoke-tested with
 * plain Node: `node server.js` starts it on 127.0.0.1:8888.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 8888;
const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;

// Build stamp — shown in the app footer (from /api/config) and printed
// at startup, so a screenshot proves which build is running. The
// "-electron" suffix distinguishes this shell from the old Python one
// (which was plain "2026-11-12e"); the React app itself is unchanged.
const BUILD = "2026-11-13m-electron";

const LOGIN_TTL_MS = 600_000; // 10 minutes
const MAX_BODY_BYTES = 65536;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadClientId() {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".spotify_overlay.json"), "utf8"),
    );
    const cid =
      data && typeof data.client_id === "string" ? data.client_id.trim() : "";
    return cid || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- in-memory handoff
// The overlay window (Electron) and the user's default browser do NOT
// share localStorage, so the login is handed through this server:
//   * POST /api/login-state {verifier, state, client_id} — the app
//     stores the PKCE verifier here before opening the browser, so the
//     callback (running in the browser) can finish the exchange.
//   * POST /api/tokens {access_token, refresh_token?, expires_at} — the
//     callback posts the finished tokens here; the app polls
//     GET /api/tokens and picks them up.
const loginStates = new Map(); // state -> { verifier, client_id, ts }
let tokens = { value: null, ts: 0 };
// States whose login-state was legitimately consumed by the browser
// callback (GET /api/login-state) — state -> ts. POST /api/tokens is
// only accepted for one of these, so a stray page can't plant tokens
// for the app to pick up. Entries expire after LOGIN_TTL_MS.
const consumedStates = new Map();

function purgeExpired(now) {
  for (const [state, entry] of loginStates) {
    if (now - entry.ts > LOGIN_TTL_MS) loginStates.delete(state);
  }
  for (const [state, ts] of consumedStates) {
    if (now - ts > LOGIN_TTL_MS) consumedStates.delete(state);
  }
}

function purgeLoginStates(now) {
  purgeExpired(now);
}

function storeLoginState(verifier, state, clientId) {
  const now = Date.now();
  purgeLoginStates(now);
  loginStates.set(state, { verifier, client_id: clientId, ts: now });
}

function takeLoginState(state) {
  const now = Date.now();
  purgeLoginStates(now);
  const entry = loginStates.get(state);
  if (!entry) return null;
  loginStates.delete(state); // single-use
  return { verifier: entry.verifier, clientId: entry.client_id };
}

function storeTokens(t) {
  tokens = { value: t, ts: Date.now() };
}

function takeTokens() {
  if (!tokens.value) return null;
  if (Date.now() - tokens.ts > LOGIN_TTL_MS) {
    tokens = { value: null, ts: 0 };
    return null;
  }
  // Single-use: the first successful read consumes the handoff, so a
  // second reader (or a second poll) gets null. The app polls every
  // 2s while waiting and already handles a null response.
  const value = { ...tokens.value };
  tokens = { value: null, ts: 0 };
  return value;
}

function clearTokens() {
  tokens = { value: null, ts: 0 };
}

// ------------------------------------------------------------------ server
function createServer({ distDir, onLog }) {
  const distAbs = path.resolve(distDir);
  const callbackHtml = fs.readFileSync(
    path.join(__dirname, "callback.html"),
    "utf8",
  );

  // Per-launch secret: fresh random bytes every time the server starts
  // (one server per app launch). Never logged, never written to disk,
  // never sent over /api/config — it only reaches the Electron window
  // through the in-memory index.html injection below.
  const SERVER_SECRET = crypto.randomBytes(32).toString("base64url");

  function log(line) {
    if (typeof onLog === "function") onLog(line);
  }

  // Host validation (DNS-rebinding defence): only the loopback names
  // this server actually listens on, with port 8888 when one is given.
  // A rebinding hostname (evil.example -> 127.0.0.1) fails here even
  // though it resolves to this machine.
  function hostOk(req) {
    const raw = typeof req.headers.host === "string" ? req.headers.host : "";
    const host = raw.trim().toLowerCase();
    if (!host) return false;
    const idx = host.lastIndexOf(":");
    let name = host;
    let port = "";
    if (idx !== -1) {
      name = host.slice(0, idx);
      port = host.slice(idx + 1);
      if (!/^\d+$/.test(port)) return false;
    }
    if (name !== "127.0.0.1" && name !== "localhost") return false;
    return port === "" || port === String(PORT);
  }

  // Constant-time comparison so the secret can't be probed byte by byte.
  function secretOk(req) {
    const given = req.headers["x-sov-secret"];
    if (typeof given !== "string" || !given) return false;
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(SERVER_SECRET, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function isJsonContent(req) {
    const ct = req.headers["content-type"];
    if (typeof ct !== "string") return false;
    return ct.split(";")[0].trim().toLowerCase() === "application/json";
  }

  // Content-Security-Policy for served pages. Chosen conservatively so
  // it cannot break the React app:
  //   script-src 'self' + per-response nonce — the app loads only its
  //     own /app.js; the one inline script (the injected secret, and
  //     callback.html's inline script) carries the nonce.
  //   style-src 'self' 'unsafe-inline' — index.html has an inline
  //     <style> for the transparent first paint, callback.html has an
  //     inline <style>, and React sets style={{...}} attributes all
  //     over (10+ in App.tsx alone); a stricter style-src would break
  //     the UI. Inline styles can't exfiltrate data the way inline
  //     scripts can, so this is the accepted tradeoff.
  //   img-src 'self' data: https: — cover art comes from Spotify's CDN
  //     (https://i.scdn.co, host varies per image) and icons are data:.
  //   connect-src 'self' + the three API hosts the app fetches:
  //     api.spotify.com (Web API), accounts.spotify.com (token
  //     exchange/refresh) and lrclib.net (synced lyrics). 'self'
  //     covers the /api/* calls to this server.
  //   font-src 'self' data: — no external fonts today; bundled or
  //     embedded only.
  //   media-src / object-src / frame-src 'none' — the app plays no
  //     media itself and embeds nothing.
  //   base-uri 'self', form-action 'self' — no forms in the app.
  // Deliberately NO Access-Control-Allow-Origin anywhere: a foreign
  // origin must not be able to read any response from this server.
  function cspFor(nonce) {
    return [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://lrclib.net",
      "font-src 'self' data:",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }

  function send(req, res, status, body, contentType, nonce) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": cspFor(nonce),
    });
    // One line per request, like server.py's log_message — never logs
    // a body, so token values can never appear here.
    log(`sov: "${req.method} ${req.url} HTTP/1.1" ${status} ${buf.length}`);
    if (req.method !== "HEAD") res.end(buf);
    else res.end();
  }

  function sendJson(req, res, status, obj, nonce) {
    send(req, res, status, JSON.stringify(obj), "application/json; charset=utf-8", nonce);
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      const len = Number.parseInt(req.headers["content-length"] || "0", 10);
      if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      const chunks = [];
      let total = 0;
      let done = false;
      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(data && typeof data === "object" && !Array.isArray(data) ? data : null);
        } catch {
          finish(null);
        }
      });
      req.on("error", () => finish(null));
    });
  }

  const server = http.createServer((req, res) => {
    (async () => {
      // One fresh CSP nonce per response; the same nonce is stamped
      // onto any inline <script> this response carries.
      const nonce = crypto.randomBytes(16).toString("base64");

      // Host validation runs before anything else — including the
      // health check — so a rebinding hostname gets nothing at all.
      if (!hostOk(req)) {
        sendJson(req, res, 403, { error: "forbidden host" }, nonce);
        return;
      }

      let url;
      try {
        url = new URL(req.url, `http://${HOST}:${PORT}`);
      } catch {
        sendJson(req, res, 400, { error: "bad request" }, nonce);
        return;
      }
      const pathname = url.pathname;

      if (req.method === "POST" && pathname === "/api/login-state") {
        if (!secretOk(req)) {
          sendJson(req, res, 403, { error: "forbidden" }, nonce);
          return;
        }
        if (!isJsonContent(req)) {
          sendJson(req, res, 415, { error: "application/json required" }, nonce);
          return;
        }
        const data = await readJsonBody(req);
        if (
          !data ||
          typeof data.verifier !== "string" ||
          !data.verifier ||
          typeof data.state !== "string" ||
          !data.state ||
          typeof data.client_id !== "string" ||
          !data.client_id
        ) {
          sendJson(req, res, 400, { error: "verifier, state and client_id required" }, nonce);
          return;
        }
        storeLoginState(data.verifier, data.state, data.client_id);
        sendJson(req, res, 200, { ok: true }, nonce);
        return;
      }

      if (req.method === "POST" && pathname === "/api/tokens") {
        // The browser callback has no per-launch secret, so this POST
        // is bound to the OAuth state instead: it is only accepted
        // when the state was recently consumed by the callback's
        // GET /api/login-state (10 min TTL). The app itself never
        // POSTs tokens, so this binding doesn't break it.
        if (!isJsonContent(req)) {
          sendJson(req, res, 415, { error: "application/json required" }, nonce);
          return;
        }
        const data = await readJsonBody(req);
        if (
          !data ||
          typeof data.access_token !== "string" ||
          !data.access_token ||
          typeof data.expires_at !== "number"
        ) {
          sendJson(req, res, 400, { error: "access_token and expires_at required" }, nonce);
          return;
        }
        if (typeof data.state !== "string" || !data.state) {
          sendJson(req, res, 403, { error: "state required" }, nonce);
          return;
        }
        purgeExpired(Date.now());
        if (!consumedStates.has(data.state)) {
          sendJson(req, res, 403, { error: "unknown or expired state" }, nonce);
          return;
        }
        storeTokens({
          access_token: data.access_token,
          refresh_token:
            typeof data.refresh_token === "string" ? data.refresh_token : "",
          expires_at: data.expires_at,
        });
        sendJson(req, res, 200, { ok: true }, nonce);
        return;
      }

      if (req.method === "DELETE" && pathname === "/api/tokens") {
        if (!secretOk(req)) {
          sendJson(req, res, 403, { error: "forbidden" }, nonce);
          return;
        }
        clearTokens();
        sendJson(req, res, 200, { ok: true }, nonce);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (pathname === "/api/health") {
          // Exempt from the secret: App.tsx polls this and must keep
          // working untouched. It carries no sensitive data.
          sendJson(req, res, 200, { ok: true }, nonce);
          return;
        }
        if (pathname === "/api/config") {
          // Secret required. The browser callback's /api/config
          // fallback fetch will 403 — acceptable: the normal callback
          // path gets the Client ID from /api/login-state, and the
          // fallback only ever ran when the login was already stale.
          if (!secretOk(req)) {
            sendJson(req, res, 403, { error: "forbidden" }, nonce);
            return;
          }
          const cid = loadClientId();
          sendJson(req, res, 200, {
            clientId: cid,
            source: cid ? "spotify_overlay.json" : "none",
            redirectUri: REDIRECT_URI,
            build: BUILD,
          }, nonce);
          return;
        }
        if (pathname === "/api/tokens") {
          if (!secretOk(req)) {
            sendJson(req, res, 403, { error: "forbidden" }, nonce);
            return;
          }
          sendJson(req, res, 200, { tokens: takeTokens() }, nonce);
          return;
        }
        if (pathname === "/api/login-state") {
          // Exempt from the secret: the browser callback reads this to
          // get the PKCE verifier. It is single-use and gated on the
          // random state value — and consuming it records the state,
          // which is what later authorises the token POST.
          const state = url.searchParams.get("state") || "";
          const entry = state ? takeLoginState(state) : null;
          if (!entry) {
            sendJson(req, res, 404, { error: "not found" }, nonce);
            return;
          }
          consumedStates.set(state, Date.now());
          sendJson(req, res, 200, entry, nonce);
          return;
        }
        if (pathname === "/callback") {
          // callback.html's inline <script> needs this response's
          // nonce or the CSP above blocks it (its inline <style> is
          // covered by style-src 'unsafe-inline').
          const page = callbackHtml.replace(
            "<script>",
            `<script nonce="${nonce}">`,
          );
          send(req, res, 200, page, "text/html; charset=utf-8", nonce);
          return;
        }

        // Static files from dist/ — "/" serves the app.
        const rel = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\//, "");
        const target = path.resolve(distAbs, rel);
        if (target !== distAbs && !target.startsWith(distAbs + path.sep)) {
          send(req, res, 404, "not found", "text/plain", nonce);
          return;
        }
        let stat;
        try {
          stat = fs.statSync(target);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isFile()) {
          send(req, res, 404, "not found", "text/plain", nonce);
          return;
        }
        const contentType =
          MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
        let body = fs.readFileSync(target);
        if (rel === "index.html") {
          // Inject the per-launch secret into the served page, in
          // memory only — dist/index.html on disk is a build artifact
          // and is never edited. The script carries this response's
          // CSP nonce so script-src allows it.
          const injected =
            `<script nonce="${nonce}">window.__SOV_SECRET__=${JSON.stringify(SERVER_SECRET)};</script></head>`;
          body = Buffer.from(
            body.toString("utf8").replace("</head>", injected),
            "utf8",
          );
        }
        send(req, res, 200, body, contentType, nonce);
        return;
      }

      sendJson(req, res, 404, { error: "not found" }, nonce);
    })().catch(() => {
      try {
        sendJson(req, res, 500, { error: "internal error" }, crypto.randomBytes(16).toString("base64"));
      } catch {
        // Response already gone — nothing to do.
      }
    });
  });

  return server;
}

/** Start listening on 127.0.0.1:8888. Resolves with the server, or
 *  rejects with the listen error (EADDRINUSE when another sov — or
 *  anything else — already holds the port). */
function startServer({ distDir, onLog }) {
  return new Promise((resolve, reject) => {
    const server = createServer({ distDir, onLog });
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

module.exports = { createServer, startServer, HOST, PORT, REDIRECT_URI, BUILD };

// Standalone smoke-test mode: `node server.js` serves dist/ on 8888.
if (require.main === module) {
  const distDir = path.join(__dirname, "dist");
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error("sov: dist/ is missing — the prebuilt frontend is not here.");
    process.exit(1);
  }
  startServer({ distDir, onLog: (line) => console.log(line) })
    .then(() => {
      console.log(`sov: serving on http://${HOST}:${PORT}/`);
      console.log(`sov: build ${BUILD}`);
      console.log("sov: press Ctrl+C to stop.");
    })
    .catch((err) => {
      console.error(`sov: could not listen on ${HOST}:${PORT} — ${err.message}`);
      if (err.code === "EADDRINUSE") {
        console.error("sov: port 8888 is already in use — another sov is still running.");
        console.error("sov: close the old sov window first, then run this again.");
      }
      process.exit(1);
    });
}
