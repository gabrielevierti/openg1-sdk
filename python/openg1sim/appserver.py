"""The simulator as an application you leave running.

    python3 -m openg1sim app

Two servers in one process:

* a **glasses endpoint** on TCP 8766, which your program connects to instead
  of a pair of radios;
* the **panel** on http://127.0.0.1:8765, which shows what the wearer would
  see and gives you buttons for the things a wearer does — tap, look up, take
  the glasses off, run the battery down.

The division of labour matters and mirrors the real thing. Your app owns the
display; the simulator owns the input. So while an app is attached, the
"send to the glasses" controls in the browser are disabled: something else is
driving that screen, and letting two writers fight over it would produce
confusing results that have no equivalent on hardware.

Nothing here is a special mode of the SDK. The bytes on the socket are the
bytes that would have gone over BLE, so an app that works against this works
against glasses for the same reasons, and the day you do put them on, the
only line that changes is how you got your ``G1``.
"""

from __future__ import annotations

import asyncio
import contextlib

from openg1._generated import Arm

from .device import SimulatedG1
from .emulator import MockTransport
from .net import GLASSES_PORT, HELLO_SIZE, MAGIC, PROTOCOL_VERSION
from .web import SimulatorServer


class GlassesEndpoint:
    """Accepts arm connections and shuttles packets to the emulator."""

    def __init__(
        self,
        sim: SimulatedG1,
        *,
        host: str = "127.0.0.1",
        port: int = GLASSES_PORT,
        on_change=None,
    ) -> None:
        self.sim = sim
        self.host = host
        self.port = port
        self._on_change = on_change or (lambda: None)
        self._clients: dict[Arm, asyncio.StreamWriter] = {}
        self.connections = 0

    @property
    def attached(self) -> bool:
        """True once both arms are held by a remote app.

        Both, not either: a session is only usable when it can write to the
        pair, and reporting "attached" after one arm arrives makes the browser
        flicker between states during the handshake.
        """
        return len(self._clients) == 2

    def transport_for(self, arm: Arm) -> MockTransport:
        return (
            self.sim.emulator.left_transport
            if arm is Arm.LEFT
            else self.sim.emulator.right_transport
        )

    # -- serving -----------------------------------------------------------

    async def serve(self) -> asyncio.AbstractServer:
        server = await asyncio.start_server(self._handle, self.host, self.port)
        return server

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            hello = await asyncio.wait_for(reader.readexactly(HELLO_SIZE), timeout=5)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            writer.close()
            return

        if hello[:6] != MAGIC or hello[6] != PROTOCOL_VERSION:
            # Something that is not an openg1 client, or a version mismatch.
            # Closing quietly beats a traceback: port scanners exist.
            writer.close()
            return

        arm = Arm.LEFT if hello[7] == Arm.LEFT.value else Arm.RIGHT
        transport = self.transport_for(arm)
        # Honour the MTU the client negotiated, so chunk sizes on this side
        # match what the app believes it is allowed to send.
        transport._mtu = int.from_bytes(hello[8:10], "big") or 247

        if arm in self._clients:
            # A second client for the same arm. Refuse rather than interleave.
            writer.close()
            return

        self._clients[arm] = writer
        self.connections += 1
        transport.on_notify(lambda data, w=writer: self._send(w, data))
        self._on_change()

        try:
            while True:
                header = await reader.readexactly(4)
                size = int.from_bytes(header, "big")
                packet = await reader.readexactly(size)
                await transport.write(packet)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        except asyncio.CancelledError:
            raise
        finally:
            self._clients.pop(arm, None)
            transport.on_notify(lambda _data: None)
            with contextlib.suppress(Exception):
                writer.close()
            self._on_change()

    def _send(self, writer: asyncio.StreamWriter, data: bytes) -> None:
        """Push a notification back to the app. Fire and forget by design:
        BLE notifications are unacknowledged, so pretending otherwise here
        would make the simulator better-behaved than the hardware."""
        if writer.is_closing():
            return
        with contextlib.suppress(Exception):
            writer.write(len(data).to_bytes(4, "big") + bytes(data))

    def close(self) -> None:
        for writer in list(self._clients.values()):
            with contextlib.suppress(Exception):
                writer.close()
        self._clients.clear()


class AppServer(SimulatorServer):
    """The browser panel, aware of whether an app is attached."""

    def __init__(self, *, glasses: GlassesEndpoint, **kw) -> None:
        self.glasses = glasses
        super().__init__(**kw)

    def _frame_payload(self) -> dict:
        payload = super()._frame_payload()
        payload["attached"] = self.glasses.attached
        payload["connections"] = self.glasses.connections
        return payload

    def announce(self) -> None:
        state = "attached" if self.glasses.attached else "waiting"
        self.log(
            f"app {state}"
            + ("" if self.glasses.attached else " — start your program to connect")
        )
        self._push("attach", {"attached": self.glasses.attached})

    async def _command(self, name: str, params: dict, body: bytes) -> None:
        # Display commands need a local session, which does not exist while a
        # remote app owns the arms.
        if self.sim.g1 is None and name in ("text", "clear", "demo", "image"):
            return self.log(f"{name}: your app owns the display while it is attached")
        return await super()._command(name, params, body)


async def run_app(
    *,
    host: str = "127.0.0.1",
    web_port: int = 8765,
    glasses_port: int = GLASSES_PORT,
    open_browser: bool = True,
) -> None:
    async with SimulatedG1(attach_local_g1=False) as sim:
        endpoint = GlassesEndpoint(sim, host=host, port=glasses_port)
        server = AppServer(glasses=endpoint, sim=sim, host=host, port=web_port)
        endpoint._on_change = server.announce

        glasses_server = await endpoint.serve()
        url = f"http://{host}:{web_port}"
        print("openg1 simulator")
        print(f"  panel     {url}")
        print(f"  glasses   {host}:{glasses_port}")
        print()
        print("  Point your program at it with either of:")
        print(f"    g1 = await G1.connect_simulator()")
        print(f"    OPENG1_SIMULATOR=1 python3 yourapp.py")
        print()
        print("  ctrl-c to stop")

        if open_browser:
            _open_browser(url)

        try:
            async with glasses_server:
                await server.serve()
        finally:
            endpoint.close()


def _open_browser(url: str) -> None:
    """Best effort. A simulator that fails to start because a browser could
    not be found would be a silly way to lose."""
    import webbrowser

    with contextlib.suppress(Exception):
        webbrowser.open(url)
