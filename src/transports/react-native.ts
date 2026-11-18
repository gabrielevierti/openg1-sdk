/**
 * React Native transport, on top of `react-native-ble-plx`. iPhone and Android.
 *
 * The library is not a dependency of this package: you pass your own
 * `BleManager`, so this file compiles without it and you choose the version.
 *
 *     import { BleManager } from "react-native-ble-plx";
 *     import { G1 } from "openg1";
 *     import { connectPair } from "openg1/transports/react-native";
 *
 *     const manager = new BleManager();
 *     const g1 = await G1.connect(connectPair(manager));
 *
 * You still own permissions: Bluetooth on iOS (`NSBluetoothAlwaysUsageDescription`),
 * `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` on Android 12+.
 */
import { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from "../generated.ts";
import { fromBase64, toBase64, type Bytes } from "../bytes.ts";
import { DiscoveryError, NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import { BaseTransport, PairFinder, type FoundArm, type TransportPair } from "../transport.ts";

interface Subscription {
  remove(): void;
}
export interface BlePlxDevice {
  id: string;
  name?: string | null;
  localName?: string | null;
  rssi?: number | null;
  mtu?: number;
  discoverAllServicesAndCharacteristics(): Promise<unknown>;
  monitorCharacteristicForService(
    service: string,
    characteristic: string,
    listener: (error: unknown, characteristic: { value?: string | null } | null) => void,
  ): Subscription;
  writeCharacteristicWithoutResponseForService(service: string, characteristic: string, base64: string): Promise<unknown>;
  cancelConnection(): Promise<unknown>;
  onDisconnected(listener: (error: unknown, device: unknown) => void): Subscription;
}
export interface BlePlxManager {
  startDeviceScan(
    uuids: string[] | null,
    options: Record<string, unknown> | null,
    listener: (error: unknown, device: BlePlxDevice | null) => void,
  ): unknown;
  stopDeviceScan(): unknown;
  connectToDevice(id: string, options?: { requestMTU?: number; timeout?: number }): Promise<BlePlxDevice>;
}

export interface ReactNativeOptions {
  /** Give up scanning after this long. Default 10 s. */
  scanTimeoutMs?: number;
  /** Pick a pair by channel number when several are in range. */
  channel?: string | number;
  /** MTU to request on Android. iOS negotiates on its own. Default 247. */
  mtu?: number;
}

export class BlePlxTransport extends BaseTransport {
  readonly #manager: BlePlxManager;
  readonly #id: string;
  readonly #requestMtu: number;
  #device: BlePlxDevice | null = null;
  #subs: Subscription[] = [];
  #closing = false;

  constructor(manager: BlePlxManager, found: { id: string; name: string }, options: ReactNativeOptions = {}) {
    super();
    this.#manager = manager;
    this.#id = found.id;
    this.name = found.name;
    this.#requestMtu = options.mtu ?? 247;
  }

  get connected(): boolean {
    return this.#device !== null;
  }
  get maxWrite(): number {
    // iOS reports what it negotiated; an unknown MTU falls back to the BLE minimum.
    return Math.max(20, (this.#device?.mtu ?? 23) - 3);
  }

  async connect(): Promise<void> {
    if (this.#device) return;
    this.#closing = false;
    let device: BlePlxDevice;
    try {
      device = await this.#manager.connectToDevice(this.#id, { requestMTU: this.#requestMtu });
      await device.discoverAllServicesAndCharacteristics();
    } catch (error) {
      throw new TransportError(`could not connect to ${this.name}: ${(error as Error).message}`, { cause: error });
    }
    this.#subs = [
      device.monitorCharacteristicForService(SERVICE_UUID, RX_CHAR_UUID, (error, characteristic) => {
        if (error || !characteristic?.value) return;
        this.emit(fromBase64(characteristic.value));
      }),
      device.onDisconnected(() => {
        const expected = this.#closing;
        this.#teardown();
        if (!expected) this.emitDisconnect("device disconnected");
      }),
    ];
    this.#device = device;
  }

  #teardown(): void {
    for (const s of this.#subs.splice(0)) s.remove();
    this.#device = null;
  }

  async disconnect(): Promise<void> {
    const device = this.#device;
    this.#closing = true;
    this.#teardown();
    await device?.cancelConnection().catch(() => {});
  }

  async write(data: Bytes): Promise<void> {
    if (!this.#device) throw new NotConnectedError(`${this.name} is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    try {
      await this.#device.writeCharacteristicWithoutResponseForService(SERVICE_UUID, TX_CHAR_UUID, toBase64(data));
    } catch (error) {
      throw new TransportError(`write to ${this.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** Scan until one complete left/right pair has been seen. */
export function scanPair(
  manager: BlePlxManager,
  options: ReactNativeOptions = {},
): Promise<{ left: FoundArm<BlePlxDevice>; right: FoundArm<BlePlxDevice> }> {
  return new Promise((resolve, reject) => {
    const finder = new PairFinder<BlePlxDevice>(options.channel);
    const timeoutMs = options.scanTimeoutMs ?? 10000;
    const timer = setTimeout(() => {
      manager.stopDeviceScan();
      reject(
        new DiscoveryError(
          `no complete pair of G1 arms found in ${timeoutMs} ms (saw: ${finder.seen().join(", ") || "nothing"}). ` +
            `Both arms must be out of the case and not connected to the official app.`,
        ),
      );
    }, timeoutMs);
    // No service filter: iOS hides service UUIDs for some advertisements, names are what works everywhere.
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        clearTimeout(timer);
        manager.stopDeviceScan();
        reject(new DiscoveryError(`scan failed: ${(error as Error).message ?? error}`, { cause: error }));
        return;
      }
      if (!device) return;
      const pair = finder.add(device.localName ?? device.name, device, device.rssi ?? undefined);
      if (pair) {
        clearTimeout(timer);
        manager.stopDeviceScan();
        resolve(pair);
      }
    });
  });
}

/** Scan for a pair and return its two transports, ready for `G1.connect`. */
export async function connectPair(manager: BlePlxManager, options: ReactNativeOptions = {}): Promise<TransportPair> {
  const pair = await scanPair(manager, options);
  return {
    left: new BlePlxTransport(manager, { id: pair.left.ref.id, name: pair.left.name }, options),
    right: new BlePlxTransport(manager, { id: pair.right.ref.id, name: pair.right.name }, options),
  };
}
