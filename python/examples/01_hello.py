"""The smallest useful program: connect, show something, read the battery.

    python3 01_hello.py            # real glasses
    python3 01_hello.py --sim  # simulated glasses, no hardware needed
"""

import asyncio

from _common import glasses  # noqa: E402  (also fixes sys.path)



async def main() -> None:
    async with glasses() as (g1, sim):
        battery = await g1.info.battery()
        firmware = await g1.info.firmware()
        print(f"firmware {firmware.version} — battery {battery.left}% / {battery.right}%")

        await g1.display.text("ciao from openg1", hold=3.0)
        if sim:
            print(f"the emulator saw: {sim.emulator.left.screen_text!r}")
        await g1.display.clear()


asyncio.run(main())
