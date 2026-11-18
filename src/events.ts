/**
 * Decoding what the glasses say on their own initiative.
 *
 * Three things arrive unprompted: touchbar and wear state changes (0xF5),
 * microphone frames (0xF1), and battery reports (0x2C — also the reply to a
 * poll; both are treated identically).
 *
 * Unknown sub-codes are not dropped. They surface as `unknown` events with the
 * bytes intact, because the fastest way to extend this protocol is to wear the
 * glasses, poke at them, and read the log.
 */
import { Evt, StateEvent } from "./generated.ts";
import { toHex, type Bytes } from "./bytes.ts";
import type { Packet } from "./framing.ts";

export type ArmName = "left" | "right";
export type Gesture = "single_tap" | "double_tap" | "triple_tap" | "hold_start" | "hold_end";

interface Base {
  /** Which arm's radio it arrived on. */
  arm: ArmName;
  raw: Bytes;
}

/** A touchbar gesture. */
export interface TouchEvent extends Base {
  type: "touch";
  gesture: Gesture;
  subcode: number;
}
/** Head raised or lowered past the configured angle. */
export interface HeadEvent extends Base {
  type: "head";
  up: boolean;
}
export interface WearEvent extends Base {
  type: "wear";
  worn: boolean;
}
/** Charging case state. Only the field that changed is set. */
export interface CaseEvent extends Base {
  type: "case";
  lidOpen?: boolean;
  charging?: boolean;
  battery?: number;
}
export interface ChargingEvent extends Base {
  type: "charging";
  charging: boolean;
}
export interface DashboardEvent extends Base {
  type: "dashboard";
  open: boolean;
}
export interface PairedEvent extends Base {
  type: "paired";
}
/** One LC3 packet from the microphone. */
export interface AudioEvent extends Base {
  type: "audio";
  seq: number;
  data: Bytes;
}
export interface BatteryEvent extends Base {
  type: "battery";
  percent: number;
  voltageMv?: number;
  charging?: boolean;
  extra: Bytes;
}
/** The wearer held the left touchbar: the "Even AI" trigger. Start the microphone. */
export interface AiRequestEvent extends Base {
  type: "ai-request";
}
/** The wearer let go. Stop recording. */
export interface AiStopEvent extends Base {
  type: "ai-stop";
}
export interface UnknownEvent extends Base {
  type: "unknown";
  opcode: number;
  subcode?: number;
  data: Bytes;
}
/** Emitted by the session itself when a link drops. */
export interface DisconnectEvent {
  type: "disconnect";
  arm: ArmName;
  raw: Bytes;
  reason?: string;
}

export type G1Event =
  | TouchEvent
  | HeadEvent
  | WearEvent
  | CaseEvent
  | ChargingEvent
  | DashboardEvent
  | PairedEvent
  | AudioEvent
  | BatteryEvent
  | AiRequestEvent
  | AiStopEvent
  | UnknownEvent
  | DisconnectEvent;

export type EventType = G1Event["type"];
export type EventOf<T extends EventType> = Extract<G1Event, { type: T }>;

const TOUCH: Record<number, Gesture> = {
  [StateEvent.TOUCHBAR_SINGLE_TAP]: "single_tap",
  [StateEvent.TOUCHBAR_DOUBLE_TAP]: "double_tap",
  [StateEvent.TOUCHBAR_TRIPLE_TAP]: "triple_tap",
  [StateEvent.TOUCHBAR_TRIPLE_TAP_ALT]: "triple_tap",
  [StateEvent.TOUCHBAR_HOLD_START]: "hold_start",
  [StateEvent.TOUCHBAR_HOLD_END]: "hold_end",
};

/** Turn a decoded packet into an event, or null if it is a plain command reply. */
export function parseEvent(packet: Packet, arm: ArmName): G1Event | null {
  const body = packet.payload;
  const raw = packet.raw;
  switch (packet.opcode) {
    case Evt.MIC_DATA:
      if (!body.length) return null;
      return { type: "audio", arm, raw, seq: body[0]!, data: body.subarray(1) };
    case Evt.BATTERY_REPORT:
      return battery(body, arm, raw);
    case Evt.STATE_CHANGE:
      return state(body, arm, raw);
    default:
      return null;
  }
}

function battery(body: Bytes, arm: ArmName, raw: Bytes): G1Event {
  // [tag, percent, ...]. The tail carries voltage and charge flags and its
  // layout moves between firmware builds, so it is exposed but not trusted.
  if (body.length < 2) return { type: "unknown", arm, raw, opcode: Evt.BATTERY_REPORT, data: body };
  const event: BatteryEvent = { type: "battery", arm, raw, percent: Math.min(100, body[1]!), extra: body.subarray(2) };
  if (body.length >= 4) event.voltageMv = body[2]! | (body[3]! << 8);
  if (body.length >= 7) event.charging = body[6] !== 0;
  return event;
}

function state(body: Bytes, arm: ArmName, raw: Bytes): G1Event {
  if (!body.length) return { type: "unknown", arm, raw, opcode: Evt.STATE_CHANGE, data: body };
  const sub = body[0]!;
  const tail = body.subarray(1);
  const flag = tail.length > 0 && tail[0] !== 0;

  const gesture = TOUCH[sub];
  if (gesture) {
    // A hold on the left arm is the Even AI trigger; on the right it is just a hold.
    if (sub === StateEvent.TOUCHBAR_HOLD_START && arm === "left") return { type: "ai-request", arm, raw };
    if (sub === StateEvent.TOUCHBAR_HOLD_END && arm === "left") return { type: "ai-stop", arm, raw };
    return { type: "touch", arm, raw, gesture, subcode: sub };
  }
  switch (sub) {
    case StateEvent.HEAD_UP:
      return { type: "head", arm, raw, up: true };
    case StateEvent.HEAD_DOWN:
      return { type: "head", arm, raw, up: false };
    case StateEvent.GLASSES_WORN:
      return { type: "wear", arm, raw, worn: true };
    case StateEvent.GLASSES_REMOVED:
      return { type: "wear", arm, raw, worn: false };
    case StateEvent.CASE_LID_OPEN:
      return { type: "case", arm, raw, lidOpen: true };
    case StateEvent.CASE_LID_CLOSED:
      return { type: "case", arm, raw, lidOpen: false };
    case StateEvent.CASE_CHARGING:
      return { type: "case", arm, raw, charging: flag };
    case StateEvent.CASE_BATTERY:
      return tail.length
        ? { type: "case", arm, raw, battery: Math.min(100, tail[0]!) }
        : { type: "case", arm, raw };
    case StateEvent.CHARGING_STATE:
      return { type: "charging", arm, raw, charging: flag };
    case StateEvent.DASHBOARD_OPENED:
      return { type: "dashboard", arm, raw, open: true };
    case StateEvent.DASHBOARD_CLOSED:
      return { type: "dashboard", arm, raw, open: false };
    case StateEvent.BLE_PAIRED:
      return { type: "paired", arm, raw };
    default:
      return { type: "unknown", arm, raw, opcode: Evt.STATE_CHANGE, subcode: sub, data: tail };
  }
}

/** One-line human summary, used by `openg1 monitor` and the simulator log. */
export function describeEvent(event: G1Event): string {
  const side = `[${event.arm}]`;
  switch (event.type) {
    case "touch":
      return `${side} touch ${event.gesture}`;
    case "head":
      return `${side} head ${event.up ? "up" : "down"}`;
    case "wear":
      return `${side} glasses ${event.worn ? "worn" : "removed"}`;
    case "charging":
      return `${side} charging=${event.charging}`;
    case "case": {
      const bits = [
        event.lidOpen === undefined ? "" : `lidOpen=${event.lidOpen}`,
        event.charging === undefined ? "" : `charging=${event.charging}`,
        event.battery === undefined ? "" : `battery=${event.battery}`,
      ].filter(Boolean);
      return `${side} case ${bits.join(" ") || "event"}`;
    }
    case "dashboard":
      return `${side} dashboard ${event.open ? "opened" : "closed"}`;
    case "battery":
      return `${side} battery ${event.percent}%`;
    case "audio":
      return `${side} audio seq=${event.seq} ${event.data.length}B`;
    case "ai-request":
      return `${side} Even AI requested (left hold)`;
    case "ai-stop":
      return `${side} Even AI stopped`;
    case "paired":
      return `${side} paired`;
    case "disconnect":
      return `${side} disconnected${event.reason ? `: ${event.reason}` : ""}`;
    case "unknown": {
      const sub = event.subcode === undefined ? "" : ` sub=0x${event.subcode.toString(16).padStart(2, "0")}`;
      return `${side} unknown 0x${event.opcode.toString(16).padStart(2, "0")}${sub} ${toHex(event.data, " ")}`;
    }
  }
}
