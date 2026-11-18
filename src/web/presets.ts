/**
 * The playground's examples. Each is a complete program: what you see here is
 * what you would write in your own app, minus the line that connects.
 *
 * In scope: `g1` (the connected glasses), `sim` (the simulator, or null on
 * real glasses), `signal` (aborts when you press Stop), `sleep(ms)`, `log()`,
 * and `openg1` (the whole SDK).
 */
export interface Preset {
  name: string;
  title: string;
  about: string;
  code: string;
}

export const PRESETS: Preset[] = [
  {
    name: "hello",
    title: "Hello: text and gestures",
    about: "Firmware text, then every touch-bar gesture echoed back. Try the touch bars above.",
    code: `// Text goes through the firmware's own renderer: five lines a screen.
await g1.display.text("Hello from openg1\\nTap a touch bar.");

g1.on("touch", async (event) => {
  await g1.display.text(event.arm + " arm: " + event.gesture.replace("_", " "));
});

g1.on("head", async (event) => {
  await g1.display.text(event.up ? "You looked up" : "You looked down");
});

const battery = await g1.info.battery();
log("battery", battery);
`,
  },
  {
    name: "clock",
    title: "Clock: drawing with a canvas",
    about: "Anything beyond five lines of text is a 576×136 bitmap. This draws one every second.",
    code: `// c.safe is the part of the panel you can see on your pair.
while (!signal.aborted) {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const seconds = now.getSeconds();

  await g1.display.draw((c) => {
    const { y, height } = c.safe;
    c.text(time, 16, y + Math.max(0, (height - 76) / 2), { font: "xl" });
    c.text(date, 250, y + 14, { font: "md" });
    c.text("Milano · 9°", 250, y + 42, { font: "md" });
    c.progress(250, y + height - 30, 300, 14, seconds / 59);
    c.battery(c.width - 44, y + 16, 87);
  });
  await sleep(1000);
}
`,
  },
  {
    name: "navigation",
    title: "Navigation: arrow, distance, speed",
    about: "A turn-by-turn screen drawn by the SDK. The speed box inverts when you pass the limit.",
    code: `const route = [
  { maneuver: "continue", distanceM: 2400, road: "A7 towards Milano", speedLimitKmh: 130 },
  { maneuver: "exit_right", distanceM: 900, road: "Exit Milano Ovest", speedLimitKmh: 90 },
  { maneuver: "roundabout", distanceM: 300, road: "Second exit", speedLimitKmh: 50 },
  { maneuver: "turn_left", distanceM: 120, road: "Corso Sempione", speedLimitKmh: 50 },
  { maneuver: "arrive", distanceM: 40, road: "On your right" },
];

let remainingM = 142000;
for (const step of route) {
  for (let i = 0; i < 3 && !signal.aborted; i++) {
    const speedKmh = Math.round((step.speedLimitKmh ?? 30) * (0.9 + 0.08 * i));
    await g1.navigation.update({ ...step, remainingM, etaS: remainingM / 28, speedKmh });
    remainingM -= 500;
    await sleep(1200);
  }
}
await g1.display.text("You have arrived.");
`,
  },
  {
    name: "teleprompter",
    title: "Teleprompter: pages you turn with taps",
    about: "The SDK wraps and pages long text. Right tap goes forward, left tap goes back.",
    code: `const script = \`Good evening, and thank you for coming.
Tonight I want to talk about a pair of glasses that were discontinued,
and about what happens to hardware when the software around it winds down.
The short version: the screen still works, the radio still works,
and the protocol turned out to be small enough to write down.
So we wrote it down. Then we wrote a simulator, so that nobody needs
to own a pair to build something for the people who do.\`;

const pages = openg1.paginate(script.replace(/\\n/g, " "));
let page = 0;

const show = () =>
  g1.display.textPage(pages[page].join("\\n"), { page: page + 1, maxPage: pages.length });

g1.on("touch", async (event) => {
  if (event.gesture !== "single_tap") return;
  page = Math.max(0, Math.min(pages.length - 1, page + (event.arm === "left" ? -1 : 1)));
  log("page", page + 1, "of", pages.length);
  await show();
});

await show();
`,
  },
  {
    name: "app",
    title: "Apps: a launcher with two mini-apps",
    about: "The App class gives each mini-app a lifecycle. Triple-tap switches between them.",
    code: `const { App, Launcher, runApp } = openg1;

class Counter extends App {
  name = "counter";
  count = 0;
  async start() { await this.draw(); }
  async onTouch(event) {
    if (event.gesture === "single_tap") this.count += event.arm === "right" ? 1 : -1;
    if (event.gesture === "double_tap") this.count = 0;
    await this.draw();
  }
  draw() {
    return this.screen.draw((c) => {
      const mid = c.safe.y + c.safe.height / 2;
      c.text(String(this.count), c.width / 2, mid - 40, { font: "xl", align: "center" });
      c.text("right +1 · left −1 · double tap resets", c.width / 2, mid + 36, { font: "sm", align: "center" });
    });
  }
}

class Uptime extends App {
  name = "uptime";
  intervalMs = 2000;
  async start() { await this.tick(); }
  async tick() {
    const battery = await this.g1.info.battery();
    const seconds = await this.g1.info.uptime();
    await this.screen.rows(
      "Uptime " + Math.floor(seconds / 60) + " min",
      "Battery L " + battery.left + "%  R " + battery.right + "%",
      "Triple-tap for the counter",
    );
  }
}

await runApp(new Launcher([new Counter(), new Uptime()]), g1, { signal });
`,
  },
  {
    name: "notify",
    title: "Notification, brightness, settings",
    about: "The parts of the glasses that are not the display.",
    code: `await g1.notifications.notify({
  appName: "Messages",
  title: "Marta",
  message: "Running ten minutes late, order for me?",
});
await sleep(2500);
await g1.notifications.clear();

await g1.display.text("Brightness sweep");
for (const level of [5, 15, 30, 42, 21]) {
  await g1.display.brightness(level);
  await sleep(500);
}

const firmware = await g1.info.firmware();
log("firmware", firmware.version, "built", firmware.build);
log("head-up angle", await g1.settings.getHeadupAngle());
await g1.display.text("Firmware " + firmware.version + "\\nSee the log below.");
`,
  },
];
