# Open G1 SDK

![Version](https://img.shields.io/badge/version-1.0-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

![Splash](splash.png)

**An open-source Python SDK and simulator for Even Realities G1 smart glasses.**

OpenG1 lets you develop applications for the G1 without depending on the official app. Connect to real glasses over Bluetooth, render and test applications in the simulator, work with the display, read device state, receive gestures, capture microphone audio, and access the underlying protocol directly.

The simulator uses the same `G1` API as real hardware, so an application written against OpenG1 can move between the simulator and physical glasses without code changes.

> The G1 is discontinued and the official software ecosystem is winding down. OpenG1 exists to keep the hardware useful and give owners a way to continue building for it.

**Not affiliated with Even Realities.**

## Quick start

Install OpenG1:

```sh
pip install -e '.[all]'
```

Then connect to a pair of glasses:

```python
from openg1 import G1

async with await G1.connect() as g1:
    await g1.display.text("ciao")

    async for event in g1.events():
        print(event)
```

Or develop without owning the hardware:

```python
from openg1sim import SimulatedG1

async with SimulatedG1() as sim:
    await sim.g1.display.text("ciao")
    print(sim.panel.frame.to_blocks())
```

The same application code works with both.

## What you can build

OpenG1 currently supports:

* Text rendering, wrapping and pagination
* 1-bit bitmap images with dithering
* Display brightness
* Dashboard and notification payloads
* Silent mode
* Head-up angle
* Wear detection
* Touch events
* Head gestures
* Even AI trigger events
* Battery and firmware information
* Microphone capture and LC3 decoding
* Raw protocol packets
* Navigation and teleprompter payloads
* A full software simulator

For anything that is not yet wrapped by the high-level API, you can send raw packets directly.

## Develop without the glasses

The simulator is a first-class part of OpenG1, not just a debugging utility.

It emulates the G1 protocol, renders the display, accepts simulated wearer input, and exposes the same `G1` interface used by physical hardware.

Start it with:

```sh
python3 -m openg1sim
```

Then run your application against it:

```sh
OPENG1_SIMULATOR=1 python3 myapp.py
```

No application changes are required.

You can also use the simulator in several modes:

```sh
python3 -m openg1sim             # simulator window
python3 -m openg1sim app         # browser interface
python3 -m openg1sim dev app.py  # live-reload development
python3 -m openg1sim web         # panel only
python3 -m openg1sim term        # terminal viewer
python3 -m openg1sim demo        # scripted demonstration
```

The simulator listens on TCP port `8766` for protocol traffic and serves the panel interface on `http://127.0.0.1:8765`.

This makes it possible to develop and test an application without repeatedly putting the glasses on, waiting for Bluetooth connections, or manually reproducing input events.

## The display is simulated as pixels

A protocol packet succeeding does not mean that the result is actually usable.

The G1 framebuffer is:

```text
576 × 136 pixels
```

OpenG1 renders that framebuffer so you can see exactly what your application is producing.

For example:

```python
await sim.g1.display.text_page(
    long_message,
    page=1,
    max_page=1,
)

report = sim.report()

print(report.truncated_lines)
```

The simulator can therefore catch problems such as:

* Text falling outside the visible region
* Images being clipped
* Incorrect scaling
* Incorrect pagination
* Incorrect display transforms
* Content extending beyond the usable viewing area

## Calibrate your glasses

The physical display and the visually usable area are not necessarily identical.

How the glasses sit on your face can make some rows difficult or impossible to see. OpenG1 therefore supports a calibration step that measures the usable display area and stores it as a device profile.

Run:

```sh
python3 examples/07_calibrate.py --save
```

You can also sweep through display geometries:

```sh
python3 examples/07_calibrate.py --sweep
```

Once calibrated, pass the safe area to the image renderer:

```python
await g1.display.image(
    image,
    safe_area=(top, bottom),
)
```

The image is then scaled into the usable region instead of simply being shifted around the framebuffer.

The simulator uses the same calibration data, allowing you to test against the effective display area rather than an idealized 576×136 rectangle.

Use:

```python
sim.check_parity()
```

to fail a test when simulator output and calibrated display behavior disagree.

## CLI

OpenG1 also provides a command-line interface:

```sh
openg1 scan
openg1 info
openg1 monitor
openg1 text "ciao"
openg1 image photo.jpg
openg1 image photo.jpg --safe-area 12,12
openg1 send 0x01 1e00
openg1 spec
```

Everything can also be run against the simulator:

```sh
openg1 --sim demo
```

### Protocol monitor

For reverse-engineering and debugging, `openg1 monitor` is particularly useful.

Unknown event and command sub-codes are printed rather than silently discarded. This makes it possible to capture previously unsupported behavior and extend the protocol implementation.

## Examples

Every example supports `--sim`, so you can run them without a pair of glasses.

```sh
python3 examples/01_hello.py --sim
python3 examples/05_image.py --sim --png
```

| Example            | Description                                     |
| ------------------ | ----------------------------------------------- |
| `01_hello.py`      | Connect, display text and read the battery      |
| `02_events.py`     | React to taps, head gestures and wear detection |
| `03_navigation.py` | Genova → Milano navigation example              |
| `04_assistant.py`  | Capture microphone audio and display a response |
| `05_image.py`      | Dither and display a bitmap                     |
| `06_simulator.py`  | Render the display as pixels                    |
| `07_calibrate.py`  | Measure the usable display area                 |
| `08_diagnose.py`   | Diagnose clipping and transport problems        |
| `09_devapp.py`     | Minimal live-reload development application     |
| `10_starter.py`    | Starting point for a new OpenG1 application     |

The image example also includes a calibration chart with `TOP`, `BOTTOM`, and a row ruler. It makes display clipping immediately visible in the simulator.

## Example applications

OpenG1 includes several complete applications in `examples/apps/`.

| Application       | Description                          |
| ----------------- | ------------------------------------ |
| `clock.py`        | Time, date and battery display       |
| `timer.py`        | Touch-controlled Pomodoro timer      |
| `teleprompter.py` | Paginated script controlled by taps  |
| `launcher.py`     | Switch between multiple applications |

For example:

```sh
OPENG1_SIMULATOR=1 python3 examples/apps/launcher.py
```

See [`docs/BUILDING_APPS.md`](docs/BUILDING_APPS.md) for the application architecture and patterns used by these examples.

## Installation

OpenG1 is intentionally split into optional dependencies.

```sh
pip install -e '.[all]'
```

Or install only what you need:

```sh
pip install -e '.[ble]'
pip install -e '.[images]'
pip install -e '.[audio]'
```

| Extra    | Dependency | Purpose                                   |
| -------- | ---------- | ----------------------------------------- |
| `ble`    | `bleak`    | Bluetooth communication with real glasses |
| `images` | `Pillow`   | PNG/JPEG loading and image processing     |
| `audio`  | `lc3`      | LC3 microphone frame decoding             |

The core protocol implementation, session layer, emulator and simulator do not require external dependencies.

## Protocol implementation

The wire protocol is defined in:

```text
protocol/openg1.protocol.yaml
```

This is the source of truth for the SDK.

It currently describes:

* 49 commands
* 3 event types
* 11 enums
* 83 conformance vectors
* Confidence levels for every reverse-engineered field

Every protocol item is marked as:

* `confirmed` — verified against the hardware or official implementation
* `observed` — seen in real traffic but not fully understood
* `guessed` — inferred from behavior or related implementations

Generated constants live in:

```text
openg1/_generated.py
```

Do not edit that file manually.

Regenerate it with:

```sh
python3 tools/codegen.py
python3 tools/gen_vectors.py
```

The human-readable protocol documentation is available in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## A few protocol details worth knowing

### Framed lengths include the header

The framed length field includes its own header.

For example:

```text
25 06 00 03
```

is an opcode `0x25` packet with a declared frame length of `6`.

It is not:

```text
command 0x25
sub-command 0x06
```

This distinction matters for variable-length commands.

### Bitmap CRCs include the storage address

For bitmap transfers, the CRC is calculated over the storage address followed by the file data.

For example:

```text
00 1C 00 00
```

must be included before calculating the CRC.

A CRC calculated over the file alone is rejected by the glasses.

### Update the left arm first

The two display halves are updated independently.

The reliable sequence is:

```text
LEFT
  ↓
ACK
  ↓
RIGHT
  ↓
ACK
```

Sending both sides concurrently can result in display tearing.

## Known limitations

Two areas are intentionally incomplete.

### Firmware updates

Firmware update support is not implemented.

A malformed firmware transfer can permanently brick a device, and replacement G1 hardware is no longer readily available. OpenG1 therefore does not expose firmware flashing functionality until the process can be implemented with sufficient confidence.

### Navigation and teleprompter payloads

The navigation and teleprompter opcodes are known and accepted by the glasses, but parts of their payload layouts are still inferred.

They are therefore marked `guessed` in the protocol specification.

The high-level navigation helpers currently fall back to formatted text where necessary, providing useful behavior without pretending that the undocumented layouts are fully understood.

## Testing

The project includes a dependency-free test runner:

```sh
python3 tests/run_tests.py
```

Filter tests with:

```sh
python3 tests/run_tests.py -k text
```

Or use pytest:

```sh
pytest
```

The test suite covers the protocol, SDK, emulator and simulator.

Conformance vectors are generated from the protocol specification so that implementations can be checked against the same expected packet structures.

## Project structure

```text
openg1/
├── openg1/                 # Python SDK
├── openg1sim/              # Simulator and emulator
├── protocol/
│   └── openg1.protocol.yaml
├── examples/
│   ├── apps/
│   └── ...
├── tests/
├── tools/
└── docs/
```

The important distinction is:

```text
Your application
       │
       ▼
    OpenG1
       │
       ├───────────────┐
       ▼               ▼
  Real G1          Simulated G1
       │               │
      BLE          Emulator
                       │
                       ▼
                    Renderer
```

The application does not need to know which backend it is running against.

## Contributing

The most useful contributions are real protocol observations.

If OpenG1 does not understand something the glasses do, run:

```sh
openg1 monitor
```

Perform the action on the glasses, then open an issue containing:

1. The action you performed
2. The relevant packet capture
3. Whether the behavior was observed on the left, right, or both sides
4. Firmware version
5. Any visible result on the glasses

Packet captures are considerably more useful than guesses. A previously unknown command can often be implemented once its request, acknowledgement and resulting event are known.

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Credits

OpenG1 builds on the reverse-engineering work of the G1 community, including:

* `even-realities/EvenDemoApp`
* `JohnRThomas/EvenDemoApp`
* `binarythinktank/eveng1_python_sdk`
* `emingenc/even_glasses`
* `emingenc/g1_flutter_blue_plus`
* `hqrrr/EvenComfort`
* `lohmuller/even-g1-java-sdk`
* `FJiangArthur/Helix-iOS`
* `radioegor146/even-utils`
* `Mentra-Community/MentraOS`

OpenG1 would not exist without that prior work.

## Documentation

| Document                                         | Description                            |
| ------------------------------------------------ | -------------------------------------- |
| [`docs/SIMULATOR_APP.md`](docs/SIMULATOR_APP.md) | Develop and test without the hardware  |
| [`docs/BUILDING_APPS.md`](docs/BUILDING_APPS.md) | Build applications with OpenG1         |
| [`docs/SIMULATOR.md`](docs/SIMULATOR.md)         | Simulator architecture and API         |
| [`docs/TESTING.md`](docs/TESTING.md)             | SDK and application testing            |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md)           | G1 wire protocol and confidence levels |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)             | Protocol captures and contributions    |

## License

MIT License.

OpenG1 is an independent open-source project and is **not affiliated with or endorsed by Even Realities**.
