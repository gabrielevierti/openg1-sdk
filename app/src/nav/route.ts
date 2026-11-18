/**
 * Routes from OpenStreetMap data, with no key and no account.
 *
 * Search is Nominatim; routing is OSRM as hosted by FOSSGIS
 * (routing.openstreetmap.de), which has car, bicycle and foot profiles and
 * returns speed limits where the map has them. Both are donated public
 * services with fair-use limits: fine for personal use, not for shipping to
 * thousands of users — the endpoints are settings for that reason.
 *
 * This module only talks HTTP and reshapes JSON; following the route is in
 * tracker.ts.
 */
import type { Maneuver } from "openg1";
import { cumulativeDistances, type LatLon } from "./geo.ts";

export type Profile = "car" | "moto" | "bike" | "foot";

/** Road classes a car or motorbike route can be asked to stay off. One at a time: that is what the servers support. */
export type Avoid = "none" | "toll" | "motorway" | "ferry";

export interface Place extends LatLon {
  name: string;
  detail: string;
}

export interface RouteStep {
  maneuver: Maneuver;
  /** The road you are on after the manoeuvre. */
  road: string;
  /** Distance along the route at which the manoeuvre happens. */
  atM: number;
  /** For roundabouts: which exit to take. */
  exit?: number;
}

export interface Route {
  profile: Profile;
  distanceM: number;
  durationS: number;
  line: LatLon[];
  /** Running distance at each vertex of `line`. */
  cumulative: number[];
  steps: RouteStep[];
  /** Speed limit in km/h on the segment starting at each vertex, where known. */
  limits: (number | null)[];
}

export interface Endpoints {
  search: string;
  routing: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  search: "https://nominatim.openstreetmap.org",
  routing: "https://routing.openstreetmap.de",
};

export class RoutingError extends Error {}

async function getJson(url: string, fetcher: typeof fetch): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" } });
  } catch {
    throw new RoutingError("No connection to the map service. Check that the phone is online.");
  }
  if (response.status === 429) throw new RoutingError("The map service is busy (rate limit). Wait a few seconds and try again.");
  if (!response.ok) throw new RoutingError(`The map service answered ${response.status}.`);
  return response.json();
}

/** Look a place up by name or address. `near` biases results towards where you are. */
export async function searchPlaces(
  query: string,
  options: { near?: LatLon; endpoints?: Endpoints; fetch?: typeof fetch; language?: string } = {},
): Promise<Place[]> {
  const base = (options.endpoints ?? DEFAULT_ENDPOINTS).search;
  const params = new URLSearchParams({ format: "jsonv2", q: query, limit: "6", addressdetails: "0" });
  if (options.language) params.set("accept-language", options.language);
  if (options.near) {
    const { lat, lon } = options.near;
    params.set("viewbox", `${lon - 1},${lat + 1},${lon + 1},${lat - 1}`);
  }
  const results = await getJson(`${base}/search?${params}`, options.fetch ?? fetch);
  if (!Array.isArray(results)) return [];
  return results
    .map((r: any): Place => {
      const parts = String(r.display_name ?? "").split(", ");
      return { lat: Number(r.lat), lon: Number(r.lon), name: r.name || parts[0] || query, detail: parts.slice(1, 4).join(", ") };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

const MODIFIER: Record<string, Maneuver> = {
  uturn: "u_turn",
  "sharp right": "sharp_right",
  right: "turn_right",
  "slight right": "slight_right",
  straight: "continue",
  "slight left": "slight_left",
  left: "turn_left",
  "sharp left": "sharp_left",
};

/** OSRM's (type, modifier) pair as one of the SDK's manoeuvres. */
export function maneuverOf(type: string, modifier?: string): Maneuver {
  const side = modifier?.includes("left") ? "left" : "right";
  switch (type) {
    case "arrive":
      return "arrive";
    case "roundabout":
    case "rotary":
      return "roundabout";
    case "merge":
      return "merge";
    case "off ramp":
      return side === "left" ? "exit_left" : "exit_right";
    case "depart":
    case "new name":
    case "notification":
      return type === "depart" ? "continue" : (MODIFIER[modifier ?? "straight"] ?? "continue");
    default:
      // turn, continue, end of road, fork, on ramp, roundabout turn
      return MODIFIER[modifier ?? "straight"] ?? "continue";
  }
}

/** Reshape one OSRM route object. Exported so it can be tested without a network. */
export function parseOsrmRoute(raw: any, profile: Profile): Route {
  const coordinates: [number, number][] = raw?.geometry?.coordinates ?? [];
  if (coordinates.length < 2) throw new RoutingError("The map service returned an empty route.");
  const line = coordinates.map(([lon, lat]) => ({ lat, lon }));
  const cumulative = cumulativeDistances(line);

  const steps: RouteStep[] = [];
  const limits: (number | null)[] = new Array(line.length).fill(null);
  let vertex = 0;
  for (const leg of raw.legs ?? []) {
    const speeds: any[] = leg.annotation?.maxspeed ?? [];
    speeds.forEach((entry, i) => {
      if (entry && typeof entry.speed === "number" && vertex + i < limits.length) {
        limits[vertex + i] = Math.round(entry.unit === "mph" ? entry.speed * 1.609344 : entry.speed);
      }
    });
    let stepVertex = vertex;
    for (const step of leg.steps ?? []) {
      const m = step.maneuver ?? {};
      if (m.type !== "depart") {
        const road = step.name || step.ref || (step.destinations ? `→ ${String(step.destinations).split(",")[0]}` : "");
        const entry: RouteStep = {
          maneuver: maneuverOf(String(m.type), m.modifier),
          road,
          atM: cumulative[Math.min(stepVertex, cumulative.length - 1)]!,
        };
        if (typeof m.exit === "number") entry.exit = m.exit;
        steps.push(entry);
      }
      stepVertex += Math.max(0, (step.geometry?.coordinates?.length ?? 1) - 1);
    }
    vertex = stepVertex;
  }
  if (!steps.length || steps[steps.length - 1]!.maneuver !== "arrive") {
    steps.push({ maneuver: "arrive", road: "", atM: cumulative[cumulative.length - 1]! });
  }
  return {
    profile,
    distanceM: Number(raw.distance) || cumulative[cumulative.length - 1]!,
    durationS: Number(raw.duration) || 0,
    line,
    cumulative,
    steps,
    limits,
  };
}

/** Ask for routes between two points: the best one first, then alternatives when the server offers any. */
export async function findRoutes(
  from: LatLon,
  to: LatLon,
  profile: Profile,
  options: { endpoints?: Endpoints; fetch?: typeof fetch; avoid?: Avoid; alternatives?: boolean } = {},
): Promise<Route[]> {
  const base = (options.endpoints ?? DEFAULT_ENDPOINTS).routing;
  // Motorbikes follow the car network: same roads, same limits.
  const server = profile === "moto" ? "car" : profile;
  const motor = server === "car";
  const build = (avoid: Avoid) =>
    `${base}/routed-${server}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    `?steps=true&geometries=geojson&overview=full&annotations=maxspeed` +
    (options.alternatives ? "&alternatives=true" : "") +
    (motor && avoid !== "none" ? `&exclude=${avoid}` : "");
  const fetcher = options.fetch ?? fetch;
  const avoid = options.avoid ?? "none";
  let data = await getJson(build(avoid), fetcher).catch((error) => {
    // A server that cannot exclude a road class answers 400; the plain route is still worth having.
    if (motor && avoid !== "none" && /answered 400/.test((error as Error).message)) return getJson(build("none"), fetcher);
    throw error;
  });
  if (data?.code !== "Ok" && motor && avoid !== "none") data = await getJson(build("none"), fetcher);
  if (data?.code !== "Ok" || !data.routes?.length) {
    throw new RoutingError(
      data?.code === "NoRoute" ? "No route between those two points for this way of travelling." : "The map service could not build a route.",
    );
  }
  return (data.routes as unknown[]).map((raw) => parseOsrmRoute(raw, profile));
}

/** The best route between two points. */
export async function findRoute(
  from: LatLon,
  to: LatLon,
  profile: Profile,
  options: { endpoints?: Endpoints; fetch?: typeof fetch; avoid?: Avoid } = {},
): Promise<Route> {
  return (await findRoutes(from, to, profile, options))[0]!;
}
