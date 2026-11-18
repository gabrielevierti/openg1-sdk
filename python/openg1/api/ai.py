"""The Even AI loop, minus Even's cloud.

The hardware side of "Even AI" is just three things: a hold on the left
touchbar, a microphone stream, and paginated text with a particular status
nibble. None of it is tied to Even's servers. Give :class:`EvenAI` a function
that turns audio into an answer and you have the same feature pointed at
whatever model you like — or at nothing at all, if you would rather bind the
gesture to something else entirely.

    async def answer(audio: AudioBuffer) -> str:
        return my_llm(my_stt(audio.decode_pcm()))

    await g1.ai.run(answer)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Awaitable, Callable

from .._generated import ScreenStatus
from ..events import AiRequestEvent, AiStopEvent, TouchEvent
from ..lc3 import AudioBuffer
from ..session import Session
from .audio import Audio
from .display import Display

log = logging.getLogger("openg1.ai")

Responder = Callable[[AudioBuffer], "Awaitable[str] | str"]


class EvenAI:
    def __init__(self, session: Session) -> None:
        self._s = session
        self._audio = Audio(session)
        self._display = Display(session)
        self._task: asyncio.Task | None = None

    async def run(
        self,
        responder: Responder,
        *,
        max_record_s: float = 20.0,
        thinking_message: str = "...",
    ) -> None:
        """Handle one interaction, from touchbar hold to answer on screen."""
        await self._s.wait_for(AiRequestEvent, timeout=3600)
        await self._capture_and_answer(responder, max_record_s, thinking_message)

    def listen(
        self,
        responder: Responder,
        *,
        max_record_s: float = 20.0,
        thinking_message: str = "...",
    ) -> Callable[[], None]:
        """Handle every interaction, indefinitely. Returns a stop function."""

        async def loop() -> None:
            while True:
                try:
                    await self.run(
                        responder,
                        max_record_s=max_record_s,
                        thinking_message=thinking_message,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("AI interaction failed")
                    with contextlib.suppress(Exception):
                        await self.show("Something went wrong", error=True)

        self._task = asyncio.create_task(loop(), name="openg1-even-ai")

        def stop() -> None:
            if self._task:
                self._task.cancel()
                self._task = None

        return stop

    async def _capture_and_answer(
        self, responder: Responder, max_record_s: float, thinking_message: str
    ) -> None:
        buffer = await self._audio.start()
        try:
            # Whichever comes first: the wearer lets go, or the firmware's own
            # capture limit runs out.
            with contextlib.suppress(asyncio.TimeoutError):
                await self._s.wait_for(AiStopEvent, timeout=max_record_s)
        finally:
            await self._audio.stop()

        if thinking_message:
            await self.show(thinking_message, done=False)

        result = responder(buffer)
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[misc]
        await self.show(str(result))

    async def show(
        self,
        text: str,
        *,
        done: bool = True,
        manual: bool = False,
        error: bool = False,
    ) -> None:
        """Display an answer with the Even AI status nibble set.

        The nibble is what makes the glasses treat this as an AI response
        rather than plain text: it drives the page indicator and lets the
        touchbar page through the result.
        """
        if error:
            mode = ScreenStatus.EVEN_AI_NETWORK_ERROR
        elif manual:
            mode = ScreenStatus.EVEN_AI_MANUAL
        elif done:
            mode = ScreenStatus.EVEN_AI_COMPLETE
        else:
            mode = ScreenStatus.EVEN_AI_DISPLAYING
        await self._display.text(text, mode=mode, page_delay=3.0)

    async def paged(self, text: str) -> Callable[[], None]:
        """Show a long answer and let the wearer page it with the touchbar.

        Left tap goes back, right tap goes forward, exactly as the official
        app behaves. Returns a function that stops handling taps.
        """
        from .. import text as text_mod
        from .._generated import Arm

        screens = text_mod.paginate(text)
        index = 0

        async def render() -> None:
            await self._display.text_page(
                "\n".join(screens[index].lines),
                page=index + 1,
                max_page=len(screens),
                mode=ScreenStatus.EVEN_AI_MANUAL,
            )

        async def on_tap(event: TouchEvent) -> None:
            nonlocal index
            if event.gesture != "single_tap":
                return
            step = -1 if event.arm is Arm.LEFT else 1
            new = min(max(index + step, 0), len(screens) - 1)
            if new != index:
                index = new
                await render()

        await render()
        return self._s.on(TouchEvent, on_tap)
