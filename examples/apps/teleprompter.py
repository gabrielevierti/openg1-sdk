"""Read a script off the glasses, advancing with the touchbar.

    OPENG1_SIMULATOR=1 python3 examples/apps/teleprompter.py notes.txt

    tap         next chunk
    double tap  previous chunk
    head up     repeat the current chunk

Shows how to page long text yourself instead of letting `display.text` do it
on a timer: you get to decide when the wearer moves on, which is the whole
point of a teleprompter.

It also shows the layout rule that matters. `screen.lines` is how many lines
this device actually has — fewer than five if rows are hidden — so the
chunking adapts instead of quietly losing the last line.
"""

import pathlib
import sys
import textwrap

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from openg1.app import App, run  # noqa: E402

CHARS_PER_LINE = 38  # comfortable at the default font on a 576px panel

SAMPLE = """
Buongiorno. Today I want to talk about why an open SDK for a discontinued
pair of smart glasses is worth building at all.
The answer is that the hardware still works. The company moved on; the
radio did not. Everything the official app could do, the glasses can still
do, and the protocol is knowable.
That is the whole argument. Thank you.
"""


class Teleprompter(App):
    name = "teleprompter"
    description = "paged script, advanced by tap"

    def __init__(self, text: str = SAMPLE) -> None:
        super().__init__()
        self.text = " ".join(text.split())
        self.chunks: list[str] = []
        self.index = 0

    async def start(self) -> None:
        # Chunking happens here, not in __init__, because it depends on
        # screen.lines and the screen does not exist until the app attaches.
        wrapped = textwrap.wrap(self.text, CHARS_PER_LINE)
        per_screen = self.screen.lines
        self.chunks = [
            "\n".join(wrapped[i : i + per_screen])
            for i in range(0, len(wrapped), per_screen)
        ] or [""]
        await self.refresh()

    async def on_tap(self, event) -> None:
        if event.gesture == "double_tap":
            self.index = max(0, self.index - 1)
        else:
            self.index = min(len(self.chunks) - 1, self.index + 1)
        await self.refresh()

    async def on_head(self, event) -> None:
        if event.up:
            await self.refresh()

    async def refresh(self) -> None:
        await self.screen.show(self.chunks[self.index])


if __name__ == "__main__":
    source = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else None
    body = pathlib.Path(source).read_text() if source else SAMPLE
    run(Teleprompter(body))
