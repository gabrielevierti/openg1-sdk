/** Wearer actions as data, so a web page, a socket or a test can drive a simulator the same way. */
import { OpenG1Error } from "../errors.ts";
import type { ArmName } from "../events.ts";
import type { Simulator } from "./simulator.ts";

export type SimInput =
  | { action: "tap"; arm?: ArmName; count?: 1 | 2 | 3 }
  | { action: "hold-start" | "hold-end"; arm?: ArmName }
  | { action: "look"; up: boolean }
  | { action: "wear"; worn: boolean }
  | { action: "battery"; value: number; arm?: ArmName }
  | { action: "charge"; charging: boolean }
  | { action: "case"; open: boolean }
  | { action: "reset" };

/** Apply one wearer action. Throws for an action it does not know. */
export function applyInput(sim: Simulator, input: SimInput): void {
  const arm = (value: unknown, fallback: ArmName): ArmName => (value === "left" || value === "right" ? value : fallback);
  switch (input.action) {
    case "tap": {
      const count = input.count === 2 || input.count === 3 ? input.count : 1;
      return sim.tap(arm(input.arm, "right"), count);
    }
    case "hold-start":
      return sim.holdStart(arm(input.arm, "left"));
    case "hold-end":
      return sim.holdEnd(arm(input.arm, "left"));
    case "look":
      return sim.lookUp(Boolean(input.up));
    case "wear":
      return sim.wear(Boolean(input.worn));
    case "battery":
      return sim.setBattery(Number(input.value), input.arm);
    case "charge":
      return sim.charge(Boolean(input.charging));
    case "case":
      return sim.caseLid(Boolean(input.open));
    case "reset":
      return sim.reset();
    default:
      throw new OpenG1Error(
        `unknown action "${(input as { action?: string }).action}". Use tap, hold-start, hold-end, look, wear, battery, charge, case or reset.`,
      );
  }
}
