"""Packet framing.

The G1 puts two different packet shapes on one characteristic:

``raw``     ``[opcode, ...payload]`` — no length, no sequence. Used by the
            bulk and legacy commands (text, bitmap, mic, argument-less getters).

``framed``  ``[opcode, len_lo, len_hi, seq, ...payload]`` where ``len`` counts
            the whole packet including those four bytes.

Which family an opcode belongs to is a property of the opcode, so the decoder
takes a hint from the generated command table rather than guessing. It still
validates the length field before trusting it, which is what lets it survive
the zero padding the firmware appends to short replies.

Two details that bite people:

* Replies are padded out to the ATT payload size. ``10 06 00 04 01 c9`` arrives
  as twenty bytes. Trimming to the declared length is not optional.
* Replies to framed commands echo the request and then append their result
  *past* the declared length. So the declared length delimits the echo, and
  anything after it is the answer. :class:`Packet` keeps both, as ``payload``
  and ``trailer``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ._generated import COMMANDS, Status
from .errors import ProtocolError

FRAMED_OPCODES: frozenset[int] = frozenset(
    spec.opcode for spec in COMMANDS.values() if spec.framed
)

RAW_OPCODES: frozenset[int] = frozenset(
    spec.opcode for spec in COMMANDS.values() if not spec.framed
)

#: Opcodes that are framed in one command and raw in another. There are none
#: today; the check exists so the ambiguity is caught the moment it appears.
AMBIGUOUS_OPCODES: frozenset[int] = FRAMED_OPCODES & RAW_OPCODES


@dataclass(frozen=True)
class Packet:
    """A decoded packet in either family."""

    opcode: int
    payload: bytes = b""
    seq: int | None = None
    framed: bool = False
    trailer: bytes = field(default=b"", repr=False)
    raw: bytes = field(default=b"", repr=False)

    # -- inspection --------------------------------------------------------

    @property
    def status(self) -> int | None:
        """Status byte of a generic reply, if this looks like one.

        Generic replies are ``[opcode, status]`` for raw commands, and the
        status lands in the trailer (or at the end of the echo) for framed
        ones. Returns ``None`` when no byte in the expected position is a
        known status code.
        """
        for candidate in (
            self.trailer[:1],
            self.payload[-1:] if self.framed else self.payload[:1],
        ):
            if candidate and candidate[0] in tuple(Status):
                return candidate[0]
        return None

    @property
    def ok(self) -> bool:
        return self.status == Status.SUCCESS

    def hex(self) -> str:
        return " ".join(f"{b:02x}" for b in (self.raw or self.to_bytes()))

    def to_bytes(self) -> bytes:
        if self.framed:
            return encode_framed(self.opcode, self.seq or 0, self.payload)
        return encode_raw(self.opcode, self.payload)


def encode_raw(opcode: int, payload: bytes = b"") -> bytes:
    """``[opcode, ...payload]``."""
    _check_byte("opcode", opcode)
    return bytes([opcode]) + bytes(payload)


def encode_framed(opcode: int, seq: int, payload: bytes = b"") -> bytes:
    """``[opcode, len_lo, len_hi, seq, ...payload]``, ``len`` counting the header."""
    _check_byte("opcode", opcode)
    _check_byte("seq", seq)
    total = 4 + len(payload)
    if total > 0xFFFF:
        raise ProtocolError(f"framed packet of {total} bytes exceeds the 16-bit length field")
    return bytes([opcode, total & 0xFF, (total >> 8) & 0xFF, seq]) + bytes(payload)


def looks_framed(data: bytes) -> bool:
    """True when *data* parses as a framed packet from a known framed opcode.

    The length field has to be self-consistent, which rules out raw packets
    that happen to share an opcode value.
    """
    if len(data) < 4 or data[0] not in FRAMED_OPCODES:
        return False
    declared = data[1] | (data[2] << 8)
    return 4 <= declared <= len(data)


def decode(data: bytes, *, framed: bool | None = None) -> Packet:
    """Parse one packet.

    Pass ``framed=`` to override the opcode-table heuristic — useful when
    replaying a capture whose opcode is not in the table yet.
    """
    data = bytes(data)
    if not data:
        raise ProtocolError("cannot decode an empty packet")

    if framed is None:
        framed = looks_framed(data)

    if not framed:
        return Packet(opcode=data[0], payload=data[1:], framed=False, raw=data)

    if len(data) < 4:
        raise ProtocolError(f"framed packet needs 4 header bytes, got {len(data)}")
    declared = data[1] | (data[2] << 8)
    if declared < 4:
        raise ProtocolError(f"framed length field of {declared} is below the header size")
    if declared > len(data):
        raise ProtocolError(
            f"framed packet declares {declared} bytes but only {len(data)} arrived"
        )
    return Packet(
        opcode=data[0],
        payload=data[4:declared],
        seq=data[3],
        framed=True,
        trailer=data[declared:],
        raw=data,
    )


def strip_padding(data: bytes) -> bytes:
    """Drop the trailing zero bytes the firmware pads short replies with.

    Only safe on payloads where a trailing zero carries no meaning; the
    session uses it for logging, never for parsing.
    """
    return data.rstrip(b"\x00")


def _check_byte(name: str, value: int) -> None:
    if not isinstance(value, int) or not 0 <= value <= 0xFF:
        raise ProtocolError(f"{name} must be a byte in 0..255, got {value!r}")


class SequenceCounter:
    """The session-global 8-bit counter carried by framed packets.

    Heartbeats keep a separate instance: the firmware tracks that one on its
    own and mixing the two makes replies impossible to correlate.
    """

    __slots__ = ("_value",)

    def __init__(self, start: int = 0) -> None:
        self._value = start & 0xFF

    def next(self) -> int:
        value = self._value
        self._value = (self._value + 1) & 0xFF
        return value

    def peek(self) -> int:
        return self._value

    def reset(self, value: int = 0) -> None:
        self._value = value & 0xFF
