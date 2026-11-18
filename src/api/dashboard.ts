/** The always-on dashboard: clock, weather, layout, quick notes. */
import { DashboardMode, DashboardPanel, WeatherIcon } from "../generated.ts";
import * as cmd from "../commands.ts";
import type { Response, Session } from "../session.ts";

const OWM_RANGES: readonly (readonly [number, number, number])[] = [
  [200, 299, WeatherIcon.THUNDERSTORM],
  [300, 321, WeatherIcon.DRIZZLE],
  [500, 504, WeatherIcon.RAIN],
  [511, 511, WeatherIcon.FREEZING],
  [520, 531, WeatherIcon.HEAVY_RAIN],
  [600, 622, WeatherIcon.SNOW],
  [701, 701, WeatherIcon.MIST],
  [711, 731, WeatherIcon.SAND],
  [741, 741, WeatherIcon.FOG],
  [751, 762, WeatherIcon.SAND],
  [771, 771, WeatherIcon.SQUALLS],
  [781, 781, WeatherIcon.TORNADO],
  [800, 800, WeatherIcon.SUNNY],
  [801, 804, WeatherIcon.CLOUDS],
];

/** Translate an OpenWeatherMap condition code to a G1 icon id. */
export function iconFromOwm(code: number, night = false): number {
  if (night && code === 800) return WeatherIcon.NIGHT;
  for (const [lo, hi, icon] of OWM_RANGES) if (code >= lo && code <= hi) return icon;
  return WeatherIcon.NONE;
}

export class Dashboard {
  readonly #s: Session;
  constructor(session: Session) {
    this.#s = session;
  }

  /** Push the host clock. The glasses have no clock of their own worth trusting. */
  setTime(o: { epochMs?: number; twelveHour?: boolean } = {}): Promise<Response> {
    return this.#s.send(cmd.setTimeAndWeather(o));
  }

  /** Clock and weather travel in the same packet, so this sets both. */
  setWeather(o: cmd.TimeWeatherOptions = {}): Promise<Response> {
    return this.#s.send(cmd.setTimeAndWeather({ icon: WeatherIcon.SUNNY, temperatureC: 20, ...o }));
  }

  setLayout(mode: number = DashboardMode.DUAL, panel: number = DashboardPanel.NOTES): Promise<Response> {
    return this.#s.send(cmd.setDashboardLayout(mode, panel));
  }

  lock(locked = true): Promise<Response> {
    return this.#s.send(cmd.dashboardLock(locked));
  }

  /** Raw quick-note payload. The layout of 0x1E is still guesswork. */
  quickNote(data: ArrayLike<number>): Promise<Response> {
    return this.#s.send(cmd.setQuickNote(data));
  }
}
