# The simulator

`openg1sim` is how you run openg1 without hardware. It has two halves, and the
second is the reason it exists.

The **emulator** answers *what were the glasses told?* It parses every packet,
enforces the acknowledgement ordering the firmware enforces, verifies bitmap
CRCs and records the resulting state. That is enough to test a protocol
implementation and not enough to test an application, because an application
can deliver every packet perfectly and still put a line of text where nobody
will read it.

The **panel** answers *what would the wearer see?* It renders the 576×136
display to actual pixels, which is where layout mistakes become visible.

```sh
python3 -m openg1sim demo            # a scripted tour, in the terminal
python3 -m openg1sim term            # live viewer, keyboard control
python3 -m openg1sim web             # browser viewer, clickable controls
python3 -m openg1sim dev app.py      # browser viewer that reruns app.py on save
python3 -m openg1sim render "ciao" -o panel.png
```

Nothing here needs hardware, a radio, permissions, or a third-party package.

## In code

```python
from openg1sim import SimulatedG1

async with SimulatedG1() as sim:
    await sim.g1.display.text("Genova to Milano, 145 km")

    print(sim.panel.frame.to_blocks())                    # terminal
    open("panel.png", "wb").write(sim.panel.frame.to_png(scale=2))

    report = sim.report()
    assert report.fits
```

`sim.g1` is an ordinary `openg1.G1`. Every packet goes through
`openg1sim.EmulatedGlasses`, is parsed by the same code that parses hardware
replies, and is answered the same way. Anything written against the SDK runs
against this unchanged, and a session that works here works on hardware for
the same reasons.

The emulator lives here rather than in `openg1` on purpose. A fake device shipped
inside a library invites people to write against it by accident, and having
two ways to not-have-glasses meant two things to keep in step. There is one
now: `SimulatedG1`.

## Live reload

```sh
python3 -m openg1sim dev examples/09_devapp.py
```

Watches the app's folder and, on every save, cancels the running app, blanks
the panel and runs it again. The browser page stays open across reloads, so
you keep your event log and your place; only your code restarts.

An app is a file exposing `async def main(g1)`. Since `g1` is an ordinary
`G1`, the same file runs on hardware with a three-line `__main__` block — the
simulator is where you iterate, not something you port away from.

The module is imported fresh under a new name each time rather than reloaded
in place. Reloading leaves the old module object alive wherever anything
captured a reference, so half the app is new and half is stale, and the hour
you then spend debugging is not spent on your code. Import errors, tracebacks
and a missing `main()` are reported into the browser log; none of them stop
the server.

## What it catches

```python
report = sim.report()
report.fits              # False if anything fell off or overflowed
report.truncated_lines   # lines past the fifth, which nobody will ever see
report.overflow          # lines wider than the 488-pixel text column
report.lines             # lines as rendered here
report.sdk_lines         # lines as openg1.text.wrap predicted
```

The useful case is a screen that the protocol considers a complete success:

```python
await sim.g1.display.text_page(long_message, page=1, max_page=1)
assert sim.report().truncated_lines == 0     # fails
```

Every packet was delivered and acknowledged. `text_page` pushes exactly one
screen and paginates nothing, so everything past the fifth line is simply not
drawn, and no part of the protocol considers that an error. `display.text`, by
contrast, splits a long message into several screens on a timer — which is why
the same text passes through one call and fails through the other.

## Stimulus

Everything the SDK emulator can inject, plus a re-render:

```python
await sim.tap(Arm.RIGHT, count=2)
await sim.hold(Arm.LEFT)          # the Even AI trigger
await sim.head_up(False)          # display goes dark, as it does on the wrist-flick
await sim.wear(False)             # wear detection blanks the panel
await sim.battery_report(20)
await sim.dashboard(True)
sim.set_clock("14:32", "18°  clear")
sim.notify("Marco: ci vediamo alle 20:00")
```

Frames are observable, which is what the viewers are built on:

```python
sim.on_frame(lambda s: print("frame", s.frames))
queue = sim.frame_queue()         # asyncio.Queue of frame numbers
```

## The terminal viewer

```sh
python3 -m openg1sim term
```

Half-block characters give two pixels per terminal row, so the panel becomes
144 columns by 34 rows — fits an ordinary window, and 21-pixel text stays
readable. Keys: `t` tap, `T` double, `y` triple, `h` hold, `u`/`j` head up and
down, `w` wear, `d` dashboard, `b` battery, `c` clear, `p` save a PNG, `q`
quit. Events from the session print underneath as they arrive.

## The browser viewer

```sh
python3 -m openg1sim web           # http://127.0.0.1:8765
```

Server-sent events push a new frame the moment your code draws something, so
the page updates live. Buttons feed stimulus back in, and there is a text box
that calls `display.text` directly. `/panel.png?scale=2` gives you a still.

It runs on raw `asyncio` streams rather than `http.server`, because the
simulator is already an asyncio program and a threaded server would need a
lock around every frame.

## Two honest limitations

**The font is not the firmware's.** Even does not publish it. The simulator
draws a 5×7 cell font, scaled 2 wide by 3 tall — condensed on purpose, because
that fits about 40 characters into the 488-pixel text column, which is close to
what the real proportional font manages. Square scaling would look nicer and
fit 27, which would report overflow on text that fits the glasses perfectly
well.

A residual gap remains, so `report()` carries both line counts and
`disagrees_with_sdk`. Where they differ, `openg1.text.wrap` is the better guide to
what the firmware will do, because it at least models a proportional font.
Read a truncation warning as *this is tight, look at it* rather than *this is
broken*. The reverse direction is the reliable one: if the simulator says it
fits, it fits.

**It is not a model of the optics.** The real display is a green monochrome
waveguide with its own brightness curve, a limited field of view, and a
focal distance that makes text sit somewhere in front of you. What you get
here is the bitmap that would be fed to it. The simulator will not tell you
that your layout is unreadable while walking, or that the wearer's eye lands
in the wrong corner.

## Rendering without a session

The framebuffer is usable on its own, which is handy for building layouts:

```python
from openg1sim import Framebuffer

frame = Framebuffer()
frame.draw_text("Via Emilia", 44, 8)
frame.hline(44, 40, 488)
frame.draw_text("2.4 km   4 min   limit 50", 44, 48)
open("mock.png", "wb").write(frame.to_png(scale=2))
```

`draw_char`, `draw_text`, `fill_rect`, `rect`, `line`, `hline`, `vline`,
`invert` and `blit_bmp` are all there. `blit_bmp` takes the same 1-bpp file
the glasses accept, so you can render exactly what you are about to transfer
and check it before spending 9854 bytes over BLE on it.

## Adding glyphs

`openg1sim/font.py` is a dict of five column bytes per character, bit 0 at the
top. Accented characters are composed — the base glyph shifts down a row and
an accent mask goes above it — so adding a language is usually one line in
`_COMPOSED`. `python3 -m openg1sim font` prints the whole table as ASCII art,
which is how you check a new glyph looks right.
