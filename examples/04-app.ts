/**
 * A mini-app, developed with live reload:
 *
 *   npx openg1 sim examples/04-app.ts
 *
 * Open the page it prints, edit this file, save: the app restarts in the
 * simulator. The same class runs on real glasses with `runApp(new Timer(), g1)`.
 */
import { App, type TouchEvent } from "openg1";

export default class Timer extends App {
  override name = "timer";
  override intervalMs = 1000;

  seconds = 25 * 60;
  active = false;

  override async start(): Promise<void> {
    await this.draw();
  }

  override async tick(): Promise<void> {
    if (!this.active) return;
    this.seconds = Math.max(0, this.seconds - 1);
    if (this.seconds === 0) this.active = false;
    await this.draw();
  }

  override async onTouch(event: TouchEvent): Promise<void> {
    if (event.gesture === "single_tap") this.active = !this.active;
    if (event.gesture === "double_tap") {
      this.seconds = 25 * 60;
      this.active = false;
    }
    await this.draw();
  }

  private draw() {
    const minutes = String(Math.floor(this.seconds / 60)).padStart(2, "0");
    const seconds = String(this.seconds % 60).padStart(2, "0");
    return this.screen.draw((c) => {
      const { y, height } = c.safe;
      c.text(`${minutes}:${seconds}`, c.width / 2, y + (height - 100) / 2, { font: "xl", align: "center" });
      c.progress(138, y + height - 26, 300, 12, 1 - this.seconds / (25 * 60));
      c.text(this.active ? "tap to pause" : "tap to start · double tap to reset", c.width / 2, y + height - 46, {
        font: "sm",
        align: "center",
      });
    });
  }
}
