"""Persistent device configuration."""

from __future__ import annotations

import asyncio

from .._generated import ButtonAction
from .. import commands as cmd
from ..errors import ProtocolError
from ..session import Response, Session


class Settings:
    def __init__(self, session: Session) -> None:
        self._s = session

    async def silent_mode(self, enabled: bool) -> Response:
        return await self._s.send(cmd.set_silent_mode(enabled))

    async def get_silent_mode(self) -> bool:
        body = (await self._s.send(cmd.get_silent_mode())).payload()
        if len(body) < 2:
            raise ProtocolError(f"short silent-mode reply: {body.hex(' ')}")
        return body[1] == 0x0C

    async def headup_angle(self, degrees: int) -> Response:
        """Tilt at which the display wakes, 0..60."""
        return await self._s.send(cmd.set_headup_angle(degrees))

    async def get_headup_angle(self) -> int:
        body = (await self._s.send(cmd.get_headup_angle())).payload()
        if len(body) < 3:
            raise ProtocolError(f"short head-up reply: {body.hex(' ')}")
        return body[2]

    async def wear_detection(self, enabled: bool) -> Response:
        """When on, the glasses emit WearEvent as they go on and off."""
        return await self._s.send(cmd.set_wear_detection(enabled))

    async def get_wear_detection(self) -> bool:
        body = (await self._s.send(cmd.get_wear_detection())).payload()
        if len(body) < 2:
            raise ProtocolError(f"short wear-detection reply: {body.hex(' ')}")
        return bool(body[1])

    async def headup_action(self, action: int = ButtonAction.DASHBOARD) -> Response:
        return await self._s.send(cmd.set_button_config(action))

    async def double_tap_action(self, action: int = ButtonAction.DASHBOARD) -> Response:
        return await self._s.send(cmd.set_gesture_config(action))

    async def calibrate(self, *, settle: float = 1.0) -> None:
        """Re-zero head tracking. Keep still and level while this runs."""
        await self._s.send(cmd.reset_zero_degree())
        await asyncio.sleep(settle)
        await self._s.send(cmd.calibration(0x02, bytes([0x01, 0x00])))

    async def language(self, code: int) -> Response:
        return await self._s.send(cmd.set_language(code))

    async def debug_mode(self, enabled: bool) -> Response:
        return await self._s.send(cmd.set_debug_mode(enabled))

    async def factory_reset(self) -> None:
        """Reboot both arms. The link drops; reconnect afterwards."""
        await self._s.send(cmd.hard_reset(), strict=False)
