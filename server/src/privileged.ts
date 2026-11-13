// Host-side handlers for the Spotify connector CLI and LRCLIB.
//
// The overlay is connected DIRECTLY to the Spotify account linked with
// this Muse (the `spotify` connector) — there is no per-user Client ID,
// no OAuth flow in the browser, and no Spotify credential anywhere in the
// app. Server actions cannot spawn processes, so they declare these
// contracts and call ctx.executePrivileged; the handlers below run
// /opt/hatch/bin/spotify-api on the host, which talks to the connected
// account. Actions only ever receive the CLI's JSON output.

import { spawn } from "node:child_process";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  spotifyCli: {
    request: z.object({ args: z.array(z.string()) }),
    response: z.object({
      ok: z.boolean(),
      stdout: z.string(),
      stderr: z.string(),
    }),
    capabilities: ["spotify.read", "spotify.playback"],
    timeoutMs: 30_000,
  },
  fetchText: {
    request: z.object({ url: z.string() }),
    response: z.object({
      ok: z.boolean(),
      status: z.number(),
      text: z.string(),
    }),
    timeoutMs: 20_000,
  },
  fetchBinary: {
    request: z.object({ url: z.string() }),
    response: z.object({
      ok: z.boolean(),
      status: z.number(),
      contentType: z.string(),
      base64: z.string(),
    }),
    timeoutMs: 20_000,
  },
});

function runCli(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/opt/hatch/bin/spotify-api", args, {
      timeout: 25_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: stderr || String(err) });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async spotifyCli(args) {
    return runCli(args.args);
  },
  async fetchText(args) {
    try {
      const res = await fetch(args.url, {
        headers: { "User-Agent": "SpotifyOverlay/3.0 (Muse web artifact)" },
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  },
  async fetchBinary(args) {
    try {
      const res = await fetch(args.url, {
        headers: { "User-Agent": "SpotifyOverlay/3.0 (Muse web artifact)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, contentType: "", base64: "" };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        ok: true,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "image/jpeg",
        base64: buf.toString("base64"),
      };
    } catch {
      return { ok: false, status: 0, contentType: "", base64: "" };
    }
  },
});
