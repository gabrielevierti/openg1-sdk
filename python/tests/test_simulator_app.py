"""The simulator as a separate process.

The property under test is that nothing above the transport can tell the
difference. If an app has to know it is talking to a simulator, the simulator
has failed at its job, because then the code you debug is not the code you
ship.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from openg1 import G1
from openg1._generated import Arm
from openg1.transport.net import (
    DEFAULT_PORT,
    HELLO_SIZE,
    MAGIC,
    NetTransport,
    SimulatorUnavailable,
    env_target,
)
from openg1sim import SimulatedG1
from openg1sim.appserver import AppServer, GlassesEndpoint


async def start_simulator(port: int = 0):
    """A running simulator on an arbitrary free port."""
    sim = SimulatedG1(attach_local_g1=False)
    await sim.__aenter__()
    endpoint = GlassesEndpoint(sim, port=port)
    server = await endpoint.serve()
    actual = server.sockets[0].getsockname()[1]
    endpoint.port = actual
    return sim, endpoint, server


async def stop_simulator(sim, endpoint, server) -> None:
    endpoint.close()
    server.close()
    await server.wait_closed()
    await sim.__aexit__(None, None, None)


class TestEnvTarget:
    def test_unset_is_none(self, monkeypatch=None):
        os.environ.pop("OPENG1_SIMULATOR", None)
        assert env_target() is None

    def test_off_switches_are_none(self):
        for value in ("0", "off", "false", "no", ""):
            os.environ["OPENG1_SIMULATOR"] = value
            assert env_target() is None
        os.environ.pop("OPENG1_SIMULATOR", None)

    def test_on_gives_the_default(self):
        os.environ["OPENG1_SIMULATOR"] = "1"
        assert env_target() == ("127.0.0.1", DEFAULT_PORT)
        os.environ.pop("OPENG1_SIMULATOR", None)

    def test_host_and_port(self):
        os.environ["OPENG1_SIMULATOR"] = "10.0.0.5:9999"
        assert env_target() == ("10.0.0.5", 9999)
        os.environ.pop("OPENG1_SIMULATOR", None)

    def test_nonsense_is_rejected_with_a_useful_message(self):
        from openg1.errors import OpenG1Error

        os.environ["OPENG1_SIMULATOR"] = "not:a:port"
        try:
            with pytest.raises(OpenG1Error):
                env_target()
        finally:
            os.environ.pop("OPENG1_SIMULATOR", None)


class TestUnavailable:
    @pytest.mark.asyncio
    async def test_connecting_to_nothing_names_the_fix(self):
        transport = NetTransport(Arm.LEFT, port=1)
        with pytest.raises(SimulatorUnavailable) as exc:
            await transport.connect()
        assert "openg1sim app" in str(exc.value)


class TestSeparateProcess:
    @pytest.mark.asyncio
    async def test_a_session_runs_over_the_socket(self):
        sim, endpoint, server = await start_simulator()
        try:
            g1 = await G1.connect_simulator(port=endpoint.port)
            async with g1:
                await g1.display.text("over the wire")
            assert sim.emulator.left.screen_text == "over the wire"
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_queries_get_real_replies(self):
        sim, endpoint, server = await start_simulator()
        try:
            g1 = await G1.connect_simulator(port=endpoint.port)
            async with g1:
                battery = await g1.info.battery()
            assert battery.left == 87 and battery.right == 87
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_a_bitmap_survives_the_stream_framing(self):
        """9854 bytes in 51 packets: the case where TCP coalescing would show."""
        from openg1.bmp import Bitmap

        sim, endpoint, server = await start_simulator()
        try:
            g1 = await G1.connect_simulator(port=endpoint.port)
            async with g1:
                result = await g1.display.bitmap(Bitmap.blank())
            assert result.ok
            assert len(sim.emulator.left.bmp_image) == 9854
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_wearer_input_reaches_the_app(self):
        sim, endpoint, server = await start_simulator()
        seen = []
        try:
            from openg1 import TouchEvent

            g1 = await G1.connect_simulator(port=endpoint.port)
            async with g1:
                g1.on(TouchEvent, lambda e: seen.append(e.gesture))
                await asyncio.sleep(0.05)
                await sim.tap(Arm.RIGHT, 2)
                await asyncio.sleep(0.2)
            assert "double_tap" in seen
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_the_simulator_outlives_the_app(self):
        """The whole point: restart your program, keep the window."""
        sim, endpoint, server = await start_simulator()
        try:
            for message in ("first run", "second run"):
                g1 = await G1.connect_simulator(port=endpoint.port)
                async with g1:
                    await g1.display.text(message)
                assert sim.emulator.left.screen_text == message
            assert endpoint.connections == 4  # two arms, twice
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_attached_needs_both_arms(self):
        sim, endpoint, server = await start_simulator()
        try:
            assert not endpoint.attached
            left = NetTransport(Arm.LEFT, port=endpoint.port)
            await left.connect()
            await asyncio.sleep(0.1)
            assert not endpoint.attached  # one arm is not a usable pair
            right = NetTransport(Arm.RIGHT, port=endpoint.port)
            await right.connect()
            await asyncio.sleep(0.1)
            assert endpoint.attached
            await left.disconnect()
            await right.disconnect()
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_garbage_is_dropped_without_taking_the_server_down(self):
        sim, endpoint, server = await start_simulator()
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", endpoint.port)
            writer.write(b"GET / HTTP/1.1\r\n\r\n")
            await writer.drain()
            await asyncio.sleep(0.2)
            writer.close()

            # Still serving.
            g1 = await G1.connect_simulator(port=endpoint.port)
            async with g1:
                await g1.display.text("still here")
            assert sim.emulator.left.screen_text == "still here"
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_hello_size_matches_what_the_client_sends(self):
        assert HELLO_SIZE == len(MAGIC) + 4


class TestAppModeGuards:
    @pytest.mark.asyncio
    async def test_browser_display_controls_are_refused_while_attached(self):
        """Two writers on one panel has no hardware equivalent."""
        sim, endpoint, server = await start_simulator()
        try:
            app = AppServer(glasses=endpoint, sim=sim, port=0)
            messages: list[str] = []
            app.log = messages.append
            await app._command("text", {}, b"hello")
            assert any("owns the display" in m for m in messages)
        finally:
            await stop_simulator(sim, endpoint, server)

    @pytest.mark.asyncio
    async def test_wearer_controls_still_work_while_attached(self):
        sim, endpoint, server = await start_simulator()
        try:
            app = AppServer(glasses=endpoint, sim=sim, port=0)
            await app._command("wear", {"worn": ["0"]}, b"")
            assert sim.left_state.worn is False
        finally:
            await stop_simulator(sim, endpoint, server)
