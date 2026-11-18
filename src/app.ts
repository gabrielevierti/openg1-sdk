/**
 * Write a mini-app once; run it on the simulator and on the glasses.
 *
 * A thin layer over {@link G1}. You never have to use it, but it handles the
 * two things that are tedious to get right in every app:
 *
 * Layout inside the rows you can actually see. `this.screen` reads the device
 * profile and pads for it, so `screen.show("ciao")` is readable on any pair.
 *
 * A lifecycle. An app that binds event handlers must unbind them when it
 * stops, or the next app inherits them.
 *
 *     class Hello extends App {
 *       name = "hello";
 *       async start() { await this.screen.show("ciao"); }
 *       async onTouch(e) { await this.screen.show(`you did a ${e.gesture}`); }
 *     }
 *     await runApp(new Hello(), g1);
 */
import type { BitmapOptions, BitmapResult } from "./api/display.ts";
import type { Canvas } from "./canvas.ts";
import type { G1Event, HeadEvent, TouchEvent, WearEvent } from "./events.ts";
import type { G1 } from "./g1.ts";
import { visibleHeight } from "./profile.ts";

/** Pixels the firmware uses per line of text at its default size. */
export const LINE_HEIGHT = 27;
export const PANEL_LINES = 5;

/** Output that lands where the wearer can read it. Every app gets one as `this.screen`. */
export class Screen {
  readonly g1: G1;
  constructor(g1: G1) {
    this.g1 = g1;
  }

  /** Text lines swallowed by the hidden rows at the top of the panel. */
  get hiddenLines(): number {
    return Math.ceil(this.g1.display.safeArea[0] / LINE_HEIGHT);
  }

  /** How many lines of firmware text you actually have. Fewer than five on a pair with hidden rows. */
  get lines(): number {
    const [top, bottom] = this.g1.display.safeArea;
    const usable = Math.floor((visibleHeight({ ...this.g1.profile, hiddenTop: top, hiddenBottom: bottom })) / LINE_HEIGHT);
    return Math.max(1, Math.min(PANEL_LINES - this.hiddenLines, usable));
  }

  /** Display text, pushed below the rows this pair cannot show. */
  show(message: string): Promise<void> {
    return this.g1.display.text("\n".repeat(this.hiddenLines) + message, { pageDelayMs: 0 });
  }

  /** One line per argument, trimmed to what fits — a line you left out is a decision, a line the firmware dropped is a bug. */
  rows(...lines: string[]): Promise<void> {
    return this.show(lines.slice(0, this.lines).join("\n"));
  }

  /** Draw a bitmap screen. The canvas's `safe` rectangle is the visible band. */
  draw(fn: (canvas: Canvas) => void | Promise<void>, options?: BitmapOptions): Promise<BitmapResult> {
    return this.g1.display.draw(fn, options);
  }

  async clear(): Promise<void> {
    await this.g1.display.clear();
  }
}

/** Base class for a mini-app. Override what you need. */
export abstract class App {
  /** Shown by the launcher. */
  name = "app";
  description = "";
  /** Milliseconds between {@link tick} calls. Undefined means never. */
  intervalMs?: number;

  g1!: G1;
  screen!: Screen;

  #unbind: (() => void)[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  // -- what you override ----------------------------------------------------------

  /** Called once when the app opens. Draw your first screen here. */
  async start(): Promise<void> {}
  /** Called every `intervalMs`. Never overlaps itself. */
  async tick(): Promise<void> {}
  /** Called when the app closes. Release anything you took. */
  async stop(): Promise<void> {}
  async onTouch(_event: TouchEvent): Promise<void> {}
  async onHead(_event: HeadEvent): Promise<void> {}
  async onWear(_event: WearEvent): Promise<void> {}
  /** Every event, including the ones without a dedicated hook. */
  async onEvent(_event: G1Event): Promise<void> {}

  // -- what the framework does ------------------------------------------------------

  get running(): boolean {
    return this.#running;
  }

  /** Bind to a connection and start. Called by {@link runApp} and {@link Launcher}. */
  async attach(g1: G1, options: { bindEvents?: boolean } = {}): Promise<void> {
    this.g1 = g1;
    this.screen = new Screen(g1);
    this.#running = true;
    if (options.bindEvents ?? true) {
      this.#unbind = [
        g1.on("touch", (e) => this.#safely("onTouch", () => this.onTouch(e))),
        g1.on("head", (e) => this.#safely("onHead", () => this.onHead(e))),
        g1.on("wear", (e) => this.#safely("onWear", () => this.onWear(e))),
        g1.on("*", (e) => this.#safely("onEvent", () => this.onEvent(e))),
      ];
    }
    await this.start();
    if (this.intervalMs) this.#schedule();
  }

  async detach(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const off of this.#unbind.splice(0)) off();
    await this.stop();
  }

  #schedule(): void {
    this.#timer = setTimeout(async () => {
      await this.#safely("tick", () => this.tick());
      if (this.#running && this.intervalMs) this.#schedule();
    }, this.intervalMs);
  }

  /** One bad handler must not kill the app, or the session under it. */
  async #safely(what: string, fn: () => Promise<void>): Promise<void> {
    if (!this.#running) return;
    try {
      await fn();
    } catch (error) {
      console.error(`[${this.name}] ${what} failed:`, error);
    }
  }
}

/**
 * Several apps, one at a time, switched with a gesture (triple tap by
 * default). Small apps that each do one thing, in a shell that decides which
 * is on screen.
 */
export class Launcher extends App {
  override name = "launcher";
  readonly apps: App[];
  readonly switchGesture: TouchEvent["gesture"];
  index = 0;

  constructor(apps: App[], switchGesture: TouchEvent["gesture"] = "triple_tap") {
    super();
    if (!apps.length) throw new RangeError("a launcher needs at least one app");
    this.apps = apps;
    this.switchGesture = switchGesture;
  }

  get current(): App {
    return this.apps[this.index]!;
  }

  override async start(): Promise<void> {
    await this.open(this.index);
  }

  override async stop(): Promise<void> {
    await this.current.detach();
  }

  /** Switch to an app by index. */
  async open(index: number): Promise<void> {
    if (this.current.running) await this.current.detach();
    this.index = ((index % this.apps.length) + this.apps.length) % this.apps.length;
    // The launcher owns the event bindings and forwards, so it can claim one gesture.
    await this.current.attach(this.g1, { bindEvents: false });
  }

  override async onTouch(event: TouchEvent): Promise<void> {
    if (event.gesture === this.switchGesture) await this.open(this.index + 1);
    else await this.current.onTouch(event);
  }
  override async onHead(event: HeadEvent): Promise<void> {
    await this.current.onHead(event);
  }
  override async onWear(event: WearEvent): Promise<void> {
    await this.current.onWear(event);
  }
  override async onEvent(event: G1Event): Promise<void> {
    await this.current.onEvent(event);
  }
}

/**
 * Run an app on a connection until `signal` aborts (or forever). Clears the
 * screen on the way out; leaves the connection open, since you made it.
 */
export async function runApp(app: App, g1: G1, options: { signal?: AbortSignal } = {}): Promise<void> {
  await app.attach(g1);
  try {
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
      g1.on("disconnect", () => resolve());
    });
  } finally {
    await app.detach().catch(() => {});
    if (g1.connected) await g1.display.clear().catch(() => {});
  }
}
