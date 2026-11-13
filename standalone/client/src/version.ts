/**
 * Client build stamp. Keep in sync with BUILD in server.py — both are
 * bumped on every shipped change. The Connect footer prefers the stamp
 * it gets from /api/config (which proves which server.py is running)
 * and falls back to this one when the server doesn't answer (which
 * still proves the dist/ is new: an old dist has no build in its
 * footer at all).
 */
export const CLIENT_BUILD = "2026-11-13m";
