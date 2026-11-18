"""Microphone audio: reassembly, container writing, optional decoding.

The G1 streams LC3 (the Bluetooth LE Audio codec), not PCM. Decoding it needs
a real codec, so the SDK does the parts it can do honestly — ordering frames,
spotting gaps, writing files — and hands decoding to ``liblc3`` if you have it.

Even without a decoder this is useful: an ``.lc3`` dump feeds straight into
``ffmpeg``, and most speech-to-text services accept it.
"""

from __future__ import annotations

import struct
import wave
from dataclasses import dataclass, field

from .errors import UnsupportedFeature

#: The G1 microphone stream, as far as it has been characterised.
SAMPLE_RATE = 16000
FRAME_DURATION_US = 10000
FRAME_BYTES = 20


@dataclass
class AudioBuffer:
    """Collects LC3 frames and puts them back in order.

    BLE notifications can arrive out of order and the 8-bit sequence wraps
    every 256 frames — about 2.5 seconds. Wrap detection assumes frames are
    never late by more than half the sequence space, which holds comfortably
    at this frame rate.
    """

    frames: dict[int, bytes] = field(default_factory=dict)
    _last_seq: int | None = field(default=None, repr=False)
    _epoch: int = field(default=0, repr=False)

    def add(self, seq: int, data: bytes) -> None:
        if self._last_seq is not None and seq < self._last_seq - 128:
            self._epoch += 256
        self._last_seq = seq
        self.frames[self._epoch + seq] = bytes(data)

    @property
    def frame_count(self) -> int:
        return len(self.frames)

    @property
    def duration_s(self) -> float:
        return self.frame_count * FRAME_DURATION_US / 1_000_000

    def missing(self) -> list[int]:
        """Indices dropped by the link. A few is normal; many means the host
        is not draining notifications fast enough."""
        if not self.frames:
            return []
        keys = sorted(self.frames)
        return [i for i in range(keys[0], keys[-1] + 1) if i not in self.frames]

    def raw(self) -> bytes:
        return b"".join(self.frames[k] for k in sorted(self.frames))

    def clear(self) -> None:
        self.frames.clear()
        self._last_seq = None
        self._epoch = 0

    def write_lc3(self, path: str) -> None:
        """Write an LC3 file with the standard header ffmpeg expects."""
        payload = self.raw()
        header = struct.pack(
            "<HHHHHHHI",
            0x1C7C,                     # magic
            18,                         # header size
            SAMPLE_RATE // 100,
            0,                          # bitrate, unknown for this stream
            1,                          # channels
            FRAME_DURATION_US // 10,
            0,                          # rfu
            len(payload) // FRAME_BYTES,
        )
        with open(path, "wb") as fh:
            fh.write(header)
            fh.write(payload)

    def decode_pcm(self) -> bytes:
        """Decode to 16-bit mono PCM. Requires ``pip install lc3``."""
        try:
            import lc3  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise UnsupportedFeature(
                "LC3 decoding needs liblc3: pip install 'openg1[audio]'. "
                "Without it you can still save the raw stream with write_lc3() "
                "and convert it with ffmpeg."
            ) from exc
        decoder = lc3.Decoder(FRAME_DURATION_US, SAMPLE_RATE)
        out = bytearray()
        for key in sorted(self.frames):
            out += decoder.decode(self.frames[key], bit_depth=16)
        return bytes(out)

    def write_wav(self, path: str) -> None:
        pcm = self.decode_pcm()
        with wave.open(path, "wb") as fh:
            fh.setnchannels(1)
            fh.setsampwidth(2)
            fh.setframerate(SAMPLE_RATE)
            fh.writeframes(pcm)
