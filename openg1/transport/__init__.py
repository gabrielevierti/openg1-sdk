"""Transport abstraction.

Everything above this line is pure protocol; everything below it is radios.
The session only needs four things from a transport — connect, disconnect,
write, and a callback for inbound notifications — which is what keeps the SDK
portable to whatever BLE stack you already have — and what lets ``openg1sim``
substitute a whole emulated pair from outside the library.

Bring your own by implementing :class:`Transport`; nothing else needs to know.
"""

from __future__ import annotations

import abc
from typing import Awaitable, Callable

NotifyHandler = Callable[[bytes], "Awaitable[None] | None"]


class Transport(abc.ABC):
    """One BLE link to one arm."""

    #: Human-readable identity, used in logs and errors.
    name: str = "?"
    address: str = "?"

    @abc.abstractmethod
    async def connect(self) -> None: ...

    @abc.abstractmethod
    async def disconnect(self) -> None: ...

    @abc.abstractmethod
    async def write(self, data: bytes) -> None:
        """Write one protocol packet. Must not split it across ATT writes."""

    @property
    @abc.abstractmethod
    def is_connected(self) -> bool: ...

    @property
    def max_write(self) -> int:
        """Largest packet this link can carry in a single write."""
        return 20

    def on_notify(self, handler: NotifyHandler) -> None:
        self._notify_handler = handler

    async def _emit(self, data: bytes) -> None:
        handler = getattr(self, "_notify_handler", None)
        if handler is None:
            return
        result = handler(data)
        if hasattr(result, "__await__"):
            await result  # type: ignore[misc]


def __getattr__(name: str):  # lazy so importing openg1 never pulls in bleak
    if name in ("BleakTransport", "scan", "discover_pair"):
        from .bleak_transport import BleakTransport, discover_pair, scan

        return {"BleakTransport": BleakTransport, "scan": scan, "discover_pair": discover_pair}[name]
    raise AttributeError(name)


__all__ = [
    "Transport",
    "NotifyHandler",
    "BleakTransport",
    "scan",
    "discover_pair",
]
