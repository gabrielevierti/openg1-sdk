/**
 * Following a route: where am I on it, what comes next, am I still on it.
 *
 * Pure arithmetic over a Route and a stream of positions, so it runs the same
 * from GPS, from a simulated drive, and in a test.
 */
import type { NavigationStep } from "openg1";
import { projectOnSegment, type LatLon } from "./geo.ts";
import type { Route } from "./route.ts";

export interface Fix extends LatLon {
  /** Metres per second, when the receiver reports it. */
  speedMps?: number | null;
  /** Milliseconds since the epoch. */
  time: number;
  accuracyM?: number;
}

export interface Progress {
  /** Distance travelled along the route. */
  alongM: number;
  /** How far the fix is from the route line. */
  offsetM: number;
  stepIndex: number;
  toManeuverM: number;
  remainingM: number;
  etaS: number;
  speedKmh: number | null;
  limitKmh: number | null;
  offRoute: boolean;
  arrived: boolean;
}

export interface TrackerOptions {
  /** Further than this from the line counts as off it. Default 45 m. */
  offRouteM?: number;
  /** Consecutive off-line fixes before saying so, to ride out GPS jumps. Default 3. */
  offRouteFixes?: number;
  /** Within this distance of the end counts as arrived. Default 25 m. */
  arriveM?: number;
}

export class RouteTracker {
  readonly route: Route;
  readonly #options: Required<TrackerOptions>;
  #segment = 0;
  #off = 0;
  #last: Fix | null = null;
  #speed: number | null = null;

  constructor(route: Route, options: TrackerOptions = {}) {
    this.route = route;
    this.#options = {
      offRouteM: options.offRouteM ?? 45,
      offRouteFixes: options.offRouteFixes ?? 3,
      arriveM: options.arriveM ?? 25,
    };
  }

  update(fix: Fix): Progress {
    const { line, cumulative, steps, limits } = this.route;

    // Search forward from the last matched segment, a stretch at a time, so a
    // route that crosses itself cannot snap you back to the first pass.
    const search = (from: number, to: number) => {
      let best = { index: from, t: 0, distance: Infinity };
      for (let i = from; i < Math.min(to, line.length - 1); i++) {
        const p = projectOnSegment(fix, line[i]!, line[i + 1]!);
        if (p.distanceM < best.distance) best = { index: i, t: p.t, distance: p.distanceM };
      }
      return best;
    };
    let match = search(this.#segment, this.#segment + 60);
    if (match.distance > this.#options.offRouteM) {
      const wide = search(0, line.length);
      if (wide.distance < match.distance && wide.index >= this.#segment) match = wide;
    }
    if (match.distance <= this.#options.offRouteM) {
      this.#segment = match.index;
      this.#off = 0;
    } else {
      this.#off++;
    }

    const alongM = cumulative[match.index]! + (cumulative[match.index + 1]! - cumulative[match.index]!) * match.t;
    const total = cumulative[cumulative.length - 1]!;
    const remainingM = Math.max(0, total - alongM);

    // The next instruction is the first one still ahead (with a few metres of grace at the turn itself).
    let stepIndex = steps.findIndex((s) => s.atM > alongM + 5);
    if (stepIndex < 0) stepIndex = steps.length - 1;
    const toManeuverM = Math.max(0, steps[stepIndex]!.atM - alongM);

    // Speed: trust the receiver; otherwise derive it from consecutive fixes, smoothed.
    let speedMps = fix.speedMps ?? null;
    if (speedMps === null && this.#last && fix.time > this.#last.time) {
      const d = projectOnSegment(fix, this.#last, this.#last).distanceM;
      speedMps = d / ((fix.time - this.#last.time) / 1000);
    }
    if (speedMps !== null && speedMps >= 0 && speedMps < 90) {
      this.#speed = this.#speed === null ? speedMps : this.#speed * 0.5 + speedMps * 0.5;
    }
    this.#last = fix;

    const pace = this.route.durationS > 0 && total > 0 ? this.route.durationS / total : 0;
    return {
      alongM,
      offsetM: match.distance,
      stepIndex,
      toManeuverM,
      remainingM,
      etaS: remainingM * pace,
      speedKmh: this.#speed === null ? null : Math.round(this.#speed * 3.6),
      limitKmh: limits[match.index] ?? null,
      offRoute: this.#off >= this.#options.offRouteFixes,
      arrived: remainingM <= this.#options.arriveM && this.#off === 0,
    };
  }
}

/** Round a distance the way a navigator speaks it, so the screen changes only when it matters. */
export function roundDistance(metres: number): number {
  if (metres >= 10000) return Math.round(metres / 1000) * 1000;
  if (metres >= 1000) return Math.round(metres / 100) * 100;
  if (metres >= 300) return Math.round(metres / 50) * 50;
  return Math.max(0, Math.round(metres / 10) * 10);
}

/** What to put on the glasses for this moment of the route. */
export function stepFor(route: Route, progress: Progress): NavigationStep {
  const step = route.steps[progress.stepIndex]!;
  const out: NavigationStep = {
    maneuver: progress.arrived ? "arrive" : step.maneuver,
    distanceM: roundDistance(progress.toManeuverM),
    remainingM: roundDistance(progress.remainingM),
    etaS: Math.round(progress.etaS / 60) * 60,
  };
  const road = step.maneuver === "roundabout" && step.exit ? `Exit ${step.exit}${step.road ? ` · ${step.road}` : ""}` : step.road;
  if (road) out.road = road;
  if (progress.speedKmh !== null) out.speedKmh = progress.speedKmh;
  if (progress.limitKmh !== null) out.speedLimitKmh = progress.limitKmh;
  return out;
}

/** A stable key for a screen: two moments with the same key need no redraw. */
export function stepKey(step: NavigationStep): string {
  return [step.maneuver, step.distanceM, step.road, step.remainingM, step.etaS, step.speedKmh, step.speedLimitKmh].join("|");
}
