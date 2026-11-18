/**
 * Turning a string into 0x4E packets.
 *
 * The glasses do not wrap text. They render what you send on the line you send
 * it, and anything past the display edge is simply gone. So the SDK lays the
 * text out itself, which means knowing how wide each glyph is — and the
 * firmware exposes no font metrics at all.
 *
 * {@link FontMetrics} is therefore an estimate, calibrated against Even's own
 * demo app (488 px of usable width at a 21 px font, five lines per screen). It
 * is a plain object you can replace: measure the real advances, pass your own,
 * and every layout in the SDK gets better at once.
 */
import {
  DEFAULT_FONT_PX,
  DEFAULT_LINES_PER_SCREEN,
  ScreenAction,
  ScreenStatus,
  TEXT_WIDTH,
} from "./generated.ts";
import { utf8, type Bytes } from "./bytes.ts";
import { sendText, type Outbound } from "./commands.ts";

const NARROW = new Set("iljt.,;:!'`|()[]{}/\\-");
const WIDE = new Set("mwMW@%&");
const UPPER_LIKE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#");

/** True for characters that occupy a full-width cell (CJK, fullwidth forms, most emoji). */
export function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Estimated glyph advances for the on-glasses font, as fractions of the font size. */
export interface FontMetrics {
  sizePx: number;
  narrow: number;
  space: number;
  normal: number;
  upper: number;
  wide: number;
  fullwidth: number;
}

export const DEFAULT_METRICS: FontMetrics = {
  sizePx: DEFAULT_FONT_PX,
  narrow: 0.3,
  space: 0.28,
  normal: 0.52,
  upper: 0.62,
  wide: 0.85,
  fullwidth: 1.0,
};

export function advance(ch: string, m: FontMetrics = DEFAULT_METRICS): number {
  if (ch === " ") return m.sizePx * m.space;
  if (isWide(ch)) return m.sizePx * m.fullwidth;
  if (NARROW.has(ch)) return m.sizePx * m.narrow;
  if (WIDE.has(ch)) return m.sizePx * m.wide;
  if (UPPER_LIKE.has(ch)) return m.sizePx * m.upper;
  return m.sizePx * m.normal;
}

export function measure(text: string, m: FontMetrics = DEFAULT_METRICS): number {
  let total = 0;
  for (const ch of text) total += advance(ch, m);
  return total;
}

export interface LayoutOptions {
  widthPx?: number;
  linesPerScreen?: number;
  metrics?: FontMetrics;
}

/**
 * Break text into lines that fit. Explicit newlines are honoured, words longer
 * than a line are broken mid-word rather than dropped, and CJK breaks between
 * any two characters.
 */
export function wrap(text: string, o: LayoutOptions = {}): string[] {
  const width = o.widthPx ?? TEXT_WIDTH;
  const m = o.metrics ?? DEFAULT_METRICS;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of tokenise(paragraph)) {
      const candidate = current + word;
      if (current && measure(candidate.trimEnd(), m) > width) {
        lines.push(current.trimEnd());
        current = word.trim() ? word.trimStart() : "";
      } else {
        current = candidate;
      }
      while (measure(current, m) > width && [...current].length > 1) {
        const chars = [...current];
        const cut = longestPrefix(chars, width, m);
        lines.push(chars.slice(0, cut).join(""));
        current = chars.slice(cut).join("");
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

function* tokenise(paragraph: string): Generator<string> {
  let buf = "";
  for (const ch of paragraph) {
    if (isWide(ch)) {
      if (buf) {
        yield buf;
        buf = "";
      }
      yield ch;
    } else if (ch === " ") {
      buf += ch;
      yield buf;
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) yield buf;
}

function longestPrefix(chars: string[], width: number, m: FontMetrics): number {
  let total = 0;
  for (let i = 0; i < chars.length; i++) {
    total += advance(chars[i]!, m);
    if (total > width) return Math.max(1, i);
  }
  return chars.length;
}

/** Wrap text and group the lines into screens. */
export function paginate(text: string, o: LayoutOptions = {}): string[][] {
  const per = o.linesPerScreen ?? DEFAULT_LINES_PER_SCREEN;
  const lines = wrap(text, o);
  const screens: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += per) screens.push(lines.slice(i, i + per));
  return screens;
}

/**
 * Chop data into pieces of at most `limit` bytes without splitting a UTF-8
 * sequence. A torn multi-byte character renders as a replacement glyph and
 * stays wrong for the rest of the screen.
 */
export function splitUtf8(data: Bytes, limit: number): Bytes[] {
  if (limit < 4) throw new RangeError("limit must leave room for a 4-byte UTF-8 sequence");
  const pieces: Bytes[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + limit, data.length);
    if (end < data.length) {
      while (end > start && (data[end]! & 0xc0) === 0x80) end--;
      if (end === start) end = Math.min(start + limit, data.length);
    }
    pieces.push(data.subarray(start, end));
    start = end;
  }
  return pieces.length ? pieces : [new Uint8Array(0)];
}

/** Compose the 0x4E status byte from its two nibbles. */
export function screenStatus(mode: number = ScreenStatus.TEXT_SHOW, newContent = true): number {
  return (mode & 0xf0) | (newContent ? ScreenAction.NEW_CONTENT : 0);
}

export interface TextPacketOptions extends LayoutOptions {
  seq?: number;
  /** Payload budget per packet: the negotiated write size minus the nine header bytes. */
  maxData?: number;
  mode?: number;
}

/** Full pipeline: string in, one packet list per screen out. */
export function textPackets(text: string, o: TextPacketOptions = {}): Outbound[][] {
  const screens = paginate(text, o);
  const status = screenStatus(o.mode);
  const seq = o.seq ?? 0;
  return screens.map((lines, pageIndex) => {
    const pieces = splitUtf8(utf8(lines.join("\n")), o.maxData ?? 167);
    return pieces.map((piece, i) =>
      sendText(piece, {
        seq: (seq + pageIndex) & 0xff,
        totalPackages: pieces.length,
        packageIndex: i,
        screenStatus: status,
        page: pageIndex + 1,
        maxPage: screens.length,
      }),
    );
  });
}

export function fits(text: string, o: LayoutOptions = {}): boolean {
  return measure(text, o.metrics) <= (o.widthPx ?? TEXT_WIDTH);
}
