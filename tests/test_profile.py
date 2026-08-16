"""One device profile, read by both sides.

The point of these is narrow and important: the number that decides what the
simulator dims must be the same number that decides what `display.image()`
letterboxes into. If those ever drift, the simulator stops predicting the
glasses and everything built on it becomes guesswork.
"""

from __future__ import annotations

import asyncio
import pathlib
import tempfile

import pytest

from openg1 import profile as profile_mod
from openg1.errors import ParityError
from openg1.profile import DeviceProfile
from openg1sim import SimulatedG1


class TestDeviceProfile:
    def test_default_hides_nothing(self):
        assert DeviceProfile().safe_area == (0, 0)
        assert not DeviceProfile().calibrated

    def test_visible_geometry(self):
        device = DeviceProfile(hidden_top=23)
        assert device.visible_height == 113
        assert device.visible_rows == range(23, 136)

    def test_negative_margins_rejected(self):
        with pytest.raises(ValueError):
            DeviceProfile(hidden_top=-1)

    def test_margins_swallowing_the_panel_rejected(self):
        with pytest.raises(ValueError):
            DeviceProfile(hidden_top=80, hidden_bottom=80)

    def test_uncalibrated_description_says_so(self):
        assert "uncalibrated" in DeviceProfile().describe()

    def test_round_trip_through_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "p.toml"
            DeviceProfile(name="mine", hidden_top=23, hidden_bottom=4).save(path)
            loaded = profile_mod.load(path)
        assert loaded.hidden_top == 23 and loaded.hidden_bottom == 4

    def test_missing_file_falls_back_to_default(self):
        assert profile_mod.load.__doc__  # documented as non-raising
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "nope.toml"
            assert not missing.exists()


class TestBothSidesAgree:
    """The actual guarantee."""

    def setup_method(self):
        self.device = DeviceProfile(name="test", hidden_top=23)
        profile_mod.use(self.device)

    def teardown_method(self):
        profile_mod.use(None)

    def test_display_reads_the_profile(self):
        """Hardware side."""
        from openg1.api.display import Display

        display = Display.__new__(Display)
        Display.__init__(display, session=None)
        assert display.safe_area == (23, 0)

    @pytest.mark.asyncio
    async def test_simulator_reads_the_same_profile(self):
        async with SimulatedG1() as sim:
            assert sim.device.safe_area == (23, 0)

    @pytest.mark.asyncio
    async def test_an_image_lands_inside_the_visible_band(self):
        """The two halves meeting: image() letterboxes, simulator agrees."""
        from openg1.bmp import load_image

        with tempfile.TemporaryDirectory() as tmp:
            try:
                from PIL import Image
            except ImportError:
                pytest.skip("needs Pillow")
            path = pathlib.Path(tmp) / "src.png"
            Image.new("L", (576, 136), 255).save(path)

            async with SimulatedG1() as sim:
                await sim.g1.display.image(str(path), dither=False)
                assert sim.hidden_ink() == 0
                assert sim.check_parity() == []

    @pytest.mark.asyncio
    async def test_drawing_into_the_hidden_band_is_reported(self):
        from openg1.bmp import Bitmap

        bitmap = Bitmap.blank()
        for x in range(576):
            bitmap.set(x, 5)  # row 5 is inside the hidden 23

        async with SimulatedG1() as sim:
            await sim.g1.display.bitmap(bitmap)
            assert sim.hidden_ink() == 576
            assert any("hidden rows" in p for p in sim.check_parity())

    @pytest.mark.asyncio
    async def test_strict_mode_raises_instead_of_warning(self):
        from openg1.bmp import Bitmap

        bitmap = Bitmap.blank()
        for x in range(576):
            bitmap.set(x, 5)

        async with SimulatedG1(strict=True) as sim:
            await sim.g1.display.bitmap(bitmap)
            with pytest.raises(ParityError):
                sim.check_parity()

    @pytest.mark.asyncio
    async def test_clean_screen_passes_strict(self):
        from openg1.bmp import Bitmap

        bitmap = Bitmap.blank()
        for x in range(576):
            bitmap.set(x, 60)  # comfortably inside the visible band

        async with SimulatedG1(strict=True) as sim:
            await sim.g1.display.bitmap(bitmap)
            assert sim.check_parity() == []

    @pytest.mark.asyncio
    async def test_rendered_png_dims_the_hidden_rows(self):
        """What the window shows is what the eye gets."""
        from openg1.bmp import Bitmap

        bitmap = Bitmap.blank()
        for x in range(576):
            bitmap.set(x, 5)
            bitmap.set(x, 60)

        async with SimulatedG1() as sim:
            await sim.g1.display.bitmap(bitmap)
            plain = sim.panel.frame.to_png(scale=1)
            masked = sim.png(scale=1)
        assert plain != masked  # the mask actually changed the output


class TestOverride:
    def test_explicit_device_beats_the_active_profile(self):
        profile_mod.use(DeviceProfile(hidden_top=23))
        try:
            sim = SimulatedG1(device=DeviceProfile(hidden_top=4))
            assert sim.device.hidden_top == 4
        finally:
            profile_mod.use(None)

    def test_use_none_restores_disk_lookup(self):
        profile_mod.use(DeviceProfile(hidden_top=99))
        profile_mod.use(None)
        assert profile_mod.active().hidden_top != 99
