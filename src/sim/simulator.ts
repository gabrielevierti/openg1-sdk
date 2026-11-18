/**
 * A pair of glasses that lives in a process instead of on your face.
 *
 * Two emulated arms, the things a wearer does to them, and the picture they
 * would show. The same {@link G1} API runs against this as against hardware:
 *
 *     const sim = new Simulator();
 *     const g1 = await G1.connect(sim.pair());
 *     await g1.display.text("ciao");
 *     console.log(sim.frame.toBlocks());
 *     sim.tap("right");                    // your handlers fire
 *
 * It runs anywhere the SDK does — Node, a browser tab, a phone — because it
 * is the SDK's own code on the other end of an in-memory link.
 */
import { IDLE_TIMEOUT_S, StateEvent } from "../generated.ts";
import type { Bitmap } from "../bitmap.ts";
import type { Bytes } from "../bytes.ts";
import { NotConnectedError, PacketTooLargeError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { makeProfile, safeAreaOf, type DeviceProfile } from "../profile.ts";
import { ARMS, BaseTransport, type Transport, type TransportPair } from "../transport.ts";
import { ArmFirmware } from "./firmware.ts";
import { renderDisplay, type RenderReport } from "./renderer.ts";

export interface SimulatorOptions {
  profile?: Partial<DeviceProfile>;
  /** The MTU the emulated link negotiates. 23 reproduces a failed negotiation. Default 247. */
  mtu?: number;
  /** Delay before each reply, to make races visible. Default 0. */
  latencyMs?: number;
  /**
   * Drop the link after 32 s without a heartbeat, as the firmware does.
   * Off by default so tests and idle sessions do not time out.
   */
  enforceHeartbeat?: boolean;
  /** Stream fake microphone packets while the mic is enabled. Default true. */
  micStream?: boolean;
  /** Channel number in the advertised names. */
  channel?: number;
}

export interface SimulatorSnapshot {
  worn: boolean;
  headUp: boolean;
  attached: Record<ArmName, boolean>;
  battery: Record<ArmName, number>;
  charging: boolean;
  brightness: number;
  autoBrightness: boolean;
  silent: boolean;
  mic: boolean;
  displayOn: boolean;
  /** False when the two lenses would show different things. */
  armsInSync: boolean;
  content: RenderReport;
  profile: DeviceProfile;
  warnings: string[];
  frame: number;
}

type Listener = () => void;

/**
 * The simulator's side of one arm's link. Whoever attaches — the in-process
 * transport, a WebSocket, a TCP socket — gets the arm's notifications and may
 * write packets to it. One consumer at a time, as with a real peripheral.
 */
export class ArmPort {
  readonly arm: ArmName;
  readonly name: string;
  mtu: number;
  #sink: ((data: Bytes) => void) | null = null;
  #drop: ((reason: string) => void) | null = null;
  readonly #sim: Simulator;

  constructor(sim: Simulator, arm: ArmName, name: string, mtu: number) {
    this.#sim = sim;
    this.arm = arm;
    this.name = name;
    this.mtu = mtu;
  }

  get attached(): boolean {
    return this.#sink !== null;
  }

  get maxWrite(): number {
    return this.mtu - 3;
  }

  /** Become this arm's central. Returns a function that detaches. */
  attach(sink: (data: Bytes) => void, onDrop?: (reason: string) => void): () => void {
    if (this.#sink) throw new NotConnectedError(`the ${this.arm} arm already has a connection`);
    this.#sink = sink;
    this.#drop = onDrop ?? null;
    this.#sim._attachmentChanged(this.arm);
    return () => {
      if (this.#sink !== sink) return;
      this.#sink = null;
      this.#drop = null;
      this.#sim._attachmentChanged(this.arm);
    };
  }

  /** Write one packet to the arm, as a BLE write would. */
  write(data: Bytes): void {
    if (!this.#sink) throw new NotConnectedError(`the ${this.arm} arm is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    this.#sim._write(this.arm, data);
  }

  /** Deliver a notification to whoever is attached. */
  notify(data: Bytes): void {
    this.#sink?.(data);
  }

  /** The arm hangs up, as it does on a heartbeat timeout or a reboot. */
  drop(reason: string): void {
    const drop = this.#drop;
    this.#sink = null;
    this.#drop = null;
    this.#sim._attachmentChanged(this.arm);
    drop?.(reason);
  }
}

/** In-process link to one emulated arm. */
class SimTransport extends BaseTransport {
  readonly #port: ArmPort;
  #detach: (() => void) | null = null;

  constructor(port: ArmPort) {
    super();
    this.#port = port;
    this.name = port.name;
  }
  get connected(): boolean {
    return this.#detach !== null;
  }
  get maxWrite(): number {
    return this.#port.maxWrite;
  }
  async connect(): Promise<void> {
    if (this.#detach) return;
    this.#detach = this.#port.attach(
      (data) => this.emit(data),
      (reason) => {
        this.#detach = null;
        this.emitDisconnect(reason);
      },
    );
  }
  async disconnect(): Promise<void> {
    this.#detach?.();
    this.#detach = null;
  }
  async write(data: Bytes): Promise<void> {
    if (!this.#detach) throw new NotConnectedError(`${this.name} is not connected`);
    this.#port.write(data);
  }
}

export class Simulator {
  readonly profile: DeviceProfile;
  readonly left: ArmFirmware;
  readonly right: ArmFirmware;
  readonly ports: Record<ArmName, ArmPort>;
  readonly options: Required<Pick<SimulatorOptions, "latencyMs" | "enforceHeartbeat" | "micStream">>;

  worn = true;
  headUp = false;

  readonly #frameListeners = new Set<Listener>();
  readonly #packetListeners = new Set<(arm: ArmName, direction: "tx" | "rx", data: Bytes) => void>();
  readonly #extraWarnings: string[] = [];
  #frameNo = 0;
  #cache: { revision: string; bitmap: Bitmap; report: RenderReport } | null = null;
  #notifyQueued = false;
  #lastBeat: Record<ArmName, number> = { left: 0, right: 0 };
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #mic: ReturnType<typeof setInterval> | null = null;
  #micSeq = 0;

  constructor(options: SimulatorOptions = {}) {
    this.profile = makeProfile(options.profile);
    this.options = {
      latencyMs: options.latencyMs ?? 0,
      enforceHeartbeat: options.enforceHeartbeat ?? false,
      micStream: options.micStream ?? true,
    };
    const mtu = options.mtu ?? this.profile.mtu;
    const channel = options.channel ?? 42;
    this.left = new ArmFirmware("left");
    this.right = new ArmFirmware("right");
    this.ports = {
      left: new ArmPort(this, "left", `Even G1_${channel}_L_SIM001`, mtu),
      right: new ArmPort(this, "right", `Even G1_${channel}_R_SIM001`, mtu),
    };
    for (const arm of ARMS) this.arm(arm).onChange = () => this.#changed();
  }

  arm(arm: ArmName): ArmFirmware {
    return arm === "left" ? this.left : this.right;
  }

  /** Two in-process transports, ready for `G1.connect`. */
  pair(): TransportPair {
    return { left: new SimTransport(this.ports.left), right: new SimTransport(this.ports.right) };
  }

  /** Stop timers. Call when you are done with a simulator that used heartbeat enforcement or the mic. */
  close(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#mic) clearInterval(this.#mic);
    this.#watchdog = this.#mic = null;
  }

  // -- what the wearer sees ---------------------------------------------------------

  /** True when the panel is lit: worn, and not powered down. */
  get displayOn(): boolean {
    return this.worn && this.left.state.displayPower;
  }

  #render(arm: ArmName): { bitmap: Bitmap; report: RenderReport } {
    const display = this.arm(arm).display;
    const { canvas, report } = renderDisplay(display, { safeArea: safeAreaOf(this.profile), visible: this.displayOn });
    return { bitmap: canvas.bitmap, report };
  }

  #current(): { bitmap: Bitmap; report: RenderReport } {
    const revision = `${this.left.display.revision}:${this.displayOn}`;
    if (!this.#cache || this.#cache.revision !== revision) this.#cache = { revision, ...this.#render("left") };
    return this.#cache;
  }

  /** The panel as pixels: what the wearer would see right now. */
  get frame(): Bitmap {
    return this.#current().bitmap;
  }

  /** The same, for one specific arm — useful when testing that the two agree. */
  frameFor(arm: ArmName): Bitmap {
    return arm === "left" ? this.frame : this.#render(arm).bitmap;
  }

  /** What the renderer noticed about the current screen: overflow, truncation, ink in hidden rows. */
  report(): RenderReport {
    return this.#current().report;
  }

  /** The text currently on screen, as the firmware received it. Empty for bitmap screens. */
  get screenText(): string {
    return this.left.display.kind === "text" ? this.left.display.text : "";
  }

  get armsInSync(): boolean {
    const a = this.left.display;
    const b = this.right.display;
    if (a.kind !== b.kind || a.text !== b.text) return false;
    if (a.kind === "image") {
      const x = a.image!.bits;
      const y = b.image!.bits;
      return x.length === y.length && x.every((v, i) => v === y[i]);
    }
    return true;
  }

  /** Everything the two arms and the renderer complained about, oldest first. */
  get warnings(): string[] {
    const out = [...this.left.warnings, ...this.right.warnings, ...this.#extraWarnings];
    const r = this.report();
    if (r.truncatedLines) out.push(`${r.truncatedLines} line(s) past the fifth: the firmware drops them`);
    if (r.overflowLines.length) out.push(`${r.overflowLines.length} line(s) wider than the panel: the firmware clips them`);
    if (r.hiddenInk) {
      out.push(
        `${r.hiddenInk} lit pixel(s) in the ${this.profile.hiddenTop}/${this.profile.hiddenBottom} hidden rows: invisible on this pair`,
      );
    }
    if (this.left.display.kind !== "none" && this.right.display.kind === "none") {
      out.push("only the left arm has content: the right lens is dark. Send display packets to both arms.");
    }
    return out;
  }

  /** Throw if the current screen would not read correctly on hardware. For tests. */
  assertReadable(): void {
    const problems = this.warnings;
    if (problems.length) throw new Error(`simulator: ${problems.join("; ")}`);
  }

  snapshot(): SimulatorSnapshot {
    return {
      worn: this.worn,
      headUp: this.headUp,
      attached: { left: this.ports.left.attached, right: this.ports.right.attached },
      battery: { left: this.left.state.battery, right: this.right.state.battery },
      charging: this.left.state.charging,
      brightness: this.right.state.brightness,
      autoBrightness: this.right.state.autoBrightness,
      silent: this.left.state.silent,
      mic: this.right.state.micEnabled,
      displayOn: this.displayOn,
      armsInSync: this.armsInSync,
      content: this.report(),
      profile: this.profile,
      warnings: this.warnings.slice(-20),
      frame: this.#frameNo,
    };
  }

  /** Blank both panels and forget warnings, keeping connections and settings. */
  reset(): void {
    this.left.warnings.length = 0;
    this.right.warnings.length = 0;
    this.#extraWarnings.length = 0;
    for (const arm of ARMS) this.arm(arm).resetDisplay();
  }

  /** Called on every change to the picture or the state. Returns an unsubscribe function. */
  onFrame(listener: Listener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** Every packet crossing either link: `tx` is app → glasses. */
  onPacket(listener: (arm: ArmName, direction: "tx" | "rx", data: Bytes) => void): () => void {
    this.#packetListeners.add(listener);
    return () => this.#packetListeners.delete(listener);
  }

  #changed(): void {
    this.#frameNo++;
    if (this.#notifyQueued) return;
    // Coalesce: a bitmap transfer is a hundred packets and one picture.
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of [...this.#frameListeners]) listener();
    });
  }

  // -- what the wearer does -----------------------------------------------------------

  /** Tap a touchbar: 1, 2 or 3 times. */
  tap(arm: ArmName = "right", count: 1 | 2 | 3 = 1): void {
    const sub = { 1: StateEvent.TOUCHBAR_SINGLE_TAP, 2: StateEvent.TOUCHBAR_DOUBLE_TAP, 3: StateEvent.TOUCHBAR_TRIPLE_TAP }[count];
    this.#push(arm, this.arm(arm).stateEvent(sub));
  }

  /** Press and hold a touchbar. On the left arm this is the Even AI trigger. */
  holdStart(arm: ArmName = "left"): void {
    this.#push(arm, this.arm(arm).stateEvent(StateEvent.TOUCHBAR_HOLD_START));
  }

  holdEnd(arm: ArmName = "left"): void {
    this.#push(arm, this.arm(arm).stateEvent(StateEvent.TOUCHBAR_HOLD_END));
  }

  /** Look up past the head-up angle, or back down. */
  lookUp(up = true): void {
    this.headUp = up;
    this.#push("right", this.right.stateEvent(up ? StateEvent.HEAD_UP : StateEvent.HEAD_DOWN));
    this.#changed();
  }

  /** Put the glasses on or take them off. Off blanks the display, as wear detection does. */
  wear(worn = true): void {
    this.worn = worn;
    if (this.left.state.wearDetection) {
      this.#push("left", this.left.stateEvent(worn ? StateEvent.GLASSES_WORN : StateEvent.GLASSES_REMOVED));
    }
    this.#changed();
  }

  /** Set the battery level; the arm pushes a report, as it does periodically. */
  setBattery(percent: number, arm?: ArmName): void {
    for (const a of arm ? [arm] : ARMS) {
      this.arm(a).state.battery = Math.max(0, Math.min(100, Math.round(percent)));
      this.#push(a, this.arm(a).batteryReport());
    }
    this.#changed();
  }

  /** Put the glasses on charge, or take them off. */
  charge(charging = true): void {
    for (const a of ARMS) {
      this.arm(a).state.charging = charging;
      this.#push(a, this.arm(a).stateEvent(StateEvent.CHARGING_STATE, Number(charging)));
    }
    this.#changed();
  }

  /** Open or close the charging case lid. */
  caseLid(open: boolean): void {
    this.#push("right", this.right.stateEvent(open ? StateEvent.CASE_LID_OPEN : StateEvent.CASE_LID_CLOSED));
  }

  /** Inject one microphone packet by hand. */
  audioPacket(data: Bytes, seq?: number): void {
    this.#push("right", this.right.audioPacket(seq ?? this.#micSeq++, data));
  }

  /** Inject arbitrary bytes as a notification from one arm. For testing your handling of unknown events. */
  inject(arm: ArmName, data: Bytes): void {
    this.#push(arm, data);
  }

  #push(arm: ArmName, data: Bytes): void {
    if (!this.ports[arm].attached) return;
    for (const l of this.#packetListeners) l(arm, "rx", data);
    this.ports[arm].notify(data);
  }

  // -- plumbing -------------------------------------------------------------------------

  /**
   * Show what a packet would do without being the device it is sent to. Wrap
   * the transports of real glasses with {@link shadow} and this simulator
   * becomes a live preview of their display.
   */
  mirror(arm: ArmName, data: Bytes): void {
    for (const l of this.#packetListeners) l(arm, "tx", data);
    this.arm(arm).handle(data);
  }

  /** @internal */
  _write(arm: ArmName, data: Bytes): void {
    for (const l of this.#packetListeners) l(arm, "tx", data);
    const firmware = this.arm(arm);
    const before = firmware.state.micEnabled;
    const beats = firmware.state.heartbeats;
    const replies = firmware.handle(data);
    if (firmware.state.heartbeats !== beats) this.#lastBeat[arm] = Date.now();
    if (firmware.state.micEnabled !== before) this.#micChanged();
    const deliver = () => {
      for (const reply of replies) this.#push(arm, reply);
    };
    if (this.options.latencyMs) setTimeout(deliver, this.options.latencyMs);
    else queueMicrotask(deliver);
  }

  /** @internal */
  _attachmentChanged(arm: ArmName): void {
    this.#lastBeat[arm] = Date.now();
    const any = this.ports.left.attached || this.ports.right.attached;
    if (any && this.options.enforceHeartbeat && !this.#watchdog) {
      this.#watchdog = setInterval(() => this.#checkHeartbeats(), 1000);
      unref(this.#watchdog);
    } else if (!any && this.#watchdog) {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
    }
    if (!this.ports.right.attached && this.right.state.micEnabled) {
      this.right.state.micEnabled = false;
      this.#micChanged();
    }
    this.#changed();
  }

  #checkHeartbeats(): void {
    for (const arm of ARMS) {
      if (this.ports[arm].attached && Date.now() - this.#lastBeat[arm] > IDLE_TIMEOUT_S * 1000) {
        this.#extraWarnings.push(`[${arm}] no heartbeat for ${IDLE_TIMEOUT_S} s: the arm dropped the link`);
        this.ports[arm].drop("heartbeat timeout");
      }
    }
  }

  #micChanged(): void {
    if (this.#mic) clearInterval(this.#mic);
    this.#mic = null;
    if (!this.right.state.micEnabled || !this.options.micStream) return;
    const started = Date.now();
    // Ten 20-byte LC3 frames per packet, one packet every 100 ms.
    this.#mic = setInterval(() => {
      if (Date.now() - started > 30000) {
        // The firmware caps a capture at roughly thirty seconds.
        this.right.state.micEnabled = false;
        this.#micChanged();
        this.#changed();
        return;
      }
      const data = new Uint8Array(200);
      for (let i = 0; i < data.length; i++) data[i] = (this.#micSeq * 31 + i * 7) & 0xff;
      this.audioPacket(data);
    }, 100);
    unref(this.#mic);
  }
}

/** Let a Node process exit while a simulator timer is pending. A no-op in browsers. */
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Wrap the transports of real glasses so a simulator shows what they were
 * told to display. Nothing about the real link changes; the simulator only
 * watches the writes. The preview is what the glasses *should* be showing —
 * it cannot know about a packet the radio dropped.
 */
export function shadow(pair: TransportPair, sim: Simulator): TransportPair {
  const wrap = (arm: ArmName, real: Transport): Transport => ({
    get name() {
      return real.name;
    },
    get connected() {
      return real.connected;
    },
    get maxWrite() {
      return real.maxWrite;
    },
    connect: () => real.connect(),
    disconnect: () => real.disconnect(),
    onNotify: (handler) => real.onNotify(handler),
    onDisconnect: (handler) => real.onDisconnect(handler),
    async write(data) {
      await real.write(data);
      sim.mirror(arm, data);
    },
  });
  return { left: wrap("left", pair.left), right: wrap("right", pair.right) };
}
