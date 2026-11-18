/**
 * openg1/server — a simulator (and optionally a hub) other processes can reach.
 *
 * One HTTP port carries everything:
 *
 *   /                  the simulator's web page
 *   /arm/left|right    WebSocket: one binary message = one BLE packet
 *   /control           WebSocket: frames and packet log out, wearer input in
 *   /api/*             the same over plain HTTP, for scripts and CI
 *   /v1/*              the hub's JSON API, when a hub is mounted
 *
 * A second, TCP port speaks the original Python simulator's wire format, so
 * the Python SDK (`OPENG1_SIMULATOR=1`) connects to this simulator unchanged.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { toBase64, toHex, type Bytes } from "../bytes.ts";
import { describePacket } from "../describe.ts";
import { CommandTimeout, NotConnectedError, OpenG1Error, PacketTooLargeError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { G1 } from "../g1.ts";
import { VERSION } from "../version.ts";
import { applyInput, type SimInput } from "../sim/input.ts";
import { Simulator, type SimulatorOptions } from "../sim/simulator.ts";
import {
  LengthPrefixedReader,
  lengthPrefixed,
  TCP_HELLO_SIZE,
  TCP_MAGIC,
  TCP_PROTOCOL_VERSION,
} from "../transports/tcp.ts";
import { Hub, HubRequestError, type HubParams } from "./hub.ts";
import { panelToPng } from "./png.ts";

export * from "./hub.ts";
export * from "./png.ts";

export interface ServerOptions {
  /** Interface to listen on. Default 127.0.0.1; use 0.0.0.0 to reach it from a phone on the same network. */
  host?: string;
  /** HTTP + WebSocket port. Default 8765. 0 picks a free one. */
  port?: number;
  /** Port for the Python SDK's TCP format. Default 8766. `false` disables it. */
  tcpPort?: number | false;
  /** An existing simulator, options for a new one, or `false` for a hub-only server. */
  simulator?: Simulator | SimulatorOptions | false;
  /**
   * Mount the JSON API under /v1. Pass a connected `G1`, or `"simulator"` to
   * drive this server's own simulator.
   */
  hub?: G1 | "simulator" | false;
  /** Require `Authorization: Bearer <token>` (or `?token=`) on everything but the web page. */
  token?: string;
  /** Send `Access-Control-Allow-Origin` so web pages on other origins may call the API. Off by default. */
  cors?: boolean | string;
}

export interface RunningServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly tcpPort: number | null;
  readonly sim: Simulator | null;
  readonly hub: Hub | null;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HubRequestError("request body is larger than 8 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function readParams(req: IncomingMessage, url: URL): Promise<HubParams> {
  const params: HubParams = {};
  for (const [key, value] of url.searchParams) {
    if (key === "token") continue;
    params[key] = value === "true" ? true : value === "false" ? false : value !== "" && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
  if (req.method === "GET" || req.method === "HEAD") return params;
  const body = await readBody(req);
  if (!body.length) return params;
  const type = String(req.headers["content-type"] ?? "");
  if (/^(image|application\/octet-stream)/.test(type)) return { ...params, body };
  const text = new TextDecoder().decode(body);
  if (/^text\/plain/.test(type)) return { ...params, text };
  try {
    const json = JSON.parse(text);
    if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    return { ...params, ...json };
  } catch {
    throw new HubRequestError("the request body must be a JSON object (or an image, with an image/* content type)");
  }
}

function statusFor(error: unknown): number {
  if (error instanceof HubRequestError) return 400;
  if (error instanceof CommandTimeout) return 504;
  if (error instanceof NotConnectedError) return 503;
  if (error instanceof OpenG1Error) return 502;
  return 500;
}

function findWebPage(): string | null {
  // Built page first: next to the sources there is only the unbundled template.
  for (const candidate of ["../../dist/web/index.html", "../web/index.html"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

const FALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>openg1 simulator</title>
<body style="font:16px system-ui;margin:3rem;max-width:40rem">
<h1>openg1 simulator</h1>
<p>The simulator is running, but its web page has not been built. Run <code>npm run build</code> in the openg1 checkout and reload.</p>
<p>Meanwhile the API works: <a href="/api/state">/api/state</a>, <a href="/api/frame.png">/api/frame.png</a>.</p>`;

/** Start a simulator server, a hub, or both. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const sim =
    options.simulator === false
      ? null
      : options.simulator instanceof Simulator
        ? options.simulator
        : new Simulator({ enforceHeartbeat: true, ...options.simulator });

  let hub: Hub | null = null;
  let ownG1: G1 | null = null;
  if (options.hub === "simulator") {
    if (!sim) throw new OpenG1Error(`hub: "simulator" needs a simulator; do not pass simulator: false`);
    ownG1 = await G1.connect(sim.pair(), { profile: sim.profile });
    hub = new Hub(ownG1);
  } else if (options.hub) {
    hub = new Hub(options.hub);
  }

  const webPage = findWebPage();
  const cors = options.cors === true ? "*" : options.cors || null;

  const send = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
    const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type,
      "cache-control": "no-store",
      ...(cors ? { "access-control-allow-origin": cors } : {}),
    });
    res.end(data);
  };
  const fail = (res: ServerResponse, error: unknown): void => {
    const status = statusFor(error);
    if (status === 500) console.error("openg1 server:", error);
    send(res, status, { ok: false, error: { name: (error as Error).name ?? "Error", message: (error as Error).message ?? String(error) } });
  };
  const authorised = (req: IncomingMessage, url: URL): boolean => {
    if (!options.token) return true;
    const header = String(req.headers.authorization ?? "");
    return header === `Bearer ${options.token}` || url.searchParams.get("token") === options.token;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...(cors ? { "access-control-allow-origin": cors } : {}),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }
    if (path === "/" || path === "/index.html") {
      // Tell the page it is being served by a simulator, so it mirrors this one instead of starting its own.
      const page = webPage ? readFileSync(webPage, "utf8").replace("<!--OPENG1_SERVER-->", "<script>window.OPENG1_SERVER = true;</script>") : FALLBACK_PAGE;
      return send(res, 200, page, "text/html");
    }
    if (!authorised(req, url)) {
      return send(res, 401, { ok: false, error: { name: "Unauthorized", message: "missing or wrong token" } });
    }

    // -- simulator ---------------------------------------------------------------
    if (path.startsWith("/api/")) {
      if (!sim) return send(res, 404, { ok: false, error: { name: "NotFound", message: "this server has no simulator" } });
      if (path === "/api/state") return send(res, 200, { version: VERSION, hub: hub !== null, ...sim.snapshot() });
      if (path === "/api/frame.png") {
        const scale = Number(url.searchParams.get("scale") ?? 2);
        const png = panelToPng(sim.frame, { scale, hidden: [sim.profile.hiddenTop, sim.profile.hiddenBottom] });
        return send(res, 200, png, "image/png");
      }
      if (path === "/api/frame.txt") return send(res, 200, `${sim.frame.toBlocks()}\n`, "text/plain");
      if (path === "/api/input" && req.method === "POST") {
        try {
          applyInput(sim, (await readParams(req, url)) as unknown as SimInput);
        } catch (error) {
          throw new HubRequestError((error as Error).message);
        }
        return send(res, 200, { ok: true });
      }
      if (path === "/api/reset" && req.method === "POST") {
        sim.reset();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, error: { name: "NotFound", message: `no such endpoint ${path}` } });
    }

    // -- hub -----------------------------------------------------------------------
    if (path === "/v1" || path.startsWith("/v1/")) {
      if (!hub) {
        return send(res, 404, {
          ok: false,
          error: { name: "NotFound", message: "no hub is mounted on this server; start it with `openg1 hub`" },
        });
      }
      if (path === "/v1") return send(res, 200, { ok: true, result: { version: VERSION, methods: Object.keys(hub.methods) } });
      if (path === "/v1/events") {
        // Server-sent events: one JSON object per event. Works with curl and URLSession alike.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          ...(cors ? { "access-control-allow-origin": cors } : {}),
        });
        res.write(": openg1 events\n\n");
        const off = hub.onEvent((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
        req.on("close", () => {
          off();
          clearInterval(keepAlive);
        });
        return;
      }
      const method = path.slice(4).split("/").join(".");
      const result = await hub.call(method, await readParams(req, url));
      return send(res, 200, { ok: true, result });
    }

    send(res, 404, { ok: false, error: { name: "NotFound", message: `nothing at ${path}` } });
  };

  const http: Server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => fail(res, error));
  });

  // -- WebSockets ----------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const controls = new Set<WsSocket>();
  const broadcast = (message: object): void => {
    const text = JSON.stringify(message);
    for (const socket of controls) if (socket.readyState === 1) socket.send(text);
  };

  const frameMessage = () => ({ type: "frame", bits: toBase64(sim!.frame.bits), state: sim!.snapshot() });
  const offs: (() => void)[] = [];
  if (sim) {
    offs.push(sim.onFrame(() => controls.size && broadcast(frameMessage())));
    let bulk = 0;
    offs.push(
      sim.onPacket((arm, direction, data) => {
        if (!controls.size) return;
        const d = describePacket(direction, data, arm);
        if (d.bulk) {
          bulk++;
          return;
        }
        if (bulk) {
          broadcast({ type: "packet", arm, direction: "tx", name: "bulk", text: `… ${bulk} bitmap/audio packets`, hex: "" });
          bulk = 0;
        }
        broadcast({ type: "packet", arm, direction, name: d.name, text: d.text, hex: toHex(data.subarray(0, 48), " "), t: Date.now() });
      }),
    );
  }

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const refuse = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!authorised(req, url)) return refuse(401, "Unauthorized");
    const armMatch = /^\/arm\/(left|right)$/.exec(url.pathname);

    if (armMatch && sim) {
      const port = sim.ports[armMatch[1] as ArmName];
      if (port.attached) return refuse(409, "Arm already connected");
      wss.handleUpgrade(req, socket, head, (ws) => {
        const mtu = Number(url.searchParams.get("mtu"));
        if (Number.isInteger(mtu) && mtu >= 23 && mtu <= 517) port.mtu = mtu;
        let detach: (() => void) | null = null;
        try {
          detach = port.attach(
            (data) => ws.readyState === 1 && ws.send(data),
            (reason) => ws.close(1001, reason),
          );
        } catch {
          return ws.close(1013, "arm already connected");
        }
        ws.send(JSON.stringify({ type: "hello", name: port.name, mtu: port.mtu }));
        ws.on("message", (data, isBinary) => {
          if (!isBinary) return;
          try {
            port.write(new Uint8Array(data as Buffer));
          } catch (error) {
            if (error instanceof PacketTooLargeError) ws.close(1009, "packet larger than the negotiated MTU allows");
          }
        });
        ws.on("close", () => detach?.());
        ws.on("error", () => detach?.());
      });
      return;
    }

    if (url.pathname === "/control" && sim) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        controls.add(ws);
        ws.send(JSON.stringify({ type: "hello", version: VERSION, hub: hub !== null, width: 576, height: 136 }));
        ws.send(JSON.stringify(frameMessage()));
        ws.on("message", (data) => {
          try {
            applyInput(sim, JSON.parse(String(data)));
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", message: (error as Error).message }));
          }
        });
        ws.on("close", () => controls.delete(ws));
        ws.on("error", () => controls.delete(ws));
      });
      return;
    }

    if (url.pathname === "/v1/events" && hub) {
      const h = hub;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const off = h.onEvent((event) => ws.readyState === 1 && ws.send(JSON.stringify({ event })));
        ws.on("message", async (data) => {
          let id: unknown = null;
          try {
            const request = JSON.parse(String(data));
            id = request.id ?? null;
            const result = await h.call(String(request.method), request.params ?? {});
            ws.send(JSON.stringify({ id, ok: true, result }));
          } catch (error) {
            ws.send(JSON.stringify({ id, ok: false, error: { name: (error as Error).name, message: (error as Error).message } }));
          }
        });
        ws.on("close", off);
        ws.on("error", off);
      });
      return;
    }
    refuse(404, "Not Found");
  });

  // -- TCP, for the Python SDK -----------------------------------------------------------
  let tcp: TcpServer | null = null;
  const tcpSockets = new Set<Socket>();
  if (sim && options.tcpPort !== false) {
    tcp = createTcpServer((socket) => {
      tcpSockets.add(socket);
      socket.setNoDelay(true);
      let hello: Bytes = new Uint8Array(0);
      let detach: (() => void) | null = null;
      const reader = new LengthPrefixedReader();
      let portRef: Simulator["ports"][ArmName] | null = null;
      socket.on("data", (chunk) => {
        let data: Bytes = new Uint8Array(chunk);
        if (!portRef) {
          hello = hello.length ? new Uint8Array([...hello, ...data]) : data;
          if (hello.length < TCP_HELLO_SIZE) return;
          const ok = TCP_MAGIC.every((b, i) => hello[i] === b) && hello[6] === TCP_PROTOCOL_VERSION;
          // Not an openg1 client: close quietly. Port scanners exist.
          if (!ok) return socket.destroy();
          const port = sim.ports[hello[7] === 0 ? "left" : "right"];
          if (port.attached) return socket.destroy();
          port.mtu = ((hello[8]! << 8) | hello[9]!) || 247;
          detach = port.attach(
            (packet) => !socket.destroyed && socket.write(lengthPrefixed(packet)),
            () => socket.destroy(),
          );
          portRef = port;
          data = hello.subarray(TCP_HELLO_SIZE);
        }
        for (const packet of reader.push(data)) {
          try {
            portRef.write(packet);
          } catch {
            socket.destroy();
          }
        }
      });
      const done = () => {
        tcpSockets.delete(socket);
        detach?.();
        detach = null;
      };
      socket.on("close", done);
      socket.on("error", done);
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new OpenG1Error(`port ${options.port ?? 8765} is already in use — is another simulator running? Pick another with --port.`)
          : error,
      ),
    );
    http.listen(options.port ?? 8765, host, resolve);
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 8765);

  let tcpPort: number | null = null;
  if (tcp) {
    const wanted = options.tcpPort === undefined ? 8766 : (options.tcpPort as number);
    await new Promise<void>((resolve) => {
      // The TCP port is a convenience for Python clients; losing it must not stop the simulator.
      tcp!.once("error", () => {
        tcp = null;
        resolve();
      });
      tcp!.listen(wanted, host, () => {
        const a = tcp!.address();
        tcpPort = typeof a === "object" && a ? a.port : wanted;
        resolve();
      });
    });
  }

  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return {
    url: `http://${shown}:${port}`,
    host,
    port,
    tcpPort,
    sim,
    hub,
    async close() {
      for (const off of offs) off();
      for (const ws of wss.clients) ws.terminate();
      for (const socket of tcpSockets) socket.destroy();
      await ownG1?.disconnect().catch(() => {});
      sim?.close();
      await Promise.all([
        new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        }),
        tcp ? new Promise<void>((resolve) => tcp!.close(() => resolve())) : Promise.resolve(),
      ]);
    },
  };
}
