/**
 * Builders for every command in the spec.
 *
 * Each builder returns an {@link Outbound} describing what to send and where.
 * It never touches the radio and never allocates a sequence number — the
 * session does both — which keeps this module pure, and is why the conformance
 * vectors in protocol/vectors.json can be checked against it byte for byte.
 */
import {
  BMP_STORAGE_ADDRESS,
  COMMANDS,
  DashboardMode,
  DashboardPanel,
  DashboardSub,
  ScreenAction,
  ScreenStatus,
  SilentMode,
  WeatherIcon,
  type CommandSpec,
} from "./generated.ts";
import { concat, utf8, type Bytes } from "./bytes.ts";
import { crc32BE } from "./crc.ts";
import { ProtocolError } from "./errors.ts";

export type Target = "left" | "right" | "both";

/** One packet, ready for the session to stamp and write. */
export interface Outbound {
  readonly command: string;
  readonly body: Bytes;
  /** Undefined means "whatever the spec says for this command". */
  readonly target?: Target;
  /** False for fire-and-forget writes inside a bulk transfer. */
  readonly awaitAck: boolean;
}

export function specOf(out: Outbound): CommandSpec {
  const spec = COMMANDS[out.command];
  if (!spec) throw new ProtocolError(`unknown command ${out.command}`);
  return spec;
}

export function resolvedTarget(out: Outbound): Target {
  return out.target ?? specOf(out).target;
}

/** The same packet, addressed to one arm (or both). */
export function to(out: Outbound, target: Target): Outbound {
  return { ...out, target };
}

export function fireAndForget(out: Outbound): Outbound {
  return { ...out, awaitAck: false };
}

/** Build an Outbound for any command by name: spec prefix + your bytes. The escape hatch. */
export function command(name: string, data: ArrayLike<number> = []): Outbound {
  const spec = COMMANDS[name];
  if (!spec) throw new ProtocolError(`unknown command ${name}`);
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (!Number.isInteger(b) || b < 0 || b > 0xff) throw new ProtocolError(`${name}: byte out of range: ${b}`);
  }
  return { command: name, body: concat(spec.prefix, data), awaitAck: true };
}

function body(name: string, data: ArrayLike<number>): Outbound {
  if (!COMMANDS[name]) throw new ProtocolError(`unknown command ${name}`);
  return { command: name, body: Uint8Array.from(data), awaitAck: true };
}

function range(name: string, value: number, lo: number, hi: number): number {
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new ProtocolError(`${name} must be an integer between ${lo} and ${hi}, got ${value}`);
  }
  return value;
}

const bit = (flag: boolean): number => (flag ? 1 : 0);

// --- Display ---------------------------------------------------------------

/** Screen brightness. Hardware range is 0..42 (0x2A), not 0..100. */
export const setBrightness = (level: number, auto = false): Outbound =>
  command("SET_BRIGHTNESS", [range("brightness", level, 0, 0x2a), bit(auto)]);
export const getBrightness = (): Outbound => command("GET_BRIGHTNESS");

export interface SendTextOptions {
  seq: number;
  totalPackages: number;
  packageIndex: number;
  screenStatus?: number;
  newCharPos?: number;
  page?: number;
  maxPage?: number;
}

/** One 0x4E packet: nine header bytes, then UTF-8. */
export function sendText(data: Bytes, o: SendTextOptions): Outbound {
  const status = o.screenStatus ?? (ScreenStatus.TEXT_SHOW | ScreenAction.NEW_CONTENT);
  const pos = (o.newCharPos ?? 0) & 0xffff;
  const header = [
    o.seq & 0xff,
    range("totalPackages", o.totalPackages, 1, 255),
    range("packageIndex", o.packageIndex, 0, 255),
    status & 0xff,
    pos >> 8,
    pos & 0xff,
    range("page", o.page ?? 1, 0, 255),
    range("maxPage", o.maxPage ?? 1, 1, 255),
  ];
  return body("SEND_TEXT", concat(header, data));
}

export const clearScreen = (): Outbound => command("CLEAR_SCREEN");

/** One 0x15 packet. The first one carries the destination address. */
export function bmpPacket(index: number, chunk: Bytes, first = false): Outbound {
  return body("BMP_DATA", concat([index & 0xff], first ? BMP_STORAGE_ADDRESS : [], chunk));
}
export const bmpEnd = (): Outbound => command("BMP_END");
export const bmpCrcPacket = (crc: number): Outbound => body("BMP_CRC", crc32BE(crc));

/**
 * Virtual screen geometry. Must be sent twice — preview first, then again
 * with preview=false within a few seconds to commit. `display.setGeometry`
 * does the two-step for you.
 */
export const setDisplaySettings = (height: number, depth: number, preview: boolean): Outbound =>
  command("SET_DISPLAY_SETTINGS", [
    0x08,
    0x02,
    bit(preview),
    range("height", height, 0, 8),
    range("depth", depth, 1, 9),
  ]);
export const getDisplaySettings = (): Outbound => command("GET_DISPLAY_SETTINGS");
export const displayPower = (on: boolean): Outbound => command("DISPLAY_POWER", [bit(on)]);

// --- Session -----------------------------------------------------------------

/** Keepalive. Carries its own counter, distinct from the global sequence. */
export const heartbeat = (counter: number): Outbound => command("HEARTBEAT", [0x04, counter & 0xff]);
export const seqSync = (): Outbound => command("SEQ_SYNC", [0x01]);
export const init = (): Outbound => command("INIT");
/** Reboot both arms. No reply — the link drops mid-command. */
export const hardReset = (): Outbound => command("HARD_RESET");
export const getFirmwareInfo = (): Outbound => command("GET_FIRMWARE_INFO");
export const getUptime = (): Outbound => command("GET_UPTIME");
export const getBattery = (): Outbound => command("GET_BATTERY");
export const getDeviceInfo = (): Outbound => command("GET_DEVICE_INFO");
export const getMacAddress = (): Outbound => command("GET_MAC_ADDRESS");
export const getGlassesSerial = (): Outbound => command("GET_GLASSES_SERIAL");
export const getDeviceSerial = (): Outbound => command("GET_DEVICE_SERIAL");
export const getEsbChannel = (): Outbound => command("GET_ESB_CHANNEL");
export const getEsbNotifyCount = (): Outbound => command("GET_ESB_NOTIFY_COUNT");
/** Local usage telemetry. May contain personal data; nothing leaves the host. */
export const getBuriedPoint = (): Outbound => command("GET_BURIED_POINT");

// --- Audio -------------------------------------------------------------------

/** Right arm only. Enabling starts an LC3 stream of audio events. */
export const micControl = (enable: boolean): Outbound => command("MIC_CONTROL", [bit(enable)]);

// --- Settings ----------------------------------------------------------------

export const setSilentMode = (enabled: boolean): Outbound =>
  command("SET_SILENT_MODE", [enabled ? SilentMode.ON : SilentMode.OFF]);
export const getSilentMode = (): Outbound => command("GET_SILENT_MODE");
/** Tilt in degrees (0..60) at which the display wakes. */
export const setHeadupAngle = (angle: number, level = 1): Outbound =>
  command("SET_HEADUP_ANGLE", [range("angle", angle, 0, 0x3c), level]);
export const getHeadupAngle = (): Outbound => command("GET_HEADUP_ANGLE");
export const setWearDetection = (enable: boolean): Outbound => command("SET_WEAR_DETECTION", [bit(enable)]);
export const getWearDetection = (): Outbound => command("GET_WEAR_DETECTION");
export const getAntiShake = (): Outbound => command("GET_ANTI_SHAKE");
/** Rebind the head-up gesture. See ButtonAction. */
export const setButtonConfig = (action: number): Outbound => command("SET_BUTTON_CONFIG", [0x03, action & 0xff]);
/** Rebind the double-tap gesture. Shares opcode 0x26 with the geometry command. */
export const setGestureConfig = (action: number): Outbound => command("SET_GESTURE_CONFIG", [0x05, action & 0xff]);
export const calibration = (step: number, data: ArrayLike<number> = []): Outbound =>
  command("CALIBRATION", concat([step & 0xff], data));
/** Re-zero the head-tracking reference. */
export const resetZeroDegree = (): Outbound => calibration(0x01);
export const setLanguage = (language: number): Outbound => command("SET_LANGUAGE", [0x01, language & 0xff]);
export const setMessageMode = (mode: number): Outbound => command("SET_MESSAGE_MODE", [mode & 0xff]);
export const setAncsConfig = (data: ArrayLike<number>): Outbound => command("SET_ANCS_CONFIG", data);
export const setDebugMode = (enable: boolean): Outbound => command("SET_DEBUG_MODE", [bit(enable)]);

// --- Dashboard ---------------------------------------------------------------

export interface TimeWeatherOptions {
  /** Unix time in milliseconds. Defaults to now. */
  epochMs?: number;
  icon?: number;
  temperatureC?: number;
  fahrenheit?: boolean;
  twelveHour?: boolean;
}

/**
 * Clock and weather widget. The device wants the timestamp twice: 32-bit
 * seconds and 64-bit milliseconds, both little endian. Temperature is always
 * sent in Celsius; `fahrenheit` only changes what the glasses render.
 */
export function setTimeAndWeather(o: TimeWeatherOptions = {}): Outbound {
  const ms = Math.floor(o.epochMs ?? Date.now());
  const s = Math.floor(ms / 1000);
  const lo = ms % 0x100000000;
  const hi = Math.floor(ms / 0x100000000);
  const temp = range("temperatureC", Math.round(o.temperatureC ?? 0), -128, 127);
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  return body("SET_DASHBOARD", [
    DashboardSub.TIME_WEATHER,
    ...u32(s >>> 0),
    ...u32(lo >>> 0),
    ...u32(hi >>> 0),
    range("icon", o.icon ?? WeatherIcon.NONE, 0, 0x10),
    temp & 0xff,
    bit(o.fahrenheit ?? false),
    bit(o.twelveHour ?? false),
  ]);
}

/** Dashboard layout. `panel` is ignored in MINIMAL mode. */
export const setDashboardLayout = (
  mode: number = DashboardMode.DUAL,
  panel: number = DashboardPanel.NOTES,
): Outbound => body("SET_DASHBOARD", [DashboardSub.LAYOUT, range("mode", mode, 0, 2), panel & 0xff]);
export const dashboardLock = (locked: boolean): Outbound => command("DASHBOARD_LOCK", [0x01, bit(locked)]);
export const setQuickNote = (data: ArrayLike<number>): Outbound => command("SET_QUICK_NOTE", data);
export const setCalendarEvent = (data: ArrayLike<number>): Outbound => command("SET_CALENDAR_EVENT", data);

// --- Notifications -----------------------------------------------------------

export const notificationConfigPacket = (chunk: Bytes, index: number, count: number): Outbound =>
  body("SET_NOTIFICATION_CONFIG", concat([range("count", count, 1, 255), index & 0xff], chunk));
export const notificationPacket = (chunk: Bytes, index: number, count: number): Outbound =>
  body("SEND_NOTIFICATION", concat([range("count", count, 1, 255), index & 0xff], chunk));
export const clearNotification = (): Outbound => command("CLEAR_NOTIFICATION");
export const getWhitelist = (): Outbound => command("GET_WHITELIST");

export interface NotificationFields {
  appId: string;
  appName: string;
  title: string;
  subtitle?: string;
  message?: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
  msgId?: number;
}

/**
 * The JSON body the 0x4B command carries. Field names match what the official
 * app emits; the firmware is picky about them, so they are not normalised.
 */
export function notificationJson(n: NotificationFields): Bytes {
  const now = Date.now();
  return utf8(
    JSON.stringify({
      ncs_notification: {
        msg_id: n.msgId ?? now % 0x100000000,
        type: 0,
        app_identifier: n.appId,
        title: n.title,
        subtitle: n.subtitle ?? "",
        message: n.message ?? "",
        time_s: Math.floor(n.timestamp ?? now / 1000),
        date: "",
        display_name: n.appName,
      },
    }),
  );
}

export interface NotificationConfig {
  apps?: { id: string; name: string }[];
  calendar?: boolean;
  call?: boolean;
  messages?: boolean;
  iosMail?: boolean;
  enable?: boolean;
}

/** Allow-list document for the 0x04 command. */
export function notificationConfigJson(c: NotificationConfig = {}): Bytes {
  return utf8(
    JSON.stringify({
      calendar_enable: c.calendar ?? true,
      call_enable: c.call ?? true,
      msg_enable: c.messages ?? true,
      ios_mail_enable: c.iosMail ?? true,
      app: { list: (c.apps ?? []).map((a) => ({ id: a.id, name: a.name })), enable: c.enable ?? true },
    }),
  );
}

// --- Features ----------------------------------------------------------------

export const setTeleprompter = (data: ArrayLike<number>): Outbound => command("SET_TELEPROMPTER", data);
/** Raw turn-by-turn payload. The field layout of 0x0A is not established. */
export const setNavigation = (data: ArrayLike<number>): Outbound => command("SET_NAVIGATION", data);
