"""Talk to a simulator running in another process.

The emulator inside ``openg1sim`` is fine for tests, but it lives in your app's
process, which means the simulator and the thing being simulated die together.
That is the wrong shape for actually building something: you want the glasses
sitting there in their own window, staying up while you start, crash and
restart your program forty times.

This transport gives you that. It carries exactly the bytes a BLE write would
carry, over a TCP socket to :mod:`openg1sim.appserver`, and returns exactly the
bytes a notification would return. Nothing above it can tell the difference,
which is the whole point — the same code runs on the simulator and on glasses,
and the only thing that changes is how you got your ``G1``.

    from openg1 import G1

    g1 = await G1.connect_simulator()       # 127.0.0.1:8766 by default

Wire format
-----------
One TCP connection per arm. The client opens with a nine-byte hello —
``OG1SIM``, a protocol version byte, an arm byte, and the MTU the client wants
— and after that every message is a four-byte big-endian length followed by
that many bytes. Packets are framed because TCP is a stream and BLE is not: a
write that arrives in two segments must still surface as one packet, or the
session upstream sees a truncated frame and the bug looks like a protocol bug.
"""

from __future__ import annotations

import asyncio
import os

from ..errors import NotConnectedError, OpenG1Error
from .._generated import Arm
from . import Transport

MAGIC = b"OG1SIM"
PROTOCOL_VERSION = 1
#: MAGIC + version + arm + 2-byte MTU.
HELLO_SIZE = len(MAGIC) + 4
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766

#: Set ``OPENG1_SIMULATOR=1`` (or ``host:port``) and :meth:`openg1.G1.connect` goes
#: to the simulator instead of scanning for radios. Handy for running an
#: unmodified program, or someone else's, without a pair on your face.
ENV_VAR = "OPENG1_SIMULATOR"


class SimulatorUnavailable(OpenG1Error):
    """Nothing was listening. Almost always: the simulator is not running."""


def env_target() -> tuple[str, int] | None:
    """Parse ``OPENG1_SIMULATOR``. Returns ``None`` when unset or ``0``/``off``."""
    raw = os.environ.get(ENV_VAR, "").strip()
    if not raw or raw.lower() in ("0", "off", "false", "no"):
        return None
    if raw.lower() in ("1", "on", "true", "yes"):
        return DEFAULT_HOST, DEFAULT_PORT
    host, _, port = raw.rpartition(":")
    if not host:
        return raw, DEFAULT_PORT
    try:
        return host, int(port)
    except ValueError:
        raise OpenG1Error(
            f"{ENV_VAR}={raw!r} is not a host:port, a port, or on/off"
        ) from None


class NetTransport(Transport):
    """One arm's link to a simulator process."""

    def __init__(
        self,
        arm: Arm,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        mtu: int = 247,
    ) -> None:
        self.arm = arm
        self.host = host
        self.port = port
        self._mtu = mtu
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._pump: asyncio.Task | None = None
        self.name = f"Even G1_42_{arm.label}_SIM"
        self.address = f"{host}:{port}#{arm.value}"

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        try:
            self._reader, self._writer = await asyncio.open_connection(
                self.host, self.port
            )
        except OSError as exc:
            raise SimulatorUnavailable(
                f"no simulator on {self.host}:{self.port} — start one with "
                f"`python3 -m openg1sim app`"
            ) from exc

        self._writer.write(
            MAGIC + bytes([PROTOCOL_VERSION, self.arm.value]) + self._mtu.to_bytes(2, "big")
        )
        await self._writer.drain()
        self._pump = asyncio.create_task(self._read_loop())

    async def disconnect(self) -> None:
        if self._pump is not None:
            self._pump.cancel()
            self._pump = None
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except (OSError, asyncio.CancelledError):
                pass
        self._reader = self._writer = None

    @property
    def is_connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    @property
    def max_write(self) -> int:
        return self._mtu - 3

    # -- traffic -----------------------------------------------------------

    async def write(self, data: bytes) -> None:
        if self._writer is None:
            raise NotConnectedError(f"{self.name} is not connected")
        self._writer.write(len(data).to_bytes(4, "big") + bytes(data))
        await self._writer.drain()

    async def _read_loop(self) -> None:
        assert self._reader is not None
        try:
            while True:
                header = await self._reader.readexactly(4)
                size = int.from_bytes(header, "big")
                await self._emit(await self._reader.readexactly(size))
        except (asyncio.IncompleteReadError, ConnectionResetError):
            # The simulator went away. Surface it as a disconnect rather than
            # a traceback: closing the simulator window is a normal thing to
            # do, not a crash in the user's program.
            if self._writer is not None:
                self._writer.close()
                self._writer = None
        except asyncio.CancelledError:
            raise


async def connect_pair(
    host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, *, mtu: int = 247
) -> tuple[NetTransport, NetTransport]:
    """Both arms, connected, ready to hand to :class:`openg1.G1`."""
    left = NetTransport(Arm.LEFT, host=host, port=port, mtu=mtu)
    right = NetTransport(Arm.RIGHT, host=host, port=port, mtu=mtu)
    await left.connect()
    try:
        await right.connect()
    except Exception:
        await left.disconnect()
        raise
    return left, right
