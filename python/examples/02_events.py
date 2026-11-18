"""React to the wearer.

Prints everything the glasses report and binds a couple of gestures. This is
also the quickest way to discover sub-codes nobody has documented — anything
unrecognised prints as UnknownEvent with its raw bytes.
"""

import asyncio

from _common import glasses  # noqa: E402  (also fixes sys.path)

from openg1 import HeadEvent, TouchEvent, WearEvent, describe


async def main() -> None:
    async with glasses() as (g1, sim):
        async def on_touch(event: TouchEvent) -> None:
            if event.gesture == "double_tap":
                await g1.display.text("double tap", page_delay=0, hold=1)
            elif event.gesture == "single_tap":
                battery = await g1.info.battery()
                await g1.display.text(f"{battery.lowest}%", page_delay=0, hold=1)

        g1.on(TouchEvent, on_touch)
        g1.on(HeadEvent, lambda e: print("head", "up" if e.up else "down"))
        g1.on(WearEvent, lambda e: print("worn" if e.worn else "removed"))

        if sim:
            # Drive the emulator so the example does something on its own.
            for action in (sim.tap(), sim.tap(count=2), sim.wear(True)):
                await action
                await asyncio.sleep(0.3)
            return

        print("listening — tap the touchbar, look up, take the glasses off")
        stream = g1.events()
        while True:
            print(describe(await stream.__anext__()))


asyncio.run(main())
