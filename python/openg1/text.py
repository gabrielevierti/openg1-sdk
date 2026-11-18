"""Turning a string into 0x4E packets.

The glasses do not wrap text. They render what you send on the line you send
it, and anything past the display edge is simply gone. So the SDK has to lay
the text out itself, which means knowing how wide each glyph is — and the
firmware exposes no font metrics at all.

:class:`FontMetrics` is therefore an estimate, calibrated against Even's own
demo app (488 px of usable width at a 21 px font, five lines per screen). It is
deliberately a plain object you can replace: if you measure the real advance
widths, drop in your own and every layout in the SDK gets better at once.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Iterator

from ._generated import (
    DEFAULT_FONT_PX,
    DEFAULT_LINES_PER_SCREEN,
    TEXT_WIDTH,
    ScreenAction,
    ScreenStatus,
)
from .commands import Outbound, send_text

#: Advance width as a fraction of the font size, by character class.
_NARROW = set("iljt.,;:!'`|()[]{}/\\-")
_WIDE = set("mwMW@%&")
_UPPER_LIKE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#")


@dataclass(frozen=True)
class FontMetrics:
    """Estimated glyph advances for the on-glasses font."""

    size_px: int = DEFAULT_FONT_PX
    narrow: float = 0.30
    space: float = 0.28
    normal: float = 0.52
    upper: float = 0.62
    wide: float = 0.85
    fullwidth: float = 1.00

    def advance(self, ch: str) -> float:
        if ch == " ":
            return self.size_px * self.space
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            return self.size_px * self.fullwidth
        if ch in _NARROW:
            return self.size_px * self.narrow
        if ch in _WIDE:
            return self.size_px * self.wide
        if ch in _UPPER_LIKE:
            return self.size_px * self.upper
        return self.size_px * self.normal

    def measure(self, text: str) -> float:
        return sum(self.advance(c) for c in text)


DEFAULT_METRICS = FontMetrics()


def wrap(
    text: str,
    *,
    width_px: int = TEXT_WIDTH,
    metrics: FontMetrics = DEFAULT_METRICS,
) -> list[str]:
    """Break *text* into lines that fit ``width_px``.

    Explicit newlines are honoured. Words longer than a full line are broken
    mid-word rather than dropped, and CJK text breaks between any two
    characters since it has no spaces to break on.
    """
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for word in _tokenise(paragraph):
            candidate = current + word
            if current and metrics.measure(candidate.rstrip()) > width_px:
                lines.append(current.rstrip())
                current = word.lstrip() if word.strip() else ""
            else:
                current = candidate
            while metrics.measure(current) > width_px and len(current) > 1:
                cut = _longest_prefix(current, width_px, metrics)
                lines.append(current[:cut])
                current = current[cut:]
        lines.append(current.rstrip())
    return lines


def _tokenise(paragraph: str) -> Iterator[str]:
    """Split into break opportunities: words with trailing spaces, or single
    CJK characters."""
    buf = ""
    for ch in paragraph:
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            if buf:
                yield buf
                buf = ""
            yield ch
        elif ch == " ":
            buf += ch
            yield buf
            buf = ""
        else:
            buf += ch
    if buf:
        yield buf


def _longest_prefix(text: str, width_px: int, metrics: FontMetrics) -> int:
    total = 0.0
    for i, ch in enumerate(text):
        total += metrics.advance(ch)
        if total > width_px:
            return max(1, i)
    return len(text)


@dataclass
class Screen:
    """One screenful of text, already wrapped."""

    lines: list[str] = field(default_factory=list)

    def encode(self) -> bytes:
        return "\n".join(self.lines).encode("utf-8")


def paginate(
    text: str,
    *,
    width_px: int = TEXT_WIDTH,
    lines_per_screen: int = DEFAULT_LINES_PER_SCREEN,
    metrics: FontMetrics = DEFAULT_METRICS,
) -> list[Screen]:
    """Wrap *text* and group the lines into screens."""
    lines = wrap(text, width_px=width_px, metrics=metrics)
    return [
        Screen(lines[i : i + lines_per_screen])
        for i in range(0, max(len(lines), 1), lines_per_screen)
    ] or [Screen([""])]


def split_utf8(data: bytes, limit: int) -> list[bytes]:
    """Chop *data* into pieces of at most *limit* bytes without splitting a
    UTF-8 sequence.

    The glasses render each packet's bytes as they arrive; a torn multi-byte
    character shows up as a replacement glyph and stays wrong for the rest of
    the screen.
    """
    if limit < 4:
        raise ValueError("limit must leave room for a 4-byte UTF-8 sequence")
    pieces: list[bytes] = []
    start = 0
    while start < len(data):
        end = min(start + limit, len(data))
        if end < len(data):
            while end > start and (data[end] & 0xC0) == 0x80:
                end -= 1
            if end == start:  # pathological: single oversized sequence
                end = min(start + limit, len(data))
        pieces.append(data[start:end])
        start = end
    return pieces or [b""]


def screen_status(
    *,
    new_content: bool = True,
    mode: int = ScreenStatus.TEXT_SHOW,
) -> int:
    """Compose the 0x4E status byte from its two nibbles."""
    low = ScreenAction.NEW_CONTENT if new_content else 0x00
    return (int(mode) & 0xF0) | (int(low) & 0x0F)


def text_packets(
    text: str,
    *,
    seq: int = 0,
    max_data: int = 167,
    width_px: int = TEXT_WIDTH,
    lines_per_screen: int = DEFAULT_LINES_PER_SCREEN,
    metrics: FontMetrics = DEFAULT_METRICS,
    mode: int = ScreenStatus.TEXT_SHOW,
) -> list[list[Outbound]]:
    """Full pipeline: string in, one packet list per screen out.

    ``max_data`` is the payload budget per packet — the negotiated write size
    minus the nine header bytes. The session computes it; the default matches
    a 176-byte write.
    """
    screens = paginate(
        text, width_px=width_px, lines_per_screen=lines_per_screen, metrics=metrics
    )
    total_pages = len(screens)
    status = screen_status(mode=mode)
    out: list[list[Outbound]] = []
    for page_index, screen in enumerate(screens):
        pieces = split_utf8(screen.encode(), max_data)
        out.append(
            [
                send_text(
                    piece,
                    seq=(seq + page_index) & 0xFF,
                    total_packages=len(pieces),
                    package_index=i,
                    screen_status=status,
                    page=page_index + 1,
                    max_page=total_pages,
                )
                for i, piece in enumerate(pieces)
            ]
        )
    return out


def preview(
    text: str,
    *,
    width_px: int = TEXT_WIDTH,
    lines_per_screen: int = DEFAULT_LINES_PER_SCREEN,
    metrics: FontMetrics = DEFAULT_METRICS,
) -> str:
    """Render the layout as ASCII art, for checking wrapping without hardware."""
    screens = paginate(
        text, width_px=width_px, lines_per_screen=lines_per_screen, metrics=metrics
    )
    cols = max(24, int(width_px / (metrics.size_px * metrics.normal)))
    parts: list[str] = []
    for i, screen in enumerate(screens, 1):
        parts.append(f"+{'-' * cols}+  screen {i}/{len(screens)}")
        for line in screen.lines:
            parts.append(f"|{line[:cols]:<{cols}}|")
        for _ in range(lines_per_screen - len(screen.lines)):
            parts.append(f"|{'':<{cols}}|")
        parts.append(f"+{'-' * cols}+")
    return "\n".join(parts)


def fits(text: str, *, width_px: int = TEXT_WIDTH, metrics: FontMetrics = DEFAULT_METRICS) -> bool:
    return metrics.measure(text) <= width_px


__all__ = [
    "FontMetrics",
    "DEFAULT_METRICS",
    "Screen",
    "wrap",
    "paginate",
    "split_utf8",
    "screen_status",
    "text_packets",
    "preview",
    "fits",
]

