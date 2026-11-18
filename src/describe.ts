/**
 * Naming packets for humans: the simulator's log and `openg1 monitor` use
 * this. Unknown opcodes are named as such rather than hidden — an unexplained
 * packet is usually the interesting one.
 */
import { COMMANDS, Evt, Status } from "./generated.ts";
import { toHex, type Bytes } from "./bytes.ts";
import { describeEvent, parseEvent, type ArmName } from "./events.ts";
import { decode, packetStatus, type Packet } from "./framing.ts";

export interface PacketDescription {
  /** Spec name of the command or event, or `0x..` when unknown. */
  name: string;
  /** One line: the name plus the useful part of the payload. */
  text: string;
  /** True for the high-volume packets a log should collapse: bitmap chunks, audio, their acks. */
  bulk: boolean;
}

const BY_OPCODE = new Map<number, typeof COMMANDS[string][]>();
for (const spec of Object.values(COMMANDS)) {
  BY_OPCODE.set(spec.opcode, [...(BY_OPCODE.get(spec.opcode) ?? []), spec]);
}

/** The command a packet most likely is: same opcode, longest matching constant prefix. */
export function commandNameOf(packet: Packet): string {
  const candidates = BY_OPCODE.get(packet.opcode) ?? [];
  let best: string | null = null;
  let bestLen = -1;
  for (const spec of candidates) {
    if (spec.framed !== packet.framed && candidates.length > 1) continue;
    if (spec.prefix.every((b, i) => packet.payload[i] === b) && spec.prefix.length > bestLen) {
      best = spec.name;
      bestLen = spec.prefix.length;
    }
  }
  return best ?? candidates[0]?.name ?? `0x${packet.opcode.toString(16).padStart(2, "0")}`;
}

const BULK = new Set(["BMP_DATA"]);

/** Describe one packet. `tx` is app → glasses, `rx` is glasses → app. */
export function describePacket(direction: "tx" | "rx", data: Bytes, arm: ArmName = "left"): PacketDescription {
  let packet: Packet;
  try {
    packet = decode(data);
  } catch {
    return { name: "?", text: `undecodable ${toHex(data, " ")}`, bulk: false };
  }
  if (direction === "rx") {
    const event = parseEvent(packet, arm);
    if (event && event.type !== "battery") {
      return { name: event.type, text: describeEvent(event).replace(/^\[\w+\] /, ""), bulk: event.type === "audio" };
    }
    const name = commandNameOf(packet);
    if (packet.opcode > 0x7f && packet.opcode !== Evt.MIC_DATA && packet.opcode !== Evt.STATE_CHANGE && !COMMANDS[name]) {
      // The firmware string reply has no opcode at all: it is plain ASCII.
      return { name: "reply", text: `headerless reply (${data.length} bytes)`, bulk: false };
    }
    const status = packetStatus(packet);
    const verdict = status === Status.SUCCESS ? "ok" : status === Status.FAILURE ? "FAILED" : toHex(packet.payload.subarray(0, 8), " ");
    return { name, text: `${name} → ${verdict}`, bulk: BULK.has(name) };
  }
  const name = commandNameOf(packet);
  const body = packet.payload;
  let detail = "";
  if (name === "SEND_TEXT" && body.length >= 8) {
    const text = new TextDecoder().decode(body.subarray(8)).replace(/\n/g, "⏎");
    detail = ` page ${body[6]}/${body[7]} part ${body[2]! + 1}/${body[1]} "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
  } else if (name === "BMP_DATA") detail = ` #${body[0]}`;
  else if (body.length) detail = ` ${toHex(body.subarray(0, 12), " ")}${body.length > 12 ? "…" : ""}`;
  return { name, text: `${name}${detail}`, bulk: BULK.has(name) };
}
