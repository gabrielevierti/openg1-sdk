# Building for the G1 without wearing the G1

This is the guide for developing an entire application against the simulator
and only putting the glasses on when you have something worth looking at.

The short version:

```sh
# terminal 1 — the simulator window. Leave it open all day.
python3 -m openg1sim

# terminal 2 — your program, restart it as often as you like
OPENG1_SIMULATOR=1 python3 myapp.py
```

`python3 -m openg1sim` with no arguments opens the window: the panel, buttons for
everything a wearer does, and a log. It needs nothing installed — Tk ships
with Python.

That is the whole workflow. The rest of this document explains what is
happening, what the simulator does and does not tell you, and how to be
confident the thing you built will work on hardware.

---

## 1. What the simulator app actually is

`python3 -m openg1sim` (or `python3 -m openg1sim gui`) opens a window containing:

- the **panel**, drawn at 2× so 576×136 is comfortable to look at;
- **wearer input** — touchbar, head gestures, wear detection, battery;
- a **status line** — frame count, lit pixels, battery, and a warning in amber
  when the current text does not fit;
- a **log** of everything that happened.

Behind the window it also listens on TCP `8766` for your program.

If you would rather have it in a browser — on another machine, say, or on a
Python without Tk — `python3 -m openg1sim app` serves the same thing over HTTP.
That variant starts one process containing two servers:

| | Where | What it is |
| --- | --- | --- |
| **Glasses endpoint** | TCP `127.0.0.1:8766` | What your program connects to instead of two BLE radios |
| **Panel** | http://127.0.0.1:8765 | What you look at instead of the display |

Your program connects to the glasses endpoint and sends the **exact bytes** it
would send over Bluetooth. The simulator parses them with the same code that
parses hardware replies, answers the way the firmware answers, and draws the
result on a 576×136 framebuffer that the browser renders.

Nothing above the transport knows the difference. That is the design goal, and
it is what makes this worth trusting: the code you debug against the simulator
is byte-for-byte the code you ship.

**The division of labour mirrors the real thing.** Your app owns the display.
The simulator owns the input — taps, head gestures, wear detection, battery
level. While an app is attached, the browser's "send to the glasses" buttons
are disabled, because two things writing to one panel is a situation with no
hardware equivalent and it would only produce confusing results.

---

## 2. Connecting your program

Three ways, in order of how much you have to change.

### Nothing at all — the environment variable

```sh
OPENG1_SIMULATOR=1 python3 myapp.py
```

`G1.connect()` checks `OPENG1_SIMULATOR` before it scans for radios. Set it and
an unmodified hardware program — including one you did not write — runs
against the simulator. Unset it and the same program scans for real glasses.

```sh
OPENG1_SIMULATOR=1                    # 127.0.0.1:8766
OPENG1_SIMULATOR=8766                 # same
OPENG1_SIMULATOR=192.168.1.20:8766    # a simulator on another machine
OPENG1_SIMULATOR=0                    # off; scan for real glasses
```

This is the one to use day to day. Put it in your shell profile or your
editor's run configuration and forget about it.

### Explicit — in code

```python
from openg1 import G1

g1 = await G1.connect_simulator()          # 127.0.0.1:8766
g1 = await G1.connect_simulator(port=9000)
```

Useful in tests, or when you want a script that is always the simulator
regardless of environment.

### A flag of your own

```python
import sys
from openg1 import G1

g1 = (await G1.connect_simulator() if "--sim" in sys.argv
      else await G1.connect())
```

What the bundled examples do.

---

## 3. A first program, start to finish

Create `myapp.py`:

```python
import asyncio
from openg1 import G1, TouchEvent


async def main(g1):
    await g1.display.brightness(30)
    await g1.display.text("ciao")

    async def on_touch(event: TouchEvent) -> None:
        battery = await g1.info.battery()
        await g1.display.text(f"{event.gesture}\n{battery.lowest}%")

    g1.on(TouchEvent, on_touch)
    await asyncio.Event().wait()          # stay up for input


if __name__ == "__main__":
    async def run():
        async with await G1.connect() as g1:
            await main(g1)

    asyncio.run(run())
```

Then:

```sh
python3 -m openg1sim app                    # terminal 1
OPENG1_SIMULATOR=1 python3 myapp.py         # terminal 2
```

Open http://127.0.0.1:8765. You will see `ciao`. Click **double tap** and the
panel changes — that event travelled from the browser, through the emulator,
over the socket, into your event handler, and the reply came back the same
way.

Note the shape of `main(g1)`: the interesting logic takes a `G1` and does not
care where it came from. Keep that separation and the day you switch to
hardware you change the four lines at the bottom and nothing else.

---

## 4. The tighter loop: live reload

Restarting by hand gets old. If you write your app as `async def main(g1)` in
its own file:

```sh
python3 -m openg1sim dev myapp.py
```

Every time you save, the app is cancelled, the panel is blanked, and your code
runs again from scratch. The browser page stays open across reloads, so you
keep your event log and your scroll position.

`dev` runs its own simulator inside the same process, so you do not need
`openg1sim app` at the same time — use `app` when you want the simulator to
outlive many separate runs of your program, and `dev` when you want the
fastest possible edit-save-look cycle.

The module is imported fresh under a new name on each reload rather than
reloaded in place. In-place reload leaves the old module alive wherever
anything captured a reference, so half your app is new and half is stale and
the hour you then spend debugging is not spent on your code.

Errors — syntax errors, tracebacks, a missing `main()` — are printed into the
browser log and never stop the server. Fix the file, save, and it picks up.

See `examples/09_devapp.py` for a working starting point.

---

## 5. Reading the panel

The browser shows the framebuffer as the wearer would see it, plus:

- **frame** — increments on every render, so you can tell "nothing happened"
  from "something happened and looked identical"
- **lit** — how many pixels are on
- **fit** — whether the current text fits, and how many lines did not

That last one is the one to watch. A screen can deliver every packet
successfully and still be wrong:

```python
report = sim.report()
report.fits             # False
report.truncated_lines  # 3 — nobody will ever see those
report.overflow         # lines too wide for 576px
```

The panel holds five lines at the default size. The protocol has no opinion
about a sixth, and neither does the firmware — it simply is not drawn. This is
the single most common way a G1 app is broken while appearing to work, and it
is invisible in a byte log.

**Save png** downloads the current panel, which is the fastest way to attach
"here is what it looks like" to an issue.

---

## 6. Simulating the wearer

Everything in the browser's *wearer input* section injects a real event, the
same bytes the firmware sends:

| Control | What your app receives |
| --- | --- |
| tap / double tap / triple tap | `TouchEvent` with `gesture` |
| hold left (AI) | the Even AI trigger, which starts a microphone stream |
| head up / head down | `HeadEvent` |
| wear / remove | `WearEvent` — the real panel powers down when removed |
| battery 87% / 20% / 5% | a battery report at that level |

Use these to test the paths that are annoying to reach on hardware. Getting
real glasses down to 5% battery to check your low-power branch takes hours;
here it takes a click.

---

## 7. Making the simulator match your glasses

This is the part that decides whether the simulator is useful or a
comfortable lie. Get it right once and what you build in the window is what
reaches your eye.

### The one divergence that matters

The framebuffer is 576×136. Your eye does not get 576×136 — how the glasses
sit on your face decides how much you actually see, and on your pair the top
23 rows are gone. A simulator that draws all 136 rows will happily show you a
design that is unreadable through the glass.

So measure it once and write it down:

```sh
python3 examples/07_calibrate.py            # read the ruler through the glasses
python3 examples/07_calibrate.py --verify 23 # check that margin
python3 examples/07_calibrate.py --save 23   # write it to your device profile
```

That writes `~/.config/openg1/profile.toml`, and **both sides read it**:

- the simulator draws those rows dimmed, so the window shows what you would
  see rather than what the framebuffer holds;
- `display.image()` letterboxes into the visible band by default, on the
  simulator and on hardware alike.

One number, two consumers. That shared value is the entire mechanism — there
is no separate "simulator setting" to drift out of step with reality.

```sh
openg1 profile                # what is in force, and where it was found
openg1 profile --set 23,0     # set it without running the calibration
```

### The parity check

Every screen the simulator draws is checked against your profile:

```python
sim.hidden_ink()      # lit pixels nobody will see. Should be 0.
sim.check_parity()    # [] when the window and the glasses agree
```

The GUI shows this live — `px IN HIDDEN ROWS` in amber, and a line in the log
the first time it happens. In tests, make it fatal:

```python
async with SimulatedG1(strict=True) as sim:
    await sim.g1.display.text("ciao")
    sim.check_parity()          # raises ParityError on any divergence
```

Put that in your test suite and a layout can never quietly become
unshippable: the build fails the moment something lands where you cannot read
it, rather than the next time you put the glasses on.

### An important consequence for text

With 23 hidden rows, **the first line of text is gone**. Lines are 24px, so
line one occupies rows 0–23 — exactly the band you cannot see. The firmware
decides where text goes and the SDK cannot move it, so there is no software
fix. Your options are:

1. **Recover the rows.** Run `python3 examples/07_calibrate.py --sweep`. The
   virtual screen's height and depth decide where the panel sits in your field
   of view, and a band that is unreachable at one setting is often fully
   visible at another. This is the right answer if it works: nothing lost.
2. **Start with a blank line**, and treat line one as padding.
3. **Draw bitmaps instead of text**, where you control every pixel and
   `safe_area` handles the placement for you.

The parity check will tell you which of these you are doing, every time.

## 7a. What still needs the glasses

With the profile set, the geometry agrees. These do not, and no amount of
software will change that — be honest with yourself about them:

- **Brightness, contrast and ambient light.** Green-on-black on a laptop is
  not a waveguide in daylight. Legibility is a physical question.
- **Timing and radio conditions.** No packet loss, no dropped connections, no
  interference, no BLE latency unless you ask for it
  (`SimulatedG1(latency=…)`). Real Bluetooth is slower and occasionally fails.
- **Battery drain and thermals.** A number you set, not a physical process.
- **The guessed parts of the protocol.** Commands marked `guessed` in
  `docs/PROTOCOL.md` are guesses on both sides. The simulator accepting one
  proves the SDK is self-consistent, not that the firmware agrees.

Everything else — packet structure, framing, sequence numbers, acknowledgement
ordering, bitmap chunking and CRC, text pagination, event decoding, and now
panel geometry — is the same code and the same numbers as hardware. A mistake
there fails here too.

## 8. Suggested workflow

1. **Build against `openg1sim dev`.** Structure, layout, event handling, state.
   This is most of the work and none of it needs the glasses.
2. **Switch to `openg1sim app`** once you have something that runs for a while,
   so the simulator stays up across restarts and you can attach a debugger or
   run it from your editor.
3. **Check `report().fits` for every screen you draw.** Better still, assert
   on it in a test — see `docs/TESTING.md`.
4. **Set your device profile before you write a line of layout code**
   (section 7). Without it the simulator is showing you rows you do not have,
   and everything after that is guesswork.
5. **Put the glasses on once**, near the end, for the things only hardware
   can tell you: legibility, brightness, whether the timing feels right,
   whether the text is readable at a glance while you are doing something
   else.
6. **Then keep using the simulator** for everything after that. The glasses
   are for confirming, not for iterating.

---

## 9. Reference

```sh
python3 -m openg1sim                        # the window (same as `gui`)
python3 -m openg1sim gui --glasses-port 9001
python3 -m openg1sim app                    # browser version instead
python3 -m openg1sim app --port 9000 --glasses-port 9001
python3 -m openg1sim app --no-browser       # do not open a browser on start

python3 -m openg1sim dev myapp.py           # live reload
python3 -m openg1sim dev myapp.py --watch src --watch assets

python3 -m openg1sim web                    # panel only, no app endpoint
python3 -m openg1sim term                   # terminal viewer
python3 -m openg1sim demo                   # scripted tour
python3 -m openg1sim render "ciao" -o panel.png

openg1 --sim info                           # the CLI, against a simulated pair
```

```python
from openg1 import G1
from openg1sim import SimulatedG1

g1 = await G1.connect_simulator(host="127.0.0.1", port=8766)

async with SimulatedG1() as sim:          # embedded, for tests
    await sim.g1.display.text("ciao")
    assert sim.report().fits
    sim.panel.frame.to_png(scale=2)
    sim.panel.frame.to_blocks()
```

| Environment variable | Effect |
| --- | --- |
| `OPENG1_SIMULATOR=1` | `G1.connect()` goes to `127.0.0.1:8766` |
| `OPENG1_SIMULATOR=host:port` | ...goes there instead |
| `OPENG1_SIMULATOR=0` | off; scan for real glasses |

### Troubleshooting

**`SimulatorUnavailable: no simulator on 127.0.0.1:8766`** — the simulator is
not running, or it is on a different port. Start it, or match the ports.

**`openg1sim gui needs tkinter`** — your Python was built without it. On macOS,
`brew install python-tk`; on Debian or Ubuntu, `sudo apt install python3-tk`.
Or use `python3 -m openg1sim app` and a browser, which needs nothing.

**The window is up but the buttons do nothing.** Wearer input only goes
somewhere if something is listening. Check the top-right corner: it says
"app attached" once your program connects, and names the port while it is
waiting.

**The browser's text buttons do nothing.** An app is attached and owns the
display. That is deliberate; the log line says so. Stop your program to get
the controls back.

**My program connects but the panel never changes.** Check the frame counter.
If it is not incrementing, nothing is being drawn — likely your code is
awaiting something that never completes before it reaches a display call.

**Reload does not pick up my edit.** `dev` watches the app's folder by
default. If your code lives elsewhere, add `--watch thatfolder`.
