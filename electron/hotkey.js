"use strict";
/**
 * Global toggle hotkey — configurable, default Ctrl+Shift+M.
 *
 * Why Ctrl+Shift+M: the old default (Right Shift+M) also types a
 * capital M in chat. The low-level hook only *observes* keystrokes —
 * it cannot swallow them — so the combo fired while the user was
 * typing. Ctrl+Shift+M cannot produce a character while Ctrl is
 * held, so it never collides with typing; Ctrl+Shift is also not a
 * gameplay combo (unlike Shift alone, e.g. sprint). Either Ctrl and
 * either Shift count in the hook tracker.
 *
 * Settings file — ~/.sov-settings.json (read once at startup; there
 * is deliberately NO settings IPC yet — a later Phase 2 step owns
 * the settings UI and IPC, and must match this exact format):
 *
 *   {
 *     "hotkey": "ctrl+shift+m",        // combo, see parseHotkey
 *     "hotkeyMode": "hook"             // "hook" | "globalShortcut"
 *   }
 *
 * - "hotkey": "+"-joined, case-insensitive. Modifiers: ctrl, shift,
 *   alt, meta — each optionally suffixed with "left"/"right"
 *   (e.g. "ctrlright+shift+m", "shiftright+m"). The last token is
 *   the key: a single letter (a-z), a digit (0-9), or F1–F24.
 *   Examples: "ctrl+shift+m" (default), "ctrl+alt+m",
 *   "shiftright+m" (the old default). Unknown tokens, a missing
 *   key, or two keys fall back to the default with a console log.
 * - "hotkeyMode": "hook" (default) uses the low-level keyboard hook
 *   (uiohook-napi), which reports left/right modifiers as different
 *   keycodes and works even when the app is not focused — including
 *   while a game has focus — and falls back to globalShortcut for
 *   the same combo if the hook cannot load. "globalShortcut" skips
 *   the hook entirely and registers the combo with Electron's
 *   globalShortcut only. Pick "globalShortcut" if a game's
 *   anti-cheat flags low-level keyboard hooks: some anti-cheat
 *   software treats any global key hook as suspicious, and the
 *   globalShortcut path uses only Windows RegisterHotKey, which
 *   anti-cheat does not flag. Note globalShortcut cannot tell left
 *   from right modifiers, so a side-specific hotkey (e.g.
 *   "shiftright+m") degrades to either side in that mode.
 * - Omitting the file, either field, or the whole file being
 *   invalid JSON all fall back to the defaults (ctrl+shift+m,
 *   hook); nothing throws.
 *
 * The detection logic lives in createHotkeyTracker(), which takes
 * any event emitter with the hook's keydown/keyup events — that
 * makes it unit-testable with synthetic events (the real hook cannot
 * run on a headless Linux VM).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_HOTKEY = "ctrl+shift+m";
const DEFAULT_MODE = "hook";
const SETTINGS_FILE = path.join(os.homedir(), ".sov-settings.json");

const HOTKEY_DESCRIPTION = "Ctrl+Shift+M";
const FALLBACK_HOTKEY = "CommandOrControl+Shift+M";

// Modifier keycode names in uiohook-napi's UiohookKey. "Ctrl"/"Shift"/
// "Alt"/"Meta" are the LEFT keys; the right ones are suffixed Right.
const MODIFIER_KEYS = {
  ctrl: { left: "Ctrl", right: "CtrlRight" },
  shift: { left: "Shift", right: "ShiftRight" },
  alt: { left: "Alt", right: "AltRight" },
  meta: { left: "Meta", right: "MetaRight" },
};

/**
 * Parse a hotkey string ("ctrl+shift+m") into a combo:
 * { key: "M", ctrl: "any"|"left"|"right"|null, shift: ..., alt: ..., meta: ... }
 * Returns null when the string is invalid (unknown token, no key,
 * or more than one non-modifier token).
 */
function parseHotkey(str) {
  if (typeof str !== "string") return null;
  const tokens = str
    .split("+")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return null;
  const combo = { key: null, ctrl: null, shift: null, alt: null, meta: null };
  for (const token of tokens) {
    let matched = false;
    for (const mod of Object.keys(MODIFIER_KEYS)) {
      if (token === mod) {
        combo[mod] = "any";
        matched = true;
      } else if (token === `${mod}left`) {
        combo[mod] = "left";
        matched = true;
      } else if (token === `${mod}right`) {
        combo[mod] = "right";
        matched = true;
      }
    }
    if (matched) continue;
    // The key: one letter, one digit, or F1–F24.
    if (/^[a-z]$/.test(token) || /^[0-9]$/.test(token) || /^f([1-9]|1[0-9]|2[0-4])$/.test(token)) {
      if (combo.key) return null; // two keys
      combo.key = token.toUpperCase();
      continue;
    }
    return null; // unknown token
  }
  if (!combo.key) return null;
  return combo;
}

/** Human-readable form of a combo, e.g. "Ctrl+Shift+M". */
function comboToDescription(combo) {
  const parts = [];
  for (const mod of ["ctrl", "shift", "alt", "meta"]) {
    if (combo[mod] === "any") parts.push(mod[0].toUpperCase() + mod.slice(1));
    else if (combo[mod] === "left") parts.push(`Left ${mod[0].toUpperCase() + mod.slice(1)}`);
    else if (combo[mod] === "right") parts.push(`Right ${mod[0].toUpperCase() + mod.slice(1)}`);
  }
  parts.push(combo.key);
  return parts.join("+");
}

/**
 * Electron globalShortcut accelerator for a combo. globalShortcut
 * cannot distinguish left/right modifiers, so a side-specific combo
 * degrades to either side here. "ctrl" maps to CommandOrControl so
 * the accelerator is correct on every platform.
 */
function comboToAccelerator(combo) {
  const parts = [];
  if (combo.ctrl) parts.push("CommandOrControl");
  if (combo.shift) parts.push("Shift");
  if (combo.alt) parts.push("Alt");
  if (combo.meta) parts.push("Meta");
  parts.push(combo.key);
  return parts.join("+");
}

/**
 * Read ~/.sov-settings.json and resolve the effective hotkey + mode.
 * Never throws; any missing/invalid piece falls back to the default
 * (and logs why, so a typo in the file is visible, not silent).
 * Returns { hotkey, hotkeyMode, combo, accelerator, description }.
 */
function loadHotkeySettings() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    // No file, or invalid JSON — defaults.
    if (fs.existsSync(SETTINGS_FILE)) {
      console.log("sov: ~/.sov-settings.json is not valid JSON — using the default hotkey.");
    }
  }
  let combo = parseHotkey(raw && raw.hotkey);
  if (!combo) {
    if (raw && raw.hotkey !== undefined) {
      console.log(
        `sov: ignoring invalid hotkey ${JSON.stringify(raw.hotkey)} in ~/.sov-settings.json — using the default.`,
      );
    }
    combo = parseHotkey(DEFAULT_HOTKEY);
  }
  let mode = raw && raw.hotkeyMode;
  if (mode !== "hook" && mode !== "globalShortcut") {
    if (raw && mode !== undefined) {
      console.log(
        `sov: ignoring invalid hotkeyMode ${JSON.stringify(mode)} in ~/.sov-settings.json — using "hook".`,
      );
    }
    mode = DEFAULT_MODE;
  }
  return {
    hotkey: comboToDescription(combo),
    hotkeyMode: mode,
    combo,
    accelerator: comboToAccelerator(combo),
    description: comboToDescription(combo),
  };
}

/**
 * Track a combo on an event emitter that fires the hook's
 * keydown/keyup events ({ keycode }). Fires toggle() once per key
 * press while the required modifiers are held (holding the key down
 * does not repeat). A modifier specified as "left"/"right" only
 * counts that side; "any" counts either side. Returns a detach
 * function that removes the listeners.
 */
function createHotkeyTracker({ hook, Key, toggle, combo }) {
  const keyCode = Key[combo.key];
  const state = {
    ctrlLeft: false,
    ctrlRight: false,
    shiftLeft: false,
    shiftRight: false,
    altLeft: false,
    altRight: false,
    metaLeft: false,
    metaRight: false,
  };
  const modCodes = {};
  for (const mod of Object.keys(MODIFIER_KEYS)) {
    modCodes[Key[MODIFIER_KEYS[mod].left]] = [mod, "Left"];
    modCodes[Key[MODIFIER_KEYS[mod].right]] = [mod, "Right"];
  }
  let keyDown = false;

  function modifierSatisfied(mod) {
    const side = combo[mod];
    if (!side) return true;
    if (side === "any") return state[`${mod}Left`] || state[`${mod}Right`];
    return state[`${mod}${side === "left" ? "Left" : "Right"}`];
  }
  function allModifiersSatisfied() {
    return ["ctrl", "shift", "alt", "meta"].every(modifierSatisfied);
  }

  const onKeyDown = (e) => {
    if (!e || typeof e.keycode !== "number") return;
    const mod = modCodes[e.keycode];
    if (mod) {
      state[`${mod[0]}${mod[1]}`] = true;
      return;
    }
    if (e.keycode === keyCode) {
      if (allModifiersSatisfied() && !keyDown) {
        keyDown = true;
        toggle();
      }
    }
  };
  const onKeyUp = (e) => {
    if (!e || typeof e.keycode !== "number") return;
    const mod = modCodes[e.keycode];
    if (mod) {
      state[`${mod[0]}${mod[1]}`] = false;
      return;
    }
    if (e.keycode === keyCode) keyDown = false;
  };

  hook.on("keydown", onKeyDown);
  hook.on("keyup", onKeyUp);
  return () => {
    try {
      hook.removeListener("keydown", onKeyDown);
    } catch {
      // Detach is best-effort.
    }
    try {
      hook.removeListener("keyup", onKeyUp);
    } catch {
      // Detach is best-effort.
    }
  };
}

/**
 * Backwards-compatible Right Shift + M tracker (the old default).
 * Kept so existing tests/callers of createShiftMTracker keep
 * working; new code should use createHotkeyTracker with a combo.
 */
function createShiftMTracker({ hook, Key, toggle }) {
  const combo = parseHotkey("shiftright+m");
  return createHotkeyTracker({ hook, Key, toggle, combo });
}

/**
 * Start the global toggle hotkey. Reads ~/.sov-settings.json once
 * (see loadHotkeySettings). Returns { mode, stop, description }
 * where mode is "hook" (low-level hook for the configured combo),
 * "globalShortcut" (fallback, or the configured mode), or "none"
 * (nothing could be registered — the toggle is then only available
 * by clicking the ring). Never throws.
 */
function createHotkey({ toggle, globalShortcut }) {
  const settings = loadHotkeySettings();
  const { combo, accelerator, description } = settings;

  function registerGlobalShortcut() {
    try {
      if (globalShortcut && globalShortcut.register(accelerator, () => toggle())) {
        return {
          mode: "globalShortcut",
          description,
          stop() {
            try {
              globalShortcut.unregister(accelerator);
            } catch {
              // Stop is best-effort.
            }
          },
        };
      }
    } catch {
      // Fall through to "none".
    }
    return null;
  }

  // Configured globalShortcut-only mode: skip the hook entirely
  // (e.g. when a game's anti-cheat flags low-level keyboard hooks).
  if (settings.hotkeyMode === "globalShortcut") {
    return (
      registerGlobalShortcut() || { mode: "none", description, stop() {} }
    );
  }

  // 1. Low-level hook — the only way to see left/right modifiers
  // specifically, and it works while a game has focus.
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    const detach = createHotkeyTracker({ hook: uIOhook, Key: UiohookKey, toggle, combo });
    try {
      uIOhook.start();
    } catch (startErr) {
      detach();
      throw startErr;
    }
    return {
      mode: "hook",
      description,
      stop() {
        try {
          detach();
        } catch {
          // Stop is best-effort.
        }
        try {
          uIOhook.stop();
        } catch {
          // Stop is best-effort.
        }
      },
    };
  } catch (err) {
    console.log(
      `sov: low-level keyboard hook unavailable (${err && err.message ? err.message : err}) — falling back to the global shortcut.`,
    );
  }

  // 2. Fallback: Electron globalShortcut for the same combo. It
  // cannot tell left from right modifiers, so a side-specific combo
  // degrades to either side here — still usable.
  return (
    registerGlobalShortcut() || { mode: "none", description, stop() {} }
  );
}

module.exports = {
  createHotkey,
  createHotkeyTracker,
  createShiftMTracker,
  loadHotkeySettings,
  parseHotkey,
  comboToAccelerator,
  comboToDescription,
  HOTKEY_DESCRIPTION,
  FALLBACK_HOTKEY,
  DEFAULT_HOTKEY,
  DEFAULT_MODE,
  SETTINGS_FILE,
};
