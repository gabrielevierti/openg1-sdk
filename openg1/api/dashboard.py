"""The always-on dashboard: clock, weather, layout, quick notes."""

from __future__ import annotations

import time

from .._generated import DashboardMode, DashboardPanel, WeatherIcon
from .. import commands as cmd
from ..session import Response, Session

#: OpenWeatherMap condition codes mapped onto the sixteen icons the G1 has.
_OWM_RANGES = (
    (200, 299, WeatherIcon.THUNDERSTORM),
    (300, 321, WeatherIcon.DRIZZLE),
    (500, 504, WeatherIcon.RAIN),
    (511, 511, WeatherIcon.FREEZING),
    (520, 531, WeatherIcon.HEAVY_RAIN),
    (600, 622, WeatherIcon.SNOW),
    (701, 701, WeatherIcon.MIST),
    (711, 731, WeatherIcon.SAND),
    (741, 741, WeatherIcon.FOG),
    (751, 761, WeatherIcon.SAND),
    (762, 762, WeatherIcon.SAND),
    (771, 771, WeatherIcon.SQUALLS),
    (781, 781, WeatherIcon.TORNADO),
    (800, 800, WeatherIcon.SUNNY),
    (801, 804, WeatherIcon.CLOUDS),
)


def icon_from_owm(code: int, *, night: bool = False) -> int:
    """Translate an OpenWeatherMap code to a G1 icon id."""
    if night and code == 800:
        return WeatherIcon.NIGHT
    for lo, hi, icon in _OWM_RANGES:
        if lo <= code <= hi:
            return icon
    return WeatherIcon.NONE


class Dashboard:
    def __init__(self, session: Session) -> None:
        self._s = session

    async def set_time(
        self,
        *,
        epoch: float | None = None,
        twelve_hour: bool = False,
    ) -> Response:
        """Push the host clock. The glasses have no RTC of their own worth trusting."""
        now = epoch if epoch is not None else time.time()
        return await self._s.send(
            cmd.set_time_and_weather(
                epoch_s=int(now), epoch_ms=int(now * 1000), twelve_hour=twelve_hour
            )
        )

    async def set_weather(
        self,
        *,
        icon: int = WeatherIcon.SUNNY,
        temperature_c: int = 20,
        fahrenheit: bool = False,
        twelve_hour: bool = False,
        epoch: float | None = None,
    ) -> Response:
        """Clock and weather travel in the same packet, so this sets both."""
        now = epoch if epoch is not None else time.time()
        return await self._s.send(
            cmd.set_time_and_weather(
                epoch_s=int(now),
                epoch_ms=int(now * 1000),
                icon=icon,
                temperature_c=temperature_c,
                fahrenheit=fahrenheit,
                twelve_hour=twelve_hour,
            )
        )

    async def set_layout(
        self,
        mode: int = DashboardMode.DUAL,
        panel: int = DashboardPanel.NOTES,
    ) -> Response:
        return await self._s.send(cmd.set_dashboard_layout(mode, panel))

    async def lock(self, locked: bool = True) -> Response:
        return await self._s.send(cmd.dashboard_lock(locked))

    async def quick_note(self, data: bytes) -> Response:
        """Raw quick-note payload. The layout of 0x1E is still guesswork."""
        return await self._s.send(cmd.set_quick_note(data))
