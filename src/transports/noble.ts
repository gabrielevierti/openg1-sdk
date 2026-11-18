/**
 * Node transport, on top of noble (`@stoprocent/noble` or `@abandonware/noble`).
 * macOS, Linux, Windows.
 *
 * noble is not a dependency of this package — it compiles native code — so
 * install it yourself and pass it in:
 *
 *     import noble from "@stoprocent/noble";
 *     import { G1 } from "openg1";
 *     import { connectPair } from "openg1/transports/noble";
 *
 *     const g1 = await G1.connect(connectPair(noble));
 */
import { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from "../generated.ts";
import type { Bytes } from "../bytes.ts";
import { DiscoveryError, NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import { BaseTransport, PairFinder, parseDeviceName, type FoundArm, type TransportPair } from "../transport.ts";

export interface NobleCharacteristic {
  uuid: string;
  subscribeAsync(): Promise<void>;
  unsubscribeAsync(): Promise<void>;
  writeAsync(data: Uint8Array, withoutResponse: boolean): Promise<void>;
  on(event: "data", listener: (data: Uint8Array, isNotification: boolean) => void): unknown;
  removeAllListeners(event: "data"): unknown;
}
export interface NoblePeripheral {
  id: string;
  address?: string;
  rssi?: number;
  mtu?: number | null;
  advertisement: { localName?: string };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    services: string[],
    characteristics: string[],
  ): Promise<{ characteristics: NobleCharacteristic[] }>;
  once(event: "disconnect", listener: () => void): unknown;
  removeAllListeners(event: "disconnect"): unknown;
}
export interface Noble {
  state?: string;
  on(event: "discover", listener: (peripheral: NoblePeripheral) => void): unknown;
  on(event: "stateChange", listener: (state: string) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  startScanningAsync(serviceUUIDs?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

export interface NobleOptions {
  scanTimeoutMs?: number;
  channel?: string | number;
  /** Used when noble cannot report the negotiated MTU (it cannot on macOS). Default 247. */
  mtu?: number;
}

const short = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();

export class NobleTransport extends BaseTransport {
  readonly peripheral: NoblePeripheral;
  readonly #fallbackMtu: number;
  #tx: NobleCharacteristic | null = null;
  #rx: NobleCharacteristic | null = null;
  #closing = false;

  constructor(peripheral: NoblePeripheral, name: string, options: NobleOptions = {}) {
    super();
    this.peripheral = peripheral;
    this.name = name;
    this.#fallbackMtu = options.mtu ?? 247;
  }

  get connected(): boolean {
    return this.#tx !== null;
  }
  get maxWrite(): number {
    return Math.max(20, (this.peripheral.mtu || this.#fallbackMtu) - 3);
  }

  async connect(): Promise<void> {
    if (this.#tx) return;
    this.#closing = false;
    try {
      await this.peripheral.connectAsync();
      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [short(SERVICE_UUID)],
        [short(TX_CHAR_UUID), short(RX_CHAR_UUID)],
      );
      const tx = characteristics.find((c) => short(c.uuid) === short(TX_CHAR_UUID));
      const rx = characteristics.find((c) => short(c.uuid) === short(RX_CHAR_UUID));
      if (!tx || !rx) throw new Error("the Nordic UART characteristics are missing — is this really a G1 arm?");
      rx.on("data", (data) => this.emit(new Uint8Array(data)));
      await rx.subscribeAsync();
      this.peripheral.once("disconnect", () => {
        const expected = this.#closing;
        this.#tx = this.#rx = null;
        if (!expected) this.emitDisconnect("peripheral disconnected");
      });
      this.#tx = tx;
      this.#rx = rx;
    } catch (error) {
      await this.peripheral.disconnectAsync().catch(() => {});
      throw new TransportError(`could not connect to ${this.name}: ${(error as Error).message}`, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    this.#rx?.removeAllListeners("data");
    this.#tx = this.#rx = null;
    await this.peripheral.disconnectAsync().catch(() => {});
  }

  async write(data: Bytes): Promise<void> {
    if (!this.#tx) throw new NotConnectedError(`${this.name} is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    try {
      await this.#tx.writeAsync(data, true);
    } catch (error) {
      throw new TransportError(`write to ${this.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

function poweredOn(noble: Noble, timeoutMs: number): Promise<void> {
  if (noble.state === "poweredOn") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener("stateChange", onState as never);
      reject(new DiscoveryError(`Bluetooth adapter is ${noble.state ?? "not ready"}; is Bluetooth on and permitted for this terminal?`));
    }, timeoutMs);
    const onState = (state: string) => {
      if (state !== "poweredOn") return;
      clearTimeout(timer);
      noble.removeListener("stateChange", onState as never);
      resolve();
    };
    noble.on("stateChange", onState);
  });
}

/** Every G1 arm in range, for a `scan` command. */
export async function scan(noble: Noble, timeoutMs = 6000): Promise<FoundArm<NoblePeripheral>[]> {
  await poweredOn(noble, 5000);
  const found = new Map<string, FoundArm<NoblePeripheral>>();
  const onDiscover = (p: NoblePeripheral) => {
    const name = p.advertisement.localName;
    const parsed = parseDeviceName(name);
    if (!parsed) return;
    const arm: FoundArm<NoblePeripheral> = { ...parsed, name: name!, ref: p };
    if (p.rssi !== undefined) arm.rssi = p.rssi;
    found.set(p.id, arm);
  };
  noble.on("discover", onDiscover);
  await noble.startScanningAsync([], true);
  await new Promise((r) => setTimeout(r, timeoutMs));
  await noble.stopScanningAsync().catch(() => {});
  noble.removeListener("discover", onDiscover as never);
  return [...found.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.arm.localeCompare(b.arm));
}

/** Scan until one complete left/right pair has been seen. */
export async function scanPair(
  noble: Noble,
  options: NobleOptions = {},
): Promise<{ left: FoundArm<NoblePeripheral>; right: FoundArm<NoblePeripheral> }> {
  await poweredOn(noble, 5000);
  const finder = new PairFinder<NoblePeripheral>(options.channel);
  const timeoutMs = options.scanTimeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover as never);
      noble.stopScanningAsync().catch(() => {});
    };
    const onDiscover = (p: NoblePeripheral) => {
      const pair = finder.add(p.advertisement.localName, p, p.rssi);
      if (pair) {
        stop();
        resolve(pair);
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(
        new DiscoveryError(
          `no complete pair of G1 arms found in ${timeoutMs} ms (saw: ${finder.seen().join(", ") || "nothing"}). ` +
            `Both arms must be out of the case and not connected to the official app.`,
        ),
      );
    }, timeoutMs);
    noble.on("discover", onDiscover);
    // No service filter: macOS hides service UUIDs from scan results, names are what works everywhere.
    noble.startScanningAsync([], true).catch((error) => {
      stop();
      reject(new DiscoveryError(`scan failed: ${(error as Error).message}`, { cause: error }));
    });
  });
}

/** Scan for a pair and return its two transports, ready for `G1.connect`. */
export async function connectPair(noble: Noble, options: NobleOptions = {}): Promise<TransportPair> {
  const pair = await scanPair(noble, options);
  return {
    left: new NobleTransport(pair.left.ref, pair.left.name, options),
    right: new NobleTransport(pair.right.ref, pair.right.name, options),
  };
}
