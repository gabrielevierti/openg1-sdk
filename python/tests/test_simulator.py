"""Tests for the simulator.

These check the thing the byte-level tests cannot: that what reaches the panel
is the picture you meant. A packet log will happily tell you a 400-character
paragraph was delivered; only a renderer will tell you that four of its lines
fell off the bottom.
"""

from __future__ import annotations

import pytest

from openg1._generated import Arm
from openg1.bmp import Bitmap
from openg1sim import DISPLAY_HEIGHT, DISPLAY_WIDTH, Framebuffer, SimulatedG1
from openg1sim import font, panel as panel_mod


class TestFont:
    def test_every_glyph_is_five_columns(self):
        for char, columns in font.GLYPHS.items():
            assert len(columns) == 5, char
            for column in columns:
                assert 0 <= column <= 0xFF, char

    def test_missing_characters_render_as_a_box(self):
        # A hollow box, the same convention terminals use — a missing glyph
        # should look missing rather than looking like a space.
        assert font.glyph("\u5000") == font.MISSING
        assert font.glyph(" ") != font.MISSING

    def test_accents_sit_above_the_letter(self):
        plain = font.glyph("a")
        accented = font.glyph("à")
        assert accented != plain
        # The accent occupies row 0, which the bare letter never touches.
        assert any(column & 0x01 for column in accented)
        assert not any(column & 0x01 for column in plain)

    def test_italian_vowels_are_all_present(self):
        for char in "àèìòù":
            assert font.has_glyph(char), char

    def test_advance_matches_the_panel_arithmetic(self):
        # 40 columns of 12 pixels is 480, the most that fits the spec's 488
        # pixel text width — and close to what the firmware's proportional
        # font manages, which is the number that matters.
        assert font.advance(2) == 12
        assert font.text_width("x" * 40, 2) <= 488
        assert font.text_width("x" * 41, 2) > 488


class TestFramebuffer:
    def test_starts_blank(self):
        frame = Framebuffer()
        assert (frame.width, frame.height) == (DISPLAY_WIDTH, DISPLAY_HEIGHT)
        assert frame.lit() == 0

    def test_set_and_get(self):
        frame = Framebuffer(32, 8)
        frame.set(5, 3)
        assert frame.get(5, 3)
        assert not frame.get(6, 3)
        frame.set(5, 3, False)
        assert not frame.get(5, 3)

    def test_writes_outside_the_panel_are_dropped(self):
        frame = Framebuffer(16, 4)
        frame.set(-1, 0)
        frame.set(0, 99)
        frame.set(16, 0)
        assert frame.lit() == 0

    def test_fill_rect_is_clipped(self):
        frame = Framebuffer(16, 4)
        frame.fill_rect(-4, -4, 8, 8)
        assert frame.lit() == 16  # the 4x4 that actually landed on the panel

    def test_text_lights_pixels(self):
        frame = Framebuffer(200, 40)
        frame.draw_text("openg1", 0, 0)
        assert frame.lit() > 0

    def test_glyphs_scale_independently_in_each_axis(self):
        def extent(frame):
            xs = [x for y in range(frame.height) for x in range(frame.width) if frame.get(x, y)]
            ys = [y for y in range(frame.height) for x in range(frame.width) if frame.get(x, y)]
            return max(xs) + 1, max(ys) + 1

        wide = Framebuffer(200, 40)
        tall = Framebuffer(200, 40)
        wide.draw_text("m", 0, 0, 4, 2)
        tall.draw_text("m", 0, 0, 2, 4)

        assert wide.lit() == tall.lit()  # same glyph, same ink, different shape
        wide_w, wide_h = extent(wide)
        tall_w, tall_h = extent(tall)
        assert wide_w == tall_w * 2
        assert tall_h == wide_h * 2

    def test_png_has_a_valid_signature_and_scales(self):
        frame = Framebuffer(16, 8)
        frame.set(0, 0)
        small = frame.to_png(scale=1)
        large = frame.to_png(scale=4)
        assert small[:8] == b"\x89PNG\r\n\x1a\n"
        assert len(large) > len(small)

    def test_blit_bmp_round_trips_through_the_sdk_encoder(self):
        # The BMP the simulator draws is the same file the glasses receive,
        # so a polarity or row-order mistake shows up immediately here.
        source = Bitmap.blank(64, 16)
        source.set(0, 0)
        source.set(63, 15)
        source.set(10, 4)

        frame = Framebuffer(64, 16)
        frame.blit_bmp(source.to_bmp())

        assert frame.get(0, 0)
        assert frame.get(63, 15)
        assert frame.get(10, 4)
        assert frame.lit() == 3  # and nothing else got lit

    def test_blit_rejects_a_non_bitmap(self):
        with pytest.raises(ValueError):
            Framebuffer().blit_bmp(b"definitely not a bitmap")

    def test_blocks_render_two_rows_per_line(self):
        frame = Framebuffer(576, 136)
        text = frame.to_blocks()
        lines = text.splitlines()
        assert len(lines) == 136 // 4
        assert len(lines[0]) == 576 // 4


class TestPanelLayout:
    def test_capacity_matches_the_spec(self):
        # The protocol spec says five lines at the default font size, and the
        # firmware fits roughly forty characters across.
        board = panel_mod.Panel()
        assert board.rows() == 5
        assert board.columns() == 40

    def test_wrapping_keeps_every_word(self):
        board = panel_mod.Panel()
        source = "Genova to Milano is about 145 kilometres by road"
        lines = board.wrap(source)
        assert len(lines) > 1
        assert " ".join(lines) == source

    def test_a_word_longer_than_the_panel_is_broken(self):
        board = panel_mod.Panel()
        lines = board.wrap("x" * 100)
        assert len(lines) == 3
        assert all(len(line) <= board.columns() for line in lines)

    def test_newlines_start_a_new_line(self):
        board = panel_mod.Panel()
        assert board.wrap("Via Emilia\n2.4 km") == ["Via Emilia", "2.4 km"]


class TestSimulatedDevice:
    @pytest.mark.asyncio
    async def test_text_reaches_the_panel(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("ciao")
            assert sim.panel.frame.lit() > 0
            assert sim.report().lit_pixels > 0

    @pytest.mark.asyncio
    async def test_clearing_blanks_the_panel(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("ciao")
            assert sim.panel.frame.lit() > 0
            await sim.g1.display.clear()
            assert sim.panel.frame.lit() == 0

    @pytest.mark.asyncio
    async def test_a_single_overlong_screen_is_reported_as_truncated(self):
        # text_page pushes one screen with no pagination, so anything past
        # five lines is simply never seen. The packets all deliver fine.
        async with SimulatedG1() as sim:
            await sim.g1.display.text_page(
                " ".join(["parola"] * 40), page=1, max_page=1
            )
            report = sim.report()
            assert report.truncated_lines > 0
            assert not report.fits

    @pytest.mark.asyncio
    async def test_display_text_paginates_so_nothing_is_lost(self):
        # display.text splits into screens on a timer, which is why the same
        # message that overflows above does not overflow here.
        async with SimulatedG1() as sim:
            await sim.g1.display.text(" ".join(["parola"] * 12), page_delay=0)
            assert sim.report().fits

    @pytest.mark.asyncio
    async def test_the_two_font_models_are_compared_not_conflated(self):
        # The SDK estimates the firmware's proportional font; the simulator
        # draws a monospace cell font and fits fewer characters per line. The
        # report carries both so the difference is visible rather than
        # mysterious.
        async with SimulatedG1() as sim:
            await sim.g1.display.text_page(
                " ".join(["parola"] * 40), page=1, max_page=1
            )
            report = sim.report()
            assert report.sdk_lines is not None
            assert report.lines >= report.sdk_lines
            assert report.disagrees_with_sdk

    @pytest.mark.asyncio
    async def test_text_that_fits_reports_no_problem(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("Via Emilia\n2.4 km   4 min")
            assert sim.report().fits

    @pytest.mark.asyncio
    async def test_accented_text_survives_packet_splitting(self):
        # Long enough to be split across packets, so a torn UTF-8 sequence
        # would show up as replacement boxes on the panel.
        async with SimulatedG1() as sim:
            await sim.g1.display.text("perché però città università " * 2)
            assert sim.panel.frame.lit() > 0
            assert "\ufffd" not in sim.emulator.left.screen_text

    @pytest.mark.asyncio
    async def test_removing_the_glasses_blanks_the_display(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("ciao")
            lit_while_worn = sim.panel.frame.lit()

            await sim.wear(False)
            # Not blank — the panel shows why it is off — but not the message.
            assert sim.panel.frame.lit() != lit_while_worn

            await sim.wear(True)
            assert sim.panel.frame.lit() == lit_while_worn

    @pytest.mark.asyncio
    async def test_head_down_turns_the_display_off(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("ciao")
            lit = sim.panel.frame.lit()
            await sim.head_up(False)
            assert sim.panel.frame.lit() != lit

    @pytest.mark.asyncio
    async def test_a_bitmap_appears_on_the_panel(self):
        async with SimulatedG1() as sim:
            bitmap = Bitmap.blank(DISPLAY_WIDTH, DISPLAY_HEIGHT)
            for x in range(DISPLAY_WIDTH):
                bitmap.set(x, 68)
            await sim.g1.display.bitmap(bitmap)
            assert sim.panel.frame.lit() == DISPLAY_WIDTH
            assert sim.panel.frame.get(100, 68)

    @pytest.mark.asyncio
    async def test_frames_are_pushed_to_listeners(self):
        async with SimulatedG1() as sim:
            seen: list[int] = []
            sim.on_frame(lambda s: seen.append(s.frames))
            await sim.g1.display.text("ciao")
            assert seen

    @pytest.mark.asyncio
    async def test_events_still_reach_the_sdk(self):
        # The simulator wraps the SDK's emulator rather than replacing it, so
        # everything the session does must keep working.
        from openg1.events import TouchEvent

        async with SimulatedG1() as sim:
            received: list[TouchEvent] = []
            sim.g1.session.on(TouchEvent, received.append)
            await sim.tap(Arm.RIGHT, 2)
            assert received and received[0].arm is Arm.RIGHT

    @pytest.mark.asyncio
    async def test_dashboard_renders_the_clock(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.clear()
            sim.set_clock("14:32", "18°  clear")
            await sim.dashboard(True)
            assert sim.panel.frame.lit() > 0

    @pytest.mark.asyncio
    async def test_png_export_of_a_live_panel(self):
        async with SimulatedG1() as sim:
            await sim.g1.display.text("ciao")
            data = sim.panel.frame.to_png(scale=2)
            assert data[:8] == b"\x89PNG\r\n\x1a\n"
            assert len(data) > 100
