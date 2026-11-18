/**
 * Navigation: a turn-by-turn screen with speed against the limit.
 *
 * The firmware has its own navigation mode, but its packet layout is not
 * known, so the SDK draws the screen itself. Feed `update()` from whatever
 * routing source you have.
 *
 *   npx openg1 sim
 *   node examples/03-navigation.ts
 */
import { G1, sleep, type NavigationStep } from "openg1";
import { connectSimulator } from "openg1/transports/ws";

const route: NavigationStep[] = [
  { maneuver: "continue", distanceM: 38000, road: "A7 towards Milano", speedLimitKmh: 130 },
  { maneuver: "exit_right", distanceM: 1200, road: "Exit Milano Ovest", speedLimitKmh: 90 },
  { maneuver: "roundabout", distanceM: 300, road: "Second exit", speedLimitKmh: 50 },
  { maneuver: "turn_left", distanceM: 150, road: "Corso Sempione", speedLimitKmh: 50 },
  { maneuver: "arrive", distanceM: 40, road: "On your right" },
];

const g1 = await G1.connect(connectSimulator());
let remainingM = 142_000;

for (const step of route) {
  for (const factor of [0.92, 1.0, 1.06]) {
    const speedKmh = Math.round((step.speedLimitKmh ?? 20) * factor);
    await g1.navigation.update({ ...step, remainingM, etaS: remainingM / 28, speedKmh });
    remainingM -= 800;
    await sleep(1000);
  }
}

await g1.display.text("You have arrived.");
await g1.disconnect();
