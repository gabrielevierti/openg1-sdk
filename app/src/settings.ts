/** What the app remembers between launches. One JSON blob in localStorage. */
import { DEFAULT_ENDPOINTS, type Avoid, type Endpoints, type Place, type Profile } from "./nav/route.ts";

export interface Note {
  id: string;
  title: string;
  body: string;
}

export interface Settings {
  /** Rows of the panel the wearer cannot see. Measured on your own pair. */
  hiddenTop: number;
  hiddenBottom: number;
  /** Draw navigation as a bitmap (richer) or as firmware text (lighter on the radio). */
  navStyle: "graphic" | "text";
  profile: Profile;
  avoid: Avoid;
  endpoints: Endpoints;
  recentPlaces: Place[];
  /** Keep the glasses' clock and weather widget fresh while connected. */
  autoSync: boolean;
  /** Where the weather was last asked for, so later connections can refresh it without asking again. */
  weatherAt: { lat: number; lon: number } | null;
  fahrenheit: boolean;
  twelveHour: boolean;
  notes: Note[];
  teleprompterText: string;
  /** Seconds per page when the teleprompter advances by itself; 0 means taps only. */
  teleprompterAutoS: number;
  /** Ids of the mini-apps in the launcher, in order. */
  miniApps: string[];
  /** Apps whose notifications the glasses should show. */
  notifyApps: { id: string; name: string }[];
  notifyCalls: boolean;
  notifyMessages: boolean;
  notifyCalendar: boolean;
  notifyMail: boolean;
  /** Reconnect by itself when the link drops. */
  autoReconnect: boolean;
  simulatorUrl: string;
  /** Follow the phone, or force one appearance. */
  theme: "system" | "light" | "dark";
  /** An OpenAI-compatible chat endpoint for the assistant and translation. Yours: nothing is preconfigured. */
  aiEndpoint: string;
  aiKey: string;
  aiModel: string;
  translateTo: string;
  /** Where each teleprompter text was left, keyed by a hash of the text. */
  lastPages: Record<string, number>;
}

export const DEFAULTS: Settings = {
  hiddenTop: 0,
  hiddenBottom: 0,
  navStyle: "graphic",
  profile: "car",
  avoid: "none",
  endpoints: DEFAULT_ENDPOINTS,
  recentPlaces: [],
  autoSync: true,
  weatherAt: null,
  fahrenheit: false,
  twelveHour: false,
  notes: [],
  teleprompterText: "",
  teleprompterAutoS: 0,
  miniApps: ["clock", "timer", "counter", "status"],
  notifyApps: [],
  notifyCalls: true,
  notifyMessages: true,
  notifyCalendar: true,
  notifyMail: true,
  autoReconnect: true,
  simulatorUrl: "",
  theme: "system",
  aiEndpoint: "",
  aiKey: "",
  aiModel: "",
  translateTo: "English",
  lastPages: {},
};

const KEY = "openg1.app.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* a fresh start is a fine fallback */
  }
  return { ...DEFAULTS };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage full or unavailable: the app still works for this session */
  }
}
