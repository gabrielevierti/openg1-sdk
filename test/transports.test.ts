/**
 * The BLE adapters against fakes shaped like each library's API, with the
 * simulator behind them. This proves the adapters wire the SDK to that shape
 * correctly; it cannot prove the libraries behave as documented on a real
 * phone, which is why the README calls these untested on hardware.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscoveryError, fromBase64, G1, PairFinder, parseDeviceName, RX_CHAR_UUID, SERVICE_UUID, toBase64, TX_CHAR_UUID } from "../src/index.ts";
import { Simulator, type ArmPort } from "../src/sim/index.ts";
import * as capacitor from "../src/transports/capacitor.ts";
import * as noble from "../src/transports/noble.ts";
import * as rn from "../src/transports/react-native.ts";
import { WebBluetoothPairing, type WebBluetoothDevice } from "../src/transports/web-bluetooth.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function exercise(g1: G1, sim: Simulator): Promise<void> {
  await g1.display.text("ciao");
  assert.equal(sim.screenText, "ciao");
  assert.equal(sim.armsInSync, true);
  const result = await g1.display.draw((c) => c.rect(4, 4, 568, 128, { radius: 12 }), { crcDelayMs: 0 });
  assert.equal(result.ok, true);
  const tapped = g1.waitFor("touch", { timeoutMs: 500 });
  sim.tap("left", 2);
  assert.deepEqual([(await tapped).arm, (await tapped).gesture], ["left", "double_tap"]);
  assert.equal((await g1.info.battery()).left, 87);
}

test("device names parse and pairs are matched by channel", () => {
  assert.deepEqual(parseDeviceName("Even G1_42_L_ABC123"), { arm: "left", channel: "42", serial: "ABC123" });
  assert.deepEqual(parseDeviceName("Even G1_7_R_S110LAAL103842"), { arm: "right", channel: "7", serial: "S110LAAL103842" });
  assert.equal(parseDeviceName("Some Headphones"), null);
  assert.equal(parseDeviceName(undefined), null);
  const finder = new PairFinder<string>();
  assert.equal(finder.add("Even G1_42_L_A", "a"), null);
  assert.equal(finder.add("Even G1_13_R_B", "b"), null, "an arm of another pair does not complete this one");
  assert.equal(finder.add("JBL Flip", "x"), null);
  const pair = finder.add("Even G1_42_R_A", "c", -50);
  assert.deepEqual([pair?.left.ref, pair?.right.ref, pair?.right.rssi], ["a", "c", -50]);
  assert.equal(new PairFinder<string>(13).add("Even G1_42_L_A", "a"), null);
});

// --- Web Bluetooth ---------------------------------------------------------------------

function fakeWebBluetoothDevice(port: ArmPort): WebBluetoothDevice & { drop(): void } {
  const device = new EventTarget() as WebBluetoothDevice & { drop(): void };
  const rx = Object.assign(new EventTarget(), {
    value: null as DataView | null,
    startNotifications: async () => {},
    stopNotifications: async () => {},
    writeValueWithoutResponse: async () => {},
  });
  let detach: (() => void) | null = null;
  let busy = false;
  const tx = Object.assign(new EventTarget(), {
    startNotifications: async () => {},
    stopNotifications: async () => {},
    writeValueWithoutResponse: async (value: BufferSource) => {
      // Chrome rejects overlapping GATT operations on one device.
      if (busy) throw new Error("GATT operation already in progress.");
      busy = true;
      await tick(0);
      busy = false;
      port.write(new Uint8Array(value as ArrayBuffer));
    },
  });
  const gatt = {
    connected: false,
    async connect() {
      detach = port.attach((data) => {
        rx.value = new DataView(data.buffer, data.byteOffset, data.byteLength);
        rx.dispatchEvent(new Event("characteristicvaluechanged"));
      });
      gatt.connected = true;
      return gatt;
    },
    disconnect() {
      detach?.();
      detach = null;
      gatt.connected = false;
    },
    async getPrimaryService(uuid: string) {
      assert.equal(uuid, SERVICE_UUID);
      return { getCharacteristic: async (c: string) => (c === TX_CHAR_UUID ? tx : c === RX_CHAR_UUID ? rx : assert.fail(c)) };
    },
  };
  Object.assign(device, { id: port.name, name: port.name, gatt });
  device.drop = () => {
    gatt.disconnect();
    device.dispatchEvent(new Event("gattserverdisconnected"));
  };
  return device;
}

test("Web Bluetooth: two choosers make a pair, writes are serialised, a dropped link is reported", async () => {
  const sim = new Simulator();
  const devices = [fakeWebBluetoothDevice(sim.ports.right), fakeWebBluetoothDevice(sim.ports.left)];
  const requests: unknown[] = [];
  const pairing = new WebBluetoothPairing({
    bluetooth: {
      requestDevice: async (options) => {
        requests.push(options);
        return devices[requests.length - 1]!;
      },
    },
  });
  assert.equal(pairing.missing, "left");
  assert.throws(() => pairing.pair(), DiscoveryError);
  await pairing.request(); // the user happens to pick the right arm first
  assert.equal(pairing.complete, false);
  assert.equal(pairing.missing, "left");
  await pairing.request();
  assert.equal(pairing.complete, true);
  assert.deepEqual(requests[0], { filters: [{ namePrefix: "Even G1_" }], optionalServices: [SERVICE_UUID] });

  const g1 = await G1.connect(pairing.pair());
  assert.equal(g1.session.transports.left.name, "Even G1_42_L_SIM001");
  await exercise(g1, sim);
  // Unawaited back-to-back writes must not overlap on the device.
  await Promise.all([g1.session.sendRaw("left", Uint8Array.from([0x2c, 0x01])), g1.session.sendRaw("left", Uint8Array.from([0x2c, 0x01]))]);

  const lost = g1.waitFor("disconnect", { timeoutMs: 500 });
  devices[1]!.drop();
  assert.equal((await lost).arm, "left");
  await g1.disconnect();
});

test("Web Bluetooth: arms of two different pairs, and things that are not arms, are refused", async () => {
  const pairing = new WebBluetoothPairing({ bluetooth: { requestDevice: async () => assert.fail() } });
  const device = (name: string) => Object.assign(new EventTarget(), { id: name, name }) as WebBluetoothDevice;
  pairing.add(device("Even G1_42_L_AAA"));
  assert.throws(() => pairing.add(device("Even G1_13_R_BBB")), /two different pairs/);
  assert.throws(() => pairing.add(device("AirPods")), /not a G1 arm/);
  await assert.rejects(new WebBluetoothPairing().request(), /Web Bluetooth is not available/);
});

// --- react-native-ble-plx ----------------------------------------------------------------

function fakeBlePlx(sim: Simulator, mtu = 185) {
  const log: string[] = [];
  const device = (port: ArmPort): rn.BlePlxDevice & { drop(): void } => {
    let detach: (() => void) | null = null;
    let onData: ((error: unknown, c: { value?: string } | null) => void) | null = null;
    let onGone: ((error: unknown, d: unknown) => void) | null = null;
    return {
      id: `id-${port.arm}`,
      name: null,
      localName: port.name,
      rssi: -60,
      mtu,
      async discoverAllServicesAndCharacteristics() {
        port.mtu = mtu;
        detach = port.attach((data) => onData?.(null, { value: toBase64(data) }));
      },
      monitorCharacteristicForService(service, characteristic, listener) {
        assert.deepEqual([service, characteristic], [SERVICE_UUID, RX_CHAR_UUID]);
        onData = listener;
        return { remove: () => (onData = null) };
      },
      async writeCharacteristicWithoutResponseForService(service, characteristic, base64) {
        assert.deepEqual([service, characteristic], [SERVICE_UUID, TX_CHAR_UUID]);
        port.write(fromBase64(base64));
      },
      async cancelConnection() {
        detach?.();
        log.push(`cancel ${port.arm}`);
      },
      onDisconnected(listener) {
        onGone = listener;
        return { remove: () => (onGone = null) };
      },
      drop() {
        detach?.();
        onGone?.(null, this);
      },
    };
  };
  const devices = { left: device(sim.ports.left), right: device(sim.ports.right) };
  const manager: rn.BlePlxManager = {
    startDeviceScan(_uuids, _options, listener) {
      log.push("scan");
      setTimeout(() => {
        listener(null, { ...devices.right, localName: "Someone's Watch" } as rn.BlePlxDevice);
        listener(null, devices.right);
        listener(null, devices.left);
      }, 1);
    },
    stopDeviceScan: () => log.push("stop"),
    async connectToDevice(id, options) {
      log.push(`connect ${id} mtu=${options?.requestMTU}`);
      return id === "id-left" ? devices.left : devices.right;
    },
  };
  return { manager, devices, log };
}

test("react-native-ble-plx: scan, connect left first, base64 both ways, chunk size follows the negotiated MTU", async () => {
  const sim = new Simulator();
  const { manager, devices, log } = fakeBlePlx(sim, 185);
  const g1 = await G1.connect(rn.connectPair(manager));
  assert.deepEqual(log, ["scan", "stop", "connect id-left mtu=247", "connect id-right mtu=247"]);
  assert.equal(g1.session.transports.left.maxWrite, 182);
  await exercise(g1, sim);
  const result = await g1.display.draw((c) => c.circle(288, 68, 40), { crcDelayMs: 0 });
  assert.equal(result.chunkSize, 176, "an iPhone-sized MTU still carries a bitmap, in smaller chunks");
  const lost = g1.waitFor("disconnect", { timeoutMs: 500 });
  devices.right.drop();
  assert.equal((await lost).arm, "right");
  await g1.disconnect();
  assert.ok(log.includes("cancel left"));
});

test("react-native-ble-plx: an incomplete pair times out saying what was seen", async () => {
  const manager: rn.BlePlxManager = {
    startDeviceScan(_u, _o, listener) {
      setTimeout(() => listener(null, { id: "x", localName: "Even G1_42_L_AAA" } as rn.BlePlxDevice), 1);
    },
    stopDeviceScan() {},
    connectToDevice: async () => assert.fail(),
  };
  await assert.rejects(rn.scanPair(manager, { scanTimeoutMs: 30 }), /saw: Even G1_42_L_AAA/);
});

// --- Capacitor -----------------------------------------------------------------------------

test("Capacitor bluetooth-le: scan by name prefix, DataView both ways", async () => {
  const sim = new Simulator();
  const detach = new Map<string, () => void>();
  const drops = new Map<string, (id: string) => void>();
  const portOf = (id: string) => (id === "L" ? sim.ports.left : sim.ports.right);
  const calls: string[] = [];
  const ble: capacitor.CapacitorBleClient = {
    async initialize() {
      calls.push("initialize");
    },
    async requestLEScan(options, callback) {
      calls.push(`scan ${options.namePrefix}`);
      setTimeout(() => {
        callback({ device: { deviceId: "L", name: sim.ports.left.name }, rssi: -50 });
        callback({ device: { deviceId: "R" }, localName: sim.ports.right.name });
      }, 1);
    },
    async stopLEScan() {
      calls.push("stop");
    },
    async connect(id, onDisconnect) {
      calls.push(`connect ${id}`);
      if (onDisconnect) drops.set(id, onDisconnect);
    },
    async disconnect(id) {
      detach.get(id)?.();
    },
    async startNotifications(id, service, characteristic, callback) {
      assert.deepEqual([service, characteristic], [SERVICE_UUID, RX_CHAR_UUID]);
      detach.set(id, portOf(id).attach((data) => callback(new DataView(data.buffer, data.byteOffset, data.byteLength))));
    },
    async stopNotifications() {},
    async writeWithoutResponse(id, service, characteristic, value) {
      assert.deepEqual([service, characteristic], [SERVICE_UUID, TX_CHAR_UUID]);
      portOf(id).write(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async getMtu() {
      return 247;
    },
  };
  const g1 = await G1.connect(capacitor.connectPair(ble));
  assert.deepEqual(calls, ["initialize", "scan Even G1_", "stop", "connect L", "connect R"]);
  assert.equal(g1.session.transports.right.maxWrite, 244);
  await exercise(g1, sim);
  const lost = g1.waitFor("disconnect", { timeoutMs: 500 });
  detach.get("L")!();
  drops.get("L")!("L");
  assert.equal((await lost).arm, "left");
  await g1.disconnect();
});

// --- noble -----------------------------------------------------------------------------------

test("noble: waits for the adapter, scans by name, short UUIDs, write without response", async () => {
  const sim = new Simulator();
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const peripheral = (port: ArmPort): noble.NoblePeripheral & { drop(): void } => {
    let detach: (() => void) | null = null;
    let onData: ((data: Uint8Array, n: boolean) => void) | null = null;
    let onGone: (() => void) | null = null;
    const chars: noble.NobleCharacteristic[] = [
      {
        uuid: "6e400002b5a3f393e0a9e50e24dcca9e",
        subscribeAsync: async () => assert.fail("TX is not subscribed to"),
        unsubscribeAsync: async () => {},
        writeAsync: async (data, withoutResponse) => {
          assert.equal(withoutResponse, true);
          port.write(new Uint8Array(data));
        },
        on: () => {},
        removeAllListeners: () => {},
      },
      {
        uuid: "6e400003b5a3f393e0a9e50e24dcca9e",
        subscribeAsync: async () => {
          detach = port.attach((data) => onData?.(data, true));
        },
        unsubscribeAsync: async () => {},
        writeAsync: async () => assert.fail("RX is not written to"),
        on: (_e, l) => (onData = l),
        removeAllListeners: () => (onData = null),
      },
    ];
    return {
      id: port.arm,
      rssi: -40,
      mtu: null, // noble cannot report it on macOS
      advertisement: { localName: port.name },
      connectAsync: async () => {},
      disconnectAsync: async () => {
        detach?.();
      },
      discoverSomeServicesAndCharacteristicsAsync: async (services, characteristics) => {
        assert.deepEqual(services, ["6e400001b5a3f393e0a9e50e24dcca9e"]);
        assert.equal(characteristics.length, 2);
        return { characteristics: chars };
      },
      once: (_e, l) => (onGone = l),
      removeAllListeners: () => (onGone = null),
      drop() {
        detach?.();
        onGone?.();
      },
    };
  };
  const peripherals = [peripheral(sim.ports.left), peripheral(sim.ports.right)];
  const fake: noble.Noble & { state: string } = {
    state: "unknown",
    on(event: string, listener: (...a: any[]) => void) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener as never);
    },
    async startScanningAsync() {
      setTimeout(() => {
        for (const l of [...(listeners.get("discover") ?? [])]) {
          l({ id: "tv", advertisement: { localName: "Living Room TV" } });
          l(peripherals[0]);
          l(peripherals[1]);
        }
      }, 1);
    },
    async stopScanningAsync() {},
  };
  setTimeout(() => {
    fake.state = "poweredOn";
    for (const l of [...(listeners.get("stateChange") ?? [])]) l("poweredOn");
  }, 5);

  const g1 = await G1.connect(noble.connectPair(fake));
  assert.equal(g1.session.transports.left.maxWrite, 244, "falls back to the G1's usual MTU when noble reports none");
  assert.equal(listeners.get("discover")?.size, 0, "scan listener removed");
  await exercise(g1, sim);
  const lost = g1.waitFor("disconnect", { timeoutMs: 500 });
  peripherals[1]!.drop();
  assert.equal((await lost).arm, "right");
  await g1.disconnect();

  const arms = await noble.scan(fake, 20);
  assert.deepEqual(arms.map((a) => `${a.arm}:${a.channel}`), ["left:42", "right:42"]);
});
