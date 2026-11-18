"""Push a picture to the panel.

    python3 examples/05_image.py                  # real glasses
    python3 examples/05_image.py --sim            # render the panel here
    python3 examples/05_image.py --sim --png      # ...and write 05_image-panel.png

`--sim` is the one worth reaching for when an image looks wrong: it draws the
pixels, so a clipped or muddy image is visible without putting the glasses on.

The framebuffer is 576x136 and the glasses show all of it. If your image is
already that size, send it as-is — every extra "helpful" transform is another
chance to lose rows. Only reach for `safe_area` if the top and bottom of the
panel are genuinely cut off for you. Measure it with 07_calibrate.py; do not
guess.
"""

import asyncio
import pathlib
import sys

from _common import glasses  # noqa: E402  (also fixes sys.path)
from openg1.bmp import content_bounds, load_image  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
PATH = str(HERE / "05_image.bmp")

# (hidden_top, hidden_bottom) in pixels, from 07_calibrate.py. (0, 0) = all visible.
SAFE_AREA = (23, 0)

WRITE_PNG = "--png" in sys.argv


def describe(bitmap) -> None:
    bounds = content_bounds(bitmap)
    print(f"panel     : {bitmap.width}x{bitmap.height}")
    print(f"safe area : {SAFE_AREA[0]} hidden top, {SAFE_AREA[1]} hidden bottom")
    print(
        f"ink spans : rows {bounds[0]}-{bounds[1]}"
        if bounds
        else "ink spans : (blank — nothing to show)"
    )


async def main() -> None:
    # Quantise locally first, so we can say what will actually be sent.
    bitmap = load_image(PATH, safe_area=SAFE_AREA, dither=True, fit="stretch")
    describe(bitmap)

    async with glasses() as (g1, sim):
        # No auto_center, no vertical_offset: the bitmap is already the size
        # of the panel, so any shift can only push pixels off it.
        result = await g1.display.bitmap(bitmap, top_down=False)
        print(f"transfer  : {result}")

        if sim is not None:
            print()
            print(sim.panel.frame.to_blocks())
            if WRITE_PNG:
                out = HERE / "05_image-panel.png"
                out.write_bytes(sim.panel.frame.to_png(scale=2))
                print(f"wrote {out}")
        else:
            await asyncio.sleep(5)
        await g1.display.clear()


asyncio.run(main())
