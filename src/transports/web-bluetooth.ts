/**
 * Web Bluetooth transport: real glasses from a web page.
 *
 * Works in Chrome and Edge on Android, macOS, Windows, Linux and ChromeOS, and
 * on iPhone inside a Web Bluetooth browser such as Bluefy (Safari does not
 * implement Web Bluetooth). The page must be served over https or from
 * localhost.
 *
 * Each arm is a separate peripheral, and the browser only shows its device
 * chooser in response to a tap — so pairing is two taps, one per arm:
 *
 *     const arms = new WebBluetoothPairing();
 *     button.onclick = async () => {
 *       await arms.request();                 // chooser: pick an arm
 *       if (arms.complete) g1 = await G1.connect(arms.pair());
 *     };
 *
 * Close the official Even app first: an arm accepts one central at a time.
 */
import { NAME_PREFIX, RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from "../generated.ts";
import type { Bytes } from "../bytes.ts";
import { DiscoveryError, NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { BaseTransport, parseDeviceName, type TransportPair } from "../transport.ts";

// The slice of the Web Bluetooth API this file uses, so no extra typings are needed.
interface BtCharacteristic extends EventTarget {
  value?: DataView | null;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}
interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>;
}
interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BtService>;
}
export interface WebBluetoothDevice extends EventTarget {
  id: string;
  name?: string | null;
  gatt?: BtServer | null;
}
export interface WebBluetooth {
  requestDevice(options: {
    filters: { namePrefix?: string; services?: string[] }[];
    optionalServices?: string[];
  }): Promise<WebBluetoothDevice>;
  getDevices?(): Promise<WebBluetoothDevice[]>;
}

export interface WebBluetoothOptions {
  /**
   * The MTU to assume. Web Bluetooth does not report the negotiated value;
   * the G1 settles on 247 with every central observed so far. Lower it if
   * bitmap transfers fail their CRC on your platform.
   */
  mtu?: number;
  /** Defaults to `navigator.bluetooth`. */
  bluetooth?: WebBluetooth;
}

function bluetoothOf(options: WebBluetoothOptions): WebBluetooth {
  const bt = options.bluetooth ?? (globalThis.navigator as { bluetooth?: WebBluetooth } | undefined)?.bluetooth;
  if (!bt) {
    throw new TransportError(
      "Web Bluetooth is not available here. Use Chrome or Edge (on iPhone, a Web Bluetooth browser such as Bluefy), " +
        "and serve the page over https or from localhost.",
    );
  }
  return bt;
}

export class WebBluetoothTransport extends BaseTransport {
  readonly device: WebBluetoothDevice;
  readonly arm: ArmName | null;
  readonly #mtu: number;
  #tx: BtCharacteristic | null = null;
  #rx: BtCharacteristic | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;

  constructor(device: WebBluetoothDevice, options: WebBluetoothOptions = {}) {
    super();
    this.device = device;
    this.name = device.name ?? "?";
    this.arm = parseDeviceName(device.name)?.arm ?? null;
    this.#mtu = options.mtu ?? 247;
  }

  get connected(): boolean {
    return this.#tx !== null && !!this.device.gatt?.connected;
  }
  get maxWrite(): number {
    return this.#mtu - 3;
  }

  readonly #onValue = (event: Event): void => {
    const value = (event.target as BtCharacteristic).value;
    if (value) this.emit(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  };

  readonly #onGone = (): void => {
    const expected = this.#closing;
    this.#tx = this.#rx = null;
    if (!expected) this.emitDisconnect("gatt server disconnected");
  };

  async connect(): Promise<void> {
    if (this.connected) return;
    const gatt = this.device.gatt;
    if (!gatt) throw new TransportError(`${this.name} exposes no GATT server`);
    this.#closing = false;
    try {
      const server = await gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const tx = await service.getCharacteristic(TX_CHAR_UUID);
      const rx = await service.getCharacteristic(RX_CHAR_UUID);
      rx.addEventListener("characteristicvaluechanged", this.#onValue);
      await rx.startNotifications();
      this.device.addEventListener("gattserverdisconnected", this.#onGone);
      this.#tx = tx;
      this.#rx = rx;
    } catch (error) {
      gatt.disconnect();
      throw new TransportError(
        `could not connect to ${this.name}: ${(error as Error).message}. ` +
          `Is the official Even app still connected? An arm accepts one central at a time.`,
        { cause: error },
      );
    }
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    this.#rx?.removeEventListener("characteristicvaluechanged", this.#onValue);
    this.device.removeEventListener("gattserverdisconnected", this.#onGone);
    this.#tx = this.#rx = null;
    this.device.gatt?.disconnect();
  }

  write(data: Bytes): Promise<void> {
    if (!this.#tx || !this.device.gatt?.connected) return Promise.reject(new NotConnectedError(`${this.name} is not connected`));
    if (data.length > this.maxWrite) return Promise.reject(new PacketTooLargeError(data.length, this.maxWrite));
    // One GATT operation at a time per device, or the browser throws "operation already in progress".
    const tx = this.#tx;
    const run = this.#queue.then(() => tx.writeValueWithoutResponse(data as BufferSource));
    this.#queue = run.catch(() => {});
    return run.catch((error) => {
      throw new TransportError(`write to ${this.name} failed: ${(error as Error).message}`, { cause: error });
    });
  }
}

/**
 * Collects the two arms across two user gestures. Call {@link request} from a
 * click handler until {@link complete}; then hand {@link pair} to `G1.connect`.
 */
export class WebBluetoothPairing {
  left: WebBluetoothTransport | null = null;
  right: WebBluetoothTransport | null = null;
  readonly #options: WebBluetoothOptions;

  constructor(options: WebBluetoothOptions = {}) {
    this.#options = options;
  }

  get complete(): boolean {
    return this.left !== null && this.right !== null;
  }

  /** Which arm is still missing, for the label on your button. */
  get missing(): ArmName | null {
    return !this.left ? "left" : !this.right ? "right" : null;
  }

  /** Show the browser's device chooser. Must be called from a user gesture. */
  async request(): Promise<WebBluetoothTransport> {
    const device = await bluetoothOf(this.#options).requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [SERVICE_UUID],
    });
    return this.add(device);
  }

  /** Add a device you obtained yourself. */
  add(device: WebBluetoothDevice): WebBluetoothTransport {
    const parsed = parseDeviceName(device.name);
    if (!parsed) {
      throw new DiscoveryError(`"${device.name ?? "unnamed device"}" is not a G1 arm (expected a name like Even G1_42_L_ABC123)`);
    }
    const other = parsed.arm === "left" ? this.right : this.left;
    const otherChannel = parseDeviceName(other?.name)?.channel;
    if (otherChannel !== undefined && otherChannel !== parsed.channel) {
      throw new DiscoveryError(
        `${device.name} is on channel ${parsed.channel} but ${other!.name} is on ${otherChannel}: these are arms of two different pairs`,
      );
    }
    const transport = new WebBluetoothTransport(device, this.#options);
    this[parsed.arm] = transport;
    return transport;
  }

  /**
   * Arms this origin was already granted, without a chooser. Needs
   * `navigator.bluetooth.getDevices`, which Chrome ships behind a flag on
   * some platforms; returns false when it is missing or finds no full pair.
   */
  async restore(): Promise<boolean> {
    const bt = bluetoothOf(this.#options);
    if (!bt.getDevices) return false;
    for (const device of await bt.getDevices()) {
      if (parseDeviceName(device.name)) {
        try {
          this.add(device);
        } catch {
          /* an arm of another pair */
        }
      }
    }
    return this.complete;
  }

  pair(): TransportPair {
    if (!this.left || !this.right) {
      throw new DiscoveryError(`the ${this.missing} arm has not been chosen yet; call request() again from a click`);
    }
    return { left: this.left, right: this.right };
  }
}

/** True when this browser can talk to the glasses directly. */
export function webBluetoothAvailable(): boolean {
  return !!(globalThis.navigator as { bluetooth?: unknown } | undefined)?.bluetooth;
}
