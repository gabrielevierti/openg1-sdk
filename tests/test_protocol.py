"""Unit tests for the pure protocol layer. No radios, no event loop."""

from __future__ import annotations

import pytest

from openg1 import commands as cmd
from openg1._generated import ScreenStatus, Status
from openg1.bmp import Bitmap, decode_bmp, from_gray, row_stride
from openg1.crc import bmp_crc
from openg1.errors import ProtocolError
from openg1.framing import SequenceCounter, decode, encode_framed, encode_raw
from openg1.text import paginate, split_utf8, wrap


class TestFraming:
    def test_raw_roundtrip(self):
        packet = decode(encode_raw(0x0E, b"\x01"))
        assert (packet.opcode, packet.payload, packet.framed) == (0x0E, b"\x01", False)

    def test_framed_length_counts_the_header(self):
        assert encode_framed(0x25, 0x2A, b"\x04\x2a") == bytes.fromhex("2506002a042a")

    def test_framed_trims_padding_by_declared_length(self):
        packet = decode(bytes.fromhex("10060004" + "01c9" + "00" * 14))
        assert packet.payload == b"\x01\xc9"
        assert packet.trailer == b"\x00" * 14

    def test_result_byte_lands_past_the_declared_length(self):
        packet = decode(bytes.fromhex("3905001c0100"))
        assert packet.payload == b"\x01" and packet.trailer == b"\x00"

    def test_short_framed_packet_is_rejected(self):
        with pytest.raises(ProtocolError):
            decode(bytes.fromhex("25ff00"), framed=True)

    def test_declared_length_longer_than_the_packet_is_rejected(self):
        with pytest.raises(ProtocolError):
            decode(bytes.fromhex("25400001"), framed=True)

    def test_raw_opcode_is_not_mistaken_for_framed(self):
        # 0x0E is raw; it must not be reinterpreted even if the bytes could
        # pass a length check.
        assert decode(bytes.fromhex("0e0400ff")).framed is False

    def test_sequence_wraps_at_256(self):
        counter = SequenceCounter(0xFE)
        assert [counter.next() for _ in range(3)] == [0xFE, 0xFF, 0x00]


class TestCommands:
    def test_constant_prefix_is_applied(self):
        assert cmd.get_firmware_info().body == b"\x74"
        assert cmd.hard_reset().body == b"\x72"

    def test_battery_and_device_info_share_an_opcode(self):
        assert cmd.get_battery().opcode == cmd.get_device_info().opcode == 0x2C
        assert cmd.get_battery().body != cmd.get_device_info().body

    def test_brightness_range_is_enforced(self):
        with pytest.raises(ProtocolError):
            cmd.set_brightness(0x2B)
        assert cmd.set_brightness(0x2A, auto=True).body == b"\x2a\x01"

    def test_mic_goes_to_the_right_arm_only(self):
        assert cmd.mic_control(True).resolved_target == "right"

    def test_notifications_go_to_the_left_arm_only(self):
        assert cmd.clear_notification().resolved_target == "left"

    def test_text_header_is_eight_bytes_after_the_opcode(self):
        out = cmd.send_text(b"hi", seq=1, total_packages=1, package_index=0)
        assert len(out.body) == 8 + 2
        assert out.body[3] == ScreenStatus.TEXT_SHOW | 0x01

    def test_silent_mode_is_an_enum_not_a_boolean(self):
        assert cmd.set_silent_mode(True).body == b"\x0c"
        assert cmd.set_silent_mode(False).body == b"\x0a"

    def test_display_settings_needs_both_phases(self):
        preview = cmd.set_display_settings(4, 5, preview=True).body
        commit = cmd.set_display_settings(4, 5, preview=False).body
        assert preview[2] == 1 and commit[2] == 0

    def test_dashboard_time_is_little_endian(self):
        out = cmd.set_time_and_weather(epoch_s=0x11223344, epoch_ms=0)
        assert out.body[1:5] == bytes.fromhex("44332211")


class TestText:
    def test_wrap_respects_newlines(self):
        assert wrap("a\nb") == ["a", "b"]

    def test_long_words_are_broken_not_dropped(self):
        lines = wrap("x" * 500, width_px=100)
        assert len(lines) > 1
        assert "".join(lines) == "x" * 500

    def test_pagination_groups_into_screens(self):
        screens = paginate("\n".join(str(i) for i in range(12)), lines_per_screen=5)
        assert [len(s.lines) for s in screens] == [5, 5, 2]

    def test_split_never_tears_a_utf8_sequence(self):
        for text in ("caffè corretto", "東京都渋谷区", "ok 👍🏽 done"):
            data = text.encode("utf-8")
            for limit in range(4, 16):
                pieces = split_utf8(data, limit)
                assert b"".join(pieces) == data
                for piece in pieces:
                    piece.decode("utf-8")  # raises if torn

    def test_empty_input_still_yields_a_screen(self):
        assert len(paginate("")) == 1


class TestBitmap:
    def test_stride_is_padded_to_four_bytes(self):
        assert row_stride(576) == 72
        assert row_stride(1) == 4

    def test_set_and_get_roundtrip(self):
        bitmap = Bitmap.blank(16, 2)
        bitmap.set(0, 0)
        bitmap.set(15, 1)
        assert bitmap.get(0, 0) == 1 and bitmap.get(15, 1) == 1
        assert bitmap.get(1, 0) == 0

    def test_bmp_roundtrip(self):
        bitmap = Bitmap.blank(576, 136)
        for x in range(0, 576, 7):
            bitmap.set(x, 3)
        restored = decode_bmp(bitmap.to_bmp())
        assert restored.bits == bitmap.bits
        assert (restored.width, restored.height) == (576, 136)

    def test_top_down_roundtrip(self):
        bitmap = Bitmap.blank(32, 4)
        bitmap.set(1, 0)
        assert decode_bmp(bitmap.to_bmp(top_down=True)).bits == bitmap.bits

    def test_threshold_quantisation(self):
        gray = [0, 255, 0, 255]
        bitmap = from_gray(gray, 2, 2, dither=False)
        assert [bitmap.get(x, y) for y in range(2) for x in range(2)] == [0, 1, 0, 1]

    def test_dithering_preserves_average_tone(self):
        bitmap = from_gray([128] * 400, 20, 20, dither=True)
        lit = sum(bitmap.get(x, y) for y in range(20) for x in range(20))
        assert 140 < lit < 260  # roughly half, which is the point

    def test_crc_includes_the_storage_address(self):
        assert bmp_crc(b"abc") != bmp_crc(b"abc", address=b"\x00\x00\x00\x00")
