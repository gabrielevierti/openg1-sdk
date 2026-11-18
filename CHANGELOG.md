# Changelog

## 2.0.0

A rebuild around one goal: the same API on a computer, on Android and on
iPhone, with a simulator good enough to develop against.

### Added

- **TypeScript SDK** (`openg1`): the protocol, session and `G1` API in pure
  TypeScript with no dependencies. Passes the same conformance vectors as the
  Python SDK, plus a parity fixture generated from it (command builders, text
  layout, dithering, BMP encoding, transfer chunking).
- **Transports** for Web Bluetooth, React Native (`react-native-ble-plx`),
  Capacitor (`@capacitor-community/bluetooth-le`), Node (`noble`), WebSocket
  and TCP. Tested against library-shaped stand-ins; not yet on hardware.
- **Canvas**: lines, shapes, arcs, proportional text in five bitmap fonts,
  wrapped text boxes, progress bars, arrows. `display.draw`, `display.image`.
- **Simulator rewritten** (`openg1/sim`): emulated firmware per arm, a
  renderer, wearer input and diagnostics, as a browser-safe library. A
  self-contained web page with a playground and a real-glasses mode; a server
  with WebSocket, HTTP and TCP endpoints; live reload for app files.
- **Hub** (`openg1 hub`): the SDK as a JSON API over HTTP, server-sent events
  and WebSocket, including screens described as drawing operations.
- **Navigation drawn as a bitmap**: arrow, distance, road, speed against the
  limit.
- `App` / `Launcher` framework, `session.exclusive`, `session.idle`,
  `describePacket`.

- **Companion app** (`app/`): one Capacitor codebase for iPhone and Android.
  Connection with a live preview, its own navigator on OpenStreetMap data
  (search, car/bike/foot routes, speed limits, rerouting), teleprompter, notes,
  mini-app launcher, glasses settings and calibration. Tested in a browser
  against the simulator; native builds not yet compiled.

### Changed

- The repository is now a Node package at the root; the Python SDK moved to
  `python/` and keeps working, including against the new simulator
  (`OPENG1_SIMULATOR=1`).
- `display.text` (TypeScript) sends to both arms, left first, as the spec and
  the official app do. The Python SDK still sends text to the left arm only.
- Simulator text is drawn in a proportional font and judged with the SDK's own
  metrics, instead of a fixed 5×7 cell font.

### Fixed

- Text on a link without MTU negotiation: the per-packet budget had a floor of
  16 bytes, which overflowed a 20-byte write. Both SDKs.
- The dependency-free Python test runner skipped parametrised cases when
  pytest was installed.

### Removed

- Committed `__pycache__` and `.DS_Store` files; README references to examples
  and documents that did not exist.

## 1.0 — the Python SDK

First release: the Python SDK and the visual simulator.

### SDK

- Full protocol support — text, images, dashboard, notifications, settings,
  microphone with LC3 reassembly, events, device info
- `asyncio` throughout, fully typed, importable with no dependencies at all;
  BLE, image and audio support are optional extras and lazily loaded
- Dual-arm session: left-before-right ordering, one command outstanding,
  reply correlation, the 28-second heartbeat
- Emulator (`openg1sim.EmulatedGlasses`) that parses real packets and replies
  the way the firmware does
- `openg1` command line tool — scan, info, monitor, text, image, raw send, spec
- `protocol/openg1.protocol.yaml` as the source of truth, with codegen and 83
  conformance vectors
- 276 tests, runnable without pytest

### Simulator

- Renders the 576×136 panel to actual pixels, so layout mistakes surface
  before the hardware sees them
- Wraps the SDK emulator rather than replacing it — `sim.g1` is an ordinary
  `G1`, and every packet still goes through the same parsing and replies
- A 5×7 bitmap font written for this, including composed accents and arrows
- Terminal viewer with keyboard control, browser viewer with clickable
  controls over server-sent events, PNG export
- `report()` flags truncated and overflowing lines, and carries both its own
  line count and the SDK's so the two font models can be compared rather than
  confused
- Stdlib only: no Pillow, no font files, no web framework
- 32 tests

### Fixed before release

- `display.bitmap(auto_center=True)` translated a full-panel image by the
  requested `vertical_offset` and let the rows that fell off the framebuffer
  disappear. A 576x136 picture arrived with its bottom 20 rows missing and a
  blank band at the top, which reads as the panel cropping. The shift is now
  clamped against the content bounds, so centering moves ink and never
  destroys it; an offset that cannot be honoured warns instead of silently
  eating pixels.
- `Display` no longer assumes eight hidden rows at the bottom of the panel.
  How much of the display a wearer sees depends on fit, so it is measured,
  not guessed — `examples/07_calibrate.py` draws a numbered rule, and
  `set_safe_area()` / `safe_area=(top, bottom)` record the answer.
- `bmp.load_image()` takes `safe_area` and fits inside the visible band,
  scaling the picture down rather than cropping it.
- `bmp.content_bounds()` and `bmp.shift_rows()` work a row of bytes at a
  time; the old centering pass ran ~78,000 Python-level iterations per image.
- `display.bitmap()` logs through `logging.getLogger("openg1.display")` instead
  of printing `[DEBUG]` lines to stdout.
- `load_image` uses `Image.tobytes()`; `getdata()` is deprecated and goes away
  in Pillow 14.
- `display.image()` rejects unknown keyword arguments instead of dropping
  them, which is how `vertical_offset=20` looked like it was working.

- `display.bitmap()` now returns a `BitmapResult` and raises when an arm does
  not confirm the CRC. Both arms previously swallowed CRC failures and
  timeouts into a log line, so a partial transfer looked like a success.
- `bmp.check_transfer_budget()` refuses a transfer needing more than 256
  chunks. The chunk index is one byte; below a 39-byte chunk it wrapped
  silently, which a 23-byte MTU produces.
- `display.bitmap(pace=...)` throttles the write-without-response data phase.
- `examples/08_diagnose.py` distinguishes a truncated transfer from a panel
  the wearer cannot fully see, by sending the same image both byte orders.
- `examples/07_calibrate.py` sweeps the virtual-screen geometry (`--sweep`)
  and restores the original setting afterwards. Moving the display is worth
  trying before shrinking the image, since `safe_area` costs resolution and
  geometry costs nothing.

### App framework

- New `openg1.app`: `App`, `Screen`, `Launcher`, `run()`. A mini-app declares
  `start`/`tick`/`on_tap`/`on_head`/`on_wear`/`stop`; handlers are bound on
  attach and released on detach, and an exception in one is caught rather than
  taking the connection down with it.
- `Screen` reads the device profile: `show()` pads below the hidden rows,
  `lines` reports how many lines this pair actually has. The same call is
  correct on a calibrated pair and on one that hides nothing.
- New example apps in `examples/apps/`: `clock.py`, `timer.py`,
  `teleprompter.py`, and `launcher.py` running all three.
- New guide: `docs/BUILDING_APPS.md`.
- `protocol/og1.protocol.yaml` renamed to `openg1.protocol.yaml`.
- Added CI (`.github/workflows/tests.yml`), `CONTRIBUTING.md`, and a docs
  index at `docs/README.md`.

### Starter template

- `examples/10_starter.py` — a skeleton that runs unchanged on the simulator
  and on hardware, and pads text below the hidden rows using the device
  profile, so the padding is zero on a pair that hides nothing.

### Renamed to OpenG1

- The package is `openg1`, the simulator is `openg1sim`, the CLI is `openg1`,
  the environment variable is `OPENG1_SIMULATOR`, and the base exception is
  `OpenG1Error`. Everything that said `og1` now says `openg1`.

### Simulator/hardware parity

- New `openg1.profile`: one `DeviceProfile` — panel size, hidden rows, MTU —
  read by **both** the simulator and `Display`. The hidden-row count used to
  exist only as a constant in an example, which is exactly how you ship a
  layout that looked right in the window.
- The simulator dims the rows the wearer cannot see instead of drawing all
  136. Dimmed rather than cropped: cropping would change the geometry and make
  the window disagree with the framebuffer.
- New `sim.hidden_ink()` and `sim.check_parity()`; `SimulatedG1(strict=True)`
  raises `ParityError` on any divergence, so a test fails at the moment a
  layout becomes unshippable.
- `examples/07_calibrate.py --save 23` writes the profile;
  `openg1 profile [--set TOP,BOTTOM]` shows or sets it.
- `tests/run_tests.py` now honours `setup_method`/`teardown_method`, so test
  files stay runnable under both it and pytest.

### The simulator window

- New: `python3 -m openg1sim` opens a desktop window — the panel at 2×, buttons
  for touchbar, head, wear and battery, a status line that warns in amber
  when text does not fit, and a log. Tk, because it ships with Python; a
  simulator you must install a toolkit for is one you use once.
- New: `openg1sim.controller.SimulatorController` runs the simulator on its own
  thread and is the only thing crossing between it and the GUI thread. All
  the logic lives there so it can be tested without a display; `openg1sim.gui`
  is a thin view over it.
- Missing tkinter prints install instructions and points at the browser
  version rather than a traceback.

### The simulator as an application

- New: `python3 -m openg1sim app`. The simulator now runs as its own process,
  with a glasses endpoint on TCP 8766 and the panel on 8765. Your program
  connects to it and sends the bytes a BLE write would carry, so the
  simulator outlives your restarts instead of dying with them.
- New: `openg1.transport.net.NetTransport` and `G1.connect_simulator()`.
- New: `OPENG1_SIMULATOR=1` makes `G1.connect()` reach the simulator instead of
  scanning, so an unmodified hardware program runs against it unchanged.
- While an app is attached the browser's display controls are refused —
  two writers on one panel has no hardware equivalent. Wearer input (tap,
  head, wear, battery) still works, which is the useful direction anyway.
- New: `SimulatedG1(attach_local_g1=False)` for a headless simulator with no
  local session.
- New guide: `docs/SIMULATOR_APP.md`.

### Simulator and cleanup

- The emulator moved out of the SDK into `openg1sim` (`openg1/transport/mock.py` ->
  `openg1sim/emulator.py`, `VirtualG1` -> `EmulatedGlasses`). Shipping a fake
  device inside the library invited writing against it by accident, and having
  two ways to not-have-glasses meant two things to keep in step.
  **Removed: `G1.virtual()`, `openg1.VirtualG1`, `openg1.MockTransport`,
  `openg1.transport.mock`.** Use `openg1sim.SimulatedG1`; `sim.emulator.left`
  replaces the arm state the old constructor returned.
- `openg1 --virtual` is now `openg1 --sim`; likewise for every example.
- `SimulatedG1.virtual` is now `SimulatedG1.emulator`.
- New: `python3 -m openg1sim dev app.py` — the browser viewer, plus a file
  watcher that reruns your app on every save. An app is `async def main(g1)`,
  so the same file runs on hardware. Modules are imported fresh rather than
  reloaded in place; app errors are reported, never fatal.
- New: `SimulatedG1.reset()`, blanking the panel without dropping the session.
- Fixed: `openg1sim/web.py` shipped placeholder tokens (`#11perhaps`,
  `#35totally`) in its stylesheet and patched them at import time.
- Removed `display.bitmap(parallel=...)`, which was accepted and ignored.
- Demo content deduplicated into `openg1sim/scenes.py`; the two copies had
  drifted. Example boilerplate deduplicated into `examples/_common.py`; four
  examples imported `sys` twice. Dropped two `_unused()` linter stubs and
  seven unused imports.

### Known gaps

- Navigation (`0x0A`) and teleprompter (`0x09`) payload layouts are guesses.
  The navigation helpers fall back to formatted text, which works.
- Firmware update is deliberately unimplemented.
- LC3 decoding needs an external library; the SDK reassembles and writes
  frames without decoding them.
- The simulator's font is not the firmware's, and it models no optics. See
  `docs/SIMULATOR.md`.
