"""Decoding what the glasses say on their own initiative.

Three things arrive unprompted: touchbar and wear state changes (0xF5),
microphone frames (0xF1), and battery reports (0x2C, which is also the reply
to a poll — the SDK treats both identically).

Unknown sub-codes are not dropped. They surface as :class:`UnknownEvent` with
the bytes intact, because the fastest way to extend this protocol is to wear
the glasses, poke at them, and read the log.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from ._generated import Arm, Evt, StateEvent
from .framing import Packet


@dataclass(frozen=True)
class Event:
    """Base class. ``arm`` says which radio it arrived on."""

    arm: Arm
    raw: bytes = field(default=b"", repr=False)

    @property
    def name(self) -> str:
        return type(self).__name__


@dataclass(frozen=True)
class TouchEvent(Event):
    """A touchbar gesture."""

    gesture: str = "unknown"
    subcode: int = 0

    @property
    def is_hold(self) -> bool:
        return self.gesture in ("hold_start", "hold_end")


@dataclass(frozen=True)
class HeadEvent(Event):
    """Head raised or lowered past the configured angle."""

    up: bool = False


@dataclass(frozen=True)
class WearEvent(Event):
    worn: bool = False


@dataclass(frozen=True)
class CaseEvent(Event):
    """Charging case state. ``battery`` is a percentage when reported."""

    lid_open: bool | None = None
    charging: bool | None = None
    battery: int | None = None


@dataclass(frozen=True)
class ChargingEvent(Event):
    charging: bool = False


@dataclass(frozen=True)
class DashboardEvent(Event):
    open: bool = False


@dataclass(frozen=True)
class PairedEvent(Event):
    pass


@dataclass(frozen=True)
class AudioEvent(Event):
    """One LC3 frame from the microphone."""

    seq: int = 0
    data: bytes = b""


@dataclass(frozen=True)
class BatteryEvent(Event):
    percent: int = 0
    voltage_mv: int | None = None
    charging: bool | None = None
    extra: bytes = field(default=b"", repr=False)


@dataclass(frozen=True)
class AiRequestEvent(Event):
    """The wearer held the left touchbar: Even AI wants a microphone."""


@dataclass(frozen=True)
class AiStopEvent(Event):
    """The wearer let go. Stop recording."""


@dataclass(frozen=True)
class UnknownEvent(Event):
    opcode: int = 0
    subcode: int | None = None
    data: bytes = b""


_TOUCH = {
    StateEvent.TOUCHBAR_SINGLE_TAP: "single_tap",
    StateEvent.TOUCHBAR_DOUBLE_TAP: "double_tap",
    StateEvent.TOUCHBAR_TRIPLE_TAP: "triple_tap",
    StateEvent.TOUCHBAR_TRIPLE_TAP_ALT: "triple_tap",
    StateEvent.TOUCHBAR_HOLD_START: "hold_start",
    StateEvent.TOUCHBAR_HOLD_END: "hold_end",
}


def parse(packet: Packet, arm: Arm) -> Event | None:
    """Turn a decoded packet into an event, or ``None`` if it is a command reply.

    Command replies are correlated by the session, not routed here.
    """
    op = packet.opcode
    body = packet.payload

    if op == Evt.MIC_DATA:
        if not body:
            return None
        return AudioEvent(arm=arm, raw=packet.raw, seq=body[0], data=bytes(body[1:]))

    if op == Evt.BATTERY_REPORT:
        return _battery(body, arm, packet.raw)

    if op == Evt.STATE_CHANGE:
        return _state(body, arm, packet.raw)

    return None


def _battery(body: bytes, arm: Arm, raw: bytes) -> Event:
    # [tag, percent, ...]. The tail carries voltage and charge flags and its
    # layout moves between firmware builds, so it is exposed but not trusted.
    if len(body) < 2:
        return UnknownEvent(arm=arm, raw=raw, opcode=Evt.BATTERY_REPORT, data=bytes(body))
    percent = min(100, body[1])
    voltage = None
    charging = None
    if len(body) >= 4:
        voltage = struct.unpack_from("<H", body, 2)[0]
    if len(body) >= 7:
        charging = bool(body[6])
    return BatteryEvent(
        arm=arm,
        raw=raw,
        percent=percent,
        voltage_mv=voltage,
        charging=charging,
        extra=bytes(body[2:]),
    )


def _state(body: bytes, arm: Arm, raw: bytes) -> Event:
    if not body:
        return UnknownEvent(arm=arm, raw=raw, opcode=Evt.STATE_CHANGE, data=b"")
    sub = body[0]
    tail = bytes(body[1:])

    if sub in _TOUCH:
        # A hold on the left arm is the Even AI trigger; on the right it is
        # just a hold. The distinction matters, so both events are emitted and
        # the AI one is the more specific.
        if sub == StateEvent.TOUCHBAR_HOLD_START and arm is Arm.LEFT:
            return AiRequestEvent(arm=arm, raw=raw)
        if sub == StateEvent.TOUCHBAR_HOLD_END and arm is Arm.LEFT:
            return AiStopEvent(arm=arm, raw=raw)
        return TouchEvent(arm=arm, raw=raw, gesture=_TOUCH[sub], subcode=sub)

    if sub == StateEvent.HEAD_UP:
        return HeadEvent(arm=arm, raw=raw, up=True)
    if sub == StateEvent.HEAD_DOWN:
        return HeadEvent(arm=arm, raw=raw, up=False)

    if sub == StateEvent.GLASSES_WORN:
        return WearEvent(arm=arm, raw=raw, worn=True)
    if sub == StateEvent.GLASSES_REMOVED:
        return WearEvent(arm=arm, raw=raw, worn=False)

    if sub == StateEvent.CASE_LID_OPEN:
        return CaseEvent(arm=arm, raw=raw, lid_open=True)
    if sub == StateEvent.CASE_LID_CLOSED:
        return CaseEvent(arm=arm, raw=raw, lid_open=False)
    if sub == StateEvent.CASE_CHARGING:
        return CaseEvent(arm=arm, raw=raw, charging=bool(tail[:1] and tail[0]))
    if sub == StateEvent.CASE_BATTERY:
        return CaseEvent(arm=arm, raw=raw, battery=min(100, tail[0]) if tail else None)

    if sub == StateEvent.CHARGING_STATE:
        return ChargingEvent(arm=arm, raw=raw, charging=bool(tail[:1] and tail[0]))

    if sub == StateEvent.DASHBOARD_OPENED:
        return DashboardEvent(arm=arm, raw=raw, open=True)
    if sub == StateEvent.DASHBOARD_CLOSED:
        return DashboardEvent(arm=arm, raw=raw, open=False)

    if sub == StateEvent.BLE_PAIRED:
        return PairedEvent(arm=arm, raw=raw)

    return UnknownEvent(
        arm=arm, raw=raw, opcode=Evt.STATE_CHANGE, subcode=sub, data=tail
    )


def describe(event: Event) -> str:
    """One-line human summary, used by ``openg1 monitor``."""
    side = event.arm.label
    if isinstance(event, TouchEvent):
        return f"[{side}] touch {event.gesture}"
    if isinstance(event, HeadEvent):
        return f"[{side}] head {'up' if event.up else 'down'}"
    if isinstance(event, WearEvent):
        return f"[{side}] glasses {'worn' if event.worn else 'removed'}"
    if isinstance(event, ChargingEvent):
        return f"[{side}] charging={event.charging}"
    if isinstance(event, CaseEvent):
        bits = [f"{k}={v}" for k, v in
                (("lid_open", event.lid_open), ("charging", event.charging),
                 ("battery", event.battery)) if v is not None]
        return f"[{side}] case " + (" ".join(bits) or "event")
    if isinstance(event, DashboardEvent):
        return f"[{side}] dashboard {'opened' if event.open else 'closed'}"
    if isinstance(event, BatteryEvent):
        return f"[{side}] battery {event.percent}%"
    if isinstance(event, AudioEvent):
        return f"[{side}] audio seq={event.seq} {len(event.data)}B"
    if isinstance(event, AiRequestEvent):
        return f"[{side}] Even AI requested"
    if isinstance(event, AiStopEvent):
        return f"[{side}] Even AI stopped"
    if isinstance(event, PairedEvent):
        return f"[{side}] paired"
    if isinstance(event, UnknownEvent):
        sub = "" if event.subcode is None else f" sub=0x{event.subcode:02x}"
        return f"[{side}] unknown 0x{event.opcode:02x}{sub} {event.data.hex(' ')}"
    return f"[{side}] {event.name}"
