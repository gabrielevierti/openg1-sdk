"""A 576x136 one-bit framebuffer, and the drawing needed to fill it.

The emulator in the SDK tells you what the glasses were *told*. This tells you
what the wearer would *see*, which is a different and often more useful thing:
text that overflows the panel, a line that wraps somewhere ugly, an image that
dithered into mud. None of that shows up in a byte log.

Everything here is stdlib. The PNG writer is about thirty lines because
`zlib` does the hard part, and pulling in Pillow to save a two-colour image
would be a poor trade for a package whose whole point is having no
dependencies.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

from . import font

DISPLAY_WIDTH = 576
DISPLAY_HEIGHT = 136


class Framebuffer:
    """One bit per pixel, stored one byte per pixel for simplicity.

    576x136 is 78 kilobytes as bytes and 10 kilobytes packed. At this size the
    packing is not worth the arithmetic, and a flat ``bytearray`` keeps every
    drawing routine to one line.
    """

    __slots__ = ("width", "height", "pixels")

    def __init__(self, width: int = DISPLAY_WIDTH, height: int = DISPLAY_HEIGHT) -> None:
        self.width = width
        self.height = height
        self.pixels = bytearray(width * height)

    # -- basics ------------------------------------------------------------

    def clear(self, value: int = 0) -> None:
        self.pixels[:] = bytes([1 if value else 0]) * (self.width * self.height)

    def set(self, x: int, y: int, on: bool = True) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            self.pixels[y * self.width + x] = 1 if on else 0

    def get(self, x: int, y: int) -> bool:
        if 0 <= x < self.width and 0 <= y < self.height:
            return self.pixels[y * self.width + x] == 1
        return False

    def lit(self) -> int:
        """How many pixels are on. A cheap way to assert 'something rendered'."""
        return sum(self.pixels)

    # -- shapes ------------------------------------------------------------

    def fill_rect(self, x: int, y: int, w: int, h: int, on: bool = True) -> None:
        value = 1 if on else 0
        x0, x1 = max(0, x), min(self.width, x + w)
        if x0 >= x1:
            return
        row = bytes([value]) * (x1 - x0)
        for yy in range(max(0, y), min(self.height, y + h)):
            start = yy * self.width + x0
            self.pixels[start : start + (x1 - x0)] = row

    def rect(self, x: int, y: int, w: int, h: int, on: bool = True) -> None:
        self.fill_rect(x, y, w, 1, on)
        self.fill_rect(x, y + h - 1, w, 1, on)
        self.fill_rect(x, y, 1, h, on)
        self.fill_rect(x + w - 1, y, 1, h, on)

    def hline(self, x: int, y: int, length: int, on: bool = True) -> None:
        self.fill_rect(x, y, length, 1, on)

    def vline(self, x: int, y: int, length: int, on: bool = True) -> None:
        self.fill_rect(x, y, 1, length, on)

    def line(self, x0: int, y0: int, x1: int, y1: int, on: bool = True) -> None:
        """Bresenham, for the odd diagonal in a navigation arrow."""
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            self.set(x0, y0, on)
            if x0 == x1 and y0 == y1:
                return
            doubled = 2 * error
            if doubled >= dy:
                error += dy
                x0 += sx
            if doubled <= dx:
                error += dx
                y0 += sy

    def invert(self, x: int = 0, y: int = 0, w: int | None = None, h: int | None = None) -> None:
        w = self.width if w is None else w
        h = self.height if h is None else h
        for yy in range(max(0, y), min(self.height, y + h)):
            base = yy * self.width
            for xx in range(max(0, x), min(self.width, x + w)):
                self.pixels[base + xx] ^= 1

    # -- text --------------------------------------------------------------

    def draw_char(
        self, char: str, x: int, y: int, x_scale: int = 2, y_scale: int = 3, on: bool = True
    ) -> int:
        """Draw one glyph with its top-left at (x, y). Returns the advance.

        The two scales are separate because the panel's real font is
        proportional and narrower than a square cell font — see the note in
        :mod:`openg1sim.font`.
        """
        columns = font.glyph(char)
        for column_index, column in enumerate(columns):
            for row in range(font.CELL_HEIGHT):
                if column >> row & 1:
                    self.fill_rect(
                        x + column_index * x_scale, y + row * y_scale, x_scale, y_scale, on
                    )
        return font.advance(x_scale)

    def draw_text(
        self, text: str, x: int, y: int, x_scale: int = 2, y_scale: int = 3, on: bool = True
    ) -> int:
        """Draw a single line. Returns the x position after the last glyph."""
        cursor = x
        for char in text:
            if cursor >= self.width:
                break
            cursor += self.draw_char(char, cursor, y, x_scale, y_scale, on)
        return cursor

    def draw_lines(
        self,
        lines: list[str],
        x: int = 0,
        y: int = 0,
        x_scale: int = 2,
        y_scale: int = 3,
        leading: int = 0,
    ) -> None:
        step = font.line_height(y_scale, leading)
        for index, line in enumerate(lines):
            self.draw_text(line, x, y + index * step, x_scale, y_scale)

    # -- bitmaps -----------------------------------------------------------

    def blit_bmp(self, data: bytes, x: int = 0, y: int = 0) -> None:
        """Draw a 1-bpp Windows BMP — the format the glasses accept.

        Rows run bottom-up unless the header height is negative, which is the
        single most common reason a transferred image appears upside down.
        """
        if len(data) < 62 or data[:2] != b"BM":
            raise ValueError("not a BMP file")
        offset = struct.unpack_from("<I", data, 10)[0]
        width = struct.unpack_from("<i", data, 18)[0]
        height_field = struct.unpack_from("<i", data, 22)[0]
        depth = struct.unpack_from("<H", data, 28)[0]
        if depth != 1:
            raise ValueError(f"expected 1 bit per pixel, got {depth}")

        height = abs(height_field)
        top_down = height_field < 0
        stride = ((width + 31) // 32) * 4

        # Palette entry 0 is usually black, but not always; honour it rather
        # than assuming, or inverted images render inverted.
        zero_is_dark = data[54:57] < data[58:61]

        for row in range(height):
            source_row = row if top_down else height - 1 - row
            start = offset + source_row * stride
            for column in range(width):
                byte = data[start + (column >> 3)]
                bit = byte >> (7 - (column & 7)) & 1
                # Lit means "the bright palette entry". With the usual
                # palette (index 0 black) that is bit 1; with an inverted
                # palette it is bit 0.
                if bool(bit) != zero_is_dark:
                    continue
                self.set(x + column, y + row, True)

    # -- output ------------------------------------------------------------

    def to_png(
        self,
        scale: int = 1,
        foreground=(0x6E, 0xF5, 0xC8),
        background=(0, 0, 0),
        hidden: tuple[int, int] = (0, 0),
        hidden_foreground=(0x2A, 0x3D, 0x38),
        hidden_background=(0x0A, 0x0E, 0x0D),
    ) -> bytes:
        """Encode as a PNG. Default colours are the G1's green-on-black.

        ``hidden`` is ``(top, bottom)`` rows the wearer cannot see on the
        device this is standing in for. Those rows are drawn dimmed rather
        than cropped: cropping would quietly change the image geometry and
        make the window disagree with the framebuffer, while dimming shows
        both what you sent and what will actually reach an eye. Anything you
        can only read in the dim band is a bug you would otherwise ship.
        """
        width, height = self.width * scale, self.height * scale
        hidden_top, hidden_bottom = hidden
        visible_from = hidden_top * scale
        visible_to = (self.height - hidden_bottom) * scale
        raw = bytearray()
        for y in range(height):
            raw.append(0)  # filter: none
            source = (y // scale) * self.width
            visible = visible_from <= y < visible_to
            on = foreground if visible else hidden_foreground
            off = background if visible else hidden_background
            for x in range(width):
                colour = on if self.pixels[source + x // scale] else off
                raw.extend(colour)

        def chunk(tag: bytes, payload: bytes) -> bytes:
            body = tag + payload
            return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

        header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )

    def to_ascii(self, columns: int = 96, on: str = "#", off: str = ".") -> str:
        """A coarse sketch. Fine for a quick look, poor for reading text."""
        step_x = max(1, self.width // columns)
        step_y = step_x * 2
        rows = []
        for y in range(0, self.height, step_y):
            rows.append(
                "".join(on if self.get(x, y) else off for x in range(0, self.width, step_x))
            )
        return "\n".join(rows)

    def to_blocks(self, x_scale: int = 4, y_scale: int = 2) -> str:
        """Half-block rendering: two sampled rows per terminal row.

        The two scales are separate because terminal cells are about twice as
        tall as they are wide. At the default the panel becomes 144 columns by
        34 rows — fits an ordinary window, and the 21-pixel text stays
        readable, which it does not if you sample squarely.
        """
        rows = []
        step = y_scale * 2
        for y in range(0, self.height, step):
            line = []
            for x in range(0, self.width, x_scale):
                top = self._sample(x, y, x_scale, y_scale)
                bottom = self._sample(x, y + y_scale, x_scale, y_scale)
                line.append(_BLOCKS[(top, bottom)])
            rows.append("".join(line))
        return "\n".join(rows)

    def _sample(self, x: int, y: int, w: int, h: int) -> bool:
        """True if any pixel in the cell is lit — thin strokes must survive."""
        for yy in range(y, min(y + h, self.height)):
            base = yy * self.width
            for xx in range(x, min(x + w, self.width)):
                if self.pixels[base + xx]:
                    return True
        return False

    def copy(self) -> "Framebuffer":
        clone = Framebuffer(self.width, self.height)
        clone.pixels[:] = self.pixels
        return clone

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Framebuffer)
            and other.width == self.width
            and other.height == self.height
            and other.pixels == self.pixels
        )


_BLOCKS = {
    (False, False): " ",
    (True, False): "▀",
    (False, True): "▄",
    (True, True): "█",
}


@dataclass(frozen=True)
class Region:
    """A rectangle, so layout code can name its areas instead of counting."""

    x: int
    y: int
    width: int
    height: int

    def inset(self, amount: int) -> "Region":
        return Region(
            self.x + amount,
            self.y + amount,
            max(0, self.width - amount * 2),
            max(0, self.height - amount * 2),
        )
