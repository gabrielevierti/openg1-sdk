/** The app's state and everything it can do, in one object the screens observe. */
import type { G1, NavigationStep } from "openg1";
import { ActivityManager } from "./activities.ts";
import { ask, textKey, translate, type ChatMessage } from "./features/assistant.ts";
import { Connection } from "./connection.ts";
import { fetchWeather, hudActivity, syncDashboard, type Weather } from "./features/dashboard.ts";
import { calibrationActivity, launcherActivity } from "./features/miniapps.ts";
import { navigationActivity, type NavigationView } from "./features/navigation.ts";
import { currentPosition, gpsSource, simulatedSource } from "./features/position.ts";
import { teleprompterActivity, type TeleprompterControl } from "./features/teleprompter.ts";
import { DEMO_OSRM_ROUTE } from "./nav/demo-route.ts";
import type { LatLon } from "./nav/geo.ts";
import { findRoutes, parseOsrmRoute, searchPlaces, type Place, type Route } from "./nav/route.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";

export interface DeviceSettings {
  brightness: number;
  autoBrightness: boolean;
  silent: boolean;
  headupAngle: number;
  wearDetection: boolean;
}

export interface PlannedRoute {
  destination: Place;
  route: Route;
  /** Every route the server offered; `route` is the chosen one. */
  options: Route[];
  /** True for the built-in demo route, which can only be driven in simulation. */
  demo: boolean;
}

export class AppState {
  settings: Settings = loadSettings();
  readonly conn: Connection;
  readonly activities: ActivityManager;

  weather: Weather | null = null;
  device: DeviceSettings | null = null;
  planned: PlannedRoute | null = null;
  nav: NavigationView | null = null;
  teleprompter: TeleprompterControl | null = null;
  miniApp = "";
  /** The feature screen open over the tabs, if any. */
  screen: "navigate" | "teleprompter" | "notes" | "assistant" | "translate" | "message" | null = null;
  chat: ChatMessage[] = [];
  translation: { source: string; result: string } | null = null;
  /** One line of feedback for the last thing the user did. */
  notice = "";
  noticeIsError = false;
  busy = "";

  readonly #listeners = new Set<() => void>();
  #queued = false;

  constructor() {
    const changed = () => this.changed();
    this.activities = new ActivityManager(changed);
    this.conn = new Connection(
      { hiddenTop: this.settings.hiddenTop, hiddenBottom: this.settings.hiddenBottom },
      { changed, lost: () => this.#lost(), ready: (g1) => void this.#ready(g1) },
    );
    this.conn.autoReconnect = this.settings.autoReconnect;
    this.#applyTheme();
  }

  #applyTheme(): void {
    const root = document.documentElement;
    if (this.settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = this.settings.theme;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Tell the screens something changed. Coalesced: a bitmap transfer is many changes and one repaint. */
  changed(): void {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      for (const listener of this.#listeners) listener();
    });
  }

  set(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    if ("hiddenTop" in patch || "hiddenBottom" in patch) {
      this.conn.setProfile({ hiddenTop: this.settings.hiddenTop, hiddenBottom: this.settings.hiddenBottom });
    }
    if ("autoReconnect" in patch) this.conn.autoReconnect = this.settings.autoReconnect;
    if ("theme" in patch) this.#applyTheme();
    this.changed();
  }

  say(text: string, isError = false): void {
    this.notice = text;
    this.noticeIsError = isError;
    this.changed();
  }

  /** Run something the user asked for, showing progress and turning a throw into a readable line. */
  async attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.busy = label;
    this.notice = "";
    this.changed();
    try {
      return await fn();
    } catch (error) {
      this.say((error as Error).message || String(error), true);
      return undefined;
    } finally {
      this.busy = "";
      this.changed();
    }
  }

  get g1(): G1 {
    if (!this.conn.g1) throw new Error("Connect the glasses first.");
    return this.conn.g1;
  }

  // -- connection ---------------------------------------------------------------------

  async #ready(g1: G1): Promise<void> {
    try {
      const brightness = await g1.display.getBrightness();
      this.device = {
        brightness: brightness.level,
        autoBrightness: brightness.auto,
        silent: await g1.settings.getSilentMode(),
        headupAngle: await g1.settings.getHeadupAngle(),
        wearDetection: await g1.settings.getWearDetection(),
      };
      if (this.settings.autoSync) await this.sync(false);
    } catch {
      /* the connection is up; these are refinements */
    }
    this.changed();
  }

  #lost(): void {
    this.activities.abandon();
    this.nav = null;
    this.teleprompter = null;
    this.device = null;
  }

  async disconnect(): Promise<void> {
    await this.activities.stop();
    await this.conn.disconnect();
    this.device = null;
  }

  // -- dashboard ------------------------------------------------------------------------

  /** Push the clock, and the weather when asked or when a place is already known. */
  async sync(askForLocation: boolean): Promise<void> {
    let at: LatLon | null = this.settings.weatherAt;
    if (askForLocation) {
      at = await currentPosition();
      this.set({ weatherAt: at });
    }
    if (at) this.weather = await fetchWeather(at).catch((error) => (askForLocation ? Promise.reject(error) : this.weather));
    await syncDashboard(this.g1, { weather: this.weather, fahrenheit: this.settings.fahrenheit, twelveHour: this.settings.twelveHour });
    this.changed();
  }

  startHud(): Promise<void> {
    return this.activities.start(
      hudActivity({ weather: () => this.weather, twelveHour: this.settings.twelveHour, fahrenheit: this.settings.fahrenheit }),
      this.g1,
    );
  }

  // -- navigation -------------------------------------------------------------------------

  async search(query: string): Promise<Place[]> {
    const near = this.settings.weatherAt ?? undefined;
    return searchPlaces(query, { near, endpoints: this.settings.endpoints, language: navigator.language });
  }

  /** Work out a route from where the phone is to a place. */
  async plan(destination: Place): Promise<void> {
    const from = await currentPosition();
    const options = await findRoutes(from, destination, this.settings.profile, {
      endpoints: this.settings.endpoints,
      avoid: this.settings.avoid,
      alternatives: true,
    });
    this.planned = { destination, route: options[0]!, options, demo: false };
    const recent = [destination, ...this.settings.recentPlaces.filter((p) => p.name !== destination.name)].slice(0, 6);
    this.set({ recentPlaces: recent });
  }

  chooseRoute(index: number): void {
    if (!this.planned?.options[index]) return;
    this.planned = { ...this.planned, route: this.planned.options[index]! };
    this.changed();
  }

  /** Load the built-in route: no network, no GPS. */
  planDemo(): void {
    const route = parseOsrmRoute(DEMO_OSRM_ROUTE, "car");
    const end = route.line[route.line.length - 1]!;
    this.planned = { destination: { ...end, name: "Via Turati (demo)", detail: "A built-in route for trying things out" }, route, options: [route], demo: true };
    this.changed();
  }

  async startNavigation(simulated: boolean): Promise<void> {
    const planned = this.planned;
    if (!planned) throw new Error("Choose a destination first.");
    this.nav = { route: planned.route, progress: null, step: null, rerouting: false };
    await this.activities.start(
      navigationActivity({
        route: planned.route,
        destination: planned.destination,
        source: simulated || planned.demo ? simulatedSource(planned.route) : gpsSource(),
        style: this.settings.navStyle,
        endpoints: this.settings.endpoints,
        avoid: this.settings.avoid,
        onUpdate: (view) => {
          this.nav = view;
          this.changed();
        },
      }),
      this.g1,
    );
  }

  // -- tools ---------------------------------------------------------------------------------

  /** Lines of firmware text that fall in the rows this pair cannot show. */
  get hiddenLines(): number {
    return Math.ceil(this.settings.hiddenTop / 27);
  }

  open(screen: AppState["screen"]): void {
    this.screen = screen;
    this.notice = "";
    this.changed();
  }

  /** Show a text a page at a time. `resume` picks up where this same text was left. */
  startTeleprompter(title: string, text: string, resume = false): Promise<void> {
    const key = textKey(text);
    return this.activities.start(
      teleprompterActivity({
        title,
        text,
        autoS: this.settings.teleprompterAutoS,
        hiddenLines: this.hiddenLines,
        startPage: resume ? (this.settings.lastPages[key] ?? 0) : 0,
        onControl: (control) => {
          this.teleprompter = control;
          if (control && this.settings.lastPages[key] !== control.page) {
            const lastPages = { ...this.settings.lastPages, [key]: control.page };
            // Keep the memory small: the most recent few texts are the ones worth resuming.
            for (const old of Object.keys(lastPages).slice(0, -20)) delete lastPages[old];
            this.set({ lastPages });
          }
          this.changed();
        },
      }),
      this.g1,
    );
  }

  /** Where this text was left, if it was read before. */
  lastPage(text: string): number {
    return this.settings.lastPages[textKey(text)] ?? 0;
  }

  get ai() {
    return { endpoint: this.settings.aiEndpoint, key: this.settings.aiKey, model: this.settings.aiModel };
  }

  /** Ask the assistant; the answer goes to the chat and, when connected, to the glasses. */
  async askAssistant(question: string): Promise<void> {
    const history = this.chat;
    this.chat = [...history, { role: "user", content: question }];
    this.changed();
    try {
      const answer = await ask(this.ai, history, question);
      this.chat = [...this.chat, { role: "assistant", content: answer }];
      if (this.conn.g1) await this.startTeleprompter("Assistant", answer);
    } catch (error) {
      this.chat = history;
      throw error;
    }
  }

  async translateText(source: string): Promise<void> {
    const result = await translate(this.ai, source, this.settings.translateTo);
    this.translation = { source, result };
    if (this.conn.g1) await this.startTeleprompter("Translation", result);
    this.changed();
  }

  startMiniApps(): Promise<void> {
    return this.activities.start(
      launcherActivity(this.settings.miniApps, (title) => {
        this.miniApp = title;
        this.changed();
      }),
      this.g1,
    );
  }

  startCalibration(): Promise<void> {
    return this.activities.start(calibrationActivity(), this.g1);
  }

  async stop(): Promise<void> {
    await this.activities.stop();
    this.nav = null;
    this.changed();
  }

  /** Show a short message, stopping whatever owned the display. */
  async sendText(text: string): Promise<void> {
    await this.activities.stop();
    await this.g1.display.text("\n".repeat(this.hiddenLines) + text);
  }

  // -- glasses settings -------------------------------------------------------------------------

  async setDevice(patch: Partial<DeviceSettings>): Promise<void> {
    const g1 = this.g1;
    const next = { ...(this.device ?? { brightness: 21, autoBrightness: false, silent: false, headupAngle: 30, wearDetection: true }), ...patch };
    if ("brightness" in patch || "autoBrightness" in patch) await g1.display.brightness(next.brightness, next.autoBrightness);
    if ("silent" in patch) await g1.settings.silentMode(next.silent);
    if ("headupAngle" in patch) await g1.settings.headupAngle(next.headupAngle);
    if ("wearDetection" in patch) await g1.settings.wearDetection(next.wearDetection);
    this.device = next;
    this.changed();
  }

  async applyNotifications(): Promise<void> {
    const s = this.settings;
    await this.g1.notifications.configure({
      apps: s.notifyApps,
      calendar: s.notifyCalendar,
      call: s.notifyCalls,
      messages: s.notifyMessages,
      iosMail: s.notifyMail,
    });
  }
}

export const app = new AppState();

/** A short description of a step for the phone's own screen. */
export function describeStep(step: NavigationStep): string {
  const verb: Record<string, string> = {
    continue: "Continue",
    turn_left: "Turn left",
    turn_right: "Turn right",
    slight_left: "Keep left",
    slight_right: "Keep right",
    sharp_left: "Sharp left",
    sharp_right: "Sharp right",
    u_turn: "Make a U-turn",
    roundabout: "At the roundabout",
    merge: "Merge",
    exit_left: "Take the exit on the left",
    exit_right: "Take the exit",
    arrive: "Arrive",
  };
  return verb[step.maneuver] ?? step.maneuver;
}
