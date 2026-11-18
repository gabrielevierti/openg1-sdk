/**
 * One thing owns the display at a time.
 *
 * Navigation, the teleprompter, the mini-app launcher and the HUD all want
 * the whole panel. An activity is a function that runs until its signal
 * aborts; starting one stops the one before it and clears the screen between.
 */
import type { G1 } from "openg1";

export interface ActivityContext {
  g1: G1;
  signal: AbortSignal;
  /** Report a line of status for the app's own screen. */
  status(text: string): void;
}

export interface Activity {
  id: string;
  title: string;
  run(ctx: ActivityContext): Promise<void>;
}

export class ActivityManager {
  current: Activity | null = null;
  status = "";
  error = "";
  #controller: AbortController | null = null;
  #running: Promise<void> = Promise.resolve();
  readonly #changed: () => void;

  constructor(onChange: () => void) {
    this.#changed = onChange;
  }

  /** Start an activity, stopping whatever was running. Resolves once it has begun. */
  async start(activity: Activity, g1: G1): Promise<void> {
    await this.stop();
    const controller = (this.#controller = new AbortController());
    this.current = activity;
    this.status = "";
    this.error = "";
    this.#changed();
    this.#running = (async () => {
      try {
        await activity.run({
          g1,
          signal: controller.signal,
          status: (text) => {
            this.status = text;
            this.#changed();
          },
        });
      } catch (error) {
        if (!controller.signal.aborted) this.error = (error as Error).message || String(error);
      } finally {
        if (this.#controller === controller) {
          this.#controller = null;
          this.current = null;
          // Whatever the activity left on the glasses should not outlive it.
          if (g1.connected) await g1.session.idle().then(() => g1.display.clear()).catch(() => {});
          this.#changed();
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#running;
  }

  /** The link dropped: the activity cannot continue, and there is nothing to clear. */
  abandon(): void {
    this.#controller?.abort();
  }
}

/** Resolve when the signal aborts. For activities that are driven entirely by events. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
