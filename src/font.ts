/**
 * Proportional 1-bit fonts for drawing your own screens.
 *
 * The firmware renders text itself when you call `display.text`, at one size,
 * five lines a screen. For anything else — big digits, a speedometer, a
 * two-column layout — you draw a bitmap, and these atlases are what the
 * {@link Canvas} draws with: `sm` (14px), `md` (21px), `lg` (36px bold) and
 * `xl` (64px bold, digits and units only), plus `fw`, a condensed 21px face
 * whose advance widths track the firmware's own text — the simulator uses it
 * to draw `display.text` screens.
 */
import { fromBase64 } from "./bytes.ts";
import { FONT_BLOBS, type FontBlob } from "./fontdata.ts";

export type FontName = "sm" | "md" | "fw" | "lg" | "xl";

export interface Glyph {
  advance: number;
  width: number;
  height: number;
  /** Offset of the bitmap from the pen position. */
  xoff: number;
  /** Offset of the bitmap from the top of the line. */
  yoff: number;
  /** width*height bits, row-major, MSB first, not row-padded. */
  bits: Uint8Array;
}

export class BitmapFont {
  readonly name: string;
  readonly size: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly #glyphs = new Map<number, Glyph>();

  constructor(blob: FontBlob) {
    this.name = blob.name;
    this.size = blob.size;
    this.ascent = blob.ascent;
    this.descent = blob.descent;
    this.lineHeight = blob.lineHeight;
    const data = fromBase64(blob.data);
    let i = 0;
    while (i + 7 <= data.length) {
      const code = data[i]! | (data[i + 1]! << 8);
      const advance = data[i + 2]!;
      const width = data[i + 3]!;
      const height = data[i + 4]!;
      const xoff = (data[i + 5]! << 24) >> 24;
      const yoff = (data[i + 6]! << 24) >> 24;
      const size = (width * height + 7) >> 3;
      this.#glyphs.set(code, { advance, width, height, xoff, yoff, bits: data.subarray(i + 7, i + 7 + size) });
      i += 7 + size;
    }
  }

  has(ch: string): boolean {
    return this.#glyphs.has(ch.codePointAt(0) ?? -1);
  }

  /** The glyph for a character, or undefined: callers draw a hollow box. */
  glyph(ch: string): Glyph | undefined {
    return this.#glyphs.get(ch.codePointAt(0) ?? -1);
  }

  /** Advance used for characters the atlas does not have. */
  get missingAdvance(): number {
    return Math.round(this.size * 0.6);
  }

  advance(ch: string): number {
    return this.glyph(ch)?.advance ?? this.missingAdvance;
  }

  /** Width in pixels of one line of text. */
  measure(text: string, scale = 1, spacing = 0): number {
    let w = 0;
    let n = 0;
    for (const ch of text) {
      w += this.advance(ch) * scale;
      n++;
    }
    return w + Math.max(0, n - 1) * spacing;
  }

  /** Greedy word wrap to a pixel width, breaking long words rather than dropping them. */
  wrap(text: string, maxWidth: number, scale = 1): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.measure(candidate, scale) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        let rest = word;
        while (this.measure(rest, scale) > maxWidth && [...rest].length > 1) {
          const chars = [...rest];
          let cut = 1;
          while (cut < chars.length && this.measure(chars.slice(0, cut + 1).join(""), scale) <= maxWidth) cut++;
          lines.push(chars.slice(0, cut).join(""));
          rest = chars.slice(cut).join("");
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }
}

const cache = new Map<string, BitmapFont>();

/** Get a built-in font by name. Parsed on first use. */
export function getFont(name: FontName | BitmapFont = "md"): BitmapFont {
  if (name instanceof BitmapFont) return name;
  let f = cache.get(name);
  if (!f) {
    const blob = FONT_BLOBS[name];
    if (!blob) throw new RangeError(`no built-in font named ${name}; choose sm, md, fw, lg or xl`);
    f = new BitmapFont(blob);
    cache.set(name, f);
  }
  return f;
}
