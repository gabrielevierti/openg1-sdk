"""Live-reload development server.

    python3 -m openg1sim dev myapp.py

Watches ``myapp.py`` (and anything else you point it at), and every time you
save, tears the app down and runs it again against a fresh panel. The browser
page stays open across reloads, so you keep your scroll position, your event
log and your place in the world — the only thing that restarts is your code.

An app is a module exposing ``async def main(g1)``::

    async def main(g1):
        await g1.display.text("ciao")

``g1`` is an ordinary :class:`openg1.G1`. The same file runs on hardware with a
three-line ``__main__`` block, which is the point: the simulator is where you
iterate, not a thing you have to port away from.

Why reimport rather than reload
-------------------------------
Reloading a module in place leaves the old module object alive wherever
anything captured a reference, so half your app is new and half is stale and
the bug you spend an hour on is not in your code. This throws the module away
and imports it fresh under a new name every time. It costs a few milliseconds
and it means a green run actually means something.
"""

from __future__ import annotations

import asyncio
import importlib.util
import itertools
import pathlib
import sys
import time
import traceback

from .device import SimulatedG1
from .web import SimulatorServer

POLL_INTERVAL = 0.25


class ReloadError(Exception):
    """The app failed to import or run. Reported, never fatal."""


def _iter_watched(paths: list[pathlib.Path]):
    """Every file we care about, expanding directories to their .py files."""
    for path in paths:
        if path.is_dir():
            yield from sorted(path.rglob("*.py"))
        elif path.exists():
            yield path


def _fingerprint(paths: list[pathlib.Path]) -> dict[pathlib.Path, tuple[float, int]]:
    """(mtime, size) per file.

    Size is in there because mtime alone has coarse granularity on some
    filesystems: save twice inside one tick and the second save is invisible,
    which reads as "the dev server is ignoring me" at exactly the moment you
    are iterating fastest.
    """
    return {p: (p.stat().st_mtime, p.stat().st_size) for p in _iter_watched(paths)}


class DevServer(SimulatorServer):
    """The web simulator, plus a file watcher and an app slot."""

    def __init__(self, app_path: pathlib.Path, watch: list[pathlib.Path], **kw) -> None:
        self.app_path = app_path.resolve()
        self.watch = watch or [self.app_path]
        self._counter = itertools.count(1)
        self._task: asyncio.Task | None = None
        self.reloads = 0
        self.last_error: str | None = None
        super().__init__(**kw)

    # -- running the app ---------------------------------------------------

    def _import_app(self):
        """Import the app file fresh, under a name nothing else will reuse."""
        name = f"og1sim_app_{next(self._counter)}"
        spec = importlib.util.spec_from_file_location(name, self.app_path)
        if spec is None or spec.loader is None:
            raise ReloadError(f"cannot import {self.app_path}")
        module = importlib.util.module_from_spec(spec)
        # Registered so dataclasses, pickle and tracebacks can find it, then
        # dropped again below — we never want two generations resident.
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(name, None)
        entry = getattr(module, "main", None)
        if entry is None:
            raise ReloadError(
                f"{self.app_path.name} defines no main(); the dev server needs "
                f"`async def main(g1):` as the entry point"
            )
        return entry

    async def _run_app(self) -> None:
        try:
            entry = self._import_app()
        except ReloadError as exc:
            return self._fail(str(exc))
        except Exception:
            return self._fail(traceback.format_exc())

        try:
            result = entry(self.sim.g1)
            if asyncio.iscoroutine(result):
                await result
            self.log(f"{self.app_path.name} finished")
            self._push("status", {"state": "idle", "reloads": self.reloads})
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(traceback.format_exc())

    def _fail(self, message: str) -> None:
        self.last_error = message
        for line in message.rstrip().splitlines():
            self.log(line)
        self._push("status", {"state": "error", "reloads": self.reloads})

    async def reload(self, reason: str = "changed") -> None:
        """Stop whatever is running and start the app again."""
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

        self.reloads += 1
        self.last_error = None
        await self.sim.g1.display.clear()
        self.sim.reset()
        self.log(f"--- reload #{self.reloads} ({reason}) ---")
        self._push("status", {"state": "running", "reloads": self.reloads})
        self._task = asyncio.create_task(self._run_app())

    # -- watching ----------------------------------------------------------

    async def watch_files(self, previous=None) -> None:
        """Poll for changes. Polling beats inotify here: it is thirty lines
        instead of a dependency and a per-platform backend, and a
        quarter-second delay is invisible next to the time it takes to look
        up at the panel.

        ``previous`` lets the caller snapshot *before* the first run, so an
        edit made while the app is starting is not swallowed.
        """
        previous = _fingerprint(self.watch) if previous is None else previous
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                current = _fingerprint(self.watch)
            except OSError:
                continue  # a file mid-write; try again next tick
            if current != previous:
                changed = [
                    p.name
                    for p in set(current) | set(previous)
                    if current.get(p) != previous.get(p)
                ]
                previous = current
                await self.reload(", ".join(sorted(changed)[:3]))

    # -- control endpoints -------------------------------------------------

    async def _command(self, name: str, params: dict, body: bytes) -> None:
        if name == "reload":
            return await self.reload("manual")
        return await super()._command(name, params, body)

    async def serve(self) -> None:
        # Snapshot first: a save during the initial run must still count.
        baseline = _fingerprint(self.watch)
        await self.reload("start")
        watcher = asyncio.create_task(self.watch_files(baseline))
        try:
            await super().serve()
        finally:
            watcher.cancel()
            if self._task is not None:
                self._task.cancel()


async def run_dev(
    app: str,
    *,
    watch: list[str] | None = None,
    host: str = "127.0.0.1",
    port: int = 8765,
) -> None:
    path = pathlib.Path(app)
    if not path.exists():
        raise SystemExit(f"no such file: {app}")

    extra = [pathlib.Path(w) for w in (watch or [])]
    # An app almost always imports its own neighbours, so watch the folder it
    # lives in unless told otherwise. Watching one file and then wondering why
    # editing the helper next to it does nothing is a bad first hour.
    watched = extra or [path.parent if path.parent != pathlib.Path("") else path]

    # The app's own directory on sys.path, so `import helpers` works the way
    # it would if you ran the file directly.
    sys.path.insert(0, str(path.resolve().parent))

    async with SimulatedG1() as sim:
        server = DevServer(path, watched, sim=sim, host=host, port=port)
        print(f"watching {', '.join(str(w) for w in watched)}")
        await server.serve()
