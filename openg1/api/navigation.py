"""Turn-by-turn navigation.

Honesty first: the byte layout of the 0x0A command has not been established.
What follows is a structured builder that produces a plausible payload and a
text fallback that definitely works today, so navigation apps can be written
now and switched over the moment the real layout is known.

If you decode 0x0A, :meth:`Navigation.encode_step` is the single function to
replace and every consumer of this SDK gets it for free.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum

from .. import commands as cmd
from ..session import Response, Session


class Maneuver(IntEnum):
    """Turn icons, numbered as the official app appears to number them."""

    CONTINUE = 0
    TURN_LEFT = 1
    TURN_RIGHT = 2
    SLIGHT_LEFT = 3
    SLIGHT_RIGHT = 4
    SHARP_LEFT = 5
    SHARP_RIGHT = 6
    U_TURN = 7
    ROUNDABOUT = 8
    MERGE = 9
    EXIT_LEFT = 10
    EXIT_RIGHT = 11
    ARRIVE = 12


@dataclass
class Step:
    """One instruction on a route."""

    maneuver: Maneuver = Maneuver.CONTINUE
    distance_m: int = 0
    road: str = ""
    #: Distance and time to the destination, not to this step.
    remaining_m: int = 0
    eta_s: int = 0
    speed_kmh: int = 0
    speed_limit_kmh: int = 0

    def as_text(self) -> str:
        """The fallback rendering: plain text on the display."""
        head = _distance(self.distance_m)
        line1 = f"{head} {_verb(self.maneuver)}".strip()
        line2 = self.road
        parts = []
        if self.remaining_m:
            parts.append(_distance(self.remaining_m))
        if self.eta_s:
            parts.append(f"{self.eta_s // 60} min")
        if self.speed_limit_kmh:
            parts.append(f"limit {self.speed_limit_kmh}")
        if self.speed_kmh:
            parts.append(f"{self.speed_kmh} km/h")
        return "\n".join(x for x in (line1, line2, "   ".join(parts)) if x)


def _verb(m: Maneuver) -> str:
    return {
        Maneuver.CONTINUE: "continue",
        Maneuver.TURN_LEFT: "turn left",
        Maneuver.TURN_RIGHT: "turn right",
        Maneuver.SLIGHT_LEFT: "bear left",
        Maneuver.SLIGHT_RIGHT: "bear right",
        Maneuver.SHARP_LEFT: "sharp left",
        Maneuver.SHARP_RIGHT: "sharp right",
        Maneuver.U_TURN: "U-turn",
        Maneuver.ROUNDABOUT: "at the roundabout",
        Maneuver.MERGE: "merge",
        Maneuver.EXIT_LEFT: "exit left",
        Maneuver.EXIT_RIGHT: "exit right",
        Maneuver.ARRIVE: "arrive",
    }[m]


def _distance(metres: int) -> str:
    if metres <= 0:
        return ""
    if metres < 1000:
        return f"{round(metres / 10) * 10} m"
    return f"{metres / 1000:.1f} km"


class Navigation:
    def __init__(self, session: Session) -> None:
        self._s = session
        #: Flip to False once 0x0A is decoded and verified on hardware.
        self.use_text_fallback = True

    @staticmethod
    def encode_step(step: Step) -> bytes:
        """Speculative 0x0A payload. Replace this when the layout is known."""
        return struct.pack(
            "<BIIIHH",
            int(step.maneuver),
            step.distance_m & 0xFFFFFFFF,
            step.remaining_m & 0xFFFFFFFF,
            step.eta_s & 0xFFFFFFFF,
            step.speed_kmh & 0xFFFF,
            step.speed_limit_kmh & 0xFFFF,
        ) + step.road.encode("utf-8")[:64]

    async def update(self, step: Step) -> Response | None:
        """Show one instruction.

        Uses the text path by default because it is the one that is known to
        work. Set ``use_text_fallback = False`` to send the binary command.
        """
        if self.use_text_fallback:
            from .display import Display

            await Display(self._s).text(step.as_text(), page_delay=0)
            return None
        return await self._s.send(cmd.set_navigation(self.encode_step(step)))

    async def raw(self, payload: bytes) -> Response:
        """Send an arbitrary 0x0A payload. For experimenting."""
        return await self._s.send(cmd.set_navigation(payload))

    async def stop(self) -> None:
        await self._s.send(cmd.clear_screen())
