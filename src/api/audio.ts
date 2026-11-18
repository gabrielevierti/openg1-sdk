/** Microphone capture. */
import { AudioBuffer } from "../audio.ts";
import { sleep } from "../bytes.ts";
import * as cmd from "../commands.ts";
import type { Session } from "../session.ts";

export class Audio {
  /** The firmware caps a capture at about thirty seconds and stops on its own. */
  static readonly MAX_CAPTURE_MS = 30000;

  readonly #s: Session;
  #buffer = new AudioBuffer();
  #off: (() => void) | null = null;

  constructor(session: Session) {
    this.#s = session;
  }

  get buffer(): AudioBuffer {
    return this.#buffer;
  }

  get recording(): boolean {
    return this.#off !== null;
  }

  /** Enable the right arm's mic and begin collecting LC3 packets. */
  async start(): Promise<AudioBuffer> {
    this.#buffer = new AudioBuffer();
    const buffer = this.#buffer;
    this.#off?.();
    this.#off = this.#s.on("audio", (event) => buffer.add(event.seq, event.data));
    await this.#s.send(cmd.micControl(true));
    return buffer;
  }

  async stop(): Promise<AudioBuffer> {
    await this.#s.send(cmd.micControl(false)).catch(() => {});
    this.#off?.();
    this.#off = null;
    return this.#buffer;
  }

  /** Capture for a fixed time and return the frames. */
  async record(ms = 5000, signal?: AbortSignal): Promise<AudioBuffer> {
    if (ms > Audio.MAX_CAPTURE_MS) {
      throw new RangeError("the firmware stops capturing after about 30 s; call start()/stop() and restart the mic for more");
    }
    await this.start();
    try {
      await sleep(ms, signal);
    } finally {
      await this.stop();
    }
    return this.#buffer;
  }
}
