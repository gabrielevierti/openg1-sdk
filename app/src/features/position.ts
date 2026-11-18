/** Where the phone is: the native plugin in the app, the browser API on the web, or a pretend drive. */
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { pointAlong, type LatLon } from "../nav/geo.ts";
import type { Route } from "../nav/route.ts";
import type { Fix } from "../nav/tracker.ts";

export type StopWatching = () => void;

export interface PositionSource {
  readonly simulated: boolean;
  watch(onFix: (fix: Fix) => void, onError: (message: string) => void): Promise<StopWatching>;
}

const DENIED = "Location permission is off. Allow it for this app in the phone's settings to navigate.";

/** One reading, for "from where I am". */
export async function currentPosition(): Promise<LatLon> {
  if (Capacitor.isNativePlatform()) {
    const permission = await Geolocation.requestPermissions().catch(() => null);
    if (permission && permission.location === "denied") throw new Error(DENIED);
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  }
  if (!("geolocation" in navigator)) throw new Error("This browser cannot report a location.");
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? DENIED : "Could not get a location fix. Try again outdoors.")),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

/** The real receiver. */
export function gpsSource(): PositionSource {
  return {
    simulated: false,
    async watch(onFix, onError) {
      if (Capacitor.isNativePlatform()) {
        const id = await Geolocation.watchPosition({ enableHighAccuracy: true, minimumUpdateInterval: 1000 }, (p, error) => {
          if (error || !p) return onError(error?.message ?? "No location fix.");
          onFix({ lat: p.coords.latitude, lon: p.coords.longitude, speedMps: p.coords.speed, accuracyM: p.coords.accuracy, time: p.timestamp });
        });
        return () => void Geolocation.clearWatch({ id });
      }
      const id = navigator.geolocation.watchPosition(
        (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, speedMps: p.coords.speed, accuracyM: p.coords.accuracy, time: p.timestamp }),
        (e) => onError(e.code === e.PERMISSION_DENIED ? DENIED : "Lost the location fix."),
        { enableHighAccuracy: true, maximumAge: 1000 },
      );
      return () => navigator.geolocation.clearWatch(id);
    },
  };
}

/**
 * A pretend drive along a route, for trying the navigator at a desk. Speed
 * follows the route's own limits where it has them, a little over now and
 * then so the warning shows.
 */
export function simulatedSource(route: Route, options: { timeScale?: number; intervalMs?: number } = {}): PositionSource {
  const scale = options.timeScale ?? 8;
  const interval = options.intervalMs ?? 500;
  return {
    simulated: true,
    async watch(onFix) {
      const total = route.cumulative[route.cumulative.length - 1]!;
      const cruise = route.durationS > 0 ? total / route.durationS : 12;
      let along = 0;
      let vertex = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        while (vertex < route.cumulative.length - 2 && route.cumulative[vertex + 1]! <= along) vertex++;
        const limit = route.limits[vertex];
        const base = limit ? limit / 3.6 : cruise;
        const speed = base * (ticks % 24 > 18 ? 1.12 : 0.94);
        along = Math.min(total, along + speed * (interval / 1000) * scale);
        ticks++;
        onFix({ ...pointAlong(route.line, route.cumulative, along), speedMps: speed, time: Date.now() });
        if (along >= total) clearInterval(timer);
      }, interval);
      return () => clearInterval(timer);
    },
  };
}
