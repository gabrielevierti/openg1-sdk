"""Vertical placement of bitmaps.

The bug these guard against: ``auto_center`` used to translate a full-panel
image by the requested offset and let whatever fell off the bottom of the
framebuffer disappear. A 576x136 picture went in and 116 rows came out, with
the missing 20 replaced by a blank band at the top — which looks exactly like
the panel cropping the image, so it got blamed on the hardware.

Centering may move ink. It may never destroy it.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
import warnings

import pytest

from openg1._generated import DISPLAY_HEIGHT, DISPLAY_WIDTH
from openg1.api.display import Display
from openg1.bmp import Bitmap, content_bounds, shift_rows


def full_panel() -> Bitmap:
    """Ink in every row, top to bottom."""
    bitmap = Bitmap.blank()
    for y in range(DISPLAY_HEIGHT):
        bitmap.set(0, y)
        bitmap.set(DISPLAY_WIDTH - 1, y)
    return bitmap


def band(top: int, bottom: int) -> Bitmap:
    """Ink in rows ``top..bottom`` inclusive."""
    bitmap = Bitmap.blank()
    for y in range(top, bottom + 1):
        bitmap.set(10, y)
    return bitmap


def lit_rows(bitmap: Bitmap) -> int:
    stride = bitmap.stride
    return sum(
        1
        for y in range(bitmap.height)
        if any(bitmap.bits[y * stride : (y + 1) * stride])
    )


def display(top: int = 0, bottom: int = 0) -> Display:
    d = Display.__new__(Display)
    d._visible_top = top
    d._visible_bottom = bottom
    d.vertical_offset = 0
    return d


class TestContentBounds:
    def test_blank_has_no_bounds(self):
        assert content_bounds(Bitmap.blank()) is None

    def test_bounds_are_inclusive(self):
        assert content_bounds(band(12, 40)) == (12, 40)

    def test_full_panel(self):
        assert content_bounds(full_panel()) == (0, DISPLAY_HEIGHT - 1)


class TestShiftRows:
    def test_zero_shift_is_the_same_object(self):
        bitmap = band(4, 8)
        assert shift_rows(bitmap, 0) is bitmap

    def test_shift_moves_content(self):
        assert content_bounds(shift_rows(band(4, 8), 6)) == (10, 14)

    def test_shift_preserves_pixel_pattern(self):
        original = band(4, 8)
        moved = shift_rows(original, 6)
        stride = original.stride
        for y in range(4, 9):
            assert (
                moved.bits[(y + 6) * stride : (y + 7) * stride]
                == original.bits[y * stride : (y + 1) * stride]
            )


class TestCenteringNeverCrops:
    def test_full_panel_image_is_returned_untouched(self):
        bitmap = full_panel()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result = display()._center_bitmap(bitmap, offset=20)
        assert lit_rows(result) == DISPLAY_HEIGHT
        assert content_bounds(result) == (0, DISPLAY_HEIGHT - 1)

    def test_the_original_bug_would_have_lost_twenty_rows(self):
        """Documents the regression in the terms it was reported in."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result = display()._center_bitmap(full_panel(), offset=20)
        assert lit_rows(result) != DISPLAY_HEIGHT - 20

    def test_offset_that_does_not_fit_warns(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            display()._center_bitmap(full_panel(), offset=20)
        assert any("auto_center" in str(w.message) for w in caught)

    def test_offset_that_fits_does_not_warn(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            display()._center_bitmap(band(40, 60), offset=5)
        assert not caught

    @pytest.mark.parametrize("offset", [-200, -20, 0, 20, 200])
    def test_no_offset_ever_loses_ink(self, offset):
        for bitmap in (full_panel(), band(0, 10), band(120, 135), band(50, 70)):
            before = lit_rows(bitmap)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                after = lit_rows(display()._center_bitmap(bitmap, offset=offset))
            assert after == before

    def test_blank_bitmap_survives(self):
        blank = Bitmap.blank()
        assert display()._center_bitmap(blank, offset=20) is blank

    def test_small_content_centres_in_the_visible_band(self):
        # 20 rows of ink, 12 hidden top and bottom -> centred in rows 12..123
        result = display(12, 12)._center_bitmap(band(0, 19))
        top, bottom = content_bounds(result)
        assert top == 12 + (112 - 20) // 2
        assert bottom - top == 19


class TestSafeArea:
    def test_defaults_to_nothing_hidden(self):
        assert display().safe_area == (0, 0)

    def test_set_safe_area(self):
        d = display()
        d.set_safe_area(10, 14)
        assert d.safe_area == (10, 14)

    def test_negative_margins_rejected(self):
        with pytest.raises(ValueError):
            display().set_safe_area(-1, 0)

    def test_margins_swallowing_the_panel_rejected(self):
        with pytest.raises(ValueError):
            display().set_safe_area(80, 80)


class TestLoadImageSafeArea:
    """These need Pillow. Skipped when it is absent, since it is an extra.

    Uses tempfile rather than pytest's tmp_path so the suite still runs under
    tests/run_tests.py, which does not implement fixtures.
    """

    @contextlib.contextmanager
    def _png(self, size=(DISPLAY_WIDTH, DISPLAY_HEIGHT)):
        try:
            from PIL import Image
        except ImportError:
            pytest.skip("needs Pillow")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "src.png")
            Image.new("L", size, 255).save(path)
            yield path

    def test_no_safe_area_fills_the_panel(self):
        from openg1.bmp import load_image

        with self._png() as path:
            bitmap = load_image(path, dither=False)
        assert content_bounds(bitmap) == (0, DISPLAY_HEIGHT - 1)

    def test_safe_area_scales_into_the_visible_band(self):
        from openg1.bmp import load_image

        with self._png() as path:
            bitmap = load_image(path, dither=False, safe_area=(12, 12))
        top, bottom = content_bounds(bitmap)
        assert top >= 12
        assert bottom <= DISPLAY_HEIGHT - 13

    def test_safe_area_keeps_the_whole_picture(self):
        """A source taller than the band must shrink, not crop."""
        from openg1.bmp import load_image

        with self._png() as path:
            plain = load_image(path, dither=False)
            safe = load_image(path, dither=False, safe_area=(20, 20))
        assert lit_rows(safe) < lit_rows(plain)  # scaled down
        assert lit_rows(safe) >= DISPLAY_HEIGHT - 40 - 2  # but fills the band

    def test_bad_fit_rejected(self):
        from openg1.bmp import load_image

        with self._png() as path, pytest.raises(ValueError):
            load_image(path, fit="squish")

    def test_impossible_safe_area_rejected(self):
        from openg1.bmp import load_image

        with self._png() as path, pytest.raises(ValueError):
            load_image(path, safe_area=(70, 70))


class TestTransferBudget:
    """The chunk index is one byte. Nothing used to check that."""

    def test_documented_chunk_size_is_fine(self):
        from openg1.bmp import check_transfer_budget

        assert check_transfer_budget(9854, 194) == 51

    def test_exactly_256_chunks_allowed(self):
        from openg1.bmp import check_transfer_budget

        assert check_transfer_budget(256 * 40, 40) == 256

    def test_257_chunks_rejected(self):
        from openg1.bmp import ProtocolError, check_transfer_budget

        with pytest.raises(ProtocolError):
            check_transfer_budget(256 * 40 + 1, 40)

    def test_default_mtu_is_rejected_not_corrupted(self):
        """A 23-byte MTU leaves 14-byte chunks and 704 of them."""
        from openg1.bmp import ProtocolError, check_transfer_budget

        with pytest.raises(ProtocolError) as exc:
            check_transfer_budget(9854, 14)
        assert "704" in str(exc.value)

    def test_zero_chunk_rejected(self):
        from openg1.bmp import ProtocolError, check_transfer_budget

        with pytest.raises(ProtocolError):
            check_transfer_budget(9854, 0)


class TestBitmapResult:
    def test_ok_needs_both_arms(self):
        from openg1.api.display import BitmapResult

        result = BitmapResult(bytes_sent=9854, packets=51, chunk_size=194, top_down=False)
        assert not result.ok
        result.left_ok = True
        assert not result.ok
        result.right_ok = True
        assert result.ok

    def test_str_names_the_failing_arm(self):
        from openg1.api.display import BitmapResult

        result = BitmapResult(9854, 51, 194, False, left_ok=True, right_ok=False)
        assert "FAILED" in str(result)


class TestBitmapVerification:
    @pytest.mark.asyncio
    async def test_successful_transfer_reports_both_arms(self):
        from openg1sim import SimulatedG1
        from openg1.bmp import Bitmap

        async with SimulatedG1() as sim:
            g1 = sim.g1
            result = await g1.display.bitmap(Bitmap.blank())
        assert result.ok
        assert result.bytes_sent == 9854
        assert result.packets == 51

    @pytest.mark.asyncio
    async def test_small_mtu_raises_instead_of_wrapping(self):
        from openg1sim import SimulatedG1
        from openg1.bmp import Bitmap
        from openg1.errors import ProtocolError

        async with SimulatedG1() as sim:
            g1 = sim.g1
            for transport in g1.session.transports.values():
                transport._mtu = 23
            with pytest.raises(ProtocolError):
                await g1.display.bitmap(Bitmap.blank())

    @pytest.mark.asyncio
    async def test_top_down_is_recorded(self):
        from openg1sim import SimulatedG1
        from openg1.bmp import Bitmap

        async with SimulatedG1() as sim:
            g1 = sim.g1
            result = await g1.display.bitmap(Bitmap.blank(), top_down=True)
        assert result.top_down is True

    @pytest.mark.asyncio
    async def test_pace_does_not_change_the_bytes(self):
        from openg1sim import SimulatedG1
        from openg1.bmp import Bitmap

        async with SimulatedG1() as sim:
            g1 = sim.g1
            paced = await g1.display.bitmap(Bitmap.blank(), pace=0.0001)
        assert paced.bytes_sent == 9854 and paced.ok
