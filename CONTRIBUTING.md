# Contributing

The protocol was pieced together from Even's demo app, community captures and
a lot of patience. Corrections from anyone with a pair on their face are the
most valuable thing this project can receive.

## Running the tests

```sh
python3 tests/run_tests.py        # no dependencies, no pytest needed
python3 tests/run_tests.py -k bmp # filter
pytest                            # also works
```

The suite runs with nothing installed, and it should stay that way. Anything
needing Pillow or bleak belongs behind a skip.

## Working without hardware

```sh
python3 -m openg1sim              # the simulator window
```

See [`docs/SIMULATOR_APP.md`](docs/SIMULATOR_APP.md). Everything in this repo
was built against the simulator, including this sentence.

## Protocol changes

Every command lives in [`protocol/openg1.protocol.yaml`](protocol/openg1.protocol.yaml)
with a confidence marker:

| | |
| --- | --- |
| `confirmed` | verified against hardware, by capture or by observed behaviour |
| `observed` | seen in the wild, purpose inferred |
| `guessed` | plausible, untested — treat as a hypothesis |

The Python enums are generated from that file, so change the YAML and
regenerate rather than editing `_generated.py`:

```sh
python3 tools/codegen.py
```

**Promoting something to `confirmed` needs evidence.** A capture, or a clear
description of what the glasses did. "It did not error" is not evidence — the
firmware acknowledges plenty of things it then ignores.

## Style

- Explain *why* in comments, not *what*. The code says what it does.
- Prefer a test that would have caught the bug over one that covers the line.
- Keep `openg1` free of anything that imports a radio or a GUI toolkit;
  `openg1sim` is where development tooling lives.

## Things that would help most

- Captures from real hardware for anything marked `guessed`, especially the
  navigation and teleprompter layouts.
- Calibration numbers from other people's glasses — how many rows are hidden
  on your pair, and at which virtual-screen height.
- Apps. `docs/BUILDING_APPS.md` is the guide; small and sharp beats large.
