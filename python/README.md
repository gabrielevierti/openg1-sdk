# OpenG1 — Python SDK

The original SDK: `openg1` (protocol, session, `G1`) and `openg1sim` (an in-process emulator used by its tests). It is the implementation that has been used on real glasses.

```sh
pip install -e '.[all]'          # from this directory; extras: ble, images, audio
```

```python
from openg1 import G1

async with await G1.connect() as g1:        # scans for a pair over Bluetooth
    await g1.display.text("ciao")
    async for event in g1.events():
        print(event)
```

## With the simulator

The repository's simulator speaks this SDK's simulator transport on TCP 8766:

```sh
npx openg1 sim                               # from the repository root
OPENG1_SIMULATOR=1 python3 examples/01_hello.py
```

`G1.connect()` honours `OPENG1_SIMULATOR` (`1`, or `host:port`), so a program written for hardware runs against the simulator unchanged. `python3 -m openg1sim` still starts this package's own simulator.

## Tests

```sh
python3 tests/run_tests.py       # no dependencies
pytest                           # also works
```

## Sharing with the TypeScript SDK

- `../protocol/openg1.protocol.yaml` is the source of truth for both; `_generated.py` comes from it.
- `../protocol/vectors.json` is passed by both.
- The device profile file (`./openg1.toml` or `~/.config/openg1/profile.toml`), written by `examples/07_calibrate.py --save`, is read by both.

One difference to know about: `display.text` here sends to the left arm only, while the TypeScript SDK sends to both (left, then right) as the protocol spec describes. The simulator reports "only the left arm has content" when it sees this.
