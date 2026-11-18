/**
 * The hub: the SDK as a JSON API.
 *
 * One process holds the connection to the glasses (or to a simulator) and
 * exposes every operation by name, so anything that can speak HTTP or
 * WebSocket can use it — Swift, Kotlin, Python, a Shortcut, curl:
 *
 *     curl -X POST localhost:8765/v1/display/text -d '{"text":"ciao"}'
 *
 * The method table below is the whole API. REST maps `POST /v1/display/text`
 * to `display.text`; the WebSocket at `/v1/events` takes
 * `{"id":1,"method":"display.text","params":{...}}` and streams events.
 */
import { Bitmap, type SafeArea } from "../bitmap.ts";
import { fromBase64, fromHex, toBase64, toHex, type Bytes } from "../bytes.ts";
import * as cmd from "../commands.ts";
import { applyDrawOps, type DrawOp } from "../draw-ops.ts";
import { OpenG1Error, ProtocolError } from "../errors.ts";
import type { ArmName, G1Event } from "../events.ts";
import type { G1 } from "../g1.ts";
import type { NavigationStep } from "../api/navigation.ts";
import { decodePng } from "./png.ts";

export type HubParams = Record<string, unknown>;
export type HubMethod = (params: HubParams) => Promise<unknown>;

/** A request the hub cannot honour as asked: maps to HTTP 400. */
export class HubRequestError extends OpenG1Error {}

function need<T extends "string" | "number" | "boolean">(params: HubParams, key: string, type: T): T extends "string" ? string : T extends "number" ? number : boolean {
  const value = params[key];
  if (typeof value !== type) throw new HubRequestError(`"${key}" is required and must be a ${type}`);
  return value as never;
}

function opt<T>(params: HubParams, key: string, type: "string" | "number" | "boolean"): T | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type) throw new HubRequestError(`"${key}" must be a ${type}`);
  return value as T;
}

function armOf(params: HubParams): ArmName {
  const arm = params.arm;
  if (arm !== "left" && arm !== "right") throw new HubRequestError(`"arm" must be "left" or "right"`);
  return arm;
}

/** Decode an image parameter: `png` or `bmp` as base64, or raw bytes from a binary request body. */
function imageOf(params: HubParams, safeArea: SafeArea): Bitmap {
  const fit = {
    safeArea,
    fit: opt<"contain" | "cover" | "stretch">(params, "fit", "string"),
    dither: opt<boolean>(params, "dither", "boolean"),
    threshold: opt<number>(params, "threshold", "number"),
    invert: opt<boolean>(params, "invert", "boolean"),
  };
  let bytes: Bytes | undefined;
  let kind: "png" | "bmp" | undefined;
  if (params.body instanceof Uint8Array) {
    bytes = params.body;
    kind = bytes[0] === 0x42 && bytes[1] === 0x4d ? "bmp" : "png";
  } else if (typeof params.png === "string") {
    bytes = fromBase64(params.png);
    kind = "png";
  } else if (typeof params.bmp === "string") {
    bytes = fromBase64(params.bmp);
    kind = "bmp";
  }
  if (!bytes || !kind) throw new HubRequestError(`send the image as "png" or "bmp" (base64), or as the raw request body`);
  if (kind === "bmp") return Bitmap.fromBmp(bytes);
  const image = decodePng(bytes);
  return Bitmap.fromRGBA(image.data, image.width, image.height, fit);
}

/** Events as JSON: byte fields become hex strings. */
export function serializeEvent(event: G1Event): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) out[key] = value instanceof Uint8Array ? toHex(value) : value;
  return out;
}

/** Every operation the hub exposes, by name. */
export function createMethods(g1: G1): Record<string, HubMethod> {
  const fast = (p: HubParams) => ({
    crcDelayMs: opt<number>(p, "crcDelayMs", "number"),
    paceMs: opt<number>(p, "paceMs", "number"),
    autoCenter: opt<boolean>(p, "autoCenter", "boolean"),
  });
  return {
    status: async () => ({
      connected: g1.connected,
      arms: { left: g1.session.transports.left.name, right: g1.session.transports.right.name },
      profile: g1.profile,
      safeArea: g1.display.safeArea,
      display: { width: g1.display.width, height: g1.display.height },
    }),

    "display.text": async (p) => {
      await g1.display.text(need(p, "text", "string"), { pageDelayMs: opt(p, "pageDelayMs", "number") });
      return {};
    },
    "display.page": async (p) => {
      await g1.display.textPage(need(p, "text", "string"), { page: opt(p, "page", "number"), maxPage: opt(p, "maxPage", "number") });
      return {};
    },
    "display.clear": async () => {
      await g1.display.clear();
      return {};
    },
    "display.draw": async (p) => g1.display.draw((c) => applyDrawOps(c, p.ops as DrawOp[]), fast(p)),
    "display.image": async (p) => g1.display.bitmap(imageOf(p, g1.display.safeArea), fast(p)),
    "display.brightness": async (p) => {
      await g1.display.brightness(need(p, "level", "number"), opt(p, "auto", "boolean") ?? false);
      return {};
    },
    "display.getBrightness": () => g1.display.getBrightness(),
    "display.safeArea": async (p) => {
      g1.display.setSafeArea(need(p, "top", "number"), opt(p, "bottom", "number") ?? 0);
      return { safeArea: g1.display.safeArea };
    },

    "info.battery": () => g1.info.battery(),
    "info.firmware": () => g1.info.firmware(),
    "info.uptime": async () => ({ seconds: await g1.info.uptime() }),
    "info.serial": async () => g1.info.serial(),

    "settings.silentMode": async (p) => {
      await g1.settings.silentMode(need(p, "enabled", "boolean"));
      return {};
    },
    "settings.headupAngle": async (p) => {
      await g1.settings.headupAngle(need(p, "degrees", "number"));
      return {};
    },
    "settings.wearDetection": async (p) => {
      await g1.settings.wearDetection(need(p, "enabled", "boolean"));
      return {};
    },
    "settings.get": async () => ({
      silentMode: await g1.settings.getSilentMode(),
      headupAngle: await g1.settings.getHeadupAngle(),
      wearDetection: await g1.settings.getWearDetection(),
    }),

    "dashboard.setTime": async (p) => {
      await g1.dashboard.setTime({ epochMs: opt(p, "epochMs", "number"), twelveHour: opt(p, "twelveHour", "boolean") });
      return {};
    },
    "dashboard.setWeather": async (p) => {
      await g1.dashboard.setWeather({
        icon: opt(p, "icon", "number"),
        temperatureC: opt(p, "temperatureC", "number"),
        fahrenheit: opt(p, "fahrenheit", "boolean"),
        twelveHour: opt(p, "twelveHour", "boolean"),
      });
      return {};
    },

    "notifications.notify": async (p) => {
      await g1.notifications.notify({
        title: need(p, "title", "string"),
        message: opt(p, "message", "string"),
        subtitle: opt(p, "subtitle", "string"),
        appId: opt(p, "appId", "string"),
        appName: opt(p, "appName", "string"),
      });
      return {};
    },
    "notifications.clear": async () => {
      await g1.notifications.clear();
      return {};
    },

    "navigation.update": async (p) => {
      need(p, "maneuver", "string");
      return g1.navigation.update(p as unknown as NavigationStep, fast(p));
    },
    "navigation.stop": async () => {
      await g1.navigation.stop();
      return {};
    },

    "audio.start": async () => {
      await g1.audio.start();
      return {};
    },
    "audio.stop": async () => {
      const buffer = await g1.audio.stop();
      return { packets: buffer.packetCount, seconds: buffer.durationS, missing: buffer.missing().length, lc3: toBase64(buffer.toLc3File()) };
    },

    /** Any command from the spec by name, with a hex payload. The escape hatch. */
    "raw.send": async (p) => {
      const out = cmd.command(need(p, "command", "string"), fromHex(opt<string>(p, "hex", "string") ?? ""));
      const target = opt<cmd.Target>(p, "target", "string");
      const response = await g1.session.send(target ? cmd.to(out, target) : out, { strict: false });
      return {
        ok: response.ok,
        left: response.left?.packet ? toHex(response.left.packet.raw) : null,
        right: response.right?.packet ? toHex(response.right.packet.raw) : null,
      };
    },
    /** Arbitrary bytes to one arm. Nothing waits for a reply; watch the event stream. */
    "raw.write": async (p) => {
      await g1.session.sendRaw(armOf(p), fromHex(need(p, "hex", "string")));
      return {};
    },
  };
}

export class Hub {
  readonly g1: G1;
  readonly methods: Record<string, HubMethod>;

  constructor(g1: G1) {
    this.g1 = g1;
    this.methods = createMethods(g1);
  }

  /** Run one method. Throws {@link HubRequestError} for requests that are wrong as asked. */
  async call(method: string, params: HubParams = {}): Promise<unknown> {
    const fn = this.methods[method];
    if (!fn) {
      throw new HubRequestError(`no such method "${method}". Available: ${Object.keys(this.methods).join(", ")}`);
    }
    try {
      return (await fn(params)) ?? {};
    } catch (error) {
      // Bad arguments surface from the SDK as ProtocolError / RangeError; say so rather than "internal error".
      if (error instanceof ProtocolError || error instanceof RangeError) throw new HubRequestError(error.message, { cause: error });
      throw error;
    }
  }

  /** Subscribe to every event as a JSON-ready object. Returns an unsubscribe function. */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    return this.g1.on("*", (event) => listener(serializeEvent(event)));
  }
}
