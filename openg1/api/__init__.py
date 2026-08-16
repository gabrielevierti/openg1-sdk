"""Feature namespaces hanging off :class:`openg1.G1`.

Each module owns one area of the device and turns multi-packet protocol
choreography into a single awaitable. Nothing here holds state the session
does not already have, so they are cheap to construct and safe to hold on to.
"""

from .display import Display
from .audio import Audio
from .dashboard import Dashboard
from .notifications import Notifications
from .settings import Settings
from .navigation import Navigation
from .ai import EvenAI
from .info import DeviceInfo

__all__ = [
    "Display",
    "Audio",
    "Dashboard",
    "Notifications",
    "Settings",
    "Navigation",
    "EvenAI",
    "DeviceInfo",
]
