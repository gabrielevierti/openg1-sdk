"""Bitmap support: build a 1-bit BMP the glasses accept, and chop it up.

The panel is 576x136 and monochrome. What travels over BLE is not raw pixels
but a complete 1-bit ``.bmp`` file — header included — written into arm-local
storage at ``0x0000_1C00``, then committed with an end marker and a CRC.

Everything here is pure Python. Pillow is used only to *decode* arbitrary
image formats; the quantisation, dithering and BMP writing are implemented
locally so a minimal install can still push a bitmap.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Iterable, Sequence

from ._generated import (
    BMP_CHUNK_BYTES,
    BMP_STORAGE_ADDRESS,
    DISPLAY_HEIGHT,
    DISPLAY_WIDTH,
)
from .commands import Outbound, bmp_crc, bmp_end, bmp_packet
from .crc import bmp_crc as compute_bmp_crc
from .errors import ProtocolError, UnsupportedFeature

_FILE_HEADER = 14
_INFO_HEADER = 40
_PALETTE = 8
BMP_HEADER_SIZE = _FILE_HEADER + _INFO_HEADER + _PALETTE  # 62


@dataclass
class Bitmap:
    """A 1-bit image. ``bits`` is row-major, MSB-first, rows padded to 4 bytes."""

    width: int
    height: int
    bits: bytearray

    @property
    def stride(self) -> int:
        return row_stride(self.width)

    @classmethod
    def blank(cls, width: int = DISPLAY_WIDTH, height: int = DISPLAY_HEIGHT) -> "Bitmap":
        return cls(width, height, bytearray(row_stride(width) * height))

    def get(self, x: int, y: int) -> int:
        byte = self.bits[y * self.stride + (x >> 3)]
        return (byte >> (7 - (x & 7))) & 1

    def set(self, x: int, y: int, value: int = 1) -> None:
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        index = y * self.stride + (x >> 3)
        mask = 1 << (7 - (x & 7))
        if value:
            self.bits[index] |= mask
        else:
            self.bits[index] &= ~mask & 0xFF

    def invert(self) -> "Bitmap":
        return Bitmap(self.width, self.height, bytearray(b ^ 0xFF for b in self.bits))

    def to_ascii(self, on: str = "#", off: str = ".") -> str:
        """Terminal preview. Handy for checking a bitmap without hardware."""
        return "\n".join(
            "".join(on if self.get(x, y) else off for x in range(self.width))
            for y in range(self.height)
        )

    def to_bmp(self, *, top_down: bool = False) -> bytes:
        return encode_bmp(self, top_down=top_down)


def row_stride(width: int) -> int:
    """Bytes per row: 1 bit per pixel, rounded up to a 4-byte boundary."""
    return ((width + 31) // 32) * 4


def content_bounds(bitmap: Bitmap) -> tuple[int, int] | None:
    """First and last row holding at least one lit pixel, or ``None``.

    Works a row of bytes at a time rather than pixel by pixel — the naive
    version is ~78,000 Python-level iterations on a full panel.
    """
    stride = bitmap.stride
    rows = [
        y
        for y in range(bitmap.height)
        if any(bitmap.bits[y * stride : (y + 1) * stride])
    ]
    if not rows:
        return None
    return rows[0], rows[-1]


def shift_rows(bitmap: Bitmap, dy: int) -> Bitmap:
    """Translate vertically by ``dy`` rows. Rows pushed off the edge are lost.

    Callers that must not lose pixels should clamp ``dy`` against
    :func:`content_bounds` first.
    """
    if dy == 0:
        return bitmap
    stride = bitmap.stride
    out = Bitmap.blank(bitmap.width, bitmap.height)
    for y in range(bitmap.height):
        target = y + dy
        if 0 <= target < bitmap.height:
            out.bits[target * stride : (target + 1) * stride] = bitmap.bits[
                y * stride : (y + 1) * stride
            ]
    return out


def encode_bmp(bitmap: Bitmap, *, top_down: bool = False) -> bytes:
    """Serialise to a 1-bpp Windows BMP.

    BMP stores rows bottom-up unless the height is negative. Even's sample
    images are bottom-up, which is the default here; ``top_down=True`` writes
    the negative-height variant if your firmware wants it.
    """
    stride = bitmap.stride
    pixel_bytes = stride * bitmap.height
    size = BMP_HEADER_SIZE + pixel_bytes

    header = struct.pack("<2sIHHI", b"BM", size, 0, 0, BMP_HEADER_SIZE)
    info = struct.pack(
        "<IiiHHIIiiII",
        _INFO_HEADER,
        bitmap.width,
        -bitmap.height if top_down else bitmap.height,
        1,      # planes
        1,      # bits per pixel
        0,      # BI_RGB
        pixel_bytes,
        2835,   # 72 dpi
        2835,
        2,      # palette entries used
        2,      # palette entries important
    )
    palette = struct.pack("<4B4B", 0, 0, 0, 0, 255, 255, 255, 0)

    rows = [
        bytes(bitmap.bits[y * stride : (y + 1) * stride]) for y in range(bitmap.height)
    ]
    if not top_down:
        rows.reverse()
    return header + info + palette + b"".join(rows)


def decode_bmp(data: bytes) -> Bitmap:
    """Read back a 1-bpp BMP produced by :func:`encode_bmp` (or by anything else)."""
    if len(data) < BMP_HEADER_SIZE or data[:2] != b"BM":
        raise ProtocolError("not a BMP file")
    offset = struct.unpack_from("<I", data, 10)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    bpp = struct.unpack_from("<H", data, 28)[0]
    if bpp != 1:
        raise ProtocolError(f"expected a 1-bit BMP, got {bpp} bits per pixel")
    top_down = height < 0
    height = abs(height)
    stride = row_stride(width)
    rows = [data[offset + i * stride : offset + (i + 1) * stride] for i in range(height)]
    if not top_down:
        rows.reverse()
    return Bitmap(width, height, bytearray(b"".join(rows)))


# ---------------------------------------------------------------------------
# Quantisation
# ---------------------------------------------------------------------------

def from_gray(
    gray: Sequence[int],
    width: int,
    height: int,
    *,
    threshold: int = 128,
    dither: bool = True,
) -> Bitmap:
    """Quantise an 8-bit grayscale buffer to 1 bit.

    Floyd-Steinberg by default: on a display this small, plain thresholding
    turns photographs into mud, while dithering keeps a readable impression of
    tone. Pass ``dither=False`` for line art, screenshots and text, where
    thresholding is sharper and dithering just adds noise.
    """
    if len(gray) < width * height:
        raise ProtocolError(
            f"grayscale buffer holds {len(gray)} samples, need {width * height}"
        )
    bitmap = Bitmap.blank(width, height)
    if not dither:
        for y in range(height):
            base = y * width
            for x in range(width):
                if gray[base + x] >= threshold:
                    bitmap.set(x, y, 1)
        return bitmap

    buf = [float(v) for v in gray[: width * height]]
    for y in range(height):
        base = y * width
        for x in range(width):
            old = buf[base + x]
            new = 255.0 if old >= threshold else 0.0
            if new:
                bitmap.set(x, y, 1)
            err = old - new
            if x + 1 < width:
                buf[base + x + 1] += err * 7 / 16
            if y + 1 < height:
                nb = base + width
                if x:
                    buf[nb + x - 1] += err * 3 / 16
                buf[nb + x] += err * 5 / 16
                if x + 1 < width:
                    buf[nb + x + 1] += err * 1 / 16
    return bitmap


def load_image(
    path: str,
    *,
    width: int = DISPLAY_WIDTH,
    height: int = DISPLAY_HEIGHT,
    dither: bool = True,
    threshold: int = 128,
    fit: str = "contain",
    safe_area: tuple[int, int] = (0, 0),
) -> Bitmap:
    """Load any image format and quantise it. Requires Pillow.

    ``fit`` is ``contain`` (letterbox, nothing cropped), ``cover`` (fill and
    crop the overflow) or ``stretch``.

    ``safe_area`` is ``(hidden_top, hidden_bottom)``: rows the wearer cannot
    actually see. Fitting happens inside the band that remains, and the
    result is pasted back at the right place on the full-size canvas. So a
    576x136 source with ``safe_area=(10, 10)`` is scaled down to 116 rows and
    parked in the middle — every pixel of it lands where it can be read,
    which is what you want when the top and bottom of the panel are cut off.
    """
    if fit not in ("contain", "cover", "stretch"):
        raise ValueError(f"fit must be contain, cover or stretch, not {fit!r}")
    hidden_top, hidden_bottom = safe_area
    if hidden_top < 0 or hidden_bottom < 0:
        raise ValueError("safe-area margins cannot be negative")
    box_height = height - hidden_top - hidden_bottom
    if box_height < 1:
        raise ValueError(
            f"safe area of {hidden_top}+{hidden_bottom} leaves no room on a "
            f"{height}px panel"
        )

    try:
        from PIL import Image  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on install
        raise UnsupportedFeature(
            "loading arbitrary image formats needs Pillow: pip install 'openg1[images]'. "
            "A 1-bit .bmp can be sent with Bitmap/decode_bmp and no extra dependency."
        ) from exc

    img = Image.open(path).convert("L")

    if fit == "stretch":
        img = img.resize((width, box_height))
    else:
        scale = (
            min(width / img.width, box_height / img.height)
            if fit == "contain"
            else max(width / img.width, box_height / img.height)
        )
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        )

    canvas = Image.new("L", (width, height), 0)
    # Centre horizontally, and vertically within the visible band.
    canvas.paste(
        img,
        (
            (width - img.width) // 2,
            hidden_top + (box_height - img.height) // 2,
        ),
    )
    # tobytes() on an "L" image is one byte per pixel, row-major — the same
    # thing getdata() yields, without the Pillow 14 deprecation.
    return from_gray(
        canvas.tobytes(), width, height, dither=dither, threshold=threshold
    )


# ---------------------------------------------------------------------------
# Transfer
# ---------------------------------------------------------------------------

def chunk_image(image: bytes, size: int = BMP_CHUNK_BYTES) -> list[bytes]:
    return [bytes(image[i : i + size]) for i in range(0, len(image), size)] or [b""]


MAX_TRANSFER_PACKETS = 256  # the chunk index is a single byte


def check_transfer_budget(size: int, chunk_size: int) -> int:
    """Refuse a transfer the one-byte chunk index cannot address.

    ``bmp_packet`` writes ``index & 0xFF``. Past 256 chunks that silently
    wraps, and the firmware has no way to tell chunk 0 from chunk 256 — the
    tail of the file lands on top of the head. A 576x136 image is 9854 bytes,
    so anything below a 39-byte chunk wraps.

    Chunk size follows the negotiated MTU, so this fires when MTU negotiation
    did not happen: a 23-byte default MTU leaves 14 bytes of payload and 704
    chunks. The protocol expects 194.
    """
    if chunk_size < 1:
        raise ProtocolError(
            f"chunk size resolved to {chunk_size} bytes — the negotiated MTU "
            "is too small to carry a bitmap packet at all"
        )
    needed = -(-size // chunk_size)
    if needed > MAX_TRANSFER_PACKETS:
        raise ProtocolError(
            f"{size} bytes at {chunk_size} bytes per chunk needs {needed} "
            f"chunks, but the chunk index is one byte and wraps after "
            f"{MAX_TRANSFER_PACKETS}. The chunk size follows the negotiated "
            f"MTU; this one implies about {chunk_size + 6}. Ask for a larger "
            f"MTU (the protocol assumes {BMP_CHUNK_BYTES}-byte chunks, which "
            f"needs roughly 244)."
        )
    return needed


def transfer_packets(
    image: bytes,
    *,
    chunk_size: int = BMP_CHUNK_BYTES,
    address: bytes = BMP_STORAGE_ADDRESS,
) -> tuple[list[Outbound], Outbound, Outbound]:
    """Build the whole three-phase transfer.

    Returns ``(data_packets, end_packet, crc_packet)``. Send the data packets
    in order — both arms may be written concurrently for these, since this is
    a store, not a display update — then the end marker, then the CRC once the
    end marker is acknowledged.
    """
    chunks = chunk_image(image, chunk_size)
    packets = [bmp_packet(i, c, first=(i == 0)) for i, c in enumerate(chunks)]
    return packets, bmp_end(), bmp_crc(compute_bmp_crc(image, address))


def validate_for_display(image: bytes) -> None:
    """Warn early about images the panel will refuse or render wrong."""
    bitmap = decode_bmp(image)
    if (bitmap.width, bitmap.height) != (DISPLAY_WIDTH, DISPLAY_HEIGHT):
        raise ProtocolError(
            f"the panel is {DISPLAY_WIDTH}x{DISPLAY_HEIGHT}; this image is "
            f"{bitmap.width}x{bitmap.height}"
        )


def iter_chunk_indices(count: int) -> Iterable[int]:
    return range(count)
