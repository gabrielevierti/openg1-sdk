/**
 * A drawing surface for the panel.
 *
 * `display.text` gives you the firmware's five lines. Everything else the G1
 * can show is a 576x136 1-bit bitmap, and this is how you make one: lines,
 * boxes, arcs, proportional text in four sizes, word-wrapped text boxes,
 * progress bars and direction arrows. Then `g1.display.draw(canvas)`.
 *
 *     await g1.display.draw((c) => {
 *       c.text("87", c.width / 2, 20, { font: "xl", align: "center" });
 *       c.text("km/h", c.width / 2, 100, { font: "md", align: "center" });
 *     });
 *
 * Coordinates are pixels from the top-left. Nothing throws for drawing out of
 * bounds — it is clipped — and `on: false` erases instead of lighting.
 */
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "./generated.ts";
import { Bitmap, type SafeArea } from "./bitmap.ts";
import { getFont, type BitmapFont, type FontName } from "./font.ts";

export interface StrokeOptions {
  /** Light the pixels (default) or erase them. */
  on?: boolean;
  /** Line thickness in pixels. Default 1. */
  width?: number;
}

export interface ShapeOptions extends StrokeOptions {
  /** Fill the shape instead of outlining it. */
  fill?: boolean;
}

export interface RectOptions extends ShapeOptions {
  /** Corner radius in pixels. */
  radius?: number;
}

export interface TextOptions {
  font?: FontName | BitmapFont;
  align?: "left" | "center" | "right";
  /** Where `y` sits on the line: its top (default), its vertical middle, or the baseline. */
  baseline?: "top" | "middle" | "alphabetic";
  /** Integer magnification. Default 1. */
  scale?: number;
  /** Extra pixels between glyphs. */
  spacing?: number;
  on?: boolean;
  /** Truncate with an ellipsis past this many pixels. */
  maxWidth?: number;
}

export interface TextBoxOptions extends Omit<TextOptions, "baseline" | "maxWidth"> {
  valign?: "top" | "middle" | "bottom";
  /** Pixels per line. Defaults to the font's own line height. */
  lineHeight?: number;
  /** Stop after this many lines, ending the last with an ellipsis. */
  maxLines?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Canvas {
  readonly bitmap: Bitmap;
  /** The part of the panel the wearer can actually see. Lay out inside this. */
  readonly safe: Rect;

  constructor(width: number = DISPLAY_WIDTH, height: number = DISPLAY_HEIGHT, safeArea: SafeArea = [0, 0]) {
    this.bitmap = new Bitmap(width, height);
    this.safe = { x: 0, y: safeArea[0], width, height: Math.max(0, height - safeArea[0] - safeArea[1]) };
  }

  get width(): number {
    return this.bitmap.width;
  }
  get height(): number {
    return this.bitmap.height;
  }

  clear(): this {
    this.bitmap.clear();
    return this;
  }

  pixel(x: number, y: number, on = true): this {
    this.bitmap.set(Math.round(x), Math.round(y), on);
    return this;
  }

  // -- lines and shapes -----------------------------------------------------

  line(x0: number, y0: number, x1: number, y1: number, o: StrokeOptions = {}): this {
    const on = o.on ?? true;
    const w = o.width ?? 1;
    if (w <= 1) {
      this.#bresenham(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), on);
      return this;
    }
    // A thick line is a filled quad with round caps.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    this.polygon(
      [
        [x0 + nx, y0 + ny],
        [x1 + nx, y1 + ny],
        [x1 - nx, y1 - ny],
        [x0 - nx, y0 - ny],
      ],
      { fill: true, on },
    );
    this.circle(x0, y0, w / 2, { fill: true, on });
    this.circle(x1, y1, w / 2, { fill: true, on });
    return this;
  }

  #bresenham(x0: number, y0: number, x1: number, y1: number, on: boolean): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.bitmap.set(x0, y0, on);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  #hspan(x0: number, x1: number, y: number, on: boolean): void {
    if (y < 0 || y >= this.height) return;
    const a = Math.max(0, Math.min(x0, x1));
    const b = Math.min(this.width - 1, Math.max(x0, x1));
    for (let x = a; x <= b; x++) this.bitmap.set(x, y, on);
  }

  rect(x: number, y: number, w: number, h: number, o: RectOptions = {}): this {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    if (w <= 0 || h <= 0) return this;
    const on = o.on ?? true;
    const r = Math.max(0, Math.min(Math.round(o.radius ?? 0), Math.floor(Math.min(w, h) / 2)));
    const inset = (row: number): number => {
      // How far a rounded corner eats into this row.
      const d = row < r ? r - row : row >= h - r ? row - (h - r - 1) : 0;
      return d ? Math.ceil(r - Math.sqrt(Math.max(0, r * r - d * d))) : 0;
    };
    if (o.fill) {
      for (let row = 0; row < h; row++) this.#hspan(x + inset(row), x + w - 1 - inset(row), y + row, on);
      return this;
    }
    const t = Math.max(1, Math.round(o.width ?? 1));
    for (let row = 0; row < h; row++) {
      const i = inset(row);
      if (row < t || row >= h - t) {
        this.#hspan(x + i, x + w - 1 - i, y + row, on);
      } else {
        // Sides: thick enough to stay connected to the curve above and below.
        const span = Math.max(t, Math.abs(inset(row - 1) - i) + 1, Math.abs(inset(row + 1) - i) + 1);
        this.#hspan(x + i, x + i + Math.min(span, t + r) - 1, y + row, on);
        this.#hspan(x + w - i - Math.min(span, t + r), x + w - 1 - i, y + row, on);
      }
    }
    return this;
  }

  circle(cx: number, cy: number, r: number, o: ShapeOptions = {}): this {
    const on = o.on ?? true;
    if (r <= 0) return this;
    const t = o.fill ? r : Math.min(r, Math.max(1, o.width ?? 1));
    const inner = r - t;
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const outer = r * r - dy * dy;
      if (outer < 0) continue;
      const xo = Math.sqrt(outer);
      if (o.fill || inner <= 0 || Math.abs(dy) >= inner) {
        this.#hspan(Math.round(cx - xo), Math.round(cx + xo), y, on);
      } else {
        const xi = Math.sqrt(inner * inner - dy * dy);
        this.#hspan(Math.round(cx - xo), Math.round(cx - xi), y, on);
        this.#hspan(Math.round(cx + xi), Math.round(cx + xo), y, on);
      }
    }
    return this;
  }

  /** An arc from `startDeg` to `endDeg`, clockwise, 0° pointing up. For gauges. */
  arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number, o: StrokeOptions = {}): this {
    const on = o.on ?? true;
    const w = Math.max(1, o.width ?? 1);
    const sweep = endDeg - startDeg;
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / 360) * 2 * Math.PI * r * 1.5));
    for (let i = 0; i <= steps; i++) {
      const a = ((startDeg + (sweep * i) / steps - 90) * Math.PI) / 180;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (w <= 1) this.bitmap.set(Math.round(x), Math.round(y), on);
      else this.circle(x, y, w / 2, { fill: true, on });
    }
    return this;
  }

  polygon(points: readonly (readonly [number, number])[], o: ShapeOptions = {}): this {
    const on = o.on ?? true;
    if (points.length < 2) return this;
    if (!o.fill) {
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        this.line(a[0], a[1], b[0], b[1], { on, width: o.width });
      }
      return this;
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    for (let y = Math.max(0, Math.ceil(minY)); y <= Math.min(this.height - 1, Math.floor(maxY)); y++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) this.#hspan(Math.round(xs[i]!), Math.round(xs[i + 1]!), y, on);
    }
    return this;
  }

  /** Flip every pixel in a rectangle. Good for a selected row in a menu. */
  invertRect(x: number, y: number, w: number, h: number): this {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(this.height, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(this.width, Math.round(x + w)); xx++) {
        this.bitmap.set(xx, yy, !this.bitmap.get(xx, yy));
      }
    }
    return this;
  }

  // -- text -------------------------------------------------------------------

  measure(text: string, o: Pick<TextOptions, "font" | "scale" | "spacing"> = {}): number {
    return getFont(o.font).measure(text, o.scale ?? 1, o.spacing ?? 0);
  }

  /** Draw one line of text. Returns the width drawn, in pixels. */
  text(text: string, x: number, y: number, o: TextOptions = {}): number {
    const font = getFont(o.font);
    const scale = Math.max(1, Math.round(o.scale ?? 1));
    const spacing = o.spacing ?? 0;
    const on = o.on ?? true;
    if (o.maxWidth !== undefined && font.measure(text, scale, spacing) > o.maxWidth) {
      text = ellipsize(text, font, o.maxWidth, scale, spacing);
    }
    const width = font.measure(text, scale, spacing);
    let pen = Math.round(o.align === "center" ? x - width / 2 : o.align === "right" ? x - width : x);
    const top = Math.round(
      o.baseline === "alphabetic"
        ? y - font.ascent * scale
        : o.baseline === "middle"
          ? y - (font.lineHeight * scale) / 2
          : y,
    );
    for (const ch of text) {
      const g = font.glyph(ch);
      if (!g) {
        // Hollow box: a missing glyph should look missing, not like a space.
        const w = font.missingAdvance * scale;
        this.rect(pen + scale, top + Math.round(font.ascent * 0.25) * scale, w - 2 * scale, Math.round(font.ascent * 0.7) * scale, { on });
        pen += w + spacing;
        continue;
      }
      for (let gy = 0; gy < g.height; gy++) {
        for (let gx = 0; gx < g.width; gx++) {
          const i = gy * g.width + gx;
          if (!(g.bits[i >> 3]! & (0x80 >> (i & 7)))) continue;
          const px = pen + (g.xoff + gx) * scale;
          const py = top + (g.yoff + gy) * scale;
          if (scale === 1) this.bitmap.set(px, py, on);
          else for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.bitmap.set(px + sx, py + sy, on);
        }
      }
      pen += g.advance * scale + spacing;
    }
    return width;
  }

  /**
   * Word-wrapped text inside a rectangle. Returns the lines that were drawn,
   * so you can tell when something did not fit.
   */
  textBox(text: string, x: number, y: number, w: number, h: number, o: TextBoxOptions = {}): string[] {
    const font = getFont(o.font);
    const scale = Math.max(1, Math.round(o.scale ?? 1));
    const lineHeight = o.lineHeight ?? font.lineHeight * scale;
    const capacity = Math.min(o.maxLines ?? Infinity, Math.max(1, Math.floor(h / lineHeight)));
    let lines = font.wrap(text, w, scale);
    if (lines.length > capacity) {
      lines = lines.slice(0, capacity);
      lines[capacity - 1] = ellipsize(`${lines[capacity - 1]}…`, font, w, scale, o.spacing ?? 0);
    }
    const block = lines.length * lineHeight;
    const top = o.valign === "middle" ? y + (h - block) / 2 : o.valign === "bottom" ? y + h - block : y;
    const anchor = o.align === "center" ? x + w / 2 : o.align === "right" ? x + w : x;
    lines.forEach((line, i) => {
      this.text(line, anchor, top + i * lineHeight, { ...o, font, scale, baseline: "top" });
    });
    return lines;
  }

  // -- widgets ------------------------------------------------------------------

  /** A progress bar. `value` is 0..1. */
  progress(x: number, y: number, w: number, h: number, value: number, o: { radius?: number } = {}): this {
    const radius = o.radius ?? Math.floor(h / 2);
    this.rect(x, y, w, h, { radius });
    const inner = Math.round((w - 4) * Math.max(0, Math.min(1, value)));
    if (inner > 0) this.rect(x + 2, y + 2, inner, h - 4, { fill: true, radius: Math.max(0, radius - 2) });
    return this;
  }

  /**
   * A direction arrow centred on (cx, cy). `angleDeg` is the heading: 0 is
   * straight ahead (up), 90 is right, -90 left, 180 a U-turn.
   */
  arrow(cx: number, cy: number, size: number, angleDeg = 0, o: { on?: boolean } = {}): this {
    const a = (angleDeg * Math.PI) / 180;
    const rot = (px: number, py: number): [number, number] => [
      cx + px * Math.cos(a) - py * Math.sin(a),
      cy + px * Math.sin(a) + py * Math.cos(a),
    ];
    const s = size / 2;
    const shaft = s * 0.32;
    this.polygon(
      [
        rot(0, -s),
        rot(s * 0.8, -s * 0.1),
        rot(shaft, -s * 0.1),
        rot(shaft, s),
        rot(-shaft, s),
        rot(-shaft, -s * 0.1),
        rot(-s * 0.8, -s * 0.1),
      ],
      { fill: true, on: o.on ?? true },
    );
    return this;
  }

  /** A battery glyph with its level. `level` is 0..100. */
  battery(x: number, y: number, level: number, o: { width?: number; height?: number } = {}): this {
    const w = o.width ?? 28;
    const h = o.height ?? 14;
    this.rect(x, y, w - 3, h, { radius: 2 });
    this.rect(x + w - 3, y + Math.round(h / 4), 3, Math.round(h / 2), { fill: true });
    const inner = Math.round(((w - 7) * Math.max(0, Math.min(100, level))) / 100);
    if (inner > 0) this.rect(x + 2, y + 2, inner, h - 4, { fill: true });
    return this;
  }

  /** Paste another bitmap. */
  image(src: Bitmap, x = 0, y = 0, mode: "or" | "copy" | "xor" | "erase" = "or"): this {
    this.bitmap.blit(src, Math.round(x), Math.round(y), mode);
    return this;
  }

  toBitmap(): Bitmap {
    return this.bitmap;
  }
}

function ellipsize(text: string, font: BitmapFont, maxWidth: number, scale: number, spacing: number): string {
  const chars = [...text.replace(/…$/, "")];
  while (chars.length && font.measure(`${chars.join("")}…`, scale, spacing) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
