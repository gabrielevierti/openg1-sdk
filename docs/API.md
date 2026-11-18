# API reference

Everything below is exported from `openg1` unless a different entry point is named. Types ship with the package; this page is the map.

## Connecting

```ts
const g1 = await G1.connect(pair, options?);
await g1.disconnect();
g1.connected;
```

`pair` is `{ left, right }` from a transport ([`PLATFORMS.md`](PLATFORMS.md)), or a promise of one.

| Option | Default | |
| --- | --- | --- |
| `profile` | hides nothing | `{ hiddenTop, hiddenBottom, mtu, name }` — how this pair sits on your face |
| `ackTimeoutMs` | 2500 | how long an arm has to acknowledge |
| `heartbeatIntervalMs` | 28000 | the firmware drops the link at 32 s |
| `autoHeartbeat` | true | |
| `strict` | true | throw when an arm answers FAILURE |
| `handshake` | true | send INIT and SEQ_SYNC on connect, as the official app does |

## `g1.display`

| | |
| --- | --- |
| `text(message, { pageDelayMs?, mode?, signal? })` | Firmware text. Wrapped to the panel, five lines a screen, paged with a pause when it needs more than one. |
| `textPage(message, { page?, maxPage?, mode? })` | Exactly one screen you laid out yourself. |
| `clear()` | |
| `canvas()` | A blank `Canvas` whose `safe` rectangle is this pair's visible band. |
| `draw(canvas \| (c) => void, options?)` | Draw and show. |
| `image({ data, width, height }, options?)` | Any RGBA pixels — a canvas `ImageData`, a decoded PNG — fitted (`fit`: `contain`, `cover`, `stretch`), optionally dithered, inside the safe area. |
| `bitmap(bitmap \| bmpBytes, options?)` | A ready 576×136 one-bit image. |
| `brightness(level, auto?)`, `getBrightness()` | 0–42. |
| `setGeometry(height, depth)`, `getGeometry()` | The virtual screen's position; does the preview/commit two-step. |
| `power(on)` | |
| `safeArea`, `setSafeArea(top, bottom)` | Rows you cannot see. |

Bitmap options: `verify` (default true: throw unless both arms confirm the CRC), `onProgress`, `timeoutMs`, `autoCenter`, `topDown`, `paceMs` (delay per data packet), `crcDelayMs` (pause before the CRC, default 300 — lower it if your glasses keep up).

The result says what happened: `{ bytesSent, packets, chunkSize, leftOk, rightOk, ok }`.

## `Canvas`

```ts
const c = g1.display.canvas();      // or new Canvas(width, height, safeArea)
```

| | |
| --- | --- |
| `text(str, x, y, { font, align, baseline, scale, spacing, maxWidth, on })` | One line. Returns its width. `maxWidth` truncates with an ellipsis. |
| `textBox(str, x, y, w, h, { font, align, valign, lineHeight, maxLines })` | Word-wrapped. Returns the lines drawn. |
| `measure(str, { font, scale })` | |
| `line(x0, y0, x1, y1, { width, on })` | |
| `rect(x, y, w, h, { fill, radius, width, on })` | |
| `circle(cx, cy, r, { fill, width, on })` | |
| `arc(cx, cy, r, startDeg, endDeg, { width })` | Clockwise, 0° up. |
| `polygon(points, { fill, width, on })` | |
| `progress(x, y, w, h, value)` | 0–1. |
| `arrow(cx, cy, size, angleDeg)` | 0 straight ahead, 90 right. |
| `battery(x, y, level)` | 0–100. |
| `invertRect(x, y, w, h)` | |
| `image(bitmap, x, y, mode)` | `or`, `copy`, `xor`, `erase`. |
| `safe` | `{ x, y, width, height }` — lay out inside this. |
| `bitmap` | The `Bitmap` underneath. |

Fonts: `sm` (14 px), `md` (21 px), `fw` (21 px condensed, close to the firmware's widths), `lg` (36 px bold), `xl` (64 px bold; digits, `:.,-+%°/`, `k m h`). Latin, Latin-1, Latin Extended-A and a set of symbols (`← ↑ → ↓ ✓ ✗ ★ ⚠ • ° €` …). A character the font lacks is drawn as a hollow box.

`Bitmap` has `get`/`set`, `lit()`, `contentBounds()`, `toBmp()`, `Bitmap.fromBmp()`, `Bitmap.fromRGBA()`, `Bitmap.fromGray()`, `toRGBA()`, `toBlocks()`.

## Events

```ts
const off = g1.on("touch", (event) => { … });   off();
const event = await g1.waitFor("head", { timeoutMs, signal, filter });
for await (const event of g1.events()) { … }
```

| `type` | Fields |
| --- | --- |
| `touch` | `arm`, `gesture`: `single_tap` `double_tap` `triple_tap` `hold_start` `hold_end` |
| `ai-request`, `ai-stop` | A hold on the **left** bar, and its release |
| `head` | `up` |
| `wear` | `worn` |
| `battery` | `percent`, `voltageMv?`, `charging?` |
| `charging` | `charging` |
| `case` | `lidOpen?`, `charging?`, `battery?` |
| `dashboard` | `open` |
| `audio` | `seq`, `data` |
| `disconnect` | `arm`, `reason?` |
| `unknown` | `opcode`, `subcode?`, `data` — not dropped, so you can decode it |

Every event has `arm` (`"left"` or `"right"`) and `raw` (the bytes). `"*"` subscribes to all of them.

## The other namespaces

**`g1.info`** — `battery()` → `{ left, right, lowest }`; `firmware()` → `{ version, build, raw }`; `uptime()`; `serial()`; `raw(commandName)`.

**`g1.settings`** — `silentMode(on)`, `getSilentMode()`, `headupAngle(deg)`, `getHeadupAngle()`, `wearDetection(on)`, `getWearDetection()`, `headupAction(action)`, `doubleTapAction(action)`, `calibrate()`, `language(code)`, `debugMode(on)`, `reboot()`.

**`g1.dashboard`** — `setTime({ epochMs?, twelveHour? })`, `setWeather({ icon, temperatureC, fahrenheit?, twelveHour? })`, `setLayout(mode, panel)`, `lock(on)`, `quickNote(bytes)`. `iconFromOwm(code)` maps OpenWeatherMap codes.

**`g1.notifications`** — `notify({ title, message?, subtitle?, appName?, appId? })`, `configure({ apps, calendar, call, messages, iosMail })`, `clear()`.

**`g1.audio`** — `start()` → `AudioBuffer`, `stop()`, `record(ms)`. The buffer has `packetCount`, `durationS`, `missing()`, `raw()`, `toLc3File()`, and `decode(decoder)` if you bring an LC3 decoder.

**`g1.navigation`** — `update(step)` draws a step as a bitmap; `updateText(step)` uses firmware text; `raw(bytes)` sends the firmware's own (undecoded) navigation command; `stop()`.

**`g1.assistant`** — `once(responder)`, `listen(responder)` → stop function, `show(text, { state })`, `paged(text)`. The responder gets an `AudioBuffer` and returns the answer.

## Apps

```ts
class MyApp extends App {
  name = "my-app";
  intervalMs = 1000;                 // optional: call tick() this often
  async start() {}                   // draw the first screen
  async tick() {}
  async stop() {}
  async onTouch(event) {}
  async onHead(event) {}
  async onWear(event) {}
  async onEvent(event) {}            // everything
}
await runApp(new MyApp(), g1, { signal });
```

Inside an app: `this.g1`, and `this.screen` — `show(text)`, `rows(...lines)`, `draw(fn)`, `clear()`, `lines` (how many text lines this pair can show). `Launcher([...apps], switchGesture = "triple_tap")` is itself an app.

## Lower levels

`g1.session` is the escape hatch:

```ts
import { commands } from "openg1";

await g1.session.send(commands.setBrightness(30));                 // any builder
await g1.session.send(commands.command("GET_MAC_ADDRESS"), { strict: false });   // any spec entry by name
await g1.session.sendRaw("left", bytes);                           // any bytes
g1.session.onPacket((arm, direction, data) => { … });              // every packet, both ways
await g1.session.exclusive(async (tx) => { … });                   // hold the send lock for a sequence
await g1.session.idle();                                           // everything queued has been sent
```

Also exported: `framing` (`decode`, `encodeFramed`, `encodeRaw`), `crc32`, `bmpCrc`, `text` (`wrap`, `paginate`, `measure`, `splitUtf8`), `describePacket`, `describeEvent`, `applyDrawOps`, the generated constants (`COMMANDS`, `Op`, `StateEvent`, `ScreenStatus`, `WeatherIcon`, …) and the error classes (`CommandTimeout`, `CommandError`, `ProtocolError`, `TransportError`, `NotConnectedError`, `PacketTooLargeError`, `DiscoveryError`), all derived from `OpenG1Error`.
