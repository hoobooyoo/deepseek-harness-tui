/**
 * deepcode theme — an opencode-inspired terminal palette.
 *
 * The visual language follows opencode's approach: a warm accent on a dark
 * terminal, semantic tokens (accent / success / warning / error / info /
 * muted), truecolor when the terminal supports it, and a clean fallback to
 * 256-color and then plain ANSI. `NO_COLOR` and `FORCE_COLOR` are honored.
 *
 * @module deepcode/lib/theme
 */

/** Warm brand color — opencode's `primary` (darkStep9). */
const ACCENT = "#fab283";
/** Lighter brand shade — opencode's darkStep10. */
const ACCENT_LIGHT = "#ffc09f";
/** Semantic tokens, taken from opencode's default `opencode` theme (dark). */
const PALETTE = {
  accent: ACCENT,
  accentLight: ACCENT_LIGHT,
  secondary: "#5c9cf5",
  purple: "#9d7cd8",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  info: "#56b6c2",
  text: "#eeeeee",
  muted: "#808080",
  subtle: "#606060",
  border: "#484848",
  borderSubtle: "#3c3c3c",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
};

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Nearest 6x6x6 256-color cube index for an RGB triple. */
function rgbToAnsi256(r, g, b) {
  const scale = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * scale(r) + 6 * scale(g) + scale(b);
}

function colorEnabled() {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "0" && force !== "false") return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function truecolorEnabled() {
  const colorterm = process.env.COLORTERM ?? "";
  const term = process.env.TERM ?? "";
  if (/truecolor|24bit/i.test(colorterm + " " + term)) return true;
  return /^(iTerm\.app|WezTerm|ghostty|vscode|Hyper|kitty)$/i.test(
    process.env.TERM_PROGRAM ?? "",
  );
}

const ENABLED = colorEnabled();
const TRUECOLOR = ENABLED && truecolorEnabled();

function wrap(open, close, text) {
  if (!ENABLED) return text;
  return `${open}${text}${close}`;
}

/** Paint text with a hex color, degrading gracefully. */
export function paint(text, color) {
  if (!ENABLED || color == null) return String(text);
  const [r, g, b] = hexToRgb(color);
  if (TRUECOLOR) {
    return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
  }
  return `\u001b[38;5;${rgbToAnsi256(r, g, b)}m${text}\u001b[0m`;
}

export function bold(text) {
  return wrap("\u001b[1m", "\u001b[0m", text);
}

export function dim(text) {
  return wrap("\u001b[2m", "\u001b[0m", text);
}

/** Color a string from `from` to `to` hex, per character, left to right. */
export function gradient(text, from, to) {
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  const length = Math.max(String(text).length, 1);
  let out = "";
  for (let i = 0; i < String(text).length; i += 1) {
    const t = i / (length - 1);
    const rgb = fromRgb.map((start, channel) =>
      Math.round(start + (toRgb[channel] - start) * t),
    );
    const hex =
      "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    out += paint(text[i], hex);
  }
  return out;
}

export const accent = (text) => paint(text, PALETTE.accent);
export const success = (text) => paint(text, PALETTE.success);
export const warning = (text) => paint(text, PALETTE.warning);
export const error = (text) => paint(text, PALETTE.error);
export const info = (text) => paint(text, PALETTE.info);
export const muted = (text) => paint(text, PALETTE.muted);

export { PALETTE, ENABLED as colorSupported };
