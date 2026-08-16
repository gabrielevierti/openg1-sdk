# Building apps

How to write something for the G1, develop it entirely against the simulator,
and have it work when you put the glasses on.

Read [`SIMULATOR_APP.md`](SIMULATOR_APP.md) first if you have not set your
device profile. Without it the simulator is showing you rows your eye does not
get, and everything below is built on sand.

---

## The shortest app

```python
from openg1.app import App, run


class Hello(App):
    name = "hello"

    async def start(self):
        await self.screen.show("ciao")

    async def on_tap(self, event):
        await self.screen.show(f"you tapped: {event.gesture}")


if __name__ == "__main__":
    run(Hello())
```

```sh
python3 -m openg1sim                 # window, leave it open
OPENG1_SIMULATOR=1 python3 hello.py  # your app
python3 hello.py                     # the same file, on the glasses
```

`run()` connects to the simulator when `OPENG1_SIMULATOR` is set and to real
glasses when it is not. That is the only difference between the two, and it
lives outside your code.

---

## What you get

### `self.screen`

Text output that lands where the wearer can read it.

```python
await self.screen.show("one\ntwo")     # padded below your hidden rows
await self.screen.rows("one", "two")   # a line per argument, trimmed to fit
await self.screen.clear()

self.screen.lines          # lines this device actually has (≤ 5)
self.screen.hidden_lines   # lines lost to the hidden rows at the top
```

`show()` exists because of one hard fact: **the firmware puts the first line
of text at the top of the panel, and the SDK cannot move it.** On a pair where
the top rows are hidden, that line is gone. `screen.show()` pads for it using
your device profile, so the same call is correct on your pair and on one that
hides nothing, where the padding is zero.

Check `screen.lines` rather than assuming five. On a pair with hidden rows it
is four, and a layout written for five loses its last line without saying so.

### `self.g1`

The full SDK, whenever you need something `Screen` does not wrap:

```python
await self.g1.display.brightness(30)
await self.g1.display.image("logo.png")     # letterboxes into your safe area
await self.g1.display.bitmap(my_bitmap)
battery = await self.g1.info.battery()
await self.g1.navigation.update(step)
```

### Lifecycle

| | When |
| --- | --- |
| `start()` | once, when the app opens. Draw your first screen. |
| `tick()` | every `interval` seconds, if you set `interval`. |
| `on_tap(event)` | touchbar. `event.gesture` is `single_tap`, `double_tap`, `triple_tap`. |
| `on_head(event)` | `event.up` is True when the wearer looks up. |
| `on_wear(event)` | `event.worn` — the panel powers down when removed. |
| `stop()` | when the app closes. Release anything you took. |

Handlers are bound on attach and unbound on detach. That matters more than it
sounds: an app that leaves handlers behind means the next app reacts to taps
meant for it, and you spend an evening on a bug that is not in either app.

Exceptions inside a handler are caught and printed rather than raised. A
traceback out of an event callback would otherwise reach the notification pump
and take the connection down, which on the glasses looks like them freezing
for no reason.

---

## Four patterns worth copying

### Something that updates itself — [`apps/clock.py`](../examples/apps/clock.py)

```python
class Clock(App):
    interval = 10.0        # the panel shows minutes; faster is waste

    async def tick(self):
        await self.refresh()
```

The framework runs the loop in a task it also cancels, so closing the app
cannot leak it.

### Something with state — [`apps/timer.py`](../examples/apps/timer.py)

A pomodoro timer, driven from the touchbar. Two things to steal:

- everything that draws goes through one `refresh()`, so two code paths can
  never disagree about what is on screen;
- `refresh()` skips the write when the screen has not changed. A redraw is a
  full BLE round trip, and on a once-a-second tick that adds up fast.

### Something paged — [`apps/teleprompter.py`](../examples/apps/teleprompter.py)

Long text advanced by tap rather than on a timer. Note that it chunks in
`start()`, not `__init__`: chunking depends on `screen.lines`, and the screen
does not exist until the app attaches.

### Several apps at once — [`apps/launcher.py`](../examples/apps/launcher.py)

```python
from openg1.app import Launcher, run

run(Launcher([Clock(), Timer(), Teleprompter()]))
```

Triple tap switches. The launcher claims that one gesture and forwards
everything else, so an app never needs to know it is inside one.

---

## Testing an app

Apps are plain objects. Attach one to a simulator and assert:

```python
import pytest
from openg1sim import SimulatedG1
from myapp import Hello


@pytest.mark.asyncio
async def test_first_screen_is_readable():
    async with SimulatedG1(strict=True) as sim:
        app = Hello()
        await app._attach(sim.g1)

        assert "ciao" in sim.emulator.left.screen_text  # what it was told
        assert sim.check_parity() == []                 # what you would see

        await app._detach()
```

`strict=True` turns any divergence between the simulator and your glasses into
a raised `ParityError`. Put that in your suite and a layout cannot quietly
become unshippable — the test fails the moment something lands where you
cannot read it, instead of the next time you put the glasses on.

To drive input, use the simulator directly:

```python
await sim.tap(count=2)
await sim.head_up(True)
await sim.wear(False)
await sim.battery_report(5)
```

---

## Going to hardware

There is no port. Unset `OPENG1_SIMULATOR` and run the same file.

Worth doing once, near the end:

- **Look at it.** Brightness, contrast and legibility at a glance are physical
  questions the simulator cannot answer.
- **Check the timing feels right.** Real Bluetooth is slower than a socket,
  and a redraw you never noticed in the window may be visible on your face.
- **Re-run the calibration** if the fit has changed. `openg1 profile` tells
  you what is in force.

Everything else — layout, geometry, event handling, protocol — already agreed
before you put them on.

---

## Not using the framework

Nothing requires it. The raw API is what the numbered examples use:

```python
import asyncio
from openg1 import G1, TouchEvent


async def main():
    async with await G1.connect() as g1:
        await g1.display.text("ciao")
        g1.on(TouchEvent, lambda e: print(e.gesture))
        await asyncio.Event().wait()


asyncio.run(main())
```

If you do this, remember the padding yourself — `openg1.app.Screen` is doing
real work, and `display.text()` on its own will put your first line where you
cannot see it.
