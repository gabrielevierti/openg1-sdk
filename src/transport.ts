/**
 * Transport abstraction.
 *
 * Everything above this line is pure protocol; everything below it is radios.
 * The session needs four things from a link to one arm — connect, disconnect,
 * write, and a callback for inbound notifications — which is what lets the
 * same SDK run over Web Bluetooth in Chrome, a native BLE plugin on a phone,
 * noble on a desktop, or a WebSocket to the simulator.
 *
 * Bring your own by implementing {@link Transport}; nothing else needs to know.
 */
import type { Bytes } from "./bytes.ts";
import type { ArmName } from "./events.ts";

export type NotifyHandler = (data: Bytes) => void;
export type DisconnectHandler = (reason?: string) => void;

/** One link to one arm. */
export interface Transport {
  /** Human-readable identity, e.g. the advertised name `Even G1_42_L_ABC123`. */
  readonly name: string;
  readonly connected: boolean;
  /** Largest packet this link carries in one write: the negotiated MTU minus 3. */
  readonly maxWrite: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Write one protocol packet. Must not split it across ATT writes. */
  write(data: Bytes): Promise<void>;
  /** Register the single consumer of inbound notifications. */
  onNotify(handler: NotifyHandler): void;
  /** Register a callback for an unexpected link loss. */
  onDisconnect(handler: DisconnectHandler): void;
}

/** Both arms. What every `connect*` helper returns and what `G1.connect` takes. */
export interface TransportPair {
  left: Transport;
  right: Transport;
}

/** Shared plumbing for transports: handler storage and emit helpers. */
export abstract class BaseTransport implements Transport {
  name = "?";
  #notify: NotifyHandler | null = null;
  #disconnect: DisconnectHandler | null = null;

  abstract get connected(): boolean;
  abstract get maxWrite(): number;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract write(data: Bytes): Promise<void>;

  onNotify(handler: NotifyHandler): void {
    this.#notify = handler;
  }
  onDisconnect(handler: DisconnectHandler): void {
    this.#disconnect = handler;
  }
  /** Deliver one inbound packet. */
  protected emit(data: Bytes): void {
    this.#notify?.(data);
  }
  /** Report that the link dropped without `disconnect()` being called. */
  protected emitDisconnect(reason?: string): void {
    this.#disconnect?.(reason);
  }
}

export const ARMS: readonly ArmName[] = ["left", "right"];

/** Parse an advertised name like `Even G1_42_L_ABC123`. */
export function parseDeviceName(name: string | null | undefined): { arm: ArmName; channel: string; serial: string } | null {
  if (!name) return null;
  const m = /^Even[ _]G1_(\d+)_([LR])_(.+)$/.exec(name);
  if (!m) return null;
  return { arm: m[2] === "L" ? "left" : "right", channel: m[1]!, serial: m[3]! };
}

/** One arm seen while scanning. `ref` is whatever your BLE stack calls a device. */
export interface FoundArm<T> {
  arm: ArmName;
  channel: string;
  serial: string;
  name: string;
  rssi?: number;
  ref: T;
}

/**
 * Collects scan results until one complete left/right pair has been seen.
 * The two halves of a pair advertise separately and share a channel number;
 * that is the only thing that matches them.
 */
export class PairFinder<T> {
  readonly #byChannel = new Map<string, Partial<Record<ArmName, FoundArm<T>>>>();
  readonly #channel: string | undefined;

  constructor(channel?: string | number) {
    this.#channel = channel === undefined ? undefined : String(channel);
  }

  /** Offer a scan result. Returns the pair as soon as both arms are known. */
  add(name: string | null | undefined, ref: T, rssi?: number): { left: FoundArm<T>; right: FoundArm<T> } | null {
    const parsed = parseDeviceName(name);
    if (!parsed) return null;
    if (this.#channel !== undefined && parsed.channel !== this.#channel) return null;
    const sides = this.#byChannel.get(parsed.channel) ?? {};
    const found: FoundArm<T> = { ...parsed, name: name!, ref };
    if (rssi !== undefined) found.rssi = rssi;
    sides[parsed.arm] = found;
    this.#byChannel.set(parsed.channel, sides);
    return sides.left && sides.right ? { left: sides.left, right: sides.right } : null;
  }

  /** Every arm seen so far, for an error message that says what was in range. */
  seen(): string[] {
    return [...this.#byChannel.values()].flatMap((s) => [s.left?.name, s.right?.name]).filter((n): n is string => !!n);
  }
}
