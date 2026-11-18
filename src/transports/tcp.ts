/**
 * TCP transport (Node): the wire format of the original Python simulator.
 *
 * `python3 -m openg1sim app` listens on 8766 and speaks this; so does this
 * project's own simulator server, for the Python SDK's benefit. One
 * connection per arm, a nine-byte hello — `OG1SIM`, a version byte, an arm
 * byte, a big-endian MTU — then every packet as a four-byte big-endian length
 * followed by that many bytes.
 */
import { connect, type Socket } from "node:net";
import { concat, type Bytes } from "../bytes.ts";
import { NotConnectedError, PacketTooLargeError, TransportError } from "../errors.ts";
import type { ArmName } from "../events.ts";
import { BaseTransport, type TransportPair } from "../transport.ts";

export const TCP_MAGIC = new TextEncoder().encode("OG1SIM");
export const TCP_PROTOCOL_VERSION = 1;
export const TCP_HELLO_SIZE = TCP_MAGIC.length + 4;
export const DEFAULT_TCP_PORT = 8766;

/** Splits a TCP stream back into length-prefixed packets. */
export class LengthPrefixedReader {
  #buffer: Bytes = new Uint8Array(0);
  /** Feed a chunk; get back every complete packet it finished. */
  push(chunk: Bytes): Bytes[] {
    this.#buffer = this.#buffer.length ? concat(this.#buffer, chunk) : chunk;
    const out: Bytes[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const b = this.#buffer;
      const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
      if (b.length < 4 + size) break;
      out.push(b.slice(4, 4 + size));
      this.#buffer = b.subarray(4 + size);
    }
    return out;
  }
}

export function lengthPrefixed(data: Bytes): Bytes {
  const n = data.length;
  return concat([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff], data);
}

export class TcpTransport extends BaseTransport {
  readonly arm: ArmName;
  readonly host: string;
  readonly port: number;
  readonly #mtu: number;
  #socket: Socket | null = null;

  constructor(arm: ArmName, host = "127.0.0.1", port = DEFAULT_TCP_PORT, mtu = 247) {
    super();
    this.arm = arm;
    this.host = host;
    this.port = port;
    this.#mtu = mtu;
    this.name = `Even G1_42_${arm === "left" ? "L" : "R"}_SIM`;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }
  get maxWrite(): number {
    return this.#mtu - 3;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = connect(this.port, this.host);
      const reader = new LengthPrefixedReader();
      socket.setNoDelay(true);
      socket.once("connect", () => {
        socket.write(
          concat(TCP_MAGIC, [TCP_PROTOCOL_VERSION, this.arm === "left" ? 0 : 1, (this.#mtu >> 8) & 0xff, this.#mtu & 0xff]),
        );
        this.#socket = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        for (const packet of reader.push(new Uint8Array(chunk))) this.emit(packet);
      });
      socket.once("error", (error) => {
        if (!this.#socket) reject(new TransportError(`no simulator on ${this.host}:${this.port} (${error.message})`));
      });
      socket.once("close", () => {
        if (this.#socket === socket) {
          this.#socket = null;
          this.emitDisconnect("socket closed");
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    socket?.destroy();
  }

  async write(data: Bytes): Promise<void> {
    if (!this.#socket || this.#socket.destroyed) throw new NotConnectedError(`${this.name} is not connected`);
    if (data.length > this.maxWrite) throw new PacketTooLargeError(data.length, this.maxWrite);
    this.#socket.write(lengthPrefixed(data));
  }
}

/** Both arms over TCP, ready for `G1.connect`. */
export function connectTcp(host = "127.0.0.1", port = DEFAULT_TCP_PORT, mtu = 247): TransportPair {
  return { left: new TcpTransport("left", host, port, mtu), right: new TcpTransport("right", host, port, mtu) };
}
