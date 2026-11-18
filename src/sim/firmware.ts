/**
 * One emulated arm.
 *
 * This is not a stub. It parses real packets, answers with the replies the
 * firmware gives (zero padding included), reassembles text and bitmap
 * transfers, verifies the bitmap CRC the way the bootloader does, and keeps
 * the state a real arm keeps. It knows nothing about transports or pixels:
 * bytes in, bytes out.
 */
import { BMP_STORAGE_ADDRESS, Evt, Op, ScreenStatus, Status } from "../generated.ts";
import { Bitmap } from "../bitmap.ts";
import { concat, fromUtf8, padTo, utf8, type Bytes } from "../bytes.ts";
import { bmpCrc } from "../crc.ts";
import type { ArmName } from "../events.ts";
import { decode, encodeFramed, type Packet } from "../framing.ts";

export type ContentKind = "none" | "text" | "image" | "notification";

/** What one arm is currently showing. */
export interface ArmDisplay {
  kind: ContentKind;
  text: string;
  /** High nibble of the last SEND_TEXT status byte. */
  mode: number;
  page: number;
  maxPage: number;
  image: Bitmap | null;
  notification: { app: string; title: string; subtitle: string; message: string } | null;
  /** Bumped on every change, so observers can tell frames apart. */
  revision: number;
}

export interface ArmState {
  battery: number;
  charging: boolean;
  brightness: number;
  autoBrightness: boolean;
  silent: boolean;
  headupAngle: number;
  wearDetection: boolean;
  displayHeight: number;
  displayDepth: number;
  displayPower: boolean;
  dashboardLocked: boolean;
  micEnabled: boolean;
  initialised: boolean;
  debugMode: boolean;
  heartbeats: number;
  resets: number;
  bootedAt: number;
  firmware: string;
}

const DEFAULT_FIRMWARE =
  "net build time: 2024-12-28 20:21:57, app build time 2024-12-28 20:20:45, ver 1.4.5, JBD DeviceID 4010";

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

export class ArmFirmware {
  readonly arm: ArmName;
  readonly state: ArmState;
  readonly display: ArmDisplay;
  /** Things an app did that real firmware would punish silently. Read these. */
  readonly warnings: string[] = [];
  /** Called when a packet changes what the arm shows or how it is configured. */
  onChange: (() => void) | null = null;

  #textParts = new Map<number, Bytes>();
  #bmp: Bytes[] = [];
  #bmpNext = 0;
  #bmpBroken = false;
  #noteParts = new Map<number, Bytes>();

  constructor(arm: ArmName) {
    this.arm = arm;
    this.state = {
      battery: 87,
      charging: false,
      brightness: 21,
      autoBrightness: false,
      silent: false,
      headupAngle: 30,
      wearDetection: true,
      displayHeight: 4,
      displayDepth: 5,
      displayPower: true,
      dashboardLocked: false,
      micEnabled: false,
      initialised: false,
      debugMode: false,
      heartbeats: 0,
      resets: 0,
      bootedAt: Date.now(),
      firmware: DEFAULT_FIRMWARE,
    };
    this.display = blankDisplay();
  }

  /** Forget what is on screen, keeping settings. Used between app reloads. */
  resetDisplay(): void {
    Object.assign(this.display, blankDisplay(), { revision: this.display.revision + 1 });
    this.#textParts.clear();
    this.#noteParts.clear();
    this.#bmp = [];
    this.onChange?.();
  }

  #warn(message: string): void {
    this.warnings.push(`[${this.arm}] ${message}`);
    if (this.warnings.length > 200) this.warnings.shift();
  }

  #changed(): void {
    this.display.revision++;
    this.onChange?.();
  }

  /** Feed one packet from the app. Returns the notifications the arm sends back. */
  handle(data: Bytes): Bytes[] {
    let packet: Packet;
    try {
      packet = decode(data);
    } catch {
      this.#warn(`undecodable packet ${[...data.subarray(0, 8)].map(hex2).join(" ")}…`);
      return [];
    }
    const s = this.state;
    const body = packet.payload;
    const ack = (status: number = Status.SUCCESS): Bytes[] => [generic(packet, status)];
    const reply = (...bytes: number[]): Bytes[] => [padTo(Uint8Array.from(bytes), 20)];

    switch (packet.opcode) {
      case Op.HEARTBEAT:
        s.heartbeats++;
        return ack();
      case Op.INIT:
        s.initialised = true;
        return ack();
      case Op.SEQ_SYNC:
        return ack();

      case Op.SET_BRIGHTNESS:
        if (body.length < 2) return ack(Status.FAILURE);
        if (body[0]! > 0x2a) {
          this.#warn(`brightness ${body[0]} is above the hardware maximum of 42`);
          return ack(Status.FAILURE);
        }
        s.brightness = body[0]!;
        s.autoBrightness = body[1] !== 0;
        this.onChange?.();
        return ack();
      case Op.GET_BRIGHTNESS:
        return reply(Op.GET_BRIGHTNESS, 0x65, s.brightness, Number(s.autoBrightness));

      case Op.SET_SILENT_MODE:
        if (!body.length) return ack(Status.FAILURE);
        s.silent = body[0] === 0x0c;
        this.onChange?.();
        return ack();
      case Op.GET_SILENT_MODE:
        return reply(Op.GET_SILENT_MODE, 0x69, s.silent ? 0x0c : 0x0a, 0x06);

      case Op.SET_HEADUP_ANGLE:
        if (!body.length || body[0]! > 0x3c) return ack(Status.FAILURE);
        s.headupAngle = body[0]!;
        return ack();
      case Op.GET_HEADUP_ANGLE:
        return reply(Op.GET_HEADUP_ANGLE, 0x6d, 0x0f, s.headupAngle, 0x00);

      case Op.SET_WEAR_DETECTION:
        if (!body.length) return ack(Status.FAILURE);
        s.wearDetection = body[0] !== 0;
        return ack();
      case Op.GET_WEAR_DETECTION:
        return reply(Op.GET_WEAR_DETECTION, Status.SUCCESS, Number(s.wearDetection));

      case Op.GET_DISPLAY_SETTINGS:
        return reply(Op.GET_DISPLAY_SETTINGS, Status.SUCCESS, s.displayHeight, s.displayDepth);
      case Op.SET_DISPLAY_SETTINGS:
        // Opcode 0x26 is shared: subcommand 0x08 is geometry, 0x05 the gesture binding.
        if (body[0] === 0x08 && body.length >= 5 && body[2] === 0) {
          // Only the commit (preview == 0) changes anything.
          s.displayHeight = body[3]!;
          s.displayDepth = body[4]!;
        }
        return ack();
      case Op.DISPLAY_POWER:
        if (body.length) {
          s.displayPower = body[0] !== 0;
          this.#changed();
        }
        return ack();

      case Op.GET_UPTIME: {
        const up = Math.floor((Date.now() - s.bootedAt) / 1000) + 6729;
        return [Uint8Array.from([Op.GET_UPTIME, up & 0xff, (up >> 8) & 0xff, (up >> 16) & 0xff, (up >>> 24) & 0xff])];
      }

      case Op.MIC_CONTROL:
        if (!body.length) return ack(Status.FAILURE);
        if (this.arm !== "right") {
          this.#warn("MIC_CONTROL sent to the left arm; the microphone is on the right");
          return [Uint8Array.from([Op.MIC_CONTROL, Status.FAILURE, body[0]!])];
        }
        s.micEnabled = body[0] !== 0;
        this.onChange?.();
        return reply(Op.MIC_CONTROL, Status.SUCCESS, body[0]!);

      case Op.GET_BATTERY:
        // 0x2C multiplexes on its first payload byte.
        if (body[0] === 0x01) return reply(Op.GET_BATTERY, 0x66, s.battery, 0xe6, 0x5d, 0x24, Number(s.charging), 0x00);
        return reply(Op.GET_BATTERY, 0x66, 0x02);

      case Op.HARD_RESET:
        // 0x23 multiplexes too: 0x74 asks for the firmware string, 0x72 reboots.
        if (body[0] === 0x74) return [padTo(utf8(s.firmware), 203)];
        s.resets++;
        s.bootedAt = Date.now();
        this.resetDisplay();
        return [];

      case Op.SEND_TEXT:
        return this.#text(packet) ? ack() : ack(Status.FAILURE);
      case Op.CLEAR_SCREEN:
        Object.assign(this.display, blankDisplay(), { revision: this.display.revision });
        this.#changed();
        return ack();

      case Op.BMP_DATA:
        if (!body.length) return ack(Status.FAILURE);
        this.#bmpChunk(body);
        return ack();
      case Op.BMP_END:
        return ack();
      case Op.BMP_CRC:
        if (body.length < 4) return ack(Status.FAILURE);
        return ack(this.#bmpCommit(body) ? Status.SUCCESS : Status.FAILURE);

      case Op.SEND_NOTIFICATION:
        this.#notification(body);
        return ack();
      case Op.CLEAR_NOTIFICATION:
        if (this.display.kind === "notification") {
          Object.assign(this.display, blankDisplay(), { revision: this.display.revision });
          this.#changed();
        }
        return ack();

      case Op.DASHBOARD_LOCK:
        if (body.length >= 2) s.dashboardLocked = body[1] !== 0;
        return ack();
      case Op.SET_DEBUG_MODE:
        s.debugMode = body[0] === 1;
        return ack();

      default:
        // Anything not modelled still acknowledges, exactly as the firmware
        // does for settings it accepts but does not report back.
        return ack();
    }
  }

  #text(packet: Packet): boolean {
    const body = packet.payload;
    if (body.length < 8) {
      this.#warn("SEND_TEXT shorter than its 9-byte header");
      return false;
    }
    const total = body[1]!;
    const index = body[2]!;
    if (index >= total) {
      this.#warn(`SEND_TEXT package ${index} of ${total}`);
      return false;
    }
    if (index === 0) this.#textParts.clear();
    this.#textParts.set(index, body.subarray(8));
    if (this.#textParts.size < total) return true;
    const keys = [...this.#textParts.keys()].sort((a, b) => a - b);
    const text = fromUtf8(concat(...keys.map((k) => this.#textParts.get(k)!)));
    this.#textParts.clear();
    if (text.includes("�")) this.#warn("text contains a torn UTF-8 sequence; it renders as a replacement glyph");
    Object.assign(this.display, {
      kind: "text",
      text,
      mode: body[3]! & 0xf0,
      page: body[6]!,
      maxPage: body[7]!,
      image: null,
      notification: null,
    } satisfies Partial<ArmDisplay>);
    this.#changed();
    return true;
  }

  #bmpChunk(body: Bytes): void {
    const index = body[0]!;
    let chunk = body.subarray(1);
    if (index === 0) {
      this.#bmp = [];
      this.#bmpNext = 0;
      this.#bmpBroken = false;
      const address = chunk.subarray(0, 4);
      if (address.length < 4 || address.some((b, i) => b !== BMP_STORAGE_ADDRESS[i])) {
        this.#warn("first BMP_DATA packet does not start with the storage address 00 1c 00 00");
        this.#bmpBroken = true;
      }
      chunk = chunk.subarray(4);
    }
    if (index !== (this.#bmpNext & 0xff)) {
      this.#warn(`BMP_DATA chunk ${index} arrived where ${this.#bmpNext & 0xff} was expected; the image will be corrupt`);
      this.#bmpBroken = true;
    }
    this.#bmpNext++;
    this.#bmp.push(chunk.slice());
  }

  #bmpCommit(body: Bytes): boolean {
    const expected = ((body[0]! << 24) | (body[1]! << 16) | (body[2]! << 8) | body[3]!) >>> 0;
    const file = concat(...this.#bmp);
    this.#bmp = [];
    if (this.#bmpBroken || bmpCrc(file) !== expected) {
      this.#warn("bitmap CRC mismatch: the glasses reject the image and keep the previous screen");
      return false;
    }
    let bitmap: Bitmap;
    try {
      bitmap = Bitmap.fromBmp(file);
    } catch (error) {
      this.#warn(`bitmap rejected: ${(error as Error).message}`);
      return false;
    }
    if (bitmap.width !== 576 || bitmap.height !== 136) {
      this.#warn(`bitmap is ${bitmap.width}x${bitmap.height}; the panel is 576x136`);
      return false;
    }
    Object.assign(this.display, { kind: "image", image: bitmap, text: "", notification: null } satisfies Partial<ArmDisplay>);
    this.#changed();
    return true;
  }

  #notification(body: Bytes): void {
    if (body.length < 2) return;
    const total = body[0]!;
    const index = body[1]!;
    if (index === 0) this.#noteParts.clear();
    this.#noteParts.set(index, body.subarray(2));
    if (this.#noteParts.size < total) return;
    const keys = [...this.#noteParts.keys()].sort((a, b) => a - b);
    const json = fromUtf8(concat(...keys.map((k) => this.#noteParts.get(k)!)));
    this.#noteParts.clear();
    try {
      const n = JSON.parse(json).ncs_notification ?? {};
      this.display.notification = {
        app: String(n.display_name ?? ""),
        title: String(n.title ?? ""),
        subtitle: String(n.subtitle ?? ""),
        message: String(n.message ?? ""),
      };
      this.display.kind = "notification";
      this.#changed();
    } catch {
      this.#warn("notification JSON did not parse; the firmware would drop it");
    }
  }

  // -- unsolicited messages the arm sends on its own -------------------------------

  stateEvent(subcode: number, ...data: number[]): Bytes {
    return Uint8Array.from([Evt.STATE_CHANGE, subcode, ...data]);
  }

  batteryReport(): Bytes {
    const s = this.state;
    return padTo(Uint8Array.from([Evt.BATTERY_REPORT, 0x66, s.battery, 0xe6, 0x5d, 0x24, Number(s.charging), 0x00]), 20);
  }

  audioPacket(seq: number, data: Bytes): Bytes {
    return concat([Evt.MIC_DATA, seq & 0xff], data);
  }
}

function blankDisplay(): ArmDisplay {
  return {
    kind: "none",
    text: "",
    mode: ScreenStatus.TEXT_SHOW,
    page: 1,
    maxPage: 1,
    image: null,
    notification: null,
    revision: 0,
  };
}

/** Generic replies mimic the real ones, padding included. */
function generic(packet: Packet, status: number): Bytes {
  if (packet.framed) {
    return padTo(concat(encodeFramed(packet.opcode, packet.seq ?? 0, packet.payload), [status]), 20);
  }
  return padTo(Uint8Array.from([packet.opcode, status]), 20);
}
