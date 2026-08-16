"""Exception hierarchy. Everything the SDK raises inherits from OpenG1Error."""

from __future__ import annotations


class OpenG1Error(Exception):
    """Base class for every error this SDK raises."""


class TransportError(OpenG1Error):
    """The BLE layer failed: no adapter, write rejected, link dropped."""


class NotConnectedError(TransportError):
    pass


class DiscoveryError(OpenG1Error):
    """Scanning finished without finding a usable pair of arms."""


class ProtocolError(OpenG1Error):
    """A packet could not be built or parsed."""


class PacketTooLargeError(ProtocolError):
    def __init__(self, size: int, limit: int) -> None:
        super().__init__(
            f"packet is {size} bytes but the negotiated MTU only allows {limit}; "
            "raise the MTU or split the payload"
        )
        self.size = size
        self.limit = limit


class CommandError(OpenG1Error):
    """The glasses answered, and the answer was a refusal."""

    def __init__(self, command: str, status: int, arm: str | None = None) -> None:
        where = f" on the {arm} arm" if arm else ""
        super().__init__(f"{command} failed with status 0x{status:02X}{where}")
        self.command = command
        self.status = status
        self.arm = arm


class CommandTimeout(OpenG1Error):
    def __init__(self, command: str, timeout: float, arm: str | None = None) -> None:
        where = f" on the {arm} arm" if arm else ""
        super().__init__(f"{command} got no reply within {timeout}s{where}")
        self.command = command
        self.timeout = timeout
        self.arm = arm


class UnsupportedFeature(OpenG1Error):
    """The feature exists in the protocol but needs an optional dependency."""


class ParityError(OpenG1Error):
    """The simulator would show something the glasses would not.

    Raised only in strict mode. The point of a simulator is that what you
    build in it is what you ship, so a divergence is an error, not a note.
    """
