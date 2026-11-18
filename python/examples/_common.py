"""Bootstrap shared by every example.

Each example used to repeat the same three things: a `sys.path` insert so the
repo runs from a checkout, a flag to pick real glasses or a fake pair, and a
branch that returned a different tuple shape in each case. That is fine once
and tedious eight times, and it drifted — one file imported `sys` twice, and
the flag meant slightly different things in different examples.

    from _common import glasses

    async def main():
        async with glasses() as (g1, sim):
            await g1.display.text("ciao")

`sim` is `None` on real hardware and a `SimulatedG1` under `--sim`, so an
example can show simulator-only detail without a second code path.
"""

from __future__ import annotations

import contextlib
import pathlib
import sys

# Run from a checkout without installing.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from openg1 import G1  # noqa: E402


def wants_sim(argv: list[str] | None = None) -> bool:
    return "--sim" in (argv if argv is not None else sys.argv)


@contextlib.asynccontextmanager
async def glasses(*, argv: list[str] | None = None):
    """Yield ``(g1, sim)``. Closes whichever one it opened."""
    if wants_sim(argv):
        from openg1sim import SimulatedG1

        async with SimulatedG1() as sim:
            yield sim.g1, sim
        return

    g1 = await G1.connect()
    async with g1:
        yield g1, None


def show_panel(sim, caption: str = "") -> None:
    """Print the panel, when there is one. No-op on hardware."""
    if sim is None:
        return
    if caption:
        print(f"\n-- {caption}")
    print(sim.panel.frame.to_blocks())
