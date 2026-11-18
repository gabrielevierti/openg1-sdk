/**
 * The simulator's web page.
 *
 * One page, three places the glasses can be:
 *
 *   simulator  an emulated pair running in this tab — nothing to install
 *   server     the emulated pair inside `openg1 sim`, mirrored here, so apps
 *              on this or another machine can connect to it
 *   glasses    a real pair over Web Bluetooth, with a preview of what they
 *              were told to show
 *
 * The playground runs the same SDK against whichever is selected.
 */
import * as openg1 from "../browser.ts";
import {
  describeEvent,
  describePacket,
  fromBase64,
  G1,
  makeProfile,
  sleep,
  toHex,
  type ArmName,
  type DeviceProfile,
} from "../index.ts";
import { applyInput, shadow, Simulator, type SimInput, type SimulatorSnapshot } from "../sim/index.ts";
import { connectSimulator } from "../transports/ws.ts";
import { WebBluetoothPairing, webBluetoothAvailable } from "../transports/web-bluetooth.ts";
import { PRESETS } from "./presets.ts";

type Mode = "simulator" | "server" | "glasses";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const served = Boolean((window as { OPENG1_SERVER?: boolean }).OPENG1_SERVER);
const token = new URLSearchParams(location.search).get("token") ?? undefined;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`openg1.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`openg1.${key}`, value);
    } catch {
      /* storage is a convenience here, never required */
    }
  },
};

// -- state ---------------------------------------------------------------------------

let mode: Mode = served ? "server" : "simulator";
let profile: DeviceProfile = makeProfile({
  hiddenTop: Number(store.get("top") ?? 0) || 0,
  hiddenBottom: Number(store.get("bottom") ?? 0) || 0,
});
/** The emulated pair (simulator mode) or the preview of a real one (glasses mode). */
let sim: Simulator | null = null;
let g1: G1 | null = null;
let control: WebSocket | null = null;
let pairing: WebBluetoothPairing | null = null;
let bits: Uint8Array = new Uint8Array(72 * 136);
let snapshot: SimulatorSnapshot | null = null;
let program: AbortController | null = null;
let teardown: (() => void)[] = [];

// -- log -------------------------------------------------------------------------------

const logList = $<HTMLOListElement>("log");
let bulk = 0;

function log(kind: "tx" | "rx" | "event" | "note" | "error" | "out", text: string, detail = ""): void {
  const item = document.createElement("li");
  item.className = `log-${kind}`;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = { tx: "app →", rx: "← g1", event: "event", note: "note", error: "error", out: "log" }[kind];
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  item.append(tag, body);
  if (detail) {
    const hex = document.createElement("span");
    hex.className = "hex";
    hex.textContent = detail;
    item.append(hex);
  }
  logList.append(item);
  while (logList.children.length > 250) logList.firstElementChild!.remove();
  logList.scrollTop = logList.scrollHeight;
}

/** The first bytes of a packet, without the zero padding the firmware adds. */
function hexPreview(data: Uint8Array): string {
  let end = data.length;
  while (end > 1 && data[end - 1] === 0) end--;
  return toHex(data.subarray(0, Math.min(end, 20)), " ") + (end > 20 ? " …" : "");
}

function logPacket(arm: ArmName, direction: "tx" | "rx", data: Uint8Array): void {
  const d = describePacket(direction, data, arm);
  if (d.bulk) {
    bulk++;
    return;
  }
  if (bulk) {
    log("tx", `… ${bulk} bitmap or audio packets`);
    bulk = 0;
  }
  log(direction, `${arm === "left" ? "L" : "R"} ${d.text}`, direction === "tx" ? hexPreview(data) : "");
}

// -- drawing ---------------------------------------------------------------------------

const panel = $<HTMLCanvasElement>("panel");
const ctx = panel.getContext("2d")!;
const image = ctx.createImageData(576, 136);

function render(): void {
  const s = snapshot;
  const level = s ? 0.55 + (Math.min(42, s.brightness) / 42) * 0.45 : 1;
  for (let y = 0; y < 136; y++) {
    for (let x = 0; x < 576; x++) {
      const lit = (bits[y * 72 + (x >> 3)]! >> (7 - (x & 7))) & 1;
      const i = (y * 576 + x) * 4;
      image.data[i] = 110;
      image.data[i + 1] = 255;
      image.data[i + 2] = 160;
      image.data[i + 3] = lit ? Math.round(255 * level) : 0;
    }
  }
  ctx.putImageData(image, 0, 0);

  const lens = $("lens");
  lens.style.setProperty("--hidden-top", `${(profile.hiddenTop / 136) * 100}%`);
  lens.style.setProperty("--hidden-bottom", `${(profile.hiddenBottom / 136) * 100}%`);
  const note = $("lens-note");
  if (!s) note.textContent = mode === "server" ? "Connecting to the simulator…" : "";
  else if (!s.worn) note.textContent = "Glasses off: the display is dark";
  else if (!s.displayOn) note.textContent = "Display powered down";
  else if (s.content.kind === "none") {
    note.textContent = mode === "glasses" && !g1 ? "Choose both arms to connect" : "Nothing on screen. Run something below.";
  } else note.textContent = "";

  const pill = (id: string, text: string, state: "" | "on" | "warn" = ""): void => {
    const el = $(id);
    el.textContent = text;
    el.dataset.state = state;
  };
  if (s) {
    pill("pill-left", `L ${s.attached.left ? "linked" : "free"} · ${s.battery.left}%`, s.attached.left ? "on" : "");
    pill("pill-right", `R ${s.attached.right ? "linked" : "free"} · ${s.battery.right}%`, s.attached.right ? "on" : "");
    pill("pill-brightness", `Brightness ${s.autoBrightness ? "auto" : `${s.brightness}/42`}`);
    pill("pill-sync", s.armsInSync ? "Lenses match" : "Lenses differ", s.armsInSync ? "" : "warn");
    pill("pill-mic", s.mic ? "Mic on" : "Mic off", s.mic ? "on" : "");
    pill("pill-silent", s.silent ? "Silent" : "Sound on");
  }

  const warnings = $<HTMLUListElement>("warnings");
  warnings.replaceChildren(
    ...(s?.warnings ?? []).slice(-4).map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
  warnings.hidden = !s?.warnings.length;

  $("look").setAttribute("aria-pressed", String(Boolean(s?.headUp)));
  $("wear").setAttribute("aria-pressed", String(s?.worn ?? true));
  $("charge").setAttribute("aria-pressed", String(Boolean(s?.charging)));
  $("wear").textContent = s?.worn === false ? "Glasses off" : "Wearing";
  const battery = $<HTMLInputElement>("battery");
  if (s && document.activeElement !== battery) battery.value = String(s.battery.left);
  $("battery-out").textContent = `${battery.value}%`;
}

function fromSimulator(): void {
  if (!sim) return;
  bits = sim.frame.bits;
  snapshot = sim.snapshot();
  if (mode === "glasses" && snapshot) {
    // A preview has no link of its own: report the real one.
    const linked = Boolean(g1?.connected);
    snapshot.attached = { left: linked, right: linked };
  }
  render();
}

// -- input -------------------------------------------------------------------------------

function input(action: SimInput): void {
  if (mode === "glasses") return;
  if (mode === "server") {
    if (control?.readyState === 1) control.send(JSON.stringify(action));
    return;
  }
  if (sim) applyInput(sim, action);
}

/** A touch bar: taps are counted, and a long press is a hold — as on the temple of the glasses. */
function bindTouchBar(id: string, arm: ArmName): void {
  const bar = $(id);
  let taps = 0;
  let tapTimer: number | undefined;
  let holdTimer: number | undefined;
  let holding = false;
  const flush = () => {
    if (taps) input({ action: "tap", arm, count: Math.min(3, taps) as 1 | 2 | 3 });
    taps = 0;
  };
  bar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    bar.classList.add("pressed");
    holdTimer = window.setTimeout(() => {
      holding = true;
      window.clearTimeout(tapTimer);
      taps = 0;
      bar.classList.add("holding");
      input({ action: "hold-start", arm });
    }, 500);
  });
  const release = () => {
    window.clearTimeout(holdTimer);
    if (!bar.classList.contains("pressed")) return;
    bar.classList.remove("pressed", "holding");
    if (holding) {
      holding = false;
      input({ action: "hold-end", arm });
      return;
    }
    taps++;
    window.clearTimeout(tapTimer);
    tapTimer = window.setTimeout(flush, 320);
  };
  bar.addEventListener("pointerup", release);
  bar.addEventListener("pointerleave", release);
  bar.addEventListener("pointercancel", release);
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input({ action: "tap", arm, count: 1 });
    }
  });
}

// -- modes -------------------------------------------------------------------------------

async function stopProgram(): Promise<void> {
  program?.abort();
  program = null;
  $("run").hidden = false;
  $("stop").hidden = true;
}

async function leave(): Promise<void> {
  await stopProgram();
  for (const off of teardown.splice(0)) off();
  await g1?.disconnect().catch(() => {});
  g1 = null;
  control?.close();
  control = null;
  sim?.close();
  sim = null;
  pairing = null;
  snapshot = null;
  bits = new Uint8Array(72 * 136);
}

function watch(simulator: Simulator): void {
  teardown.push(simulator.onFrame(fromSimulator), simulator.onPacket(logPacket));
}

async function enter(next: Mode): Promise<void> {
  await leave();
  mode = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.setAttribute("aria-selected", String(button.dataset.mode === mode));
  }
  $("wearer").classList.toggle("disabled", mode === "glasses");
  $("bluetooth").hidden = mode !== "glasses";
  $("wearer-hint").textContent =
    mode === "glasses"
      ? "Use the real touch bars: every gesture shows up in the traffic log."
      : "Tap, double-tap or triple-tap a touch bar. Press and hold for a long press.";

  if (mode === "simulator") {
    sim = new Simulator({ profile });
    watch(sim);
    fromSimulator();
    log("note", "Simulator ready: an emulated pair is running in this tab.");
  } else if (mode === "server") {
    render();
    const url = `${location.origin.replace(/^http/, "ws")}/control${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const socket = new WebSocket(url);
    control = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "frame") {
        bits = fromBase64(message.bits);
        snapshot = message.state;
        profile = message.state.profile;
        syncSafeAreaInputs();
        render();
      } else if (message.type === "packet") {
        log(message.direction, `${message.arm === "left" ? "L" : "R"} ${message.text}`, message.direction === "tx" ? message.hex : "");
      } else if (message.type === "hello") {
        log("note", `Mirroring the simulator at ${location.host}. Apps connect to ws://${location.host}.`);
      } else if (message.type === "error") {
        log("error", message.message);
      }
    };
    socket.onclose = () => {
      if (control !== socket) return;
      snapshot = null;
      render();
      $("lens-note").textContent = "The simulator stopped. Start it again and reload.";
    };
  } else {
    sim = new Simulator({ profile, micStream: false });
    watch(sim);
    pairing = new WebBluetoothPairing();
    fromSimulator();
    updateBluetooth();
  }
}

// -- real glasses ------------------------------------------------------------------------

function updateBluetooth(message = ""): void {
  const button = $<HTMLButtonElement>("bt-choose");
  const status = $("bt-status");
  if (!webBluetoothAvailable()) {
    button.disabled = true;
    status.textContent =
      "This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer; on iPhone, a Web Bluetooth browser such as Bluefy. The page must be served over https or from localhost.";
    return;
  }
  button.disabled = Boolean(g1);
  if (g1) {
    button.textContent = "Connected";
    status.textContent = message || `${pairing?.left?.name} and ${pairing?.right?.name}. The picture above is a preview of what they were sent.`;
    return;
  }
  const missing = pairing?.missing ?? "left";
  button.textContent = pairing?.left || pairing?.right ? `Choose the ${missing} arm` : "Choose the first arm";
  status.textContent =
    message || "Each arm is its own Bluetooth device, so you choose twice. Close the official Even app first: an arm accepts one connection.";
}

async function chooseArm(): Promise<void> {
  if (!pairing || !sim) return;
  try {
    const arm = await pairing.request();
    log("note", `Chosen: ${arm.name}`);
    if (!pairing.complete) return updateBluetooth();
    updateBluetooth("Connecting…");
    g1 = await G1.connect(shadow(pairing.pair(), sim), { profile });
    teardown.push(
      g1.on("*", (event) => {
        if (event.type !== "audio") log("event", describeEvent(event));
        if (event.type === "disconnect") {
          g1 = null;
          updateBluetooth("The glasses disconnected. Choose the arms again to reconnect.");
          pairing = new WebBluetoothPairing();
        }
        fromSimulator();
      }),
    );
    const battery = await g1.info.battery();
    sim.left.state.battery = battery.left;
    sim.right.state.battery = battery.right;
    updateBluetooth();
    fromSimulator();
  } catch (error) {
    const e = error as Error;
    if (e.name === "NotFoundError") return updateBluetooth("No arm chosen.");
    log("error", e.message);
    updateBluetooth(
      e.name === "SecurityError"
        ? "This page is not allowed to use Bluetooth here (it is embedded in another site). Open it from `openg1 sim` or from its own https address."
        : e.message,
    );
  }
}

// -- playground --------------------------------------------------------------------------

const code = $<HTMLTextAreaElement>("code");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

async function ensureG1(): Promise<G1> {
  if (g1?.connected) return g1;
  if (mode === "glasses") throw new Error("Connect the glasses first: choose both arms above.");
  if (mode === "server") {
    g1 = await G1.connect(connectSimulator(location.origin, { token }), { profile });
  } else {
    g1 = await G1.connect(sim!.pair(), { profile });
  }
  const current = g1;
  teardown.push(
    current.on("*", (event) => {
      if (event.type !== "audio" && event.type !== "battery") log("event", describeEvent(event));
    }),
  );
  return current;
}

async function run(): Promise<void> {
  await stopProgram();
  store.set("code", code.value);
  const controller = (program = new AbortController());
  const { signal } = controller;
  $("run").hidden = true;
  $("stop").hidden = false;
  try {
    const device = await ensureG1();
    // Let the previous program's last transfer land before wiping the screen under it.
    await device.session.idle();
    if (mode === "simulator") sim?.reset();
    const body = new AsyncFunction("g1", "sim", "signal", "sleep", "log", "openg1", code.value);
    const off: (() => void)[] = [];
    // Handlers the program registers must die with it, or the next run inherits them.
    const scoped = new Proxy(device, {
      get(target, key) {
        if (key === "on") {
          return (type: never, handler: never) => {
            const unsubscribe = target.on(type, handler);
            off.push(unsubscribe);
            return unsubscribe;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    signal.addEventListener("abort", () => off.forEach((f) => f()));
    await body(
      scoped,
      mode === "simulator" ? sim : null,
      signal,
      (ms: number) => sleep(ms, signal),
      (...values: unknown[]) => log("out", values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ")),
      openg1,
    );
    // A program that returns keeps its handlers until Stop: most examples end by waiting for taps.
    if (!off.length && program === controller) await stopProgram();
  } catch (error) {
    if (!signal.aborted) {
      log("error", (error as Error).message || String(error));
      if (program === controller) await stopProgram();
    }
  }
}

function loadPreset(name: string): void {
  const preset = PRESETS.find((p) => p.name === name) ?? PRESETS[0]!;
  code.value = preset.code;
  $("preset-about").textContent = preset.about;
}

// -- safe area ---------------------------------------------------------------------------

function syncSafeAreaInputs(): void {
  const top = $<HTMLInputElement>("safe-top");
  const bottom = $<HTMLInputElement>("safe-bottom");
  if (document.activeElement !== top) top.value = String(profile.hiddenTop);
  if (document.activeElement !== bottom) bottom.value = String(profile.hiddenBottom);
  top.disabled = bottom.disabled = mode === "server";
  $("safe-note").textContent =
    mode === "server"
      ? "Set by the server: start it with --top and --bottom, or a profile file."
      : "Rows of the panel you cannot see on your own pair. The simulator shades them and layouts avoid them.";
}

async function changeSafeArea(): Promise<void> {
  const top = Math.max(0, Math.min(100, Number($<HTMLInputElement>("safe-top").value) || 0));
  const bottom = Math.max(0, Math.min(100, Number($<HTMLInputElement>("safe-bottom").value) || 0));
  if (top + bottom >= 136) return;
  profile = makeProfile({ ...profile, hiddenTop: top, hiddenBottom: bottom });
  store.set("top", String(top));
  store.set("bottom", String(bottom));
  if (mode !== "server") await enter(mode);
}

// -- wiring ------------------------------------------------------------------------------

function init(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    if (button.dataset.mode === "server" && !served) {
      button.hidden = true;
      continue;
    }
    button.addEventListener("click", () => void enter(button.dataset.mode as Mode));
  }
  bindTouchBar("tb-left", "left");
  bindTouchBar("tb-right", "right");
  $("look").addEventListener("click", () => input({ action: "look", up: !snapshot?.headUp }));
  $("wear").addEventListener("click", () => input({ action: "wear", worn: snapshot?.worn === false }));
  $("charge").addEventListener("click", () => input({ action: "charge", charging: !snapshot?.charging }));
  $<HTMLInputElement>("battery").addEventListener("input", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    $("battery-out").textContent = `${value}%`;
    input({ action: "battery", value });
  });
  $("bt-choose").addEventListener("click", () => void chooseArm());
  $("safe-top").addEventListener("change", () => void changeSafeArea());
  $("safe-bottom").addEventListener("change", () => void changeSafeArea());
  $("lens").addEventListener("click", () => $("lens").classList.toggle("zoomed"));
  $("clear-log").addEventListener("click", () => logList.replaceChildren());

  const select = $<HTMLSelectElement>("preset");
  for (const preset of PRESETS) select.add(new Option(preset.title, preset.name));
  select.addEventListener("change", () => loadPreset(select.value));
  loadPreset(PRESETS[0]!.name);
  const saved = store.get("code");
  if (saved && saved !== PRESETS[0]!.code) {
    code.value = saved;
    select.add(new Option("Your last program", "saved"), 0);
    select.value = "saved";
    $("preset-about").textContent = "What you ran last time in this browser.";
  }
  $("run").addEventListener("click", () => void run());
  $("stop").addEventListener("click", () => void stopProgram());
  code.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void run();
    if (event.key === "Tab") {
      event.preventDefault();
      code.setRangeText("  ", code.selectionStart, code.selectionEnd, "end");
    }
  });

  syncSafeAreaInputs();
  void enter(mode).then(() => {
    syncSafeAreaInputs();
    // Open in a working state: the first example is already on the glasses.
    if (mode === "simulator") void run();
  });
}

init();
