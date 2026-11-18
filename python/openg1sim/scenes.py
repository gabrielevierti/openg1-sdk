"""The screens the demo and the web viewer both show.

These used to be written out twice — once in ``__main__.cmd_demo`` and once in
``web.SimulatorServer._demo`` — which meant the terminal tour and the browser
tour drifted apart, and the sine-wave test bitmap existed in two versions with
different periods. One copy, imported by both.
"""

from __future__ import annotations

import math

from openg1.bmp import Bitmap
from openg1.device import G1

#: Short lines for the browser's "run demo" button.
TOUR_LINES: list[str] = [
    "openg1 simulator",
    "Genova to Milano, 145 km",
    "Via Emilia\n2.4 km   4 min\nlimit 50   42 km/h",
]

#: A paragraph that wraps but still fits.
PARAGRAPH = (
    "Genova to Milano is about 145 km. Via Emilia in 2.4 km, then the A7 "
    "north."
)

#: Long enough to need more than one screen, which is the interesting case.
OVERFLOWING = (
    "The panel holds five lines at the default size. This message is "
    "considerably longer than that, so the SDK splits it into screens and "
    "advances them on a timer, which is what the official app does."
)

SINGLE_SCREEN = (
    "The same message pushed as a single screen. Everything past the fifth "
    "line is simply not shown, and no part of the protocol considers that "
    "an error."
)


def test_bitmap() -> Bitmap:
    """A full-width sine between two rules — exercises the whole panel.

    Rows 8 and 127 rather than 0 and 135 so the trace has somewhere to go
    without clipping, and the rules are visibly inside the frame.
    """
    bitmap = Bitmap.blank()
    for x in range(bitmap.width):
        bitmap.set(x, 8)
        bitmap.set(x, 127)
        bitmap.set(x, int(68 + 48 * math.sin(x / 42)))
    return bitmap


async def run_tour(g1: G1, *, page_delay: float = 0.0) -> None:
    """Push the short tour. Used by the browser's demo button."""
    for line in TOUR_LINES:
        await g1.display.text(line, page_delay=page_delay)
