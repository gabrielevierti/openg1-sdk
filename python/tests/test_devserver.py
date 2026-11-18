"""The dev server: reload correctness, and failing safely.

The property that matters is that a reload is a *clean* one. Reloading a
module in place leaves stale references alive and produces bugs that look
like they are in your code, so these check that a second generation really
does replace the first rather than layering on top of it.

The other property is that nothing your app does can take the server down.
A traceback in an app is the normal case during development, not an error
condition for the tool.
"""

from __future__ import annotations

import asyncio
import pathlib
import tempfile

import pytest

from openg1sim import SimulatedG1
from openg1sim.devserver import DevServer, _fingerprint, _iter_watched


def write_app(path: pathlib.Path, body: str) -> None:
    path.write_text(body)


TEXT_APP = "async def main(g1):\n    await g1.display.text({!r})\n"


class TestWatching:
    def test_directory_expands_to_py_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "a.py").write_text("")
            (root / "b.py").write_text("")
            (root / "notes.txt").write_text("")
            found = {p.name for p in _iter_watched([root])}
        assert found == {"a.py", "b.py"}

    def test_missing_paths_are_skipped_not_fatal(self):
        assert list(_iter_watched([pathlib.Path("/nope/never.py")])) == []

    def test_fingerprint_includes_size(self):
        """mtime granularity is coarse; two saves in one tick must differ."""
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "a.py"
            path.write_text("x = 1")
            first = _fingerprint([path])
            path.write_text("x = 22222")  # same tick, different size
            assert _fingerprint([path]) != first


class TestReload:
    @pytest.mark.asyncio
    async def test_runs_the_app_on_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, TEXT_APP.format("first"))
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.1)
                assert sim.emulator.left.screen_text == "first"
                assert server.reloads == 1

    @pytest.mark.asyncio
    async def test_second_generation_replaces_the_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, TEXT_APP.format("first"))
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.1)

                write_app(app, TEXT_APP.format("second"))
                await server.reload("test")
                await asyncio.sleep(0.1)
                assert sim.emulator.left.screen_text == "second"
                assert server.reloads == 2

    @pytest.mark.asyncio
    async def test_reload_clears_the_panel_first(self):
        """Otherwise the previous run's pixels linger under the new ones."""
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, "async def main(g1):\n    pass\n")
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await sim.g1.display.text("left over from before")
                assert sim.report().lit_pixels > 0
                await server.reload("test")
                await asyncio.sleep(0.1)
                assert sim.report().lit_pixels == 0

    @pytest.mark.asyncio
    async def test_module_is_not_left_in_sys_modules(self):
        import sys

        before = set(sys.modules)
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, TEXT_APP.format("x"))
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.1)
        leaked = {n for n in set(sys.modules) - before if n.startswith("og1sim_app_")}
        assert not leaked


class TestFailingApps:
    @pytest.mark.asyncio
    async def test_syntax_error_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, "def main(g1)\n")  # missing colon
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.1)
                assert server.last_error and "SyntaxError" in server.last_error

    @pytest.mark.asyncio
    async def test_runtime_error_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, "async def main(g1):\n    raise ValueError('boom')\n")
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.2)
                assert server.last_error and "boom" in server.last_error

    @pytest.mark.asyncio
    async def test_missing_main_says_so_clearly(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, "x = 1\n")
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.1)
                assert "main()" in (server.last_error or "")

    @pytest.mark.asyncio
    async def test_a_broken_app_can_be_fixed_without_restarting(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(app, "async def main(g1):\n    raise ValueError('boom')\n")
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.2)
                assert server.last_error

                write_app(app, TEXT_APP.format("fixed"))
                await server.reload("test")
                await asyncio.sleep(0.2)
                assert server.last_error is None
                assert sim.emulator.left.screen_text == "fixed"

    @pytest.mark.asyncio
    async def test_a_long_running_app_is_cancelled_on_reload(self):
        """An app that never returns must not block the next generation."""
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / "app.py"
            write_app(
                app,
                "import asyncio\n"
                "async def main(g1):\n"
                "    await g1.display.text('running')\n"
                "    await asyncio.sleep(3600)\n",
            )
            async with SimulatedG1() as sim:
                server = DevServer(app, [app], sim=sim)
                await server.reload("test")
                await asyncio.sleep(0.15)
                assert sim.emulator.left.screen_text == "running"

                write_app(app, TEXT_APP.format("next"))
                await asyncio.wait_for(server.reload("test"), timeout=3)
                await asyncio.sleep(0.15)
                assert sim.emulator.left.screen_text == "next"


class TestEmulatorMoved:
    """`G1.virtual()` is gone; the simulator is the only fake device."""

    def test_g1_has_no_virtual_constructor(self):
        from openg1 import G1

        assert not hasattr(G1, "virtual")

    def test_og1_does_not_export_the_emulator(self):
        import openg1

        for name in ("VirtualG1", "MockTransport"):
            with pytest.raises(AttributeError):
                getattr(openg1, name)

    def test_emulator_lives_in_og1sim(self):
        from openg1sim import EmulatedGlasses, MockTransport  # noqa: F401

    def test_simulated_g1_passes_session_kwargs_through(self):
        sim = SimulatedG1(auto_heartbeat=False)
        assert sim._session_kw == {"auto_heartbeat": False}
