/**
 * Just enough PNG for a command-line tool: write the panel as a picture, and
 * read a picture to put on the panel. Node only (uses zlib). In a browser use
 * a canvas instead — `Bitmap.fromRGBA` takes `ImageData` directly.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { Bitmap } from "../bitmap.ts";
import { concat, type Bytes } from "../bytes.ts";
import { crc32 } from "../crc.ts";
import { OpenG1Error } from "../errors.ts";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Bytes): Bytes {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat(head.subarray(4), data)));
  return concat(head, data, crc);
}

/** Encode 8-bit RGBA pixels as a PNG. */
export function encodePng(rgba: ArrayLike<number>, width: number, height: number): Bytes {
  const header = new Uint8Array(13);
  const v = new DataView(header.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let i = 0; i < width * 4; i++) raw[row + 1 + i] = rgba[y * width * 4 + i]!;
  }
  return concat(SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)));
}

export interface PanelPngOptions {
  /** Pixel magnification. Default 2. */
  scale?: number;
  /** `[hiddenTop, hiddenBottom]` rows to tint, so you can see what this pair cannot show. */
  hidden?: readonly [number, number];
}

/** The panel as the wearer sees it: green on black. */
export function panelToPng(bitmap: Bitmap, o: PanelPngOptions = {}): Bytes {
  const scale = Math.max(1, Math.round(o.scale ?? 2));
  const [top, bottom] = o.hidden ?? [0, 0];
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < bitmap.height; y++) {
    const hiddenRow = y < top || y >= bitmap.height - bottom;
    for (let x = 0; x < bitmap.width; x++) {
      const lit = bitmap.get(x, y);
      const color = lit ? (hiddenRow ? [70, 110, 80] : [60, 255, 120]) : hiddenRow ? [40, 14, 14] : [6, 10, 8];
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * w + x * scale + sx) * 4;
          out[i] = color[0]!;
          out[i + 1] = color[1]!;
          out[i + 2] = color[2]!;
          out[i + 3] = 255;
        }
      }
    }
  }
  return encodePng(out, w, h);
}

/** Decode a non-interlaced 8-bit PNG (gray, RGB, palette, with or without alpha) to RGBA. */
export function decodePng(file: Bytes): { data: Uint8ClampedArray; width: number; height: number } {
  if (file.length < 8 || SIGNATURE.some((b, i) => file[i] !== b)) throw new OpenG1Error("not a PNG file");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Bytes | null = null;
  let transparency: Bytes | null = null;
  const idat: Bytes[] = [];
  for (let p = 8; p + 8 <= file.length; ) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(...file.subarray(p + 4, p + 8));
    const data = file.subarray(p + 8, p + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + length;
  }
  if (depth !== 8 || interlace !== 0) {
    throw new OpenG1Error("only 8-bit, non-interlaced PNGs are supported here; re-export the image or use a 1-bit .bmp");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new OpenG1Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(concat(...idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (line[i]! + predicted) & 0xff;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 0 || colorType === 4) {
      r = g = b = pixels[s]!;
      if (colorType === 4) a = pixels[s + 1]!;
    } else if (colorType === 3) {
      const index = pixels[s]!;
      r = palette?.[index * 3] ?? 0;
      g = palette?.[index * 3 + 1] ?? 0;
      b = palette?.[index * 3 + 2] ?? 0;
      a = transparency?.[index] ?? 255;
    } else {
      r = pixels[s]!;
      g = pixels[s + 1]!;
      b = pixels[s + 2]!;
      if (colorType === 6) a = pixels[s + 3]!;
    }
    out.set([r, g, b, a], i * 4);
  }
  return { data: out, width, height };
}
