#!/usr/bin/env python3
"""Work out *why* an image is coming out clipped.

    python3 examples/08_diagnose.py            # real glasses
    python3 examples/08_diagnose.py --sim      # render locally instead

There are only two places a band of the picture can go missing, and they are
told apart by one experiment.

1. **Bytes never arrived.** The BMP is bottom-up, so the last bytes on the
   wire are the top rows of the image. Lose the tail of the transfer and the
   *top* of the panel goes blank. Set `top_down=True` and the same loss now
   eats the *bottom* instead — the damage follows the byte order.

2. **The pixels arrived but you cannot see them.** How the glasses sit, and
   the virtual-screen geometry, decide how much of the panel reaches your
   eye. That band stays in the same place whatever the byte order.

So: run this, and watch which edge is missing in each pass. Moves with
top_down -> truncation. Stays put -> measure it with 07_calibrate.py and use
safe_area.
"""

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from openg1 import G1  # noqa: E402
from openg1.bmp import BMP_HEADER_SIZE, content_bounds, load_image, row_stride  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
PATH = str(HERE / "05_image.bmp")
USE_SIM = "--sim" in sys.argv


async def open_display():
    if USE_SIM:
        from openg1sim import SimulatedG1

        sim = SimulatedG1()
        await sim.__aenter__()
        return sim.g1, sim
    g1 = await G1.connect()
    await g1.__aenter__()
    return g1, None


async def main() -> None:
    bitmap = load_image(PATH, dither=True)
    expected = BMP_HEADER_SIZE + row_stride(bitmap.width) * bitmap.height

    print("== the bitmap, before anything is sent ==")
    print(f"  size       : {bitmap.width}x{bitmap.height}")
    print(f"  ink spans  : rows {content_bounds(bitmap)}")
    print(f"  BMP file   : {expected} bytes ({BMP_HEADER_SIZE} header + pixels)")
    print("  If the ink already stops short here, the problem is the source")
    print("  image or load_image, and nothing below matters.\n")

    g1, sim = await open_display()
    try:
        display = g1.display

        print("== transport ==")
        writes = {name: t.max_write for name, t in g1.session.transports.items()}
        for name, write in writes.items():
            print(f"  {name}: {write} bytes per write")
        chunk = display._chunk()
        packets = -(-expected // chunk)
        print(f"  chunk size : {chunk} bytes  (the protocol assumes 194)")
        print(f"  packets    : {packets}")
        if packets > 256:
            print("  !! the chunk index is one byte and wraps after 256.")
            print("     MTU negotiation did not happen. Fix that first.")
        elif chunk < 194:
            print("  !  below the documented chunk size; MTU came out low.")
        print()

        for top_down in (False, True):
            edge = "bottom" if top_down else "top"
            print(f"== top_down={top_down} — truncation would eat the {edge} ==")
            result = await display.bitmap(bitmap, top_down=top_down, verify=False)
            print(f"  {result}")
            if result.bytes_sent != expected:
                print(f"  !! sent {result.bytes_sent}, expected {expected}")
            if not result.ok:
                print("  !! an arm did not confirm the CRC — bytes were lost.")
                print("     Retry with pace=0.002 to rule out buffer overrun.")

            if sim is not None:
                print(sim.panel.frame.to_blocks())
            else:
                print("  Look at the glasses now. Which edge is missing?")
                await asyncio.sleep(8)
            print()

        print("== conclusion ==")
        print("  missing edge moved with top_down -> bytes are being lost")
        print("  missing edge stayed put          -> optics; use safe_area")
    finally:
        if sim is not None:
            await sim.__aexit__(None, None, None)
        else:
            await g1.__aexit__(None, None, None)


asyncio.run(main())
