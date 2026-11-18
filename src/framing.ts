/**
 * Packet framing.
 *
 * The G1 puts two packet shapes on one characteristic:
 *
 *   raw     [opcode, ...payload]                       no length, no sequence
 *   framed  [opcode, len_lo, len_hi, seq, ...payload]  len counts the whole packet
 *
 * Which family an opcode belongs to is a property of the opcode, so the decoder
 * takes a hint from the generated command table and still validates the length
 * before trusting it. Two details that bite people:
 *
 *  - Replies are zero-padded to the ATT payload size: `10 06 00 04 01 c9`
 *    arrives as twenty bytes. Trimming to the declared length is not optional.
 *  - Replies to framed commands echo the request and append their result past
 *    the declared length. `payload` is the echo, `trailer` is the answer.
 */
import { COMMANDS, Status } from "./generated.ts";
import { concat, toHex, type Bytes } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";

export const FRAMED_OPCODES: ReadonlySet<number> = new Set(
  Object.values(COMMANDS).filter((c) => c.framed).map((c) => c.opcode),
);
export const RAW_OPCODES: ReadonlySet<number> = new Set(
  Object.values(COMMANDS).filter((c) => !c.framed).map((c) => c.opcode),
);

const STATUS_VALUES: ReadonlySet<number> = new Set(Object.values(Status));

export interface Packet {
  readonly opcode: number;
  readonly payload: Bytes;
  readonly seq: number | null;
  readonly framed: boolean;
  readonly trailer: Bytes;
  readonly raw: Bytes;
}

const EMPTY = new Uint8Array(0);

/** Status byte of a generic reply, or null when no byte in the expected place is a status code. */
export function packetStatus(packet: Packet): number | null {
  const candidates = [
    packet.trailer.subarray(0, 1),
    packet.framed ? packet.payload.subarray(Math.max(0, packet.payload.length - 1)) : packet.payload.subarray(0, 1),
  ];
  for (const c of candidates) if (c.length && STATUS_VALUES.has(c[0]!)) return c[0]!;
  return null;
}

export function packetOk(packet: Packet): boolean {
  return packetStatus(packet) === Status.SUCCESS;
}

export function packetHex(packet: Packet): string {
  return toHex(packet.raw, " ");
}

function checkByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new ProtocolError(`${name} must be a byte in 0..255, got ${value}`);
  }
}

/** `[opcode, ...payload]` */
export function encodeRaw(opcode: number, payload: ArrayLike<number> = EMPTY): Bytes {
  checkByte("opcode", opcode);
  return concat([opcode], payload);
}

/** `[opcode, len_lo, len_hi, seq, ...payload]`, len counting the header. */
export function encodeFramed(opcode: number, seq: number, payload: ArrayLike<number> = EMPTY): Bytes {
  checkByte("opcode", opcode);
  checkByte("seq", seq);
  const total = 4 + payload.length;
  if (total > 0xffff) throw new ProtocolError(`framed packet of ${total} bytes exceeds the 16-bit length field`);
  return concat([opcode, total & 0xff, (total >> 8) & 0xff, seq], payload);
}

/** True when data parses as a framed packet from a known framed opcode. */
export function looksFramed(data: Bytes): boolean {
  if (data.length < 4 || !FRAMED_OPCODES.has(data[0]!)) return false;
  const declared = data[1]! | (data[2]! << 8);
  return declared >= 4 && declared <= data.length;
}

/** Parse one packet. Pass `framed` to override the opcode-table heuristic. */
export function decode(data: Bytes, framed?: boolean): Packet {
  if (!data.length) throw new ProtocolError("cannot decode an empty packet");
  const isFramed = framed ?? looksFramed(data);
  if (!isFramed) {
    return { opcode: data[0]!, payload: data.subarray(1), seq: null, framed: false, trailer: EMPTY, raw: data };
  }
  if (data.length < 4) throw new ProtocolError(`framed packet needs 4 header bytes, got ${data.length}`);
  const declared = data[1]! | (data[2]! << 8);
  if (declared < 4) throw new ProtocolError(`framed length field of ${declared} is below the header size`);
  if (declared > data.length) {
    throw new ProtocolError(`framed packet declares ${declared} bytes but only ${data.length} arrived`);
  }
  return {
    opcode: data[0]!,
    payload: data.subarray(4, declared),
    seq: data[3]!,
    framed: true,
    trailer: data.subarray(declared),
    raw: data,
  };
}

/** Drop trailing zero padding. For logging only, never for parsing. */
export function stripPadding(data: Bytes): Bytes {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.subarray(0, end);
}

/** The 8-bit counter carried by framed packets. Heartbeats keep their own. */
export class SequenceCounter {
  #value: number;
  constructor(start = 0) {
    this.#value = start & 0xff;
  }
  next(): number {
    const value = this.#value;
    this.#value = (this.#value + 1) & 0xff;
    return value;
  }
  peek(): number {
    return this.#value;
  }
  reset(value = 0): void {
    this.#value = value & 0xff;
  }
}
