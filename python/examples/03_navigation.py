"""Turn-by-turn navigation on the glasses.

The official app will not route Genova to Milano — it gives up on long
distances — which is the kind of thing an open SDK exists to fix. This feeds
steps from any router you like onto the display, with speed and speed limit,
and pages them as you drive.

Swap `fake_route()` for a real routing source (OSRM, Valhalla, GraphHopper)
and it is a working navigation app.
"""

import asyncio

from _common import glasses  # noqa: E402  (also fixes sys.path)

from openg1.api.navigation import Maneuver, Step


def fake_route() -> list[Step]:
    return [
        Step(Maneuver.CONTINUE, 1200, "A7 towards Milano", 142_000, 5880, 108, 130),
        Step(Maneuver.SLIGHT_RIGHT, 800, "Exit Serravalle", 118_000, 4800, 96, 110),
        Step(Maneuver.ROUNDABOUT, 300, "SP35bis", 117_000, 4700, 48, 50),
        Step(Maneuver.TURN_LEFT, 150, "Via Emilia", 2_400, 240, 42, 50),
        Step(Maneuver.ARRIVE, 0, "Milano Centrale", 0, 0, 0, 50),
    ]


async def main() -> None:
    async with glasses() as (g1, sim):
        await g1.display.brightness(30)
        for step in fake_route():
            await g1.navigation.update(step)
            if sim:
                print("-" * 40)
                print(sim.emulator.left.screen_text)
            await asyncio.sleep(0.5 if sim else 8.0)
        await g1.navigation.stop()


asyncio.run(main())
