/**
 * Turn-by-turn navigation.
 *
 * Honesty first: the byte layout of the firmware's own navigation command
 * (0x0A) has not been established. So `update()` does not use it. It draws
 * the instruction itself — arrow, distance, road, speed against the limit —
 * as a bitmap, which works today on any firmware and looks better than five
 * lines of text. `raw()` sends an arbitrary 0x0A payload for anyone decoding
 * the real thing.
 */
import type { Canvas } from "../canvas.ts";
import * as cmd from "../commands.ts";
import type { Response, Session } from "../session.ts";
import type { BitmapOptions, BitmapResult, Display } from "./display.ts";

export type Maneuver =
  | "continue"
  | "turn_left"
  | "turn_right"
  | "slight_left"
  | "slight_right"
  | "sharp_left"
  | "sharp_right"
  | "u_turn"
  | "roundabout"
  | "merge"
  | "exit_left"
  | "exit_right"
  | "arrive";

/** One instruction on a route. */
export interface NavigationStep {
  maneuver: Maneuver;
  /** Metres to the manoeuvre. */
  distanceM?: number;
  road?: string;
  /** Metres to the destination. */
  remainingM?: number;
  /** Seconds to the destination. */
  etaS?: number;
  speedKmh?: number;
  speedLimitKmh?: number;
}

const ANGLE: Record<Maneuver, number> = {
  continue: 0,
  turn_left: -90,
  turn_right: 90,
  slight_left: -45,
  slight_right: 45,
  sharp_left: -135,
  sharp_right: 135,
  u_turn: 180,
  roundabout: 0,
  merge: 20,
  exit_left: -30,
  exit_right: 30,
  arrive: 0,
};

const VERB: Record<Maneuver, string> = {
  continue: "continue",
  turn_left: "turn left",
  turn_right: "turn right",
  slight_left: "bear left",
  slight_right: "bear right",
  sharp_left: "sharp left",
  sharp_right: "sharp right",
  u_turn: "U-turn",
  roundabout: "roundabout",
  merge: "merge",
  exit_left: "exit left",
  exit_right: "exit right",
  arrive: "arrive",
};

export function formatDistance(metres: number): string {
  if (metres <= 0) return "";
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** The plain-text rendering, for `display.text` or a log. */
export function stepAsText(step: NavigationStep): string {
  const line1 = `${formatDistance(step.distanceM ?? 0)} ${VERB[step.maneuver]}`.trim();
  const parts: string[] = [];
  if (step.remainingM) parts.push(formatDistance(step.remainingM));
  if (step.etaS) parts.push(formatDuration(step.etaS));
  if (step.speedLimitKmh) parts.push(`limit ${step.speedLimitKmh}`);
  if (step.speedKmh !== undefined) parts.push(`${step.speedKmh} km/h`);
  return [line1, step.road ?? "", parts.join("   ")].filter(Boolean).join("\n");
}

/** Draw one instruction onto a canvas, inside its safe area. */
export function drawStep(c: Canvas, step: NavigationStep): void {
  const { y, height } = c.safe;
  const mid = y + height / 2;
  const iconSize = Math.min(72, height - 8);

  // Left: the manoeuvre.
  if (step.maneuver === "roundabout") {
    c.circle(48, mid, iconSize / 2 - 4, { width: 6 });
    c.arrow(48, mid - iconSize / 2 + 4, 26, 90);
  } else if (step.maneuver === "arrive") {
    c.circle(48, mid - 8, 16, { width: 6 });
    c.polygon(
      [
        [34, mid + 2],
        [62, mid + 2],
        [48, mid + iconSize / 2],
      ],
      { fill: true },
    );
  } else {
    c.arrow(48, mid, iconSize, ANGLE[step.maneuver]);
  }

  // Middle: distance, then the road.
  const distance = formatDistance(step.distanceM ?? 0) || VERB[step.maneuver];
  c.text(distance, 104, y + Math.max(0, height / 2 - 44), { font: "lg" });
  if (step.road) c.text(step.road, 104, y + height / 2 + 2, { font: "md", maxWidth: 290 });
  const footer: string[] = [];
  if (step.remainingM) footer.push(formatDistance(step.remainingM));
  if (step.etaS) footer.push(formatDuration(step.etaS));
  if (footer.length && height >= 100) c.text(footer.join("  ·  "), 104, y + height - 20, { font: "sm" });

  // Right: speed, boxed and inverted when over the limit.
  if (step.speedKmh !== undefined) {
    const over = step.speedLimitKmh !== undefined && step.speedKmh > step.speedLimitKmh;
    const right = c.width - 12;
    c.text(String(step.speedKmh), right - 44, y + Math.max(0, height / 2 - 40), { font: "lg", align: "center" });
    c.text("km/h", right - 44, y + height / 2, { font: "sm", align: "center" });
    if (over) c.invertRect(right - 92, y + Math.max(0, height / 2 - 44), 96, 66);
    if (step.speedLimitKmh !== undefined) {
      c.circle(right - 136, mid - 10, 22, { width: 3 });
      c.text(String(step.speedLimitKmh), right - 136, mid - 10, { font: "sm", align: "center", baseline: "middle" });
    }
  }
}

export class Navigation {
  readonly #s: Session;
  readonly #display: Display;
  constructor(session: Session, display: Display) {
    this.#s = session;
    this.#display = display;
  }

  /** Show one instruction, drawn as a bitmap. */
  update(step: NavigationStep, o: BitmapOptions = {}): Promise<BitmapResult> {
    return this.#display.draw((c) => drawStep(c, step), o);
  }

  /** Show one instruction with the firmware's text renderer instead. Cheaper to send. */
  updateText(step: NavigationStep): Promise<void> {
    return this.#display.text(stepAsText(step), { pageDelayMs: 0 });
  }

  /** Send an arbitrary 0x0A payload. For experimenting with the firmware's own navigation mode. */
  raw(payload: ArrayLike<number>): Promise<Response> {
    return this.#s.send(cmd.setNavigation(payload), { strict: false });
  }

  async stop(): Promise<void> {
    await this.#display.clear();
  }
}
