"""The mini-app framework.

Two things carry weight here: that layout adapts to the device profile, so an
app written on the simulator is readable on the glasses; and that an app
releases its handlers, because one that does not poisons whatever runs next.
"""

from __future__ import annotations

import asyncio

import pytest

from openg1 import profile as profile_mod
from openg1.app import PANEL_LINES, App, Launcher, Screen
from openg1.profile import DeviceProfile
from openg1sim import SimulatedG1


class Recorder(App):
    name = "recorder"

    def __init__(self) -> None:
        super().__init__()
        self.events: list[str] = []
        self.started = self.stopped = 0

    async def start(self) -> None:
        self.started += 1
        await self.screen.show("started")

    async def stop(self) -> None:
        self.stopped += 1

    async def on_tap(self, event) -> None:
        self.events.append(event.gesture)


class Boom(App):
    name = "boom"

    async def on_tap(self, event) -> None:
        raise RuntimeError("handler exploded")


class TestScreenAdaptsToTheDevice:
    def teardown_method(self):
        profile_mod.use(None)

    def test_no_padding_when_nothing_is_hidden(self):
        profile_mod.use(DeviceProfile())
        screen = Screen(g1=None)
        assert screen.hidden_lines == 0
        assert screen.lines == PANEL_LINES

    def test_padding_covers_the_hidden_rows(self):
        profile_mod.use(DeviceProfile(hidden_top=23))
        screen = Screen(g1=None)
        assert screen.hidden_lines == 1

    def test_a_partial_line_still_costs_a_whole_line(self):
        """Rows 0-3 hidden still means line one is unreadable."""
        profile_mod.use(DeviceProfile(hidden_top=4))
        assert Screen(g1=None).hidden_lines == 1

    def test_usable_lines_shrink_with_the_visible_band(self):
        profile_mod.use(DeviceProfile(hidden_top=23))
        assert Screen(g1=None).lines < PANEL_LINES

    def test_never_reports_zero_lines(self):
        profile_mod.use(DeviceProfile(hidden_top=100, hidden_bottom=20))
        assert Screen(g1=None).lines >= 1


class TestLifecycle:
    def setup_method(self):
        profile_mod.use(DeviceProfile(hidden_top=23))

    def teardown_method(self):
        profile_mod.use(None)

    @pytest.mark.asyncio
    async def test_start_draws_inside_the_visible_band(self):
        async with SimulatedG1(strict=True) as sim:
            app = Recorder()
            await app._attach(sim.g1)
            assert app.started == 1
            assert "started" in sim.emulator.left.screen_text
            assert sim.check_parity() == []
            await app._detach()

    @pytest.mark.asyncio
    async def test_detach_unbinds_handlers(self):
        async with SimulatedG1() as sim:
            app = Recorder()
            await app._attach(sim.g1)
            await sim.tap()
            await asyncio.sleep(0.15)
            assert app.events == ["single_tap"]

            await app._detach()
            await sim.tap()
            await asyncio.sleep(0.15)
            assert app.events == ["single_tap"]  # nothing new
            assert app.stopped == 1

    @pytest.mark.asyncio
    async def test_a_failing_handler_does_not_kill_the_session(self):
        async with SimulatedG1() as sim:
            app = Boom()
            await app._attach(sim.g1)
            await sim.tap()
            await asyncio.sleep(0.15)
            # still usable
            await sim.g1.display.text("alive")
            assert "alive" in sim.emulator.left.screen_text
            await app._detach()

    @pytest.mark.asyncio
    async def test_ticker_runs_and_is_cancelled(self):
        class Ticking(App):
            name = "ticking"
            interval = 0.05

            def __init__(self):
                super().__init__()
                self.ticks = 0

            async def tick(self):
                self.ticks += 1

        async with SimulatedG1() as sim:
            app = Ticking()
            await app._attach(sim.g1)
            await asyncio.sleep(0.2)
            assert app.ticks >= 2
            await app._detach()
            settled = app.ticks
            await asyncio.sleep(0.15)
            assert app.ticks == settled  # the task really stopped


class TestLauncher:
    def teardown_method(self):
        profile_mod.use(None)

    class Tap:
        def __init__(self, gesture):
            self.gesture = gesture

    @pytest.mark.asyncio
    async def test_triple_tap_switches(self):
        first, second = Recorder(), Recorder()
        second.name = "second"
        async with SimulatedG1() as sim:
            launcher = Launcher([first, second])
            await launcher._attach(sim.g1)
            assert launcher.current is first
            await launcher.on_tap(self.Tap("triple_tap"))
            assert launcher.current is second
            await launcher._detach()

    @pytest.mark.asyncio
    async def test_switching_stops_the_outgoing_app(self):
        first, second = Recorder(), Recorder()
        async with SimulatedG1() as sim:
            launcher = Launcher([first, second])
            await launcher._attach(sim.g1)
            await launcher.on_tap(self.Tap("triple_tap"))
            assert first.stopped == 1 and second.started == 1
            await launcher._detach()

    @pytest.mark.asyncio
    async def test_other_gestures_reach_the_open_app(self):
        app = Recorder()
        async with SimulatedG1() as sim:
            launcher = Launcher([app])
            await launcher._attach(sim.g1)
            await launcher.on_tap(self.Tap("double_tap"))
            assert app.events == ["double_tap"]
            await launcher._detach()

    @pytest.mark.asyncio
    async def test_it_wraps_around(self):
        apps = [Recorder(), Recorder(), Recorder()]
        async with SimulatedG1() as sim:
            launcher = Launcher(apps)
            await launcher._attach(sim.g1)
            for _ in range(3):
                await launcher.on_tap(self.Tap("triple_tap"))
            assert launcher.current is apps[0]
            await launcher._detach()

    def test_an_empty_launcher_is_rejected(self):
        with pytest.raises(ValueError):
            Launcher([])


class TestBundledApps:
    """The shipped examples must survive their own profile."""

    def setup_method(self):
        profile_mod.use(DeviceProfile(hidden_top=23))

    def teardown_method(self):
        profile_mod.use(None)

    def _load(self, filename: str):
        import importlib.util
        import pathlib

        path = (
            pathlib.Path(__file__).resolve().parents[1] / "examples" / "apps" / filename
        )
        source = path.read_text().replace('if __name__ == "__main__":', "if False:")
        spec = importlib.util.spec_from_file_location(path.stem, path)
        module = importlib.util.module_from_spec(spec)
        exec(compile(source, str(path), "exec"), module.__dict__)
        return module

    @pytest.mark.asyncio
    async def test_clock_renders_within_the_safe_area(self):
        module = self._load("clock.py")
        async with SimulatedG1(strict=True) as sim:
            app = module.Clock()
            await app._attach(sim.g1)
            assert sim.check_parity() == []
            await app._detach()

    @pytest.mark.asyncio
    async def test_timer_renders_and_responds(self):
        module = self._load("timer.py")
        async with SimulatedG1(strict=True) as sim:
            app = module.Timer()
            await app._attach(sim.g1)
            assert "25:00" in sim.emulator.left.screen_text
            await app.on_tap(TestLauncher.Tap("single_tap"))
            assert app.running
            assert sim.check_parity() == []
            await app._detach()

    @pytest.mark.asyncio
    async def test_teleprompter_chunks_to_the_visible_lines(self):
        module = self._load("teleprompter.py")
        async with SimulatedG1(strict=True) as sim:
            app = module.Teleprompter()
            await app._attach(sim.g1)
            assert len(app.chunks) > 1
            for chunk in app.chunks:
                assert len(chunk.splitlines()) <= app.screen.lines
            assert sim.check_parity() == []
            await app._detach()
