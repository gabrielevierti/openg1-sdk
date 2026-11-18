/** Clock, weather, and a heads-up screen of our own. */
import { sleep, WeatherIcon, type G1 } from "openg1";
import type { Activity } from "../activities.ts";
import type { LatLon } from "../nav/geo.ts";

export interface Weather {
  temperatureC: number;
  icon: number;
  label: string;
}

/** WMO weather codes, as Open-Meteo reports them, to the glasses' icon set. */
export function iconFromWmo(code: number, isDay = true): { icon: number; label: string } {
  if (code === 0) return isDay ? { icon: WeatherIcon.SUNNY, label: "Clear" } : { icon: WeatherIcon.NIGHT, label: "Clear" };
  if (code <= 3) return { icon: WeatherIcon.CLOUDS, label: code === 3 ? "Overcast" : "Partly cloudy" };
  if (code === 45 || code === 48) return { icon: WeatherIcon.FOG, label: "Fog" };
  if (code >= 51 && code <= 55) return { icon: WeatherIcon.DRIZZLE, label: "Drizzle" };
  if (code === 56 || code === 57 || code === 66 || code === 67) return { icon: WeatherIcon.FREEZING, label: "Freezing rain" };
  if (code === 61 || code === 63 || code === 80 || code === 81) return { icon: WeatherIcon.RAIN, label: "Rain" };
  if (code === 65 || code === 82) return { icon: WeatherIcon.HEAVY_RAIN, label: "Heavy rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: WeatherIcon.SNOW, label: "Snow" };
  if (code >= 95) return { icon: WeatherIcon.THUNDERSTORM, label: "Thunderstorm" };
  return { icon: WeatherIcon.NONE, label: "" };
}

/** Current weather from Open-Meteo: free, no key. */
export async function fetchWeather(at: LatLon, fetcher: typeof fetch = fetch): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${at.lat.toFixed(3)}&longitude=${at.lon.toFixed(3)}` +
    `&current=temperature_2m,weather_code,is_day`;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch {
    throw new Error("No connection to the weather service.");
  }
  if (!response.ok) throw new Error(`The weather service answered ${response.status}.`);
  const current = (await response.json())?.current;
  if (typeof current?.temperature_2m !== "number") throw new Error("The weather service sent no reading.");
  return { temperatureC: current.temperature_2m, ...iconFromWmo(Number(current.weather_code), current.is_day !== 0) };
}

/** Set the glasses' clock, and their weather widget when a reading is at hand. */
export async function syncDashboard(
  g1: G1,
  options: { weather?: Weather | null; fahrenheit: boolean; twelveHour: boolean },
): Promise<void> {
  if (options.weather) {
    await g1.dashboard.setWeather({
      icon: options.weather.icon,
      temperatureC: options.weather.temperatureC,
      fahrenheit: options.fahrenheit,
      twelveHour: options.twelveHour,
    });
  } else {
    await g1.dashboard.setTime({ twelveHour: options.twelveHour });
  }
}

/** A screen that stays up: time, date, weather, both batteries. Redrawn when the minute changes. */
export function hudActivity(options: { weather(): Weather | null; twelveHour: boolean; fahrenheit: boolean }): Activity {
  return {
    id: "hud",
    title: "Heads-up screen",
    async run({ g1, signal }) {
      let shown = "";
      while (!signal.aborted) {
        const now = new Date();
        const time = now.toLocaleTimeString(options.twelveHour ? "en-US" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: options.twelveHour }).replace(/ ?[AP]M/i, "");
        const weather = options.weather();
        const battery = await g1.info.battery();
        const key = `${time}|${weather?.temperatureC}|${battery.lowest}`;
        if (key !== shown) {
          shown = key;
          await g1.display.draw((c) => {
            const { y, height } = c.safe;
            c.text(time, 16, y + Math.max(0, (height - 76) / 2), { font: "xl" });
            c.text(now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }), 250, y + 10, { font: "md", maxWidth: 250 });
            if (weather) {
              const t = options.fahrenheit ? `${Math.round(weather.temperatureC * 1.8 + 32)}°F` : `${Math.round(weather.temperatureC)}°C`;
              c.text(`${t}  ${weather.label}`, 250, y + 40, { font: "md", maxWidth: 300 });
            }
            c.battery(c.width - 44, y + height - 22, battery.lowest);
            c.text(`${battery.lowest}%`, c.width - 50, y + height - 24, { font: "sm", align: "right" });
          });
        }
        await sleep(5000, signal).catch(() => {});
      }
    },
  };
}
