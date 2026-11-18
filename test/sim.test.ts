/** The SDK against the simulator: the same code path an app takes, end to end. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  App,
  Bitmap,
  Canvas,
  CommandError,
  CommandTimeout,
  G1,
  Launcher,
  ProtocolError,
  commands,
  runApp,
  toHex,
  type G1Event,
} from "../src/index.ts";
import { Simulator, simulate } from "../src/sim/index.ts";

const FAST = { crcDelayMs: 0 };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("handshake initialises the left arm and both arms are connected", async () => {
  const { g1, sim } = await simulate();
  assert.equal(g1.connected, true);
  assert.equal(sim.left.state.initialised, true);
  assert.equal(sim.right.state.initialised, false, "INIT is left-arm only");
  await g1.disconnect();
  assert.equal(g1.connected, false);
  assert.equal(sim.ports.left.attached, false);
});

test("text reaches both arms, left first", async () => {
  const { g1, sim } = await simulate();
  const order: string[] = [];
  sim.onPacket((arm, dir, data) => {
    if (dir === "tx" && data[0] === 0x4e) order.push(arm);
  });
  await g1.display.text("ciao");
  assert.equal(sim.screenText, "ciao");
  assert.equal(sim.right.display.text, "ciao");
  assert.deepEqual(order, ["left", "right"]);
  assert.equal(sim.armsInSync, true);
  assert.ok(sim.frame.lit() > 50, "text is rendered as pixels");
  sim.assertReadable();
  await g1.disconnect();
});

test("long text is paged and each page fits five lines", async () => {
  const { g1, sim } = await simulate();
  const pages: string[] = [];
  sim.onFrame(() => {
    if (sim.armsInSync && sim.screenText && pages.at(-1) !== sim.screenText) pages.push(sim.screenText);
  });
  await g1.display.text(Array.from({ length: 120 }, (_, i) => `parola${i}`).join(" "), { pageDelayMs: 1 });
  await tick();
  assert.ok(pages.length >= 2, `expected several pages, got ${pages.length}`);
  for (const p of pages) assert.ok(p.split("\n").length <= 5);
  assert.equal(sim.left.display.maxPage, pages.length);
  await g1.disconnect();
});

test("multi-packet text survives a small MTU and UTF-8 is never torn", async () => {
  const { g1, sim } = await simulate({ mtu: 40 });
  await g1.display.text("perché così è più bello — àèìòù € 日本語");
  assert.ok(!sim.screenText.includes("�"));
  assert.match(sim.screenText, /perché così/);
  assert.equal(sim.warnings.length, 0);
  await g1.disconnect();
});

test("a drawn canvas arrives pixel for pixel on both arms", async () => {
  const { g1, sim } = await simulate();
  const canvas = g1.display.canvas();
  canvas.rect(10, 10, 100, 50, { radius: 8 });
  canvas.text("87", 300, 30, { font: "xl", align: "center" });
  canvas.arrow(500, 68, 60, 90);
  const result = await g1.display.draw(canvas, FAST);
  assert.equal(result.ok, true);
  assert.equal(result.chunkSize, 194);
  assert.deepEqual(sim.frame.bits, canvas.bitmap.bits);
  assert.deepEqual(sim.frameFor("right").bits, canvas.bitmap.bits);
  assert.equal(sim.left.display.kind, "image");
  await g1.display.clear();
  assert.equal(sim.frame.lit(), 0);
  await g1.disconnect();
});

test("a bitmap that is not panel-sized is refused before anything is sent", async () => {
  const { g1, sim } = await simulate();
  let sent = 0;
  sim.onPacket((_arm, dir) => dir === "tx" && sent++);
  await assert.rejects(g1.display.bitmap(new Bitmap(100, 50)), ProtocolError);
  assert.equal(sent, 0);
  await g1.disconnect();
});

test("without MTU negotiation a bitmap is refused with an explanation", async () => {
  const { g1 } = await simulate({ mtu: 23 });
  await assert.rejects(g1.display.bitmap(new Bitmap()), /chunk index is one byte/);
  await g1.display.text("text still works at MTU 23, in small pieces");
  await g1.disconnect();
});

test("a corrupted transfer fails the CRC and is reported, not shown", async () => {
  const { g1, sim } = await simulate();
  await g1.display.text("before");
  // Drop one data packet on the way to the right arm.
  const port = sim.ports.right;
  const write = port.write.bind(port);
  let n = 0;
  port.write = (data) => {
    if (data[0] === 0x15 && n++ === 3) return;
    write(data);
  };
  const canvas = new Canvas();
  canvas.rect(0, 0, 576, 136, { fill: true });
  await assert.rejects(g1.display.draw(canvas, FAST), /bitmap not confirmed \(left=true, right=false\)/);
  assert.equal(sim.right.display.kind, "text", "the right arm kept its previous screen");
  assert.ok(sim.warnings.some((w) => /CRC mismatch/.test(w)));
  await g1.disconnect();
});

test("image fitting respects the safe area and never lights hidden rows", async () => {
  const { g1, sim } = await simulate({ profile: { hiddenTop: 23, hiddenBottom: 5 } });
  const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  await g1.display.image({ data: rgba, width: 64, height: 64 }, { dither: false, ...FAST });
  assert.equal(sim.frame.litInRows(0, 23), 0);
  assert.equal(sim.frame.litInRows(131, 136), 0);
  assert.equal(sim.frame.lit(), 108 * 108, "a white square scaled to the 108 visible rows");
  assert.equal(sim.report().hiddenInk, 0);

  const full = new Canvas();
  full.rect(0, 0, 576, 136, { fill: true });
  await g1.display.draw(full, FAST);
  assert.equal(sim.report().hiddenInk, 576 * 28);
  assert.throws(() => sim.assertReadable(), /hidden rows/);
  await g1.disconnect();
});

test("wearer input arrives as typed events", async () => {
  const { g1, sim } = await simulate();
  const seen: string[] = [];
  g1.on("*", (e: G1Event) => {
    seen.push(e.type === "touch" ? `touch:${e.arm}:${e.gesture}` : e.type === "head" ? `head:${e.up}` : e.type);
  });
  sim.tap("right");
  sim.tap("left", 2);
  sim.tap("right", 3);
  sim.lookUp();
  sim.lookUp(false);
  sim.wear(false);
  sim.holdStart("left");
  sim.holdEnd("left");
  sim.holdStart("right");
  sim.setBattery(55, "left");
  sim.charge(true);
  sim.inject("left", Uint8Array.from([0xf5, 0x7e, 0x01]));
  await tick();
  assert.deepEqual(seen, [
    "touch:right:single_tap",
    "touch:left:double_tap",
    "touch:right:triple_tap",
    "head:true",
    "head:false",
    "wear",
    "ai-request",
    "ai-stop",
    "touch:right:hold_start",
    "battery",
    "charging",
    "charging",
    "unknown",
  ]);
  assert.equal(sim.frame.lit(), 0);
  await g1.disconnect();
});

test("waitFor resolves with the next matching event and times out otherwise", async () => {
  const { g1, sim } = await simulate();
  setTimeout(() => sim.tap("left"), 5);
  setTimeout(() => sim.tap("right", 2), 10);
  const event = await g1.waitFor("touch", { filter: (e) => e.gesture === "double_tap" });
  assert.equal(event.arm, "right");
  await assert.rejects(g1.waitFor("head", { timeoutMs: 20 }), CommandTimeout);
  await g1.disconnect();
});

test("events() is an async iterator that unsubscribes on break", async () => {
  const { g1, sim } = await simulate();
  setTimeout(() => {
    sim.tap();
    sim.lookUp();
  }, 5);
  const types: string[] = [];
  for await (const e of g1.events()) {
    types.push(e.type);
    if (types.length === 2) break;
  }
  assert.deepEqual(types, ["touch", "head"]);
  await g1.disconnect();
});

test("info and settings round-trip through the emulated firmware", async () => {
  const { g1, sim } = await simulate();
  sim.left.state.battery = 61;
  sim.right.state.battery = 48;
  assert.deepEqual(await g1.info.battery(), { left: 61, right: 48, lowest: 48 });
  const fw = await g1.info.firmware();
  assert.equal(fw.version, "1.4.5");
  assert.equal(fw.build, "2024-12-28 20:20:45");
  assert.ok((await g1.info.uptime()) >= 6729);

  await g1.display.brightness(30, true);
  assert.deepEqual(await g1.display.getBrightness(), { level: 30, auto: true });
  assert.throws(() => g1.display.brightness(43), ProtocolError);

  await g1.settings.silentMode(true);
  assert.equal(await g1.settings.getSilentMode(), true);
  await g1.settings.headupAngle(45);
  assert.equal(await g1.settings.getHeadupAngle(), 45);
  await g1.settings.wearDetection(false);
  assert.equal(await g1.settings.getWearDetection(), false);
  await g1.display.setGeometry(6, 3, 1);
  assert.deepEqual(await g1.display.getGeometry(), { height: 6, depth: 3 });
  await g1.dashboard.setTime();
  await g1.dashboard.setWeather({ temperatureC: 12 });
  await g1.disconnect();
});

test("framed replies are matched by sequence and the counter advances", async () => {
  const { g1, sim } = await simulate();
  const sent: string[] = [];
  sim.onPacket((arm, dir, data) => dir === "tx" && arm === "left" && sent.push(toHex(data)));
  const before = g1.session.seq.peek();
  await g1.session.send(commands.setDisplaySettings(4, 5, true));
  await g1.session.send(commands.setDisplaySettings(4, 5, false));
  assert.equal(g1.session.seq.peek(), (before + 2) & 0xff);
  assert.equal(sent[0], `260900${before.toString(16).padStart(2, "0")}0802010405`);
  await g1.disconnect();
});

test("a FAILURE status throws in strict mode and is returned otherwise", async () => {
  const { g1 } = await simulate();
  await assert.rejects(g1.session.send(commands.to(commands.micControl(true), "left")), CommandError);
  const response = await g1.session.send(commands.to(commands.micControl(true), "left"), { strict: false });
  assert.equal(response.ok, false);
  await g1.disconnect();
});

test("an arm that stops answering produces a timeout naming the arm", async () => {
  const { g1, sim } = await simulate();
  sim.ports.right.write = () => {};
  await assert.rejects(g1.display.text("x", {}), (e: unknown) => e instanceof CommandTimeout && e.arm === "right");
  await g1.disconnect();
}, { timeout: 5000 });

test("heartbeats run on their own counter and keep the link alive", async () => {
  const sim = new Simulator();
  const g1 = await G1.connect(sim.pair(), { heartbeatIntervalMs: 10 });
  await tick(60);
  assert.ok(sim.left.state.heartbeats >= 3, `left got ${sim.left.state.heartbeats}`);
  assert.equal(sim.left.state.heartbeats, sim.right.state.heartbeats);
  assert.ok(g1.session.hbSeq.peek() >= 3);
  await g1.disconnect();
});

test("the microphone streams from the right arm and stops on request", async () => {
  const { g1, sim } = await simulate();
  const buffer = await g1.audio.start();
  assert.equal(sim.right.state.micEnabled, true);
  await tick(350);
  await g1.audio.stop();
  assert.equal(sim.right.state.micEnabled, false);
  assert.ok(buffer.packetCount >= 2, `got ${buffer.packetCount} packets`);
  assert.deepEqual(buffer.missing(), []);
  assert.equal(buffer.toLc3File().length, 18 + buffer.byteLength);
  await g1.disconnect();
  sim.close();
});

test("notifications are chunked to the left arm and rendered as a card", async () => {
  const { g1, sim } = await simulate({ mtu: 60 });
  const arms = new Set<string>();
  sim.onPacket((arm, dir, data) => dir === "tx" && data[0] === 0x4b && arms.add(arm));
  await g1.notifications.notify({ title: "Marta", message: "Arrivo tra dieci minuti, compra il pane ".repeat(3), appName: "Messaggi" });
  assert.deepEqual([...arms], ["left"]);
  assert.equal(sim.left.display.notification?.title, "Marta");
  assert.ok(sim.frame.lit() > 100);
  await g1.notifications.clear();
  assert.equal(sim.left.display.kind, "none");
  await g1.disconnect();
});

test("navigation draws a step as a bitmap", async () => {
  const { g1, sim } = await simulate();
  await g1.navigation.update(
    { maneuver: "turn_right", distanceM: 350, road: "Corso Buenos Aires", remainingM: 142000, etaS: 5400, speedKmh: 132, speedLimitKmh: 130 },
    FAST,
  );
  assert.equal(sim.left.display.kind, "image");
  assert.ok(sim.frame.lit() > 2000);
  sim.assertReadable();
  await g1.disconnect();
});

test("an App gets a lifecycle, ticks, and has its handlers unbound on exit", async () => {
  const { g1, sim } = await simulate();
  const log: string[] = [];
  class Counter extends App {
    override name = "counter";
    override intervalMs = 5;
    n = 0;
    override async start() {
      log.push("start");
      await this.screen.show("0");
    }
    override async tick() {
      this.n++;
    }
    override async onTouch() {
      await this.screen.show(`tapped ${this.n > 0}`);
      log.push("tap");
    }
    override async stop() {
      log.push("stop");
    }
  }
  const app = new Counter();
  const controller = new AbortController();
  const done = runApp(app, g1, { signal: controller.signal });
  await tick(30);
  sim.tap();
  await tick(10);
  assert.equal(sim.screenText, "tapped true");
  controller.abort();
  await done;
  assert.deepEqual(log, ["start", "tap", "stop"]);
  assert.equal(sim.screenText, "", "screen cleared on exit");
  sim.tap();
  await tick();
  assert.deepEqual(log, ["start", "tap", "stop"], "no handler left behind");
  await g1.disconnect();
});

test("a Launcher switches apps on triple tap and forwards everything else", async () => {
  const { g1, sim } = await simulate();
  class Named extends App {
    constructor(label: string) {
      super();
      this.name = label;
    }
    override async start() {
      await this.screen.show(this.name);
    }
    override async onTouch() {
      await this.screen.show(`${this.name}!`);
    }
  }
  const controller = new AbortController();
  const done = runApp(new Launcher([new Named("clock"), new Named("timer")]), g1, { signal: controller.signal });
  await tick();
  assert.equal(sim.screenText, "clock");
  sim.tap("right", 3);
  await tick();
  assert.equal(sim.screenText, "timer");
  sim.tap("right");
  await tick();
  assert.equal(sim.screenText, "timer!");
  sim.tap("right", 3);
  await tick();
  assert.equal(sim.screenText, "clock");
  controller.abort();
  await done;
  await g1.disconnect();
});

test("a pair with hidden rows gets its text pushed into view", async () => {
  const { g1, sim } = await simulate({ profile: { hiddenTop: 23 } });
  class Hello extends App {
    override async start() {
      assert.equal(this.screen.lines, 4);
      await this.screen.rows("uno", "due", "tre", "quattro", "cinque");
    }
  }
  const controller = new AbortController();
  const done = runApp(new Hello(), g1, { signal: controller.signal });
  await tick();
  assert.equal(sim.screenText, "\nuno\ndue\ntre\nquattro");
  assert.equal(sim.frame.litInRows(0, 23), 0);
  sim.assertReadable();
  controller.abort();
  await done;
  await g1.disconnect();
});

test("the simulator notices text the firmware would clip or drop", async () => {
  const { g1, sim } = await simulate();
  await g1.display.textPage("1\n2\n3\n4\n5\n6\n7");
  assert.equal(sim.report().truncatedLines, 2);
  await g1.display.textPage("W".repeat(60));
  assert.equal(sim.report().overflowLines.length, 1);
  assert.equal(sim.report().fits, false);
  await g1.disconnect();
});

test("heartbeat enforcement drops a silent link and the session reports it", async () => {
  const sim = new Simulator({ enforceHeartbeat: true });
  const g1 = await G1.connect(sim.pair(), { autoHeartbeat: false });
  const lost: string[] = [];
  g1.on("disconnect", (e) => {
    lost.push(e.arm);
  });
  sim.ports.left.drop("heartbeat timeout");
  await tick();
  assert.deepEqual(lost, ["left"]);
  assert.equal(g1.connected, false);
  await g1.disconnect();
  sim.close();
});
