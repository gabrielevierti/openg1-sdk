#!/usr/bin/env python3
"""Find out which rows of the panel you can actually read.

    python3 examples/07_calibrate.py              # ruler at your current geometry
    python3 examples/07_calibrate.py --sweep      # try every virtual-screen height
    python3 examples/07_calibrate.py --set 4,3    # apply height,depth and look
    python3 examples/07_calibrate.py --verify 23  # check a safe area you measured
    python3 examples/07_calibrate.py --save 23    # write it to your device profile
    python3 examples/07_calibrate.py --sim        # render locally instead

Draws a full-width ruler: a labelled rule every 16 rows and a tick every 8,
numbered on both sides. Read off the lowest and highest numbers you can make
out — those bracket your visible band.

Try `--sweep` before you settle for a smaller picture. The virtual screen's
height and depth decide where the panel sits in your field of view, and a
band that is unreachable at one setting is often fully visible at another.
Shrinking the image with `safe_area` costs resolution permanently; moving the
display costs nothing.
"""

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from openg1 import G1  # noqa: E402
from openg1.bmp import Bitmap  # noqa: E402
from openg1sim.font import glyph  # noqa: E402

LABEL_EVERY = 16
TICK_EVERY = 8
HOLD = 6.0

USE_SIM = "--sim" in sys.argv


def draw_text(bm: Bitmap, text: str, x: int, y: int, scale: int = 2) -> int:
    """Blit 5x7 glyphs, bit 0 at the top. Returns the width drawn."""
    start = x
    for ch in text:
        for col, bits in enumerate(glyph(ch)):
            for row in range(7):
                if not (bits >> row) & 1:
                    continue
                for sx in range(scale):
                    for sy in range(scale):
                        bm.set(x + col * scale + sx, y + row * scale + sy, 1)
        x += 6 * scale
    return x - start


def ruler() -> Bitmap:
    """A vertical ruler that fits inside 136 rows without labels colliding.

    Numbers sit *above* the rule they mark, so the bottom-most label stays on
    the panel; a 14px glyph starting at row 128 would not. Row 0 needs no
    number — it is the frame edge.
    """
    bm = Bitmap.blank()
    right = bm.width - 1
    bottom = bm.height - 1

    # A one-pixel frame. A missing edge is the whole point of the exercise.
    for x in range(bm.width):
        bm.set(x, 0, 1)
        bm.set(x, bottom, 1)
    for y in range(bm.height):
        bm.set(0, y, 1)
        bm.set(right, y, 1)

    for y in range(0, bm.height, TICK_EVERY):
        labelled = y % LABEL_EVERY == 0 and y > 0
        if labelled:
            span, step = range(78, bm.width - 78), 2      # long dashes
        else:
            span, step = range(170, bm.width - 170), 4    # short ticks
        for x in span:
            if x % step == 0:
                bm.set(x, y, 1)

        if labelled:
            text = str(y)
            top = y - 15
            draw_text(bm, text, 8, top)
            draw_text(bm, text, right - 8 - 12 * len(text), top)

    # Unmistakable edge markers, in the middle where the numbers are not.
    for word, top in (("TOP", 1), ("BOTTOM", bm.height - 15)):
        width = 12 * len(word)
        draw_text(bm, word, (bm.width - width) // 2, top)

    return bm


def safe_box(hidden_top: int, hidden_bottom: int) -> Bitmap:
    """A frame drawn exactly where `safe_area` would put your picture.

    This is the check, not another measurement: if all four sides of the box
    are visible, that safe area works. If the top edge is missing, raise
    `hidden_top` and look again.
    """
    bm = Bitmap.blank()
    top = hidden_top
    bottom = bm.height - 1 - hidden_bottom
    if top >= bottom:
        raise ValueError(f"({hidden_top}, {hidden_bottom}) leaves no rows")

    for x in range(bm.width):
        bm.set(x, top, 1)
        bm.set(x, bottom, 1)
    for y in range(top, bottom + 1):
        bm.set(0, y, 1)
        bm.set(bm.width - 1, y, 1)

    # Thick corner brackets — an edge that is merely dim is still findable.
    for dx in range(40):
        for dy in range(3):
            for x in (dx, bm.width - 1 - dx):
                bm.set(x, top + dy, 1)
                bm.set(x, bottom - dy, 1)

    label = f"SAFE {hidden_top},{hidden_bottom}"
    draw_text(bm, label, (bm.width - 12 * len(label)) // 2, top + 6)
    draw_text(bm, "ALL 4 EDGES?", (bm.width - 12 * 12) // 2, bottom - 20)
    return bm


async def show(display, sim, caption: str, bitmap: Bitmap | None = None) -> None:
    print(f"\n-- {caption}")
    await display.bitmap(bitmap if bitmap is not None else ruler(), top_down=False)
    if sim is not None:
        print(sim.panel.frame.to_blocks())
    else:
        await asyncio.sleep(HOLD)


def parse_set() -> tuple[int, int] | None:
    if "--set" not in sys.argv:
        return None
    raw = sys.argv[sys.argv.index("--set") + 1]
    height, _, depth = raw.partition(",")
    return int(height), int(depth)


async def main() -> None:
    if USE_SIM:
        from openg1sim import SimulatedG1

        sim = SimulatedG1()
        await sim.__aenter__()
        g1 = sim.g1
    else:
        sim = None
        g1 = await G1.connect()
        await g1.__aenter__()

    try:
        display = g1.display

        try:
            original = await display.get_geometry()
            print(f"current geometry: height={original[0]} depth={original[1]}")
        except Exception as exc:  # older firmware may not answer
            original = None
            print(f"could not read the current geometry ({exc})")

        if "--save" in sys.argv:
            raw = sys.argv[sys.argv.index("--save") + 1]
            top, _, bot = raw.partition(",")
            from openg1.profile import DeviceProfile

            device = DeviceProfile(
                name="my-g1", hidden_top=int(top), hidden_bottom=int(bot or 0)
            )
            written = device.save()
            print(f"\nwrote {written}")
            print(f"  {device.describe()}")
            print(
                "\nThe simulator now dims those rows and display.image() "
                "letterboxes into\nwhat is left — so what you build in the "
                "window is what reaches your eye."
            )
            return

        if "--verify" in sys.argv:
            raw = sys.argv[sys.argv.index("--verify") + 1]
            top, _, bot = raw.partition(",")
            margins = (int(top), int(bot or 0))
            await show(
                display,
                sim,
                f"safe area {margins}",
                safe_box(*margins),
            )
            print(
                "\nAll four edges visible -> that safe area is right.\n"
                "Top edge missing      -> raise the first number and rerun.\n"
                "Lots of slack at the top -> lower it; every hidden row costs "
                "resolution."
            )
            return

        chosen = parse_set()
        if chosen:
            print(f"applying height={chosen[0]} depth={chosen[1]}")
            await display.set_geometry(*chosen)
            await show(display, sim, f"height={chosen[0]} depth={chosen[1]}")

        elif "--sweep" in sys.argv:
            depth = original[1] if original else 3
            print(
                f"\nSweeping height 0-8 at depth {depth}. For each, note the "
                f"lowest\nand highest number you can read. This changes a "
                f"persistent setting;"
            )
            if original:
                print(f"yours was height={original[0]} depth={original[1]}.")
            for height in range(9):
                await display.set_geometry(height, depth)
                await show(display, sim, f"height={height} depth={depth}")
            if original:
                print(f"\nrestoring height={original[0]} depth={original[1]}")
                await display.set_geometry(*original)

        else:
            await show(display, sim, "current geometry")

        print(
            "\nLowest number you can read  -> hidden_top\n"
            "Highest number you can read -> 136 minus hidden_bottom\n"
            "If 0 and 128 are both readable, nothing is hidden and SAFE_AREA "
            "stays (0, 0).\n"
            "Otherwise put those margins in 05_image.py, or call "
            "display.set_safe_area(top, bottom)."
        )
    finally:
        if sim is not None:
            await sim.__aexit__(None, None, None)
        else:
            await g1.display.clear()
            await g1.__aexit__(None, None, None)


asyncio.run(main())
