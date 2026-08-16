"""Reading state back off the device."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .._generated import Arm
from .. import commands as cmd
from ..errors import ProtocolError
from ..session import Session

_FW_RE = re.compile(r"ver\s+(?P<version>[\d.]+)")
_BUILD_RE = re.compile(r"app build time\s+(?P<build>[\d\-: ]+)")
_SERIAL_RE = re.compile(
    r"^(?P<frame>S1[01]0)(?P<side>[LR])(?P<color>[A-Z]{2})(?P<rest>.+)$"
)

FRAMES = {"S100": "round", "S110": "square"}
COLORS = {"AA": "grey", "BB": "brown", "CC": "green"}


@dataclass
class Battery:
    left: int
    right: int

    @property
    def lowest(self) -> int:
        return min(self.left, self.right)


@dataclass
class Firmware:
    version: str
    build: str
    raw: str


@dataclass
class SerialInfo:
    serial: str
    frame: str
    color: str
    side: str


def decode_serial(serial: str) -> SerialInfo:
    """Unpack a serial like ``S110LAAL103842``.

    Prefix is the frame shape, then the side, then a two-letter colour code.
    """
    match = _SERIAL_RE.match(serial.strip().upper())
    if not match:
        return SerialInfo(serial=serial, frame="unknown", color="unknown", side="?")
    return SerialInfo(
        serial=serial,
        frame=FRAMES.get(match.group("frame"), "unknown"),
        color=COLORS.get(match.group("color"), "unknown"),
        side=match.group("side"),
    )


class DeviceInfo:
    def __init__(self, session: Session) -> None:
        self._s = session

    async def battery(self) -> Battery:
        """Poll both arms. They discharge unevenly — the right one drives the
        microphone — so the pair is reported, not an average."""
        response = await self._s.send(cmd.get_battery())
        levels = {}
        for arm in (Arm.LEFT, Arm.RIGHT):
            reply = response.replies.get(arm)
            body = reply.packet.payload if reply and reply.packet else b""
            levels[arm] = min(100, body[1]) if len(body) >= 2 else 0
        return Battery(left=levels[Arm.LEFT], right=levels[Arm.RIGHT])

    async def firmware(self) -> Firmware:
        response = await self._s.send(cmd.get_firmware_info())
        packet = response.any_packet
        blob = (packet.raw if packet else b"").rstrip(b"\x00")
        text = blob.decode("ascii", "replace")
        version = _FW_RE.search(text)
        build = _BUILD_RE.search(text)
        return Firmware(
            version=version.group("version") if version else "unknown",
            build=build.group("build").strip() if build else "unknown",
            raw=text,
        )

    async def uptime(self) -> int:
        """Seconds since the arms last booted."""
        body = (await self._s.send(cmd.get_uptime())).payload()
        if len(body) < 4:
            raise ProtocolError(f"short uptime reply: {body.hex(' ')}")
        return int.from_bytes(body[:4], "little")

    async def serial(self) -> SerialInfo:
        """Serial as advertised in the BLE name — no round trip needed."""
        name = self._s.transports[Arm.LEFT].name
        tail = name.rsplit("_", 1)[-1] if "_" in name else name
        return decode_serial(tail)

    async def raw(self, command: str) -> bytes:
        """Fire any argument-less getter by name and hand back the bytes.

        For the opcodes whose replies nobody has decoded yet.
        """
        builder = getattr(cmd, command, None)
        if builder is None:
            raise ProtocolError(f"no such command builder: {command}")
        return (await self._s.send(builder(), strict=False)).payload()
