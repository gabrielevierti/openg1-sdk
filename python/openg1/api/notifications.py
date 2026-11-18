"""Phone notifications forwarded to the glasses."""

from __future__ import annotations

from .. import commands as cmd
from ..session import Session

#: The 0x04 and 0x4B commands both cap a chunk's JSON at 180 bytes.
CHUNK_LIMIT = 180


def chunk_json(document: bytes, limit: int = CHUNK_LIMIT) -> list[bytes]:
    """Split a JSON document for transport.

    Bytes, not characters — the firmware counts bytes, and a multi-byte
    character split across two chunks makes the whole document unparseable at
    the far end.
    """
    return [document[i : i + limit] for i in range(0, len(document), limit)] or [b""]


class Notifications:
    def __init__(self, session: Session) -> None:
        self._s = session

    async def configure(
        self,
        apps: list[tuple[str, str]] | None = None,
        *,
        calendar: bool = True,
        call: bool = True,
        messages: bool = True,
        ios_mail: bool = True,
    ) -> None:
        """Set the allow-list of apps whose notifications get through.

        ``apps`` is a list of ``(identifier, display name)``. An empty list
        with the category flags on lets system notifications through and
        nothing else.
        """
        document = cmd.notification_config_json(
            apps or [],
            calendar=calendar,
            call=call,
            messages=messages,
            ios_mail=ios_mail,
        )
        chunks = chunk_json(document, self._limit())
        await self._s.send_all(
            [
                cmd.notification_config_packet(chunk, i, len(chunks))
                for i, chunk in enumerate(chunks)
            ]
        )

    async def notify(
        self,
        *,
        title: str,
        message: str = "",
        app_id: str = "dev.openg1.sdk",
        app_name: str = "OG1",
        subtitle: str = "",
        timestamp: int | None = None,
    ) -> None:
        """Push one notification to the left arm."""
        document = cmd.notification_json(
            app_id=app_id,
            app_name=app_name,
            title=title,
            subtitle=subtitle,
            message=message,
            timestamp=timestamp,
        )
        chunks = chunk_json(document, self._limit())
        await self._s.send_all(
            [
                cmd.notification_packet(chunk, i, len(chunks))
                for i, chunk in enumerate(chunks)
            ]
        )

    async def clear(self) -> None:
        await self._s.send(cmd.clear_notification())

    def _limit(self) -> int:
        # opcode + chunk count + chunk index, then whatever the link allows.
        return max(32, min(CHUNK_LIMIT, self._s.max_data(extra_header=2)))
