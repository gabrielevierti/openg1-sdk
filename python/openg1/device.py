"""The object you actually use: :class:`G1`."""

from __future__ import annotations

from typing import Type, TypeVar

from ._generated import Arm
from .api import (
    Audio,
    Dashboard,
    DeviceInfo,
    Display,
    EvenAI,
    Navigation,
    Notifications,
    Settings,
)
from .events import Event
from .session import Session
from .transport import Transport

E = TypeVar("E", bound=Event)


class G1:
    """A pair of Even Realities G1 glasses.

    Construct it from two transports, or let :meth:`connect` find a pair over
    BLE. Without hardware, use ``openg1sim.SimulatedG1``, which supplies its own
    transports and renders the panel::

        async with await G1.connect() as g1:
            await g1.display.text("ciao")
            print(await g1.info.battery())

    Everything is grouped into namespaces — ``display``, ``audio``,
    ``dashboard``, ``notifications``, ``settings``, ``navigation``, ``ai``,
    ``info`` — and the :class:`~openg1.session.Session` underneath stays
    reachable as ``.session`` for anything the namespaces do not cover yet.
    """

    def __init__(self, left: Transport, right: Transport, **session_kw) -> None:
        self.session = Session(left, right, **session_kw)
        self.display = Display(self.session)
        self.audio = Audio(self.session)
        self.dashboard = Dashboard(self.session)
        self.notifications = Notifications(self.session)
        self.settings = Settings(self.session)
        self.navigation = Navigation(self.session)
        self.ai = EvenAI(self.session)
        self.info = DeviceInfo(self.session)

    # -- construction ------------------------------------------------------

    @classmethod
    async def connect(
        cls,
        *,
        timeout: float = 6.0,
        channel: str | None = None,
        use_cache: bool = True,
        **session_kw,
    ) -> "G1":
        """Scan, connect both arms, run the handshake.

        If ``OPENG1_SIMULATOR`` is set, this connects to a running simulator
        instead of scanning for radios — so a program written for hardware,
        including one you did not write, runs against the simulator with no
        code change at all.
        """
        from .transport.net import env_target

        target = env_target()
        if target is not None:
            return await cls.connect_simulator(*target, **session_kw)

        from .transport.bleak_transport import connect_pair, discover_pair

        pair = await discover_pair(timeout, channel=channel, use_cache=use_cache)
        left, right = await connect_pair(pair)
        g1 = cls(left, right, **session_kw)
        await g1.session.start()
        return g1

    @classmethod
    async def connect_simulator(
        cls,
        host: str = "127.0.0.1",
        port: int = 8766,
        *,
        mtu: int = 247,
        **session_kw,
    ) -> "G1":
        """Connect to a simulator running in another process.

        Start one with ``python3 -m openg1sim app``. Everything above the
        transport is identical to hardware, so this is not a special mode —
        it is the same session over a different wire.
        """
        from .transport.net import connect_pair

        left, right = await connect_pair(host, port, mtu=mtu)
        g1 = cls(left, right, **session_kw)
        await g1.session.start()
        return g1

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> "G1":
        await self.session.start()
        return self

    async def disconnect(self) -> None:
        await self.session.stop()

    async def __aenter__(self) -> "G1":
        if not self.session.is_connected:
            await self.session.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.disconnect()

    # -- shortcuts ---------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self.session.is_connected

    @property
    def left(self) -> Transport:
        return self.session.transports[Arm.LEFT]

    @property
    def right(self) -> Transport:
        return self.session.transports[Arm.RIGHT]

    def on(self, event_type: Type[E], handler):
        """Subscribe to an event type. Returns an unsubscribe callable."""
        return self.session.on(event_type, handler)

    async def wait_for(self, event_type: Type[E], timeout: float = 30.0) -> E:
        return await self.session.wait_for(event_type, timeout)

    def events(self):
        """``async for event in g1.events():``"""
        return self.session.stream()

    async def text(self, message: str, **kw) -> None:
        """Shorthand for ``g1.display.text``."""
        await self.display.text(message, **kw)

    async def clear(self) -> None:
        await self.display.clear()
