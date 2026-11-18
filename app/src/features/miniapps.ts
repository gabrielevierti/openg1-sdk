/**
 * Mini-apps: small things that own the display one at a time, switched with a
 * triple tap. Each is an ordinary openg1 `App`.
 *
 * To add your own, write a class here (or import one) and add it to CATALOG.
 * Anything that runs in the simulator with `openg1 sim your-app.ts` runs here.
 */
import { App, Launcher, runApp, type TouchEvent } from "openg1";
import type { Activity } from "../activities.ts";

class Clock extends App {
  override name = "clock";
  override intervalMs = 5000;
  #shown = "";
  override async start() {
    this.#shown = "";
    await this.tick();
  }
  override async tick() {
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (time === this.#shown) return;
    this.#shown = time;
    await this.screen.draw((c) => {
      const mid = c.safe.y + c.safe.height / 2;
      c.text(time, c.width / 2, mid - 50, { font: "xl", align: "center" });
      c.text(now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }), c.width / 2, mid + 28, { font: "md", align: "center" });
    });
  }
}

class Timer extends App {
  override name = "timer";
  override intervalMs = 1000;
  total = 25 * 60;
  seconds = this.total;
  active = false;
  override async start() {
    await this.draw();
  }
  override async tick() {
    if (!this.active) return;
    this.seconds = Math.max(0, this.seconds - 1);
    if (this.seconds === 0) this.active = false;
    // A frame takes about a second on the radio: redraw every five, and at the end.
    if (this.seconds % 5 === 0) await this.draw();
  }
  override async onTouch(event: TouchEvent) {
    if (event.gesture === "single_tap") this.active = !this.active;
    if (event.gesture === "double_tap") {
      this.seconds = this.total;
      this.active = false;
    }
    await this.draw();
  }
  draw() {
    const m = String(Math.floor(this.seconds / 60)).padStart(2, "0");
    const s = String(this.seconds % 60).padStart(2, "0");
    return this.screen.draw((c) => {
      const { y, height } = c.safe;
      c.text(`${m}:${s}`, c.width / 2, y + Math.max(0, (height - 104) / 2), { font: "xl", align: "center" });
      c.text(this.active ? "tap to pause" : "tap to start · double tap resets", c.width / 2, y + height - 44, { font: "sm", align: "center" });
      c.progress(138, y + height - 22, 300, 12, 1 - this.seconds / this.total);
    });
  }
}

class Counter extends App {
  override name = "counter";
  count = 0;
  override async start() {
    await this.draw();
  }
  override async onTouch(event: TouchEvent) {
    if (event.gesture === "single_tap") this.count += event.arm === "right" ? 1 : -1;
    if (event.gesture === "double_tap") this.count = 0;
    await this.draw();
  }
  draw() {
    return this.screen.draw((c) => {
      const mid = c.safe.y + c.safe.height / 2;
      c.text(String(this.count), c.width / 2, mid - 46, { font: "xl", align: "center" });
      c.text("right +1 · left −1 · double tap resets", c.width / 2, mid + 30, { font: "sm", align: "center" });
    });
  }
}

class Status extends App {
  override name = "status";
  override intervalMs = 30000;
  override async start() {
    await this.tick();
  }
  override async tick() {
    const battery = await this.g1.info.battery();
    const minutes = Math.floor((await this.g1.info.uptime()) / 60);
    await this.screen.rows(
      `Battery  L ${battery.left}%   R ${battery.right}%`,
      `Awake for ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}`,
      "Triple-tap for the next app",
    );
  }
}

export interface MiniAppInfo {
  id: string;
  title: string;
  about: string;
  create(): App;
}

export const CATALOG: MiniAppInfo[] = [
  { id: "clock", title: "Clock", about: "Time and date, large.", create: () => new Clock() },
  { id: "timer", title: "Timer", about: "A 25-minute countdown. Tap starts and pauses.", create: () => new Timer() },
  { id: "counter", title: "Counter", about: "Right tap adds, left tap subtracts.", create: () => new Counter() },
  { id: "status", title: "Glasses status", about: "Battery of each arm and time awake.", create: () => new Status() },
];

/** Run the chosen mini-apps in a launcher. */
export function launcherActivity(ids: string[], onSwitch: (title: string) => void): Activity {
  return {
    id: "miniapps",
    title: "Mini-apps",
    async run({ g1, signal }) {
      const chosen = ids.map((id) => CATALOG.find((a) => a.id === id)).filter((a): a is MiniAppInfo => !!a);
      if (!chosen.length) throw new Error("Choose at least one mini-app.");
      const launcher = new Launcher(chosen.map((a) => a.create()));
      const open = launcher.open.bind(launcher);
      launcher.open = async (index) => {
        await open(index);
        onSwitch(chosen[launcher.index]!.title);
      };
      await runApp(launcher, g1, { signal });
    },
  };
}

/** A ruler for measuring which rows of the panel you can see. */
export function calibrationActivity(): Activity {
  return {
    id: "calibration",
    title: "Calibration ruler",
    async run({ g1, signal }) {
      const c = g1.display.canvas();
      c.rect(0, 0, c.width, c.height);
      for (let y = 0; y < c.height; y += 10) {
        const major = y % 20 === 0;
        c.line(0, y, major ? 40 : 20, y);
        c.line(c.width - (major ? 40 : 20), y, c.width - 1, y);
        if (major && y > 0 && y < c.height - 12) {
          c.text(String(y), 46, y - 8, { font: "sm" });
          c.text(String(y), c.width - 46, y - 8, { font: "sm", align: "right" });
        }
      }
      c.text("Read the first and last number you can see", c.width / 2, 58, { font: "sm", align: "center" });
      await g1.display.bitmap(c.bitmap);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}
