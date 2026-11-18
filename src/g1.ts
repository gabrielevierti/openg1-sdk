/** The object you actually use: {@link G1}. */
import { Assistant } from "./api/ai.ts";
import { Audio } from "./api/audio.ts";
import { Dashboard } from "./api/dashboard.ts";
import { Display, type TextOptions } from "./api/display.ts";
import { DeviceInfo } from "./api/info.ts";
import { Navigation } from "./api/navigation.ts";
import { Notifications } from "./api/notifications.ts";
import { Settings } from "./api/settings.ts";
import type { EventOf, EventType, G1Event } from "./events.ts";
import { makeProfile, type DeviceProfile } from "./profile.ts";
import { Session, type EventHandler, type SessionOptions } from "./session.ts";
import type { TransportPair } from "./transport.ts";

export interface G1Options extends SessionOptions {
  /** How this pair sits on your face. See profile.ts. */
  profile?: Partial<DeviceProfile>;
  /** Skip the INIT / SEQ_SYNC exchange the official app performs on connect. */
  handshake?: boolean;
}

/**
 * A pair of Even Realities G1 glasses.
 *
 * Hand it the two links to the arms — from Web Bluetooth, a native BLE plugin,
 * noble, or the simulator — and everything above that is identical:
 *
 *     const g1 = await G1.connect(pair);
 *     await g1.display.text("ciao");
 *     g1.on("touch", (e) => console.log(e.gesture));
 *
 * Everything is grouped into namespaces — `display`, `info`, `settings`,
 * `dashboard`, `notifications`, `audio`, `navigation`, `assistant` — and the
 * {@link Session} underneath stays reachable as `.session` for anything they
 * do not cover yet.
 */
export class G1 {
  readonly session: Session;
  readonly profile: DeviceProfile;
  readonly display: Display;
  readonly info: DeviceInfo;
  readonly settings: Settings;
  readonly dashboard: Dashboard;
  readonly notifications: Notifications;
  readonly audio: Audio;
  readonly navigation: Navigation;
  readonly assistant: Assistant;
  readonly #handshake: boolean;

  constructor(pair: TransportPair, options: G1Options = {}) {
    this.profile = makeProfile(options.profile);
    this.#handshake = options.handshake ?? true;
    this.session = new Session(pair, options);
    this.display = new Display(this.session, this.profile);
    this.info = new DeviceInfo(this.session);
    this.settings = new Settings(this.session);
    this.dashboard = new Dashboard(this.session);
    this.notifications = new Notifications(this.session);
    this.audio = new Audio(this.session);
    this.navigation = new Navigation(this.session, this.display);
    this.assistant = new Assistant(this.session, this.audio, this.display);
  }

  /** Connect both arms (left first) and run the handshake. */
  static async connect(pair: TransportPair | Promise<TransportPair>, options: G1Options = {}): Promise<G1> {
    const g1 = new G1(await pair, options);
    await g1.start();
    return g1;
  }

  async start(): Promise<this> {
    await this.session.start({ handshake: this.#handshake });
    return this;
  }

  async disconnect(): Promise<void> {
    await this.session.stop();
  }

  get connected(): boolean {
    return this.session.connected;
  }

  // -- events ---------------------------------------------------------------------

  /** Subscribe to `"touch"`, `"head"`, `"wear"`, `"battery"`, … or `"*"`. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void;
  on(type: "*", handler: (event: G1Event) => void | Promise<void>): () => void;
  on(type: EventType | "*", handler: (event: never) => void | Promise<void>): () => void {
    return this.session.on(type as "*", handler as (event: G1Event) => void);
  }

  waitFor<T extends EventType>(
    type: T,
    options?: { timeoutMs?: number; signal?: AbortSignal; filter?: (event: EventOf<T>) => boolean },
  ): Promise<EventOf<T>> {
    return this.session.waitFor(type, options);
  }

  /** `for await (const event of g1.events())` */
  events(): AsyncIterableIterator<G1Event> {
    return this.session.events();
  }

  // -- shortcuts --------------------------------------------------------------------

  /** Shorthand for `g1.display.text`. */
  text(message: string, options?: TextOptions): Promise<void> {
    return this.display.text(message, options);
  }

  async clear(): Promise<void> {
    await this.display.clear();
  }
}
