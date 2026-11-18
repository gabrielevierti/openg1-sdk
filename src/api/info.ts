/** Reading state back off the device. */
import { fromUtf8, type Bytes } from "../bytes.ts";
import * as cmd from "../commands.ts";
import { ProtocolError } from "../errors.ts";
import type { Session } from "../session.ts";
import { parseDeviceName } from "../transport.ts";

export interface Battery {
  left: number;
  right: number;
  /** The arms discharge unevenly — the right one drives the microphone. */
  lowest: number;
}

export interface Firmware {
  version: string;
  build: string;
  raw: string;
}

export interface SerialInfo {
  serial: string;
  frame: "round" | "square" | "unknown";
  color: "grey" | "brown" | "green" | "unknown";
  side: string;
}

const FRAMES: Record<string, SerialInfo["frame"]> = { S100: "round", S110: "square" };
const COLORS: Record<string, SerialInfo["color"]> = { AA: "grey", BB: "brown", CC: "green" };

/** Unpack a serial like `S110LAAL103842`: frame shape, side, two-letter colour. */
export function decodeSerial(serial: string): SerialInfo {
  const m = /^(S1[01]0)([LR])([A-Z]{2})(.+)$/.exec(serial.trim().toUpperCase());
  if (!m) return { serial, frame: "unknown", color: "unknown", side: "?" };
  return { serial, frame: FRAMES[m[1]!] ?? "unknown", color: COLORS[m[3]!] ?? "unknown", side: m[2]! };
}

export class DeviceInfo {
  readonly #s: Session;
  constructor(session: Session) {
    this.#s = session;
  }

  /** Poll both arms. */
  async battery(): Promise<Battery> {
    const response = await this.#s.send(cmd.getBattery());
    const level = (body: Bytes | undefined) => (body && body.length >= 2 ? Math.min(100, body[1]!) : 0);
    const left = level(response.left?.packet?.payload);
    const right = level(response.right?.packet?.payload);
    return { left, right, lowest: Math.min(left, right) };
  }

  async firmware(): Promise<Firmware> {
    const response = await this.#s.send(cmd.getFirmwareInfo());
    // The reply is headerless ASCII, zero padded: read the raw bytes.
    const raw = response.packet?.raw ?? new Uint8Array(0);
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) end--;
    const text = fromUtf8(raw.subarray(0, end));
    return {
      version: /ver\s+([\d.]+)/.exec(text)?.[1] ?? "unknown",
      build: /app build time\s+([\d\-: ]+)/.exec(text)?.[1]?.trim() ?? "unknown",
      raw: text,
    };
  }

  /** Seconds since the arms last booted. */
  async uptime(): Promise<number> {
    const body = (await this.#s.send(cmd.getUptime())).payload;
    if (body.length < 4) throw new ProtocolError("short uptime reply");
    return (body[0]! | (body[1]! << 8) | (body[2]! << 16) | (body[3]! << 24)) >>> 0;
  }

  /** Serial as advertised in the BLE name — no round trip needed. */
  serial(): SerialInfo {
    const name = this.#s.transports.left.name;
    return decodeSerial(parseDeviceName(name)?.serial ?? name);
  }

  /** Fire any argument-less getter by spec name and hand back the bytes. For replies nobody has decoded yet. */
  async raw(command: string): Promise<Bytes> {
    return (await this.#s.send(cmd.command(command), { strict: false })).payload;
  }
}
