"""What your glasses are actually like.

The simulator and the hardware disagree in exactly one way that matters, and
it is not a protocol difference: the simulator draws all 136 rows, and your
eye does not get all 136 rows. How many you get depends on how the glasses sit
on your face, so it is a property of *your* pair and cannot be guessed.

That number used to live in two places — a constant in an example, and
nothing at all on the simulator side — which is precisely how you end up
shipping a layout that looked right in the window and is unreadable through
the glass.

So it lives here, once, and both sides read it:

* the simulator renders the hidden rows as hidden, so the window shows what
  you would see rather than what the framebuffer contains;
* :meth:`openg1.api.display.Display.image` letterboxes into the visible band
  by default, on hardware and in the simulator alike.

Measure yours with ``examples/07_calibrate.py --save``, which writes the file
for you. After that, what you build in the simulator is what you get.

Where the profile comes from, first match winning:

1. ``OPENG1_PROFILE=/path/to/profile.toml``
2. ``./openg1.toml`` in the working directory
3. ``~/.config/openg1/profile.toml``
4. the built-in default, which hides nothing

A default that hides nothing is the honest choice: an uncalibrated profile
should behave like the raw panel, not like someone else's face.
"""

from __future__ import annotations

import os
import pathlib
from dataclasses import asdict, dataclass, replace

from ._generated import DISPLAY_HEIGHT, DISPLAY_WIDTH

ENV_VAR = "OPENG1_PROFILE"
FILENAME = "openg1.toml"
USER_PATH = pathlib.Path.home() / ".config" / "openg1" / "profile.toml"


@dataclass(frozen=True)
class DeviceProfile:
    """One pair of glasses, as measured."""

    name: str = "default"

    #: Framebuffer size. Fixed by the firmware; here so nothing hard-codes it.
    width: int = DISPLAY_WIDTH
    height: int = DISPLAY_HEIGHT

    #: Rows the wearer cannot see. Measured, never guessed.
    hidden_top: int = 0
    hidden_bottom: int = 0

    #: What MTU to ask for. The protocol assumes 194-byte bitmap chunks,
    #: which needs about this much.
    mtu: int = 247

    def __post_init__(self) -> None:
        if self.hidden_top < 0 or self.hidden_bottom < 0:
            raise ValueError("hidden margins cannot be negative")
        if self.hidden_top + self.hidden_bottom >= self.height:
            raise ValueError(
                f"hidden margins {self.hidden_top}+{self.hidden_bottom} leave "
                f"nothing of a {self.height}px panel visible"
            )

    # -- the useful derived values ----------------------------------------

    @property
    def safe_area(self) -> tuple[int, int]:
        return self.hidden_top, self.hidden_bottom

    @property
    def visible_height(self) -> int:
        return self.height - self.hidden_top - self.hidden_bottom

    @property
    def visible_rows(self) -> range:
        """The rows you can actually read."""
        return range(self.hidden_top, self.height - self.hidden_bottom)

    @property
    def calibrated(self) -> bool:
        return self.hidden_top > 0 or self.hidden_bottom > 0

    def describe(self) -> str:
        if not self.calibrated:
            return (
                f"{self.name}: {self.width}x{self.height}, uncalibrated — the "
                f"simulator will show all {self.height} rows, which may be "
                f"more than you can see. Run examples/07_calibrate.py --save."
            )
        return (
            f"{self.name}: {self.width}x{self.height}, "
            f"{self.hidden_top} hidden top / {self.hidden_bottom} hidden "
            f"bottom, {self.visible_height} rows visible"
        )

    # -- persistence -------------------------------------------------------

    def to_toml(self) -> str:
        return (
            "# openg1 device profile — see openg1/profile.py\n"
            "# Written by examples/07_calibrate.py --save\n"
            "[device]\n"
            f'name = "{self.name}"\n'
            f"hidden_top = {self.hidden_top}\n"
            f"hidden_bottom = {self.hidden_bottom}\n"
            f"mtu = {self.mtu}\n"
        )

    def save(self, path: str | pathlib.Path | None = None) -> pathlib.Path:
        target = pathlib.Path(path) if path else USER_PATH
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.to_toml())
        return target

    @classmethod
    def from_dict(cls, data: dict) -> "DeviceProfile":
        known = {f: data[f] for f in cls.__dataclass_fields__ if f in data}
        return cls(**known)


DEFAULT = DeviceProfile()

_active: DeviceProfile | None = None


def candidate_paths() -> list[pathlib.Path]:
    paths = []
    env = os.environ.get(ENV_VAR, "").strip()
    if env:
        paths.append(pathlib.Path(env))
    paths.append(pathlib.Path.cwd() / FILENAME)
    paths.append(USER_PATH)
    return paths


def load(path: str | pathlib.Path | None = None) -> DeviceProfile:
    """Read a profile from disk. Never raises for a missing file."""
    if path is not None:
        return _read(pathlib.Path(path))
    for candidate in candidate_paths():
        if candidate.is_file():
            return _read(candidate)
    return DEFAULT


def _read(path: pathlib.Path) -> DeviceProfile:
    try:
        import tomllib
    except ImportError:  # pragma: no cover - Python 3.10 and older
        import tomli as tomllib  # type: ignore[no-redef]

    data = tomllib.loads(path.read_text())
    section = data.get("device", data)
    profile = DeviceProfile.from_dict(section)
    return replace(profile, name=section.get("name", path.stem))


def active() -> DeviceProfile:
    """The profile in force. Loaded once, then cached."""
    global _active
    if _active is None:
        _active = load()
    return _active


def use(profile: DeviceProfile | None) -> DeviceProfile:
    """Override the active profile. ``None`` re-reads from disk next time."""
    global _active
    _active = profile
    return profile if profile is not None else active()


def as_dict() -> dict:
    return asdict(active())
