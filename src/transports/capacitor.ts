/**
 * Capacitor transport, on top of `@capacitor-community/bluetooth-le`. For web
 * apps packaged as native iPhone and Android apps (Ionic, plain Capacitor).
 *
 * The plugin is not a dependency of this package: you pass its `BleClient`.
 *
 *     import { BleClient } from "@capacitor-community/bluetooth-le";
 *     import { G1 } from "openg1";
 *     import { connectPair } from "openg1/transports/capacitor";
 *
 *     const g1 = await G1.connect(connectPair(BleClient));
 */
import { NAME_PREFIX, RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from "../generated.ts";
import type { Bytes } from "../bytes.ts";
import { DiscoveryError, NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import { BaseTransport, PairFinder, type FoundArm, type TransportPair } from "../transport.ts";

export interface CapacitorScanResult {
  device: { deviceId: string; name?: string };
  localName?: string;
  rssi?: number;
}
export interface CapacitorBleClient {
  initialize(options?: Record<string, unknown>): Promise<void>;
  requestLEScan(
    options: { namePrefix?: string; services?: string[]; allowDuplicates?: boolean },
    callback: (result: CapacitorScanResult) => void,
  ): Promise<void>;
  stopLEScan(): Promise<void>;
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void, options?: { timeout?: number }): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  startNotifications(deviceId: string, service: string, characteristic: string, callback: (value: DataView) => void): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
  writeWithoutResponse(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>;
  getMtu?(deviceId: string): Promise<number>;
}

export interface CapacitorOptions {
  scanTimeoutMs?: number;
  channel?: string | number;
  /** Used when the plugin cannot report the negotiated MTU. Default 247. */
  mtu?: number;
}

export class CapacitorTransport extends BaseTransport {
  readonly #ble: CapacitorBleClient;
  readonly #id: string;
  readonly #fallbackMtu: number;
  #mtu = 23;
  #connected = false;
  #closing = false;

  constructor(ble: CapacitorBleClient, found: { id: string; name: string }, options: CapacitorOptions = {}) {
    super();
    this.#ble = ble;
    this.#id = found.id;
    this.name = found.name;
    this.#fallbackMtu = options.mtu ?? 247;
  }

  get connected(): boolean {
    return this.#connected;
  }
  get maxWrite(): number {
    return Math.max(20, this.#mtu - 3);
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#closing = false;
    try {
      await this.#ble.connect(this.#id, () => {
        const expected = this.#closing;
        this.#connected = false;
        if (!expected) this.emitDisconnect("device disconnected");
      });
      await this.#ble.startNotifications(this.#id, SERVICE_UUID, RX_CHAR_UUID, (value) => {
        this.emit(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      });
      this.#mtu = (await this.#ble.getMtu?.(this.#id).catch(() => undefined)) ?? this.#fallbackMtu;
      this.#connected = true;
    } catch (error) {
      await this.#ble.disconnect(this.#id).catch(() => {});
      throw new TransportError(`could not connect to ${this.name}: ${(error as Error).message}`, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    this.#connected = false;
    await this.#ble.stopNotifications(this.#id, SERVICE_UUID, RX_CHAR_UUID).catch(() => {});
    await this.#ble.disconnect(this.#id).catch(() => {});
  }

  async write(data: Bytes): Promise<void> {
    if (!this.#connected) throw new NotConnectedError(`${this.name} is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    try {
      await this.#ble.writeWithoutResponse(
        this.#id,
        SERVICE_UUID,
        TX_CHAR_UUID,
        new DataView(data.buffer, data.byteOffset, data.byteLength),
      );
    } catch (error) {
      throw new TransportError(`write to ${this.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** Scan until one complete left/right pair has been seen. */
export async function scanPair(
  ble: CapacitorBleClient,
  options: CapacitorOptions = {},
): Promise<{ left: FoundArm<string>; right: FoundArm<string> }> {
  await ble.initialize();
  const finder = new PairFinder<string>(options.channel);
  const timeoutMs = options.scanTimeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ble.stopLEScan().catch(() => {});
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DiscoveryError(
              `no complete pair of G1 arms found in ${timeoutMs} ms (saw: ${finder.seen().join(", ") || "nothing"}). ` +
                `Both arms must be out of the case and not connected to the official app.`,
            ),
          ),
        ),
      timeoutMs,
    );
    ble
      .requestLEScan({ namePrefix: NAME_PREFIX }, (result) => {
        const pair = finder.add(result.localName ?? result.device.name, result.device.deviceId, result.rssi);
        if (pair) finish(() => resolve(pair));
      })
      .catch((error) => finish(() => reject(new DiscoveryError(`scan failed: ${(error as Error).message}`, { cause: error }))));
  });
}

/** Scan for a pair and return its two transports, ready for `G1.connect`. */
export async function connectPair(ble: CapacitorBleClient, options: CapacitorOptions = {}): Promise<TransportPair> {
  const pair = await scanPair(ble, options);
  return {
    left: new CapacitorTransport(ble, { id: pair.left.ref, name: pair.left.name }, options),
    right: new CapacitorTransport(ble, { id: pair.right.ref, name: pair.right.name }, options),
  };
}
