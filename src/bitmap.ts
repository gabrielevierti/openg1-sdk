/**
 * Bitmap support: a 1-bit image the glasses accept, and how to chop it up.
 *
 * The panel is 576x136 and monochrome. What travels over BLE is not raw pixels
 * but a complete 1-bit `.bmp` file — header included — written into arm-local
 * storage at 0x00001C00, then committed with an end marker and a CRC.
 *
 * Everything here is plain TypeScript with no image library: hand it RGBA or
 * grayscale pixels from wherever your platform decodes images (a canvas, an
 * ImageBitmap, react-native-skia, a PNG decoder) and it does the scaling,
 * dithering and BMP writing.
 */
import { BMP_CHUNK_BYTES, BMP_STORAGE_ADDRESS, DISPLAY_HEIGHT, DISPLAY_WIDTH } from "./generated.ts";
import type { Bytes } from "./bytes.ts";
import { bmpCrcPacket, bmpEnd, bmpPacket, type Outbound } from "./commands.ts";
import { bmpCrc } from "./crc.ts";
import { ProtocolError } from "./errors.ts";

export const BMP_HEADER_SIZE = 62; // 14 file + 40 info + 8 palette

/** Bytes per row: 1 bit per pixel, rounded up to a 4-byte boundary. */
export function rowStride(width: number): number {
  return Math.floor((width + 31) / 32) * 4;
}

export type Fit = "contain" | "cover" | "stretch";

/** `[hiddenTop, hiddenBottom]`: rows of the panel the wearer cannot see. */
export type SafeArea = readonly [top: number, bottom: number];

export interface QuantiseOptions {
  /** 0..255. Pixels at or above it are lit. Default 128. */
  threshold?: number;
  /** Floyd–Steinberg. Good for photos, bad for line art and text. Default true. */
  dither?: boolean;
}

export interface ImageFitOptions extends QuantiseOptions {
  width?: number;
  height?: number;
  fit?: Fit;
  safeArea?: SafeArea;
  /** Light the dark pixels instead of the bright ones (black-on-white artwork). */
  invert?: boolean;
}

/** A 1-bit image. `bits` is row-major, MSB first, rows padded to 4 bytes. */
export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly bits: Uint8Array;

  constructor(width: number = DISPLAY_WIDTH, height: number = DISPLAY_HEIGHT, bits?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.stride = rowStride(width);
    this.bits = bits ?? new Uint8Array(this.stride * height);
    if (this.bits.length !== this.stride * height) {
      throw new ProtocolError(`a ${width}x${height} bitmap needs ${this.stride * height} bytes, got ${this.bits.length}`);
    }
  }

  get(x: number, y: number): 0 | 1 {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return ((this.bits[y * this.stride + (x >> 3)]! >> (7 - (x & 7))) & 1) as 0 | 1;
  }

  set(x: number, y: number, on: boolean | number = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = y * this.stride + (x >> 3);
    const mask = 0x80 >> (x & 7);
    if (on) this.bits[index]! |= mask;
    else this.bits[index]! &= ~mask;
  }

  clone(): Bitmap {
    return new Bitmap(this.width, this.height, this.bits.slice());
  }

  clear(): void {
    this.bits.fill(0);
  }

  invert(): Bitmap {
    const out = new Bitmap(this.width, this.height);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) out.set(x, y, !this.get(x, y));
    return out;
  }

  /** Number of lit pixels. */
  lit(): number {
    let n = 0;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) n += this.get(x, y);
    return n;
  }

  /** Lit pixels inside a band of rows `[from, to)`. */
  litInRows(from: number, to: number): number {
    let n = 0;
    for (let y = Math.max(0, from); y < Math.min(this.height, to); y++) {
      for (let x = 0; x < this.width; x++) n += this.get(x, y);
    }
    return n;
  }

  /** First and last row holding a lit pixel, or null when blank. */
  contentBounds(): [number, number] | null {
    let first = -1;
    let last = -1;
    for (let y = 0; y < this.height; y++) {
      const row = this.bits.subarray(y * this.stride, y * this.stride + Math.ceil(this.width / 8));
      if (row.some((b) => b !== 0)) {
        if (first < 0) first = y;
        last = y;
      }
    }
    return first < 0 ? null : [first, last];
  }

  /** Translate vertically. Rows pushed off the edge are lost. */
  shiftRows(dy: number): Bitmap {
    if (!dy) return this;
    const out = new Bitmap(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      const target = y + dy;
      if (target >= 0 && target < this.height) {
        out.bits.set(this.bits.subarray(y * this.stride, (y + 1) * this.stride), target * this.stride);
      }
    }
    return out;
  }

  /** Copy another bitmap onto this one. `mode` decides how pixels combine. */
  blit(src: Bitmap, dx = 0, dy = 0, mode: "or" | "copy" | "xor" | "erase" = "or"): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const bit = src.get(x, y);
        if (mode === "copy") this.set(dx + x, dy + y, bit);
        else if (bit) {
          if (mode === "or") this.set(dx + x, dy + y, 1);
          else if (mode === "erase") this.set(dx + x, dy + y, 0);
          else this.set(dx + x, dy + y, !this.get(dx + x, dy + y));
        }
      }
    }
  }

  /** Terminal preview. Two rows per character using half blocks. */
  toBlocks(): string {
    const out: string[] = [];
    for (let y = 0; y < this.height; y += 2) {
      let line = "";
      for (let x = 0; x < this.width; x++) {
        const top = this.get(x, y);
        const bottom = this.get(x, y + 1);
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      }
      out.push(line.trimEnd());
    }
    return out.join("\n");
  }

  /** 8-bit RGBA, lit pixels in `on`, for canvases and PNG encoders. */
  toRGBA(on: [number, number, number] = [0, 255, 96], off: [number, number, number] = [0, 0, 0]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.get(x, y) ? on : off;
        const i = (y * this.width + x) * 4;
        out[i] = c[0];
        out[i + 1] = c[1];
        out[i + 2] = c[2];
        out[i + 3] = 255;
      }
    }
    return out;
  }

  /**
   * Serialise to a 1-bpp Windows BMP. Rows are bottom-up unless `topDown`,
   * matching Even's sample images.
   */
  toBmp(topDown = false): Bytes {
    const pixelBytes = this.stride * this.height;
    const out = new Uint8Array(BMP_HEADER_SIZE + pixelBytes);
    const v = new DataView(out.buffer);
    out[0] = 0x42;
    out[1] = 0x4d;
    v.setUint32(2, out.length, true);
    v.setUint32(10, BMP_HEADER_SIZE, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, this.width, true);
    v.setInt32(22, topDown ? -this.height : this.height, true);
    v.setUint16(26, 1, true); // planes
    v.setUint16(28, 1, true); // bits per pixel
    v.setUint32(30, 0, true); // BI_RGB
    v.setUint32(34, pixelBytes, true);
    v.setInt32(38, 2835, true); // 72 dpi
    v.setInt32(42, 2835, true);
    v.setUint32(46, 2, true);
    v.setUint32(50, 2, true);
    out.set([0, 0, 0, 0, 255, 255, 255, 0], 54); // palette: black, white
    for (let y = 0; y < this.height; y++) {
      const row = topDown ? y : this.height - 1 - y;
      out.set(this.bits.subarray(row * this.stride, (row + 1) * this.stride), BMP_HEADER_SIZE + y * this.stride);
    }
    return out;
  }

  /** Read back a 1-bpp BMP (ours or anyone's). */
  static fromBmp(data: Bytes): Bitmap {
    if (data.length < BMP_HEADER_SIZE || data[0] !== 0x42 || data[1] !== 0x4d) throw new ProtocolError("not a BMP file");
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const offset = v.getUint32(10, true);
    const width = v.getInt32(18, true);
    const rawHeight = v.getInt32(22, true);
    const bpp = v.getUint16(28, true);
    if (bpp !== 1) throw new ProtocolError(`expected a 1-bit BMP, got ${bpp} bits per pixel`);
    const topDown = rawHeight < 0;
    const height = Math.abs(rawHeight);
    const stride = rowStride(width);
    if (width <= 0 || height <= 0 || offset + stride * height > data.length) {
      throw new ProtocolError("truncated or malformed BMP");
    }
    // Palette entry 0 is normally black. If it is the bright one, flip.
    const invert = offset >= 62 && data[54]! + data[55]! + data[56]! > data[58]! + data[59]! + data[60]!;
    const bitmap = new Bitmap(width, height);
    for (let y = 0; y < height; y++) {
      const row = topDown ? y : height - 1 - y;
      const src = data.subarray(offset + y * stride, offset + (y + 1) * stride);
      bitmap.bits.set(invert ? src.map((b) => b ^ 0xff) : src, row * stride);
    }
    return bitmap;
  }

  /** Quantise an 8-bit grayscale buffer (one byte per pixel, row-major). */
  static fromGray(gray: ArrayLike<number>, width: number, height: number, o: QuantiseOptions = {}): Bitmap {
    if (gray.length < width * height) {
      throw new ProtocolError(`grayscale buffer holds ${gray.length} samples, need ${width * height}`);
    }
    const threshold = o.threshold ?? 128;
    const bitmap = new Bitmap(width, height);
    if (o.dither === false) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (gray[y * width + x]! >= threshold) bitmap.set(x, y);
      return bitmap;
    }
    const buf = Float64Array.from(gray as ArrayLike<number>).subarray(0, width * height);
    for (let y = 0; y < height; y++) {
      const base = y * width;
      for (let x = 0; x < width; x++) {
        const old = buf[base + x]!;
        const lit = old >= threshold;
        if (lit) bitmap.set(x, y);
        const err = old - (lit ? 255 : 0);
        if (x + 1 < width) buf[base + x + 1]! += (err * 7) / 16;
        if (y + 1 < height) {
          const nb = base + width;
          if (x) buf[nb + x - 1]! += (err * 3) / 16;
          buf[nb + x]! += (err * 5) / 16;
          if (x + 1 < width) buf[nb + x + 1]! += err / 16;
        }
      }
    }
    return bitmap;
  }

  /**
   * Fit an RGBA image (canvas `ImageData`, a decoded PNG, …) onto the panel.
   *
   * `fit` is `contain` (letterbox), `cover` (fill and crop) or `stretch`.
   * `safeArea` is `[hiddenTop, hiddenBottom]`: fitting happens inside the band
   * that remains, so every pixel lands where it can be read. Transparent
   * pixels count as dark.
   */
  static fromRGBA(rgba: ArrayLike<number>, srcWidth: number, srcHeight: number, o: ImageFitOptions = {}): Bitmap {
    if (rgba.length < srcWidth * srcHeight * 4) throw new ProtocolError("RGBA buffer is smaller than width*height*4");
    const gray = new Uint8Array(srcWidth * srcHeight);
    for (let i = 0; i < gray.length; i++) {
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      const a = rgba[i * 4 + 3]! / 255;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[i] = Math.round((o.invert ? 255 - luma : luma) * a);
    }
    return Bitmap.fitGray(gray, srcWidth, srcHeight, o);
  }

  /** Same as {@link fromRGBA} for a grayscale source. */
  static fitGray(gray: ArrayLike<number>, srcWidth: number, srcHeight: number, o: ImageFitOptions = {}): Bitmap {
    const width = o.width ?? DISPLAY_WIDTH;
    const height = o.height ?? DISPLAY_HEIGHT;
    const fit = o.fit ?? "contain";
    const [top, bottom] = o.safeArea ?? [0, 0];
    if (top < 0 || bottom < 0) throw new RangeError("safe-area margins cannot be negative");
    const boxHeight = height - top - bottom;
    if (boxHeight < 1) throw new RangeError(`safe area of ${top}+${bottom} leaves no room on a ${height}px panel`);

    let w: number;
    let h: number;
    if (fit === "stretch") {
      w = width;
      h = boxHeight;
    } else {
      const sx = width / srcWidth;
      const sy = boxHeight / srcHeight;
      const scale = fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
      w = Math.max(1, Math.round(srcWidth * scale));
      h = Math.max(1, Math.round(srcHeight * scale));
    }
    const scaled = resampleGray(gray, srcWidth, srcHeight, w, h);
    const canvas = new Uint8Array(width * height);
    const ox = Math.floor((width - w) / 2);
    const oy = top + Math.floor((boxHeight - h) / 2);
    for (let y = 0; y < h; y++) {
      const ty = oy + y;
      if (ty < top || ty >= height - bottom) continue; // cover: crop to the visible band
      for (let x = 0; x < w; x++) {
        const tx = ox + x;
        if (tx >= 0 && tx < width) canvas[ty * width + tx] = scaled[y * w + x]!;
      }
    }
    return Bitmap.fromGray(canvas, width, height, o);
  }
}

/** Area-averaging when shrinking, bilinear when enlarging. */
function resampleGray(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  if (sw === dw && sh === dh) {
    for (let i = 0; i < out.length; i++) out[i] = src[i]!;
    return out;
  }
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (xr > 1 || yr > 1) {
        const x0 = Math.floor(x * xr);
        const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * xr)));
        const y0 = Math.floor(y * yr);
        const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * yr)));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * sw + xx]!;
        out[y * dw + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
      } else {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
        const xa = Math.floor(fx);
        const ya = Math.floor(fy);
        const xb = Math.min(sw - 1, xa + 1);
        const yb = Math.min(sh - 1, ya + 1);
        const tx = fx - xa;
        const ty = fy - ya;
        const a = src[ya * sw + xa]! * (1 - tx) + src[ya * sw + xb]! * tx;
        const b = src[yb * sw + xa]! * (1 - tx) + src[yb * sw + xb]! * tx;
        out[y * dw + x] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  }
  return out;
}

// --- Transfer ----------------------------------------------------------------

export function chunkImage(image: Bytes, size: number = BMP_CHUNK_BYTES): Bytes[] {
  const chunks: Bytes[] = [];
  for (let i = 0; i < image.length; i += size) chunks.push(image.subarray(i, i + size));
  return chunks.length ? chunks : [new Uint8Array(0)];
}

export const MAX_TRANSFER_PACKETS = 256; // the chunk index is a single byte

/**
 * Refuse a transfer the one-byte chunk index cannot address. Past 256 chunks
 * the index silently wraps and the tail of the file lands on top of the head.
 * This fires when MTU negotiation did not happen: a 23-byte MTU leaves 14
 * bytes of payload and 704 chunks for a full-panel image.
 */
export function checkTransferBudget(size: number, chunkSize: number): number {
  if (chunkSize < 1) {
    throw new ProtocolError(
      `chunk size resolved to ${chunkSize} bytes — the negotiated MTU is too small to carry a bitmap packet at all`,
    );
  }
  const needed = Math.ceil(size / chunkSize);
  if (needed > MAX_TRANSFER_PACKETS) {
    throw new ProtocolError(
      `${size} bytes at ${chunkSize} bytes per chunk needs ${needed} chunks, but the chunk index is one byte and ` +
        `wraps after ${MAX_TRANSFER_PACKETS}. The chunk size follows the negotiated MTU; ask for a larger one ` +
        `(the protocol assumes ${BMP_CHUNK_BYTES}-byte chunks, which needs roughly 247).`,
    );
  }
  return needed;
}

export interface BitmapTransfer {
  data: Outbound[];
  end: Outbound;
  crc: Outbound;
}

/** Build the whole three-phase transfer: data packets, end marker, CRC. */
export function transferPackets(
  image: Bytes,
  chunkSize: number = BMP_CHUNK_BYTES,
  address: ArrayLike<number> = BMP_STORAGE_ADDRESS,
): BitmapTransfer {
  const chunks = chunkImage(image, chunkSize);
  return {
    data: chunks.map((c, i) => bmpPacket(i, c, i === 0)),
    end: bmpEnd(),
    crc: bmpCrcPacket(bmpCrc(image, address)),
  };
}

/** Throw early for images the panel will refuse. */
export function validateForDisplay(image: Bytes): Bitmap {
  const bitmap = Bitmap.fromBmp(image);
  if (bitmap.width !== DISPLAY_WIDTH || bitmap.height !== DISPLAY_HEIGHT) {
    throw new ProtocolError(
      `the panel is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}; this image is ${bitmap.width}x${bitmap.height}`,
    );
  }
  return bitmap;
}
