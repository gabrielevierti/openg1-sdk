# Platforms

The SDK is pure TypeScript and knows nothing about radios. A **transport** carries packets to one arm; a pair of them is what `G1.connect` takes. Pick the one for where your code runs.

```ts
const g1 = await G1.connect(pair);     // pair: { left: Transport, right: Transport }
```

Before any of these: **close the official Even app** (an arm accepts one connection at a time) and take the glasses out of the case.

Status, honestly: the adapters below are tested against stand-ins shaped like each library, with the simulator behind them. None has been run on hardware from this codebase yet. The Python SDK, which sends the same bytes, has.

## Browser: Chrome, Edge, Android

Web Bluetooth. The page must be served over https or from localhost. Each arm is its own device and the browser only shows its chooser in response to a tap, so pairing takes two taps.

```ts
import { G1, WebBluetoothPairing } from "openg1/browser";      // or dist/openg1.browser.js in a <script type="module">

const pairing = new WebBluetoothPairing();
button.onclick = async () => {
  await pairing.request();                       // chooser, filtered to "Even G1_…"
  if (pairing.complete) g1 = await G1.connect(pairing.pair());
  else label.textContent = `Now choose the ${pairing.missing} arm`;
};
```

A complete page: [`examples/phone/web-bluetooth.html`](../examples/phone/web-bluetooth.html). The simulator page's **Real glasses** tab does the same and adds the playground.

Web Bluetooth does not report the negotiated MTU. The transport assumes 247, which is what the G1 settles on with the centrals observed so far; pass `new WebBluetoothPairing({ mtu: 185 })` if bitmap transfers fail their CRC.

## iPhone

Safari does not implement Web Bluetooth. Three routes:

1. **A Web Bluetooth browser** such as Bluefy, with the same page as above. No app to build.
2. **React Native** (below).
3. **Capacitor** (below), if your app is a web app in a native shell.

For a native Swift app there is no Swift port of the protocol in this repository. Either talk to the hub over HTTP ([`docs/HUB.md`](HUB.md)), or port the protocol layer: `protocol/vectors.json` and `test/fixtures/python-parity.json` are the contract a port must reproduce.

## React Native — iPhone and Android

```sh
npm install openg1 react-native-ble-plx
```

```ts
import { BleManager } from "react-native-ble-plx";
import { G1 } from "openg1";
import { connectPair } from "openg1/transports/react-native";

const manager = new BleManager();
const g1 = await G1.connect(connectPair(manager, { scanTimeoutMs: 10000 }));
```

You declare the permissions: `NSBluetoothAlwaysUsageDescription` on iOS; `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` on Android 12+. The transport requests an MTU of 247 on Android and uses whatever iOS negotiates; bitmap chunks shrink to fit. A full screen: [`examples/phone/react-native.tsx`](../examples/phone/react-native.tsx).

## Capacitor / Ionic — iPhone and Android

```sh
npm install openg1 @capacitor-community/bluetooth-le
```

```ts
import { BleClient } from "@capacitor-community/bluetooth-le";
import { G1 } from "openg1";
import { connectPair } from "openg1/transports/capacitor";

const g1 = await G1.connect(connectPair(BleClient));
```

## Node — macOS, Linux, Windows

```sh
npm install openg1 @stoprocent/noble
```

```ts
import noble from "@stoprocent/noble";
import { G1 } from "openg1";
import { connectPair } from "openg1/transports/noble";

const g1 = await G1.connect(connectPair(noble));
```

The CLI does this for you with `--ble`: `npx openg1 text "ciao" --ble`, `npx openg1 hub --ble`, `npx openg1 scan`. On macOS the terminal needs Bluetooth permission. noble cannot report the MTU on macOS; the transport assumes 247 (`{ mtu }` to override).

## Python

The original SDK, in [`python/`](../python/), with bleak. `pip install -e 'python[all]'`.

## The simulator, from anywhere

```ts
import { connectSimulator } from "openg1/transports/ws";

const g1 = await G1.connect(connectSimulator());                          // ws://127.0.0.1:8765
const g1 = await G1.connect(connectSimulator("ws://192.168.1.20:8765"));  // a simulator on your laptop, from your phone
```

Works in browsers, React Native and Node 22+. To reach a simulator from another device, start it with `--host 0.0.0.0`.

In-process, with no server: `import { simulate } from "openg1/sim"`.

## Writing a transport

Four methods and two callbacks. Extend `BaseTransport` and call `this.emit(bytes)` for each notification and `this.emitDisconnect(reason)` when the link drops:

```ts
import { BaseTransport } from "openg1";

class MyTransport extends BaseTransport {
  get connected() { … }
  get maxWrite() { return negotiatedMtu - 3; }
  async connect() { …subscribe to 6e400003-…, the RX characteristic… }
  async disconnect() { … }
  async write(data) { …write without response to 6e400002-…, the TX characteristic… }
}
```

The service is the Nordic UART Service, `6e400001-b5a3-f393-e0a9-e50e24dcca9e`. One write must carry one whole packet. Arms advertise as `Even G1_<channel>_<L|R>_<serial>`; `PairFinder` matches a left and a right by channel.
