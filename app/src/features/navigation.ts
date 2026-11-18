/** The navigator as an activity: positions in, a turn-by-turn screen on the glasses out. */
import { sleep, stepAsText, type NavigationStep } from "openg1";
import type { Activity } from "../activities.ts";
import type { LatLon } from "../nav/geo.ts";
import { findRoute, type Avoid, type Endpoints, type Route } from "../nav/route.ts";
import { RouteTracker, stepFor, stepKey, type Fix, type Progress } from "../nav/tracker.ts";
import type { PositionSource } from "./position.ts";

export interface NavigationView {
  route: Route;
  progress: Progress | null;
  step: NavigationStep | null;
  rerouting: boolean;
}

export interface NavigationOptions {
  route: Route;
  destination: LatLon & { name: string };
  source: PositionSource;
  style: "graphic" | "text";
  endpoints: Endpoints;
  avoid: Avoid;
  /** Called on every fix, so the phone's own screen can follow along. */
  onUpdate(view: NavigationView): void;
}

export function navigationActivity(options: NavigationOptions): Activity {
  return {
    id: "navigation",
    title: `Navigating to ${options.destination.name}`,
    async run({ g1, signal, status }) {
      let route = options.route;
      let tracker = new RouteTracker(route);
      let latest: NavigationStep | null = null;
      let sentKey = "";
      let arrived = false;
      let rerouting = false;
      let lastReroute = 0;
      let wake: (() => void) | null = null;

      const reroute = async (from: Fix) => {
        rerouting = true;
        status("Off the route. Finding a new one…");
        try {
          route = await findRoute(from, options.destination, route.profile, { endpoints: options.endpoints, avoid: options.avoid });
          tracker = new RouteTracker(route);
        } catch (error) {
          status(`Could not reroute: ${(error as Error).message}`);
        } finally {
          rerouting = false;
        }
      };

      const stop = await options.source.watch(
        (fix) => {
          const progress = tracker.update(fix);
          latest = stepFor(route, progress);
          arrived = progress.arrived;
          options.onUpdate({ route, progress, step: latest, rerouting });
          if (!rerouting) status(arrived ? "You have arrived." : "");
          // A wrong turn: ask for a new route, but not more than once every ten seconds.
          if (progress.offRoute && !options.source.simulated && !rerouting && Date.now() - lastReroute > 10000) {
            lastReroute = Date.now();
            void reroute(fix);
          }
          wake?.();
        },
        (message) => status(message),
      );

      try {
        status("Waiting for a location fix…");
        // A frame takes about a second over Bluetooth. Rather than queueing
        // one per fix, send the newest whenever the previous one has landed.
        while (!signal.aborted) {
          const step = latest as NavigationStep | null;
          const key = step ? stepKey(step) : "";
          if (step && key !== sentKey) {
            sentKey = key;
            if (options.style === "text") await g1.display.text(stepAsText(step), { pageDelayMs: 0 });
            else await g1.navigation.update(step);
            if (arrived) {
              await sleep(6000, signal).catch(() => {});
              return;
            }
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            wake = null;
          }
        }
      } finally {
        stop();
      }
    },
  };
}
