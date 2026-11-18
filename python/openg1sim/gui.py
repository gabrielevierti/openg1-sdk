"""The simulator window.

    python3 -m openg1sim gui

A real window with the panel in it and buttons for everything a wearer does.
Tk rather than a browser, and Tk rather than Qt, for one reason: it ships with
Python. A simulator you have to install a toolkit for is a simulator you use
once.

This module is deliberately thin. All the simulator lives in
:mod:`openg1sim.controller`, on its own thread, and everything below is a view
over it — read the status, draw the frame, send a button press. That split is
what lets the engine be tested on a machine with no display, and it means a
mistake in the layout code cannot corrupt a packet.

Threading rule, in one line: Tk widgets are touched only from the Tk thread,
and the simulator is touched only through ``controller.submit``. The GUI polls
for new frames on a timer instead of being called back, because a callback
arriving from the asyncio thread is exactly the thing that must not touch a
widget.
"""

from __future__ import annotations

import base64
import sys

from .controller import SimulatorController
from .net import GLASSES_PORT

REFRESH_MS = 40  # 25 fps; the panel is 1-bit and does not need more
SCALE = 2

BG = "#0b0f0d"
PANEL_BG = "#05100b"
INK = "#8ef5c8"
DIM = "#5c7a70"
WARN = "#f5c86e"
ERR = "#f57e7e"

TK_MISSING = """\
openg1sim gui needs tkinter, which is missing from this Python.

  macOS (Homebrew):   brew install python-tk
  Debian / Ubuntu:    sudo apt install python3-tk
  Fedora:             sudo dnf install python3-tkinter

Or use the browser version, which needs nothing at all:

  python3 -m openg1sim app
"""


def _require_tk():
    try:
        import tkinter as tk
        from tkinter import ttk
    except ImportError:
        raise SystemExit(TK_MISSING) from None
    return tk, ttk


class SimulatorWindow:
    """The window. One per process; Tk is not fond of more."""

    def __init__(self, controller: SimulatorController) -> None:
        tk, ttk = _require_tk()
        self.tk = tk
        self.controller = controller

        self.root = tk.Tk()
        self.root.title("OpenG1SDK - G1 Glasses Simulator")
        self.root.configure(bg=BG)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.resizable(False, False)

        self._photo = None  # a reference Tk will not keep for us
        self._dashboard_open = False

        self._build()
        self.root.after(REFRESH_MS, self._tick)

    # -- layout ------------------------------------------------------------

    def _build(self) -> None:
        tk = self.tk
        pad = {"padx": 10, "pady": 6}

        header = tk.Frame(self.root, bg=BG)
        header.pack(fill="x", **pad)
        tk.Label(
            header, text="576 × 136, 1 bit",
            bg=BG, fg=DIM, font=("TkDefaultFont", 11),
        ).pack(side="left")
        self.attach_label = tk.Label(
            header, text="starting…", bg=BG, fg=DIM, font=("TkDefaultFont", 11)
        )
        self.attach_label.pack(side="right")

        # The panel. Black surround so the lit pixels read the way they do
        # through the glass, rather than as a rectangle on a grey window.
        stage = tk.Frame(self.root, bg=PANEL_BG, highlightthickness=1,
                         highlightbackground="#1d3329")
        stage.pack(**pad)
        self.canvas = tk.Canvas(
            stage, width=576 * SCALE, height=136 * SCALE,
            bg="#000000", highlightthickness=0,
        )
        self.canvas.pack(padx=14, pady=14)
        self._image_id = self.canvas.create_image(0, 0, anchor="nw")

        self.meta = tk.Label(self.root, text="", bg=BG, fg=DIM,
                             font=("TkFixedFont", 10), anchor="w")
        self.meta.pack(fill="x", padx=12)

        # The dimmed band on the panel is the profile made visible; this says
        # in words which profile produced it.
        self.device_label = tk.Label(self.root, text="", bg=BG, fg=DIM,
                                     font=("TkDefaultFont", 9), anchor="w")
        self.device_label.pack(fill="x", padx=12, pady=(0, 4))

        controls = tk.Frame(self.root, bg=BG)
        controls.pack(fill="x", **pad)

        self._group(controls, "Touch", [
            ("Click", lambda: self.controller.tap(1)),
            ("Double Click", lambda: self.controller.tap(2)),
            ("Triple Click", lambda: self.controller.tap(3)),
            ("Hold Left (AI)", self.controller.hold),
        ])
        self._group(controls, "Head & Wear", [
            ("Head up", lambda: self.controller.head(True)),
            ("Head down", lambda: self.controller.head(False)),
            ("Wear", lambda: self.controller.wear(True)),
            ("Remove", lambda: self.controller.wear(False)),
        ])
        self._group(controls, "Battery", [
            ("87%", lambda: self.controller.battery(87)),
            ("40%", lambda: self.controller.battery(40)),
            ("20%", lambda: self.controller.battery(20)),
            ("5%", lambda: self.controller.battery(5)),
        ])
        self._group(controls, "Overlays", [
            ("Dashboard", self._toggle_dashboard),
            ("Notification", lambda: self.controller.notify()),
            ("Save Screenshot", self._save_png),
        ])

        log_frame = tk.Frame(self.root, bg=BG)
        log_frame.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        self.log = tk.Text(
            log_frame, height=8, bg="#070c0a", fg=DIM, insertbackground=INK,
            font=("TkFixedFont", 10), relief="flat", highlightthickness=1,
            highlightbackground="#1d3329", wrap="word",
        )
        self.log.pack(fill="both", expand=True)
        self.log.configure(state="disabled")

    def _group(self, parent, title: str, buttons) -> None:
        tk = self.tk
        frame = tk.LabelFrame(
            parent, text=title, bg=BG, fg=DIM, bd=1,
            highlightbackground="#1d3329", font=("TkDefaultFont", 10),
        )
        frame.pack(side="left", fill="y", padx=(0, 10))
        row = tk.Frame(frame, bg=BG)
        row.pack(padx=6, pady=6)
        for label, command in buttons:
            tk.Button(
                row, text=label, command=command, width=13,
                highlightbackground=BG,
            ).pack(side="top", pady=1)

    # -- the loop ----------------------------------------------------------

    def _tick(self) -> None:
        """Poll the controller. Runs on the Tk thread, ~25 times a second."""
        try:
            self._draw_frame()
            self._draw_status()
            self._drain_log()
        finally:
            # Rescheduled in `finally` so one bad frame does not stop the
            # window updating for the rest of the session.
            self.root.after(REFRESH_MS, self._tick)

    def _draw_frame(self) -> None:
        png = self.controller.take_frame()
        if png is None:
            return
        # Tk 8.6 decodes PNG natively, which saves converting 78,000 pixels
        # into a Tk colour string one at a time.
        self._photo = self.tk.PhotoImage(data=base64.b64encode(png))
        self.canvas.itemconfigure(self._image_id, image=self._photo)

    def _draw_status(self) -> None:
        status = self.controller.status()

        if status.error:
            self.attach_label.configure(text=status.error, fg=ERR)
        elif status.attached:
            self.attach_label.configure(text="app attached", fg=INK)
        elif status.listening:
            self.attach_label.configure(
                text=f"waiting for your app on port {status.port}", fg=DIM
            )
        else:
            self.attach_label.configure(text="standalone", fg=DIM)

        bits = [
            f"frame {status.frames:<5}",
            f"lit {status.lit_pixels:<6}",
            f"battery {status.battery}%",
        ]
        if not status.worn:
            bits.append("NOT WORN")
        if status.hidden_ink:
            bits.append(f"{status.hidden_ink}px IN HIDDEN ROWS")
        if not status.fits:
            bits.append(f"{status.truncated_lines} line(s) cut off")
        self.meta.configure(
            text="   ".join(bits),
            fg=WARN if (status.parity or not status.fits) else DIM,
        )
        if status.device:
            self.device_label.configure(text=status.device)

    def _drain_log(self) -> None:
        lines = self.controller.drain_log()
        if not lines:
            return
        self.log.configure(state="normal")
        for line in lines:
            self.log.insert("end", line + "\n")
        # Keep the tail. An unbounded Text widget is a slow memory leak in a
        # window people leave open for hours.
        if int(self.log.index("end-1c").split(".")[0]) > 400:
            self.log.delete("1.0", "200.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    # -- actions -----------------------------------------------------------

    def _toggle_dashboard(self) -> None:
        self._dashboard_open = not self._dashboard_open
        self.controller.dashboard(self._dashboard_open)

    def _save_png(self) -> None:
        if self.controller.sim is None:
            return
        path = "panel.png"
        try:
            from tkinter import filedialog

            chosen = filedialog.asksaveasfilename(
                defaultextension=".png", initialfile="panel.png"
            )
            if chosen:
                path = chosen
            elif chosen == "":
                return
        except Exception:
            pass  # no dialog available; fall back to the working directory
        with open(path, "wb") as handle:
            handle.write(self.controller.sim.png(scale=4))
        self.controller.note(f"saved {path}")

    # -- lifecycle ---------------------------------------------------------

    def run(self) -> None:
        self.root.mainloop()

    def close(self) -> None:
        self.controller.stop()
        self.root.destroy()


def run_gui(
    *, host: str = "127.0.0.1", glasses_port: int = GLASSES_PORT
) -> int:
    controller = SimulatorController(host=host, glasses_port=glasses_port)
    try:
        controller.start()
    except RuntimeError as exc:
        print(f"could not start the simulator: {exc}", file=sys.stderr)
        if "address" in str(exc).lower() or "in use" in str(exc).lower():
            print(
                f"Port {glasses_port} is taken — another simulator is probably "
                f"already running. Use --glasses-port to pick another.",
                file=sys.stderr,
            )
        return 1

    window = SimulatorWindow(controller)
    controller.note("Point your program at the simulator with either of:")
    controller.note(f"    OPENG1_SIMULATOR=1 python3 yourapp.py")
    controller.note(f"    g1 = await G1.connect_simulator()")
    try:
        window.run()
    finally:
        controller.stop()
    return 0
