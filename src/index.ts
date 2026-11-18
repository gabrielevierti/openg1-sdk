/**
 * openg1 — an open SDK for Even Realities G1 smart glasses.
 *
 * This entry point is pure protocol and runs anywhere JavaScript does. Pick a
 * transport from `openg1/transports/*` to reach real glasses or the simulator.
 */
export * from "./generated.ts";
export * from "./bytes.ts";
export * from "./errors.ts";
export * from "./crc.ts";
export * from "./framing.ts";
export * as commands from "./commands.ts";
export type { Outbound, Target } from "./commands.ts";
export * from "./events.ts";
export * as text from "./text.ts";
export { wrap, paginate, measure, splitUtf8, DEFAULT_METRICS, type FontMetrics } from "./text.ts";
export * from "./bitmap.ts";
export * from "./font.ts";
export * from "./canvas.ts";
export * from "./audio.ts";
export * from "./profile.ts";
export * from "./transport.ts";
export * from "./session.ts";
export * from "./g1.ts";
export * from "./app.ts";
export { Display, type BitmapOptions, type BitmapResult, type RgbaImage } from "./api/display.ts";
export type { TextOptions as DisplayTextOptions } from "./api/display.ts";
export { DeviceInfo, decodeSerial, type Battery, type Firmware, type SerialInfo } from "./api/info.ts";
export { Settings } from "./api/settings.ts";
export { Dashboard, iconFromOwm } from "./api/dashboard.ts";
export { Notifications, chunkJson, type NotifyOptions } from "./api/notifications.ts";
export { Audio } from "./api/audio.ts";
export {
  Navigation,
  drawStep,
  stepAsText,
  formatDistance,
  formatDuration,
  type Maneuver,
  type NavigationStep,
} from "./api/navigation.ts";
export { Assistant, type Responder, type AssistantOptions } from "./api/ai.ts";

export { VERSION } from "./version.ts";
export * from "./draw-ops.ts";
export * from "./describe.ts";
