"""Real BLE, via bleak.

Discovery is the fiddly part. Each arm advertises as a separate peripheral
named ``Even G1_<channel>_<L|R>_<serial>``, and the two halves of a pair share
a channel number. Some platforms — macOS in particular — hide service UUIDs
from scan results and hand back opaque addresses that change between reboots,
so name matching is the only thing that works everywhere, with service-UUID
filtering as a bonus when it is available.

Addresses that did work are cached, which turns a five-second scan into an
instant reconnect.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field

from .._generated import (
    NAME_PREFIX,
    NAME_REGEX,
    RX_CHAR_UUID,
    SERVICE_UUID,
    TX_CHAR_UUID,
    Arm,
)
from ..errors import DiscoveryError, NotConnectedError, TransportError
from . import Transport

_NAME_RE = re.compile(NAME_REGEX)
CACHE_PATH = os.path.expanduser(os.environ.get("OG1_CACHE", "~/.og1_devices"))


def _bleak():
    try:
        import bleak  # type: ignore

        return bleak
    except ImportError as exc:  # pragma: no cover - depends on install
        raise TransportError(
            "the BLE transport needs bleak: pip install 'openg1[ble]'"
        ) from exc


@dataclass(frozen=True)
class FoundArm:
    address: str
    name: str
    arm: Arm
    channel: str
    serial: str
    rssi: int | None = None


@dataclass
class DevicePair:
    left: FoundArm
    right: FoundArm

    @property
    def channel(self) -> str:
        return self.left.channel


def parse_name(name: str | None) -> tuple[Arm, str, str] | None:
    """Pull (arm, channel, serial) out of an advertised name."""
    if not name:
        return None
    match = _NAME_RE.match(name.replace("_", "_"))
    if not match:
        return None
    side = match.group("side")
    return (
        Arm.LEFT if side == "L" else Arm.RIGHT,
        match.group("channel"),
        match.group("serial"),
    )


async def scan(timeout: float = 6.0) -> list[FoundArm]:
    """Scan and return every G1 arm seen, both sides, all pairs."""
    bleak = _bleak()
    found: dict[str, FoundArm] = {}

    devices = await bleak.BleakScanner.discover(timeout=timeout, return_adv=True)
    for device, adv in devices.values():
        name = adv.local_name or device.name
        parsed = parse_name(name)
        if parsed is None:
            # Fall back to the service UUID for platforms that suppress names.
            if SERVICE_UUID.lower() not in [u.lower() for u in (adv.service_uuids or [])]:
                continue
            if not (name or "").startswith(NAME_PREFIX):
                continue
            continue
        arm, channel, serial = parsed
        found[device.address] = FoundArm(
            address=device.address,
            name=name or "",
            arm=arm,
            channel=channel,
            serial=serial,
            rssi=getattr(adv, "rssi", None),
        )
    return sorted(found.values(), key=lambda f: (f.channel, f.arm.value))


async def discover_pair(
    timeout: float = 6.0,
    *,
    channel: str | None = None,
    use_cache: bool = True,
) -> DevicePair:
    """Find one complete left/right pair.

    Tries the cache first. If several pairs are in range, pass ``channel`` to
    pick one; without it the strongest pair wins.
    """
    if use_cache and channel is None:
        cached = _load_cache()
        if cached:
            return cached

    arms = await scan(timeout)
    by_channel: dict[str, dict[Arm, FoundArm]] = {}
    for arm in arms:
        by_channel.setdefault(arm.channel, {})[arm.arm] = arm

    complete = {
        ch: sides for ch, sides in by_channel.items() if len(sides) == 2
    }
    if not complete:
        seen = ", ".join(f"{a.name}" for a in arms) or "nothing"
        raise DiscoveryError(
            f"no complete pair of G1 arms found (saw: {seen}). "
            "Both arms must be out of the case and not connected to the phone app."
        )
    if channel is not None:
        if channel not in complete:
            raise DiscoveryError(f"no complete pair on channel {channel}")
        chosen = complete[channel]
    else:
        chosen = max(
            complete.values(),
            key=lambda sides: sum((s.rssi or -120) for s in sides.values()),
        )

    pair = DevicePair(left=chosen[Arm.LEFT], right=chosen[Arm.RIGHT])
    if use_cache:
        _save_cache(pair)
    return pair


def _load_cache() -> DevicePair | None:
    try:
        with open(CACHE_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
        return DevicePair(
            left=FoundArm(arm=Arm.LEFT, **raw["left"]),
            right=FoundArm(arm=Arm.RIGHT, **raw["right"]),
        )
    except (OSError, KeyError, ValueError, TypeError):
        return None


def _save_cache(pair: DevicePair) -> None:
    def dump(a: FoundArm) -> dict:
        return {"address": a.address, "name": a.name, "channel": a.channel,
                "serial": a.serial}

    try:
        with open(CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"left": dump(pair.left), "right": dump(pair.right)}, fh, indent=2)
    except OSError:
        pass  # a cache miss next time is not worth an exception


def clear_cache() -> None:
    try:
        os.remove(CACHE_PATH)
    except OSError:
        pass


class BleakTransport(Transport):
    """One arm's BLE link."""

    def __init__(
        self,
        address: str,
        *,
        name: str = "?",
        arm: Arm | None = None,
        timeout: float = 20.0,
        on_disconnect=None,
    ) -> None:
        self.address = address
        self.name = name
        self.arm = arm
        self.timeout = timeout
        self._client = None
        self._on_disconnect = on_disconnect
        self._loop: asyncio.AbstractEventLoop | None = None

    @classmethod
    def from_found(cls, found: FoundArm, **kw) -> "BleakTransport":
        return cls(found.address, name=found.name, arm=found.arm, **kw)

    async def connect(self) -> None:
        bleak = _bleak()
        self._loop = asyncio.get_running_loop()
        self._client = bleak.BleakClient(
            self.address,
            timeout=self.timeout,
            disconnected_callback=self._handle_disconnect,
        )
        try:
            await self._client.connect()
        except Exception as exc:  # bleak raises a wide variety
            raise TransportError(f"could not connect to {self.name} ({self.address}): {exc}") from exc

        try:
            await self._client.start_notify(RX_CHAR_UUID, self._handle_notify)
        except Exception as exc:
            await self.disconnect()
            raise TransportError(
                f"{self.name} connected but the Nordic UART RX characteristic is "
                f"missing — is this really a G1 arm? ({exc})"
            ) from exc

    async def disconnect(self) -> None:
        client, self._client = self._client, None
        if client is None:
            return
        try:
            if client.is_connected:
                await client.stop_notify(RX_CHAR_UUID)
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass

    @property
    def is_connected(self) -> bool:
        return bool(self._client and self._client.is_connected)

    @property
    def max_write(self) -> int:
        if not self._client:
            return 20
        # bleak reports the ATT MTU; three bytes go to the write header.
        return max(20, getattr(self._client, "mtu_size", 23) - 3)

    async def write(self, data: bytes) -> None:
        if not self._client or not self._client.is_connected:
            raise NotConnectedError(f"{self.name} is not connected")
        if len(data) > self.max_write:
            from ..errors import PacketTooLargeError

            raise PacketTooLargeError(len(data), self.max_write)
        try:
            await self._client.write_gatt_char(TX_CHAR_UUID, bytes(data), response=False)
        except Exception as exc:
            raise TransportError(f"write to {self.name} failed: {exc}") from exc

    # -- bleak callbacks ---------------------------------------------------

    def _handle_notify(self, _sender, data: bytearray) -> None:
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._emit(bytes(data)), self._loop)

    def _handle_disconnect(self, _client) -> None:
        if self._on_disconnect and self._loop:
            self._loop.call_soon_threadsafe(self._on_disconnect, self)


async def connect_pair(pair: DevicePair, **kw) -> tuple[BleakTransport, BleakTransport]:
    """Connect both arms. Left first — the whole protocol assumes that order."""
    left = BleakTransport.from_found(pair.left, **kw)
    right = BleakTransport.from_found(pair.right, **kw)
    await left.connect()
    try:
        await right.connect()
    except Exception:
        await left.disconnect()
        raise
    return left, right


_ = field  # re-exported dataclass helper, silences unused-import linters
