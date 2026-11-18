"""Copy this file and build your app in it.

It runs identically on the simulator and on the glasses. Nothing in here is
simulator-specific and nothing needs changing when you switch — the only
difference is one environment variable.

    python3 -m openg1sim                          # window, leave it open
    OPENG1_SIMULATOR=1 python3 10_starter.py      # against the simulator
    python3 10_starter.py                         # against your glasses

Two rules keep it that way.

1. `app()` takes a `G1` and never asks where it came from. Keep your logic in
   there and the switch is free.
2. Lay out inside the visible band. `openg1 profile` says what yours is; on a
   pair with hidden rows at the top, the firmware's first text line lands
   where you cannot read it, so `say()` below pads for it. That padding is
   computed from your profile, so it is zero on an uncalibrated or
   fully-visible pair and correct on yours.
"""

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from openg1 import G1, HeadEvent, TouchEvent  # noqa: E402
from openg1 import profile  # noqa: E402

LINE_HEIGHT = 24  # what the firmware uses at the default text size


def hidden_lines() -> int:
    """Text lines swallowed by the rows this device cannot show.

    The firmware decides where text goes and the SDK cannot move it, so the
    only fix is to start lower. Reading it from the profile means this is
    right on any pair, including one where nothing is hidden.
    """
    return -(-profile.active().hidden_top // LINE_HEIGHT)


async def say(g1: G1, message: str, **kw) -> None:
    """display.text, shifted below the rows you cannot see."""
    await g1.display.text("\n" * hidden_lines() + message, **kw)


# ---------------------------------------------------------------------------
# Your app
# ---------------------------------------------------------------------------

async def app(g1: G1) -> None:
    await g1.display.brightness(30)
    await say(g1, "ciao — tap the touchbar")

    async def on_touch(event: TouchEvent) -> None:
        battery = await g1.info.battery()
        await say(g1, f"{event.gesture}\n{battery.lowest}% battery")

    async def on_head(event: HeadEvent) -> None:
        if event.up:
            await say(g1, "looking up")

    g1.on(TouchEvent, on_touch)
    g1.on(HeadEvent, on_head)

    await asyncio.Event().wait()   # run until you stop it


# ---------------------------------------------------------------------------
# Plumbing — you should not need to touch this
# ---------------------------------------------------------------------------

async def main() -> None:
    device = profile.active()
    print(device.describe())
    if not device.calibrated:
        print(
            "  (uncalibrated — run examples/07_calibrate.py --save so the "
            "simulator\n   matches what you actually see)"
        )

    async with await G1.connect() as g1:      # honours OPENG1_SIMULATOR
        try:
            await app(g1)
        finally:
            await g1.display.clear()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
