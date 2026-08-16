"""A pomodoro timer, driven entirely from the touchbar.

    OPENG1_SIMULATOR=1 python3 examples/apps/timer.py

    tap         start / pause
    double tap  reset

Shows how to hold state across events and redraw from two places without the
two disagreeing — everything goes through `refresh()`, which is the only
method that talks to the screen.
"""

import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from openg1.app import App, run  # noqa: E402

WORK = 25 * 60
BREAK = 5 * 60


class Timer(App):
    name = "timer"
    description = "25/5 pomodoro"
    interval = 1.0

    def __init__(self) -> None:
        super().__init__()
        self.remaining = WORK
        self.running = False
        self.on_break = False
        self.completed = 0
        self._last_drawn = None

    async def start(self) -> None:
        await self.refresh()

    async def tick(self) -> None:
        if not self.running:
            return
        self.remaining -= 1
        if self.remaining <= 0:
            await self.finish()
        await self.refresh()

    async def on_tap(self, event) -> None:
        if event.gesture == "double_tap":
            self.running = False
            self.remaining = BREAK if self.on_break else WORK
        else:
            self.running = not self.running
        await self.refresh()

    async def finish(self) -> None:
        if not self.on_break:
            self.completed += 1
        self.on_break = not self.on_break
        self.remaining = BREAK if self.on_break else WORK
        self.running = False

    async def refresh(self) -> None:
        minutes, seconds = divmod(max(0, self.remaining), 60)
        clock = f"{minutes:02d}:{seconds:02d}"
        state = "running" if self.running else "paused"
        phase = "break" if self.on_break else "focus"

        # Redrawing an identical screen costs a full BLE round trip for no
        # visible change, and on a once-a-second tick that adds up.
        frame = (clock, state, phase, self.completed)
        if frame == self._last_drawn:
            return
        self._last_drawn = frame

        await self.screen.rows(
            f"{clock}  {phase}",
            state,
            f"{self.completed} done today",
        )


if __name__ == "__main__":
    run(Timer())
