"""openg1sim — a visual simulator for Even Realities G1 smart glasses.

This is the only way to run openg1 without hardware. It emulates the firmware —
parsing real packets, enforcing acknowledgement ordering, verifying bitmap
CRCs — and renders the resulting 576x136 panel to actual pixels, so you can
catch a line that overflows, a paragraph that needed four screens, or an image
that dithered into mud, none of which show up in a byte log.

    from openg1sim import SimulatedG1

    async with SimulatedG1() as sim:
        await sim.g1.display.text("ciao from openg1")
        print(sim.panel.frame.to_blocks())      # in a terminal
        open("panel.png", "wb").write(sim.panel.frame.to_png(scale=2))

Or run it:

    python3 -m openg1sim demo        # scripted tour in the terminal
    python3 -m openg1sim term        # live terminal viewer
    python3 -m openg1sim web         # browser viewer with clickable controls
    python3 -m openg1sim dev app.py  # browser viewer that reloads app.py on save
    python3 -m openg1sim app         # standalone simulator your program connects to

For building a whole application without the glasses, see
``docs/SIMULATOR_APP.md``.

Nothing here needs hardware, a radio, or any third-party package.
"""

from .framebuffer import DISPLAY_HEIGHT, DISPLAY_WIDTH, Framebuffer, Region
from .panel import (
    MODE_AI_COMPLETE,
    MODE_AI_DISPLAYING,
    MODE_AI_ERROR,
    MODE_AI_MANUAL,
    MODE_TEXT,
    Panel,
    PanelState,
    RenderReport,
)
from .emulator import ArmState, EmulatedGlasses, MockTransport
from .device import ObservedTransport, SimulatedG1

__version__ = "0.1.0"

__all__ = [
    "SimulatedG1",
    "ObservedTransport",
    "EmulatedGlasses",
    "ArmState",
    "MockTransport",
    "Panel",
    "PanelState",
    "RenderReport",
    "Framebuffer",
    "Region",
    "DISPLAY_WIDTH",
    "DISPLAY_HEIGHT",
    "MODE_TEXT",
    "MODE_AI_DISPLAYING",
    "MODE_AI_COMPLETE",
    "MODE_AI_MANUAL",
    "MODE_AI_ERROR",
    "__version__",
]
