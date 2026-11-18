"""The simulator window.

Tk is not importable on every machine and never inside CI, so these test the
engine directly and the window against a stub. That split is the reason
:mod:`openg1sim.controller` exists: all the logic that can be wrong lives on the
testable side of it, and the Tk module is thin enough to read.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
import types

import pytest

from openg1 import G1
from openg1sim.controller import SimulatorController, Status


def run_client(port: int, message: str = "hello") -> None:
    """Connect from another thread, as a real app in another process would."""

    def go() -> None:
        async def main() -> None:
            async with await G1.connect_simulator(port=port) as g1:
                await g1.display.text(message)
                await asyncio.sleep(0.15)

        asyncio.run(main())

    thread = threading.Thread(target=go)
    thread.start()
    thread.join()
    time.sleep(0.25)


class TestController:
    def test_starts_and_stops(self):
        controller = SimulatorController(glasses_port=0)
        controller.start()
        try:
            assert controller.status().listening
            assert controller.status().port != 0
        finally:
            controller.stop()

    def test_starting_twice_is_an_error(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            with pytest.raises(RuntimeError):
                controller.start()
        finally:
            controller.stop()

    def test_take_frame_returns_none_when_nothing_changed(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            assert controller.take_frame() is not None  # initial render
            assert controller.take_frame() is None
        finally:
            controller.stop()

    def test_a_client_changes_the_frame(self):
        controller = SimulatorController(glasses_port=0)
        controller.start()
        try:
            controller.take_frame()
            run_client(controller.status().port, "over the wire")
            assert controller.take_frame() is not None
            assert controller.sim.emulator.left.screen_text == "over the wire"
        finally:
            controller.stop()

    def test_wearer_input_crosses_the_thread_boundary(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            controller.wear(False)
            time.sleep(0.3)
            assert controller.status().worn is False
        finally:
            controller.stop()

    def test_submit_after_stop_does_not_raise(self):
        """Clicking a button as the window closes is a normal race."""
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        sim = controller.sim
        controller.stop()
        assert controller.submit(sim.tap()) is None

    def test_log_drains_once(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            controller.note("first")
            assert "first" in controller.drain_log()
            assert controller.drain_log() == []
        finally:
            controller.stop()

    def test_status_before_start_carries_no_simulator(self):
        assert SimulatorController().status() == Status()

    def test_overflow_is_reported(self):
        controller = SimulatorController(glasses_port=0)
        controller.start()
        try:
            port = controller.status().port

            def go() -> None:
                async def main() -> None:
                    async with await G1.connect_simulator(port=port) as g1:
                        await g1.display.text_page(
                            "word " * 160, page=1, max_page=1
                        )
                        await asyncio.sleep(0.15)

                asyncio.run(main())

            thread = threading.Thread(target=go)
            thread.start()
            thread.join()
            time.sleep(0.3)
            status = controller.status()
            assert not status.fits and status.truncated_lines > 0
        finally:
            controller.stop()


def install_stub_tk() -> None:
    """A Tk that records instead of drawing."""

    class Widget:
        def __init__(self, *a, **kw):
            self.kw = dict(kw)
            self.calls = []
            self.text_content = []

        def pack(self, *a, **kw):
            self.calls.append("pack")

        def configure(self, **kw):
            self.kw.update(kw)
            self.calls.append("configure")

        config = configure

        def create_image(self, *a, **kw):
            return 1

        def itemconfigure(self, *a, **kw):
            self.calls.append("itemconfigure")

        def insert(self, where, text):
            self.text_content.append(text)

        def delete(self, *a):
            self.text_content.clear()

        def index(self, spec):
            return f"{len(self.text_content) + 1}.0"

        def see(self, *a): ...
        def title(self, *a): ...
        def protocol(self, *a): ...
        def resizable(self, *a): ...
        def destroy(self): self.calls.append("destroy")
        def mainloop(self): ...
        def after(self, ms, fn): self.scheduled = fn

    class PhotoImage:
        def __init__(self, data=None, **kw):
            self.data = data

    module = types.ModuleType("tkinter")
    for name in ("Tk", "Frame", "Label", "Canvas", "Button", "LabelFrame", "Text"):
        setattr(module, name, Widget)
    module.PhotoImage = PhotoImage
    dialog = types.ModuleType("tkinter.filedialog")
    dialog.asksaveasfilename = lambda **kw: ""
    module.filedialog = dialog
    sys.modules["tkinter"] = module
    sys.modules["tkinter.ttk"] = types.ModuleType("tkinter.ttk")
    sys.modules["tkinter.filedialog"] = dialog


class TestWindow:
    def _window(self, controller):
        install_stub_tk()
        for name in [n for n in sys.modules if n.startswith("openg1sim.gui")]:
            del sys.modules[name]
        from openg1sim.gui import SimulatorWindow

        return SimulatorWindow(controller)

    def test_builds_and_draws(self):
        controller = SimulatorController(glasses_port=0)
        controller.start()
        try:
            window = self._window(controller)
            run_client(controller.status().port, "render me")
            window._tick()
            assert "itemconfigure" in window.canvas.calls
            assert window._photo.data
        finally:
            controller.stop()

    def test_tick_reschedules_itself_even_after_trouble(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            window = self._window(controller)
            window._draw_status = lambda: (_ for _ in ()).throw(RuntimeError("x"))
            with pytest.raises(RuntimeError):
                window._tick()
            assert window.root.scheduled is not None
        finally:
            controller.stop()

    def test_status_line_warns_when_text_does_not_fit(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            window = self._window(controller)
            controller.status = lambda: Status(fits=False, truncated_lines=3)
            window._draw_status()
            assert "3 line(s) cut off" in window.meta.kw["text"]
        finally:
            controller.stop()

    def test_waiting_state_names_the_port(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            window = self._window(controller)
            controller.status = lambda: Status(listening=True, port=8766)
            window._draw_status()
            assert "8766" in window.attach_label.kw["text"]
        finally:
            controller.stop()

    def test_log_is_trimmed_so_it_cannot_grow_forever(self):
        controller = SimulatorController(glasses_port=0, serve=False)
        controller.start()
        try:
            window = self._window(controller)
            for i in range(500):
                controller.note(f"line {i}")
            window._drain_log()
            assert len(window.log.text_content) < 500
        finally:
            controller.stop()
