"""Turning what the glasses were told into what the wearer would see.

The SDK's emulator records state: the text of the current screen, the bytes of
the last image, whether the dashboard is open. This module renders that state
onto a framebuffer, which is the part that catches the mistakes a byte log
cannot — a line that overflows the panel, a paragraph that needed four screens
and got one, an image that dithered into an unreadable smear.

Two things this deliberately does not claim:

  * It is not pixel-accurate. The firmware's font is proportional and not
    published; this one is a 5x7 cell font. Lines here run slightly short of
    the real thing rather than slightly long, which is the safer direction if
    you are checking whether your text fits.
  * It is not a physics model of the optics. The real display is a green
    monochrome waveguide with its own brightness curve and a limited field of
    view. What you get here is the bitmap that would be fed to it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import font
from .framebuffer import DISPLAY_HEIGHT, DISPLAY_WIDTH, Framebuffer, Region

#: The usable text column. The panel is 576 wide but the firmware keeps a
#: margin, which is where the spec's 488 pixel text width comes from.
TEXT_MARGIN_X = (DISPLAY_WIDTH - 488) // 2
TEXT_REGION = Region(TEXT_MARGIN_X, 8, 488, DISPLAY_HEIGHT - 16)

#: Screen status high nibbles, from the protocol spec.
MODE_AI_DISPLAYING = 0x30
MODE_AI_COMPLETE = 0x40
MODE_AI_MANUAL = 0x50
MODE_AI_ERROR = 0x60
MODE_TEXT = 0x70

_MODE_LABELS = {
    MODE_AI_DISPLAYING: "AI",
    MODE_AI_COMPLETE: "AI",
    MODE_AI_MANUAL: "AI",
    MODE_AI_ERROR: "AI — network error",
}


@dataclass
class PanelState:
    """Everything the renderer needs, gathered in one place."""

    text: str = ""
    mode: int = MODE_TEXT
    page: int = 1
    max_page: int = 1
    image: bytes = b""
    image_valid: bool | None = None
    dashboard_open: bool = False
    battery: int = 87
    brightness: int = 21
    silent: bool = False
    time_label: str = ""
    weather_label: str = ""
    notification: str = ""
    #: Set when the wearer is not wearing them: the real panel powers down.
    worn: bool = True
    head_up: bool = True
    #: Glyphs are drawn 2 wide by 3 tall. Condensed, on purpose: it matches
    #: the character density of the firmware's proportional font far better
    #: than square scaling does. See :mod:`openg1sim.font`.
    scale_x: int = 2
    scale_y: int = 3
    #: Zero leading gives 24-pixel lines, so five fit the panel — which is
    #: what the spec says the firmware manages at its default size.
    leading: int = 0


class Panel:
    """Renders :class:`PanelState` into a framebuffer."""

    def __init__(self, width: int = DISPLAY_WIDTH, height: int = DISPLAY_HEIGHT) -> None:
        self.width = width
        self.height = height
        self.frame = Framebuffer(width, height)
        #: Set by :meth:`render` when a drawn line ran past the text column.
        #: The point of a simulator is to notice this before the hardware does.
        self.overflow: list[str] = []
        self.truncated_lines = 0

    # -- layout ------------------------------------------------------------

    def columns(self, scale_x: int = 2) -> int:
        return TEXT_REGION.width // font.advance(scale_x)

    def rows(self, scale_y: int = 3, leading: int = 0) -> int:
        return TEXT_REGION.height // font.line_height(scale_y, leading)

    def wrap(self, text: str, scale_x: int = 2) -> list[str]:
        """Wrap to the panel's own column count.

        This is the simulator's own wrapping, in its own font. The SDK's
        ``openg1.text.wrap`` estimates the *firmware's* proportional font; the two
        will not always agree, and where they disagree the SDK is the one to
        trust for what the glasses will do. This one answers a narrower
        question: what does the picture look like.
        """
        limit = self.columns(scale_x)
        lines: list[str] = []
        for paragraph in text.split("\n"):
            if not paragraph:
                lines.append("")
                continue
            line = ""
            for word in paragraph.split(" "):
                candidate = word if not line else f"{line} {word}"
                if len(candidate) <= limit:
                    line = candidate
                    continue
                if line:
                    lines.append(line)
                while len(word) > limit:
                    lines.append(word[:limit])
                    word = word[limit:]
                line = word
            lines.append(line)
        return lines

    # -- rendering ---------------------------------------------------------

    def render(self, state: PanelState) -> Framebuffer:
        self.frame.clear()
        self.overflow = []
        self.truncated_lines = 0

        if not state.worn:
            # Wear detection blanks the display on the real hardware. Showing
            # a blank panel is more honest than showing content nobody sees.
            self._render_off("not worn")
            return self.frame

        if not state.head_up:
            self._render_off("head down")
            return self.frame

        if state.image:
            self._render_image(state)
        elif state.dashboard_open:
            self._render_dashboard(state)
        else:
            self._render_text(state)

        if state.notification:
            self._render_notification(state)

        return self.frame

    def _render_off(self, reason: str) -> None:
        label = f"[display off — {reason}]"
        x = (self.width - font.text_width(label, 2)) // 2
        y = (self.height - font.CELL_HEIGHT * 2) // 2
        self.frame.draw_text(label, max(0, x), y, 2, 2)

    def _render_text(self, state: PanelState) -> None:
        scale_x, scale_y, leading = state.scale_x, state.scale_y, state.leading
        lines = self.wrap(state.text, scale_x)
        capacity = self.rows(scale_y, leading)

        header = 0
        label = _MODE_LABELS.get(state.mode)
        if label:
            # The AI modes draw a small header on the real display.
            self.frame.draw_text(label, TEXT_REGION.x, 2, 2, 2)
            self.frame.hline(TEXT_REGION.x, 2 + font.CELL_HEIGHT * 2 + 2, TEXT_REGION.width)
            header = font.CELL_HEIGHT * 2 + 8
            capacity = (TEXT_REGION.height - header) // font.line_height(scale_y, leading)

        if len(lines) > capacity:
            self.truncated_lines = len(lines) - capacity
            lines = lines[:capacity]

        step = font.line_height(scale_y, leading)
        for index, line in enumerate(lines):
            if font.text_width(line, scale_x) > TEXT_REGION.width:
                self.overflow.append(line)
            self.frame.draw_text(
                line, TEXT_REGION.x, TEXT_REGION.y + header + index * step, scale_x, scale_y
            )

        if state.max_page > 1:
            self._render_page_marker(state)

    def _render_page_marker(self, state: PanelState) -> None:
        label = f"{state.page}/{state.max_page}"
        x = self.width - TEXT_MARGIN_X - font.text_width(label, 2)
        y = self.height - font.CELL_HEIGHT * 2 - 2
        self.frame.draw_text(label, x, y, 2, 2)

    def _render_image(self, state: PanelState) -> None:
        try:
            self.frame.blit_bmp(state.image)
        except ValueError as error:
            self.frame.draw_text(f"[bad image: {error}]", TEXT_REGION.x, 40, 2, 2)
            return
        if state.image_valid is False:
            # The glasses reject a bad CRC outright. Say so rather than showing
            # an image the wearer would never have seen.
            self.frame.fill_rect(0, 0, self.width, 22, False)
            self.frame.draw_text("[CRC rejected]", TEXT_REGION.x, 4, 2, 2)

    def _render_dashboard(self, state: PanelState) -> None:
        """The dashboard: time and weather left, status right.

        The real layout is configurable and this is one plausible arrangement,
        not a reproduction. It exists so that opening the dashboard in a test
        shows something recognisable rather than a blank panel.
        """
        self.frame.draw_text(state.time_label or "--:--", TEXT_REGION.x, 12, 4, 5)
        if state.weather_label:
            self.frame.draw_text(state.weather_label, TEXT_REGION.x, 12 + 48, 2, 2)

        status = f"{state.battery}%"
        if state.silent:
            status += "  silent"
        x = self.width - TEXT_MARGIN_X - font.text_width(status, 2)
        self.frame.draw_text(status, x, 12, 2, 2)

        self.frame.hline(TEXT_REGION.x, self.height - 26, TEXT_REGION.width)
        if state.text:
            self.frame.draw_text(self.wrap(state.text)[0], TEXT_REGION.x, self.height - 20, 2, 2)

    def _render_notification(self, state: PanelState) -> None:
        """Notifications overlay the bottom of the panel, inverted."""
        lines = self.wrap(state.notification)[:2]
        step = font.line_height(2, 1)
        box_height = step * len(lines) + 6
        y = self.height - box_height
        self.frame.fill_rect(0, y, self.width, box_height, True)
        for index, line in enumerate(lines):
            self.frame.draw_text(line, TEXT_REGION.x, y + 3 + index * step, 2, 2, on=False)


@dataclass
class RenderReport:
    """What the renderer noticed. Assertions in tests read this.

    ``lines`` counts lines in the *simulator's* font, and ``sdk_lines`` counts
    what :func:`openg1.text.wrap` predicted for the *firmware's* font. They
    disagree, and the disagreement is the useful part.

    The firmware's font is proportional — an "l" is far narrower than an "m" —
    and the SDK estimates it per character class. The simulator draws a 5x7
    cell font where every character is the same width, so it fits fewer
    characters per line and reports overflow sooner. Where the two disagree,
    the SDK is the better guide to what the glasses will actually do.

    So read a truncation warning as "this is tight, look at it" rather than
    "this is broken". The reverse is the one to worry about: if the simulator
    says it fits, it will fit.
    """

    lit_pixels: int
    lines: int
    truncated_lines: int
    overflow: list[str] = field(default_factory=list)
    sdk_lines: int | None = None

    @property
    def fits(self) -> bool:
        """True when the picture, as drawn here, fits the panel."""
        return self.truncated_lines == 0 and not self.overflow

    @property
    def disagrees_with_sdk(self) -> bool:
        """True when the two font models predict different line counts."""
        return self.sdk_lines is not None and self.sdk_lines != self.lines
