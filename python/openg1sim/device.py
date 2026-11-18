"""A pair of glasses you can actually look at.

This wraps the SDK's own emulator rather than reimplementing it. Every packet
still goes through ``openg1.transport.mock``, gets parsed by the same code and
answered with the same replies — so a session that works here works on
hardware for the same reasons. What is added is a framebuffer per arm, updated
after every packet, and the plumbing to watch it change.

    from openg1sim import SimulatedG1

    async with SimulatedG1() as sim:
        await sim.g1.display.text("ciao")
        print(sim.panel.frame.to_blocks())
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Callable

from openg1 import G1
from openg1 import profile as profile_mod
from openg1.errors import ParityError
from openg1._generated import Arm, Cmd
from .emulator import ArmState, EmulatedGlasses, MockTransport

from .panel import MODE_TEXT, Panel, PanelState, RenderReport


class ObservedTransport(MockTransport):
    """A mock transport that tells someone when a packet lands.

    Subclassing rather than patching keeps the emulator's behaviour exactly as
    the SDK's own tests exercise it: this only adds a callback.
    """

    def __init__(self, state: ArmState, *, on_packet: Callable[[bytes], None], **kwargs) -> None:
        super().__init__(state, **kwargs)
        self._on_packet = on_packet

    async def write(self, data: bytes) -> None:
        await super().write(data)
        self._on_packet(bytes(data))


class SimulatedG1:
    """A visible pair of glasses: emulated firmware plus a rendered panel.

    ``sim.g1`` is an ordinary :class:`openg1.G1`, so any code written against the
    SDK runs against this unchanged.
    """

    def __init__(
        self,
        *,
        latency: float = 0.0,
        mtu: int = 247,
        attach_local_g1: bool = True,
        device: "profile_mod.DeviceProfile | None" = None,
        strict: bool = False,
        **session_kw,
    ) -> None:
        # When a remote app drives the glasses over the network, there must be
        # no local session: two consumers on one transport would each see the
        # other's replies and match them to commands they never sent.
        self._attach_local_g1 = attach_local_g1
        # The same profile the SDK's Display reads. Sharing it is the whole
        # mechanism behind "what you see is what you ship".
        self.device = device or profile_mod.active()
        self.strict = strict
        self.warnings: list[str] = []
        self._session_kw = session_kw
        self.emulator = EmulatedGlasses(latency=latency, mtu=mtu)
        # Swap in observing transports over the same arm state.
        self.emulator.left_transport = ObservedTransport(
            self.emulator.left, on_packet=lambda data: self._observe(Arm.LEFT, data),
            latency=latency, mtu=mtu,
        )
        self.emulator.right_transport = ObservedTransport(
            self.emulator.right, on_packet=lambda data: self._observe(Arm.RIGHT, data),
            latency=latency, mtu=mtu,
        )

        self.left_panel = Panel()
        self.right_panel = Panel()
        self.left_state = PanelState()
        self.right_state = PanelState()

        self.g1: G1 | None = None  # stays None when attach_local_g1 is False
        self.frames = 0
        self._listeners: list[Callable[[SimulatedG1], None]] = []
        self._queues: list[asyncio.Queue] = []

    # -- lifecycle ---------------------------------------------------------

    async def __aenter__(self) -> "SimulatedG1":
        left, right = self.emulator.transports()
        if self._attach_local_g1:
            self.g1 = G1(left, right, **self._session_kw)
            await self.g1.session.start()
        else:
            # Headless: a remote app owns the session. Bring the transports up
            # ourselves so the emulator will accept writes.
            await left.connect()
            await right.connect()
        self.render()
        return self

    async def __aexit__(self, *exc) -> None:
        if self.g1 is not None:
            await self.g1.disconnect()
        else:
            for transport in self.emulator.transports():
                await transport.disconnect()

    def reset(self) -> None:
        """Blank the panel and forget the screen, keeping the connection.

        Used between dev-server reloads: the app restarts, the session does
        not. Reconnecting would also work, but it would mean every reload
        re-runs the handshake and any browser watching the frame stream sees
        the panel flicker through an init sequence that has nothing to do
        with the code you just saved.
        """
        for arm_state, panel_state in (
            (self.emulator.left, self.left_state),
            (self.emulator.right, self.right_state),
        ):
            arm_state.screen_text = ""
            arm_state.bmp_image = b""
            arm_state.bmp_crc_ok = None
            panel_state.text = ""
            panel_state.image = b""
            panel_state.image_valid = None
            panel_state.notification = ""
            panel_state.dashboard_open = False
            panel_state.page = 1
            panel_state.max_page = 1
        self.render()

    # -- the visible part --------------------------------------------------

    @property
    def panel(self) -> Panel:
        """The left panel. Both arms are sent identical display packets, so
        one is enough unless you are specifically testing arm divergence."""
        return self.left_panel

    def state_for(self, arm: Arm) -> PanelState:
        return self.left_state if arm is Arm.LEFT else self.right_state

    def panel_for(self, arm: Arm) -> Panel:
        return self.left_panel if arm is Arm.LEFT else self.right_panel

    def render(self) -> None:
        for arm in (Arm.LEFT, Arm.RIGHT):
            self._sync_state(arm)
            self.panel_for(arm).render(self.state_for(arm))
        self.frames += 1
        for listener in list(self._listeners):
            listener(self)
        for queue in list(self._queues):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(self.frames)

    def png(self, scale: int = 2) -> bytes:
        """The panel as the wearer would see it, hidden rows dimmed."""
        return self.panel.frame.to_png(scale=scale, hidden=self.device.safe_area)

    def hidden_ink(self, arm: Arm = Arm.LEFT) -> int:
        """Lit pixels that fall outside the visible band.

        Non-zero means you have drawn something nobody will read. This is the
        single most useful number the simulator produces, because it is the
        one failure that looks perfect in a framebuffer dump.
        """
        frame = self.panel_for(arm).frame
        top, bottom = self.device.safe_area
        rows = list(range(0, top)) + list(range(frame.height - bottom, frame.height))
        return sum(
            1
            for y in rows
            for x in range(frame.width)
            if frame.pixels[y * frame.width + x]
        )

    def check_parity(self, arm: Arm = Arm.LEFT) -> list[str]:
        """Everything about the current screen that would differ on hardware.

        Empty list means the window and the glasses agree. In ``strict`` mode
        a non-empty list raises instead, so a test fails at the moment the
        divergence appears rather than when you next put the glasses on.
        """
        problems: list[str] = []
        report = self.report(arm)
        hidden = self.hidden_ink(arm)
        if hidden:
            problems.append(
                f"{hidden} lit pixel(s) fall in the {self.device.hidden_top}/"
                f"{self.device.hidden_bottom} hidden rows — invisible on this "
                f"device"
            )
        if report.truncated_lines:
            problems.append(
                f"{report.truncated_lines} line(s) past the bottom of the panel"
            )
        if report.overflow:
            problems.append(f"{len(report.overflow)} line(s) wider than the panel")

        if problems and self.strict:
            raise ParityError("; ".join(problems))
        self.warnings.extend(problems)
        return problems

    def report(self, arm: Arm = Arm.LEFT) -> RenderReport:
        """What the renderer noticed — overflow, truncation, pixel count.

        Also carries the SDK's own line estimate, so you can see when the two
        font models disagree. See :class:`~openg1sim.panel.RenderReport`.
        """
        from openg1 import text as sdk_text

        panel = self.panel_for(arm)
        state = self.state_for(arm)
        return RenderReport(
            lit_pixels=panel.frame.lit(),
            lines=len(panel.wrap(state.text, state.scale_x)),
            truncated_lines=panel.truncated_lines,
            overflow=list(panel.overflow),
            sdk_lines=len(sdk_text.wrap(state.text)) if state.text else 0,
        )

    def on_frame(self, listener: Callable[["SimulatedG1"], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def frame_queue(self, maxsize: int = 4) -> asyncio.Queue:
        """A queue that receives a frame number on every render."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._queues.append(queue)
        return queue

    # -- stimulus ----------------------------------------------------------
    #
    # Passed straight through to the SDK emulator, plus a re-render so the
    # panel reflects anything the event changed.

    async def tap(self, arm: Arm = Arm.RIGHT, count: int = 1) -> None:
        await self.emulator.tap(arm, count)

    async def hold(self, arm: Arm = Arm.LEFT, *, release: bool = False) -> None:
        await self.emulator.hold(arm, release=release)

    async def head_up(self, up: bool = True) -> None:
        await self.emulator.head_up(up)
        for state in (self.left_state, self.right_state):
            state.head_up = up
        self.render()

    async def wear(self, worn: bool = True) -> None:
        await self.emulator.wear(worn)
        for state in (self.left_state, self.right_state):
            state.worn = worn
        self.render()

    async def dashboard(self, opened: bool = True) -> None:
        await self.emulator.dashboard(opened)
        for state in (self.left_state, self.right_state):
            state.dashboard_open = opened
        self.render()

    async def battery_report(self, percent: int, arm: Arm = Arm.LEFT) -> None:
        await self.emulator.battery_report(arm, percent)
        self.state_for(arm).battery = percent
        self.render()

    async def audio_frame(self, seq: int, data: bytes) -> None:
        await self.emulator.audio_frame(seq, data)

    def notify(self, text: str) -> None:
        """Show a notification overlay. Local to the simulator: the real path
        is a whitelisted app pushing through ``SEND_NOTIFICATION``."""
        for state in (self.left_state, self.right_state):
            state.notification = text
        self.render()

    def set_clock(self, time_label: str, weather_label: str = "") -> None:
        for state in (self.left_state, self.right_state):
            state.time_label = time_label
            state.weather_label = weather_label
        self.render()

    # -- internals ---------------------------------------------------------

    def _observe(self, arm: Arm, data: bytes) -> None:
        """Called after the emulator has handled a packet."""
        if not data:
            return
        opcode = data[0]
        state = self.state_for(arm)

        if opcode == Cmd.SEND_TEXT and len(data) > 9:
            # Byte 4 of the packet is the screen status: the high nibble is the
            # mode, the low nibble flags new content.
            state.mode = data[4] & 0xF0
            state.page = data[7]
            state.max_page = data[8]
            state.image = b""
            state.notification = ""
        elif opcode == Cmd.CLEAR_SCREEN:
            state.image = b""
            state.notification = ""
        elif opcode in (Cmd.BMP_DATA, Cmd.BMP_CRC, Cmd.BMP_END):
            pass  # handled below from the arm state
        elif opcode == Cmd.SEND_NOTIFICATION:
            # The payload is chunked JSON; showing the raw chunk is more
            # honest than pretending to parse a partial message.
            state.notification = _notification_preview(data)

        self.render()

    def _sync_state(self, arm: Arm) -> None:
        """Pull whatever the emulator recorded into the render state."""
        source: ArmState = self.emulator.left if arm is Arm.LEFT else self.emulator.right
        state = self.state_for(arm)
        state.text = source.screen_text
        state.battery = source.battery
        state.brightness = source.brightness
        state.silent = source.silent
        if source.bmp_image:
            state.image = source.bmp_image
            state.image_valid = source.bmp_crc_ok


def _notification_preview(data: bytes) -> str:
    """Best effort at showing a notification chunk as text."""
    body = data[5:] if len(data) > 5 else b""
    try:
        text = body.decode("utf-8", "replace").strip()
    except Exception:  # pragma: no cover - decode never raises with replace
        return "[notification]"
    for key in ('"title":"', '"message":"'):
        if key in text:
            start = text.index(key) + len(key)
            end = text.find('"', start)
            if end > start:
                return text[start:end]
    return text[:60] or "[notification]"


__all__ = ["SimulatedG1", "ObservedTransport", "Panel", "PanelState", "MODE_TEXT"]
