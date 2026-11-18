"""A clock. The smallest app that is actually useful.

    OPENG1_SIMULATOR=1 python3 examples/apps/clock.py

Shows the pattern for anything that updates on its own: set `interval` and
put the work in `tick()`. The framework runs it in a task it also cancels for
you, so you never leak a loop when the app closes.
"""

import pathlib
import sys
from datetime import datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from openg1.app import App, run  # noqa: E402


class Clock(App):
    name = "clock"
    description = "time, date, battery"
    interval = 10.0        # the panel shows minutes; ticking faster is waste

    def __init__(self) -> None:
        super().__init__()
        self.battery = "--"

    async def start(self) -> None:
        await self.refresh()

    async def tick(self) -> None:
        await self.refresh()

    async def on_tap(self, event) -> None:
        # A tap is the cheap way to force a battery read, which is slow
        # enough that doing it on every tick would be rude to the radio.
        level = await self.g1.info.battery()
        self.battery = f"{level.lowest}%"
        await self.refresh()

    async def refresh(self) -> None:
        now = datetime.now()
        await self.screen.rows(
            now.strftime("%H:%M"),
            now.strftime("%A %d %B"),
            f"battery {self.battery}",
        )


if __name__ == "__main__":
    run(Clock())
