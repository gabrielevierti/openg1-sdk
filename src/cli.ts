#!/usr/bin/env node
/**
 * The `openg1` command.
 *
 *   openg1 sim                 start the simulator (web page + endpoints)
 *   openg1 sim app.ts          …and run your app in it, reloading on save
 *   openg1 hub                 simulator + JSON API; `--ble` for real glasses
 *   openg1 text "ciao"         one-shot commands against a simulator or glasses
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  App,
  Bitmap,
  COMMANDS,
  G1,
  OpenG1Error,
  commands,
  describeEvent,
  describePacket,
  describeProfile,
  fromHex,
  makeProfile,
  parseProfileToml,
  runApp,
  sleep,
  toHex,
  type DeviceProfile,
  type TransportPair,
} from "./index.ts";
import { VERSION } from "./version.ts";
import { decodePng, startServer } from "./server/index.ts";
import type { Simulator } from "./sim/simulator.ts";
import { connectSimulator, DEFAULT_SIMULATOR_URL } from "./transports/ws.ts";

const HELP = `openg1 ${VERSION} — open SDK and simulator for Even Realities G1 glasses

Simulator
  openg1 sim [app.ts]         start the simulator; with a file, run that app and reload it on save
  openg1 hub                  simulator plus the JSON API under /v1 (add --ble to drive real glasses)

One-shot commands (against the simulator by default)
  openg1 text <message>       show text
  openg1 image <file>         show a .png or 1-bit .bmp, fitted to the panel
  openg1 clear                clear the screen
  openg1 info                 battery, firmware, uptime
  openg1 monitor              print every event and packet until ctrl-c
  openg1 send <CMD> [hex]     send any command from the spec by name, e.g. send SET_BRIGHTNESS 1e00
  openg1 demo                 a short tour of what the display can do
  openg1 screenshot [file]    save the simulator's panel as a PNG
  openg1 scan                 list G1 arms in Bluetooth range (needs noble)
  openg1 spec                 list the commands in the protocol spec

Options
  --target <url>     simulator to talk to (default ${DEFAULT_SIMULATOR_URL}, or $OPENG1_SIMULATOR)
  --ble              talk to real glasses over Bluetooth (npm install @stoprocent/noble)
  --host <addr>      interface for sim/hub to listen on (default 127.0.0.1; 0.0.0.0 to reach it from a phone)
  --port <n>         HTTP/WebSocket port for sim/hub (default 8765)
  --tcp-port <n|off> port for the Python SDK's transport (default 8766)
  --token <t>        require this token on the API
  --cors             let web pages on other origins call the API
  --open             open the simulator page in a browser
  --profile <file>   device profile TOML (default ./openg1.toml, then ~/.config/openg1/profile.toml)
  --top <n> --bottom <n>   rows of the panel you cannot see, overriding the profile
  --no-heartbeat-check     do not drop idle links after 32 s as the firmware does
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["target", "host", "port", "tcp-port", "token", "profile", "top", "bottom", "scale"]);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new OpenG1Error(`--${name} needs a value`);
      flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

function loadProfile(flags: Args["flags"]): DeviceProfile {
  const candidates = [
    typeof flags.profile === "string" ? flags.profile : null,
    process.env.OPENG1_PROFILE ?? null,
    join(process.cwd(), "openg1.toml"),
    join(homedir(), ".config", "openg1", "profile.toml"),
  ].filter((p): p is string => !!p);
  let profile = makeProfile();
  for (const path of candidates) {
    if (existsSync(path)) {
      profile = parseProfileToml(readFileSync(path, "utf8"));
      break;
    }
    if (path === flags.profile) throw new OpenG1Error(`no profile at ${path}`);
  }
  const top = flags.top === undefined ? profile.hiddenTop : Number(flags.top);
  const bottom = flags.bottom === undefined ? profile.hiddenBottom : Number(flags.bottom);
  return makeProfile({ ...profile, hiddenTop: top, hiddenBottom: bottom });
}

function simulatorUrl(flags: Args["flags"]): string {
  if (typeof flags.target === "string") return flags.target;
  const env = (process.env.OPENG1_SIMULATOR ?? "").trim();
  if (!env || /^(1|on|true|yes)$/i.test(env)) return DEFAULT_SIMULATOR_URL;
  // The Python SDK reads the same variable as host:port of its TCP endpoint; accept a URL here.
  return /^(ws|http)s?:\/\//.test(env) ? env : DEFAULT_SIMULATOR_URL;
}

async function blePair(): Promise<TransportPair> {
  let noble: unknown;
  for (const name of ["@stoprocent/noble", "@abandonware/noble"]) {
    try {
      const mod = await import(name);
      noble = mod.default ?? mod;
      break;
    } catch {
      /* try the next one */
    }
  }
  if (!noble) {
    throw new OpenG1Error("--ble needs a Bluetooth library for Node. Install one with: npm install @stoprocent/noble");
  }
  const { connectPair } = await import("./transports/noble.ts");
  console.error("scanning for a pair of G1 arms…");
  return connectPair(noble as never);
}

async function connect(args: Args, profile: DeviceProfile): Promise<G1> {
  // Node 22 has a global WebSocket; on Node 20 borrow the one the server already depends on.
  const WebSocketCtor = globalThis.WebSocket ?? ((await import("ws")).WebSocket as unknown as typeof WebSocket);
  const pair = args.flags.ble
    ? await blePair()
    : connectSimulator(simulatorUrl(args.flags), { token: args.flags.token as string, WebSocket: WebSocketCtor });
  return G1.connect(pair, { profile });
}

function openBrowser(url: string): void {
  const [cmd, cmdArgs] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, cmdArgs as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* best effort */
  }
}

/** Run a user's app file inside the simulator, restarting it whenever the file changes. */
async function devLoop(file: string, sim: Simulator, profile: DeviceProfile): Promise<void> {
  const path = resolve(file);
  if (!existsSync(path)) throw new OpenG1Error(`no such file: ${file}`);
  let controller: AbortController | null = null;
  let running: Promise<void> = Promise.resolve();
  let generation = 0;

  const start = async () => {
    controller?.abort();
    await running;
    sim.reset();
    const mine = (controller = new AbortController());
    running = (async () => {
      let g1: G1 | null = null;
      try {
        const mod = await import(`${pathToFileURL(path).href}?v=${++generation}`);
        const entry = mod.default ?? mod.app ?? mod.main;
        g1 = await G1.connect(sim.pair(), { profile });
        if (entry instanceof App) await runApp(entry, g1, { signal: mine.signal });
        else if (typeof entry === "function" && entry.prototype instanceof App) await runApp(new entry(), g1, { signal: mine.signal });
        else if (typeof entry === "function") {
          await entry(g1, { sim, signal: mine.signal });
          // A script that returns leaves its last screen up until the next reload.
          await new Promise<void>((r) => (mine.signal.aborted ? r() : mine.signal.addEventListener("abort", () => r())));
        } else {
          throw new OpenG1Error(
            `${file} must default-export an App (class or instance) or an async function (g1, { sim, signal }) => …`,
          );
        }
      } catch (error) {
        if (!mine.signal.aborted) console.error(`\n[${file}] ${(error as Error).stack ?? error}\n`);
      } finally {
        await g1?.disconnect().catch(() => {});
      }
    })();
    console.log(`▶ ${file} loaded`);
  };

  await start();
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(path, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`↻ ${file} changed`);
      void start();
    }, 80);
  });
}

async function serve(args: Args, withHub: boolean): Promise<void> {
  const profile = loadProfile(args.flags);
  const appFile = args.positional[0];
  const ble = Boolean(args.flags.ble);
  if (ble && appFile) throw new OpenG1Error("an app file runs in the simulator; drop --ble, or run your app directly against the glasses");
  const tcp = args.flags["tcp-port"];
  const g1 = ble ? await G1.connect(await blePair(), { profile }) : null;
  const server = await startServer({
    host: args.flags.host as string | undefined,
    port: args.flags.port === undefined ? undefined : Number(args.flags.port),
    tcpPort: tcp === undefined ? undefined : tcp === "off" ? false : Number(tcp),
    token: args.flags.token as string | undefined,
    cors: Boolean(args.flags.cors),
    simulator: ble ? false : { profile, enforceHeartbeat: !args.flags["no-heartbeat-check"] },
    hub: g1 ?? (withHub && !appFile ? "simulator" : false),
  });
  const ws = server.url.replace("http", "ws");
  console.log(`openg1 ${VERSION}`);
  console.log(`  ${describeProfile(profile)}`);
  if (server.sim) {
    console.log(`  simulator   ${server.url}`);
    if (appFile) console.log(`  app         ${appFile} (reloads on save)`);
    else if (!server.hub) {
      console.log(`  apps        G1.connect(connectSimulator("${ws}"))`);
      if (server.tcpPort) console.log(`  python      OPENG1_SIMULATOR=127.0.0.1:${server.tcpPort} python3 yourapp.py`);
    }
  } else {
    console.log(`  glasses     ${g1!.session.transports.left.name} + ${g1!.session.transports.right.name}`);
  }
  if (server.hub) console.log(`  hub         curl -X POST ${server.url}/v1/display/text -d '{"text":"ciao"}'`);
  if (server.host === "0.0.0.0") console.log("  listening on every interface: reachable from other devices on this network");
  console.log("  ctrl-c to stop\n");
  if (args.flags.open && server.sim) openBrowser(server.url);
  if (appFile && server.sim) await devLoop(appFile, server.sim, profile);
  process.on("SIGINT", () => {
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

async function demo(g1: G1): Promise<void> {
  await g1.display.text("openg1\nText goes through the firmware's own renderer:\nfive lines a screen, wrapped and paged by the SDK.");
  await sleep(2500);
  await g1.display.draw((c) => {
    const { y, height } = c.safe;
    const now = new Date();
    c.text(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, 16, y + 4, { font: "xl" });
    c.text("Everything else is a bitmap", 250, y + 8, { font: "md" });
    c.text("you draw with a canvas.", 250, y + 34, { font: "md" });
    c.progress(250, y + Math.min(76, height - 24), 300, 16, 0.62);
    c.battery(530, y + Math.min(98, height - 16), 87);
  });
  await sleep(2500);
  await g1.navigation.update({
    maneuver: "turn_right",
    distanceM: 350,
    road: "Corso Buenos Aires",
    remainingM: 142000,
    etaS: 5400,
    speedKmh: 128,
    speedLimitKmh: 130,
  });
  await sleep(2500);
  await g1.display.text("Tap, look up, take them off:\nevery gesture is an event.\n\nopeng1 monitor shows them live.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.command === "help") return void console.log(HELP);
  if (args.flags.version || args.command === "version") return void console.log(VERSION);

  switch (args.command) {
    case "sim":
      return serve(args, Boolean(args.flags.hub));
    case "hub":
      return serve(args, true);
    case "spec": {
      for (const c of Object.values(COMMANDS)) {
        console.log(
          `0x${c.opcode.toString(16).padStart(2, "0")}  ${c.name.padEnd(26)} ${c.framed ? "framed" : "raw   "}  ${c.target.padEnd(5)}  ${c.confidence}`,
        );
      }
      return;
    }
    case "scan": {
      const mod = await import("@stoprocent/noble" as string).catch(() => import("@abandonware/noble" as string)).catch(() => null);
      if (!mod) throw new OpenG1Error("scan needs a Bluetooth library for Node. Install one with: npm install @stoprocent/noble");
      const { scan } = await import("./transports/noble.ts");
      const arms = await scan((mod.default ?? mod) as never);
      if (!arms.length) console.log("no G1 arms in range (they must be out of the case and not connected to the phone)");
      for (const a of arms) console.log(`${a.name}  channel ${a.channel}  ${a.arm}  rssi ${a.rssi ?? "?"}`);
      process.exit(0);
    }
    case "screenshot": {
      const url = simulatorUrl(args.flags).replace(/^ws/, "http");
      const token = args.flags.token ? `&token=${args.flags.token}` : "";
      const res = await fetch(`${url}/api/frame.png?scale=${args.flags.scale ?? 2}${token}`).catch(() => null);
      if (!res?.ok) throw new OpenG1Error(`no simulator answered at ${url} — start one with \`openg1 sim\``);
      const file = args.positional[0] ?? "g1.png";
      writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      return void console.log(`wrote ${file}`);
    }
  }

  const known = ["text", "image", "clear", "info", "monitor", "send", "demo"];
  if (!known.includes(args.command)) {
    throw new OpenG1Error(`unknown command "${args.command}". Run \`openg1 help\` for the list.`);
  }
  const profile = loadProfile(args.flags);
  const g1 = await connect(args, profile);
  try {
    switch (args.command) {
      case "text": {
        const message = args.positional.join(" ");
        if (!message) throw new OpenG1Error('usage: openg1 text "your message"');
        await g1.display.text(message.replace(/\\n/g, "\n"));
        break;
      }
      case "clear":
        await g1.display.clear();
        break;
      case "image": {
        const file = args.positional[0];
        if (!file || !existsSync(file)) throw new OpenG1Error(`usage: openg1 image <file.png|file.bmp>${file ? ` — no such file: ${file}` : ""}`);
        const bytes = new Uint8Array(readFileSync(file));
        if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
          const bmp = Bitmap.fromBmp(bytes);
          const fitted = bmp.width === 576 && bmp.height === 136 ? bmp : Bitmap.fromRGBA(bmp.toRGBA([255, 255, 255]), bmp.width, bmp.height, { safeArea: g1.display.safeArea, dither: false });
          console.log(await g1.display.bitmap(fitted));
        } else {
          console.log(await g1.display.image(decodePng(bytes), { dither: !args.flags["no-dither"], invert: Boolean(args.flags.invert) }));
        }
        break;
      }
      case "info": {
        const battery = await g1.info.battery();
        const firmware = await g1.info.firmware();
        console.log(`arms       ${g1.session.transports.left.name}, ${g1.session.transports.right.name}`);
        console.log(`battery    left ${battery.left}%  right ${battery.right}%`);
        console.log(`firmware   ${firmware.version} (built ${firmware.build})`);
        console.log(`uptime     ${await g1.info.uptime()} s`);
        console.log(`brightness ${JSON.stringify(await g1.display.getBrightness())}`);
        console.log(`profile    ${describeProfile(profile)}`);
        break;
      }
      case "send": {
        const [name, hex] = args.positional;
        if (!name || !COMMANDS[name]) throw new OpenG1Error(`usage: openg1 send <COMMAND> [hex]. Run \`openg1 spec\` for the names.`);
        const response = await g1.session.send(commands.command(name, fromHex(hex ?? "")), { strict: false });
        for (const reply of Object.values(response.replies)) {
          console.log(`${reply.arm.padEnd(5)} ${reply.packet ? toHex(reply.packet.raw, " ") : "(no reply)"}`);
        }
        break;
      }
      case "demo":
        await demo(g1);
        break;
      case "monitor": {
        console.log("monitoring — ctrl-c to stop");
        if (args.flags.packets) {
          g1.session.onPacket((arm, direction, data) => {
            const d = describePacket(direction, data, arm);
            if (!d.bulk) console.log(`${direction} ${arm.padEnd(5)} ${toHex(data.subarray(0, 24), " ").padEnd(72)} ${d.text}`);
          });
        }
        g1.on("*", (event) => {
          if (event.type !== "audio") console.log(describeEvent(event));
        });
        await new Promise<void>((r) => process.on("SIGINT", () => r()));
        break;
      }
    }
  } finally {
    await g1.disconnect();
  }
}

main().catch((error) => {
  if (error instanceof OpenG1Error) console.error(`openg1: ${error.message}`);
  else console.error(error);
  process.exit(1);
});
