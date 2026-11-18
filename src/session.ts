/**
 * The session: two radios pretending to be one device.
 *
 * Three things make G1 sessions harder than they look, and this module exists
 * to hide all three.
 *
 * Ordering. Each arm is an independent peripheral. Except where the protocol
 * says otherwise, a command goes to the left arm, you wait for its
 * acknowledgement, and only then does it go to the right. Fire both at once
 * and the display tears. So all sends funnel through one lock.
 *
 * Correlation. Replies carry no request id. Framed commands echo their
 * sequence byte, which is enough; raw commands echo only the opcode, which is
 * enough only because sends are serialised.
 *
 * Liveness. No heartbeat for 32 seconds and the firmware drops the link, so a
 * timer sends one every 28 — on its own counter, because the firmware tracks
 * the two independently.
 */
import { HEARTBEAT_INTERVAL_S, Status } from "./generated.ts";
import type { Bytes } from "./bytes.ts";
import { heartbeat, init, resolvedTarget, seqSync, specOf, type Outbound } from "./commands.ts";
import { CommandError, CommandTimeout, NotConnectedError, ProtocolError } from "./errors.ts";
import { parseEvent, type ArmName, type EventOf, type EventType, type G1Event } from "./events.ts";
import { decode, encodeFramed, encodeRaw, packetStatus, SequenceCounter, type Packet } from "./framing.ts";
import { ARMS, type Transport, type TransportPair } from "./transport.ts";

export interface SessionOptions {
  /** How long to wait for an arm to acknowledge. Default 2500 ms. */
  ackTimeoutMs?: number;
  /** Default 28000 ms. The firmware drops the link at 32 s. */
  heartbeatIntervalMs?: number;
  autoHeartbeat?: boolean;
  /** When true (default) a FAILURE status throws. Turn off while probing guessed commands. */
  strict?: boolean;
}

export interface SendOptions {
  timeoutMs?: number;
  strict?: boolean;
}

/** What one arm answered. */
export interface Reply {
  arm: ArmName;
  packet: Packet | null;
  elapsedMs: number;
  ok: boolean;
  status: number | null;
}

/** What both arms answered. */
export class Response {
  readonly command: string;
  readonly replies: Partial<Record<ArmName, Reply>> = {};
  constructor(command: string) {
    this.command = command;
  }
  get left(): Reply | undefined {
    return this.replies.left;
  }
  get right(): Reply | undefined {
    return this.replies.right;
  }
  get ok(): boolean {
    return Object.values(this.replies).every((r) => r.ok);
  }
  /** The first reply packet, whichever arm it came from. */
  get packet(): Packet | null {
    return this.replies.left?.packet ?? this.replies.right?.packet ?? null;
  }
  get payload(): Bytes {
    return this.packet?.payload ?? new Uint8Array(0);
  }
}

export type PacketDirection = "tx" | "rx";
export type PacketListener = (arm: ArmName, direction: PacketDirection, data: Bytes) => void;
export type EventHandler<T extends EventType = EventType> = (event: EventOf<T>) => void | Promise<void>;

interface Waiter {
  resolve(packet: Packet): void;
  reject(error: Error): void;
}

const ANY = "*";

class Pending {
  readonly #waiters = new Map<string, Waiter[]>();

  add(key: string): { promise: Promise<Packet>; waiter: Waiter } {
    let waiter!: Waiter;
    const promise = new Promise<Packet>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    const queue = this.#waiters.get(key) ?? [];
    queue.push(waiter);
    this.#waiters.set(key, queue);
    return { promise, waiter };
  }

  resolve(packet: Packet): boolean {
    for (const key of [`${packet.opcode}:${packet.seq ?? "-"}`, `${packet.opcode}:-`, ANY]) {
      const waiter = this.#waiters.get(key)?.shift();
      if (waiter) {
        waiter.resolve(packet);
        return true;
      }
    }
    return false;
  }

  discard(key: string, waiter: Waiter): void {
    const queue = this.#waiters.get(key);
    const i = queue?.indexOf(waiter) ?? -1;
    if (i >= 0) queue!.splice(i, 1);
  }

  failAll(error: Error): void {
    for (const queue of this.#waiters.values()) for (const w of queue.splice(0)) w.reject(error);
  }
}

/** Owns both transports and everything stateful about the connection. */
export class Session {
  readonly transports: Record<ArmName, Transport>;
  ackTimeoutMs: number;
  heartbeatIntervalMs: number;
  autoHeartbeat: boolean;
  strict: boolean;

  /** The global sequence counter for framed packets. */
  readonly seq = new SequenceCounter();
  /** The heartbeat's own counter. */
  readonly hbSeq = new SequenceCounter();

  readonly #pending: Record<ArmName, Pending> = { left: new Pending(), right: new Pending() };
  readonly #handlers = new Map<string, Set<(event: G1Event) => void | Promise<void>>>();
  readonly #packetListeners = new Set<PacketListener>();
  #lock: Promise<unknown> = Promise.resolve();
  #hbTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor(pair: TransportPair, options: SessionOptions = {}) {
    this.transports = { left: pair.left, right: pair.right };
    this.ackTimeoutMs = options.ackTimeoutMs ?? 2500;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_S * 1000;
    this.autoHeartbeat = options.autoHeartbeat ?? true;
    this.strict = options.strict ?? true;
  }

  // -- lifecycle ----------------------------------------------------------------

  async start(options: { handshake?: boolean } = {}): Promise<void> {
    for (const arm of ARMS) {
      const transport = this.transports[arm];
      transport.onNotify((data) => this.#receive(arm, data));
      transport.onDisconnect((reason) => this.#lost(arm, reason));
      if (!transport.connected) await transport.connect();
    }
    this.#started = true;

    if (options.handshake ?? true) {
      // What the official app does on connect: initialise the left arm, then
      // publish the sequence counter to the right. Neither is fatal if it fails.
      await this.send(init()).catch(ignoreCommandFailure);
      await this.send(seqSync()).catch(ignoreCommandFailure);
    }
    if (this.autoHeartbeat) this.#scheduleHeartbeat();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#hbTimer) clearTimeout(this.#hbTimer);
    this.#hbTimer = null;
    for (const arm of ARMS) this.#pending[arm].failAll(new NotConnectedError("session stopped"));
    for (const arm of ARMS) {
      await this.transports[arm].disconnect().catch(() => {});
    }
  }

  get connected(): boolean {
    return this.#started && this.transports.left.connected && this.transports.right.connected;
  }

  // -- sending ------------------------------------------------------------------

  /** Payload budget for one packet, given the negotiated write size. */
  maxData(options: { framed?: boolean; extraHeader?: number } = {}): number {
    const write = Math.min(this.transports.left.maxWrite, this.transports.right.maxWrite);
    return write - (options.framed ? 4 : 1) - (options.extraHeader ?? 0);
  }

  /** Stamp a packet with a sequence number (when framed) and serialise it. */
  encode(out: Outbound, seq?: number): Bytes {
    const spec = specOf(out);
    return spec.framed ? encodeFramed(spec.opcode, seq ?? this.seq.next(), out.body) : encodeRaw(spec.opcode, out.body);
  }

  /**
   * Send one command and wait for the arms that owe a reply. Serialised
   * against every other send: the left/right handshake is not safe to
   * interleave.
   */
  send(out: Outbound, options: SendOptions = {}): Promise<Response> {
    return this.exclusive((tx) => tx.send(out, options));
  }

  /** Send a batch without letting anything else — a heartbeat, say — interleave. */
  sendAll(outs: readonly Outbound[], options: SendOptions = {}): Promise<Response[]> {
    return this.exclusive(async (tx) => {
      const responses: Response[] = [];
      for (const out of outs) responses.push(await tx.send(out, options));
      return responses;
    });
  }

  /**
   * Hold the send lock for a whole multi-packet operation. Inside the
   * callback use the handle you are given, not `session.send` — that would
   * wait for the lock you are holding.
   */
  exclusive<T>(fn: (tx: SessionHandle) => Promise<T>): Promise<T> {
    const handle: SessionHandle = {
      send: (out, options) => this.#sendLocked(out, options ?? {}),
      writeRaw: (arm, data) => this.#writeRaw(arm, data),
    };
    const run = this.#lock.then(() => fn(handle));
    this.#lock = run.catch(() => {});
    return run;
  }

  /** Resolves once every send queued so far has finished. */
  idle(): Promise<void> {
    return this.#lock.then(() => {});
  }

  async #sendLocked(out: Outbound, options: SendOptions): Promise<Response> {
    if (!this.#started) throw new NotConnectedError("session has not been started");
    const spec = specOf(out);
    const timeoutMs = options.timeoutMs ?? this.ackTimeoutMs;
    const strict = options.strict ?? this.strict;
    const expectsReply = spec.response !== "none" && out.awaitAck;
    const seq = spec.framed ? this.seq.next() : null;
    const data = spec.framed ? encodeFramed(spec.opcode, seq!, out.body) : encodeRaw(spec.opcode, out.body);
    const key = spec.headerless ? ANY : `${spec.opcode}:${seq ?? "-"}`;

    const response = new Response(out.command);
    const target = resolvedTarget(out);
    for (const arm of ARMS) {
      if (target !== "both" && target !== arm) continue;
      const pending = expectsReply ? this.#pending[arm].add(key) : null;
      const started = Date.now();
      try {
        await this.#writeRaw(arm, data);
      } catch (error) {
        if (pending) this.#pending[arm].discard(key, pending.waiter);
        throw error;
      }
      let packet: Packet | null = null;
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CommandTimeout(out.command, timeoutMs, arm)), timeoutMs);
        });
        try {
          packet = await Promise.race([pending.promise, timeout]);
        } catch (error) {
          this.#pending[arm].discard(key, pending.waiter);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      const status = packet ? packetStatus(packet) : null;
      response.replies[arm] = {
        arm,
        packet,
        elapsedMs: Date.now() - started,
        status,
        ok: packet !== null && (status === null || status === Status.SUCCESS),
      };
      if (strict && status === Status.FAILURE) throw new CommandError(out.command, Status.FAILURE, arm);
    }
    return response;
  }

  async #writeRaw(arm: ArmName, data: Bytes): Promise<void> {
    const transport = this.transports[arm];
    if (!transport.connected) throw new NotConnectedError(`the ${arm} arm is not connected`);
    this.#trace(arm, "tx", data);
    await transport.write(data);
  }

  /**
   * Escape hatch: put arbitrary bytes on one arm. For protocol archaeology.
   * Nothing correlates the reply — subscribe to events and `onPacket`.
   */
  sendRaw(arm: ArmName, data: Bytes): Promise<void> {
    return this.#writeRaw(arm, data);
  }

  // -- receiving ----------------------------------------------------------------

  #receive(arm: ArmName, data: Bytes): void {
    this.#trace(arm, "rx", data);
    let packet: Packet;
    try {
      packet = decode(data);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return;
    }
    // Battery is both a reply and an unsolicited push, so a packet can be
    // both: settle the waiting caller first, then let subscribers see it too.
    this.#pending[arm].resolve(packet);
    const event = parseEvent(packet, arm);
    if (event) this.#dispatch(event);
  }

  #lost(arm: ArmName, reason?: string): void {
    this.#pending[arm].failAll(new NotConnectedError(`the ${arm} arm disconnected${reason ? `: ${reason}` : ""}`));
    if (this.#hbTimer) clearTimeout(this.#hbTimer);
    this.#hbTimer = null;
    const event: G1Event = { type: "disconnect", arm, raw: new Uint8Array(0) };
    if (reason) event.reason = reason;
    this.#dispatch(event);
  }

  #dispatch(event: G1Event): void {
    for (const key of [event.type, "*"]) {
      for (const handler of [...(this.#handlers.get(key) ?? [])]) {
        try {
          // One bad handler must not take the notification pump down with it.
          Promise.resolve(handler(event)).catch((error) => this.#handlerFailed(event, error));
        } catch (error) {
          this.#handlerFailed(event, error);
        }
      }
    }
  }

  #handlerFailed(event: G1Event, error: unknown): void {
    console.error(`openg1: handler for "${event.type}" threw:`, error);
  }

  /** Subscribe to one event type, or `"*"` for everything. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void;
  on(type: "*", handler: (event: G1Event) => void | Promise<void>): () => void;
  on(type: string, handler: (event: never) => void | Promise<void>): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    set.add(handler as (event: G1Event) => void);
    this.#handlers.set(type, set);
    return () => set.delete(handler as (event: G1Event) => void);
  }

  /** Resolve with the next event of a type. Rejects on timeout or abort. */
  waitFor<T extends EventType>(
    type: T,
    options: { timeoutMs?: number; signal?: AbortSignal; filter?: (event: EventOf<T>) => boolean } = {},
  ): Promise<EventOf<T>> {
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 30000;
      const cleanup = () => {
        off();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const off = this.on(type, ((event: EventOf<T>) => {
        if (options.filter && !options.filter(event)) return;
        cleanup();
        resolve(event);
      }) as EventHandler<T>);
      const timer = setTimeout(() => {
        cleanup();
        reject(new CommandTimeout(`waitFor(${type})`, timeoutMs, "any"));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(options.signal!.reason instanceof Error ? options.signal!.reason : new Error("aborted"));
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** `for await (const event of session.events())`. Break out of the loop to unsubscribe. */
  events(): AsyncIterableIterator<G1Event> {
    const queue: G1Event[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const off = this.on("*", (event) => {
      queue.push(event);
      wake?.();
    });
    const iterator: AsyncIterableIterator<G1Event> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        while (!queue.length && !done) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
        if (queue.length) return { value: queue.shift()!, done: false };
        return { value: undefined, done: true };
      },
      return: async () => {
        done = true;
        off();
        wake?.();
        return { value: undefined, done: true };
      },
    };
    return iterator;
  }

  // -- heartbeat ----------------------------------------------------------------

  #scheduleHeartbeat(): void {
    if (this.#hbTimer) clearTimeout(this.#hbTimer);
    this.#hbTimer = setTimeout(() => {
      this.#hbTimer = null;
      if (!this.#started) return;
      this.beat()
        .catch(() => {}) // a missed beat is retried on the next tick; a dead link reports itself
        .finally(() => {
          if (this.#started && this.autoHeartbeat) this.#scheduleHeartbeat();
        });
    }, this.heartbeatIntervalMs);
  }

  /** Send one heartbeat by hand (when `autoHeartbeat` is off). */
  beat(): Promise<Response> {
    return this.send(heartbeat(this.hbSeq.next()));
  }

  // -- diagnostics ----------------------------------------------------------------

  /** See every packet in and out. The protocol is still being reverse engineered; a capture is often the whole answer. */
  onPacket(listener: PacketListener): () => void {
    this.#packetListeners.add(listener);
    return () => this.#packetListeners.delete(listener);
  }

  #trace(arm: ArmName, direction: PacketDirection, data: Bytes): void {
    for (const listener of this.#packetListeners) listener(arm, direction, data);
  }
}

/** What `session.exclusive` hands you: sends that assume the lock is already held. */
export interface SessionHandle {
  send(out: Outbound, options?: SendOptions): Promise<Response>;
  writeRaw(arm: ArmName, data: Bytes): Promise<void>;
}

function ignoreCommandFailure(error: unknown): void {
  if (error instanceof CommandTimeout || error instanceof CommandError) return;
  throw error;
}
