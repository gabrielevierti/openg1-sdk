"""Builders for every command in the spec.

Each builder returns an :class:`Outbound` describing *what* to send and *where*
— it never touches the radio and never allocates a sequence number. The
session does both, which keeps this module pure and trivially testable, and is
why the conformance vectors can be generated from it.

Multi-packet operations (text, bitmaps, chunked JSON) live in :mod:`openg1.text`,
:mod:`openg1.bmp` and :mod:`openg1.api.notifications`; the per-packet builders they
use are here.
"""

from __future__ import annotations

import json
import struct
import time
from dataclasses import dataclass, replace

from ._generated import (
    COMMANDS,
    BMP_STORAGE_ADDRESS,
    DashboardMode,
    DashboardPanel,
    DashboardSub,
    ScreenAction,
    ScreenStatus,
    SilentMode,
    WeatherIcon,
)
from .crc import crc32_be
from .errors import ProtocolError


@dataclass(frozen=True)
class Outbound:
    """One packet, ready for the session to stamp and write."""

    command: str
    body: bytes = b""
    #: ``None`` means "whatever the spec says for this command".
    target: str | None = None
    #: Set False for fire-and-forget writes inside a bulk transfer.
    await_ack: bool = True

    @property
    def spec(self):
        return COMMANDS[self.command]

    @property
    def opcode(self) -> int:
        return self.spec.opcode

    @property
    def framed(self) -> bool:
        return self.spec.framed

    @property
    def resolved_target(self) -> str:
        return self.target or self.spec.target

    def to(self, target: str) -> "Outbound":
        return replace(self, target=target)

    def fire_and_forget(self) -> "Outbound":
        return replace(self, await_ack=False)


def _cmd(name: str, *args: int, data: bytes = b"") -> Outbound:
    """Build an Outbound, prefixing the constant payload the spec declares."""
    spec = COMMANDS[name]
    for a in args:
        if not 0 <= a <= 0xFF:
            raise ProtocolError(f"{name}: byte argument out of range: {a}")
    return Outbound(name, bytes(spec.prefix) + bytes(args) + bytes(data))


def _clamp(name: str, value: int, lo: int, hi: int) -> int:
    if not lo <= value <= hi:
        raise ProtocolError(f"{name} must be between {lo} and {hi}, got {value}")
    return value


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def set_brightness(level: int, auto: bool = False) -> Outbound:
    """Screen brightness. Hardware range is 0..42 (0x2A), not 0..100."""
    return _cmd("SET_BRIGHTNESS", _clamp("brightness", level, 0, 0x2A), 1 if auto else 0)


def get_brightness() -> Outbound:
    return _cmd("GET_BRIGHTNESS")


def send_text(
    data: bytes,
    *,
    seq: int,
    total_packages: int,
    package_index: int,
    screen_status: int = ScreenStatus.TEXT_SHOW | ScreenAction.NEW_CONTENT,
    new_char_pos: int = 0,
    page: int = 1,
    max_page: int = 1,
) -> Outbound:
    """One 0x4E packet. See :func:`openg1.text.paginate` for the whole message."""
    header = struct.pack(
        ">BBBBHBB",
        seq & 0xFF,
        _clamp("total_packages", total_packages, 1, 255),
        _clamp("package_index", package_index, 0, 255),
        screen_status & 0xFF,
        new_char_pos & 0xFFFF,
        _clamp("page", page, 0, 255),
        _clamp("max_page", max_page, 1, 255),
    )
    return Outbound("SEND_TEXT", header + bytes(data))


def clear_screen() -> Outbound:
    return _cmd("CLEAR_SCREEN")


def bmp_packet(index: int, chunk: bytes, *, first: bool = False) -> Outbound:
    """One 0x15 packet. The first one carries the destination address."""
    address = bytes(BMP_STORAGE_ADDRESS) if first else b""
    return Outbound("BMP_DATA", bytes([index & 0xFF]) + address + bytes(chunk))


def bmp_end() -> Outbound:
    return _cmd("BMP_END")


def bmp_crc(value: int) -> Outbound:
    return Outbound("BMP_CRC", crc32_be(value))


def set_display_settings(height: int, depth: int, *, preview: bool) -> Outbound:
    """Virtual screen geometry.

    Must be sent twice — ``preview=True`` first, then ``preview=False`` within
    a few seconds to commit. Skip the commit and the glasses stay lit and
    discard the change. :meth:`openg1.api.display.Display.set_geometry` does the
    two-step dance for you.
    """
    return _cmd(
        "SET_DISPLAY_SETTINGS",
        0x08,
        0x02,
        1 if preview else 0,
        _clamp("height", height, 0x00, 0x08),
        _clamp("depth", depth, 0x01, 0x09),
    )


def get_display_settings() -> Outbound:
    return _cmd("GET_DISPLAY_SETTINGS")


def display_power(on: bool) -> Outbound:
    return _cmd("DISPLAY_POWER", 1 if on else 0)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

def heartbeat(counter: int) -> Outbound:
    """Keepalive. Carries its own counter, distinct from the global sequence."""
    return _cmd("HEARTBEAT", 0x04, counter & 0xFF)


def seq_sync() -> Outbound:
    return _cmd("SEQ_SYNC", 0x01)


def init() -> Outbound:
    return _cmd("INIT")


def hard_reset() -> Outbound:
    """Reboot both arms. No reply — the link drops mid-command."""
    return _cmd("HARD_RESET")


def get_firmware_info() -> Outbound:
    return _cmd("GET_FIRMWARE_INFO")


def get_uptime() -> Outbound:
    return _cmd("GET_UPTIME")


def get_battery() -> Outbound:
    return _cmd("GET_BATTERY")


def get_device_info() -> Outbound:
    return _cmd("GET_DEVICE_INFO")


def get_mac_address() -> Outbound:
    return _cmd("GET_MAC_ADDRESS")


def get_glasses_serial() -> Outbound:
    return _cmd("GET_GLASSES_SERIAL")


def get_device_serial() -> Outbound:
    return _cmd("GET_DEVICE_SERIAL")


def get_esb_channel() -> Outbound:
    return _cmd("GET_ESB_CHANNEL")


def get_esb_notify_count() -> Outbound:
    return _cmd("GET_ESB_NOTIFY_COUNT")


def get_buried_point() -> Outbound:
    """Local usage telemetry. May contain personal data; nothing leaves the host."""
    return _cmd("GET_BURIED_POINT")


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def mic_control(enable: bool) -> Outbound:
    """Right arm only. Enabling starts an LC3 stream of MIC_DATA events."""
    return _cmd("MIC_CONTROL", 1 if enable else 0)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def set_silent_mode(enabled: bool) -> Outbound:
    return _cmd("SET_SILENT_MODE", SilentMode.ON if enabled else SilentMode.OFF)


def get_silent_mode() -> Outbound:
    return _cmd("GET_SILENT_MODE")


def set_headup_angle(angle: int, level: int = 1) -> Outbound:
    """Tilt in degrees (0..60) at which the display wakes."""
    return _cmd("SET_HEADUP_ANGLE", _clamp("angle", angle, 0, 0x3C), level)


def get_headup_angle() -> Outbound:
    return _cmd("GET_HEADUP_ANGLE")


def set_wear_detection(enable: bool) -> Outbound:
    return _cmd("SET_WEAR_DETECTION", 1 if enable else 0)


def get_wear_detection() -> Outbound:
    return _cmd("GET_WEAR_DETECTION")


def get_anti_shake() -> Outbound:
    return _cmd("GET_ANTI_SHAKE")


def set_button_config(action: int) -> Outbound:
    """Rebind the head-up gesture. See :class:`openg1.ButtonAction`."""
    return _cmd("SET_BUTTON_CONFIG", 0x03, action & 0xFF)


def set_gesture_config(action: int) -> Outbound:
    """Rebind the double-tap gesture. Shares opcode 0x26 with the geometry
    command; the 0x05 subcommand byte is what tells them apart."""
    return _cmd("SET_GESTURE_CONFIG", 0x05, action & 0xFF)


def calibration(step: int, data: bytes = b"") -> Outbound:
    return _cmd("CALIBRATION", step & 0xFF, data=data)


def reset_zero_degree() -> Outbound:
    """Re-zero the head-tracking reference."""
    return calibration(0x01)


def set_language(language: int) -> Outbound:
    return _cmd("SET_LANGUAGE", 0x01, language & 0xFF)


def set_message_mode(mode: int) -> Outbound:
    return _cmd("SET_MESSAGE_MODE", mode & 0xFF)


def set_ancs_config(data: bytes) -> Outbound:
    return _cmd("SET_ANCS_CONFIG", data=data)


def set_debug_mode(enable: bool) -> Outbound:
    return _cmd("SET_DEBUG_MODE", 1 if enable else 0)


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

def set_time_and_weather(
    *,
    epoch_s: int | None = None,
    epoch_ms: int | None = None,
    icon: int = WeatherIcon.NONE,
    temperature_c: int = 0,
    fahrenheit: bool = False,
    twelve_hour: bool = False,
) -> Outbound:
    """Clock and weather widget.

    The device wants the timestamp twice, once as 32-bit seconds and once as
    64-bit milliseconds, both little endian. ``temperature_c`` is always sent
    in Celsius; ``fahrenheit`` only changes what the glasses render.
    """
    now = time.time()
    epoch_s = int(now) if epoch_s is None else int(epoch_s)
    epoch_ms = int(now * 1000) if epoch_ms is None else int(epoch_ms)
    body = struct.pack(
        "<BIQBbBB",
        DashboardSub.TIME_WEATHER,
        epoch_s & 0xFFFFFFFF,
        epoch_ms & 0xFFFFFFFFFFFFFFFF,
        _clamp("icon", int(icon), 0x00, 0x10),
        _clamp("temperature_c", int(temperature_c), -128, 127),
        1 if fahrenheit else 0,
        1 if twelve_hour else 0,
    )
    return Outbound("SET_DASHBOARD", body)


def set_dashboard_layout(
    mode: int = DashboardMode.DUAL,
    panel: int = DashboardPanel.NOTES,
) -> Outbound:
    """Dashboard layout. ``panel`` is ignored in MINIMAL mode."""
    body = bytes(
        [
            DashboardSub.LAYOUT,
            _clamp("mode", int(mode), 0x00, 0x02),
            int(panel) & 0xFF,
        ]
    )
    return Outbound("SET_DASHBOARD", body)


def dashboard_lock(locked: bool) -> Outbound:
    return _cmd("DASHBOARD_LOCK", 0x01, 1 if locked else 0)


def set_quick_note(data: bytes) -> Outbound:
    return _cmd("SET_QUICK_NOTE", data=data)


def set_calendar_event(data: bytes) -> Outbound:
    return _cmd("SET_CALENDAR_EVENT", data=data)


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

def notification_config_packet(chunk: bytes, index: int, count: int) -> Outbound:
    return Outbound(
        "SET_NOTIFICATION_CONFIG",
        bytes([_clamp("count", count, 1, 255), index & 0xFF]) + bytes(chunk),
    )


def notification_packet(chunk: bytes, index: int, count: int) -> Outbound:
    return Outbound(
        "SEND_NOTIFICATION",
        bytes([_clamp("count", count, 1, 255), index & 0xFF]) + bytes(chunk),
    )


def clear_notification() -> Outbound:
    return _cmd("CLEAR_NOTIFICATION")


def get_whitelist() -> Outbound:
    return _cmd("GET_WHITELIST")


def notification_json(
    *,
    app_id: str,
    app_name: str,
    title: str,
    subtitle: str = "",
    message: str = "",
    timestamp: int | None = None,
    ncs_id: int = 0,
) -> bytes:
    """The JSON body the 0x4B notification command carries.

    Field names match what the official app emits; the firmware is picky about
    them, so they are not normalised to snake_case here.
    """
    payload = {
        "ncs_notification": {
            "msg_id": int(time.time() * 1000) & 0xFFFFFFFF,
            "type": 0,
            "app_identifier": app_id,
            "title": title,
            "subtitle": subtitle,
            "message": message,
            "time_s": int(timestamp if timestamp is not None else time.time()),
            "date": "",
            "display_name": app_name,
        }
    }
    if ncs_id:
        payload["ncs_notification"]["ncs_id"] = ncs_id
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def notification_config_json(
    apps: list[tuple[str, str]],
    *,
    calendar: bool = True,
    call: bool = True,
    messages: bool = True,
    ios_mail: bool = True,
    enable: bool = True,
) -> bytes:
    """Allow-list document for the 0x04 command. ``apps`` is (id, name) pairs."""
    payload = {
        "calendar_enable": calendar,
        "call_enable": call,
        "msg_enable": messages,
        "ios_mail_enable": ios_mail,
        "app": {
            "list": [{"id": app_id, "name": name} for app_id, name in apps],
            "enable": enable,
        },
    }
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------

def set_teleprompter(data: bytes) -> Outbound:
    return _cmd("SET_TELEPROMPTER", data=data)


def set_navigation(data: bytes) -> Outbound:
    """Raw turn-by-turn payload.

    The field layout of 0x0A is not established. :mod:`openg1.api.navigation`
    builds a best-effort structured payload on top of this; if you work out
    the real layout, that is the one place to change.
    """
    return _cmd("SET_NAVIGATION", data=data)
