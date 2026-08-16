"""``openg1`` — drive the glasses from a shell.

Every subcommand takes ``--sim``, which runs it against the simulated
emulator instead of a radio. That is not a toy mode: it is how you check that
a command builds the bytes you expected before you point it at hardware you
cannot easily debug.

    openg1 scan
    openg1 text "ciao Milano"
    openg1 monitor
    openg1 info --sim
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import sys

from . import __version__
from . import commands as cmd
from ._generated import Arm, DashboardMode, DashboardPanel, WeatherIcon
from .device import G1
from .errors import OpenG1Error
from .events import describe
from .text import preview as text_preview


async def _open(args) -> tuple[G1, object | None]:
    """Real glasses, or a simulated pair when ``--sim`` is given.

    ``openg1sim`` is imported here rather than at module scope: it is a
    development tool, and the CLI must keep working in an install that does
    not ship it.
    """
    if getattr(args, "sim", False):
        try:
            from openg1sim import SimulatedG1
        except ImportError as exc:  # pragma: no cover - depends on install
            raise SystemExit(
                "--sim needs openg1sim, which is not installed in this environment"
            ) from exc
        sim = SimulatedG1()
        await sim.__aenter__()
        return sim.g1, sim.emulator
    return await G1.connect(timeout=args.timeout, channel=args.channel), None


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

async def cmd_profile(args) -> int:
    """Show the device profile, or write a new one."""
    from .profile import DeviceProfile, active, candidate_paths, load

    if args.set:
        top, _, bottom = args.set.partition(",")
        device = DeviceProfile(
            name="my-g1", hidden_top=int(top), hidden_bottom=int(bottom or 0)
        )
        print(f"wrote {device.save()}")
        print(f"  {device.describe()}")
        return 0

    device = load()
    print(device.describe())
    print("\nlooked in:")
    for path in candidate_paths():
        print(f"  {'*' if path.is_file() else ' '} {path}")
    return 0


async def cmd_scan(args) -> int:
    from .transport.bleak_transport import scan

    arms = await scan(args.timeout)
    if not arms:
        print("no G1 arms found — take both arms out of the case and close the "
              "official app, which holds the connection exclusively")
        return 1
    for arm in arms:
        rssi = f"{arm.rssi:>4} dBm" if arm.rssi is not None else "       "
        print(f"{arm.arm.label}  ch{arm.channel:>3}  {rssi}  {arm.address}  {arm.name}")
    return 0


async def cmd_info(args) -> int:
    g1, _ = await _open(args)
    try:
        battery = await g1.info.battery()
        firmware = await g1.info.firmware()
        serial = await g1.info.serial()
        brightness, auto = await g1.display.get_brightness()
        height, depth = await g1.display.get_geometry()
        data = {
            "firmware": firmware.version,
            "build": firmware.build,
            "battery": {"left": battery.left, "right": battery.right},
            "uptime_s": await g1.info.uptime(),
            "serial": serial.serial,
            "frame": serial.frame,
            "colour": serial.color,
            "brightness": brightness,
            "auto_brightness": auto,
            "screen": {"height": height, "depth": depth},
            "silent_mode": await g1.settings.get_silent_mode(),
            "headup_angle": await g1.settings.get_headup_angle(),
        }
        if args.json:
            print(json.dumps(data, indent=2))
        else:
            for key, value in data.items():
                print(f"{key:>16}: {value}")
    finally:
        await g1.disconnect()
    return 0


async def cmd_text(args) -> int:
    if args.preview:
        print(text_preview(args.message))
        return 0
    g1, glasses = await _open(args)
    try:
        await g1.display.text(args.message, hold=args.hold, page_delay=args.page_delay)
        if glasses is not None:
            print(f"simulated screen: {glasses.left.screen_text!r}")
    finally:
        await g1.disconnect()
    return 0


async def cmd_image(args) -> int:
    try:
        top, _, bottom = args.safe_area.partition(",")
        safe_area = (int(top), int(bottom))
    except ValueError:
        print(f"--safe-area wants TOP,BOTTOM in pixels, not {args.safe_area!r}")
        return 2

    g1, glasses = await _open(args)
    try:
        def progress(done: int, total: int) -> None:
            print(f"\r  {done}/{total} packets", end="", flush=True)

        await g1.display.image(
            args.path,
            dither=not args.no_dither,
            fit=args.fit,
            safe_area=safe_area,
            progress=progress,
        )
        print("\rtransfer complete          ")
        if glasses is not None:
            print(f"simulated checksum ok: {glasses.left.bmp_crc_ok}")
        if args.hold:
            await asyncio.sleep(args.hold)
    finally:
        await g1.disconnect()
    return 0


async def cmd_battery(args) -> int:
    g1, _ = await _open(args)
    try:
        battery = await g1.info.battery()
        print(f"left {battery.left}%   right {battery.right}%")
    finally:
        await g1.disconnect()
    return 0


async def cmd_brightness(args) -> int:
    g1, _ = await _open(args)
    try:
        if args.level is None:
            level, auto = await g1.display.get_brightness()
            print(f"{level}/42  auto={auto}")
        else:
            await g1.display.brightness(args.level, auto=args.auto)
    finally:
        await g1.disconnect()
    return 0


async def cmd_clear(args) -> int:
    g1, _ = await _open(args)
    try:
        await g1.display.clear()
    finally:
        await g1.disconnect()
    return 0


async def cmd_dashboard(args) -> int:
    g1, _ = await _open(args)
    try:
        await g1.dashboard.set_layout(
            getattr(DashboardMode, args.mode.upper()),
            getattr(DashboardPanel, args.panel.upper()),
        )
        await g1.dashboard.set_weather(
            icon=getattr(WeatherIcon, args.weather.upper()),
            temperature_c=args.temperature,
        )
    finally:
        await g1.disconnect()
    return 0


async def cmd_notify(args) -> int:
    g1, _ = await _open(args)
    try:
        await g1.notifications.notify(
            title=args.title, message=args.message, app_name=args.app
        )
    finally:
        await g1.disconnect()
    return 0


async def cmd_monitor(args) -> int:
    """Print every event until interrupted. The reverse-engineering workhorse."""
    g1, glasses = await _open(args)
    if args.trace:
        g1.session.start_trace()
    print("listening — put the glasses on, tap, look up. ctrl-c to stop.")
    try:
        stream = g1.events()
        while True:
            event = await stream.__anext__()
            print(describe(event))
            if args.raw:
                print(f"    {event.raw.hex(' ')}")
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if args.trace:
            for ts, arm, direction, data in g1.session.stop_trace():
                print(f"{ts:.3f} {arm.label} {direction} {data.hex(' ')}")
        await g1.disconnect()
    return 0


async def cmd_send(args) -> int:
    """Put arbitrary bytes on one arm and watch what comes back."""
    payload = bytes.fromhex(args.hex.replace(" ", ""))
    g1, _ = await _open(args)
    g1.session.start_trace()
    try:
        arms = [Arm.LEFT, Arm.RIGHT] if args.arm == "both" else \
               [Arm.LEFT if args.arm == "left" else Arm.RIGHT]
        for arm in arms:
            await g1.session.send_raw(arm, payload)
        await asyncio.sleep(args.wait)
    finally:
        for ts, arm, direction, data in g1.session.stop_trace():
            print(f"{arm.label} {direction} {data.hex(' ')}")
        await g1.disconnect()
    return 0


async def cmd_record(args) -> int:
    g1, glasses = await _open(args)
    try:
        print(f"recording {args.seconds}s from the right arm...")
        buffer = await g1.audio.record(args.seconds)
        print(f"{buffer.frame_count} frames, ~{buffer.duration_s:.1f}s, "
              f"{len(buffer.missing())} dropped")
        if buffer.frame_count:
            buffer.write_lc3(args.output)
            print(f"wrote {args.output}")
            print("convert with: ffmpeg -i " + args.output + " out.wav")
    finally:
        await g1.disconnect()
    return 0


async def cmd_demo(args) -> int:
    """Exercise every subsystem in order. Good first run on real hardware."""
    g1, glasses = await _open(args)
    try:
        steps = [
            ("firmware", g1.info.firmware()),
            ("battery", g1.info.battery()),
            ("brightness", g1.display.brightness(25)),
            ("text", g1.display.text("openg1 sdk\nworking", page_delay=0, hold=1.0)),
            ("dashboard", g1.dashboard.set_weather(icon=WeatherIcon.SUNNY, temperature_c=22)),
            ("notification", g1.notifications.notify(title="openg1", message="demo")),
            ("clear", g1.display.clear()),
        ]
        for name, coro in steps:
            try:
                result = await coro
                print(f"  ok    {name}" + (f"  {result}" if name in ("firmware", "battery") else ""))
            except OpenG1Error as exc:
                print(f"  FAIL  {name}: {exc}")
    finally:
        await g1.disconnect()
    return 0


def cmd_spec(args) -> int:
    """Print the command table. No device needed."""
    from ._generated import COMMANDS

    width = max(len(n) for n in COMMANDS)
    for name, spec in COMMANDS.items():
        prefix = spec.prefix.hex(" ") or "-"
        print(
            f"{name:<{width}}  0x{spec.opcode:02X}  "
            f"{'framed' if spec.framed else 'raw   '}  "
            f"{spec.target:<5}  {spec.response:<8}  {prefix:<5}  {spec.confidence}"
        )
    return 0


# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="openg1", description=__doc__.split("\n")[0])
    parser.add_argument("--version", action="version", version=f"openg1 {__version__}")
    parser.add_argument("--sim", action="store_true",
                        help="run against a simulated pair instead of real glasses "
                             "(see `python3 -m openg1sim` for the visual version)")
    parser.add_argument("--timeout", type=float, default=6.0, help="scan timeout")
    parser.add_argument("--channel", default=None, help="pick a specific pair")
    parser.add_argument("-d", "--debug", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("scan", help="list nearby G1 arms").set_defaults(func=cmd_scan)

    p = sub.add_parser("info", help="dump device state")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("text", help="display a message")
    p.add_argument("message")
    p.add_argument("--hold", type=float, default=5.0)
    p.add_argument("--page-delay", type=float, default=3.0)
    p.add_argument("--preview", action="store_true", help="show the layout, send nothing")
    p.set_defaults(func=cmd_text)

    p = sub.add_parser("image", help="display an image file")
    p.add_argument("path")
    p.add_argument("--no-dither", action="store_true")
    p.add_argument(
        "--safe-area",
        metavar="TOP,BOTTOM",
        default="0,0",
        help="rows hidden at the top and bottom of your panel; the picture is "
        "scaled to fit between them. Measure with examples/07_calibrate.py.",
    )
    p.add_argument("--fit", choices=("contain", "cover", "stretch"), default="contain")
    p.add_argument("--hold", type=float, default=10.0)
    p.set_defaults(func=cmd_image)

    prof = sub.add_parser("profile", help="show or set your device profile")
    prof.add_argument("--set", metavar="TOP,BOTTOM",
                      help="hidden rows, from examples/07_calibrate.py")
    prof.set_defaults(func=cmd_profile)

    sub.add_parser("battery", help="read both batteries").set_defaults(func=cmd_battery)
    sub.add_parser("clear", help="clear the display").set_defaults(func=cmd_clear)

    p = sub.add_parser("brightness", help="get or set brightness (0-42)")
    p.add_argument("level", nargs="?", type=int)
    p.add_argument("--auto", action="store_true")
    p.set_defaults(func=cmd_brightness)

    p = sub.add_parser("dashboard", help="configure the dashboard")
    p.add_argument("--mode", default="dual", choices=["full", "dual", "minimal"])
    p.add_argument("--panel", default="notes",
                   choices=["notes", "stock", "news", "calendar", "navigation", "empty"])
    p.add_argument("--weather", default="sunny")
    p.add_argument("--temperature", type=int, default=20)
    p.set_defaults(func=cmd_dashboard)

    p = sub.add_parser("notify", help="push a notification")
    p.add_argument("title")
    p.add_argument("message", nargs="?", default="")
    p.add_argument("--app", default="OG1")
    p.set_defaults(func=cmd_notify)

    p = sub.add_parser("monitor", help="print events as they arrive")
    p.add_argument("--raw", action="store_true", help="also print the packet bytes")
    p.add_argument("--trace", action="store_true", help="dump a full trace on exit")
    p.set_defaults(func=cmd_monitor)

    p = sub.add_parser("send", help="write raw hex to an arm and show the reply")
    p.add_argument("hex")
    p.add_argument("--arm", default="both", choices=["left", "right", "both"])
    p.add_argument("--wait", type=float, default=1.0)
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("record", help="capture microphone audio")
    p.add_argument("--seconds", type=float, default=5.0)
    p.add_argument("--output", default="capture.lc3")
    p.set_defaults(func=cmd_record)

    sub.add_parser("demo", help="exercise every subsystem").set_defaults(func=cmd_demo)
    sub.add_parser("spec", help="print the command table").set_defaults(func=cmd_spec)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        if asyncio.iscoroutinefunction(args.func):
            return asyncio.run(args.func(args))
        return args.func(args)
    except OpenG1Error as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        raise SystemExit(main())
