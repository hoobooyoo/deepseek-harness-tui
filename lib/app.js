/**
 * deepcode TUI — an opencode-style full-screen terminal UI.
 *
 * opencode's own renderer (@opentui) needs Bun FFI and cannot load in the
 * Node harness process, and Ink/blessed cannot paint full truecolor
 * backgrounds. This module is a minimal ANSI renderer that paints the exact
 * opencode look (black background, gray panel blocks, peach accents) with
 * truecolor escape codes.
 *
 * @module deepcode/lib/app
 */

import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PALETTE } from "./theme.js";
import { LOGO_LEFT, LOGO_RIGHT, LOGO_MARKS } from "./logo.js";

const C = PALETTE;

/** Accent color for each agent mode (opencode: plan = highlight peach, goal = red). */
const MODE_COLORS = {
  plan: C.accent,
  goal: C.error,
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** opencode's home prompt max width (tui config `prompt.max_width`, default 75). */
const PROMPT_MAX_WIDTH = 75;
/** opencode's session sidebar width, trimmed for a narrower info block. */
const PANEL_WIDTH = 34;
/** Max option rows shown in a picker (fixed height; excess scrolls). */
const PICKER_MAX_ROWS = 8;
/** Session picker page size — matches the web sidebar's 5-session collapse. */
const SESSION_PAGE_SIZE = 5;
/** Max visible input lines (Ctrl+Enter inserts a line break; older lines scroll out). */
const MAX_INPUT_LINES = 5;
/** opencode toast duration (opencode Toast default duration: 5000ms). */
const TOAST_DURATION_MS = 5000;
/**
 * Highlight background for drag-selection (opencode-style): a subtle warm
 * tint over the element surface — not reverse video — so selected blank rows
 * read as a quiet band instead of a bright inverted bar.
 */
const SELECTION_BG = tint(C.backgroundElement, C.accent, 0.16);

/**
 * TUI-local commands that have no host catalog entry (the web app renders
 * /model and /permission through its own UI). The rest of the slash menu comes
 * live from the harness `commands` catalog — identical to the web app.
 */
const LOCAL_COMMANDS = [
  { id: "/model", hint: "switch model" },
  { id: "/reasoning", hint: "switch reasoning level" },
  { id: "/permission", hint: "switch permission preset" },
  { id: "/preset", hint: "switch agent preset" },
  { id: "/provider", hint: "configure third-party model providers" },
  { id: "/session", hint: "switch to a previous session" },
  { id: "/new", hint: "start a new session" },
  { id: "/quit", hint: "exit deepcode" },
];

// ── ANSI helpers ────────────────────────────────────────────────────────────

function fg(hex) {
  return hex == null ? "" : `\u001b[38;2;${r(hex)};${g(hex)};${b(hex)}m`;
}
function bg(hex) {
  return hex == null ? "" : `\u001b[48;2;${r(hex)};${g(hex)};${b(hex)}m`;
}
function r(h) { return parseInt(h.slice(1, 3), 16); }
function g(h) { return parseInt(h.slice(3, 5), 16); }
function b(h) { return parseInt(h.slice(5, 7), 16); }
const RESET = "\u001b[0m";

/**
 * X11 clipboard daemon handle (spawned lazily, one per session): owns the
 * CLIPBOARD selection through Gdk, so drag-copy works in terminals that
 * ignore OSC 52 (GNOME Terminal / VTE) on X11 sessions without xclip/xsel.
 * `SET <base64>\n` lines re-own the selection with the latest text; closing
 * stdin (TUI quit) ends the daemon.
 */
let clipDaemon = null;
const CLIP_DAEMON = fileURLToPath(new URL("./x11-clipboard.py", import.meta.url));
const CLIP_READER = fileURLToPath(new URL("./x11-clipboard-read.py", import.meta.url));

/** Whether this session can use the Gdk clipboard helper (Linux + X11). */
function canUseGdkClipboard() {
  return process.platform === "linux" && Boolean(process.env.DISPLAY);
}

/** Spawn (or reuse) the X11 clipboard daemon; null when unavailable. */
function ensureClipDaemon() {
  if (clipDaemon !== null && clipDaemon.exitCode === null) return clipDaemon;
  clipDaemon = null;
  try {
    const child = spawn("python3", [CLIP_DAEMON], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.on("error", () => { /* daemon died — next copy respawns */ });
    child.once("error", () => { if (clipDaemon === child) clipDaemon = null; });
    child.once("exit", () => { if (clipDaemon === child) clipDaemon = null; });
    clipDaemon = child;
    return child;
  } catch {
    return null;
  }
}

/**
 * Copy text to the system clipboard: on Linux X11 hand it to the Gdk
 * clipboard daemon first (terminals like GNOME Terminal ignore OSC 52 and
 * xclip/xsel may be absent), then OSC 52 (kitty/wezterm/iTerm2/…), then a
 * best-effort external tool fallback (xclip/xsel/wl-copy/pbcopy/clip).
 * Failures are silent — the selection still shows on screen.
 */
function copyToClipboard(text) {
  const content = String(text ?? "");
  if (content === "") return;
  if (canUseGdkClipboard()) {
    const daemon = ensureClipDaemon();
    if (daemon !== null) {
      try {
        daemon.stdin.write(`SET ${Buffer.from(content, "utf8").toString("base64")}\n`);
      } catch {
        /* daemon died mid-write — fall through to the other paths */
      }
    }
  }
  try {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    process.stdout.write(`\u001b]52;c;${b64}\u0007`);
  } catch {
    /* OSC 52 unsupported — fall through to external tools */
  }
  const candidates =
    process.platform === "win32"
      ? ["clip"]
      : process.platform === "darwin"
        ? ["pbcopy"]
        : ["xclip", "xsel", "wl-copy"];
  const tryTool = (i) => {
    if (i >= candidates.length) return;
    try {
      const child = spawn(candidates[i], [], { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", () => tryTool(i + 1));
      child.stdin.on("error", () => { /* fall through */ });
      child.stdin.write(content);
      child.stdin.end();
    } catch {
      tryTool(i + 1);
    }
  };
  tryTool(0);
}

/**
 * Read the system clipboard and hand the text to the callback: on Linux X11
 * read through Gdk first (wl-paste/xclip/xsel may be absent), then the
 * platform-detected tools. Failures resolve with an empty string.
 */
function readClipboard(cb) {
  if (canUseGdkClipboard()) {
    try {
      const child = spawn("python3", [CLIP_READER], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.once("error", () => tryTool(0));
      child.once("close", () => cb(out));
      return;
    } catch {
      /* fall through to the tools */
    }
  }
  const tools =
    process.platform === "darwin"
      ? [["pbpaste"]]
      : process.platform === "win32"
        ? [["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"]]
        : [["wl-paste"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]];
  const tryTool = (i) => {
    if (i >= tools.length) return cb("");
    try {
      const child = spawn(tools[i][0], tools[i].slice(1), { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.once("error", () => tryTool(i + 1));
      child.once("close", () => cb(out));
    } catch {
      tryTool(i + 1);
    }
  };
  tryTool(0);
}

/** Paste shortcut label for the current platform (⌘V on macOS, Ctrl+V elsewhere). */
const PASTE_SHORTCUT = process.platform === "darwin" ? "⌘v" : "ctrl+v";

/** Mix `fg` into `base` by `ratio` (0..1) — opencode's `tint()`. */
function tint(base, fgHex, ratio) {
  const mix = (a, b) => Math.round(a + (b - a) * ratio);
  const ch = (i) => mix(parseInt(base.slice(i, i + 2), 16), parseInt(fgHex.slice(i, i + 2), 16)).toString(16).padStart(2, "0");
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/**
 * Render one opencode logo line (its left or right half) with the exact
 * marker-glyph mapping: `_` → shadow block, `^` → upper-half block on shadow,
 * `~` → shadow upper-half block, `,` → shadow lower-half block.
 */
function renderLogoLine(line, color, bold) {
  const shadow = tint(C.background, color, 0.25);
  let out = bg(C.background);
  for (const ch of line) {
    if (ch === "_") out += `${bg(shadow)} ${RESET}${bg(C.background)}`;
    else if (ch === "^") out += `${bg(shadow)}${fg(color)}▀${RESET}${bg(C.background)}`;
    else if (ch === "~") out += `${fg(shadow)}▀`;
    else if (ch === ",") out += `${fg(shadow)}▄`;
    else out += `${fg(color)}${ch}`;
  }
  return out + RESET;
}

/** The full 4-line opencode wordmark, centered into `width` columns. */
function renderLogo(width) {
  // opencode renders left + gap(1) + right as one flex row; the whole logo
  // block centers as a unit, so every line shares the same pad. Each row is
  // padded to the full `width` with the background color so no terminal
  // default background ever shows through beside the logo.
  const halves = LOGO_LEFT.map((l, i) => displayWidth(l) + 1 + displayWidth(LOGO_RIGHT[i]));
  const blockW = Math.max(...halves);
  const pad = Math.max(0, Math.floor((width - blockW) / 2));
  const lines = [];
  for (let i = 0; i < LOGO_LEFT.length; i += 1) {
    const left = renderLogoLine(LOGO_LEFT[i], C.muted, false);
    const right = renderLogoLine(LOGO_RIGHT[i], C.text, true);
    // the row's own rendered width (marker glyphs are 1 column each); lines
    // narrower than the widest block row get extra right padding so every
    // row fills the full terminal width
    const rowW = halves[i];
    const rest = Math.max(0, width - pad - rowW);
    // every inter-part gap and the right padding carry the background color
    // (left/right end in RESET, so bare spaces would leak the terminal default)
    lines.push(
      bg(C.background) + " ".repeat(pad) +
      left + bg(C.background) + " " +
      right + bg(C.background) + " ".repeat(rest) + RESET,
    );
  }
  return lines;
}

/** Display width of a string (CJK chars count as 2). */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code === 0x09) { w += 4; continue; } // tab → 4 columns (consistent with wrap's expansion)
    // Zero-width characters: combining marks, variation selectors (FE0F
    // makes an emoji sequence render as one wide glyph — never count it),
    // ZWJ (200D), zero-width spaces, word joiners, and the BOM.
    const zero =
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2060 && code <= 0x206f) ||
      (code >= 0xfe00 && code <= 0xfe2f) ||
      code === 0xfeff ||
      code === 0x00ad;
    if (zero) continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      // The whole emoji primary block renders two columns wide.
      (code >= 0x1f000 && code <= 0x1faff) ||
      // In the ambiguous symbol ranges (231A–2BFF) only the code points with
      // an explicit emoji presentation render two columns (✅ ❌ ⚡ ☀ …);
      // text-presentation symbols there (✔ ✖ ⚠ ⚙ …) render one column.
      emojiPresentation(code);
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * Whether a code point in the ambiguous symbol ranges (231A–2BFF) renders
 * with emoji presentation (two columns) by default, per the Unicode
 * Emoji_Presentation property. Text-presentation siblings (✔ U+2714,
 * ✖ U+2716, ⚠ U+26A0, ⚙ U+2699, …) are one column — counting them wide
 * would under-run the row and push the side panel out of alignment.
 * @param code - the code point.
 * @returns true when the terminal renders it two columns wide.
 */
function emojiPresentation(code) {
  return code === 0x231a || code === 0x231b
    || (code >= 0x23e9 && code <= 0x23ec)
    || code === 0x23f0 || code === 0x23f3
    || (code >= 0x25fd && code <= 0x25fe)
    || (code >= 0x2614 && code <= 0x2615)
    || (code >= 0x2648 && code <= 0x2653)
    || code === 0x267f || code === 0x2693 || code === 0x26a1
    || (code >= 0x26aa && code <= 0x26ab)
    || (code >= 0x26bd && code <= 0x26be)
    || (code >= 0x26c4 && code <= 0x26c5)
    || code === 0x26ce || code === 0x26d4 || code === 0x26ea
    || (code >= 0x26f2 && code <= 0x26f3)
    || code === 0x26f5 || code === 0x26fa || code === 0x26fd
    || code === 0x2705
    || (code >= 0x270a && code <= 0x270b)
    || code === 0x2728 || code === 0x274c || code === 0x274e
    || (code >= 0x2753 && code <= 0x2755)
    || code === 0x2757
    || (code >= 0x2795 && code <= 0x2797)
    || code === 0x27b0 || code === 0x27bf
    || (code >= 0x2b1b && code <= 0x2b1c)
    || code === 0x2b50 || code === 0x2b55;
}

/** Word-wrap text to `width` display columns; returns lines. */
function wrap(text, width) {
  // Replace tab characters with 4 spaces so `displayWidth` and terminal
  // rendering agree on column positions — otherwise a tab counted as 1
  // column here would expand to 8+ columns in the terminal, making the
  // right-panel gray background bleed into the conversation area.
  // Strip carriage returns too — they would reset the terminal cursor to
  // column 0 mid-row and corrupt the frame layout.
  const clean = String(text ?? "").replace(/\t/g, "    ").replace(/\r/g, "");
  const out = [];
  for (const raw of clean.split("\n")) {
    let line = "";
    let lineW = 0;
    for (const word of raw.split(/(\s+)/)) {
      const w = displayWidth(word);
      if (word !== "" && w >= width) {
        // unbreakable token wider than a line (long URL / hash / minified
        // text / mixed CJK run): never leave a short stub line above it —
        // first top the current line up to full width with the token's head
        // (opencode/web: a line fills before it breaks), then hard-break the
        // remainder into width-bounded chunks so it never spills past the
        // column edge
        let rest = word;
        if (lineW > 0) {
          const room = width - lineW;
          let fill = "";
          let fillW = 0;
          for (const ch of rest) {
            const cw = displayWidth(ch);
            if (fillW + cw > room) break;
            fill += ch;
            fillW += cw;
          }
          if (fill !== "") {
            line += fill;
            lineW += fillW;
            rest = rest.slice(fill.length);
          }
          if (line !== "") out.push(line);
          line = "";
          lineW = 0;
        }
        while (rest !== "") {
          let chunk = "";
          let chunkW = 0;
          for (const ch of rest) {
            const cw = displayWidth(ch);
            if (chunkW + cw > width) break;
            chunk += ch;
            chunkW += cw;
          }
          if (chunk === "") chunk = rest[0]; // zero-width lead safety
          out.push(chunk);
          rest = rest.slice(chunk.length);
        }
        line = "";
        lineW = 0;
      } else {
        if (lineW + w > width && lineW > 0) {
          out.push(line);
          line = "";
          lineW = 0;
        }
        line += word;
        lineW += w;
      }
    }
    // keep blank source lines as blank rows, but never emit a trailing empty
    // row when the line ended on a hard-broken token
    if (line !== "" || raw === "") out.push(line);
  }
  return out;
}

/**
 * Paint one full-width row: `bgColor` fills the whole `width`, with colored
 * segments laid on top. Returns an ANSI string ending in RESET.
 */
function paintRow(bgColor, width, segments, padColor, reverse = false) {
  let out = bg(bgColor);
  let col = 0;
  for (const seg of segments) {
    const text = seg.text ?? "";
    const w = displayWidth(text);
    if (col + w > width) break;
    out += fg(seg.fg) + (seg.bold ? "\u001b[1m" : "") + (seg.italic ? "\u001b[3m" : "") + (reverse ? "\u001b[7m" : "") + text + (reverse ? "\u001b[27m" : "") + (seg.italic ? "\u001b[23m" : "") + (seg.bold ? "\u001b[22m" : "");
    col += w;
  }
  if (col < width) {
    out += fg(padColor ?? undefined) + (reverse ? "\u001b[7m" : "") + " ".repeat(width - col) + (reverse ? "\u001b[27m" : "");
  }
  return out + RESET;
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Compact token count, web parity: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
function fmtTokens(n) {
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1e3) return String(n);
  if (n < 1e6) return `${scaled(n / 1e3)}K`;
  return `${scaled(n / 1e6)}M`;
}

/** Compact duration, web parity: 45.2s under a minute, 2m42s from there on. */
function fmtDur(ms) {
  if (ms == null || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/**
 * Sum of the three disjoint prompt-side billing buckets — the web client's
 * `billedInputTokens` (uncached + cache-read + cache-write).
 */
function billedInputTokens(stats) {
  return (stats.inputTokens ?? 0) + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
}

/**
 * Cache-hit share of prompt-side input over the whole durable log — the web
 * client's `cacheHitPercent`: rounded integer percent of cache-read tokens in
 * the billed input, or "—" when nothing was billed.
 */
function fmtCacheHit(stats) {
  const denominator = billedInputTokens(stats);
  if (denominator <= 0) return "—";
  return `${Math.round(((stats.cacheReadTokens ?? 0) / denominator) * 100)}%`;
}

/**
 * Context occupancy, web parity (`contextOccupancy`): last provider-reported
 * prompt size over the recorded capacity, rounded percent clamped to 100.
 */
function fmtCtx(stats) {
  if (!stats.contextWindow || stats.contextWindow <= 0) return "";
  const used = stats.contextTokens ?? 0;
  const pct = Math.min(100, Math.round((used / stats.contextWindow) * 100));
  return `${fmtTokens(used)}/${fmtTokens(stats.contextWindow)} · ${pct}%`;
}

function truncate(text, max = 2000) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more chars)`;
}

// ── markdown preview ────────────────────────────────────────────────────────

/**
 * Split one inline markdown line into styled tokens: **bold**, *italic*,
 * `inline code`, and [links](url). Everything else stays plain text.
 */
function renderInline(text) {
  const tokens = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) tokens.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("*")) tokens.push({ text: tok.slice(1, -1), italic: true });
    else if (tok.startsWith("`")) tokens.push({ text: tok.slice(1, -1), code: true });
    else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      tokens.push({ text: link ? link[1] : tok, link: true });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens.map((t) => ({
    text: t.text,
    fg: t.code ? C.info : t.link ? C.secondary : C.text,
    bold: t.bold === true,
    italic: t.italic === true,
  }));
}

/** Wrap styled inline segments into lines of at most `width` display columns. */
function wrapSegments(segments, width) {
  const rows = [];
  let line = [];
  let lineW = 0;
  const flush = () => {
    if (line.length > 0) rows.push(line);
    line = [];
    lineW = 0;
  };
  const pushWord = (seg, word) => {
    const w = displayWidth(word);
    // hard-break unbreakable segment tokens wider than a line, preserving the
    // segment's style across the chunks (long inline code spans, URLs, …)
    if (word !== "" && w >= width) {
      if (lineW > 0) flush();
      let rest = word;
      while (rest !== "") {
        let chunk = "";
        let chunkW = 0;
        for (const ch of rest) {
          const cw = displayWidth(ch);
          if (chunkW + cw > width) break;
          chunk += ch;
          chunkW += cw;
        }
        if (chunk === "") chunk = rest[0]; // zero-width lead safety
        if (lineW > 0) flush();
        line = [{ ...seg, text: chunk }];
        lineW = chunkW;
        rest = rest.slice(chunk.length);
        if (chunkW >= width) flush();
      }
      return;
    }
    if (lineW + w > width && lineW > 0) flush();
    line.push({ ...seg, text: word });
    lineW += w;
  };
  for (const seg of segments) {
    for (const word of String(seg.text ?? "").split(/(\s+)/)) {
      if (word === "") continue;
      pushWord(seg, word);
    }
  }
  if (line.length > 0) rows.push(line);
  return rows;
}

/**
 * Render markdown text as conversation row specs (background + styled
 * segments): headings (bold), paragraphs with inline styles, fenced code
 * blocks on an element-background box, lists, blockquotes, horizontal rules.
 */
function renderMarkdown(text, width) {
  const rows = [];
  const pushRow = (bgColor, segments) => rows.push({ bg: bgColor, segments, text: segments.map((s) => s.text).join("") });
  /**
   * Push a prefixed inline line, wrapping the content across rows: the
   * prefix (e.g. "  · " for a list item) leads the first row; continuation
   * rows are indented to the content column so no line ever runs past the
   * conversation block's edge (long list items / quotes / headings).
   */
  const pushPrefixed = (prefixSegs, contentSegs) => {
    const prefixW = prefixSegs.reduce((sum, s) => sum + displayWidth(s.text), 0);
    const contentW = Math.max(8, width - 2 - prefixW);
    const lines = wrapSegments(contentSegs, contentW);
    if (lines.length === 0) {
      pushRow(C.background, prefixSegs);
      return;
    }
    lines.forEach((line, i) => {
      if (i === 0) pushRow(C.background, [...prefixSegs, ...line]);
      else pushRow(C.background, [{ text: " ".repeat(prefixW), fg: C.text }, ...line]);
    });
  };
  const lines = String(text ?? "").split("\n");
  let inCode = false;
  for (const raw of lines) {
    if (inCode) {
      if (/^\s*```\s*$/.test(raw)) {
        inCode = false;
      } else {
        // wrap long code lines so they never run past the block edge
        // (a long token would otherwise be clipped mid-way by paintRow)
        for (const line of wrap(raw, width - 2)) {
          pushRow(C.backgroundElement, [{ text: ` ${line}`, fg: C.text }]);
        }
      }
      continue;
    }
    const fence = raw.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      inCode = true;
      if (fence[1] !== "") pushRow(C.backgroundElement, [{ text: `  ${fence[1]}`, fg: C.muted, italic: true }]);
      continue;
    }
    if (raw.trim() === "") {
      pushRow(C.background, []);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(raw)) {
      // horizontal rule renders as spacing — no divider line (opencode: the
      // markdown hr is blank space, never a ─ row)
      pushRow(C.background, []);
      pushRow(C.background, []);
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const deep = heading[1].length > 2;
      pushPrefixed(
        [{ text: "  ", fg: C.text }],
        renderInline(heading[2]).map((s) => ({ ...s, bold: true, fg: deep ? C.muted : s.fg })),
      );
      continue;
    }
    const quote = raw.match(/^>\s?(.*)$/);
    if (quote) {
      pushPrefixed(
        [{ text: "  │ ", fg: C.muted }],
        renderInline(quote[1]).map((s) => ({ ...s, italic: true, fg: C.muted })),
      );
      continue;
    }
    const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      pushPrefixed([{ text: "  · ", fg: C.muted }], renderInline(ul[1]));
      continue;
    }
    const ol = raw.match(/^\s*(\d+[.)])\s+(.*)$/);
    if (ol) {
      pushPrefixed([{ text: `  ${ol[1]} `, fg: C.muted }], renderInline(ol[2]));
      continue;
    }
    // plain paragraph: wrap the styled tokens across lines
    for (const line of wrapSegments(renderInline(raw), width - 2)) {
      pushRow(C.background, line.map((s, i) => (i === 0 ? { ...s, text: " " + s.text } : s)));
    }
  }
  return rows;
}

/** Truncate text to fit `width` display columns (ellipsis when cut). */
function fit(text, width) {
  const s = String(text ?? "");
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** Keep the LAST `maxW` display columns of text (drop the leading part). */
function tailFit(text, maxW) {
  const s = String(text ?? "");
  if (displayWidth(s) <= maxW) return s;
  let out = "";
  let w = 0;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const cw = displayWidth(s[i]);
    if (w + cw > maxW) break;
    out = s[i] + out;
    w += cw;
  }
  return out;
}

/**
 * Fuzzy command-name match (opencode-style): exact prefixes rank highest,
 * then ordered-subsequence matches; -1 means no match.
 * @param query - user input after the `/`, lowercased by caller.
 * @param name - candidate command name without the slash.
 * @returns a score >= 0 when matched (higher = better), -1 when not.
 */
function fuzzyScore(query, name) {
  const q = String(query ?? "").toLowerCase();
  const n = String(name ?? "").toLowerCase();
  if (q === "") return 0;
  if (n.startsWith(q)) return 1000 - n.length;
  let qi = 0;
  for (let ni = 0; ni < n.length && qi < q.length; ni += 1) {
    if (n[ni] === q[qi]) qi += 1;
  }
  if (qi < q.length) return -1;
  return 500 - (n.length - q.length);
}

// ── layout → rows ───────────────────────────────────────────────────────────

/**
 * One-line summary for a collapsed web_search card: the query from the JSON
 * arguments when available, otherwise the first line of the result.
 */
function toolSummary(item) {
  if (typeof item.arguments === "string" && item.arguments.trim() !== "") {
    try {
      const parsed = JSON.parse(item.arguments);
      if (typeof parsed?.query === "string" && parsed.query.trim() !== "") return parsed.query.trim();
    } catch {
      /* fall through to the result line */
    }
  }
  return String(item.result ?? "").split("\n")[0]?.trim() ?? "";
}

/**
 * Build the conversation rows (each row is a paintRow spec). Think blocks are
 * collapsed by default: a one-line header with a chevron + summary; clicking
 * the header toggles it open. `expandedThink` is a Set of expanded item ids;
 * the returned array carries a `thinkRows` Map (conv-row index → item id) for
 * click hit-testing.
 */
function conversationRows(items, width, showThinking, showFull, expandedThink = null) {
  const rows = [];
  const thinkRows = new Map();
  rows.thinkRows = thinkRows;
  // leading blank rows so the first message never sits flush against the
  // window's top edge (opencode keeps padding above the message list)
  rows.push({ bg: C.background, segments: [], text: "" });
  rows.push({ bg: C.background, segments: [], text: "" });
  // every row also records its plain visible text — used by the drag-select
  // copy; UI-only rows (stopped / thought markers) are excluded from drag
  // copies via `copyable: false`
  const push = (bgColor, segments, text, copyable = true) =>
    rows.push({ bg: bgColor, segments, text: text ?? segments.map((s) => s.text).join(""), copyable });
  const pushText = (text, fgColor, bgColor) => {
    for (const line of wrap(text, width - 2)) {
      // Trim trailing whitespace so that extra spaces at the end of a line
      // never push the column past the measured width — which would let the
      // right panel's gray background bleed into the conversation block via
      // the \x1b[K erase at the end of each row.
      const trimmed = line.replace(/\s+$/, "");
      push(bgColor, [{ text: " " + trimmed, fg: fgColor }]);
    }
  };
  items.forEach((item, index) => {
    if (index > 0) rows.push({ bg: C.background, segments: [] });
    if (item.kind === "user") {
      if (item.sourceKind !== undefined && item.sourceKind !== "user") {
        // plugin-injected context (runtime-context snapshot, recalls, …):
        // one-line collapsed disclosure with a summary, click to expand —
        // the web's ContextInjectionRow
        const expanded = expandedThink?.has(item.id) ?? false;
        thinkRows.set(rows.length, item.id);
        if (expanded) {
          push(C.background, [
            { text: "  ▾ ", fg: C.subtle },
            { text: "context", fg: C.subtle, bold: true },
          ]);
          pushText(item.text, C.muted, C.background);
        } else {
          const firstLine = String(item.text ?? "").split("\n")[0] ?? "";
          const summary = fit(firstLine, Math.max(10, width - 22));
          push(C.background, [
            { text: "  ▸ ", fg: C.subtle },
            { text: "context", fg: C.subtle, bold: true },
            { text: `  ${summary}`, fg: C.subtle },
          ]);
        }
      } else {
        // left-aligned user message with a left accent bar (opencode style —
        // all messages are left-aligned; no right-aligned bubble which would
        // give each wrapped line a different leading offset). The bar ▌ sits
        // one column from the left edge so text never touches the margin.
        // top padding inside the user-message panel block (makes the block
        // visually taller and more distinct from surrounding messages). The
        // accent bar runs through padding rows too so the left border is
        // continuous from top to bottom.
        rows.push({ bg: C.backgroundPanel, segments: [{ text: "▌ ", fg: C.accent }] });
        const lines = wrap(item.text, width - 2);
        lines.forEach((line) => {
          if (line === "") {
            rows.push({ bg: C.backgroundPanel, segments: [] });
          } else {
            rows.push({
              bg: C.backgroundPanel,
              segments: [
                { text: "▌ ", fg: C.accent },
                { text: line, fg: C.text },
              ],
              text: line,
            });
          }
        });
        // bottom padding inside the user-message panel block
        rows.push({ bg: C.backgroundPanel, segments: [{ text: "▌ ", fg: C.accent }] });
      }
    } else if (item.kind === "assistant") {
      const thinkShown = item.reasoning && showThinking;
      const thinkExpanded = thinkShown && (expandedThink?.has(item.id) ?? false);
      if (thinkShown) {
        // reasoning renders as an opencode-style think line — a plain text
        // row in the warning color (no gray box), "+ Thought: <title>"
        // collapsed / "− Thought: <title>" expanded, reasoning indented
        // below. Click the header row to toggle.
        const firstLine = String(item.reasoning ?? "").split("\n")[0] ?? "";
        const title = fit(firstLine, Math.max(10, width - 24));
        thinkRows.set(rows.length, item.id);
        push(C.background, [
          { text: `  ${thinkExpanded ? "−" : "+"} `, fg: C.warning },
          { text: "Thought", fg: C.warning, bold: true },
          ...(title !== "" ? [{ text: `: ${title}`, fg: C.warning }] : []),
        ]);
        if (thinkExpanded) {
          // 1-row part gap (opencode marginTop-between-parts): header →
          // reasoning body
          push(C.background, []);
          pushText(item.reasoning, C.muted, C.background);
        }
      } else if (item.reasoning) {
        push(C.background, [{ text: "  · thought", fg: C.subtle }], "", false);
      }
      // markdown preview: styled headings / bold / italic / code / lists
      if (item.text) {
        // 1-row part gap so a think block and the message text are distinct
        // blocks with the same spacing as every other pair of messages
        // (opencode gives each part a uniform marginTop; the web keeps a
        // uniform 16px rhythm)
        if (thinkShown) push(C.background, []);
        for (const mdRow of renderMarkdown(item.text, width - 2)) {
          rows.push(mdRow);
        }
      }
      // interrupted response marker (web "message.stopped")
      if (item.interrupted) push(C.background, [{ text: "  · stopped", fg: C.subtle }], "", false);
      // No per-message copy icon: selecting text with the mouse drags a
      // selection and auto-copies it (opencode behavior), with a "copied"
      // toast at the top-right of the conversation block.
    } else if (item.kind === "tool") {
      const st =
        item.status === "running"
          ? { glyph: "⣾", fg: C.accent, label: "running" }
          : item.status === "stopped"
            ? { glyph: "■", fg: C.muted, label: "stopped" }
            : item.isError
              ? { glyph: "✖", fg: C.error, label: "error" }
              : { glyph: "✔", fg: C.success, label: "done" };
      // Tool calls render as a single plain summary line on the message
      // background — chevron + state glyph + tool name + · status + summary —
      // mirroring the web's ToolRow and opencode's InlineTool: no box, so a
      // tool call reads as its own distinct row between messages and the
      // inter-message spacing stays uniform. Click the row to expand/collapse
      // (args + result below).
      const collapsible = true;
      const collapsed = collapsible && !(expandedThink?.has(item.id) ?? false);
      if (collapsible) thinkRows.set(rows.length, item.id);
      if (collapsed) {
        const summary = toolSummary(item);
        push(C.background, [
          { text: `  ▸  ${st.glyph} `, fg: st.fg },
          { text: item.name, fg: C.text, bold: true },
          { text: ` · ${st.label}`, fg: C.muted },
          ...(summary ? [{ text: `  ${fit(summary, Math.max(10, width - 26))}`, fg: C.muted }] : []),
        ]);
      } else {
        push(C.background, [
          { text: `  ▾  ${st.glyph} `, fg: st.fg },
          { text: item.name, fg: C.text, bold: true },
          { text: ` · ${st.label}`, fg: C.muted },
        ]);
        const args = item.arguments ? (showFull ? item.arguments : truncate(item.arguments, 160)) : "";
        const result = item.result ? (showFull ? item.result : truncate(item.result, 400)) : "";
        if (args) pushText(args, C.muted, C.background);
        if (result) pushText(result, item.isError ? C.error : C.text, C.background);
      }
    } else if (item.kind === "turn-error") {
      // turn-level LLM failure (web TurnErrorItem parity), subtle
      push(C.background, [
        { text: "  ⚠ ", fg: C.error },
        { text: "turn error", fg: C.error, bold: true },
        ...(item.text ? [{ text: `  ${fit(item.text, Math.max(10, width - 26))}`, fg: C.muted }] : []),
      ]);
    } else if (item.kind === "turn-max-tokens") {
      // max-tokens turn end (web TurnMaxTokensItem parity), subtle
      push(C.background, [{ text: "  · max tokens reached", fg: C.warning }]);
    }
    // system items (command feedback like "Permission → read-only", model
    // switches, session resumes) are deliberately NOT rendered — the
    // conversation area shows only user messages and model messages
  });
  return rows;
}

/** Build the right-side stats panel rows (opencode sidebar, padding 2). */
function sidePanelRows(running, spinner, stats, width, title = "", queue = null, queueOpen = false) {
  if (width < 12) return [];
  const W = width;
  const line = (label, value) => ({ bg: C.backgroundPanel, segments: [{ text: `  ${label} `, fg: C.muted }, { text: value, fg: C.muted }] });
  const rows = [
    // top breathing room — the header never touches the window edge
    { bg: C.backgroundPanel, segments: [] },
    // the auto-summarized session title; while the model is thinking the
    // waiting spinner rides on the same header row (no "Guessing" text)
    ...(title !== "" || running
      ? [
          {
            bg: C.backgroundPanel,
            segments: [
              { text: "  ", fg: C.text },
              ...(running ? [{ text: `${spinner} `, fg: C.accent }] : []),
              { text: fit(title, Math.max(6, W - 4 - (running ? displayWidth(spinner) + 1 : 0))), fg: C.text },
            ],
          },
        ]
      : []),
    // spacing instead of a divider line under the header block
    { bg: C.backgroundPanel, segments: [] },
  ];
  // Pending inbox (web QueueDock parity): a collapsed count header when
  // messages are queued; clicking it expands the list; finished messages are
  // spliced out by the agent, so they vanish on the next snapshot. Shown only
  // while something is pending.
  if (Array.isArray(queue) && queue.length > 0) {
    rows.push({
      bg: C.backgroundPanel,
      queueHeader: true,
      segments: [
        { text: "  ", fg: C.text },
        { text: `${queue.length} queued`, fg: C.text, bold: true },
        { text: queueOpen ? "  −" : "  +", fg: C.muted },
      ],
    });
    if (queueOpen) {
      for (const item of queue) {
        rows.push({
          bg: C.backgroundPanel,
          segments: [{ text: `     ${fit(String(item.text ?? ""), Math.max(8, W - 11))}`, fg: C.muted }],
        });
      }
    }
    rows.push({ bg: C.backgroundPanel, segments: [] });
  }
  // Row visibility follows the web client's stats groups: durations only when
  // nonzero, the cache-hit/token block only once anything was billed.
  const billed = billedInputTokens(stats);
  if (stats.llmMs > 0) rows.push(line("LLM     ", fmtDur(stats.llmMs)));
  if (stats.toolMs > 0) rows.push(line("工具调用", fmtDur(stats.toolMs)));
  if (billed > 0 || stats.outputTokens > 0) {
    if (billed > 0) rows.push(line("缓存命中", fmtCacheHit(stats)));
    rows.push(line("输入    ", `${fmtTokens(billed)} tok`));
    rows.push(line("输出    ", `${fmtTokens(stats.outputTokens ?? 0)} tok`));
  }
  const ctx = fmtCtx(stats);
  if (ctx !== "") rows.push(line("ctx     ", ctx));
  return rows;
}

// ── the renderer ────────────────────────────────────────────────────────────

/**
 * Mount the full-screen UI for a controller.
 * @param controller the AgentController driving the session.
 * @param onExit called after the UI tears down.
 */
export function renderTui(controller, onExit, _stdout, _stdin) {
  const stdout = _stdout ?? process.stdout;
  const stdin = _stdin ?? process.stdin;

  // Without a real terminal there is nothing to paint: fall back to a plain
  // line and exit instead of streaming ANSI frames forever.
  if (!_stdout && !stdout.isTTY) {
    process.stderr.write("deepcode: terminal UI requires a TTY (run inside a terminal)\n");
    onExit?.();
    return { quit: () => {} };
  }

  // Read the REAL terminal size via ioctl (TIOCGWINSZ). Unlike
  // `stdout.columns`/`stdout.rows` — which Node updates only when SIGWINCH
  // arrives — this reflects the actual window size on every call, so a
  // resize that misses the signal still gets repainted at the right size
  // (no stale-width frames that leak the terminal's default background).
  const liveSize = () => {
    try {
      if (typeof stdout.getWindowSize === "function") {
        const [w, h] = stdout.getWindowSize();
        if (Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0) {
          return { cols: w, rows: h };
        }
      }
    } catch {
      /* fall through to the cached values */
    }
    return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
  };

  let columns = liveSize().cols;
  let rows = liveSize().rows;

  let input = "";
  // insertion point inside `input` (code units); the block cursor renders
  // here instead of always at the end — ←/→ move it, typing/backspace edit at
  // it (multi-line aware via the per-line render window)
  let cursor = 0;
  let items = [];
  let status = "idle";
  let stats = {};
  // pending inbox (agent.queue): filled by controller snapshots, rendered as
  // a collapsed section in the right info panel; completed items drop off
  let queue = [];
  // expansion state of the queue section (collapsed by default, web parity)
  let queueOpen = false;
  let picker = null;
  // scroll offset of the picker's option window (fixed height, scrollable)
  let pickerScroll = 0;
  let approval = null;
  let questions = null;
  // option cursor inside the pending question dialog (↑/↓ move it; enter
  // resolves the selected option) and its scroll window for long option lists
  let qIdx = 0;
  let qScroll = 0;
  let showThinking = true;
  let showFull = false;
  let frame = 0;
  let cmdIdx = 0;
  let running = true;
  let dirty = true;
  let firstFrame = true;
  // size the last paint actually rendered at (used to detect mid-drag size
  // changes that arrive without a resize event between paints)
  let paintedCols = -1;
  let paintedRows = -1;
  // custom block cursor drawn at the end of the input text (blinks via the
  // spinner timer); the terminal's own cursor stays hidden because many
  // terminals render it invisibly against the gray input background
  let cursorOn = true;
  // plan/goal agent mode toggled with Tab (replaces /plan and /goal commands);
  // each mode has its own accent color used by the prompt box left border
  let tuiMode = "plan";
  // mouse capture state: on while the input is empty (so clicks/drags do
  // nothing), off while text is present (so the terminal's native selection
  // lets the user drag-select the typed text to copy it)
  let mouseCapture = null;
  // conversation scroll offset: 0 = pinned to the bottom (latest); >0 = scrolled
  // up by that many conversation rows (mouse wheel / scrollbar thumb)
  let scrollOffset = 0;
  // think blocks are collapsed by default; clicking a think header toggles it
  // (keyed by the transcript item's stable id)
  let expandedThink = new Set();
  // session picker pagination state ({ all, loaded, loading }) — pages of
  // SESSION_PAGE_SIZE are loaded on demand as the cursor approaches the end
  let sessionPage = null;
  // the full cheap session list, restored when a search query is cleared
  let sessionListAll = [];
  // full-text session search (web parity: host SQLite FTS via sessionQuery).
  // null = list mode; otherwise { query, items, hasMore, searching }.
  let sessionSearch = null;
  let searchTimer = null;
  // @ file-mention picker state (uses the shared `picker` slot, title
  // "Select file"); the mention query is derived from the input's `@` token
  let mentionTimer = null;

  /**
   * Detect a valid `@` mention token at the end of the draft: `@` at the
   * start or after whitespace (word boundary), followed by the query up to
   * the next whitespace or `@` (web trigger rule).
   * @returns `{ start, end, query }` token span or null.
   */
  function matchMention(text) {
    const m = String(text).match(/(^|\s)@([^\s@]*)$/);
    if (m === null) return null;
    return { start: m.index + m[1].length, end: text.length, query: m[2] };
  }

  /** Open, refresh, or close the @ file-mention picker from the input state. */
    function updateMention() {
    const mt = matchMention(input);
    if (mt !== null && !input.startsWith("/")) {
      if (picker === null) {
        picker = {
          kind: "file",
          title: "Select file",
          options: [],
          loading: false,
                onResolve: (opt) => {
          const tok = matchMention(input);
          if (tok === null) return;
          input = input.slice(0, tok.start) + "@" + String(opt.value) + input.slice(tok.end);
          cursor = tok.start + 1 + String(opt.value).length;
          if (mentionTimer !== null) {
            clearTimeout(mentionTimer);
            mentionTimer = null;
          }
          cmdIdx = 0;
          paint();
        },onCancel: () => {
            // keep the typed `@...` text; the user may continue typing or delete it
          },
        };
        cmdIdx = 0;
        pickerScroll = 0;
      }
      // Picker already open or just opened — re-schedule the search so the
      // results list updates as the user types more after the @.
      scheduleMentionSearch();
      paint();
    } else if (mt === null && picker !== null && picker.kind === "file") {
      picker = null;
      if (mentionTimer !== null) {
        clearTimeout(mentionTimer);
        mentionTimer = null;
      }
      paint();
    }
  }

  function scheduleMentionSearch() {
    if (mentionTimer !== null) clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => {
      mentionTimer = null;
      void runMentionSearch();
    }, 300);
  }

  /** Run the @ file search (the `glob` tool plugin) for the current token. */
  async function runMentionSearch() {
    if (picker === null || picker.title !== "Select file") return;
    const mt = matchMention(input);
    if (mt === null) return;
    picker.loading = true;
    paint();
    const { files } = await controller.searchFiles(mt.query);
    if (picker === null || picker.title !== "Select file") return; // stale
    picker.loading = false;
    picker.options = files.map((f) => {
            const lastSlash = f.lastIndexOf("/");
            const basename = lastSlash >= 0 ? f.slice(lastSlash + 1) : f;
            const dirpath = lastSlash >= 0 ? f.slice(0, lastSlash) : "";
            return { label: basename, detail: dirpath, value: f };
          });
    cmdIdx = 0;
    paint();
  }

  // AbortController of the current session-search query (web parity: every
  // keystroke supersedes the previous search, aborting its in-flight FTS +
  // reconcile instead of queueing behind it in the serialized host engine).
  let searchAbort = null;

  function scheduleSessionSearch() {
    if (searchTimer !== null) clearTimeout(searchTimer);
    // abort the superseded search; the sqlite engine observes the signal
    // between reconcile steps, so a stale keystroke's work stops immediately
    searchAbort?.abort();
    searchAbort = new AbortController();
    const signal = searchAbort.signal;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSessionSearch(signal);
    }, 300);
  }

  /** Run (or refresh) the full-text session search for the current query. */
  async function runSessionSearch(signal) {
    if (picker === null || picker.kind !== "session") return;
    if (sessionSearch === null) return;
    const q = sessionSearch.query.trim();
    if (q === "") {
      // empty query → back to the paginated list
      sessionSearch = null;
      picker.options = [];
      sessionPage = { all: sessionListAll, loaded: 0, loading: false };
      void loadSessionPage();
      return;
    }
    sessionSearch.searching = true;
    paint();
    if (signal !== undefined && signal.aborted) return;
    const result = await controller.searchSessions(q, signal);
    if (signal !== undefined && signal.aborted) return; // superseded mid-flight
    if (sessionSearch === null || sessionSearch.query.trim() !== q) return; // stale
    sessionSearch.searching = false;
    sessionSearch.items = result.items;
    sessionSearch.hasMore = result.hasMore === true;
    // Render immediately from the warm title cache + FTS snippets (web parity:
    // search rows show the store title and the snippet; nothing blocks on
    // log reads). Missing titles enrich in the background below.
    const records = result.items.map((it) => ({ id: String(it.sessionId), title: "" }));
    picker.options = result.items.map((it, i) => ({
      label: `${controller.titleFor(String(it.sessionId)) || String(it.sessionId).slice(0, 20)}  ${it.snippet ?? ""}`,
      value: { id: String(it.sessionId), snippet: it.snippet ?? "" },
    }));
    cmdIdx = 0;
    paint();
    // Background title enrichment: fills the cache and repaints rows when it
    // settles, never delaying the search result render itself.
    if (records.length > 0) {
      void controller.enrichTitles(records, signal).then((titled) => {
        if (signal !== undefined && signal.aborted) return;
        if (sessionSearch === null || sessionSearch.query.trim() !== q) return; // stale
        picker.options = result.items.map((it, i) => ({
          label: `${titled[i]?.title || controller.titleFor(String(it.sessionId)) || String(it.sessionId).slice(0, 20)}  ${it.snippet ?? ""}`,
          value: { id: String(it.sessionId), snippet: it.snippet ?? "" },
        }));
        paint();
      });
    }
  }

  /**
   * Paste the system clipboard into the active input surface: the session
   * picker's search box when it is open, otherwise the message input.
   * Triggered by right-click and by the platform paste shortcut.
   */
  function pasteClipboard() {
    readClipboard((text) => {
      if (text === "" || text == null) return;
      if (picker !== null && picker.kind === "session") {
        if (sessionSearch === null) sessionSearch = { query: "", items: [], hasMore: false, searching: false };
        sessionSearch.query += text;
        cmdIdx = 0;
        scheduleSessionSearch();
        paint();
      } else if (picker !== null && picker.kind === "provider-form") {
        picker.fields[picker.fieldIdx].value += text;
        paint();
      } else {
        input = input.slice(0, cursor) + text + input.slice(cursor);
        cursor += text.length;
        if (input.startsWith("/")) cmdIdx = 0;
        updateMention();
        paint();
      }
    });
  }

  /**
   * Open the provider configuration form (opencode dialog style, field by
   * field): route, display name, api protocol, base url, api key env, api key
   * (stored via the credentials plugin), and models. Enter advances to the
   * next field; on the last field Enter saves through the plugins.
   * @param route - existing route to edit, or null for a new provider.
   */
  function openProviderForm(route) {
    const existing = route !== null && route !== undefined ? controller.readProviderProfile(route) : undefined;
    const fields = [
      { key: "route", label: "provider", value: existing !== undefined ? route : "", secret: false },
      { key: "displayName", label: "display name", value: existing?.displayName ?? "", secret: false },
      { key: "api", label: "api", value: existing?.api ?? "openai-completions", secret: false },
      { key: "baseURL", label: "base url", value: existing?.baseURL ?? "", secret: false },
      { key: "apiKeyEnv", label: "api key env", value: existing?.apiKeyEnv ?? "", secret: false },
      { key: "apiKey", label: "api key", value: "", secret: true },
      { key: "models", label: "models (comma separated)", value: (existing?.models ?? []).map((m) => m.id).join(", "), secret: false },
    ];
    pickerScroll = 0;
    picker = {
      kind: "provider-form",
      title: existing !== undefined ? `Provider · ${route}` : "Provider · add",
      fields,
      fieldIdx: 0,
      onResolve: async () => {
        const values = {};
        for (const f of fields) values[f.key] = f.value.trim();
        if (values.route === "") {
          controller.addSystem("Provider route must not be empty.");
          return;
        }
        const models = values.models
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m !== "");
        try {
          const saved = await controller.saveProvider({
            route: values.route,
            displayName: values.displayName || undefined,
            api: values.api || undefined,
            baseURL: values.baseURL || undefined,
            apiKeyEnv: values.apiKeyEnv || undefined,
            apiKey: values.apiKey || undefined,
            models,
          });
          controller.addSystem(`Provider "${saved}" configured — pick it from /model.`);
        } catch (error) {
          controller.addSystem(`Failed to save provider: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      onCancel: () => {},
    };
    cmdIdx = 0;
    paint();
  }

  /** Load the next session page into the open session picker (5 at a time). */
  async function loadSessionPage() {
    if (sessionPage === null || sessionPage.loading || sessionPage.loaded >= sessionPage.all.length) return;
    sessionPage.loading = true;
    paint(); // show the "loading" hint row
    // Pull pages until this slot is full of visible (non-blank) sessions or
    // the whole corpus is consumed. Blank stubs — sessions that never started
    // a turn (no conversation to switch to) — are skipped and never count
    // toward the page, so navigation never stalls on invisible stubs.
    const startLen = picker !== null && Array.isArray(picker.options) ? picker.options.length : 0;
    const target = startLen + SESSION_PAGE_SIZE;
    while (sessionPage !== null && sessionPage.loaded < sessionPage.all.length && (picker?.options?.length ?? target) < target) {
      const next = sessionPage.all.slice(sessionPage.loaded, sessionPage.loaded + SESSION_PAGE_SIZE);
      const titled = await controller.enrichTitles(next);
      if (sessionPage === null) return; // picker closed meanwhile
      sessionPage.loaded += next.length;
      if (picker !== null && picker.kind === "session" && typeof picker.buildOption === "function") {
        picker.options.push(...titled.filter((r) => r.blank !== true).map(picker.buildOption));
      }
    }
    sessionPage.loading = false;
    if (picker !== null && picker.kind === "session") {
      if (picker.options.length === 0 && sessionPage.loaded >= sessionPage.all.length) {
        // the whole workspace holds only conversation-less stubs — close the
        // empty picker instead of showing a useless "No results found" dialog
        picker = null;
        paint();
        return;
      }
      paint();
    }
  }
  // geometry the last paint rendered at, used for click hit-testing on think
  // headers (view body height, scroll start, think-row mapping)
  let clickBodyHeight = 0;
  let clickStart = 0;
  let clickThinkRows = null;
  let clickConv = null;
  // queue header click target in the right panel: its 1-based terminal row,
  // plus the 1-based first column of the panel (to route x to the panel)
  let clickQueueRow = -1;
  let clickPanelX = 0;
  // drag selection state (terminal 1-based coordinates, rows only): pressing
  // starts a drag, motion extends it, release copies the selected lines
  let dragStart = null;
  let selection = null;
  let dragMoved = false;
  // transient opencode-style toast ({ message, variant }) + its dismiss timer
  let toast = null;
  let toastTimer = null;

  let resizeRaf = null;
  const scheduleResizePaint = () => {
    // Merge rapid resize events (window drag) into one repaint per tick, but
    // repaint continuously while the size keeps changing so the screen tracks
    // the terminal instead of showing a stale frame with exposed background.
    if (resizeRaf !== null) return;
    resizeRaf = setTimeout(() => {
      resizeRaf = null;
      dirty = false;
      paint();
      const size = liveSize();
      if (columns !== size.cols || rows !== size.rows) {
        scheduleResizePaint();
      }
    }, 50);
  };
  const onResize = () => {
    const size = liveSize();
    columns = size.cols;
    rows = size.rows;
    firstFrame = true;
    scheduleResizePaint();
  };
  stdout.on("resize", onResize);

  const off = controller.subscribe((snapshot) => {
    items = snapshot.items;
    status = snapshot.status;
    stats = snapshot.stats ?? {};
    queue = snapshot.queue ?? [];
    if (queue.length === 0 && queueOpen) queueOpen = false; // web parity: empty queue re-collapses
    dirty = true;
  });

  controller.approvalHandler = (req) =>
    new Promise((resolve) => {
      approval = { req, resolve };
      dirty = true;
      paint();
    });
  controller.questionsHandler = (request) =>
    new Promise((resolve) => {
      questions = { request, resolve };
      qIdx = 0;
      qScroll = 0;
      dirty = true;
      paint();
    });

  // One fast ticker drives three clocks: (1) the running spinner on the panel
  // header row — a smooth ~15fps glyph spin (advancing one glyph per 530ms
  // read as frozen), (2) the blinking block cursor in the message
  // input / picker search / approval rows (~530ms period, one phase flip per
  // 8 ticks), and (3) the flush of controller-snapshot paints, so streaming
  // tokens land on screen at tick cadence instead of once per blink period.
  // While the agent is running the frame repaints every tick (spinner motion
  // + flowing text); idle frames repaint only on real dirt or a cursor phase
  // flip, so an idle session costs one paint per blink period.
  const TICK_MS = 66;
  const ticker = setInterval(() => {
    frame += 1;
    const nextCursor = Math.floor(frame / 8) % 2 === 0;
    const cursorChanged = nextCursor !== cursorOn;
    cursorOn = nextCursor;
    if (dirty || cursorChanged || status === "running") {
      dirty = false;
      paint();
    }
  }, TICK_MS);

  /**
   * Render the input row content (inside the prompt box, after the accent
   * bar): padding + text + blinking block cursor at the cursor column +
   * rest of the box. `cursorAt` is the cursor column within `lineText`
   * (-1 = this line has no cursor; the text is shown plain, truncated).
   */
  function renderInputContent(width, lineText, cursorAt = -1) {
    const boxW = Math.max(1, width - 3); // text columns (2 lead + 1 cursor)
    let visibleBefore = "";
    let visibleAfter = "";
    let showCursor = cursorAt >= 0;
    if (!showCursor) {
      visibleBefore = fit(String(lineText ?? ""), boxW);
    } else {
      const before = String(lineText ?? "").slice(0, cursorAt);
      const after = String(lineText ?? "").slice(cursorAt);
      // keep the cursor in view: window the before-part to the box width and
      // show as much of the after-part as still fits
      visibleBefore = tailFit(before, Math.max(1, boxW - 1));
      const bw = displayWidth(visibleBefore);
      visibleAfter = fit(after, Math.max(0, boxW - bw - 1));
    }
    let s = `${bg(C.backgroundElement)}  ${fg(C.text)}${visibleBefore}`;
    if (showCursor) {
      // white block cursor, reversed on the gray box background
      s += `${cursorOn ? `${bg(C.text)} ${RESET}${bg(C.backgroundElement)}` : " "}`;
      s += fg(C.text) + visibleAfter;
    }
    const used = 2 + displayWidth(visibleBefore) + (showCursor ? 1 + displayWidth(visibleAfter) : 0);
    s += `${bg(C.backgroundElement)}${" ".repeat(Math.max(0, width - used))}${RESET}`;
    return s;
  }

  /**
   * Enable/disable terminal mouse capture to match the input state. While the
   * input is empty, capture is ON so clicks and drags are swallowed (and our
   * onData ignores the sequences). Once the user types text, capture is turned
   * OFF so the terminal's native selection works — drag-select to copy.
   */
  function updateMouseMode() {
    // Drag capture (?1002) stays ON at all times so the app sees every
    // drag — the conversation block implements its own selection + auto-copy
    // (and the terminal's native selection is not used).
    if (mouseCapture === true) return;
    mouseCapture = true;
    stdout.write("\u001b[?1000h\u001b[?1002h\u001b[?1006h");
  }

  /**
   * Render the picker as a centered popup dialog (opencode dialog-select
   * style): bordered box with the title in the top border, a search row for
   * the session picker, the scrolling option list, and a hint row. Drawn as
   * an overlay over the last frame.
   */
  function renderPickerOverlay() {
    if (picker === null || picker.kind === "file") return "";
    const dialogW = Math.min(72, Math.max(30, columns - 8));
    const bodyBg = C.backgroundElement;
    const selBg = tint(C.backgroundElement, C.accent, 0.1);
    // content rows — opencode session-search style: a borderless elevated
    // panel; the title row leads, then the search input / options / hints
    const content = [];
    // top padding so the title does not touch the dialog's top edge
    content.push({ bg: bodyBg, segments: [] });
    content.push({ bg: bodyBg, segments: [{ text: `  ${picker.title}`, fg: C.text, bold: true }] });
    // breathing room between the title bar and the search input (opencode
    // dialog padding)
    content.push({ bg: bodyBg, segments: [] });
    if (picker.kind === "session" || picker.kind === "file" || picker.kind === "provider") {
      // search input — opencode dialog input: no icon, taller (query row +
      // underline row), peach block cursor (blinks with the frame timer)
      const q =
        picker.kind === "file"
          ? (matchMention(input)?.query ?? "")
          : picker.kind === "session"
            ? (sessionSearch?.query ?? "")
            : (picker.filter ?? "");
      const searching = picker.kind === "session" ? sessionSearch?.searching === true : picker.loading === true;
      content.push({
        bg: bodyBg,
        segments: [
          { text: "  ", fg: C.text },
          { text: q, fg: C.text, bold: true },
          { text: cursorOn ? "█" : " ", fg: C.accent },
          ...(searching ? [{ text: " …", fg: C.muted }] : []),
        ],
      });
      // spacing instead of a divider line under the search input
      content.push({ bg: bodyBg, segments: [] });
    }
    if (picker.kind === "provider-form") {
      // opencode-style provider form: one row per field, the active field
      // highlighted with the peach cursor at the end of its value
      picker.fields.forEach((f, i) => {
        const active = i === picker.fieldIdx;
        const val = f.secret && f.value !== "" ? "•".repeat(Math.min(12, f.value.length)) : f.value;
        content.push({
          bg: active ? selBg : bodyBg,
          segments: [
            { text: `${active ? " ›" : "  "} ${f.label}`, fg: active ? C.accent : C.muted, bold: active },
            { text: "  ", fg: C.muted },
            { text: val, fg: C.text },
            ...(active ? [{ text: cursorOn ? "█" : " ", fg: C.accent }] : []),
          ],
        });
      });
    }
    // keep the selection inside the fixed-height window while scrolling
    if (cmdIdx < pickerScroll) pickerScroll = cmdIdx;
    if (cmdIdx >= pickerScroll + PICKER_MAX_ROWS) pickerScroll = cmdIdx - PICKER_MAX_ROWS + 1;
    if (pickerScroll > 0) content.push({ bg: bodyBg, segments: [{ text: "  ↑ more", fg: C.muted }] });
    // provider list filters locally (opencode dialog-select fuzzy filter);
    // the provider form renders its fields above and has no option list
    const listOptions =
      picker.kind === "provider"
        ? picker.options.filter((opt) => {
            const needle = String(picker.filter ?? "").trim().toLowerCase();
            if (needle === "") return true;
            return String(opt.label).toLowerCase().includes(needle);
          })
        : picker.options;
    const visible = picker.kind === "provider-form" ? [] : listOptions.slice(pickerScroll, pickerScroll + PICKER_MAX_ROWS);
          visible.forEach((opt, i) => {
        const idx = pickerScroll + i;
        const sel = idx === cmdIdx;
        const segs = [
          { text: sel ? " \u203a " : "   ", fg: sel ? C.accent : C.text, bold: sel },
          { text: opt.label, fg: sel ? C.accent : C.text, bold: sel },
        ];
        if (opt.detail) {
          segs.push({ text: "  " + opt.detail, fg: C.muted });
        }
        content.push({
          bg: sel ? selBg : bodyBg,
          segments: segs,
        });
      });
    // opencode dialog-select empty state: plain muted "No results found" on
    // the panel background — never a highlighted (brown) row or a crash. Shown
    // when the search/filter settled but matched nothing (loading states get a
    // quiet blank instead so the dialog does not flicker "no results").
    if (picker.kind !== "provider-form" && listOptions.length === 0) {
      const busy =
        (picker.kind === "session" && (sessionSearch?.searching === true || (sessionPage !== null && sessionPage.loading))) ||
        picker.loading === true;
      if (!busy) {
        content.push({ bg: bodyBg, segments: [{ text: "  No results found", fg: C.muted }] });
      }
    }
    // one "↓ more" hint only — the scroll window and the session pagination/
    // search both imply more, but they must never stack into two lines
    let more = picker.kind !== "provider-form" && pickerScroll + PICKER_MAX_ROWS < listOptions.length;
    if (picker.kind === "session" && sessionSearch !== null) more = more || sessionSearch.hasMore;
    else if (picker.kind === "session" && sessionPage !== null) more = more || sessionPage.loaded < sessionPage.all.length;
    if (more) content.push({ bg: bodyBg, segments: [{ text: "  ↓ more", fg: C.muted }] });
    // bottom padding: every popup ends with a blank row so the last option /
    // hint text never sits flush against the dialog's bottom edge
    content.push({ bg: bodyBg, segments: [] });

    const dialogH = content.length;
    const top = Math.max(1, Math.floor((rows - dialogH) / 2));
    const left = Math.max(1, Math.floor((columns - dialogW) / 2));
    let out = "";
    // no erase-to-end-of-line: the row is exactly dialogW wide and the
    // conversation behind the popup stays visible around it (erasing would
    // paint the terminal default background — visible as red bars)
    content.forEach((r, i) => {
      out += `\u001b[${top + i + 1};${left + 1}H`;
      out += paintRow(r.bg, dialogW, r.segments ?? [], r.bg);
    });
    return out;
  }

  /** Paint the full frame. */
  function paint() {
    // Always render at the live terminal size (like opencode's renderer):
    // if the size changed since the previous PAINT (not since the last resize
    // event), force a full clear so no stale rows (leftover red background)
    // survive — e.g. a spinner tick firing mid-drag after the size moved.
    const live = liveSize();
    if (live.cols !== paintedCols || live.rows !== paintedRows) {
      columns = live.cols;
      rows = live.rows;
      firstFrame = true;
    }
    paintedCols = columns;
    paintedRows = rows;
    const W = columns;
    // opencode session: main column has paddingLeft/Right 2, sidebar 42 wide.
    // When the window is too narrow for the sidebar (opencode hides it into an
    // overlay on narrow screens), drop the panel and let the main fill the row.
    let panelW = PANEL_WIDTH;
    if (W - 4 - panelW < 24) panelW = 0;
    const convW = Math.max(20, W - 4 - panelW);

    const spinner = SPINNER[frame % SPINNER.length];

    // ── bottom rows (picker / approval / questions / input), shared ────────
    // Non-box rows (suggestions, pickers, approvals) float above the prompt;
    // the final two input rows are tagged `box: true` and become the prompt
    // box (opencode: backgroundElement + left accent border).
    const buildBottom = (width) => {
      const rows = [];
      // Non-file pickers render as a centered popup overlay (opencode dialog
      // style) — see renderPickerOverlay. File picker renders inline as
      // an extension of the prompt box (same as command suggestions).
      if (picker !== null && picker.kind !== "file") {
        // nothing here — the popup draws over the frame
      } else if (approval !== null) {
        rows.push({
          bg: C.backgroundPanel,
          segments: [
            { text: ` ⚠ Allow ${approval.req.toolName}?`, fg: C.warning, bold: true },
            ...(approval.req.reason ? [{ text: ` — ${approval.req.reason}`, fg: C.muted }] : []),
          ],
        });
        rows.push({ bg: C.backgroundPanel, segments: [{ text: "  [y] allow   [n] deny", fg: C.muted }] });
      } else {
        if (questions !== null) {
          // question dialog: the question text + every option as floating rows
          // ABOVE the prompt box (opencode dialog style) — the input box
          // below stays visible, so the dialog never covers the composer.
          // ↑/↓ move the selection, enter answers with the selected option,
          // esc skips.
          const q = questions.request.questions[0];
          const qtext = typeof q?.question === "string" ? q.question : "";
          const opts = Array.isArray(q?.options) ? q.options : [];
          const selected = Math.min(Math.max(qIdx, 0), Math.max(opts.length - 1, 0));
          // keep the selection inside the fixed-height option window
          if (selected < qScroll) qScroll = selected;
          if (selected >= qScroll + PICKER_MAX_ROWS) qScroll = selected - PICKER_MAX_ROWS + 1;
          const visible = opts.slice(qScroll, qScroll + PICKER_MAX_ROWS);
          rows.push({
            bg: C.backgroundPanel,
            segments: [
              { text: " ⚠ ", fg: C.warning },
              { text: fit(qtext, Math.max(12, width - 8)), fg: C.text, bold: true },
            ],
          });
          if (qScroll > 0) rows.push({ bg: C.backgroundPanel, segments: [{ text: "  ↑ more", fg: C.muted }] });
          if (visible.length === 0) {
            // no options: enter answers with an empty selection
            rows.push({ bg: C.backgroundPanel, segments: [{ text: "  (no options — enter to answer, esc to skip)", fg: C.muted }] });
          }
          visible.forEach((o, i) => {
            const idx = qScroll + i;
            const active = idx === selected;
            rows.push({
              bg: active ? tint(C.backgroundElement, C.accent, 0.12) : C.backgroundPanel,
              segments: [
                { text: `${active ? "  ›" : "   "} ${typeof o?.label === "string" ? o.label : ""}`, fg: active ? C.accent : C.text, bold: active },
              ],
            });
          });
          if (qScroll + PICKER_MAX_ROWS < opts.length) rows.push({ bg: C.backgroundPanel, segments: [{ text: "  ↓ more", fg: C.muted }] });
          rows.push({ bg: C.backgroundPanel, segments: [{ text: "  ↑↓ 选择 · enter 确认 · esc 跳过", fg: C.muted }] });
        }
        // ── inline file picker (opencode-style extension of the prompt box) ──
        if (picker !== null && picker.kind === "file") {
          const q = matchMention(input)?.query ?? "";
          if (q !== "" || picker.options.length > 0 || picker.loading) {
            // The @ query is already visible in the input box below, so no
            // separate query row is needed — options display directly.
            // visible options
            const listOptions = picker.options;
            const pickerScrollAdj = Math.max(0, Math.min(cmdIdx, Math.max(0, listOptions.length - PICKER_MAX_ROWS)));
            const visible = listOptions.slice(pickerScrollAdj, pickerScrollAdj + PICKER_MAX_ROWS);
            if (pickerScrollAdj > 0) rows.push({ bg: C.backgroundPanel, panel: true, segments: [{ text: "   ↑ more", fg: C.muted }] });
            visible.forEach((opt, i) => {
              const idx = pickerScrollAdj + i;
              const sel = idx === cmdIdx;
              const segs = [
                { text: sel ? " › " : "   ", fg: sel ? C.accent : C.text, bold: sel },
                { text: opt.label, fg: sel ? C.accent : C.text, bold: sel },
              ];
              if (opt.detail) segs.push({ text: "  " + opt.detail, fg: C.muted });
              rows.push({
                bg: sel ? tint(C.backgroundElement, C.accent, 0.12) : C.backgroundPanel,
                panel: true,
                segments: segs,
              });
            });
            if (visible.length === 0 && !picker.loading) {
              rows.push({ bg: C.backgroundPanel, panel: true, segments: [{ text: "  No results found", fg: C.muted }] });
            }
            if (pickerScrollAdj + PICKER_MAX_ROWS < listOptions.length) {
              rows.push({ bg: C.backgroundPanel, panel: true, segments: [{ text: "   ↓ more", fg: C.muted }] });
            }
          }
        }
        if (input.startsWith("/") && cmdIdx >= 0) {
          // fuzzy-matched commands only, rendered as an opencode-style panel:
          // backgroundPanel block with the selected row highlighted on
          // backgroundElement (see opencode ui/dialog-select.tsx).
          // Only the first word (the command name) is matched; anything after
          // a space is the command's arguments and does not affect the panel.
          const space = input.indexOf(" ");
          const namePart = (space === -1 ? input : input.slice(0, space)).slice(1);
          const matches = matchedCommands(namePart);
          if (matches.length === 0) {
            rows.push({ bg: C.backgroundPanel, panel: true, segments: [{ text: "  no matching command", fg: C.muted }] });
          } else {
            matches.forEach((c, i) =>
              rows.push({
                bg: i === cmdIdx ? C.backgroundElement : C.backgroundPanel,
                panel: true,
                segments: [
                  { text: `${i === cmdIdx ? " ›" : "  "} ${c.id}`, fg: i === cmdIdx ? C.accent : C.text, bold: i === cmdIdx },
                  { text: `  ${c.hint}`, fg: C.muted },
                ],
              }),
            );
          }
        }
        // opencode prompt box: paddingTop spacer, textarea, gap, meta row,
        // then a bottom border row (left accent bar + element-colored line).
        // The input row carries no "›" prefix — the terminal's own blinking
        // cursor is placed at the end of the text by the renderer.
        rows.push({ bg: C.backgroundElement, box: true, segments: [{ text: "  ", fg: C.muted }] });
        // multi-line input: one box row per line (Ctrl+Enter inserts a line
        // break), capped at MAX_INPUT_LINES — the window scrolls so the line
        // holding the cursor is always the bottom one, and the block cursor
        // renders at the cursor column within that line
        const inputLines = input.split("\n");
        // flat index → line index of the cursor
        let cursorLine = inputLines.length - 1;
        let flat = 0;
        for (let k = 0; k < inputLines.length; k += 1) {
          if (cursor <= flat + inputLines[k].length) {
            cursorLine = k;
            break;
          }
          flat += inputLines[k].length + 1; // +1 for the \n separator
        }
        const winStart = Math.max(0, Math.min(cursorLine, inputLines.length - MAX_INPUT_LINES));
        const shownLines = inputLines.slice(winStart, winStart + MAX_INPUT_LINES);
        let lineStart = 0;
        for (let k = 0; k < winStart; k += 1) lineStart += inputLines[k].length + 1;
        shownLines.forEach((line, i) => {
          const at = winStart + i === cursorLine ? Math.max(0, Math.min(cursor - lineStart, line.length)) : -1;
          // wrap the line so a long single line auto-wraps into multiple box
          // rows instead of being truncated with "…" (opencode / web parity:
          // the textarea wraps freely)
          const wl = wrap(line, width - 4);
          let charOfs = 0;
          wl.forEach((chunk, ci) => {
            const isLast = i === shownLines.length - 1 && ci === wl.length - 1;
            let cur = -1;
            if (winStart + i === cursorLine && at >= 0) {
              // find which wrapped chunk contains the cursor character
              if (at >= charOfs && at <= charOfs + chunk.length) {
                cur = at - charOfs;
              }
            }
            rows.push({
              bg: C.backgroundElement,
              box: true,
              inputRow: isLast,
              line: chunk,
              cursorAt: cur,
              segments: [{ text: `  ${chunk}`, fg: C.text }],
            });
            charOfs += chunk.length;
          });
          lineStart += line.length + 1;
        });
        rows.push({ bg: C.backgroundElement, box: true, segments: [{ text: "  ", fg: C.muted }] });
        // opencode meta row: the agent mode (plan/goal) first in its mode
        // color (plan peach, goal red), then the model name in white —
        // each part separated by a "·" dot, uniformly
        const modeText = tuiMode;
        const modeFg = MODE_COLORS[tuiMode] ?? C.accent;
        const modelTxt = fit(controller.modelLabel, Math.max(8, width - 40));
        const metaRest = fit(`${controller.effortLabel} · ${controller.permissionLabel}`, Math.max(8, width - displayWidth(modelTxt) - displayWidth(modeText) - 12));
        rows.push({
          bg: C.backgroundElement,
          box: true,
          segments: [
            { text: "  ", fg: C.muted },
            { text: modeText, fg: modeFg, bold: true },
            { text: " · ", fg: C.muted },
            { text: modelTxt, fg: C.text },
            { text: " · ", fg: C.muted },
            { text: metaRest, fg: C.muted },
          ],
        });
        rows.push({ bg: C.backgroundElement, boxBottom: true, segments: [] });
      }
      return rows;
    };

    // ── empty state: opencode home — centered logo + centered prompt ───────
    if (items.length === 0) {
      const promptW = Math.min(PROMPT_MAX_WIDTH, W - 4);
      const promptLeft = Math.floor((W - promptW) / 2);
      const bottom = buildBottom(promptW);
      const boxRows = bottom.filter((b) => b.box || b.boxBottom);
      const floatRows = bottom.filter((b) => !b.box && !b.boxBottom);
      // logo centers on the full screen width (same center as the prompt);
      // each row is already padded to `W` with the background color so the
      // terminal default background never shows beside the logo
      const logoLines = renderLogo(W);
      // opencode home vertical stack: flexGrow spacer, logo, gap(3),
      // floating rows (slash suggestions/pickers), prompt(paddingTop 1),
      // dialog footer (workspace dir left, "tab agents" right), flexGrow
      // spacer. The +2 shifts the stack slightly downward (opencode home: the
      // dialog sits a touch below vertical center).
      const stackH = logoLines.length + 3 + floatRows.length + 1 + boxRows.length + 1;
      const topPad = Math.max(0, Math.floor((rows - stackH - 2) / 2) + 2);
      let out = firstFrame ? "\u001b[2J\u001b[3J\u001b[H" : "\u001b[H";
      firstFrame = false;
      let floatIdx = 0;
      let boxIdx = 0;
      let footerDone = false;
      // floating rows are centered at the same offset as the prompt box so
      // the slash suggestions sit directly above the input, not at the left
      const floatRow = (f) => {
        const content = paintRow(f.bg ?? C.background, promptW, f.segments ?? [], f.bg ?? C.background);
        return bg(C.background) + " ".repeat(promptLeft) + content + bg(C.background) + " ".repeat(W - promptLeft - promptW) + RESET;
      };
      for (let i = 0; i < rows; i += 1) {
        let row;
        const afterTop = i - topPad;
        if (afterTop >= 0 && afterTop < logoLines.length) {
          row = logoLines[afterTop];
        } else if (afterTop >= logoLines.length && afterTop < logoLines.length + 3) {
          // gap between the logo and the dialog
          row = paintRow(C.background, W, []);
        } else if (afterTop >= logoLines.length + 3 && afterTop < logoLines.length + 3 + floatRows.length) {
          const f = floatRows[floatIdx];
          floatIdx += 1;
          row = floatRow(f);
        } else if (afterTop >= logoLines.length + 3 + floatRows.length && afterTop < logoLines.length + 3 + floatRows.length + boxRows.length) {
          const b = boxRows[boxIdx];
          boxIdx += 1;
          const isBottom = b.boxBottom === true;
          // half-width accent bar on the prompt box: ▌ paints the left half
          // in accent; the right half is the element background, so the bar
          // reads as a thin accent line against the box
          const bar = fg(MODE_COLORS[tuiMode] ?? C.accent) + bg(C.backgroundElement) + "▌" + RESET + bg(C.background);
          if (isBottom) {
            // opencode bottom border: left bar + full element-colored line.
            // A solid background fill avoids the ▀ glyph's lower-half
            // leaking the terminal default background (which may be red)
            // and any full-block font rendering that would look too wide.
            const line = bg(C.backgroundElement) + " ".repeat(promptW - 1) + RESET;
            row = bg(C.background) + " ".repeat(promptLeft) + bar + line + bg(C.background) + " ".repeat(W - promptLeft - promptW) + RESET;
          } else if (b.inputRow) {
            const box = renderInputContent(promptW - 1, b.line, b.cursorAt ?? -1);
            row = bg(C.background) + " ".repeat(promptLeft) + bar + box + bg(C.background) + " ".repeat(W - promptLeft - promptW) + RESET;
          } else {
            const box = paintRow(C.backgroundElement, promptW - 1, b.segments ?? [], C.backgroundElement);
            row = bg(C.background) + " ".repeat(promptLeft) + bar + box + bg(C.background) + " ".repeat(W - promptLeft - promptW) + RESET;
          }
        } else if (afterTop >= logoLines.length + 3 + floatRows.length + boxRows.length && !footerDone) {
          // dialog footer (opencode home footer): workspace directory at the
          // bottom-left in the muted operation-info style, "tab agents" at the
          // bottom-right — directly below the dialog, exactly dialog-wide
          // (never exceeding the prompt box width) and every cell on the page
          // background so no terminal-default (red) shows between the two
          footerDone = true;
          const dir = fit(controller.cwd || process.cwd(), Math.max(10, promptW - 26));
          const left = `  ${dir}`;
          const leftW = displayWidth(left);
          const hintW = displayWidth("tab agents");
          const pad = Math.max(1, promptW - leftW - hintW);
          const footer = fg(C.muted) + left + " ".repeat(pad) + fg(C.text) + "tab" + fg(C.muted) + " agents";
          row = bg(C.background) + " ".repeat(promptLeft) + footer + bg(C.background) + " ".repeat(W - promptLeft - promptW) + RESET;
        } else {
          row = paintRow(C.background, W, []);
        }
        out += row;
        // erase to end of line: set bg first so erase uses panel color, not
        // terminal default (red); reset after erase
        out += bg(C.background) + "\x1b[K" + RESET;
        if (i < rows - 1) out += "\r\n";
        else out += "\x1b[J";
      }
      if (picker !== null) out += renderPickerOverlay();
      out += renderToastOverlay(promptW);
      stdout.write(out);
      updateMouseMode();
      return;
    }

    // ── conversation state: opencode session — padded main + sidebar ───────
    const conv = conversationRows(items, convW, showThinking, showFull, expandedThink);
    const panel = sidePanelRows(
      status === "running",
      spinner,
      stats,
      panelW,
      controller.sessionTitle,
      queue,
      queueOpen,
    );
    const bottom = buildBottom(convW);

    // merge conversation + bottom into the padded main column, panel on the
    // right (opencode: main paddingLeft/Right 2, sidebar width 42)
    // body rows hold the conversation; the two reserved gap rows keep the
    // last message from touching the prompt box's top border. The dialog
    // footer (workspace dir left, "tab agents" right) follows the prompt box
    // directly, and one spare row below keeps the dialog from hugging the
    // window's bottom edge.
    const bodyHeight = Math.max(6, rows - bottom.length - 4);
    const totalConv = conv.length;
    // scrollOffset rows above the bottom; clamped to the real scroll range
    const maxScroll = Math.max(0, totalConv - bodyHeight);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
    const start = Math.max(0, totalConv - bodyHeight - scrollOffset);
    // geometry for click hit-testing on think headers (read by handleClick)
    clickBodyHeight = bodyHeight;
    clickStart = start;
    clickThinkRows = conv.thinkRows ?? null;
    clickConv = conv;
    let bottomIdx = 0;
    const panelFill = bg(C.backgroundPanel) + " ".repeat(panelW) + RESET;
    // scrollbar thumb geometry (opencode scrollbox: element-colored track,
    // border-colored thumb). scrollOffset = 0 is pinned to the latest rows, so
    // the thumb rests at the BOTTOM of the track there and climbs to the top
    // as the user scrolls toward older content.
    const thumbH = Math.max(1, Math.round((bodyHeight * bodyHeight) / Math.max(totalConv, bodyHeight)));
    const thumbTop = maxScroll === 0 ? 0 : Math.round(((maxScroll - scrollOffset) / maxScroll) * (bodyHeight - thumbH));
    const showScrollbar = maxScroll > 0;
    const leftRow = (convRow, showMarker, width, reverse) => {
      const segs = [];
      const leftBg = convRow?.bg ?? C.background;
      if (showMarker) segs.push({ text: " …", fg: C.subtle });
      if (convRow?.segments) segs.push(...convRow.segments);
      return paintRow(leftBg, width, segs, C.background, reverse);
    };

    let out = firstFrame ? "\u001b[2J\u001b[3J\u001b[H" : "\u001b[H";
    firstFrame = false;
    let footerDone = false;
    for (let i = 0; i < rows; i += 1) {
      let left;
      if (i < bodyHeight) {
        const idx = start + i;
        const convRow = idx < totalConv ? conv[idx] : null;
        // drag selection: highlight the selected body rows with a subtle
        // tint (opencode-style) instead of reverse video — a plain click
        // shows nothing, and blank page rows read as a quiet band rather
        // than a bright inverted bar
        const selRow =
          selection !== null && dragStart !== null &&
          i + 1 >= selection.y1 && i + 1 <= selection.y2;
        left = convRow?.custom
          ? convRow.custom(convW, selRow ? SELECTION_BG : undefined)
          : selRow
            ? paintRow(SELECTION_BG, convW, convRow?.segments ?? [], SELECTION_BG)
            : leftRow(convRow, idx === start && start > 0, convW, false);
      } else if (i < bodyHeight + 2) {
        // breathing room between the last message and the prompt box
        left = paintRow(C.background, convW, [], C.background);
      } else if (bottomIdx < bottom.length) {
        const b = bottom[bottomIdx];
        bottomIdx += 1;
        // prompt box rows carry opencode's left accent border; the last row
        // is the bottom border (left bar + element-colored line)
        const segs = b.segments ?? [];
        // half-width accent bar (▌): left half accent, right half element bg
        const bar = fg(MODE_COLORS[tuiMode] ?? C.accent) + bg(C.backgroundElement) + "▌" + RESET + bg(C.background);
        if (b.boxBottom) {
          // solid element-colored line (no ▀ glyph — see empty-state note)
          const line = bg(C.backgroundElement) + " ".repeat(convW - 1) + RESET;
          left = bar + line;
        } else if (b.inputRow) {
          const box = renderInputContent(convW - 1, b.line, b.cursorAt ?? -1);
          left = bar + box;
        } else if (b.box) {
          const box = paintRow(b.bg ?? C.backgroundElement, convW - 1, segs, b.bg ?? C.backgroundElement);
          left = bar + box;
        } else {
          left = paintRow(b.bg ?? C.background, convW, segs, b.bg ?? C.background);
        }
      } else if (!footerDone) {
        // dialog footer (opencode prompt footer): workspace directory at the
        // bottom-left in the same muted style as the operation hints, and the
        // "tab agents" hint at the bottom-right — exactly dialog-wide (never
        // exceeding the prompt box width) and every cell on the page
        // background so no terminal-default (red) shows between the two. The
        // right side stays panel-colored so the info block's column reaches
        // the bottom edge.
        footerDone = true;
        const dir = fit(controller.cwd || process.cwd(), Math.max(10, convW - 26));
        const l = `  ${dir}`;
        const leftW = displayWidth(l);
        const hintW = displayWidth("tab agents");
        const pad = Math.max(1, convW - leftW - hintW);
        const footer = fg(C.muted) + l + " ".repeat(pad) + fg(C.text) + "tab" + fg(C.muted) + " agents";
        left = bg(C.background) + footer;
      } else {
        left = paintRow(C.background, convW, [], C.background);
      }
      const panelRow = panel[i];
      const right = panelRow ? paintRow(C.backgroundPanel, panelW, panelRow.segments ?? []) : panelFill;
      if (panelRow?.queueHeader === true) clickQueueRow = i + 1; // terminal 1-based
      clickPanelX = 5 + convW; // 1-based first column of the panel
      // scrollbar column between the conversation and the right panel
      // (replaces one column of the main column's right padding)
      let scrollCol;
      if (i < bodyHeight && showScrollbar) {
        const inThumb = i >= thumbTop && i < thumbTop + thumbH;
        scrollCol = bg(inThumb ? C.border : C.backgroundElement) + " " + RESET;
      } else {
        scrollCol = bg(C.background) + " " + RESET;
      }
      out += bg(C.background) + "  " + left + bg(C.background) + " " + scrollCol + right;
      // erase to end of line: set bg FIRST so the erase uses the correct
      // panel color, not the terminal default (red); reset after the erase
      out += bg(C.backgroundPanel) + "\x1b[K" + RESET;
      if (i < rows - 1) out += "\r\n";
      else out += "\x1b[J"; // erase below the painted area on the last row
    }
    if (picker !== null) out += renderPickerOverlay();
    out += renderToastOverlay(convW);
    stdout.write(out);
    updateMouseMode();
  }

  // ── input handling ────────────────────────────────────────────────────────

  const decoder = new StringDecoder("utf8");
  let pending = "";

  /** Merged slash-menu: TUI-local commands + the live host catalog (web parity). */
  function commandMenu() {
    const host = (controller.listCommands?.() ?? [])
      .filter((c) => !LOCAL_COMMANDS.some((l) => l.id === `/${c.name}`))
      // /export is a browser-download command; /plan and /goal are replaced by
      // the Tab plan/goal mode toggle (which runs the same /plan on|off
      // command), so none of them are offered in the TUI.
      .filter((c) => !["export", "plan", "goal"].includes(c.name))
      .map((c) => ({ id: `/${c.name}`, hint: c.description }));
    return [...LOCAL_COMMANDS, ...host];
  }

  /**
   * Commands matching the current `/` input, ranked by fuzzy score. Empty
   * input matches everything (score 0, catalog order preserved by stable sort).
   * @param queryOverride - optional query (without the slash) replacing the
   *   live input-derived query, e.g. the command-name part of "/perm danger".
   */
  function matchedCommands(queryOverride) {
    const query = queryOverride ?? (input.startsWith("/") ? input.slice(1) : "");
    const scored = commandMenu()
      .map((c) => ({ c, score: fuzzyScore(query, c.id.slice(1)) }))
      .filter((x) => x.score >= 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c);
  }

  /**
   * Scroll the conversation by `delta` rows (negative = toward the top).
   * 0 = pinned to the bottom; clamped to the available scroll range on paint.
   */
  function scrollBy(delta) {
    scrollOffset = Math.max(0, scrollOffset + delta);
    paint();
  }

  /**
   * Left-click on a think header toggles that block's expanded state
   * (think blocks are collapsed by default). Click x/y are 1-based terminal
   * coordinates; only the conversation body area is hit-tested.
   */
  /**
   * A click (press + release without dragging): toggle a think/web_search/
   * context disclosure.
   */
  function handleClick(x, y) {
    // Right-panel click: the queue count header toggles its expansion.
    if (clickPanelX > 0 && x >= clickPanelX && y === clickQueueRow && y >= 1) {
      queueOpen = !queueOpen;
      paint();
      return;
    }
    if (clickThinkRows === null) return;
    const row = y - 1;
    if (row < 0 || row >= clickBodyHeight) return;
    const convIdx = clickStart + row;
    const itemId = clickThinkRows?.get(convIdx);
    if (itemId !== undefined) {
      if (expandedThink.has(itemId)) expandedThink.delete(itemId);
      else expandedThink.add(itemId);
      paint();
      return;
    }
  }

  /**
   * Start a drag selection at terminal coordinates (1-based). A selection is
   * NOT shown here — opencode only highlights once the pointer actually moves
   * — so a plain click never flashes a highlight.
   */
  function beginDrag(x, y) {
    dragStart = { x, y };
    selection = null;
    dragMoved = false;
    paint();
  }

  /** Extend the drag selection to the current cursor row (first motion shows it). */
  function updateDrag(x, y) {
    if (dragStart === null) return;
    if (x !== dragStart.x || y !== dragStart.y) dragMoved = true;
    if (dragMoved) {
      selection = { y1: Math.min(dragStart.y, y), y2: Math.max(dragStart.y, y) };
    }
    paint();
  }

  /**
   * End a drag: a real drag copies the selected conversation lines to the
   * clipboard and raises the "copied" toast; a click (no movement) falls
   * back to the click action.
   */
  function endDrag(x, y) {
    const start = dragStart;
    dragStart = null;
    if (start === null) return;
    if (selection !== null && dragMoved && clickBodyHeight > 0) {
      // copy the visible text of the selected conversation rows
      const y1 = Math.max(1, selection.y1);
      const y2 = Math.min(clickBodyHeight, selection.y2);
      const out = [];
      for (let row = y1; row <= y2; row += 1) {
        const convIdx = clickStart + (row - 1);
        const convRow = clickConv[convIdx];
        // UI-only rows (stopped/thought markers) never enter the copy
        if (convRow && convRow.copyable !== false) {
          const line = String(convRow.text ?? "").replace(/^ /, "");
          out.push(line.trimEnd());
        }
      }
      const copied = out.join("\n").trim();
      selection = null;
      copyToClipboard(copied);
      paint();
      if (copied !== "") showToast("Copied to clipboard");
      return;
    }
    selection = null;
    handleClick(x, y);
    paint();
  }

  /**
   * Raise the opencode-style toast (exact opencode UI): an absolute box at
   * the terminal's top-right (top 2 / right 2), backgroundPanel fill, left
   * and right "┃" borders in the variant color, 2×1 padding, the message in
   * text color; dismisses itself after opencode's default 5s duration.
   * @param message - the toast text.
   * @param variant - border color key: info | success | warning | error.
   */
  function showToast(message, variant = "info") {
    toast = { message: String(message), variant };
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast = null;
      paint();
    }, TOAST_DURATION_MS);
    paint();
  }

  /**
   * Render the opencode toast overlay (absolute top-right box), mirroring
   * opencode's Toast component: `top={2} right={2}`, maxWidth
   * `min(60, width - 6)`, padding 2×1, backgroundPanel fill, left/right
   * "┃" borders in the variant color, message word-wrapped in text color.
   * Drawn after the frame so it always floats on top.
   */
  function renderToastOverlay(convW) {
    if (toast === null) return "";
    const variantFg = {
      info: C.info,
      success: C.success,
      warning: C.warning,
      error: C.error,
    }[toast.variant] ?? C.info;
    const message = toast.message;
    // Fit within the conversation block width (minus its own padding)
    const maxInner = Math.max(8, convW - 2);
    const maxW = Math.min(60, maxInner, columns - 4);
    const pad = 2; // opencode paddingLeft/Right 2
    const borderW = 2; // ┃ ┃
    const innerW = Math.max(1, maxW - borderW - pad * 2);
    const lines = wrap(message, innerW);
    const contentW = Math.max(1, ...lines.map((line) => displayWidth(line)));
    const boxW = Math.min(maxW, borderW + pad * 2 + contentW);
    const boxH = lines.length + 2; // opencode paddingTop/Bottom 1
    const top = 2; // opencode top={2} (0-based) → terminal row 3
    // Position at the top-right corner of the conversation block so the toast
    // stays fixed relative to the conversation area when the terminal resizes.
    const convRight = 2 + convW; // right edge of the conversation block
    const left = Math.max(2, convRight - boxW);
    let out = "";
    for (let i = 0; i < boxH; i += 1) {
      const content = i === 0 || i === boxH - 1 ? "" : lines[i - 1] ?? "";
      const cw = displayWidth(content);
      const fill = Math.max(0, boxW - borderW - pad * 2 - cw);
      out += `\u001b[${top + i + 1};${left + 1}H`;
      out += bg(C.backgroundPanel) + fg(variantFg) + "┃" + RESET;
      out += bg(C.backgroundPanel) + " ".repeat(pad);
      out += content === "" ? "" : fg(C.text) + content + RESET;
      out += bg(C.backgroundPanel) + " ".repeat(fill + pad);
      out += fg(variantFg) + "┃" + RESET;
    }
    return out;
  }

  function handleKey(key) {
    // While the session picker is open, printable keys type into the search
    // box (web parity: the host SQLite FTS search) instead of the message
    // input; backspace edits the query; ↑/↓/enter/esc keep their picker roles.
    if (picker !== null && picker.kind === "session") {
      if (key === "backspace" || key === "space" || (key.length === 1 && !key.startsWith("\u001b"))) {
        if (sessionSearch === null) sessionSearch = { query: "", items: [], hasMore: false, searching: false };
        if (key === "backspace") sessionSearch.query = sessionSearch.query.slice(0, -1);
        else sessionSearch.query += key;
        cmdIdx = 0;
        scheduleSessionSearch();
        paint();
        return;
      }
    }
    // The provider list dialog filters options locally (opencode
    // dialog-select): printable keys edit the filter, backspace deletes.
    if (picker !== null && picker.kind === "provider") {
      if (key === "backspace" || key === "space" || (key.length === 1 && !key.startsWith("\u001b"))) {
        if (key === "backspace") picker.filter = String(picker.filter ?? "").slice(0, -1);
        else picker.filter = String(picker.filter ?? "") + key;
        cmdIdx = 0;
        pickerScroll = 0;
        paint();
        return;
      }
    }
    // The provider form edits the active field; Enter advances to the next
    // field (and saves on the last one), ↑/↓ move between fields, Esc cancels.
    if (picker !== null && picker.kind === "provider-form") {
      if (key === "backspace" || key === "space" || (key.length === 1 && !key.startsWith("\u001b"))) {
        const f = picker.fields[picker.fieldIdx];
        if (key === "backspace") f.value = String(f.value ?? "").slice(0, -1);
        else f.value = String(f.value ?? "") + key;
        paint();
        return;
      }
      if (key === "up") {
        picker.fieldIdx = Math.max(0, picker.fieldIdx - 1);
        paint();
        return;
      }
      if (key === "down") {
        picker.fieldIdx = Math.min(picker.fields.length - 1, picker.fieldIdx + 1);
        paint();
        return;
      }
      if (key === "enter") {
        if (picker.fieldIdx < picker.fields.length - 1) {
          picker.fieldIdx += 1;
          paint();
          return;
        }
        const p = picker;
        picker = null;
        void p.onResolve();
        cmdIdx = 0;
        return;
      }
      if (key === "escape") {
        const p = picker;
        picker = null;
        p.onCancel();
        cmdIdx = 0;
        paint();
        return;
      }
    }
    if (key === "up") {
      if (questions !== null) {
        // move the question selection up through the options
        qIdx = Math.max(0, qIdx - 1);
        paint();
        return;
      }
      if (picker !== null) cmdIdx = Math.max(0, cmdIdx - 1);
      else if (input.startsWith("/") && cmdIdx >= 0) cmdIdx = Math.max(0, cmdIdx - 1);
      paint();
      return;
    }
    if (key === "down") {
      if (questions !== null) {
        // move the question selection down (clamped to the last option)
        const opts = Array.isArray(questions.request.questions[0]?.options) ? questions.request.questions[0].options : [];
        qIdx = opts.length === 0 ? 0 : Math.min(opts.length - 1, qIdx + 1);
        paint();
        return;
      }
      if (picker !== null) {
        // search mode: the api surface returns one page (20) — hasMore is a
        // "more results" hint; the list mode prefetches pages of 5
        if (
          !(picker.kind === "session" && sessionSearch !== null) &&
          // session picker pagination: approaching the end of the loaded page
          // prefetches the next page (5 at a time) so navigation never stalls
          picker.kind === "session" &&
          sessionPage !== null &&
          !sessionPage.loading &&
          cmdIdx >= picker.options.length - 2 &&
          sessionPage.loaded < sessionPage.all.length
        ) {
          void loadSessionPage();
        }
        const listLen =
          picker.kind === "provider"
            ? picker.options.filter((opt) => {
                const needle = String(picker.filter ?? "").trim().toLowerCase();
                if (needle === "") return true;
                return String(opt.label).toLowerCase().includes(needle);
              }).length
            : picker.options.length;
        // no options → cursor stays at 0 (never -1, which would crash the
        // Enter resolution later)
        cmdIdx = listLen === 0 ? 0 : Math.min(listLen - 1, cmdIdx + 1);
      } else if (input.startsWith("/")) {
        // re-enter the dismissed panel from the top
        const space = input.indexOf(" ");
        const namePart = (space === -1 ? input : input.slice(0, space)).slice(1);
        if (cmdIdx < 0) cmdIdx = 0;
        else cmdIdx = Math.min(matchedCommands(namePart).length - 1, cmdIdx + 1);
      }
      paint();
      return;
    }
    if (key === "enter") {
      if (picker !== null) {
        const p = picker;
        // provider list resolves against the locally filtered options
        const resolved =
          p.kind === "provider"
            ? p.options.filter((opt) => {
                const needle = String(p.filter ?? "").trim().toLowerCase();
                if (needle === "") return true;
                return String(opt.label).toLowerCase().includes(needle);
              })[cmdIdx]
            : p.options[cmdIdx];
        if (resolved === undefined) {
          // nothing selected (empty search / filtered-out list): keep the
          // dialog open — opencode's dialog-select ignores Enter here, and
          // resolving `undefined` would crash the picker's onResolve
          paint();
          return;
        }
        picker = null;
        void p.onResolve(resolved);
        cmdIdx = 0;
        return;
      }
      if (approval !== null) {
        const a = approval;
        approval = null;
        a.resolve(true);
        paint();
        return;
      }
      if (questions !== null) {
        const q = questions;
        questions = null;
        const question = q.request.questions[0];
        const opts = Array.isArray(question?.options) ? question.options : [];
        const picked = opts[Math.min(Math.max(qIdx, 0), Math.max(opts.length - 1, 0))];
        q.resolve({
          answers: question
            ? [{ id: question.id, selected: picked !== undefined && picked !== null ? [String(picked.label)] : [] }]
            : [],
        });
        qIdx = 0;
        qScroll = 0;
        paint();
        return;
      }
      const text = input.trim();
      // multi-line input is always a plain message, never a slash command
      const isCommandLine = !input.includes("\n");
      if (text === "/quit" || text === "/exit") return quit();
      // While the slash panel is visible (cmdIdx >= 0), Enter always executes
      // the selected command — even when only "/" was typed and the selection
      // came from the ↑/↓ keys. Without a visible selection, a partial name
      // still fuzzy-matches to the top command.
      if (isCommandLine && text.startsWith("/") && (text.length > 1 || cmdIdx >= 0)) {
        // fuzzy match: Enter executes the matched command directly, no need to
        // type the full name. Only the first word is fuzzy-matched; anything
        // after the space is carried over as the command's arguments
        // (e.g. "/perm danger" → "/permission danger"). Works even after the
        // panel was dismissed with ESC (selection re-resolves to the top).
        const space = text.indexOf(" ");
        const namePart = space === -1 ? text : text.slice(0, space);
        const args = space === -1 ? "" : text.slice(space);
        const matches = matchedCommands(namePart.slice(1));
        if (matches.length > 0) {
          const selected = matches[Math.min(Math.max(cmdIdx, 0), matches.length - 1)];
          void runCommand(selected.id + args);
          input = "";
          cursor = 0;
          cmdIdx = 0;
          paint();
          return;
        }
        // No command matches: ignore Enter entirely (like opencode — the
        // composer does not respond), keeping the typed text in the box.
        paint();
        return;
      }
      if (isCommandLine && text.startsWith("/")) {
        void runCommand(text);
      } else if (text !== "") {
        // Sending a message applies the current agent mode first: plan mode
        // runs /plan, goal mode runs /plan off — the same commands the web
        // app uses — then the message goes to the agent. NOTE: /plan must be
        // sent WITHOUT an argument: the host handler treats any non-"off"
        // argument as a user message to steer ("/plan on" would inject the
        // word "on" into the conversation), so plan mode is entered with a
        // bare /plan.
        const planCmd = tuiMode === "plan" ? "/plan" : "/plan off";
        void controller.executeCommand(planCmd).then(() => {
          controller.send(text);
        });
        scrollOffset = 0; // sending a message follows the latest
      }
      input = "";
      cursor = 0;
      paint();
      return;
    }
    if (key === "escape") {
      // while the agent is responding, Esc interrupts the conversation
      if (status === "running" && picker === null && approval === null && questions === null) {
        controller.interrupt();
        paint();
        return;
      }
      if (picker !== null) {
        const p = picker;
        picker = null;
        void p.onCancel?.();
        cmdIdx = 0;
        paint();
        return;
      }
      if (approval !== null) {
        const a = approval;
        approval = null;
        a.resolve(false);
        paint();
        return;
      }
      if (questions !== null) {
        const q = questions;
        questions = null;
        qIdx = 0;
        qScroll = 0;
        q.resolve({ answers: [] });
        paint();
        return;
      }
      if (input.startsWith("/") && cmdIdx >= 0 && matchedCommands().length > 0) {
        // first esc: dismiss the slash panel / cancel the selection,
        // keeping the typed command so a second esc can clear it
        cmdIdx = -1;
        paint();
        return;
      }
      if (cmdIdx === -1) {
        // second esc: clear the dialog content entirely
        cmdIdx = 0;
        input = "";
        cursor = 0;
        paint();
        return;
      }
      input = "";
      cursor = 0;
      cmdIdx = 0;
      paint();
      return;
    }
    if (key === "left") {
      // move the input cursor left (dialog text only — pickers keep their own
      // up/down navigation and never receive left/right)
      if (picker === null && approval === null && questions === null) {
        if (cursor > 0 && input[cursor - 1] === "\n") {
          // start of a line: wrap to the end of the previous line (skip the \n)
          cursor = Math.max(0, cursor - 2);
        } else {
          cursor = Math.max(0, cursor - 1);
        }
        paint();
        return;
      }
    }
    if (key === "right") {
      if (picker === null && approval === null && questions === null) {
        if (cursor < input.length - 1 && input[cursor + 1] === "\n") {
          // end of a line (cursor is right before \n): skip the \n to the
          // first character of the next line
          cursor = Math.min(input.length, cursor + 2);
        } else {
          cursor = Math.min(input.length, cursor + 1);
        }
        paint();
        return;
      }
    }
    if (key === "backspace") {
      // delete the character BEFORE the cursor (not always the last one)
      if (cursor > 0) {
        input = input.slice(0, cursor - 1) + input.slice(cursor);
        cursor -= 1;
      }
      if (input.startsWith("/")) cmdIdx = 0; // match set changed → first match
      updateMention();
      paint();
      return;
    }
    if (key === "newline") {
      // Ctrl+Enter / Ctrl+J: insert a line break at the cursor instead of
      // sending — the input becomes multi-line (shown capped at
      // MAX_INPUT_LINES, windowed so the cursor line stays visible)
      input = input.slice(0, cursor) + "\n" + input.slice(cursor);
      cursor += 1;
      updateMention();
      paint();
      return;
    }
    if (key === "ctrl-v") {
      // platform paste shortcut (Ctrl+V on PC, Cmd+V on macOS — the terminal
      // usually intercepts ⌘V; right-click pastes too)
      pasteClipboard();
      return;
    }
    if (key === "ctrl-c") {
      if (status !== "idle") controller.interrupt();
      else quit();
      return;
    }
    if (key === "ctrl-t") {
      showThinking = !showThinking;
      paint();
      return;
    }
    if (key === "ctrl-o") {
      showFull = !showFull;
      paint();
      return;
    }
    if (key === "tab") {
      // Tab toggles between plan and goal agent modes (UI only: label and
      // prompt box left border color). The corresponding /plan on|off command
      // runs when a message is sent, not on the toggle itself.
      tuiMode = tuiMode === "plan" ? "goal" : "plan";
      paint();
      return;
    }
    if (key === "space") {
      input = input.slice(0, cursor) + " " + input.slice(cursor);
      cursor += 1;
      // typing re-selects the first match (default selection)
      if (input.startsWith("/")) cmdIdx = 0;
      updateMention();
      paint();
      return;
    }
    if (key.length === 1 && !key.startsWith("\u001b")) {
      input = input.slice(0, cursor) + key + input.slice(cursor);
      cursor += 1;
      // typing re-selects the first match (default selection)
      if (input.startsWith("/")) cmdIdx = 0;
      updateMention();
      paint();
    }
  }

  // A lone ESC (or an incomplete ESC sequence) may be the first half of a
  // split-delivered arrow/mouse sequence: hold it briefly instead of treating
  // it as a real ESC key, which would otherwise close pickers mid-navigation.
  let escTimer = null;
  const holdForMore = () => {
    if (escTimer !== null) return;
    escTimer = setTimeout(() => {
      escTimer = null;
      // no further bytes arrived: the pending ESC is a genuine ESC keypress
      if (pending.startsWith("\u001b")) {
        pending = pending.slice(1);
        handleKey("escape");
      }
      processPending();
    }, 30);
  };

  function onData(buf) {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    pending += decoder.write(buf);
    processPending();
  }

  function processPending() {
    while (pending.length > 0) {
      if (pending[0] === "\u001b") {
        // Arrow keys: ESC [ A-D
        const arrow = pending.match(/^\u001b\[([A-D])/);
        if (arrow) {
          handleKey(arrow[1] === "A" ? "up" : arrow[1] === "B" ? "down" : arrow[1] === "C" ? "right" : "left");
          pending = pending.slice(3);
          continue;
        }
        // SGR mouse sequence (ESC [ < b ; x ; y M/m). Button codes:
        // 0=left, 1=middle, 2=right, 64=wheel up, 65=wheel down (68/69 with
        // Shift). Wheel up scrolls toward older messages (content moves down,
        // thumb up), wheel down toward newer ones; left-click toggles a think
        // block under the cursor.
        const sgrMouse = pending.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (sgrMouse) {
          const btn = Number(sgrMouse[1]) & 0x7f;
          const x = Number(sgrMouse[2]);
          const y = Number(sgrMouse[3]);
          if (btn === 64) scrollBy(3);
          else if (btn === 65) scrollBy(-3);
          else if (btn === 0 && sgrMouse[4] === "M") beginDrag(x, y); // press
          else if (btn === 32 && sgrMouse[4] === "M") updateDrag(x, y); // drag
          else if (btn === 0 && sgrMouse[4] === "m") endDrag(x, y); // release
          // right-click paste removed — system context menu handles it
          pending = pending.slice(sgrMouse[0].length);
          continue;
        }
        // legacy X10 mouse (ESC [ M + 3 bytes): byte0 = 0x40+code, 64=wheel up,
        // 65=wheel down, 32=left press, 35=left release, 34=right press —
        // wheel scrolls, press/release drive selection or clicks, right pastes
        if (/^\u001b\[M/.test(pending) && pending.length >= 6) {
          const code = pending.charCodeAt(3) & 0x7f;
          const mx = pending.charCodeAt(4) - 0x20;
          const my = pending.charCodeAt(5) - 0x20;
          if (code === 64) scrollBy(3);
          else if (code === 65) scrollBy(-3);
          else if (code === 32) beginDrag(mx, my);
          else if (code === 35) endDrag(mx, my);
          // right-click paste removed — system context menu handles it
          pending = pending.slice(6);
          continue;
        }
        // incomplete X10 sequence — wait for the remaining bytes
        if (/^\u001b\[M/.test(pending)) {
          holdForMore();
          return;
        }
        // other CSI sequences (Home/End/Delete/…): wait for the final byte
        if (/^\u001b\[/.test(pending)) {
          const end = pending.slice(2).search(/[@-~]/);
          if (end === -1) {
            holdForMore();
            return;
          }
          pending = pending.slice(2 + end + 1);
          continue;
        }
        // lone ESC: could be the start of a split-delivered sequence — wait
        if (pending.length === 1) {
          holdForMore();
          return;
        }
        // ESC followed by something that is not a known sequence: ESC key
        pending = pending.slice(1);
        handleKey("escape");
        continue;
      }
      const ch = pending[0];
      pending = pending.slice(1);
      if (ch === "\r") handleKey("enter");
      else if (ch === "\n") handleKey("newline");
      else if (ch === "\x16") handleKey("ctrl-v");
      else if (ch === "\x7f" || ch === "\x08") handleKey("backspace");
      else if (ch === "\x03") handleKey("ctrl-c");
      else if (ch === "\x14") handleKey("ctrl-t");
      else if (ch === "\x0f") handleKey("ctrl-o");
      else if (ch === "\t") handleKey("tab");
      else if (ch === " ") handleKey("space");
      else handleKey(ch);
    }
  }

  async function runCommand(text) {
    if (text === "/model") {
      const models = await controller.listModels();
      if (models.length === 0) return controller.addSystem("No models available.");
      const cur = controller.currentModel();
      pickerScroll = 0;
      picker = {
        kind: "model",
        title: "Select model",
        options: models.map((m) => ({ label: `${m.model} · ${m.provider}${cur && m.provider === cur.provider && m.model === cur.model ? "  ● current" : ""}`, value: m })),
        onResolve: async (opt) => {
          await controller.switchModel(opt.value.provider, opt.value.model);
          controller.addSystem(`Switched to ${opt.value.model} (${opt.value.provider}).`);
        },
        onCancel: () => {},
      };
      cmdIdx = 0;
      paint();
      return;
    }
    if (text.startsWith("/model ")) {
      const arg = text.slice("/model ".length).trim();
      const models = await controller.listModels();
      const m = models.find((x) => x.model === arg || x.name === arg || `${x.provider}/${x.model}` === arg);
      if (m === undefined) return controller.addSystem(`Unknown model "${arg}".`);
      await controller.switchModel(m.provider, m.model);
      return controller.addSystem(`Switched to ${m.model} (${m.provider}).`);
    }
    if (text === "/reasoning") {
      const efforts = await controller.listEfforts();
      if (efforts.length === 0) return controller.addSystem("No reasoning levels available.");
      const cur = controller.effortLabel;
      pickerScroll = 0;
      picker = {
        kind: "reasoning",
        title: "Select reasoning level",
        options: efforts.map((e) => ({ label: `${e.id}${e.id === cur ? "  ● current" : ""}`, value: e })),
        onResolve: async (opt) => {
          await controller.switchEffort(opt.value.id);
          controller.addSystem(`Switched reasoning level to ${opt.value.id}.`);
        },
        onCancel: () => {},
      };
      cmdIdx = 0;
      paint();
      return;
    }
    if (text.startsWith("/reasoning ")) {
      const arg = text.slice("/reasoning ".length).trim();
      const efforts = await controller.listEfforts();
      const e = efforts.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (e === undefined) return controller.addSystem(`Unknown reasoning level "${arg}".`);
      await controller.switchEffort(e.id);
      return controller.addSystem(`Switched reasoning level to ${e.id}.`);
    }
    if (text === "/preset") {
      const presets = await controller.listPresets();
      if (presets.length === 0) return controller.addSystem("No agent presets available.");
      const cur = controller.presetLabel;
      pickerScroll = 0;
      picker = {
        kind: "preset",
        title: "Select agent preset",
        options: presets.map((p) => ({ label: `${p.name}${p.id === cur ? "  ● current" : ""}`, value: p })),
        onResolve: async (opt) => {
          await controller.switchPreset(opt.value.id);
          controller.addSystem(`Preset → ${opt.value.name}.`);
          paint();
        },
        onCancel: () => {},
      };
      cmdIdx = 0;
      paint();
      return;
    }
    if (text.startsWith("/preset ")) {
      const arg = text.slice("/preset ".length).trim();
      const presets = await controller.listPresets();
      const p = presets.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
      if (p === undefined) return controller.addSystem(`Unknown preset "${arg}".`);
      await controller.switchPreset(p.id);
      return controller.addSystem(`Preset → ${p.name}.`);
    }
    if (text === "/provider") {
      // Configure third-party model providers (web Models page parity): the
      // opencode-style dialog lists every configurable route from the `llm`
      // plugin directory plus an "add provider" entry; selecting one opens a
      // field-by-field form that writes the `llm-pi-ai` settings section and
      // stores the API key through the credentials service — both plugins,
      // nothing hand-rolled.
      const providers = controller.listProviderOptions();
      const addOption = { label: "＋ add provider", value: { add: true } };
      const options = [
        addOption,
        ...providers.map((p) => ({
          label: `${p.displayName} (${p.route})${p.live ? "  ● live" : ""}${p.configured ? "  ✓ configured" : ""}`,
          value: { route: p.route, displayName: p.displayName, existing: p.configured },
        })),
      ];
      pickerScroll = 0;
      picker = {
        kind: "provider",
        title: "Provider",
        filter: "",
        options,
        onResolve: async (opt) => {
          if (opt.value.add === true) openProviderForm(null);
          else openProviderForm(opt.value.route);
        },
        onCancel: () => {},
      };
      cmdIdx = 0;
      paint();
      return;
    }
    if (text.startsWith("/provider ")) {
      // quick path: /provider <route> opens the form for that route directly
      const arg = text.slice("/provider ".length).trim();
      return openProviderForm(arg === "" ? null : arg);
    }
    if (text === "/session") {
      // Paginated session picker (web parity: the sidebar collapses groups to
      // 5 sessions at a time). The corpus listing is cheap and the picker
      // opens instantly with the newest page; titles enrich page by page so
      // the log reads (which block the event loop) never stall keyboard
      // navigation. The list is time-descending (sessionQuery newest first);
      // pressing down at the end of a page loads the next one, and once every
      // session is loaded the cursor stops at the bottom.
      const sessions = await controller.listSessions();
      if (sessions.length === 0) return;
      const fmt = (ts) => {
        if (!ts) return "";
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      sessionListAll = sessions;
      sessionSearch = null;
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      sessionPage = { all: sessions, loaded: 0, loading: false };
      pickerScroll = 0;
      picker = {
        kind: "session",
        title: "Session",
        options: [],
        buildOption: (s) => ({
          label: `${s.title || s.id.slice(0, 20)}${s.live ? "  ●" : ""}  ${fmt(s.createdAt)}`,
          value: s,
        }),
        onResolve: async (opt) => {
          sessionPage = null;
          sessionSearch = null;
          if (searchTimer !== null) {
            clearTimeout(searchTimer);
            searchTimer = null;
          }
          searchAbort?.abort();
          await controller.switchSession(opt.value.id);
          scrollOffset = 0;
          paint();
        },
        onCancel: () => {
          sessionPage = null;
          sessionSearch = null;
          if (searchTimer !== null) {
            clearTimeout(searchTimer);
            searchTimer = null;
          }
          searchAbort?.abort();
        },
      };
      cmdIdx = 0;
      void loadSessionPage(); // first page (newest 5) appears immediately
      return;
    }
    if (text === "/new") {
      // start a brand-new session: the controller disposes the current agent,
      // resets the transcript + usage stats, and creates a fresh one — the
      // left conversation returns to the empty logo home and the right info
      // panel resets to zeroes
      await controller.newSession();
      scrollOffset = 0;
      picker = null;
      cmdIdx = 0;
      paint();
      return;
    }
    if (text === "/permission") {
      const perms = controller.listPermissions();
      if (perms.length === 0) return controller.addSystem("No permission presets available.");
      pickerScroll = 0;
      picker = {
        kind: "permission",
        title: "Select permission",
        options: perms.map((p) => ({ label: `${p.name}${p.current ? "  ● current" : ""}`, value: p })),
        onResolve: (opt) => {
          controller.switchPermission(opt.value.id);
          controller.addSystem(`Permission → ${opt.value.name}.`);
        },
        onCancel: () => {},
      };
      cmdIdx = 0;
      paint();
      return;
    }
    if (text.startsWith("/permission ")) {
      const arg = text.slice("/permission ".length).trim();
      const perms = controller.listPermissions();
      const p = perms.find((x) => x.id === arg || x.name === arg);
      if (p === undefined) return controller.addSystem(`Unknown permission "${arg}".`);
      controller.switchPermission(p.id);
      return controller.addSystem(`Permission → ${p.name}.`);
    }
    // Anything else goes to the host command catalog — the same commands the
    // web app serves (/compact, /feedback, /goal, /plan, …), except /export,
    // which is a browser-download command and not offered in the TUI.
    if (text === "/export" || text.startsWith("/export ")) {
      return controller.addSystem(`/export is a browser-only command and is not available in the TUI.`);
    }
    const text2 = await controller.executeCommand(text);
    // An unmatched command is silently ignored (like opencode: the composer
    // simply doesn't respond to Enter when no command matches).
    if (text2 !== undefined) {
      controller.addSystem(text2);
    }
  }

  function quit() {
    if (!running) return;
    running = false;
    clearInterval(ticker);
    if (toastTimer !== null) clearTimeout(toastTimer);
    // end the clipboard daemon (stdin EOF → daemon exits, selection released)
    if (clipDaemon !== null) {
      try {
        clipDaemon.stdin.end();
      } catch {
        /* daemon already gone */
      }
      clipDaemon = null;
    }
    off();
    stdout.off("resize", onResize);
    // restore native mouse behavior and cursor before handing back to bash
    stdout.write("\u001b[?1000l\u001b[?1002l\u001b[?1006l");
    stdout.write("\u001b[0m\u001b[2J\u001b[3J\u001b[H\u001b[?25h");
    // leave the alternate screen: the terminal restores the shell buffer,
    // so no TUI frame ever lands in the window's scrollback
    stdout.write("\u001b[?1049l");
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
    stdout.write("\n");
    onExit?.();
  }

  // setup stdin
  try {
    stdin.setRawMode(true);
  } catch {
    /* non-TTY stdin: input won't work, but rendering still can */
  }
  stdin.resume();
  stdin.on("data", onData);
  // enter the alternate screen buffer: the window gets no scrollbar and the
  // user cannot scroll back through repainted frames (opencode does the same);
  // the shell buffer is restored on quit
  stdout.write("\u001b[?1049h");
  stdout.write("\u001b[?25l"); // hide cursor

  paint();
  dirty = false;
  return { quit };
}

export { paintRow, conversationRows, sidePanelRows, wrap, displayWidth }; // internals for testing
