# Contributing

The protocol was pieced together from Even's demo app, community captures and a lot of patience. Corrections from anyone with a pair on their face are the most valuable thing this project can receive.

## Running the tests

```sh
npm install
npm test                 # the TypeScript SDK, simulator, server, transports (Node 22.18+)
npm run test:python      # the Python SDK, no dependencies needed
npm run typecheck
```

`npm test` runs the TypeScript sources directly, which needs Node 22.18 or newer. The built package runs on Node 20.

## Working without hardware

```sh
npx openg1 sim                      # the simulator page and endpoints
npx openg1 sim examples/04-app.ts   # an app with live reload
```

Everything in this repository was built against the simulator. That is also its limit: see "What has been tested" in the README before trusting an adapter on a new platform.

## Captures from real glasses

```sh
npx openg1 monitor --packets --ble      # or: openg1 monitor, with the Python SDK
```

Do the thing on the glasses, then open an issue with:

1. what you did;
2. the lines the monitor printed;
3. which arm it came from;
4. the firmware version (`npx openg1 info --ble`);
5. what the glasses showed.

Unknown packets are printed, not hidden. A previously unknown command can usually be implemented once its request, acknowledgement and resulting event are known.

## Protocol changes

Every command lives in [`protocol/openg1.protocol.yaml`](protocol/openg1.protocol.yaml) with a confidence marker:

| | |
| --- | --- |
| `confirmed` | verified against hardware, by capture or by observed behaviour |
| `observed` | seen in the wild, purpose inferred |
| `guessed` | plausible, untested — treat as a hypothesis |

Constants for both SDKs are generated from that file. Change the YAML, then:

```sh
npm run codegen                  # src/generated.ts, python/openg1/_generated.py, fonts
python3 tools/gen_vectors.py     # protocol/vectors.json
python3 tools/gen_parity.py      # test/fixtures/python-parity.json
```

(These need Python with PyYAML and Pillow.) Both SDKs must still pass `protocol/vectors.json`, and the TypeScript one must still match `test/fixtures/python-parity.json`.

**Promoting something to `confirmed` needs evidence**: a capture, or a clear description of what the glasses did. "It did not error" is not evidence — the firmware acknowledges plenty of things it then ignores.

## Style

- Explain *why* in comments, not *what*.
- Prefer a test that would have caught the bug over one that covers the line.
- `src/` outside `server/`, `cli.ts` and `transports/tcp.ts` must stay free of Node APIs: it runs in browsers and on phones.
- Transports take their BLE library as an argument and never import it.
- The TypeScript is written so Node can run it without a build step: no enums, no parameter properties, `.ts` import extensions.

## Things that would help most

- Running any transport against real glasses and reporting what happened — MTU, timing, anything that needed changing.
- Captures for anything marked `guessed`, especially the firmware's navigation and teleprompter payloads.
- The real advance widths of the firmware font, to replace the estimate in `src/text.ts`.
- Calibration numbers: how many rows are hidden on your pair.
