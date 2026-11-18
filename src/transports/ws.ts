/**
 * WebSocket transport: reach a simulator (or a bridge) running somewhere else.
 *
 * One socket per arm; one binary message is one BLE packet, in both
 * directions. That is the whole protocol, so anything above the transport
 * cannot tell this from a radio. Works wherever a global `WebSocket` exists:
 * browsers, React Native, Node 22+.
 *
 *     import { G1 } from "openg1";
 *     import { connectSimulator } from "openg1/transports/ws";
 *
 *     const g1 = await G1.connect(connectSimulator());          // ws://127.0.0.1:8765
 *     const g1 = await G1.connect(connectSimulator("ws://192.168.1.20:8765"));
 */
import type { Bytes } from "../bytes.ts";
import { NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { BaseTransport, type TransportPair } from "../transport.ts";

export const DEFAULT_SIMULATOR_URL = "ws://127.0.0.1:8765";

export interface WsOptions {
  /** The MTU to negotiate with the simulator. 23 reproduces a link without MTU exchange. */
  mtu?: number;
  /** Sent as `?token=` for servers started with one. */
  token?: string;
  /** Supply a WebSocket constructor where there is no global one. */
  WebSocket?: typeof WebSocket;
}

export class WsTransport extends BaseTransport {
  readonly arm: ArmName;
  readonly url: string;
  readonly #mtu: number;
  readonly #ctor: typeof WebSocket;
  #socket: WebSocket | null = null;

  constructor(arm: ArmName, baseUrl: string = DEFAULT_SIMULATOR_URL, options: WsOptions = {}) {
    super();
    this.arm = arm;
    this.#mtu = options.mtu ?? 247;
    const ctor = options.WebSocket ?? globalThis.WebSocket;
    if (!ctor) throw new TransportError("no WebSocket implementation here; pass one as options.WebSocket");
    this.#ctor = ctor;
    const base = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const token = options.token ? `&token=${encodeURIComponent(options.token)}` : "";
    this.url = `${base}/arm/${arm}?mtu=${this.#mtu}${token}`;
    this.name = `Even G1_42_${arm === "left" ? "L" : "R"}_SIM001`;
  }

  get connected(): boolean {
    return this.#socket?.readyState === 1;
  }

  get maxWrite(): number {
    return this.#mtu - 3;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new this.#ctor(this.url);
      socket.binaryType = "arraybuffer";
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.#socket = socket;
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          // The server's greeting carries the arm's advertised name.
          try {
            const hello = JSON.parse(event.data);
            if (typeof hello.name === "string") this.name = hello.name;
          } catch {
            /* not ours */
          }
          return;
        }
        this.emit(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        if (!opened) {
          reject(
            new TransportError(
              `nothing answered at ${this.url} — is the simulator running? Start it with \`npx openg1 sim\`.`,
            ),
          );
        }
      };
      socket.onclose = (event: CloseEvent) => {
        const was = this.#socket === socket;
        if (was) this.#socket = null;
        if (!opened) reject(new TransportError(`${this.url} refused the connection${event.reason ? `: ${event.reason}` : ""}`));
        else if (was) this.emitDisconnect(event.reason || "socket closed");
      };
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
  }

  async write(data: Bytes): Promise<void> {
    if (!this.#socket || this.#socket.readyState !== 1) throw new NotConnectedError(`${this.name} is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    this.#socket.send(data);
  }
}

/** Both arms of a simulator, ready for `G1.connect`. */
export function connectSimulator(url: string = DEFAULT_SIMULATOR_URL, options: WsOptions = {}): TransportPair {
  return { left: new WsTransport("left", url, options), right: new WsTransport("right", url, options) };
}
