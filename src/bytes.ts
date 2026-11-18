/** Small byte helpers shared by everything. No Buffer: this runs in browsers and React Native too. */

export type Bytes = Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

export function fromUtf8(data: Bytes): string {
  return decoder.decode(data);
}

export function concat(...parts: ArrayLike<number>[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function toHex(data: ArrayLike<number>, separator = ""): string {
  const out: string[] = [];
  for (let i = 0; i < data.length; i++) out.push(data[i]!.toString(16).padStart(2, "0"));
  return out.join(separator);
}

export function fromHex(hex: string): Bytes {
  const clean = hex.replace(/[\s,]|0x/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`not a hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Right-pad with zeros, as the firmware does to short replies. */
export function padTo(data: Bytes, size: number): Bytes {
  if (data.length >= size) return data;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(data: Bytes): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

let b64Lookup: Int16Array | null = null;

export function fromBase64(text: string): Bytes {
  if (!b64Lookup) {
    b64Lookup = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64.length; i++) b64Lookup[B64.charCodeAt(i)] = i;
    b64Lookup["-".charCodeAt(0)] = 62; // url-safe variants
    b64Lookup["_".charCodeAt(0)] = 63;
  }
  const clean = text.replace(/[\s=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = b64Lookup[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new Error("not a base64 string");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
