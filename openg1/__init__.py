"""openg1 — an open SDK for Even Realities G1 smart glasses.

    import asyncio
    from openg1 import G1

    async def main():
        async with await G1.connect() as g1:
            await g1.display.text("hello from openg1")
            print(await g1.info.battery())

    asyncio.run(main())

No hardware to hand? ``openg1sim`` supplies an emulated pair and renders the
panel, and ``sim.g1`` is an ordinary :class:`G1`::

    from openg1sim import SimulatedG1

    async with SimulatedG1() as sim:
        await sim.g1.display.text("hello")
        print(sim.panel.frame.to_blocks())

The layers are deliberately separable. :mod:`openg1.framing`, :mod:`openg1.commands`,
:mod:`openg1.text` and :mod:`openg1.bmp` do not import a BLE stack and never touch
the network, so they can be unit tested, reused in a different runtime, or
ported. :mod:`openg1.transport` is the only part that knows radios exist.

This project is not affiliated with Even Realities. The protocol was pieced
together from Even's own demo app, community captures and a lot of patience;
see ``docs/PROTOCOL.md``, where every command is marked confirmed, observed or
guessed.
"""

from __future__ import annotations

__version__ = "0.1.0"

from ._generated import (
    SPEC_VERSION,
    Arm,
    ButtonAction,
    Cmd,
    DashboardMode,
    DashboardPanel,
    Evt,
    ScreenAction,
    ScreenStatus,
    SilentMode,
    StateEvent,
    Status,
    WeatherIcon,
)
from .device import G1
from .errors import (
    CommandError,
    CommandTimeout,
    DiscoveryError,
    NotConnectedError,
    OpenG1Error,
    PacketTooLargeError,
    ProtocolError,
    TransportError,
    UnsupportedFeature,
)
from .events import (
    AiRequestEvent,
    AiStopEvent,
    AudioEvent,
    BatteryEvent,
    CaseEvent,
    ChargingEvent,
    DashboardEvent,
    Event,
    HeadEvent,
    PairedEvent,
    TouchEvent,
    UnknownEvent,
    WearEvent,
    describe,
)
from .framing import Packet, decode, encode_framed, encode_raw
from .session import Response, Session

__all__ = [
    "__version__",
    "SPEC_VERSION",
    "G1",
    "Session",
    "Response",
    "Packet",
    "decode",
    "encode_raw",
    "encode_framed",
    # enums
    "Arm",
    "Cmd",
    "Evt",
    "Status",
    "StateEvent",
    "ScreenStatus",
    "ScreenAction",
    "DashboardMode",
    "DashboardPanel",
    "WeatherIcon",
    "ButtonAction",
    "SilentMode",
    # events
    "Event",
    "TouchEvent",
    "HeadEvent",
    "WearEvent",
    "CaseEvent",
    "ChargingEvent",
    "DashboardEvent",
    "BatteryEvent",
    "AudioEvent",
    "AiRequestEvent",
    "AiStopEvent",
    "PairedEvent",
    "UnknownEvent",
    "describe",
    # errors
    "OpenG1Error",
    "TransportError",
    "NotConnectedError",
    "DiscoveryError",
    "ProtocolError",
    "PacketTooLargeError",
    "CommandError",
    "CommandTimeout",
    "UnsupportedFeature",
]


def __getattr__(name: str):
    """Lazy access to the BLE helpers so ``import openg1`` never needs bleak."""
    if name in ("scan", "discover_pair", "BleakTransport"):
        from .transport import bleak_transport

        return getattr(bleak_transport, {"scan": "scan", "discover_pair": "discover_pair",
                                         "BleakTransport": "BleakTransport"}[name])
    raise AttributeError(f"module 'openg1' has no attribute {name!r}")
