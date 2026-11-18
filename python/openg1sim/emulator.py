"""A G1 that lives in a process instead of on your face.

This is not a stub. It parses real packets, enforces the acknowledgement
ordering the firmware enforces, reassembles bitmap transfers and verifies
their CRC, and keeps a text buffer you can assert against. Every example and
test in this repo runs against it, which is the only reason a multi-language
SDK for a discontinued device is testable at all.

This lives in ``openg1sim`` rather than in ``openg1`` because it is a development
tool, not part of the SDK: shipping a fake device inside the library invites
people to write against it by accident, and it made the SDK's public surface
carry two ways to not-have-glasses. There is one now.

    from openg1sim import SimulatedG1

    async with SimulatedG1() as sim:
        await sim.g1.display.text("hello")
    assert "hello" in sim.emulator.left.screen_text
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from openg1._generated import Arm, Cmd, Evt, Status
from openg1.crc import bmp_crc
from openg1.framing import decode, encode_framed
from openg1.transport import Transport


@dataclass
class ArmState:
    """What one emulated arm believes about itself."""

    arm: Arm
    battery: int = 87
    brightness: int = 21
    auto_brightness: bool = False
    silent: bool = False
    headup_angle: int = 30
    wear_detection: bool = True
    display_height: int = 4
    display_depth: int = 5
    uptime_s: int = 6729
    firmware: str = "net build time: 2024-12-28 20:21:57, app build time 2024-12-28 20:20:45, ver 1.4.5, JBD DeviceID 4010"

    screen_text: str = ""
    dashboard_locked: bool = False
    mic_enabled: bool = False
    initialised: bool = False
    heartbeats: int = 0
    reset_count: int = 0

    #: Every packet the arm received, in order. Useful in assertions.
    log: list[bytes] = field(default_factory=list)

    _bmp: bytearray = field(default_factory=bytearray, repr=False)
    _bmp_done: bool = field(default=False, repr=False)
    bmp_image: bytes = field(default=b"", repr=False)
    bmp_crc_ok: bool | None = None
    _text_parts: dict[int, bytes] = field(default_factory=dict, repr=False)


class MockTransport(Transport):
    """The link between the SDK and one :class:`ArmState`."""

    def __init__(self, state: ArmState, *, latency: float = 0.0, mtu: int = 247) -> None:
        self.state = state
        self.latency = latency
        self._mtu = mtu
        self._connected = False
        self.name = f"Even G1_42_{state.arm.label}_MOCK01"
        self.address = f"00:00:00:00:00:{state.arm.value:02d}"

    async def connect(self) -> None:
        await self._delay()
        self._connected = True

    async def disconnect(self) -> None:
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def max_write(self) -> int:
        return self._mtu - 3

    async def write(self, data: bytes) -> None:
        if not self._connected:
            from openg1.errors import NotConnectedError

            raise NotConnectedError(f"{self.name} is not connected")
        if len(data) > self.max_write:
            from openg1.errors import PacketTooLargeError

            raise PacketTooLargeError(len(data), self.max_write)
        await self._delay()
        self.state.log.append(bytes(data))
        for reply in _handle(self.state, bytes(data)):
            await self._delay()
            await self._emit(reply)

    async def push(self, data: bytes) -> None:
        """Inject an unsolicited message, as the real device would."""
        await self._emit(bytes(data))

    async def _delay(self) -> None:
        if self.latency:
            await asyncio.sleep(self.latency)


class EmulatedGlasses:
    """A pair of emulated arms plus helpers to drive them from a test."""

    def __init__(self, *, latency: float = 0.0, mtu: int = 247) -> None:
        self.left = ArmState(Arm.LEFT)
        self.right = ArmState(Arm.RIGHT)
        self.left_transport = MockTransport(self.left, latency=latency, mtu=mtu)
        self.right_transport = MockTransport(self.right, latency=latency, mtu=mtu)

    def transports(self) -> tuple[MockTransport, MockTransport]:
        return self.left_transport, self.right_transport

    # -- stimulus ----------------------------------------------------------

    async def tap(self, arm: Arm = Arm.RIGHT, count: int = 1) -> None:
        sub = {1: 0x01, 2: 0x00, 3: 0x04}[count]
        await self._push(arm, bytes([Evt.STATE_CHANGE, sub]))

    async def hold(self, arm: Arm = Arm.LEFT, *, release: bool = False) -> None:
        await self._push(arm, bytes([Evt.STATE_CHANGE, 0x18 if release else 0x17]))

    async def head_up(self, up: bool = True) -> None:
        await self._push(Arm.RIGHT, bytes([Evt.STATE_CHANGE, 0x02 if up else 0x03]))

    async def wear(self, worn: bool = True) -> None:
        await self._push(Arm.LEFT, bytes([Evt.STATE_CHANGE, 0x06 if worn else 0x07]))

    async def dashboard(self, opened: bool = True) -> None:
        await self._push(Arm.RIGHT, bytes([Evt.STATE_CHANGE, 0x1E if opened else 0x1F]))

    async def audio_frame(self, seq: int, data: bytes) -> None:
        await self._push(Arm.RIGHT, bytes([Evt.MIC_DATA, seq & 0xFF]) + bytes(data))

    async def battery_report(self, arm: Arm, percent: int) -> None:
        await self._push(arm, bytes([Evt.BATTERY_REPORT, 0x66, percent & 0xFF]))

    async def _push(self, arm: Arm, data: bytes) -> None:
        t = self.left_transport if arm is Arm.LEFT else self.right_transport
        await t.push(data)


# ---------------------------------------------------------------------------
# Firmware behaviour
# ---------------------------------------------------------------------------

def _generic(packet, status: int = Status.SUCCESS) -> bytes:
    """Replies mimic the real ones, padding included."""
    if packet.framed:
        body = encode_framed(packet.opcode, packet.seq or 0, packet.payload)
        return (body + bytes([status])).ljust(20, b"\x00")
    return bytes([packet.opcode, status]).ljust(20, b"\x00")


def _handle(state: ArmState, data: bytes) -> list[bytes]:
    packet = decode(data)
    op = packet.opcode
    body = packet.payload

    if op == Cmd.HEARTBEAT:
        state.heartbeats += 1
        return [_generic(packet)]

    if op == Cmd.INIT:
        state.initialised = True
        return [_generic(packet)]

    if op == Cmd.SEQ_SYNC:
        return [_generic(packet)]

    if op == Cmd.SET_BRIGHTNESS and len(body) >= 2:
        state.brightness, state.auto_brightness = body[0], bool(body[1])
        return [_generic(packet)]

    if op == Cmd.GET_BRIGHTNESS:
        return [bytes([Cmd.GET_BRIGHTNESS, 0x65, state.brightness,
                       int(state.auto_brightness)]).ljust(20, b"\x00")]

    if op == Cmd.SET_SILENT_MODE and body:
        state.silent = body[0] == 0x0C
        return [_generic(packet)]

    if op == Cmd.GET_SILENT_MODE:
        return [bytes([Cmd.GET_SILENT_MODE, 0x69, 0x0C if state.silent else 0x0A,
                       0x06]).ljust(20, b"\x00")]

    if op == Cmd.SET_HEADUP_ANGLE and body:
        state.headup_angle = body[0]
        return [_generic(packet)]

    if op == Cmd.GET_HEADUP_ANGLE:
        return [bytes([Cmd.GET_HEADUP_ANGLE, 0x6D, 0x0F, state.headup_angle,
                       0x00]).ljust(20, b"\x00")]

    if op == Cmd.SET_WEAR_DETECTION and body:
        state.wear_detection = bool(body[0])
        return [_generic(packet)]

    if op == Cmd.GET_WEAR_DETECTION:
        return [bytes([Cmd.GET_WEAR_DETECTION, Status.SUCCESS,
                       int(state.wear_detection)]).ljust(20, b"\x00")]

    if op == Cmd.GET_DISPLAY_SETTINGS:
        return [bytes([Cmd.GET_DISPLAY_SETTINGS, Status.SUCCESS, state.display_height,
                       state.display_depth]).ljust(20, b"\x00")]

    if op == Cmd.SET_DISPLAY_SETTINGS and len(body) >= 5:
        # Only the commit (preview == 0) actually changes anything.
        if body[2] == 0:
            state.display_height, state.display_depth = body[3], body[4]
        return [_generic(packet)]

    if op == Cmd.GET_UPTIME:
        return [bytes([Cmd.GET_UPTIME]) + state.uptime_s.to_bytes(4, "little")]

    if op == Cmd.MIC_CONTROL and body:
        if state.arm is not Arm.RIGHT:
            return [bytes([Cmd.MIC_CONTROL, Status.FAILURE, body[0]])]
        state.mic_enabled = bool(body[0])
        return [bytes([Cmd.MIC_CONTROL, Status.SUCCESS, body[0]]).ljust(20, b"\x00")]

    # 0x2C and 0x23 multiplex on their first payload byte.
    if op == Cmd.GET_BATTERY:
        if body[:1] == b"\x01":
            return [bytes([Cmd.GET_BATTERY, 0x66, state.battery, 0xE6, 0x5D, 0x24,
                           0x00, 0x00]).ljust(20, b"\x00")]
        return [bytes([Cmd.GET_BATTERY, 0x66, 0x02]).ljust(20, b"\x00")]

    if op == Cmd.HARD_RESET:
        if body[:1] == b"\x74":
            return [state.firmware.encode().ljust(203, b"\x00")]
        state.reset_count += 1
        return []

    if op == Cmd.SEND_TEXT and len(body) >= 8:
        total, index = body[1], body[2]
        state._text_parts[index] = bytes(body[8:])
        if len(state._text_parts) >= total:
            joined = b"".join(state._text_parts[i] for i in sorted(state._text_parts))
            state.screen_text = joined.decode("utf-8", "replace")
            state._text_parts.clear()
        return [_generic(packet)]

    if op == Cmd.CLEAR_SCREEN:
        state.screen_text = ""
        state.bmp_image = b""
        return [_generic(packet)]

    if op == Cmd.BMP_DATA and body:
        chunk = body[1:]
        if body[0] == 0:
            state._bmp = bytearray()
            state.bmp_crc_ok = None
            chunk = chunk[4:]  # strip the storage address
        state._bmp += chunk
        return [_generic(packet)]

    if op == Cmd.BMP_END:
        state._bmp_done = True
        return [_generic(packet)]

    if op == Cmd.BMP_CRC and len(body) >= 4:
        expected = int.from_bytes(body[:4], "big")
        state.bmp_crc_ok = bmp_crc(bytes(state._bmp)) == expected
        if state.bmp_crc_ok:
            state.bmp_image = bytes(state._bmp)
        return [_generic(packet, Status.SUCCESS if state.bmp_crc_ok else Status.FAILURE)]

    if op == Cmd.DASHBOARD_LOCK and len(body) >= 2:
        state.dashboard_locked = bool(body[1])
        return [_generic(packet)]

    # Anything the emulator does not model still acknowledges, exactly as the
    # firmware does for settings it accepts but does not report back.
    return [_generic(packet)]

