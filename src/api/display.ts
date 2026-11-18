/** Everything that puts pixels on the panel. */
import { BMP_CHUNK_BYTES, DISPLAY_HEIGHT, DISPLAY_WIDTH, ScreenStatus } from "../generated.ts";
import { Bitmap, checkTransferBudget, transferPackets, type ImageFitOptions, type SafeArea } from "../bitmap.ts";
import { sleep, utf8, type Bytes } from "../bytes.ts";
import { Canvas } from "../canvas.ts";
import * as cmd from "../commands.ts";
import { CommandTimeout, ProtocolError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { safeAreaOf, type DeviceProfile } from "../profile.ts";
import type { Response, Session } from "../session.ts";
import { screenStatus, splitUtf8, textPackets, type FontMetrics } from "../text.ts";
import { ARMS } from "../transport.ts";

export interface TextOptions {
  /** Pause between screens when the text needs more than one. Default 3000 ms. */
  pageDelayMs?: number;
  /** High nibble of the status byte. Default TEXT_SHOW. */
  mode?: number;
  metrics?: FontMetrics;
  linesPerScreen?: number;
  widthPx?: number;
  /** Abort between pages. */
  signal?: AbortSignal;
}

export interface BitmapOptions {
  /** Check the image is panel-sized and throw if either arm rejects the CRC. Default true. */
  verify?: boolean;
  onProgress?: (sent: number, total: number, arm: ArmName) => void;
  /** Timeout for the end marker and CRC exchange. Default 5000 ms. */
  timeoutMs?: number;
  /** Move the ink to the middle of the visible band (a translation, never a crop). */
  autoCenter?: boolean;
  topDown?: boolean;
  /**
   * Delay after every data packet. The data phase is write-without-response,
   * so nothing throttles it; if the firmware's buffer overruns, packets vanish
   * silently until the CRC disagrees. A millisecond or two rules that out.
   */
  paceMs?: number;
  /**
   * Pause between the end marker and the CRC, per arm. Default 300 ms, the
   * value the original Python SDK was tested with on hardware. Lower it if
   * your glasses keep up; it is the main cost of a frame.
   */
  crcDelayMs?: number;
}

/** What actually went over the wire, and whether both arms agreed. */
export interface BitmapResult {
  bytesSent: number;
  packets: number;
  chunkSize: number;
  leftOk: boolean;
  rightOk: boolean;
  ok: boolean;
}

/** An image as pixels: a canvas `ImageData`, or anything shaped like one. */
export interface RgbaImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export class Display {
  readonly #s: Session;
  #safeArea: SafeArea;

  constructor(session: Session, profile: DeviceProfile) {
    this.#s = session;
    this.#safeArea = safeAreaOf(profile);
  }

  readonly width = DISPLAY_WIDTH;
  readonly height = DISPLAY_HEIGHT;

  // -- safe area ----------------------------------------------------------------

  /** `[hiddenTop, hiddenBottom]`: rows the wearer cannot see on this pair. */
  get safeArea(): SafeArea {
    return this.#safeArea;
  }

  setSafeArea(top = 0, bottom = 0): void {
    if (top < 0 || bottom < 0) throw new RangeError("safe-area margins cannot be negative");
    if (top + bottom >= DISPLAY_HEIGHT) {
      throw new RangeError(`safe area of ${top}+${bottom} leaves nothing of a ${DISPLAY_HEIGHT}px panel visible`);
    }
    this.#safeArea = [top, bottom];
  }

  // -- text -----------------------------------------------------------------------

  /**
   * Show text using the firmware's own renderer: wrapped to the panel, five
   * lines a screen, paged automatically when it does not fit on one.
   */
  async text(message: string, o: TextOptions = {}): Promise<void> {
    const pages = textPackets(message, {
      seq: this.#s.seq.peek(),
      maxData: Math.max(4, this.#s.maxData({ extraHeader: 9 })),
      mode: o.mode,
      metrics: o.metrics,
      linesPerScreen: o.linesPerScreen,
      widthPx: o.widthPx,
    });
    for (let i = 0; i < pages.length; i++) {
      await this.#sendScreen(pages[i]!);
      if (i < pages.length - 1) await sleep(o.pageDelayMs ?? 3000, o.signal);
    }
  }

  /** Show exactly one screen that you laid out yourself, with your own page numbers. */
  async textPage(message: string, o: { page?: number; maxPage?: number; mode?: number } = {}): Promise<void> {
    const pieces = splitUtf8(utf8(message), Math.max(4, this.#s.maxData({ extraHeader: 9 })));
    const status = screenStatus(o.mode ?? ScreenStatus.TEXT_SHOW);
    const seq = this.#s.seq.peek();
    await this.#sendScreen(
      pieces.map((piece, i) =>
        cmd.sendText(piece, {
          seq,
          totalPackages: pieces.length,
          packageIndex: i,
          screenStatus: status,
          page: o.page ?? 1,
          maxPage: o.maxPage ?? 1,
        }),
      ),
    );
  }

  /** The whole screen to the left arm, then the whole screen to the right, as the official app does. */
  #sendScreen(packets: cmd.Outbound[]): Promise<void> {
    return this.#s.exclusive(async (tx) => {
      for (const arm of ARMS) for (const packet of packets) await tx.send(cmd.to(packet, arm));
    });
  }

  async clear(): Promise<Response> {
    return this.#s.send(cmd.clearScreen());
  }

  // -- bitmaps ----------------------------------------------------------------------

  /** A blank canvas the size of the panel, aware of this pair's safe area. */
  canvas(): Canvas {
    return new Canvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, this.#safeArea);
  }

  /**
   * Draw a screen and show it. Pass a function that draws on a fresh canvas,
   * or a canvas you built yourself.
   */
  async draw(source: Canvas | ((canvas: Canvas) => void | Promise<void>), o: BitmapOptions = {}): Promise<BitmapResult> {
    let canvas: Canvas;
    if (typeof source === "function") {
      canvas = this.canvas();
      await source(canvas);
    } else {
      canvas = source;
    }
    return this.bitmap(canvas.bitmap, o);
  }

  /**
   * Fit a picture onto the panel and show it. Takes pixels — a canvas
   * `ImageData`, a decoded PNG — and scales into the rows you can see.
   */
  async image(image: RgbaImage, o: ImageFitOptions & BitmapOptions = {}): Promise<BitmapResult> {
    const bitmap = Bitmap.fromRGBA(image.data, image.width, image.height, { safeArea: this.#safeArea, ...o });
    return this.bitmap(bitmap, o);
  }

  /**
   * Send a 1-bit bitmap to both arms and confirm it arrived.
   *
   * With `verify` — the default — a CRC that does not come back clean throws
   * rather than being logged and forgotten. An unconfirmed transfer usually
   * renders partially.
   */
  async bitmap(image: Bitmap | Bytes, o: BitmapOptions = {}): Promise<BitmapResult> {
    const verify = o.verify ?? true;
    let bitmap = image instanceof Bitmap ? image : Bitmap.fromBmp(image);
    if (verify && (bitmap.width !== DISPLAY_WIDTH || bitmap.height !== DISPLAY_HEIGHT)) {
      throw new ProtocolError(
        `the panel is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}; this image is ${bitmap.width}x${bitmap.height}. ` +
          `Use display.image() or Bitmap.fromRGBA() to fit it.`,
      );
    }
    if (o.autoCenter) bitmap = this.#center(bitmap);
    const bytes = bitmap.toBmp(o.topDown ?? false);

    const chunkSize = Math.min(BMP_CHUNK_BYTES, this.#s.maxData({ extraHeader: 1 }) - 4);
    checkTransferBudget(bytes.length, chunkSize);
    const transfer = transferPackets(bytes, chunkSize);
    const timeoutMs = o.timeoutMs ?? 5000;
    const crcDelayMs = o.crcDelayMs ?? 300;

    const result: BitmapResult = {
      bytesSent: bytes.length,
      packets: transfer.data.length,
      chunkSize,
      leftOk: false,
      rightOk: false,
      ok: false,
    };
    // Left before right, and nothing else in between: the halves update
    // independently and a heartbeat inside a chunk sequence confuses the
    // firmware's reassembler.
    await this.#s.exclusive(async (tx) => {
      for (const arm of ARMS) {
        for (let i = 0; i < transfer.data.length; i++) {
          await tx.writeRaw(arm, this.#s.encode(transfer.data[i]!));
          if (o.paceMs) await sleep(o.paceMs);
          o.onProgress?.(i + 1, transfer.data.length, arm);
        }
        let ok = false;
        try {
          await tx.send(cmd.to(transfer.end, arm), { timeoutMs });
          if (crcDelayMs) await sleep(crcDelayMs);
          ok = (await tx.send(cmd.to(transfer.crc, arm), { timeoutMs, strict: false })).ok;
        } catch (error) {
          // A silent arm is reported as "not confirmed" below; a dead link is not swallowed.
          if (!(error instanceof CommandTimeout)) throw error;
        }
        if (arm === "left") result.leftOk = ok;
        else result.rightOk = ok;
      }
    });
    result.ok = result.leftOk && result.rightOk;
    if (verify && !result.ok) {
      throw new ProtocolError(
        `bitmap not confirmed (left=${result.leftOk}, right=${result.rightOk}) after ${result.packets} packets of ` +
          `${chunkSize} bytes. An unconfirmed transfer usually renders partially. Try paceMs: 2, and check the negotiated MTU.`,
      );
    }
    return result;
  }

  #center(bitmap: Bitmap): Bitmap {
    const bounds = bitmap.contentBounds();
    if (!bounds) return bitmap;
    const [minY, maxY] = bounds;
    const content = maxY - minY + 1;
    const [top, bottom] = this.#safeArea;
    const visible = bitmap.height - top - bottom;
    const targetY =
      content <= visible ? top + Math.floor((visible - content) / 2) : Math.floor((bitmap.height - content) / 2);
    // Clamp so no row is pushed off the framebuffer.
    const shift = Math.max(-minY, Math.min(targetY - minY, bitmap.height - 1 - maxY));
    return bitmap.shiftRows(shift);
  }

  // -- panel --------------------------------------------------------------------------

  /** Brightness 0..42. With `auto`, the ambient sensor takes over. */
  brightness(level: number, auto = false): Promise<Response> {
    return this.#s.send(cmd.setBrightness(level, auto));
  }

  async getBrightness(): Promise<{ level: number; auto: boolean }> {
    const body = (await this.#s.send(cmd.getBrightness())).payload;
    if (body.length < 3) throw new ProtocolError("short brightness reply");
    return { level: body[1]!, auto: body[2] !== 0 };
  }

  /** Height (0..8) and depth (1..9) of the virtual screen. Does the preview/commit two-step. */
  async setGeometry(height: number, depth: number, settleMs = 1500): Promise<void> {
    await this.#s.send(cmd.setDisplaySettings(height, depth, true));
    await sleep(settleMs);
    await this.#s.send(cmd.setDisplaySettings(height, depth, false));
  }

  async getGeometry(): Promise<{ height: number; depth: number }> {
    const body = (await this.#s.send(cmd.getDisplaySettings())).payload;
    if (body.length < 3) throw new ProtocolError("short display-settings reply");
    return { height: body[1]!, depth: body[2]! };
  }

  power(on = true): Promise<Response> {
    return this.#s.send(cmd.displayPower(on));
  }
}
