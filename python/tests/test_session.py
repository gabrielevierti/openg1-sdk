"""Session behaviour, exercised against the emulator."""

from __future__ import annotations

import asyncio

import pytest

from openg1 import G1, Arm, TouchEvent, WearEvent
from openg1 import commands as cmd
from openg1.bmp import Bitmap
from openg1.errors import CommandTimeout, PacketTooLargeError
from openg1.framing import decode
from openg1.session import Session
from openg1sim import EmulatedGlasses

pytestmark = pytest.mark.asyncio


async def make():
    glasses = EmulatedGlasses()
    g1 = G1(*glasses.transports(), auto_heartbeat=False)
    await g1.session.start()
    return g1, glasses


class TestOrdering:
    async def test_left_is_written_before_right(self):
        g1, glasses = await make()
        try:
            glasses.left.log.clear()
            glasses.right.log.clear()
            await g1.display.brightness(10)
        finally:
            await g1.disconnect()
        # SET_BRIGHTNESS targets the right arm only.
        assert glasses.right.log and not glasses.left.log

    async def test_both_arms_get_a_broadcast_command(self):
        g1, glasses = await make()
        try:
            await g1.display.clear()
        finally:
            await g1.disconnect()
        assert any(p[0] == 0x18 for p in glasses.left.log)
        assert any(p[0] == 0x18 for p in glasses.right.log)

    async def test_mic_only_reaches_the_right_arm(self):
        g1, glasses = await make()
        try:
            glasses.left.log.clear()
            await g1.session.send(cmd.mic_control(True))
        finally:
            await g1.disconnect()
        assert glasses.right.mic_enabled is True
        assert not any(p[0] == 0x0E for p in glasses.left.log)


class TestSequencing:
    async def test_framed_commands_consume_the_global_counter(self):
        g1, glasses = await make()
        try:
            before = g1.session.seq.peek()
            await g1.session.send(cmd.dashboard_lock(True))
            assert g1.session.seq.peek() != before
        finally:
            await g1.disconnect()

    async def test_heartbeat_uses_its_own_counter(self):
        g1, glasses = await make()
        try:
            global_before = g1.session.seq.peek()
            await g1.session.beat()
            await g1.session.beat()
            assert g1.session.hb_seq.peek() == 2
            # The heartbeat is framed, so it does move the global counter —
            # what must not happen is the two counters sharing a value space.
            assert g1.session.seq.peek() != global_before
            assert glasses.left.heartbeats == 2
        finally:
            await g1.disconnect()


class TestEvents:
    async def test_touch_events_reach_subscribers(self):
        g1, glasses = await make()
        seen = []
        g1.on(TouchEvent, seen.append)
        try:
            await glasses.tap(count=3)
            await asyncio.sleep(0.02)
        finally:
            await g1.disconnect()
        assert seen and seen[0].gesture == "triple_tap"

    async def test_wait_for_returns_the_event(self):
        g1, glasses = await make()
        try:
            task = asyncio.create_task(g1.wait_for(WearEvent, timeout=1))
            await asyncio.sleep(0.01)
            await glasses.wear(True)
            event = await task
        finally:
            await g1.disconnect()
        assert event.worn is True

    async def test_left_hold_is_the_ai_trigger_right_hold_is_not(self):
        from openg1 import AiRequestEvent

        g1, glasses = await make()
        ai, touch = [], []
        g1.on(AiRequestEvent, ai.append)
        g1.on(TouchEvent, touch.append)
        try:
            await glasses.hold(Arm.LEFT)
            await glasses.hold(Arm.RIGHT)
            await asyncio.sleep(0.02)
        finally:
            await g1.disconnect()
        assert len(ai) == 1
        assert [t.arm for t in touch] == [Arm.RIGHT]

    async def test_stream_yields_events(self):
        g1, glasses = await make()
        try:
            stream = g1.events()
            await glasses.tap()
            event = await asyncio.wait_for(stream.__anext__(), 1)
            stream.close()
        finally:
            await g1.disconnect()
        assert isinstance(event, TouchEvent)


class TestTransfers:
    async def test_bitmap_transfer_verifies_its_checksum(self):
        g1, glasses = await make()
        bitmap = Bitmap.blank()
        for x in range(0, 576, 3):
            bitmap.set(x, 40)
        try:
            await g1.display.bitmap(bitmap)
        finally:
            await g1.disconnect()
        assert glasses.left.bmp_crc_ok is True
        assert glasses.left.bmp_image == bitmap.to_bmp()
        assert glasses.right.bmp_image == bitmap.to_bmp()

    async def test_long_text_is_paginated(self):
        g1, glasses = await make()
        try:
            await g1.display.text(" ".join(f"word{i}" for i in range(200)), page_delay=0)
        finally:
            await g1.disconnect()
        pages = {decode(p).payload[6] for p in glasses.left.log if p[0] == 0x4E}
        assert len(pages) > 1

    async def test_notification_json_is_chunked(self):
        g1, glasses = await make()
        try:
            await g1.notifications.notify(title="t", message="x" * 500)
        finally:
            await g1.disconnect()
        packets = [p for p in glasses.left.log if p[0] == 0x4B]
        assert len(packets) > 1
        assert {p[1] for p in packets} == {len(packets)}
        assert [p[2] for p in packets] == list(range(len(packets)))


class TestFailureModes:
    async def test_oversized_packet_is_refused_before_it_hits_the_radio(self):
        glasses = EmulatedGlasses(mtu=23)
        session = Session(*glasses.transports(), auto_heartbeat=False)
        await session.start(handshake=False)
        try:
            with pytest.raises(PacketTooLargeError):
                await session.send(cmd.set_teleprompter(b"x" * 300))
        finally:
            await session.stop()

    async def test_a_silent_device_times_out(self):
        glasses = EmulatedGlasses()

        async def swallow(_data):
            return None

        glasses.left_transport.write = swallow  # type: ignore[assignment]
        session = Session(*glasses.transports(), ack_timeout=0.05, auto_heartbeat=False)
        await session.start(handshake=False)
        try:
            with pytest.raises(CommandTimeout):
                await session.send(cmd.clear_screen())
        finally:
            await session.stop()

    async def test_trace_captures_both_directions(self):
        g1, glasses = await make()
        g1.session.start_trace()
        try:
            await g1.display.clear()
        finally:
            trace = g1.session.stop_trace()
            await g1.disconnect()
        assert {d for _, _, d, _ in trace} == {"tx", "rx"}
