"""Microphone capture."""

from __future__ import annotations

import asyncio
import contextlib

from .. import commands as cmd
from ..events import AudioEvent
from ..lc3 import AudioBuffer
from ..session import Session


class Audio:
    """The right arm's microphone.

    The firmware caps a capture at about thirty seconds and stops on its own;
    :meth:`record` respects that by default rather than letting you wait
    forever for frames that will never come.
    """

    MAX_CAPTURE_S = 30.0

    def __init__(self, session: Session) -> None:
        self._s = session
        self._buffer = AudioBuffer()
        self._unsub = None

    @property
    def buffer(self) -> AudioBuffer:
        return self._buffer

    async def start(self) -> AudioBuffer:
        """Enable the mic and begin collecting frames."""
        self._buffer = AudioBuffer()
        if self._unsub is None:
            self._unsub = self._s.on(AudioEvent, self._collect)
        await self._s.send(cmd.mic_control(True))
        return self._buffer

    async def stop(self) -> AudioBuffer:
        with contextlib.suppress(Exception):
            await self._s.send(cmd.mic_control(False))
        if self._unsub:
            self._unsub()
            self._unsub = None
        return self._buffer

    async def record(self, seconds: float = 5.0) -> AudioBuffer:
        """Capture for *seconds* and return the frames."""
        if seconds > self.MAX_CAPTURE_S:
            raise ValueError(
                f"the firmware stops capturing after about {self.MAX_CAPTURE_S:.0f}s; "
                "call start()/stop() yourself and restart the mic if you need more"
            )
        await self.start()
        try:
            await asyncio.sleep(seconds)
        finally:
            await self.stop()
        return self._buffer

    def _collect(self, event: AudioEvent) -> None:
        self._buffer.add(event.seq, event.data)

    async def __aenter__(self) -> AudioBuffer:
        return await self.start()

    async def __aexit__(self, *exc) -> None:
        await self.stop()
