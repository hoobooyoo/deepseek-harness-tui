export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';
export const BRACKETED_PASTE_ENABLE = '\u001b[?2004h';
export const BRACKETED_PASTE_DISABLE = '\u001b[?2004l';

export function isBracketedPasteStartPrefix(input) {
  return BRACKETED_PASTE_START.startsWith(String(input ?? ''));
}

export function consumeBracketedPaste(input) {
  const value = String(input ?? '');
  if (!value.startsWith(BRACKETED_PASTE_START)) return null;
  const end = value.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
  if (end === -1) return {complete: false};
  return {
    complete: true,
    text: value.slice(BRACKETED_PASTE_START.length, end),
    rest: value.slice(end + BRACKETED_PASTE_END.length),
  };
}

export function normalizePasteText(input) {
  return String(input ?? '').replace(/\r\n?/g, '\n');
}

export function takePlainTextRun(input, options = {}) {
  const value = String(input ?? '');
  const hasLineBreak = value.includes('\n') || value.includes('\r\n');
  const allowLeadingTab = options.allowLeadingTab === true;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    const charLength = codePoint > 0xffff ? 2 : 1;
    const char = value.slice(index, index + charLength);
    if (char === '\t') {
      if (hasLineBreak || index > 0 || allowLeadingTab) {
        index += 1;
        continue;
      }
      break;
    }
    if (codePoint >= 0x20 && codePoint !== 0x7f) {
      index += charLength;
      continue;
    }
    if (char === '\n') {
      index += 1;
      continue;
    }
    if (char === '\r' && value[index + 1] === '\n') {
      index += 2;
      continue;
    }
    break;
  }
  return {text: value.slice(0, index), rest: value.slice(index)};
}