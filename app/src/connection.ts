/**
 * The link to the glasses, wherever the app is running.
 *
 *   native app (iPhone, Android)   the Capacitor Bluetooth plugin: one scan finds both arms
 *   browser (Chrome on Android)    Web Bluetooth: the user picks each arm from a chooser
 *   anywhere                       a simulator — built in, or one running on your computer
 *
 * Every link is wrapped so a preview simulator sees what was sent: the app
 * can always show what the glasses are displaying.
 */
import { BleClient } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";
import { G1, makeProfile, type DeviceProfile, type TransportPair } from "openg1";
import { shadow, Simulator } from "openg1/sim";
import { connectPair } from "openg1/transports/capacitor";
import { WebBluetoothPairing, webBluetoothAvailable } from "openg1/transports/web-bluetooth";
import { connectSimulator } from "openg1/transports/ws";

export type LinkKind = "glasses" | "simulator";
export type LinkState = "idle" | "connecting" | "connected" | "reconnecting";

export interface Battery {
  left: number;
  right: number;
}

export class Connection {
  g1: G1 | null = null;
  kind: LinkKind | null = null;
  state: LinkState = "idle";
  message = "";
  battery: Battery | null = null;
  firmware = "";
  names: string[] = [];
  /** What the glasses are showing. For a simulator link this *is* the pair. */
  preview: Simulator;
  /** True when `preview` is the device itself, so the app may offer wearer controls. */
  simulated = false;

  #pairing: WebBluetoothPairing | null = null;
  #profile: DeviceProfile;
  #wanted = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #last: (() => Promise<TransportPair>) | null = null;
  readonly #changed: () => void;
  readonly #onLost: () => void;
  readonly #onReady: (g1: G1) => void;
  autoReconnect = true;

  constructor(profile: Partial<DeviceProfile>, hooks: { changed(): void; lost(): void; ready(g1: G1): void }) {
    this.#profile = makeProfile(profile);
    this.#changed = hooks.changed;
    this.#onLost = hooks.lost;
    this.#onReady = hooks.ready;
    this.preview = this.#newPreview();
  }

  get native(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Can this device reach real glasses at all? */
  get bluetoothAvailable(): boolean {
    return this.native || webBluetoothAvailable();
  }

  /** In a browser the user picks each arm separately; this is the one still missing. */
  get missingArm(): "left" | "right" | null {
    return this.#pairing?.missing ?? null;
  }

  #newPreview(): Simulator {
    const sim = new Simulator({ profile: this.#profile, micStream: false });
    sim.onFrame(() => this.#changed());
    return sim;
  }

  /** The safe area changed: rebuild the preview and tell a live connection. */
  setProfile(profile: Partial<DeviceProfile>): void {
    this.#profile = makeProfile(profile);
    this.g1?.display.setSafeArea(this.#profile.hiddenTop, this.#profile.hiddenBottom);
    if (!this.g1) this.preview = this.#newPreview();
    this.#changed();
  }

  /**
   * Connect to real glasses. Natively this scans and connects in one go. In a
   * browser it must be called from a tap, once per arm, until it returns true.
   */
  async connectGlasses(): Promise<boolean> {
    if (this.native) {
      await this.#open("glasses", () => connectPair(BleClient, { scanTimeoutMs: 12000 }));
      return true;
    }
    this.#pairing ??= new WebBluetoothPairing();
    const pairing = this.#pairing;
    try {
      await pairing.request();
    } catch (error) {
      if ((error as Error).name !== "NotFoundError") this.message = (error as Error).message;
      this.#changed();
      return false;
    }
    if (!pairing.complete) {
      this.message = `Now choose the ${pairing.missing} arm.`;
      this.#changed();
      return false;
    }
    await this.#open("glasses", async () => pairing.pair());
    return true;
  }

  /** Connect to a simulator: the one built into the app, or one at a ws:// address. */
  async connectSimulator(url = ""): Promise<void> {
    if (url) return this.#open("simulator", async () => connectSimulator(url));
    this.preview = this.#newPreview();
    const sim = this.preview;
    await this.#open("simulator", async () => sim.pair(), true);
  }

  async #open(kind: LinkKind, makePair: () => Promise<TransportPair>, direct = false): Promise<void> {
    await this.#close();
    this.#wanted = true;
    this.#last = direct ? null : makePair;
    this.kind = kind;
    this.state = "connecting";
    this.message = kind === "glasses" ? "Looking for your glasses…" : "Starting the simulator…";
    this.#changed();
    try {
      await this.#establish(await makePair(), direct);
    } catch (error) {
      this.state = "idle";
      this.kind = null;
      this.#wanted = false;
      this.message = (error as Error).message;
      this.#pairing = null;
      this.#changed();
      throw error;
    }
  }

  async #establish(pair: TransportPair, direct: boolean): Promise<void> {
    if (!direct) this.preview = this.#newPreview();
    this.simulated = direct;
    const g1 = await G1.connect(direct ? pair : shadow(pair, this.preview), { profile: this.#profile });
    this.g1 = g1;
    this.names = [g1.session.transports.left.name, g1.session.transports.right.name];
    this.state = "connected";
    this.message = "";
    g1.on("disconnect", () => this.#lost(g1));
    g1.on("battery", (event) => {
      this.battery = { left: this.battery?.left ?? event.percent, right: this.battery?.right ?? event.percent, [event.arm]: event.percent };
      this.#changed();
    });
    this.#changed();
    // Nice to have, never a reason to fail the connection.
    await this.refresh().catch(() => {});
    this.#onReady(g1);
  }

  /** Re-read battery and firmware. */
  async refresh(): Promise<void> {
    if (!this.g1) return;
    const battery = await this.g1.info.battery();
    this.battery = { left: battery.left, right: battery.right };
    if (!this.firmware) this.firmware = (await this.g1.info.firmware()).version;
    this.#changed();
  }

  #lost(g1: G1): void {
    if (this.g1 !== g1) return;
    this.g1 = null;
    this.#onLost();
    void g1.disconnect().catch(() => {});
    if (this.#wanted && this.autoReconnect && this.#last && this.native) {
      this.state = "reconnecting";
      this.message = "Connection lost. Reconnecting…";
      this.#changed();
      this.#scheduleRetry(2000);
      return;
    }
    this.state = "idle";
    this.kind = null;
    this.#pairing = null;
    this.message = "The glasses disconnected.";
    this.#changed();
  }

  #scheduleRetry(delayMs: number): void {
    this.#retry = setTimeout(async () => {
      if (!this.#wanted || !this.#last) return;
      try {
        await this.#establish(await this.#last(), false);
      } catch {
        if (this.#wanted) this.#scheduleRetry(Math.min(delayMs * 2, 30000));
      }
    }, delayMs);
  }

  async #close(): Promise<void> {
    this.#wanted = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const g1 = this.g1;
    this.g1 = null;
    await g1?.disconnect().catch(() => {});
  }

  async disconnect(): Promise<void> {
    await this.#close();
    this.state = "idle";
    this.kind = null;
    this.simulated = false;
    this.battery = null;
    this.firmware = "";
    this.message = "";
    this.#pairing = null;
    this.preview = this.#newPreview();
    this.#changed();
  }
}
