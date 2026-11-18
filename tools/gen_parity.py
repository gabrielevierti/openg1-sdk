#!/usr/bin/env python3
"""Dump what the Python SDK produces for a fixed set of inputs.

test/parity.test.ts replays the same inputs through the TypeScript SDK and
compares. protocol/vectors.json pins the framing; this pins everything built
on top of it — command builders, text layout, dithering, BMP files, transfer
chunking — so the two SDKs cannot drift apart unnoticed.

    python3 tools/gen_parity.py
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

from openg1 import bmp, commands as c, text  # noqa: E402
from openg1.crc import bmp_crc  # noqa: E402

TEXTS = [
    "ciao",
    "",
    "The quick brown fox jumps over the lazy dog. " * 6,
    "Uscita 12 — prendi la A7 verso Milano, poi tieni la destra per la tangenziale ovest.",
    "riga uno\n\nriga tre\nriga quattro\nriga cinque\nriga sei\nriga sette",
    "Supercalifragilisticexpialidocious" * 4,
    "日本語のテキストは単語の間にスペースがありません。どこでも改行できます。",
    "perché così è più bello — àèìòù €",
    "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW iiiiiiiiiiiiiiiiiiiiiiiiii",
    "a  b   c    d " * 20,
]


def builders() -> dict[str, str]:
    out = {
        "set_brightness(30,True)": c.set_brightness(30, True),
        "set_brightness(0)": c.set_brightness(0),
        "get_brightness": c.get_brightness(),
        "clear_screen": c.clear_screen(),
        "bmp_end": c.bmp_end(),
        "bmp_crc(0xDEADBEEF)": c.bmp_crc(0xDEADBEEF),
        "bmp_packet(0,first)": c.bmp_packet(0, bytes(range(10)), first=True),
        "bmp_packet(7)": c.bmp_packet(7, bytes(range(10))),
        "set_display_settings(4,5,preview)": c.set_display_settings(4, 5, preview=True),
        "set_display_settings(8,9,commit)": c.set_display_settings(8, 9, preview=False),
        "display_power(True)": c.display_power(True),
        "heartbeat(42)": c.heartbeat(42),
        "seq_sync": c.seq_sync(),
        "init": c.init(),
        "hard_reset": c.hard_reset(),
        "get_firmware_info": c.get_firmware_info(),
        "get_battery": c.get_battery(),
        "get_uptime": c.get_uptime(),
        "mic_control(True)": c.mic_control(True),
        "set_silent_mode(True)": c.set_silent_mode(True),
        "set_silent_mode(False)": c.set_silent_mode(False),
        "set_headup_angle(35)": c.set_headup_angle(35),
        "set_wear_detection(True)": c.set_wear_detection(True),
        "set_button_config(3)": c.set_button_config(3),
        "set_gesture_config(4)": c.set_gesture_config(4),
        "reset_zero_degree": c.reset_zero_degree(),
        "calibration(2,0100)": c.calibration(0x02, bytes([1, 0])),
        "set_language(2)": c.set_language(2),
        "set_debug_mode(True)": c.set_debug_mode(True),
        "time_weather": c.set_time_and_weather(
            epoch_s=1_763_424_000, epoch_ms=1_763_424_000_123, icon=0x10, temperature_c=-7,
            fahrenheit=True, twelve_hour=True,
        ),
        "dashboard_layout(0,3)": c.set_dashboard_layout(0, 3),
        "dashboard_lock(True)": c.dashboard_lock(True),
        "clear_notification": c.clear_notification(),
        "send_text": c.send_text(b"ciao", seq=9, total_packages=3, package_index=1,
                                 new_char_pos=0x1234, page=2, max_page=4),
        "notification_packet": c.notification_packet(b"{}", 1, 3),
        "notification_config_packet": c.notification_config_packet(b"{}", 0, 1),
        "set_navigation": c.set_navigation(bytes([1, 2, 3])),
    }
    return {k: f"{v.command}:{v.body.hex()}" for k, v in out.items()}


def layouts() -> list[dict]:
    out = []
    for t in TEXTS:
        pages = text.text_packets(t, seq=5, max_data=60)
        out.append({
            "text": t,
            "wrap": text.wrap(t),
            "wrap_200": text.wrap(t, width_px=200),
            "measure": round(text.DEFAULT_METRICS.measure(t), 4),
            "packets": [[p.body.hex() for p in page] for page in pages],
        })
    return out


def images() -> dict:
    width, height = 576, 136
    gray = bytes((x * 7 + y * 13 + (x * y) % 31) % 256 for y in range(height) for x in range(width))
    dithered = bmp.from_gray(gray, width, height)
    thresholded = bmp.from_gray(gray, width, height, dither=False, threshold=100)
    file = dithered.to_bmp()
    packets, end, crc = bmp.transfer_packets(file)
    small = bmp.from_gray(bytes(range(0, 200, 10)) * 3, 20, 3, dither=False)
    return {
        "dithered_bmp": file.hex(),
        "dithered_top_down_crc": f"{bmp_crc(dithered.to_bmp(top_down=True)):08x}",
        "thresholded_crc": f"{bmp_crc(thresholded.to_bmp()):08x}",
        "packet_count": len(packets),
        "first_packet": packets[0].body.hex(),
        "last_packet": packets[-1].body.hex(),
        "end": end.body.hex(),
        "crc": crc.body.hex(),
        "small_bmp": small.to_bmp().hex(),
        "content_bounds": list(bmp.content_bounds(bmp.shift_rows(small, 1))),
    }


def main() -> None:
    data = {
        "note": "Generated by tools/gen_parity.py from the Python SDK. Do not edit.",
        "builders": builders(),
        "layouts": layouts(),
        "images": images(),
        "notification_json": c.notification_json(
            app_id="com.example", app_name="Esempio", title="Titolo è", subtitle="s",
            message="m", timestamp=1_763_424_000,
        ).decode(),
        "notification_config_json": c.notification_config_json(
            [("com.a", "A"), ("com.b", "B")], calendar=False
        ).decode(),
    }
    out = ROOT / "test" / "fixtures" / "python-parity.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
