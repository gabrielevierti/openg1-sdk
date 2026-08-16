"""Everything that puts pixels on the panel."""

from __future__ import annotations

import asyncio
import logging
import warnings
from dataclasses import dataclass

from .._generated import BMP_CHUNK_BYTES, DISPLAY_HEIGHT, Arm, ScreenStatus
from .. import profile as profile_mod
from .. import bmp as bmp_mod
from .. import commands as cmd
from .. import text as text_mod
from ..errors import ProtocolError, CommandTimeout
from ..session import Response, Session
from ..bmp import Bitmap


_log = logging.getLogger("openg1.display")

_IMAGE_KW = {"dither", "threshold", "fit", "safe_area", "width", "height"}
_BITMAP_KW = {
    "verify",
    "progress",
    "auto_center",
    "vertical_offset",
    "top_down",
    "timeout",
    "pace",
}


@dataclass
class BitmapResult:
    """What actually went over the wire, and whether both arms agreed.

    Worth keeping rather than returning ``None``: when an image renders
    partially, the first question is whether all the bytes arrived, and
    without this the answer is invisible.
    """

    bytes_sent: int
    packets: int
    chunk_size: int
    top_down: bool
    left_ok: bool = False
    right_ok: bool = False

    @property
    def ok(self) -> bool:
        return self.left_ok and self.right_ok

    def __str__(self) -> str:
        return (
            f"{self.bytes_sent} bytes in {self.packets} packets of "
            f"{self.chunk_size} — left {'ok' if self.left_ok else 'FAILED'}, "
            f"right {'ok' if self.right_ok else 'FAILED'}"
        )


class Display:
    """Panel access.

    Safe area
    ---------
    The framebuffer is always the full ``DISPLAY_WIDTH x DISPLAY_HEIGHT``.
    Whether the wearer actually *sees* all of it depends on the fit of the
    glasses and on the virtual-screen geometry, so the number of hidden rows
    is a property of a particular pair on a particular nose — not something
    the library can know. Both values therefore default to zero: nothing is
    assumed hidden, and nothing is silently moved.

    The margins come from :mod:`openg1.profile`, which the simulator reads
    too — that shared value is what makes the window and the glasses agree.
    Measure yours once with ``examples/07_calibrate.py --save``; after that
    :meth:`image` letterboxes into the visible band everywhere, and you can
    still override per call with ``safe_area=(top, bottom)`` or per session
    with :meth:`set_safe_area`.
    """

    def __init__(self, session: Session) -> None:
        self._s = session
        # Rows the wearer cannot see, from the active device profile — the
        # same value the simulator masks with, so a layout that reads in the
        # window reads through the glass.
        device = profile_mod.active()
        self._visible_top = device.hidden_top
        self._visible_bottom = device.hidden_bottom
        # Extra rows to nudge auto-centred content down (negative = up).
        self.vertical_offset = 0

    # -- safe area ---------------------------------------------------------

    @property
    def safe_area(self) -> tuple[int, int]:
        """``(hidden_top, hidden_bottom)`` in pixels."""
        return self._visible_top, self._visible_bottom

    def set_safe_area(self, top: int = 0, bottom: int = 0) -> None:
        """Record how many pixel rows are cut off on your unit."""
        if top < 0 or bottom < 0:
            raise ValueError("safe-area margins cannot be negative")
        if top + bottom >= DISPLAY_HEIGHT:
            raise ValueError(
                f"safe area of {top}+{bottom} leaves nothing of a "
                f"{DISPLAY_HEIGHT}px panel visible"
            )
        self._visible_top = top
        self._visible_bottom = bottom

    # -- text --------------------------------------------------------------

    async def text(
        self,
        message: str,
        *,
        hold: float = 0.0,
        page_delay: float = 3.0,
        mode: int = ScreenStatus.TEXT_SHOW,
        metrics: text_mod.FontMetrics = text_mod.DEFAULT_METRICS,
        lines_per_screen: int | None = None,
        width_px: int | None = None,
    ) -> None:
        budget = self._s.max_data(extra_header=9)
        pages = text_mod.text_packets(
            message,
            seq=self._s.seq.peek(),
            max_data=max(16, budget),
            mode=mode,
            metrics=metrics,
            lines_per_screen=lines_per_screen or text_mod.DEFAULT_LINES_PER_SCREEN,
            width_px=width_px or text_mod.TEXT_WIDTH,
        )
        for index, packets in enumerate(pages):
            for packet in packets:
                left_packet = packet.to("left")
                await self._s.send(left_packet)
            
            if index < len(pages) - 1 and page_delay:
                await asyncio.sleep(page_delay)
        if hold:
            await asyncio.sleep(hold)

    async def text_page(
        self,
        message: str,
        *,
        page: int,
        max_page: int,
        mode: int = ScreenStatus.TEXT_SHOW,
    ) -> None:
        budget = max(16, self._s.max_data(extra_header=9))
        pieces = text_mod.split_utf8(message.encode("utf-8"), budget)
        status = text_mod.screen_status(mode=mode)
        
        for i, piece in enumerate(pieces):
            await self._s.send(
                cmd.send_text(
                    piece,
                    seq=self._s.seq.peek(),
                    total_packages=len(pieces),
                    package_index=i,
                    screen_status=status,
                    page=page,
                    max_page=max_page,
                ).to("left")
            )

    async def clear(self) -> Response:
        left_response = await self._s.send(cmd.clear_screen().to("left"))
        right_response = await self._s.send(cmd.clear_screen().to("right"))
        return left_response if left_response.ok else right_response

    def preview(self, message: str, **kw) -> str:
        return text_mod.preview(message, **kw)

    # -- bitmaps -----------------------------------------------------------

    def _center_bitmap(self, bitmap: Bitmap, offset: int = 0) -> Bitmap:
        """Move the ink so it sits centred in the visible band.

        This is a *translation*, never a crop. The shift is clamped to what
        the canvas can absorb, so a picture that already fills the panel is
        returned untouched rather than sliding out of the framebuffer. If the
        requested offset cannot be honoured in full, the caller is warned —
        the honest answer to "this does not fit" is to scale the source
        image, which :func:`openg1.bmp.load_image` does via ``safe_area``.
        """
        bounds = bmp_mod.content_bounds(bitmap)
        if bounds is None:  # nothing to centre
            return bitmap
        min_y, max_y = bounds
        content_height = max_y - min_y + 1

        visible_top = self._visible_top
        visible_bottom = self._visible_bottom
        visible_height = bitmap.height - visible_top - visible_bottom

        if content_height <= visible_height:
            target_y = visible_top + (visible_height - content_height) // 2 + offset
        else:
            # Taller than the visible band: centre it on the whole panel and
            # leave the scaling decision to the caller.
            target_y = (bitmap.height - content_height) // 2 + offset

        wanted = target_y - min_y
        # Clamp: the topmost row cannot go above 0, the bottom row cannot go
        # past the last row. This is what stops content being destroyed.
        shift_y = max(-min_y, min(wanted, bitmap.height - 1 - max_y))

        if shift_y != wanted:
            warnings.warn(
                f"auto_center wanted to move the image {wanted:+d}px but only "
                f"{shift_y:+d}px fit; the picture already occupies rows "
                f"{min_y}-{max_y} of {bitmap.height}. Scale it into the "
                f"visible band instead, e.g. "
                f"display.image(path, safe_area=({visible_top}, {visible_bottom})).",
                stacklevel=3,
            )

        if shift_y == 0:
            return bitmap
        return bmp_mod.shift_rows(bitmap, shift_y)

    async def _send_to_arm(
        self,
        arm: Arm,
        packets,
        end,
        crc,
        *,
        timeout: float,
        pace: float,
        progress,
    ) -> bool:
        """Push one arm's copy. Returns whether the arm confirmed the CRC."""
        side = "left" if arm is Arm.LEFT else "right"
        total = len(packets)
        _log.debug("sending bitmap to %s arm (%d packets)", side, total)

        for index, packet in enumerate(packets):
            await self._s.send_raw(arm, self._s.encode(packet.to(side)))
            if pace:
                await asyncio.sleep(pace)
            if progress:
                progress(index + 1, total)

        try:
            await self._s.send(end.to(side), timeout=timeout)
            _log.debug("%s arm BMP_END acknowledged", side)
        except CommandTimeout as exc:
            _log.error("%s arm BMP_END timed out: %s", side, exc)
            return False

        await asyncio.sleep(0.3)

        try:
            response = await self._s.send(crc.to(side), timeout=timeout)
        except Exception as exc:
            _log.error("%s arm CRC exchange failed: %s", side, exc)
            return False

        _log.debug("%s CRC ok=%s", side, response.ok)
        return bool(response.ok)

    async def bitmap(
        self,
        image: bytes | Bitmap,
        *,
        verify: bool = True,
        progress=None,
        timeout: float = 5.0,
        auto_center: bool = False,
        vertical_offset: int | None = None,
        top_down: bool = False,  # Default to False since it works better
        pace: float = 0.0,
    ) -> BitmapResult:
        """Send a 1-bit bitmap to BOTH arms and confirm it arrived.

        The BMP is bottom-up unless ``top_down`` is set, so the *end* of the
        byte stream is the *top* of the picture. That matters when something
        goes wrong: a transfer that loses its tail shows up as a missing band
        at the top of the panel, not the bottom. Flipping ``top_down`` moves
        the damage to the other edge, which is a cheap way to tell truncation
        apart from the panel simply not being fully visible.

        ``pace`` inserts a delay after every data packet. The data phase is
        write-without-response, so nothing throttles it; if the firmware's
        receive buffer overruns, packets vanish with no error until the CRC
        disagrees. A pace of a millisecond or two costs a fraction of a
        second over a whole image and rules that out.

        With ``verify`` set — the default — a CRC that does not come back
        clean raises rather than being logged and forgotten.
        """
        if vertical_offset is None:
            vertical_offset = self.vertical_offset

        if isinstance(image, Bitmap):
            if auto_center:
                image = self._center_bitmap(image, offset=vertical_offset)
            image_bytes = image.to_bmp(top_down=top_down)
        else:
            bitmap_obj = bmp_mod.decode_bmp(image)
            if auto_center:
                bitmap_obj = self._center_bitmap(bitmap_obj, offset=vertical_offset)
            image_bytes = bitmap_obj.to_bmp(top_down=top_down)

        if verify:
            bmp_mod.validate_for_display(image_bytes)

        chunk_size = self._chunk()
        bmp_mod.check_transfer_budget(len(image_bytes), chunk_size)

        packets, end, crc = bmp_mod.transfer_packets(
            image_bytes, chunk_size=chunk_size
        )
        result = BitmapResult(
            bytes_sent=len(image_bytes),
            packets=len(packets),
            chunk_size=chunk_size,
            top_down=top_down,
        )

        # Left before right: the halves update independently and the panel
        # tears if both are written at once.
        result.left_ok = await self._send_to_arm(
            Arm.LEFT, packets, end, crc, timeout=timeout, pace=pace, progress=progress
        )
        result.right_ok = await self._send_to_arm(
            Arm.RIGHT, packets, end, crc, timeout=timeout, pace=pace, progress=progress
        )

        if verify and not result.ok:
            raise ProtocolError(
                f"bitmap not confirmed (left={result.left_ok}, "
                f"right={result.right_ok}) after {result.packets} packets of "
                f"{chunk_size} bytes. An unconfirmed transfer usually renders "
                f"partially: with top_down={top_down} the missing rows appear "
                f"at the {'bottom' if top_down else 'top'} of the panel. Try a "
                f"pace of 0.002, and check the negotiated MTU."
            )

        _log.debug("bitmap committed on both arms")
        return result

    async def image(self, path: str, **kw) -> BitmapResult:
        """Load any image file, quantise it and display it. Needs Pillow.

        ``safe_area=(top, bottom)`` scales the picture into the rows you can
        actually see; it defaults to whatever :meth:`set_safe_area` recorded.
        Unlike ``auto_center``, it never loses a pixel — it shrinks instead
        of shoving.
        """
        unknown = set(kw) - _IMAGE_KW - _BITMAP_KW
        if unknown:
            raise TypeError(f"image() got unexpected keyword(s): {sorted(unknown)}")

        load_kw = {k: v for k, v in kw.items() if k in _IMAGE_KW}
        load_kw.setdefault("safe_area", self.safe_area)
        bitmap = bmp_mod.load_image(path, **load_kw)
        return await self.bitmap(
            bitmap, **{k: v for k, v in kw.items() if k in _BITMAP_KW}
        )

    def _chunk(self) -> int:
        return min(BMP_CHUNK_BYTES, self._s.max_data(extra_header=1) - 4)

    # -- panel -------------------------------------------------------------

    async def brightness(self, level: int, *, auto: bool = False) -> Response:
        return await self._s.send(cmd.set_brightness(level, auto))

    async def get_brightness(self) -> tuple[int, bool]:
        response = await self._s.send(cmd.get_brightness())
        body = response.payload()
        if len(body) < 3:
            raise ProtocolError(f"short brightness reply: {body.hex(' ')}")
        return body[1], bool(body[2])

    async def set_geometry(self, height: int, depth: int, *, settle: float = 1.5) -> None:
        await self._s.send(cmd.set_display_settings(height, depth, preview=True))
        await asyncio.sleep(settle)
        await self._s.send(cmd.set_display_settings(height, depth, preview=False))

    async def get_geometry(self) -> tuple[int, int]:
        response = await self._s.send(cmd.get_display_settings())
        body = response.payload()
        if len(body) < 3:
            raise ProtocolError(f"short display-settings reply: {body.hex(' ')}")
        return body[1], body[2]

    async def power(self, on: bool = True) -> Response:
        return await self._s.send(cmd.display_power(on))