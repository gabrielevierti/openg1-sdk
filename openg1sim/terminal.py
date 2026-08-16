"""A live view of the panel in a terminal, with keys to poke at it.

Half-block characters give two vertical pixels per terminal row, which is
just enough resolution to read 21-pixel text in a 144-column window. The
alternative — ASCII art at one character per pixel block — looks fine for
shapes and is useless for words.

    python3 -m openg1sim term

Keys: t tap, T double tap, y triple tap, h hold, u/j head up and down,
w wear, d dashboard, b battery, c clear, p save a PNG, q quit.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
from datetime import datetime

from openg1._generated import Arm

from .device import SimulatedG1

CLEAR = "\x1b[2J\x1b[H"
HIDE_CURSOR = "\x1b[?25l"
SHOW_CURSOR = "\x1b[?25h"
GREEN = "\x1b[38;2;110;245;200m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"

HELP = (
    "t tap  T double  y triple  h hold  u/j head  w wear  "
    "d dash  b battery  c clear  p png  q quit"
)


class TerminalViewer:
    """Repaints whenever the panel changes, and reads single keypresses."""

    def __init__(self, sim: SimulatedG1, *, colour: bool = True) -> None:
        self.sim = sim
        self.colour = colour and sys.stdout.isatty()
        self.log: list[str] = []
        self.running = True
        self._battery = 87
        self._worn = True
        self._head_up = True
        self._dashboard = False

    def note(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log.append(f"{stamp}  {message}")
        del self.log[:-6]

    # -- painting ----------------------------------------------------------

    def paint(self) -> None:
        frame = self.sim.panel.frame
        report = self.sim.report()
        out = [CLEAR]

        title = f"openg1 simulator — {frame.width}x{frame.height}, frame {self.sim.frames}"
        out.append(self._dim(title) + "\n")
        out.append(self._dim("┌" + "─" * 144 + "┐") + "\n")
        for row in frame.to_blocks().splitlines():
            out.append(self._dim("│") + self._green(row.ljust(144)) + self._dim("│") + "\n")
        out.append(self._dim("└" + "─" * 144 + "┘") + "\n")

        status = (
            f"battery {self._battery}%   "
            f"{'worn' if self._worn else 'not worn'}   "
            f"head {'up' if self._head_up else 'down'}   "
            f"{'dashboard' if self._dashboard else 'text'}   "
            f"{report.lit_pixels} px lit"
        )
        if report.truncated_lines:
            status += f"   {report.truncated_lines} line(s) did not fit"
        if report.overflow:
            status += f"   {len(report.overflow)} line(s) overflow the panel"
        out.append(status + "\n")

        out.append(self._dim(HELP) + "\n\n")
        for line in self.log:
            out.append(self._dim(line) + "\n")

        sys.stdout.write("".join(out))
        sys.stdout.flush()

    def _green(self, text: str) -> str:
        return f"{GREEN}{text}{RESET}" if self.colour else text

    def _dim(self, text: str) -> str:
        return f"{DIM}{text}{RESET}" if self.colour else text

    # -- input -------------------------------------------------------------

    async def handle_key(self, key: str) -> None:
        sim, g1 = self.sim, self.sim.g1
        if key in ("q", "\x03", "\x04"):
            self.running = False
        elif key == "t":
            await sim.tap(Arm.RIGHT)
            self.note("tap on the right arm")
        elif key == "T":
            await sim.tap(Arm.RIGHT, 2)
            self.note("double tap on the right arm")
        elif key == "y":
            await sim.tap(Arm.RIGHT, 3)
            self.note("triple tap on the right arm")
        elif key == "h":
            await sim.hold(Arm.LEFT)
            self.note("hold on the left arm — this is the Even AI trigger")
        elif key in ("u", "j"):
            self._head_up = key == "u"
            await sim.head_up(self._head_up)
            self.note(f"head {'up' if self._head_up else 'down'}")
        elif key == "w":
            self._worn = not self._worn
            await sim.wear(self._worn)
            self.note("glasses worn" if self._worn else "glasses removed")
        elif key == "d":
            self._dashboard = not self._dashboard
            sim.set_clock(datetime.now().strftime("%H:%M"), "18°  clear")
            await sim.dashboard(self._dashboard)
            self.note(f"dashboard {'opened' if self._dashboard else 'closed'}")
        elif key == "b":
            self._battery = max(0, self._battery - 10)
            await sim.battery_report(self._battery)
            self.note(f"battery now {self._battery}%")
        elif key == "c" and g1 is not None:
            await g1.display.clear()
            self.note("screen cleared")
        elif key == "p":
            path = os.path.abspath("openg1-panel.png")
            with open(path, "wb") as handle:
                handle.write(self.sim.panel.frame.to_png(scale=2))
            self.note(f"saved {path}")

    # -- loop --------------------------------------------------------------

    async def run(self, script=None) -> None:
        queue = self.sim.frame_queue()
        self.paint()

        async def repaint() -> None:
            while self.running:
                await queue.get()
                self.paint()

        painter = asyncio.create_task(repaint())
        reader = asyncio.create_task(self._read_keys())
        tasks = [painter, reader]
        if script is not None:
            tasks.append(asyncio.create_task(script(self)))

        try:
            while self.running:
                await asyncio.sleep(0.05)
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _read_keys(self) -> None:
        """Single keypresses without Enter, where the platform allows it."""
        if not sys.stdin.isatty():
            return
        try:
            import termios
            import tty
        except ImportError:  # pragma: no cover — Windows
            return

        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str] = asyncio.Queue()

        try:
            tty.setcbreak(fd)
            loop.add_reader(fd, lambda: queue.put_nowait(sys.stdin.read(1)))
            while self.running:
                key = await queue.get()
                await self.handle_key(key)
        finally:
            with contextlib.suppress(Exception):
                loop.remove_reader(fd)
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)


async def run_terminal(script=None, *, colour: bool = True) -> None:
    async with SimulatedG1() as sim:
        viewer = TerminalViewer(sim, colour=colour)
        viewer.note("simulator ready — nothing here touches real hardware")

        from openg1.events import Event

        sim.g1.session.on(Event, lambda event: viewer.note(f"event: {event}"))

        sys.stdout.write(HIDE_CURSOR)
        try:
            await viewer.run(script)
        finally:
            sys.stdout.write(SHOW_CURSOR + "\n")
            sys.stdout.flush()
