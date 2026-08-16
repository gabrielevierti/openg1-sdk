"""Command line entry point: ``python3 -m openg1sim <command>``."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from . import __version__
from . import scenes
from .device import SimulatedG1


async def cmd_demo(args) -> int:
    """A scripted tour, printed to the terminal one screen at a time."""
    async with SimulatedG1() as sim:
        g1 = sim.g1

        async def show(title: str, pause: float = 0.0) -> None:
            print(f"\n\x1b[2m{title}\x1b[0m")
            print(sim.panel.frame.to_blocks())
            report = sim.report()
            notes = []
            if report.truncated_lines:
                notes.append(f"{report.truncated_lines} line(s) did not fit")
            if report.overflow:
                notes.append(f"{len(report.overflow)} line(s) overflow")
            print(f"  {report.lit_pixels} pixels lit" + ("   " + ", ".join(notes) if notes else ""))
            if pause:
                await asyncio.sleep(pause)

        await g1.display.text("ciao from openg1")
        await show("display.text('ciao from openg1')")

        await g1.display.text(scenes.PARAGRAPH)
        await show("a paragraph, wrapped to the panel")

        await g1.display.text(
            "This text is deliberately far too long for one screen. "
            "The panel holds five lines at the default size, and everything "
            "past that is simply not shown, so the simulator says so instead "
            "of letting you find out on the hardware. Paginate it, or make it "
            "shorter, or accept that the end is invisible."
        )
        await show("more than fits — note the warning")

        await sim.head_up(False)
        await show("head down: the display is off")
        await sim.head_up(True)

        sim.set_clock("14:32", "18°  clear")
        await sim.dashboard(True)
        await show("dashboard open")
        await sim.dashboard(False)

        from openg1.bmp import Bitmap
        import math

        bitmap = Bitmap.blank(576, 136)
        for x in range(576):
            bitmap.set(x, 8)
            bitmap.set(x, 127)
            bitmap.set(x, int(68 + 50 * math.sin(x / 40)))
        await g1.display.bitmap(bitmap)
        await show("a bitmap, sent in 194-byte chunks with a CRC")

        await g1.display.clear()
        await g1.display.text("Via Emilia\n2.4 km   4 min   limit 50   42 km/h")
        await show("a navigation screen")

        print(f"\n{sim.frames} frames rendered, no hardware involved")
    return 0


async def cmd_term(args) -> int:
    from .terminal import run_terminal

    await run_terminal(colour=not args.no_colour)
    return 0


async def cmd_web(args) -> int:
    from .web import run_web

    try:
        await run_web(args.host, args.port)
    except KeyboardInterrupt:  # pragma: no cover
        pass
    return 0


def cmd_gui(args) -> int:
    """The desktop window. Not a coroutine: Tk owns the main thread, and the
    simulator runs on its own (see openg1sim.controller)."""
    from .gui import run_gui

    return run_gui(host=args.host, glasses_port=args.glasses_port)


async def cmd_app(args) -> int:
    """Run the simulator as a standalone application."""
    from .appserver import run_app

    await run_app(
        host=args.host,
        web_port=args.port,
        glasses_port=args.glasses_port,
        open_browser=not args.no_browser,
    )
    return 0


async def cmd_dev(args) -> int:
    """Serve the panel and rerun the app whenever a watched file changes."""
    from .devserver import run_dev

    await run_dev(args.app, watch=args.watch, host=args.host, port=args.port)
    return 0


async def cmd_render(args) -> int:
    """Render one screen to a PNG without any session at all."""
    async with SimulatedG1() as sim:
        text = args.text or "openg1 simulator"
        await sim.g1.display.text(text)
        data = sim.panel.frame.to_png(scale=args.scale)
        with open(args.out, "wb") as handle:
            handle.write(data)
        report = sim.report()
        print(f"wrote {args.out} ({len(data)} bytes, {report.lit_pixels} pixels lit)")
        if report.truncated_lines:
            print(f"warning: {report.truncated_lines} line(s) did not fit on the panel")
        for line in report.overflow:
            print(f"warning: line overflows the panel: {line!r}")
    return 0


def cmd_font(args) -> int:
    from . import font

    print(font.sheet())
    return 0


def _quiet_broken_pipe() -> None:
    """Let ``| head`` close the pipe without a traceback.

    A command that prints a page of glyphs will be piped into ``head`` sooner
    or later, and Python's default behaviour there is an ugly stack trace on
    exit rather than a clean stop.
    """
    try:
        sys.stdout.flush()
    except BrokenPipeError:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="openg1sim",
        description="A visual simulator for Even Realities G1 smart glasses.",
    )
    parser.add_argument("--version", action="version", version=f"openg1sim {__version__}")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("demo", help="a scripted tour in the terminal")

    term = sub.add_parser("term", help="live terminal viewer with keyboard control")
    term.add_argument("--no-colour", action="store_true", help="plain output")

    web = sub.add_parser("web", help="browser viewer with clickable controls")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8765)

    render = sub.add_parser("render", help="render one screen to a PNG")
    render.add_argument("text", nargs="?", help="text to display")
    render.add_argument("-o", "--out", default="panel.png")
    render.add_argument("-s", "--scale", type=int, default=2)

    gui = sub.add_parser(
        "gui", help="the simulator window: panel, input buttons, log"
    )
    gui.add_argument("--host", default="127.0.0.1")
    gui.add_argument("--glasses-port", type=int, default=8766,
                     help="where your program connects")

    app = sub.add_parser(
        "app", help="the standalone simulator: run it, then point your program at it"
    )
    app.add_argument("--host", default="127.0.0.1")
    app.add_argument("--port", type=int, default=8765, help="the browser panel")
    app.add_argument("--glasses-port", type=int, default=8766,
                     help="where your program connects")
    app.add_argument("--no-browser", action="store_true",
                     help="do not open a browser window on start")

    dev = sub.add_parser(
        "dev", help="browser viewer that reruns your app every time you save"
    )
    dev.add_argument("app", help="a .py file defining `async def main(g1)`")
    dev.add_argument(
        "--watch", action="append", default=[],
        help="extra file or directory to watch; repeatable. "
             "Defaults to the folder the app lives in.",
    )
    dev.add_argument("--host", default="127.0.0.1")
    dev.add_argument("--port", type=int, default=8765)

    sub.add_parser("font", help="print the glyph table as ASCII art")

    args = parser.parse_args(argv)
    if args.command is None:
        # Bare `python3 -m openg1sim` opens the window. It is the thing people
        # want nine times out of ten, and a usage message is a poor greeting.
        args = parser.parse_args(["gui"])

    try:
        if args.command == "font":
            return cmd_font(args)
        if args.command == "gui":
            return cmd_gui(args)

        handlers = {
            "demo": cmd_demo,
            "term": cmd_term,
            "web": cmd_web,
            "app": cmd_app,
            "dev": cmd_dev,
            "render": cmd_render,
        }
        return asyncio.run(handlers[args.command](args))
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        return 0
    finally:
        _quiet_broken_pipe()


if __name__ == "__main__":
    sys.exit(main())
