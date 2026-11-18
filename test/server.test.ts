/** The simulator server and the hub, over real sockets on loopback. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Canvas, G1, TransportError, toBase64 } from "../src/index.ts";
import { decodePng, panelToPng, startServer, type RunningServer } from "../src/server/index.ts";
import { connectTcp } from "../src/transports/tcp.ts";
import { connectSimulator } from "../src/transports/ws.ts";

let server: RunningServer;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const json = async (path: string, body?: unknown, init: RequestInit = {}) => {
  const res = await fetch(`${server.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as any };
};

before(async () => {
  server = await startServer({ port: 0, tcpPort: 0, hub: "simulator" });
});
after(async () => {
  await server.close();
});

test("the web page, state and frame are served over HTTP", async () => {
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const state = await json("/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.worn, true);
  assert.equal(state.body.hub, true);
  const png = await fetch(`${server.url}/api/frame.png?scale=1`);
  const image = decodePng(new Uint8Array(await png.arrayBuffer()));
  assert.deepEqual([image.width, image.height], [576, 136]);
});

test("the hub drives the glasses over REST", async () => {
  assert.deepEqual((await json("/v1/display/text", { text: "ciao dal hub" })).body, { ok: true, result: {} });
  assert.equal(server.sim!.screenText, "ciao dal hub");

  const battery = await json("/v1/info/battery");
  assert.deepEqual(battery.body.result, { left: 87, right: 87, lowest: 87 });

  const draw = await json("/v1/display/draw", {
    crcDelayMs: 0,
    ops: [
      { op: "text", text: "87", x: 288, y: 20, font: "xl", align: "center" },
      { op: "progress", x: 138, y: 110, width: 300, height: 14, value: 0.6 },
    ],
  });
  assert.equal(draw.body.result.ok, true);
  const expected = new Canvas();
  expected.text("87", 288, 20, { font: "xl", align: "center" });
  expected.progress(138, 110, 300, 14, 0.6);
  assert.deepEqual(server.sim!.frame.bits, expected.bitmap.bits);

  const status = await json("/v1/status");
  assert.equal(status.body.result.connected, true);
  assert.match(status.body.result.arms.left, /^Even G1_42_L_/);
});

test("the hub accepts an image as a raw PNG body and as base64", async () => {
  const canvas = new Canvas(100, 100);
  canvas.circle(50, 50, 40, { fill: true });
  const png = panelToPng(canvas.bitmap, { scale: 1 });
  const raw = await fetch(`${server.url}/v1/display/image?dither=false&crcDelayMs=0`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: png,
  });
  assert.equal(((await raw.json()) as any).result.ok, true);
  const lit = server.sim!.frame.lit();
  assert.ok(lit > 9000 && lit < 9600, `a filled circle scaled to the panel height, got ${lit} px`);
  await json("/v1/display/clear", {});
  await json("/v1/display/image", { png: toBase64(png), dither: false, crcDelayMs: 0 });
  assert.equal(server.sim!.frame.lit(), lit);
});

test("hub errors are honest about whose fault it is", async () => {
  const unknown = await json("/v1/display/nope", {});
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.message, /no such method "display.nope"/);
  const missing = await json("/v1/display/text", {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /"text" is required/);
  const range = await json("/v1/display/brightness", { level: 99 });
  assert.equal(range.status, 400);
  const badOp = await json("/v1/display/draw", { ops: [{ op: "sparkles" }] });
  assert.equal(badOp.status, 400);
  assert.match(badOp.body.error.message, /ops\[0\] \(sparkles\): unknown operation/);
  const notJson = await fetch(`${server.url}/v1/display/text`, {
    method: "POST",
    body: "{nope",
    headers: { "content-type": "application/json" },
  });
  assert.equal(notJson.status, 400);
  // A plain-text body is the text itself: `curl -H 'content-type: text/plain' -d ciao`.
  const plain = await fetch(`${server.url}/v1/display/text`, { method: "POST", body: "solo testo" });
  assert.equal(plain.status, 200);
  assert.equal(server.sim!.screenText, "solo testo");
  assert.equal((await json("/nowhere")).status, 404);
});

test("wearer input over HTTP reaches the hub's event stream (SSE and WebSocket)", async () => {
  const controller = new AbortController();
  const sse = await fetch(`${server.url}/v1/events`, { signal: controller.signal });
  const reader = sse.body!.getReader();
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/v1/events`);
  const wsMessages: any[] = [];
  ws.onmessage = (e) => wsMessages.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));

  assert.equal((await json("/api/input", { action: "tap", arm: "left", count: 2 })).status, 200);
  let text = "";
  while (!text.includes("double_tap")) text += new TextDecoder().decode((await reader.read()).value);
  const event = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
  assert.deepEqual(
    { type: event.type, arm: event.arm, gesture: event.gesture, raw: event.raw },
    { type: "touch", arm: "left", gesture: "double_tap", raw: "f500" },
  );
  controller.abort();

  await tick();
  assert.equal(wsMessages[0].event.gesture, "double_tap");
  ws.send(JSON.stringify({ id: 7, method: "display.text", params: { text: "via ws" } }));
  ws.send(JSON.stringify({ id: 8, method: "nope" }));
  await tick(60);
  assert.deepEqual(wsMessages.find((m) => m.id === 7), { id: 7, ok: true, result: {} });
  assert.equal(wsMessages.find((m) => m.id === 8).ok, false);
  assert.equal(server.sim!.screenText, "via ws");
  ws.close();
  assert.equal((await json("/api/input", { action: "moonwalk" })).status, 400);
});

test("the control socket streams frames and packets and takes input", async () => {
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/control`);
  const messages: any[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  await tick();
  assert.equal(messages[0].type, "hello");
  assert.equal(messages[1].type, "frame");
  await json("/v1/display/text", { text: "frame please" });
  await tick();
  const frames = messages.filter((m) => m.type === "frame");
  assert.equal(frames.at(-1).state.content.kind, "text");
  assert.equal(Buffer.from(frames.at(-1).bits, "base64").length, 72 * 136);
  assert.ok(messages.some((m) => m.type === "packet" && /SEND_TEXT.*frame please/.test(m.text)));
  ws.send(JSON.stringify({ action: "wear", worn: false }));
  await tick();
  assert.equal(server.sim!.worn, false);
  ws.send(JSON.stringify({ action: "wear", worn: true }));
  await tick();
  ws.close();
});

test("a second server gives remote apps both arms over WebSocket and over TCP", async () => {
  const remote = await startServer({ port: 0, tcpPort: 0 });
  try {
    const g1 = await G1.connect(connectSimulator(remote.url, { mtu: 100 }));
    assert.match(g1.session.transports.left.name, /^Even G1_42_L_SIM001$/);
    assert.equal(g1.session.transports.left.maxWrite, 97);
    await g1.display.text("over websocket");
    assert.equal(remote.sim!.screenText, "over websocket");
    const canvas = g1.display.canvas();
    canvas.rect(0, 0, 576, 136, { radius: 20, width: 4 });
    const result = await g1.display.draw(canvas, { crcDelayMs: 0 });
    assert.equal(result.chunkSize, 91, "chunk size follows the MTU the client negotiated");
    assert.deepEqual(remote.sim!.frame.bits, canvas.bitmap.bits);

    // The arms are taken: a second app is refused, as a second central would be.
    await assert.rejects(G1.connect(connectSimulator(remote.url)), TransportError);

    const tapped = g1.waitFor("touch", { timeoutMs: 1000 });
    remote.sim!.tap("right", 3);
    assert.equal((await tapped).gesture, "triple_tap");
    await g1.disconnect();
    await tick();
    assert.equal(remote.sim!.ports.left.attached, false);

    const tcp = await G1.connect(connectTcp("127.0.0.1", remote.tcpPort!));
    await tcp.display.text("over tcp");
    assert.equal(remote.sim!.screenText, "over tcp");
    assert.equal((await tcp.info.firmware()).version, "1.4.5");
    await tcp.disconnect();
  } finally {
    await remote.close();
  }
});

test("a token, when set, is required everywhere but the page itself", async () => {
  const locked = await startServer({ port: 0, tcpPort: false, hub: "simulator", token: "s3cret" });
  try {
    assert.equal((await fetch(locked.url)).status, 200);
    assert.equal((await fetch(`${locked.url}/api/state`)).status, 401);
    assert.equal((await fetch(`${locked.url}/v1/status`)).status, 401);
    assert.equal((await fetch(`${locked.url}/v1/status`, { headers: { authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await fetch(`${locked.url}/api/state?token=s3cret`)).status, 200);
    await assert.rejects(G1.connect(connectSimulator(locked.url)), TransportError);
  } finally {
    await locked.close();
  }
});

test("connecting to nothing explains what to start", async () => {
  await assert.rejects(G1.connect(connectSimulator("ws://127.0.0.1:1")), /is the simulator running\?/);
  await assert.rejects(G1.connect(connectTcp("127.0.0.1", 1)), /no simulator on 127.0.0.1:1/);
});
