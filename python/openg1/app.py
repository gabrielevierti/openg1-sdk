"""Write a mini-app once; run it on the simulator and on the glasses.

This is a thin layer over :class:`openg1.G1`. You never have to use it — every
example in this repo works with the raw API — but it handles the two things
that are tedious to get right in every app, and easy to get wrong once:

**Layout inside the rows you can actually see.** The firmware puts the first
line of text at the top of the panel, and on a pair where the top rows are
hidden that line is simply lost. :class:`Screen` reads your device profile and
pads for it, so ``screen.show("ciao")`` is readable on any pair, including one
where nothing is hidden and the padding is zero.

**A lifecycle.** An app that binds event handlers needs to unbind them when it
stops, or the next app inherits them and you spend an evening wondering why
your timer reacts to the clock's taps.

    from openg1.app import App, run

    class Hello(App):
        name = "hello"

        async def start(self):
            await self.screen.show("ciao")

        async def on_tap(self, event):
            await self.screen.show(f"you tapped {event.gesture}")

    run(Hello())

``run()`` connects — to the simulator if ``OPENG1_SIMULATOR`` is set, to real
glasses otherwise — and does not return until you stop it.
"""

from __future__ import annotations

import asyncio
import contextlib

from . import profile as profile_mod
from .device import G1
from .events import HeadEvent, TouchEvent, WearEvent

#: What the firmware uses per line at the default text size.
LINE_HEIGHT = 24

#: Lines that fit on the panel when nothing is hidden.
PANEL_LINES = 5


class Screen:
    """Text output that lands where the wearer can read it.

    Every app gets one as ``self.screen``. The only reason to build one
    yourself is if you are not using :class:`App`.
    """

    def __init__(self, g1: G1, device=None) -> None:
        self.g1 = g1
        self.device = device or profile_mod.active()

    @property
    def hidden_lines(self) -> int:
        """Text lines swallowed by the hidden rows at the top of the panel."""
        return -(-self.device.hidden_top // LINE_HEIGHT)

    @property
    def lines(self) -> int:
        """How many lines of text you actually have to work with.

        Worth checking rather than assuming five: on a pair with hidden rows
        it is fewer, and a layout designed for five will lose its last line
        silently.
        """
        usable = self.device.visible_height // LINE_HEIGHT
        return max(1, min(PANEL_LINES, usable))

    async def show(self, message: str, **kw) -> None:
        """Display text, padded below the rows this device cannot show."""
        await self.g1.display.text("\n" * self.hidden_lines + message, **kw)

    async def rows(self, *lines: str, **kw) -> None:
        """Display one line per argument, trimmed to what fits.

        Trimming rather than letting the firmware drop the overflow, because
        a line you chose to leave out is a decision and a line the firmware
        discarded is a bug you cannot see.
        """
        await self.show("\n".join(lines[: self.lines]), **kw)

    async def clear(self) -> None:
        await self.g1.display.clear()


class App:
    """Base class for a mini-app.

    Override what you need. Everything is optional except ``name``, and even
    that only shows up in the launcher.
    """

    name: str = "app"
    description: str = ""

    def __init__(self) -> None:
        self.g1: G1 | None = None
        self.screen: Screen | None = None
        self._unbind: list = []
        self._task: asyncio.Task | None = None

    # -- what you override -------------------------------------------------

    async def start(self) -> None:
        """Called once when the app is opened. Draw your first screen here."""

    async def tick(self) -> None:
        """Called repeatedly if :attr:`interval` is set. Optional."""

    async def stop(self) -> None:
        """Called when the app is closed. Release anything you took."""

    async def on_tap(self, event: TouchEvent) -> None: ...
    async def on_head(self, event: HeadEvent) -> None: ...
    async def on_wear(self, event: WearEvent) -> None: ...

    #: Seconds between :meth:`tick` calls. ``None`` means never.
    interval: float | None = None

    # -- what the framework does -------------------------------------------

    async def _attach(self, g1: G1, device=None) -> None:
        self.g1 = g1
        self.screen = Screen(g1, device)
        self._unbind = [
            g1.on(TouchEvent, self._safely(self.on_tap)),
            g1.on(HeadEvent, self._safely(self.on_head)),
            g1.on(WearEvent, self._safely(self.on_wear)),
        ]
        await self.start()
        if self.interval:
            self._task = asyncio.create_task(self._ticker())

    async def _detach(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        for unbind in self._unbind:
            with contextlib.suppress(Exception):
                unbind()
        self._unbind = []
        await self.stop()

    async def _ticker(self) -> None:
        while True:
            await asyncio.sleep(self.interval or 1.0)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[{self.name}] tick failed: {exc}")

    def _safely(self, handler):
        """Wrap a handler so one bad event cannot kill the session.

        A traceback out of an event callback would otherwise propagate into
        the notification pump and take the connection down — which on the
        glasses looks like them freezing for no reason.
        """

        async def wrapped(event):
            try:
                await handler(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[{self.name}] {type(event).__name__} failed: {exc}")

        return wrapped


class Launcher(App):
    """Several apps, one at a time, switched with a triple tap.

    This is the shape the whole project is aimed at: small apps that each do
    one thing, in a shell that decides which is on screen.
    """

    name = "launcher"

    def __init__(self, apps: list[App], *, switch: str = "triple_tap") -> None:
        super().__init__()
        if not apps:
            raise ValueError("a launcher needs at least one app")
        self.apps = apps
        self.switch = switch
        self.index = 0

    @property
    def current(self) -> App:
        return self.apps[self.index]

    async def start(self) -> None:
        await self._open(self.index)

    async def stop(self) -> None:
        await self.current._detach()

    async def _open(self, index: int) -> None:
        self.index = index % len(self.apps)
        assert self.g1 is not None
        await self.current._attach(self.g1, self.screen.device)

    async def on_tap(self, event: TouchEvent) -> None:
        # The launcher only claims one gesture; everything else belongs to
        # whichever app is open, which is why it forwards rather than
        # swallowing.
        if event.gesture == self.switch:
            await self.current._detach()
            await self._open(self.index + 1)
        else:
            await self.current.on_tap(event)

    async def on_head(self, event: HeadEvent) -> None:
        await self.current.on_head(event)

    async def on_wear(self, event: WearEvent) -> None:
        await self.current.on_wear(event)


async def run_async(app: App, *, g1: G1 | None = None) -> None:
    """Run an app until cancelled. Supply ``g1`` to reuse a connection."""
    own = g1 is None
    if g1 is None:
        g1 = await G1.connect()  # honours OPENG1_SIMULATOR
    try:
        await app._attach(g1)
        await asyncio.Event().wait()
    finally:
        with contextlib.suppress(Exception):
            await app._detach()
        if own:
            with contextlib.suppress(Exception):
                await g1.display.clear()
                await g1.disconnect()


def run(app: App) -> None:
    """Blocking entry point. What you call from ``__main__``."""
    device = profile_mod.active()
    print(device.describe())
    try:
        asyncio.run(run_async(app))
    except KeyboardInterrupt:
        pass
