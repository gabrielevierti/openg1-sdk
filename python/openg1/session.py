"""The session: two radios pretending to be one device.

Three things make G1 sessions harder than they look, and this module exists to
hide all three.

**Ordering.** Each arm is an independent peripheral. Except where the protocol
says otherwise, a command goes to the left arm, you wait for its
acknowledgement, and only then does it go to the right. Fire both at once and
the display tears — the two halves of the panel end up a frame apart. So all
sends funnel through one lock and one ordered path.

**Correlation.** Replies are not tagged with a request id. Framed commands echo
their sequence byte, which is enough; raw commands echo only the opcode, which
is enough only because sends are serialised. Both cases end up in the same
pending-reply table.

**Liveness.** No heartbeat for 32 seconds and the firmware drops the link, so a
background task sends one every 28 — on its own counter, separate from the
global sequence, because the firmware tracks the two independently.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Sequence, Type, TypeVar

from ._generated import HEARTBEAT_INTERVAL_S, Arm, Status
from .commands import Outbound, heartbeat, init, seq_sync
from .errors import CommandError, CommandTimeout, NotConnectedError, ProtocolError
from .events import Event, parse
from .framing import Packet, SequenceCounter, decode, encode_framed, encode_raw
from .transport import Transport

log = logging.getLogger("openg1.session")

E = TypeVar("E", bound=Event)
EventHandler = Callable[[Event], "Awaitable[None] | None"]

#: Bytes of protocol header a packet family costs, subtracted from the write size.
_RAW_OVERHEAD = 1
_FRAMED_OVERHEAD = 4


@dataclass
class Reply:
    """What one arm answered."""

    arm: Arm
    packet: Packet | None
    elapsed: float = 0.0

    @property
    def ok(self) -> bool:
        return self.packet is not None and self.packet.status in (None, Status.SUCCESS)

    @property
    def status(self) -> int | None:
        return self.packet.status if self.packet else None


@dataclass
class Response:
    """What both arms answered."""

    command: str
    replies: dict[Arm, Reply] = field(default_factory=dict)

    def __getitem__(self, arm: Arm) -> Reply:
        return self.replies[arm]

    @property
    def left(self) -> Reply | None:
        return self.replies.get(Arm.LEFT)

    @property
    def right(self) -> Reply | None:
        return self.replies.get(Arm.RIGHT)

    @property
    def ok(self) -> bool:
        return all(r.ok for r in self.replies.values())

    @property
    def any_packet(self) -> Packet | None:
        for reply in self.replies.values():
            if reply.packet is not None:
                return reply.packet
        return None

    def payload(self) -> bytes:
        packet = self.any_packet
        return packet.payload if packet else b""


class _Pending:
    """Futures waiting on a reply, keyed by (opcode, seq-or-None)."""

    def __init__(self) -> None:
        self._waiters: dict[tuple[int, int | None], deque[asyncio.Future]] = defaultdict(deque)

    #: Key used by replies that carry no opcode at all (see GET_FIRMWARE_INFO).
    ANY = (-1, None)

    def add(self, opcode: int, seq: int | None) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters[(opcode, seq)].append(fut)
        return fut

    def add_any(self) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters[self.ANY].append(fut)
        return fut

    def resolve(self, packet: Packet) -> bool:
        for key in ((packet.opcode, packet.seq), (packet.opcode, None), self.ANY):
            queue = self._waiters.get(key)
            while queue:
                fut = queue.popleft()
                if not fut.done():
                    fut.set_result(packet)
                    return True
        return False

    def discard(self, opcode: int, seq: int | None, fut: asyncio.Future) -> None:
        queue = self._waiters.get((opcode, seq) if opcode >= 0 else self.ANY)
        if queue and fut in queue:
            queue.remove(fut)

    def fail_all(self, exc: Exception) -> None:
        for queue in self._waiters.values():
            while queue:
                fut = queue.popleft()
                if not fut.done():
                    fut.set_exception(exc)


class Session:
    """Owns both transports and everything stateful about the connection."""

    def __init__(
        self,
        left: Transport,
        right: Transport,
        *,
        ack_timeout: float = 2.5,
        heartbeat_interval: float = HEARTBEAT_INTERVAL_S,
        auto_heartbeat: bool = True,
        strict: bool = True,
    ) -> None:
        self.transports: dict[Arm, Transport] = {Arm.LEFT: left, Arm.RIGHT: right}
        self.ack_timeout = ack_timeout
        self.heartbeat_interval = heartbeat_interval
        self.auto_heartbeat = auto_heartbeat
        #: When True, a FAILURE status raises. Turn it off while probing
        #: commands whose semantics are still guesswork.
        self.strict = strict

        self.seq = SequenceCounter()
        self.hb_seq = SequenceCounter()
        self._pending: dict[Arm, _Pending] = {Arm.LEFT: _Pending(), Arm.RIGHT: _Pending()}
        self._lock = asyncio.Lock()
        self._handlers: list[tuple[type, EventHandler]] = []
        self._event_queues: list[asyncio.Queue] = []
        self._hb_task: asyncio.Task | None = None
        self._started = False
        #: Every packet in and out, if you turn it on. The protocol is still
        #: being reverse engineered; a capture is often the whole answer.
        self.trace: list[tuple[float, Arm, str, bytes]] | None = None

    # -- lifecycle ---------------------------------------------------------

    async def start(self, *, handshake: bool = True) -> None:
        for arm, transport in self.transports.items():
            transport.on_notify(self._make_receiver(arm))
            if not transport.is_connected:
                await transport.connect()
        self._started = True

        if handshake:
            # What the official app does on connect: initialise the left arm,
            # then publish the sequence counter to the right.
            with contextlib.suppress(CommandTimeout, CommandError):
                await self.send(init())
            with contextlib.suppress(CommandTimeout, CommandError):
                await self.send(seq_sync())

        if self.auto_heartbeat and self._hb_task is None:
            self._hb_task = asyncio.create_task(self._heartbeat_loop(), name="openg1-heartbeat")

    async def stop(self) -> None:
        self._started = False
        if self._hb_task:
            self._hb_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._hb_task
            self._hb_task = None
        for pending in self._pending.values():
            pending.fail_all(NotConnectedError("session stopped"))
        for transport in self.transports.values():
            await transport.disconnect()

    async def __aenter__(self) -> "Session":
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.stop()

    @property
    def is_connected(self) -> bool:
        return all(t.is_connected for t in self.transports.values())

    # -- sending -----------------------------------------------------------

    def max_data(self, *, framed: bool = False, extra_header: int = 0) -> int:
        """Payload budget for one packet, given the negotiated write size."""
        write = min(t.max_write for t in self.transports.values())
        return write - (_FRAMED_OVERHEAD if framed else _RAW_OVERHEAD) - extra_header

    def _arms_for(self, target: str) -> list[Arm]:
        if target == "left":
            return [Arm.LEFT]
        if target == "right":
            return [Arm.RIGHT]
        return [Arm.LEFT, Arm.RIGHT]

    def encode(self, out: Outbound, seq: int | None = None) -> bytes:
        if out.framed:
            return encode_framed(out.opcode, self.seq.next() if seq is None else seq, out.body)
        return encode_raw(out.opcode, out.body)

    async def send(
        self,
        out: Outbound,
        *,
        timeout: float | None = None,
        strict: bool | None = None,
    ) -> Response:
        """Send one command and wait for the arms that owe a reply.

        Serialised against every other send: the left/right handshake is not
        safe to interleave.
        """
        async with self._lock:
            return await self._send_locked(out, timeout=timeout, strict=strict)

    async def send_all(
        self,
        outs: Sequence[Outbound],
        *,
        timeout: float | None = None,
        strict: bool | None = None,
    ) -> list[Response]:
        """Send a batch without letting anything else interleave.

        Bitmap transfers and multi-packet text both need this: a heartbeat
        landing in the middle of a chunk sequence confuses the reassembler.
        """
        async with self._lock:
            return [
                await self._send_locked(o, timeout=timeout, strict=strict) for o in outs
            ]

    async def _send_locked(
        self,
        out: Outbound,
        *,
        timeout: float | None,
        strict: bool | None,
    ) -> Response:
        if not self._started:
            raise NotConnectedError("session has not been started")

        spec = out.spec
        timeout = self.ack_timeout if timeout is None else timeout
        strict = self.strict if strict is None else strict
        expects_reply = spec.response != "none" and out.await_ack

        seq = self.seq.next() if out.framed else None
        payload = (
            encode_framed(out.opcode, seq, out.body)
            if out.framed
            else encode_raw(out.opcode, out.body)
        )

        response = Response(command=out.command)
        for arm in self._arms_for(out.resolved_target):
            transport = self.transports[arm]
            headerless = getattr(spec, "headerless", False)
            fut = None
            if expects_reply:
                fut = (
                    self._pending[arm].add_any()
                    if headerless
                    else self._pending[arm].add(out.opcode, seq)
                )
            started = time.monotonic()

            self._trace(arm, "tx", payload)
            try:
                await transport.write(payload)
            except Exception:
                if fut is not None:
                    self._pending[arm].discard(-1 if headerless else out.opcode, seq, fut)
                raise

            packet: Packet | None = None
            if fut is not None:
                try:
                    packet = await asyncio.wait_for(fut, timeout)
                except asyncio.TimeoutError as exc:
                    self._pending[arm].discard(-1 if headerless else out.opcode, seq, fut)
                    raise CommandTimeout(out.command, timeout, arm.label) from exc

            reply = Reply(arm=arm, packet=packet, elapsed=time.monotonic() - started)
            response.replies[arm] = reply

            if strict and packet is not None and packet.status == Status.FAILURE:
                raise CommandError(out.command, Status.FAILURE, arm.label)

        return response

    async def send_raw(self, arm: Arm, data: bytes) -> None:
        """Escape hatch: put arbitrary bytes on one arm.

        For protocol archaeology. Nothing correlates the reply — subscribe to
        events and read the trace.
        """
        self._trace(arm, "tx", data)
        await self.transports[arm].write(bytes(data))

    # -- receiving ---------------------------------------------------------

    def _make_receiver(self, arm: Arm):
        async def receive(data: bytes) -> None:
            self._trace(arm, "rx", data)
            try:
                packet = decode(data)
            except ProtocolError as exc:
                log.debug("undecodable packet on %s: %s (%s)", arm.label, data.hex(" "), exc)
                return

            # Battery is both a reply and an unsolicited push, so a packet can
            # legitimately be both. Settle the waiting caller first, then let
            # subscribers see it too.
            resolved = self._pending[arm].resolve(packet)
            event = parse(packet, arm)
            if event is not None:
                await self._dispatch(event)
            elif not resolved:
                log.debug("unmatched reply on %s: %s", arm.label, packet.hex())

        return receive

    async def _dispatch(self, event: Event) -> None:
        for queue in list(self._event_queues):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)
        for event_type, handler in list(self._handlers):
            if isinstance(event, event_type):
                try:
                    result = handler(event)
                    if hasattr(result, "__await__"):
                        await result  # type: ignore[misc]
                except Exception:
                    log.exception("event handler for %s raised", type(event).__name__)

    def on(self, event_type: Type[E], handler: EventHandler) -> Callable[[], None]:
        """Subscribe. Returns a callable that unsubscribes."""
        entry = (event_type, handler)
        self._handlers.append(entry)

        def cancel() -> None:
            with contextlib.suppress(ValueError):
                self._handlers.remove(entry)

        return cancel

    async def wait_for(self, event_type: Type[E], timeout: float = 30.0) -> E:
        """Block until one event of *event_type* arrives."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        def handler(event: Event) -> None:
            if not fut.done():
                fut.set_result(event)

        cancel = self.on(event_type, handler)
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            cancel()

    def stream(self, maxsize: int = 512) -> "EventStream":
        """An async iterator over every event."""
        queue: asyncio.Queue = asyncio.Queue(maxsize)
        self._event_queues.append(queue)
        return EventStream(self, queue)

    # -- heartbeat ---------------------------------------------------------

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                await self.send(heartbeat(self.hb_seq.next()), timeout=self.ack_timeout)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("heartbeat failed: %s", exc)

    async def beat(self) -> Response:
        """Send one heartbeat by hand (when ``auto_heartbeat=False``)."""
        return await self.send(heartbeat(self.hb_seq.next()))

    # -- diagnostics -------------------------------------------------------

    def start_trace(self) -> None:
        self.trace = []

    def stop_trace(self) -> list[tuple[float, Arm, str, bytes]]:
        trace, self.trace = self.trace or [], None
        return trace

    def _trace(self, arm: Arm, direction: str, data: bytes) -> None:
        if self.trace is not None:
            self.trace.append((time.time(), arm, direction, bytes(data)))
        if log.isEnabledFor(logging.DEBUG):
            log.debug("%s %s %s", arm.label, direction, bytes(data).hex(" "))


class EventStream:
    """``async for event in session.stream():``"""

    def __init__(self, session: Session, queue: asyncio.Queue) -> None:
        self._session = session
        self._queue = queue

    def __aiter__(self) -> "EventStream":
        return self

    async def __anext__(self) -> Event:
        return await self._queue.get()

    def close(self) -> None:
        with contextlib.suppress(ValueError):
            self._session._event_queues.remove(self._queue)

    def __enter__(self) -> "EventStream":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

