# The simulator

A pair of G1 glasses that lives in a process instead of on your face. It is the SDK's own protocol code on the other end of the link, emulating what the firmware does with each packet, plus a renderer and the things a wearer does.

## Three ways to run it

### As a page

`dist/web/index.html` is one self-contained file. Open it from disk, host it anywhere static, or let `openg1 sim` serve it. It has three tabs:

- **In this tab** — the emulator runs in the page. Nothing to install; works on a phone.
- **Server** — mirrors the simulator inside `openg1 sim`, so the picture is the one your own program is driving. Only shown when the page is served by a simulator.
- **Real glasses** — connects over Web Bluetooth and shows a preview of what the glasses were sent.

The playground runs against whichever tab is selected. Its programs get `g1`, `sim` (null on real glasses), `signal` (aborts on Stop), `sleep(ms)`, `log()` and `openg1` (the whole SDK).

The touch bars behave like the real ones: taps are counted (one, two, three), and pressing for half a second is a hold. A hold on the left bar is the assistant trigger.

### As a server

```sh
npx openg1 sim [app.ts] [--host 0.0.0.0] [--port 8765] [--tcp-port 8766|off]
               [--top N] [--bottom N] [--profile file.toml] [--token T] [--open]
               [--no-heartbeat-check] [--hub]
```

| Endpoint | What it is |
| --- | --- |
| `GET /` | The page. |
| `WS /arm/left`, `/arm/right` | One binary message is one BLE packet, both ways. `?mtu=` sets the negotiated MTU. One client per arm, as with a real peripheral. |
| `WS /control` | Frames and the packet log out; wearer input in. What the page uses. |
| `GET /api/state` | Everything about the pair as JSON: content, warnings, battery, links. |
| `GET /api/frame.png?scale=2` | The panel as a picture. `frame.txt` gives it as block characters. |
| `POST /api/input` | A wearer action: `{"action":"tap","arm":"right","count":2}`. |
| `POST /api/reset` | Blank the panel and forget warnings. |
| TCP `8766` | The Python SDK's transport, so `OPENG1_SIMULATOR=1 python3 app.py` works unchanged. |

Actions: `tap` (`arm`, `count` 1–3), `hold-start` / `hold-end` (`arm`), `look` (`up`), `wear` (`worn`), `battery` (`value`, optional `arm`), `charge` (`charging`), `case` (`open`), `reset`.

With an app file, the simulator runs it and restarts it whenever the file is saved. The file default-exports an `App` class or instance, or an `async (g1, { sim, signal }) => …` function.

### As a library

```ts
import { simulate } from "openg1/sim";

const { g1, sim } = await simulate({ profile: { hiddenTop: 23 } });
await g1.display.text("ciao");

sim.screenText;          // "ciao"
sim.frame;               // a Bitmap: sim.frame.get(x, y), .lit(), .toBlocks()
sim.report();            // { truncatedLines, overflowLines, hiddenInk, fits, … }
sim.warnings;            // everything the firmware would have punished silently
sim.assertReadable();    // throw if any of that is non-empty

sim.tap("right", 2);     sim.holdStart("left");   sim.holdEnd("left");
sim.lookUp();            sim.wear(false);         sim.setBattery(12);
sim.charge(true);        sim.inject("left", bytes);
```

After triggering something, `await g1.session.idle()` waits until everything queued has reached both arms — the right moment to assert.

Options: `profile`, `mtu` (23 reproduces a link without MTU exchange), `latencyMs`, `enforceHeartbeat`, `micStream`.

## What it emulates

- Acknowledgements with the firmware's zero padding, and framed replies that echo the request and append the status.
- Text reassembly across packets, by package index.
- Bitmap transfers: the storage address on the first chunk, chunk order, the end marker, and the CRC over address plus file. A transfer that fails is rejected and the previous screen stays, as on hardware.
- Notification JSON reassembly, rendered as a card.
- Settings that read back: brightness, silent mode, head-up angle, wear detection, display geometry (commit only).
- Battery, firmware string (headerless ASCII), uptime.
- The microphone: LC3-sized packets from the right arm, capped at thirty seconds. The audio is filler, not speech.
- The 32-second heartbeat timeout, when `enforceHeartbeat` is on (the server's default).
- MTU: a write larger than the negotiated size fails, as a BLE write would.

## What it tells you

`sim.warnings` and the page's red box collect:

- lines past the fifth, which the firmware drops;
- lines wider than the panel, which it clips;
- lit pixels in rows your profile marks as hidden;
- content on the left arm only (the right lens would be dark);
- bitmap chunks out of order, a missing storage address, a CRC mismatch;
- torn UTF-8, a brightness above 42, the microphone command sent to the wrong arm;
- a link dropped for lack of heartbeats.

## What it does not claim

- **Text is not pixel-accurate.** The firmware's font is not published. Text screens are drawn in a condensed stand-in at the same size and line pitch, and "does this line fit" is answered with the SDK's own metrics — the same estimate `display.text` wraps with. Bitmap screens are exact.
- **It is not an optics model.** You get the framebuffer, not the waveguide.
- **The dashboard and the firmware's built-in modes** (its own navigation, teleprompter, translate) are not drawn. Their commands are acknowledged and otherwise ignored.

## The rows you cannot see

The panel has 136 rows. How the glasses sit on your face can hide some at the top or bottom, and no library can know how many. A profile records it:

```toml
# ./openg1.toml, or ~/.config/openg1/profile.toml — shared with the Python SDK
[device]
name = "mine"
hidden_top = 23
hidden_bottom = 0
```

The CLI reads that file (or `--profile`, or `--top` / `--bottom`). In code, pass `{ profile: { hiddenTop: 23 } }` to `G1.connect` or `simulate`. Then:

- `canvas.safe` is the visible rectangle, and `display.image` fits pictures inside it;
- `App.screen.show()` pushes firmware text below the hidden rows;
- the simulator shades those rows and reports any ink in them.

To measure your pair, `python/examples/07_calibrate.py --save` draws a ruler on the glasses and writes the file.
