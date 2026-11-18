"""The simulator's engine, driven from a GUI thread.

Tk owns the main thread and blocks in its own event loop; asyncio wants to own
a thread too. Rather than trying to interleave them — which produces a GUI
that stutters whenever the network is busy, and race conditions that only
appear on someone else's machine — the asyncio side gets its own thread and
this class is the only thing that crosses between them.

Everything here is safe to call from the GUI thread. Nothing here imports Tk,
which is deliberate: it means the whole engine can be tested without a display
server, and it means a bug in the window cannot be a bug in the simulator.

    controller = SimulatorController()
    controller.start()
    controller.submit(controller.sim.tap())     # from any thread
    frame = controller.take_frame()             # None if nothing changed
    controller.stop()
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass

from openg1._generated import Arm

from .appserver import GlassesEndpoint
from .device import SimulatedG1
from .net import GLASSES_PORT


@dataclass
class Status:
    """A snapshot for the GUI to display. Plain data, safe to hand across."""

    attached: bool = False
    connections: int = 0
    frames: int = 0
    lit_pixels: int = 0
    fits: bool = True
    truncated_lines: int = 0
    overflow: int = 0
    battery: int = 87
    worn: bool = True
    hidden_ink: int = 0
    parity: tuple[str, ...] = ()
    device: str = ""
    listening: bool = False
    port: int = GLASSES_PORT
    error: str = ""


class SimulatorController:
    """Runs the simulator on a background thread and exposes it safely."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        glasses_port: int = GLASSES_PORT,
        serve: bool = True,
    ) -> None:
        self.host = host
        self.glasses_port = glasses_port
        self._serve = serve

        self.sim: SimulatedG1 | None = None
        self.endpoint: GlassesEndpoint | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._stopping = threading.Event()
        self._server = None
        self._error = ""

        # Set whenever a frame is rendered; the GUI polls rather than being
        # called back, because a Tk widget must only be touched from the Tk
        # thread and a callback from asyncio is by definition not that.
        self._dirty = threading.Event()
        self._log: list[str] = []
        self._seen_problems: set[str] = set()
        self._log_lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def start(self, timeout: float = 10.0) -> None:
        """Start the background loop and block until the simulator is up."""
        if self._thread is not None:
            raise RuntimeError("already started")
        self._thread = threading.Thread(
            target=self._run, name="openg1sim", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("simulator did not start in time")
        if self._error:
            raise RuntimeError(self._error)

    def stop(self, timeout: float = 5.0) -> None:
        if self._loop is None:
            return
        self._stopping.set()
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout)
        self._thread = None

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._setup())
        except Exception as exc:  # port in use, most likely
            self._error = str(exc)
            self._ready.set()
            return
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.run_until_complete(self._teardown())
            self._loop.close()

    async def _setup(self) -> None:
        # No local G1: a remote app owns the arms when one attaches, and a
        # second session on the same transports would see replies to commands
        # it never sent.
        self.sim = SimulatedG1(attach_local_g1=False)
        await self.sim.__aenter__()
        self.sim.on_frame(lambda _sim: self._dirty.set())

        if self._serve:
            self.endpoint = GlassesEndpoint(
                self.sim,
                host=self.host,
                port=self.glasses_port,
                on_change=self._on_attach_change,
            )
            self._server = await self.endpoint.serve()
            self.glasses_port = self._server.sockets[0].getsockname()[1]
            self.endpoint.port = self.glasses_port
            self.note(f"listening for your app on {self.host}:{self.glasses_port}")
        self._dirty.set()

    async def _teardown(self) -> None:
        if self.endpoint is not None:
            self.endpoint.close()
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass
        if self.sim is not None:
            await self.sim.__aexit__(None, None, None)

    # -- crossing the thread boundary --------------------------------------

    def submit(self, coro) -> "asyncio.Future | None":
        """Schedule a coroutine on the simulator's loop from the GUI thread.

        Returns a future you are free to ignore. Errors are logged rather than
        raised: a button that throws into Tk's event loop takes the window
        down, and no wearer input is worth that.
        """
        if self._loop is None or self._stopping.is_set():
            coro.close()
            return None

        future = asyncio.run_coroutine_threadsafe(coro, self._loop)

        def _report(fut) -> None:
            try:
                fut.result()
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                self.note(f"error: {exc}")

        future.add_done_callback(_report)
        return future

    def take_frame(self) -> bytes | None:
        """PNG of the panel if it changed since last call, else ``None``.

        Returning ``None`` for "unchanged" keeps the GUI from re-encoding and
        re-uploading 78,000 pixels sixty times a second to show the same
        thing.
        """
        if not self._dirty.is_set() or self.sim is None:
            return None
        self._dirty.clear()
        return self.sim.png(scale=2)

    def status(self) -> Status:
        if self.sim is None:
            return Status(error=self._error)
        report = self.sim.report()
        problems = tuple(self.sim.check_parity())
        for problem in problems:
            if problem not in self._seen_problems:
                self._seen_problems.add(problem)
                self.note(f"parity: {problem}")
        return Status(
            hidden_ink=self.sim.hidden_ink(),
            parity=problems,
            device=self.sim.device.describe(),
            attached=bool(self.endpoint and self.endpoint.attached),
            connections=self.endpoint.connections if self.endpoint else 0,
            frames=self.sim.frames,
            lit_pixels=report.lit_pixels,
            fits=report.fits,
            truncated_lines=report.truncated_lines,
            overflow=len(report.overflow),
            battery=self.sim.left_state.battery,
            worn=self.sim.left_state.worn,
            listening=self._server is not None,
            port=self.glasses_port,
            error=self._error,
        )

    # -- log ---------------------------------------------------------------

    def note(self, text: str) -> None:
        with self._log_lock:
            self._log.append(text)

    def drain_log(self) -> list[str]:
        """Everything logged since the last call. The GUI polls this."""
        with self._log_lock:
            lines, self._log[:] = list(self._log), []
        return lines

    def _on_attach_change(self) -> None:
        if self.endpoint is None:
            return
        if self.endpoint.attached:
            self.note("app attached — it owns the display now")
        else:
            self.note("app disconnected — waiting")
        self._dirty.set()

    # -- wearer input, as plain methods the GUI can bind to buttons --------

    def tap(self, count: int = 1) -> None:
        if self.sim:
            self.note(f"tap x{count}")
            self.submit(self.sim.tap(Arm.RIGHT, count))

    def hold(self) -> None:
        if self.sim:
            self.note("hold left arm (Even AI trigger)")
            self.submit(self.sim.hold(Arm.LEFT))

    def head(self, up: bool) -> None:
        if self.sim:
            self.note(f"head {'up' if up else 'down'}")
            self.submit(self.sim.head_up(up))

    def wear(self, worn: bool) -> None:
        if self.sim:
            self.note("worn" if worn else "removed — the panel powers down")
            self.submit(self.sim.wear(worn))

    def battery(self, percent: int) -> None:
        if self.sim:
            self.note(f"battery {percent}%")
            self.submit(self.sim.battery_report(percent))

    def dashboard(self, opened: bool) -> None:
        if self.sim:
            from datetime import datetime

            self.sim.set_clock(datetime.now().strftime("%H:%M"), "18°  clear")
            self.note(f"dashboard {'opened' if opened else 'closed'}")
            self.submit(self.sim.dashboard(opened))

    def notify(self, text: str = "Messaggi — Marco: ci vediamo alle 20:00") -> None:
        if self.sim:
            self.note("notification overlay")
            self.sim.notify(text)
