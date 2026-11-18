/**
 * The Even AI loop, minus Even's cloud.
 *
 * The hardware side of "Even AI" is three things: a hold on the left touchbar,
 * a microphone stream, and paginated text with a particular status nibble.
 * None of it is tied to Even's servers. Give `listen` a function that turns
 * audio into an answer and the same gesture drives whatever model you like.
 */
import { ScreenStatus } from "../generated.ts";
import type { AudioBuffer } from "../audio.ts";
import type { Session } from "../session.ts";
import { paginate } from "../text.ts";
import type { Audio } from "./audio.ts";
import type { Display } from "./display.ts";

export type Responder = (audio: AudioBuffer) => string | Promise<string>;

export interface AssistantOptions {
  /** Give up waiting for the release after this long. Default 20 s. */
  maxRecordMs?: number;
  /** Shown while your responder runs. Empty string to skip. */
  thinkingMessage?: string;
}

export class Assistant {
  readonly #s: Session;
  readonly #audio: Audio;
  readonly #display: Display;

  constructor(session: Session, audio: Audio, display: Display) {
    this.#s = session;
    this.#audio = audio;
    this.#display = display;
  }

  /** Handle one interaction, from touchbar hold to answer on screen. */
  async once(responder: Responder, o: AssistantOptions & { signal?: AbortSignal } = {}): Promise<string> {
    await this.#s.waitFor("ai-request", { timeoutMs: 24 * 3600 * 1000, signal: o.signal });
    const buffer = await this.#audio.start();
    try {
      await this.#s.waitFor("ai-stop", { timeoutMs: o.maxRecordMs ?? 20000, signal: o.signal }).catch(() => {});
    } finally {
      await this.#audio.stop();
    }
    const thinking = o.thinkingMessage ?? "...";
    if (thinking) await this.show(thinking, { state: "thinking" });
    const answer = String(await responder(buffer));
    await this.show(answer);
    return answer;
  }

  /** Handle every interaction until you call the returned stop function. */
  listen(responder: Responder, o: AssistantOptions = {}): () => void {
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await this.once(responder, { ...o, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("openg1: assistant interaction failed:", error);
          await this.show("Something went wrong", { state: "error" }).catch(() => {});
        }
      }
    })();
    return () => controller.abort();
  }

  /** Display text with the Even AI status nibble, which is what drives the firmware's AI page indicator. */
  show(text: string, o: { state?: "done" | "thinking" | "manual" | "error" } = {}): Promise<void> {
    const mode = {
      done: ScreenStatus.EVEN_AI_COMPLETE,
      thinking: ScreenStatus.EVEN_AI_DISPLAYING,
      manual: ScreenStatus.EVEN_AI_MANUAL,
      error: ScreenStatus.EVEN_AI_NETWORK_ERROR,
    }[o.state ?? "done"];
    return this.#display.text(text, { mode });
  }

  /**
   * Show a long answer and let the wearer page it with the touchbar: left tap
   * back, right tap forward, as the official app behaves. Returns a function
   * that stops handling taps.
   */
  async paged(text: string): Promise<() => void> {
    const screens = paginate(text);
    let index = 0;
    const render = () =>
      this.#display.textPage(screens[index]!.join("\n"), {
        page: index + 1,
        maxPage: screens.length,
        mode: ScreenStatus.EVEN_AI_MANUAL,
      });
    await render();
    return this.#s.on("touch", async (event) => {
      if (event.gesture !== "single_tap") return;
      const next = Math.min(Math.max(index + (event.arm === "left" ? -1 : 1), 0), screens.length - 1);
      if (next !== index) {
        index = next;
        await render();
      }
    });
  }
}
