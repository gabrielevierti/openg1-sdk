"""A browser view of the panel, served from the same event loop.

    python3 -m openg1sim web

Server-sent events push a new frame whenever the panel changes, so the page
updates the moment your code draws something. Buttons on the page feed
stimulus back in — taps, head gestures, wear, battery — which makes this an
actual control surface rather than a picture.

It is written on raw ``asyncio`` streams rather than ``http.server`` because
the simulator is already an asyncio program, and a threaded server would need
a lock around every frame. The HTTP subset here is small enough to read: one
request per connection, or a long-lived one for the event stream.
"""

from __future__ import annotations

import asyncio
import json
import urllib.parse
from datetime import datetime

from openg1._generated import Arm
from openg1.events import Event

from . import scenes
from .device import SimulatedG1

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>openg1 simulator</title>
<style>
  :root {
    --glass: #6ef5c8;
    --ink: #0b0f0e;
    --panel: #11201b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: #0b0f0e;
    color: #cfe8e0;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  h1 { font-size: 15px; font-weight: 500; letter-spacing: .08em;
       text-transform: uppercase; color: #6b8078; margin: 0 0 18px; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  .lens {
    background: #05100c;
    border: 1px solid #1d2b26;
    border-radius: 10px;
    padding: 18px;
    display: flex; justify-content: center;
    box-shadow: inset 0 0 60px rgba(110,245,200,.05);
  }
  canvas { image-rendering: pixelated; width: 100%; max-width: 1152px; display: block; }
  .meta { display: flex; gap: 24px; flex-wrap: wrap;
          margin: 14px 2px; color: #6b8078; font-size: 12px; }
  .meta b { color: #cfe8e0; font-weight: 500; }
  .warn { color: #f5c86e; }
  .err { color: #f57e7e; }
  .hidden { display: none; }
  #app b.running { color: var(--glass); }
  #app b.error { color: #f57e7e; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 820px) { .cols { grid-template-columns: 1fr; } }
  fieldset { border: 1px solid #1d2b26; border-radius: 8px; padding: 14px; margin: 0; }
  legend { color: #6b8078; font-size: 11px; letter-spacing: .1em;
           text-transform: uppercase; padding: 0 6px; }
  button {
    background: #12201b; color: var(--glass);
    border: 1px solid #22392f; border-radius: 6px;
    padding: 7px 12px; margin: 3px; cursor: pointer;
    font: inherit; font-size: 12px;
  }
  button:hover { background: #183026; border-color: #35564a; }
  button:active { transform: translateY(1px); }
  input[type=text] {
    background: #05100c; color: #cfe8e0; border: 1px solid #22392f;
    border-radius: 6px; padding: 8px 10px; width: 100%; font: inherit;
  }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  .log { height: 150px; overflow-y: auto; margin-top: 10px;
         color: #6b8078; font-size: 12px; }
  .log div { padding: 1px 0; }
  .off { color: #4a5a54; }
</style>
</head>
<body>
<div class="wrap">
  <h1>openg1 simulator &mdash; Even Realities G1, 576&times;136</h1>

  <div class="lens"><canvas id="panel" width="576" height="136"></canvas></div>

  <div class="meta">
    <span>frame <b id="frame">0</b></span>
    <span>battery <b id="battery">87%</b></span>
    <span>lit <b id="lit">0</b> px</span>
    <span id="fit"></span>
    <span id="app" class="hidden">app <b id="appstate">idle</b>
          &middot; reload <b id="reloads">0</b></span>
  </div>

  <div class="cols">
    <fieldset>
      <legend>send to the glasses</legend>
      <input type="text" id="text" placeholder="text to display"
             value="Genova to Milano, 145 km">
      <div class="row">
        <button onclick="sendText()">show text</button>
        <button onclick="post('/api/clear')">clear</button>
        <button onclick="post('/api/demo')">run demo</button>
        <button onclick="post('/api/image')">test image</button>
      </div>
      <div class="row">
        <button onclick="post('/api/notify')">notification</button>
        <button onclick="post('/api/dashboard')">toggle dashboard</button>
        <button onclick="png()">save png</button>
        <button onclick="post('/api/reload')">reload app</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>wearer input</legend>
      <div>
        <button onclick="post('/api/tap?count=1')">tap</button>
        <button onclick="post('/api/tap?count=2')">double tap</button>
        <button onclick="post('/api/tap?count=3')">triple tap</button>
        <button onclick="post('/api/hold')">hold left (AI)</button>
      </div>
      <div>
        <button onclick="post('/api/head?up=1')">head up</button>
        <button onclick="post('/api/head?up=0')">head down</button>
        <button onclick="post('/api/wear?worn=1')">wear</button>
        <button onclick="post('/api/wear?worn=0')">remove</button>
      </div>
      <div>
        <button onclick="post('/api/battery?percent=87')">battery 87%</button>
        <button onclick="post('/api/battery?percent=20')">battery 20%</button>
        <button onclick="post('/api/battery?percent=5')">battery 5%</button>
      </div>
    </fieldset>
  </div>

  <div class="log" id="log"></div>
</div>

<script>
const canvas = document.getElementById("panel");
const ctx = canvas.getContext("2d");
const image = ctx.createImageData(576, 136);

function draw(bits) {
  // One byte per pixel from the server, expanded to the G1's green on black.
  const raw = atob(bits);
  for (let i = 0; i < 576 * 136; i++) {
    const on = raw.charCodeAt(i) !== 0;
    image.data[i * 4 + 0] = on ? 0x6e : 0x05;
    image.data[i * 4 + 1] = on ? 0xf5 : 0x10;
    image.data[i * 4 + 2] = on ? 0xc8 : 0x0c;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function note(message) {
  const log = document.getElementById("log");
  const line = document.createElement("div");
  const now = new Date().toTimeString().slice(0, 8);
  line.textContent = now + "  " + message;
  log.prepend(line);
  while (log.children.length > 60) log.lastChild.remove();
}

const stream = new EventSource("/events");
stream.addEventListener("frame", (message) => {
  const state = JSON.parse(message.data);
  draw(state.pixels);
  document.getElementById("frame").textContent = state.frame;
  document.getElementById("battery").textContent = state.battery + "%";
  document.getElementById("lit").textContent = state.lit;
  const fit = document.getElementById("fit");
  if (state.truncated || state.overflow) {
    fit.className = "warn";
    fit.textContent = state.truncated
      ? state.truncated + " line(s) did not fit on screen"
      : state.overflow + " line(s) overflow the panel";
  } else {
    fit.className = "off";
    fit.textContent = "fits";
  }
});
stream.addEventListener("log", (message) => note(JSON.parse(message.data).text));

stream.addEventListener("status", (message) => {
  const data = JSON.parse(message.data);
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("reloads").textContent = data.reloads;
  const state = document.getElementById("appstate");
  state.textContent = data.state;
  state.className = data.state === "error" ? "error"
                  : data.state === "running" ? "running" : "";
});

async function post(path) { await fetch(path, { method: "POST" }); }

async function sendText() {
  const text = document.getElementById("text").value;
  await fetch("/api/text", { method: "POST", body: text });
}

function png() { window.open("/panel.png?scale=2", "_blank"); }

document.getElementById("text").addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendText();
});
</script>
</body>
</html>
"""


class SimulatorServer:
    """Serves the page, the frame stream and the control endpoints."""

    def __init__(self, sim: SimulatedG1, host: str = "127.0.0.1", port: int = 8765) -> None:
        self.sim = sim
        self.host = host
        self.port = port
        self._clients: list[asyncio.Queue] = []
        self._dashboard = False
        sim.on_frame(lambda _: self._broadcast_frame())
        # No local session in app mode: a remote program owns the arms.
        if sim.g1 is not None:
            sim.g1.session.on(Event, lambda event: self.log(f"event: {event}"))

    # -- pushing to the browser -------------------------------------------

    def log(self, text: str) -> None:
        self._push("log", {"text": text})

    def _frame_payload(self) -> dict:
        import base64

        frame = self.sim.panel.frame
        report = self.sim.report()
        return {
            "frame": self.sim.frames,
            "pixels": base64.b64encode(bytes(frame.pixels)).decode("ascii"),
            "lit": report.lit_pixels,
            "battery": self.sim.left_state.battery,
            "truncated": report.truncated_lines,
            "overflow": len(report.overflow),
        }

    def _broadcast_frame(self) -> None:
        self._push("frame", self._frame_payload())

    def _push(self, name: str, payload: dict) -> None:
        message = f"event: {name}\ndata: {json.dumps(payload)}\n\n".encode()
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A browser that cannot keep up gets dropped frames rather
                # than back-pressuring the simulator.
                pass

    # -- serving -----------------------------------------------------------

    async def serve(self) -> None:
        server = await asyncio.start_server(self._handle, self.host, self.port)
        print(f"openg1 simulator on http://{self.host}:{self.port}  (ctrl-c to stop)")
        async with server:
            await server.serve_forever()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            writer.close()
            return

        head = request.decode("latin-1").split("\r\n")
        method, target, _ = head[0].split(" ", 2)
        headers = {}
        for line in head[1:]:
            if ": " in line:
                key, value = line.split(": ", 1)
                headers[key.lower()] = value

        body = b""
        length = int(headers.get("content-length", 0))
        if length:
            body = await reader.readexactly(length)

        path, _, query = target.partition("?")
        params = urllib.parse.parse_qs(query)

        try:
            if path == "/events":
                await self._serve_events(writer)
                return
            await self._route(writer, method, path, params, body)
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            if path != "/events":
                with_close = writer
                with_close.close()

    async def _route(self, writer, method: str, path: str, params: dict, body: bytes) -> None:
        if path == "/":
            return await self._send(writer, PAGE.encode(), "text/html; charset=utf-8")

        if path == "/panel.png":
            scale = int(params.get("scale", ["2"])[0])
            png = self.sim.panel.frame.to_png(scale=max(1, min(8, scale)))
            return await self._send(writer, png, "image/png")

        if not path.startswith("/api/") or method != "POST":
            return await self._send(writer, b"not found", "text/plain", status="404 Not Found")

        await self._command(path[5:], params, body)
        return await self._send(writer, b'{"ok":true}', "application/json")

    async def _command(self, name: str, params: dict, body: bytes) -> None:
        sim = self.sim
        g1 = sim.g1

        if name == "text":
            text = body.decode("utf-8", "replace")
            await g1.display.text(text)
            self.log(f"display.text({text!r})")
        elif name == "clear":
            await g1.display.clear()
            self.log("display.clear()")
        elif name == "tap":
            count = int(params.get("count", ["1"])[0])
            await sim.tap(Arm.RIGHT, count)
        elif name == "hold":
            await sim.hold(Arm.LEFT)
            self.log("hold on the left arm — the Even AI trigger")
        elif name == "head":
            await sim.head_up(params.get("up", ["1"])[0] == "1")
        elif name == "wear":
            await sim.wear(params.get("worn", ["1"])[0] == "1")
        elif name == "battery":
            await sim.battery_report(int(params.get("percent", ["87"])[0]))
        elif name == "dashboard":
            self._dashboard = not self._dashboard
            sim.set_clock(datetime.now().strftime("%H:%M"), "18°  clear")
            await sim.dashboard(self._dashboard)
        elif name == "notify":
            sim.notify("Messaggi — Marco: ci vediamo alle 20:00")
            self.log("notification overlay")
        elif name == "image":
            await self._send_test_image()
        elif name == "demo":
            await self._demo()

    async def _send_test_image(self) -> None:
        await self.sim.g1.display.bitmap(scenes.test_bitmap())
        self.log("image sent: 9854 bytes in 194-byte chunks, then CRC and end marker")

    async def _demo(self) -> None:
        for line in scenes.TOUR_LINES:
            await self.sim.g1.display.text(line)
            self.log(f"demo: {line}")
            await asyncio.sleep(1.2)

    async def _serve_events(self, writer: asyncio.StreamWriter) -> None:
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/event-stream\r\n"
            b"Cache-Control: no-cache\r\n"
            b"Connection: keep-alive\r\n\r\n"
        )
        await writer.drain()

        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._clients.append(queue)
        queue.put_nowait(
            f"event: frame\ndata: {json.dumps(self._frame_payload())}\n\n".encode()
        )
        try:
            while True:
                message = await queue.get()
                writer.write(message)
                await writer.drain()
        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
            pass
        finally:
            if queue in self._clients:
                self._clients.remove(queue)
            writer.close()

    async def _send(
        self, writer: asyncio.StreamWriter, body: bytes, content_type: str, status: str = "200 OK"
    ) -> None:
        writer.write(
            f"HTTP/1.1 {status}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()


async def run_web(host: str = "127.0.0.1", port: int = 8765) -> None:
    async with SimulatedG1() as sim:
        await sim.g1.display.text("openg1 simulator ready")
        server = SimulatorServer(sim, host, port)
        await server.serve()
