/**
 * openg1/sim — the simulator, as a library.
 *
 * Browser-safe and dependency-free: this is the part that runs inside a web
 * page, a test, or a phone. The server that exposes a simulator to other
 * processes lives in `openg1/server`.
 */
import { G1, type G1Options } from "../g1.ts";
import { Simulator, type SimulatorOptions } from "./simulator.ts";

export * from "./firmware.ts";
export * from "./renderer.ts";
export * from "./simulator.ts";

/**
 * A simulator with a connected `G1`, in one call:
 *
 *     const { g1, sim } = await simulate();
 */
export async function simulate(
  options: SimulatorOptions & { g1?: G1Options } = {},
): Promise<{ g1: G1; sim: Simulator }> {
  const sim = new Simulator(options);
  const g1 = await G1.connect(sim.pair(), { profile: sim.profile, ...options.g1 });
  return { g1, sim };
}
export * from "./input.ts";
