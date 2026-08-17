/**
 * deepcode wordmark — opencode-style 4-line block logo spelling "deepcode".
 *
 * Letter shapes copied from opencode `packages/tui/src/logo.ts` (same
 * `█▀▀█`/`▀▀▀▀` block style and `_^~,` marker vocabulary), re-arranged to
 * spell DEEPCODE: left half "deep" in muted color, right half "code" in text
 * color + bold, with a one-column gap between them. Marker chars map to block
 * glyphs: `_` → shadow block, `^` → upper-half block on shadow, `~` → shadow
 * upper-half block, `,` → shadow lower-half block.
 *
 * @module deepcode/lib/logo
 */

export const LOGO_LEFT = [
  "                       ",
  "█▀▀█ █▀▀█ █▀▀█ █▀▀█",
  "█__█ █^^^ █^^^ █__█",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ █▀▀▀",
];

export const LOGO_RIGHT = [
  "       ▄              ",
  "█▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "█___ █__█ █__█ █^^^",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
];

/** Marker characters that map to block-glyph rendering (opencode parity). */
export const LOGO_MARKS = "_^~,";
