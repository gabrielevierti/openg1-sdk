"""Constants shared by the simulator app and the SDK's network transport.

Kept in its own module so ``openg1sim`` does not import ``openg1.transport.net``
just to learn a port number, and so changing the wire format means editing
one file that both sides read.
"""

from openg1.transport.net import DEFAULT_PORT as GLASSES_PORT
from openg1.transport.net import HELLO_SIZE, MAGIC, PROTOCOL_VERSION

__all__ = ["GLASSES_PORT", "HELLO_SIZE", "MAGIC", "PROTOCOL_VERSION"]
