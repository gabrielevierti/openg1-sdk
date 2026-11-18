import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_OSRM_ROUTE } from "../src/nav/demo-route.ts";
import { distanceM, pointAlong, projectOnSegment } from "../src/nav/geo.ts";
import { findRoute, maneuverOf, parseOsrmRoute, RoutingError, searchPlaces } from "../src/nav/route.ts";
import { roundDistance, RouteTracker, stepFor, stepKey } from "../src/nav/tracker.ts";

test("distances and projections are right at street scale", () => {
  // One degree of latitude is about 111.2 km everywhere.
  assert.ok(Math.abs(distanceM({ lat: 45, lon: 9 }, { lat: 46, lon: 9 }) - 111195) < 50);
  // Milano Duomo to Genova Brignole, as the crow flies: about 119 km.
  const d = distanceM({ lat: 45.4642, lon: 9.19 }, { lat: 44.4071, lon: 8.9347 });
  assert.ok(d > 118000 && d < 120500, String(d));
  const p = projectOnSegment({ lat: 45.001, lon: 9.005 }, { lat: 45, lon: 9 }, { lat: 45, lon: 9.01 });
  assert.ok(Math.abs(p.t - 0.5) < 0.01);
  assert.ok(Math.abs(p.distanceM - 111.2) < 1);
  assert.equal(projectOnSegment({ lat: 45, lon: 8.9 }, { lat: 45, lon: 9 }, { lat: 45, lon: 9.01 }).t, 0);
});

test("OSRM manoeuvres map onto the SDK's", () => {
  assert.equal(maneuverOf("turn", "left"), "turn_left");
  assert.equal(maneuverOf("turn", "sharp right"), "sharp_right");
  assert.equal(maneuverOf("end of road", "right"), "turn_right");
  assert.equal(maneuverOf("fork", "slight left"), "slight_left");
  assert.equal(maneuverOf("continue", "uturn"), "u_turn");
  assert.equal(maneuverOf("new name", "straight"), "continue");
  assert.equal(maneuverOf("off ramp", "slight right"), "exit_right");
  assert.equal(maneuverOf("off ramp", "slight left"), "exit_left");
  assert.equal(maneuverOf("rotary", "right"), "roundabout");
  assert.equal(maneuverOf("merge", "slight left"), "merge");
  assert.equal(maneuverOf("arrive"), "arrive");
  assert.equal(maneuverOf("something new", "who knows"), "continue");
});

test("an OSRM route becomes steps placed along the line, with speed limits", () => {
  const route = parseOsrmRoute(DEMO_OSRM_ROUTE, "car");
  assert.equal(route.line.length, 11);
  assert.deepEqual(route.steps.map((s) => s.maneuver), ["turn_left", "roundabout", "turn_left", "arrive"]);
  assert.deepEqual(route.steps.map((s) => s.road), ["Via Manzoni", "Piazza Cavour", "Via Turati", "Via Turati"]);
  assert.equal(route.steps[1]!.exit, 2);
  // The first turn is at vertex 3, three ~313 m blocks in.
  assert.ok(Math.abs(route.steps[0]!.atM - route.cumulative[3]!) < 0.01);
  assert.ok(Math.abs(route.steps[0]!.atM - 938) < 5, String(route.steps[0]!.atM));
  assert.equal(route.steps.at(-1)!.atM, route.cumulative.at(-1));
  assert.deepEqual(route.limits.slice(0, 7), [50, 50, 50, 30, 30, null, 50]);
  assert.throws(() => parseOsrmRoute({ geometry: { coordinates: [] } }, "car"), RoutingError);
});

test("the tracker follows a drive: next turn, distances, limit, arrival", () => {
  const route = parseOsrmRoute(DEMO_OSRM_ROUTE, "car");
  const tracker = new RouteTracker(route);
  const seen: string[] = [];
  let time = 0;
  let last = tracker.update({ ...route.line[0]!, time });
  assert.equal(last.stepIndex, 0);
  assert.equal(last.limitKmh, 50);
  assert.equal(last.speedKmh, null, "no speed from a single fix");

  // 14 m/s (about 50 km/h), one fix a second.
  const total = route.cumulative.at(-1)!;
  for (let along = 14; along < total; along += 14) {
    time += 1000;
    last = tracker.update({ ...pointAlong(route.line, route.cumulative, along), time });
    assert.ok(Math.abs(last.alongM - along) < 1, `along ${along}: got ${last.alongM}`);
    assert.equal(last.offRoute, false);
    const name = `${route.steps[last.stepIndex]!.maneuver}@${route.steps[last.stepIndex]!.road}`;
    if (seen.at(-1) !== name) seen.push(name);
  }
  assert.deepEqual(seen, ["turn_left@Via Manzoni", "roundabout@Piazza Cavour", "turn_left@Via Turati", "arrive@Via Turati"]);
  assert.equal(last.speedKmh, 50);
  assert.equal(last.arrived, true);
  assert.ok(last.remainingM < 25);
});

test("the tracker says off-route only after several bad fixes, and recovers", () => {
  const route = parseOsrmRoute(DEMO_OSRM_ROUTE, "car");
  const tracker = new RouteTracker(route);
  const on = pointAlong(route.line, route.cumulative, 300);
  const off = { lat: on.lat + 0.002, lon: on.lon }; // about 220 m north of the street
  assert.equal(tracker.update({ ...on, time: 0 }).offRoute, false);
  assert.equal(tracker.update({ ...off, time: 1000 }).offRoute, false, "one jump is noise");
  assert.equal(tracker.update({ ...off, time: 2000 }).offRoute, false);
  const third = tracker.update({ ...off, time: 3000 });
  assert.equal(third.offRoute, true);
  assert.ok(third.offsetM > 200);
  assert.equal(tracker.update({ ...on, time: 4000 }).offRoute, false);
});

test("what goes on the glasses is rounded so it changes only when it matters", () => {
  assert.deepEqual([4, 96, 149, 320, 1249, 38420].map(roundDistance), [0, 100, 150, 300, 1200, 38000]);
  const route = parseOsrmRoute(DEMO_OSRM_ROUTE, "car");
  const tracker = new RouteTracker(route);
  const a = stepFor(route, tracker.update({ ...pointAlong(route.line, route.cumulative, 500), time: 0, speedMps: 13 }));
  const b = stepFor(route, tracker.update({ ...pointAlong(route.line, route.cumulative, 503), time: 300, speedMps: 13 }));
  assert.deepEqual(a, { maneuver: "turn_left", distanceM: 450, remainingM: 2600, etaS: 300, road: "Via Manzoni", speedKmh: 47, speedLimitKmh: 50 });
  assert.equal(stepKey(a), stepKey(b), "three metres further is the same screen");
  const c = stepFor(route, tracker.update({ ...pointAlong(route.line, route.cumulative, 1900), time: 9000, speedMps: 13 }));
  assert.equal(c.road, "Exit 2 · Piazza Cavour");
});

test("search and routing build the right requests and explain failures", async () => {
  const urls: string[] = [];
  const fake = (body: unknown, status = 200): typeof fetch =>
    (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as never;

  const places = await searchPlaces("Duomo", {
    near: { lat: 45.46, lon: 9.19 },
    fetch: fake([{ lat: "45.4641", lon: "9.1919", name: "Duomo di Milano", display_name: "Duomo di Milano, Piazza del Duomo, Milano, Lombardia, Italia" }]),
  });
  assert.deepEqual(places, [{ lat: 45.4641, lon: 9.1919, name: "Duomo di Milano", detail: "Piazza del Duomo, Milano, Lombardia" }]);
  assert.match(urls[0]!, /^https:\/\/nominatim\.openstreetmap\.org\/search\?format=jsonv2&q=Duomo&limit=6/);

  const route = await findRoute({ lat: 45.47, lon: 9.18 }, { lat: 45.4835, lon: 9.2 }, "bike", { fetch: fake({ code: "Ok", routes: [DEMO_OSRM_ROUTE] }) });
  assert.equal(route.profile, "bike");
  assert.equal(
    urls[1],
    "https://routing.openstreetmap.de/routed-bike/route/v1/driving/9.18,45.47;9.2,45.4835?steps=true&geometries=geojson&overview=full&annotations=maxspeed",
  );
  const at = { lat: 0, lon: 0 };
  await assert.rejects(findRoute(at, at, "car", { fetch: fake({ code: "NoRoute" }) }), /No route between/);
  await assert.rejects(findRoute(at, at, "car", { fetch: fake({}, 429) }), /rate limit/);
  await assert.rejects(findRoute(at, at, "car", { fetch: (async () => { throw new TypeError("offline"); }) as never }), /No connection/);
});

test("motorbikes use the car network, alternatives come back in order, and avoiding falls back", async () => {
  const { findRoutes } = await import("../src/nav/route.ts");
  const urls: string[] = [];
  const longer = { ...DEMO_OSRM_ROUTE, distance: 4000, duration: 500 };
  const fake = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("exclude=")) return new Response(JSON.stringify({ code: "InvalidValue" }), { status: 400 });
    return new Response(JSON.stringify({ code: "Ok", routes: [DEMO_OSRM_ROUTE, longer] }));
  }) as never;
  const at = { lat: 45.47, lon: 9.18 };
  const routes = await findRoutes(at, { lat: 45.48, lon: 9.2 }, "moto", { fetch: fake, alternatives: true, avoid: "toll" });
  assert.match(urls[0]!, /routed-car\/.*alternatives=true&exclude=toll$/);
  assert.ok(!urls[1]!.includes("exclude"), "a server that cannot exclude still gives the plain route");
  assert.deepEqual(routes.map((r) => [r.profile, r.distanceM]), [["moto", 3061], ["moto", 4000]]);
  urls.length = 0;
  await findRoutes(at, at, "bike", { fetch: fake, avoid: "motorway" });
  assert.match(urls[0]!, /routed-bike/);
  assert.ok(!urls[0]!.includes("exclude"), "avoid applies to motor routes only");
});
