#!/usr/bin/env python3
"""Generate protocol/vectors.json — the contract every binding must satisfy.

A multi-language SDK for hardware nobody can lend you is only trustworthy if
the implementations can be checked against each other. So the Python reference
emits a file of "these bytes in, those bytes out" cases, and the C, C++, Java
and TypeScript runners replay it. A binding that passes is byte-identical to
the reference on every command in the spec; a binding that fails says exactly
which vector broke.

Four kinds of vector:

``encode``  build a named command from a raw argument body and compare bytes
``decode``  parse bytes and compare the parsed fields
``crc``     checksum a buffer
``split``   chop a UTF-8 buffer without tearing a character

The decode vectors include real captures from instrumented devices, which is
why they are worth more than anything generated: they are the ground truth.
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The SDK lives at the repository root in a Python-only checkout and under
# bindings/python in the full one. Try both rather than caring which.
for _candidate in (ROOT, ROOT / "bindings" / "python"):
    if (_candidate / "openg1").is_dir():
        sys.path.insert(0, str(_candidate))
        break

import yaml  # noqa: E402

from openg1 import framing  # noqa: E402
from openg1._generated import COMMANDS  # noqa: E402
from openg1.crc import bmp_crc, crc32_xz  # noqa: E402
from openg1.text import split_utf8  # noqa: E402

SPEC = yaml.safe_load((ROOT / "protocol" / "openg1.protocol.yaml").read_text(encoding="utf-8"))
OUT = ROOT / "protocol" / "vectors.json"


def hx(data: bytes) -> str:
    return data.hex()


#: A representative argument body per command — everything after the constant
#: prefix. Kept in one table so a new command shows up as a missing vector.
BODIES: dict[str, bytes] = {
    "SET_BRIGHTNESS": bytes([0x1E, 0x01]),
    "SEND_TEXT": bytes([0x07, 0x02, 0x00, 0x71, 0x00, 0x00, 0x01, 0x03]) + b"ciao",
    "CLEAR_SCREEN": b"",
    "BMP_DATA": bytes([0x00, 0x00, 0x1C, 0x00, 0x00]) + bytes(range(8)),
    "BMP_END": b"",
    "BMP_CRC": bytes([0xDE, 0xAD, 0xBE, 0xEF]),
    "SET_DISPLAY_SETTINGS": bytes([0x08, 0x02, 0x01, 0x04, 0x05]),
    "GET_DISPLAY_SETTINGS": b"",
    "GET_BRIGHTNESS": b"",
    "DISPLAY_POWER": bytes([0x01]),
    "HEARTBEAT": bytes([0x04, 0x2A]),
    "SEQ_SYNC": bytes([0x01]),
    "INIT": b"",
    "HARD_RESET": b"",
    "GET_FIRMWARE_INFO": b"",
    "GET_UPTIME": b"",
    "GET_BATTERY": b"",
    "GET_DEVICE_INFO": b"",
    "GET_MAC_ADDRESS": b"",
    "GET_GLASSES_SERIAL": b"",
    "GET_DEVICE_SERIAL": b"",
    "GET_ESB_CHANNEL": b"",
    "GET_ESB_NOTIFY_COUNT": b"",
    "GET_BURIED_POINT": b"",
    "MIC_CONTROL": bytes([0x01]),
    "SET_SILENT_MODE": bytes([0x0C]),
    "GET_SILENT_MODE": b"",
    "SET_HEADUP_ANGLE": bytes([0x1E, 0x01]),
    "GET_HEADUP_ANGLE": b"",
    "SET_WEAR_DETECTION": bytes([0x01]),
    "GET_WEAR_DETECTION": b"",
    "GET_ANTI_SHAKE": b"",
    "SET_BUTTON_CONFIG": bytes([0x03, 0x00]),
    "SET_GESTURE_CONFIG": bytes([0x05, 0x05]),
    "CALIBRATION": bytes([0x02, 0x01, 0x00]),
    "SET_LANGUAGE": bytes([0x01, 0x02]),
    "SET_MESSAGE_MODE": bytes([0x01]),
    "SET_ANCS_CONFIG": bytes([0x01, 0x02, 0x03]),
    "SET_DEBUG_MODE": bytes([0x01]),
    "SET_DASHBOARD": bytes([0x01, 0x40, 0xE2, 0x01, 0x00]),
    "DASHBOARD_LOCK": bytes([0x01, 0x01]),
    "SET_QUICK_NOTE": bytes([0x03, 0x01, 0x00, 0x01]),
    "SET_CALENDAR_EVENT": bytes([0x01, 0x02]),
    "SET_NOTIFICATION_CONFIG": bytes([0x01, 0x00]) + b'{"call_enable":true}',
    "SEND_NOTIFICATION": bytes([0x02, 0x00]) + b'{"title":"hi"}',
    "CLEAR_NOTIFICATION": b"",
    "GET_WHITELIST": b"",
    "SET_TELEPROMPTER": b"line one",
    "SET_NAVIGATION": bytes([0x01, 0x00, 0x64]),
}

#: Bytes captured from real hardware. These are the vectors that matter.
CAPTURES: list[tuple[str, str, str]] = [
    ("quick_note_request", "1e1000290301000100030001000100 00",
     "framed: opcode 0x1E declares 16 bytes, sequence 0x29"),
    ("button_config_headup_dashboard", "0806000300 00".replace(" ", ""),
     "framed: head-up gesture bound to the dashboard"),
    ("gesture_config_double_tap_none", "260600 0a0500",
     "framed: 0x26 with subcommand 0x05 is the gesture binding, not geometry"),
    ("display_settings_commit", "2608000802010704",
     "framed: 0x26 with subcommand 0x08 is the geometry command"),
    ("calibration_reset_zero", "1005000401",
     "framed: five-byte packet, the shortest framed form"),
    ("calibration_step", "1007000c020100",
     "framed: seven-byte calibration step"),
    ("calibration_reply_padded", "10060004 01c90000000000000000000000000000".replace(" ", ""),
     "reply padded to the ATT payload size; the length field is what trims it"),
    ("display_power_request", "390500 1c01",
     "framed request"),
    ("display_power_reply", "3905001c0100",
     "reply appends its result past the declared length"),
    ("dashboard_lock_reply", "500600000101",
     "framed reply, right arm only"),
    ("language_setting", "3d06001 40102".replace(" ", ""),
     "framed language setting"),
    ("seq_sync", "2205000101",
     "opcode 0x22, length 5 — not 'command 0x22 subcommand 0x05', which is how "
     "several published tables read it"),
    ("heartbeat", "250600 2a042a",
     "opcode 0x25, length 6, heartbeat counter repeated after a 0x04 tag"),
    ("headup_angle_reply", "326d0f0100000000000000000000000000000000",
     "raw reply, zero padded"),
    ("battery_reply_right", "2c6664ef801901040501 0405",
     "raw battery report: tag 0x66 then percent"),
    ("touch_single_tap", "f501", "state change: single tap"),
    ("touch_hold_start", "f517", "state change: touchbar held — the Even AI trigger"),
    ("glasses_worn", "f506", "state change: glasses put on"),
    ("case_battery", "f50f42", "state change: case battery percentage"),
    ("mic_frame", "f10a" + "00" * 20, "one LC3 frame, sequence 10"),
    ("mic_enable_ack", "0ec901", "generic acknowledgement with the echoed argument"),
]


def build() -> dict:
    vectors: list[dict] = []

    # -- encode: every command in the spec ---------------------------------
    missing = [name for name in COMMANDS if name not in BODIES]
    if missing:
        raise SystemExit(
            "no representative body for: " + ", ".join(missing) +
            "\nadd one to BODIES in tools/gen_vectors.py"
        )

    for name, spec in COMMANDS.items():
        body = BODIES[name]
        seq = 0x2A if spec.framed else None
        # `body` is what the caller supplies; the constant prefix comes from
        # each implementation's own command table, which is the point — a
        # binding with a wrong prefix fails here rather than on hardware.
        full = bytes(spec.prefix) + body
        wire = (
            framing.encode_framed(spec.opcode, seq, full)
            if spec.framed
            else framing.encode_raw(spec.opcode, full)
        )
        vectors.append(
            {
                "kind": "encode",
                "name": f"encode_{name.lower()}",
                "command": name,
                "seq": seq,
                "body": hx(body),
                "expect": hx(wire),
            }
        )

    # -- decode: real captures ---------------------------------------------
    for name, hex_bytes, note in CAPTURES:
        data = bytes.fromhex(hex_bytes.replace(" ", ""))
        packet = framing.decode(data)
        vectors.append(
            {
                "kind": "decode",
                "name": f"decode_{name}",
                "note": note,
                "input": hx(data),
                "expect": {
                    "opcode": packet.opcode,
                    "framed": packet.framed,
                    "seq": packet.seq,
                    "payload": hx(packet.payload),
                    "trailer": hx(packet.trailer),
                },
            }
        )

    # -- crc ----------------------------------------------------------------
    crc_cases = [
        ("empty", b""),
        ("ascii", b"123456789"),
        ("bitmap_header", bytes.fromhex("424dfe260000000000003e000000")),
        ("ramp", bytes(range(256))),
    ]
    for name, data in crc_cases:
        vectors.append(
            {
                "kind": "crc",
                "name": f"crc_{name}",
                "input": hx(data),
                "expect": f"{crc32_xz(data):08x}",
            }
        )
    for name, data in crc_cases:
        vectors.append(
            {
                "kind": "crc_bmp",
                "name": f"crc_bmp_{name}",
                "input": hx(data),
                "expect": f"{bmp_crc(data):08x}",
            }
        )

    # -- utf-8 splitting ----------------------------------------------------
    split_cases = [
        ("ascii", "abcdefghijklmnop", 5),
        ("accented", "caffè corretto però", 7),
        ("cjk", "東京都渋谷区神宮前", 7),
        ("emoji", "ok 👍🏽 done 🚴 now", 9),
        ("mixed", "città 東京 ok", 6),
    ]
    for name, text, limit in split_cases:
        pieces = split_utf8(text.encode("utf-8"), limit)
        vectors.append(
            {
                "kind": "split",
                "name": f"split_{name}",
                "input": hx(text.encode("utf-8")),
                "limit": limit,
                "expect": [hx(p) for p in pieces],
            }
        )

    return {
        "spec_version": SPEC["meta"]["spec_version"],
        "generator": "tools/gen_vectors.py",
        "note": (
            "Regenerate with `python3 tools/gen_vectors.py`. Every binding must "
            "reproduce every vector byte for byte; see conformance/README.md."
        ),
        "vectors": vectors,
    }


def main() -> int:
    data = build()
    OUT.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    kinds: dict[str, int] = {}
    for v in data["vectors"]:
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: {len(data['vectors'])} vectors")
    for kind, count in sorted(kinds.items()):
        print(f"  {kind}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
