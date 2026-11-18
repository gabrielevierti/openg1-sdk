/**
 * What your glasses are actually like.
 *
 * The simulator and the hardware disagree in exactly one way that matters, and
 * it is not a protocol difference: the framebuffer has 136 rows, and your eye
 * may not get all of them. How many you lose depends on how the glasses sit on
 * your face, so it is a property of your pair and cannot be guessed.
 *
 * That number lives here, once, and both sides read it: the simulator dims the
 * hidden rows, and `display.image` / `display.canvas()` lay out inside the
 * visible band. The default hides nothing — an uncalibrated profile should
 * behave like the raw panel, not like someone else's face.
 */
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from "./generated.ts";
import type { SafeArea } from "./bitmap.ts";

export interface DeviceProfile {
  name: string;
  /** Rows at the top of the panel the wearer cannot see. Measured, never guessed. */
  hiddenTop: number;
  hiddenBottom: number;
  /** The MTU to ask for where the platform lets you ask. Bitmaps want 247. */
  mtu: number;
}

export const DEFAULT_PROFILE: Readonly<DeviceProfile> = Object.freeze({
  name: "default",
  hiddenTop: 0,
  hiddenBottom: 0,
  mtu: 247,
});

/** Fill in defaults and reject margins that leave nothing visible. */
export function makeProfile(partial: Partial<DeviceProfile> = {}): DeviceProfile {
  const profile = { ...DEFAULT_PROFILE, ...partial };
  if (profile.hiddenTop < 0 || profile.hiddenBottom < 0) throw new RangeError("hidden margins cannot be negative");
  if (profile.hiddenTop + profile.hiddenBottom >= DISPLAY_HEIGHT) {
    throw new RangeError(
      `hidden margins ${profile.hiddenTop}+${profile.hiddenBottom} leave nothing of a ${DISPLAY_HEIGHT}px panel visible`,
    );
  }
  return profile;
}

export function safeAreaOf(profile: DeviceProfile): SafeArea {
  return [profile.hiddenTop, profile.hiddenBottom];
}

export function visibleHeight(profile: DeviceProfile): number {
  return DISPLAY_HEIGHT - profile.hiddenTop - profile.hiddenBottom;
}

export function describeProfile(profile: DeviceProfile): string {
  if (!profile.hiddenTop && !profile.hiddenBottom) {
    return `${profile.name}: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, uncalibrated — all ${DISPLAY_HEIGHT} rows assumed visible`;
  }
  return (
    `${profile.name}: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, ${profile.hiddenTop} hidden top / ` +
    `${profile.hiddenBottom} hidden bottom, ${visibleHeight(profile)} rows visible`
  );
}

/**
 * Read the `[device]` table of a profile TOML — the same file the Python SDK
 * writes with `07_calibrate.py --save`, so one calibration serves both.
 */
export function parseProfileToml(text: string): DeviceProfile {
  const found: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (m) found[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  const num = (key: string): number | undefined => (found[key] !== undefined ? Number(found[key]) : undefined);
  const partial: Partial<DeviceProfile> = {};
  if (found.name) partial.name = found.name;
  const top = num("hidden_top");
  const bottom = num("hidden_bottom");
  const mtu = num("mtu");
  if (top !== undefined && Number.isFinite(top)) partial.hiddenTop = top;
  if (bottom !== undefined && Number.isFinite(bottom)) partial.hiddenBottom = bottom;
  if (mtu !== undefined && Number.isFinite(mtu)) partial.mtu = mtu;
  return makeProfile(partial);
}

export function profileToToml(profile: DeviceProfile): string {
  return (
    "# openg1 device profile — shared by the TypeScript and Python SDKs\n" +
    "[device]\n" +
    `name = "${profile.name}"\n` +
    `hidden_top = ${profile.hiddenTop}\n` +
    `hidden_bottom = ${profile.hiddenBottom}\n` +
    `mtu = ${profile.mtu}\n`
  );
}
