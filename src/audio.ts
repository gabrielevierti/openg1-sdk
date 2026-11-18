/**
 * Microphone audio: reassembly and container writing.
 *
 * The G1 streams LC3 (the Bluetooth LE Audio codec), not PCM. Decoding needs a
 * real codec, so the SDK does the parts it can do honestly — ordering frames,
 * spotting gaps, writing a file — and takes a decoder from you if you have
 * one. An `.lc3` dump feeds straight into ffmpeg.
 */
import { concat, type Bytes } from "./bytes.ts";

export const SAMPLE_RATE = 16000;
export const FRAME_DURATION_US = 10000;
export const FRAME_BYTES = 20;

/** Anything that turns one LC3 frame into 16-bit PCM samples. */
export type Lc3Decoder = (frame: Bytes) => Int16Array;

/** Collects LC3 packets and puts them back in order. */
export class AudioBuffer {
  readonly packets = new Map<number, Bytes>();
  #lastSeq: number | null = null;
  #epoch = 0;

  /** Add one packet. The 8-bit sequence wraps; wrap detection assumes nothing is late by half the space. */
  add(seq: number, data: Bytes): void {
    if (this.#lastSeq !== null && seq < this.#lastSeq - 128) this.#epoch += 256;
    this.#lastSeq = seq;
    this.packets.set(this.#epoch + seq, data.slice());
  }

  get packetCount(): number {
    return this.packets.size;
  }

  get byteLength(): number {
    let n = 0;
    for (const p of this.packets.values()) n += p.length;
    return n;
  }

  get durationS(): number {
    return ((this.byteLength / FRAME_BYTES) * FRAME_DURATION_US) / 1_000_000;
  }

  /** Indices dropped by the link. A few is normal; many means notifications are not drained fast enough. */
  missing(): number[] {
    const keys = [...this.packets.keys()].sort((a, b) => a - b);
    if (!keys.length) return [];
    const out: number[] = [];
    for (let i = keys[0]!; i <= keys[keys.length - 1]!; i++) if (!this.packets.has(i)) out.push(i);
    return out;
  }

  /** The LC3 frames, concatenated in order. */
  raw(): Bytes {
    const keys = [...this.packets.keys()].sort((a, b) => a - b);
    return concat(...keys.map((k) => this.packets.get(k)!));
  }

  clear(): void {
    this.packets.clear();
    this.#lastSeq = null;
    this.#epoch = 0;
  }

  /** An `.lc3` file with the standard header ffmpeg expects. */
  toLc3File(): Bytes {
    const payload = this.raw();
    const header = new Uint8Array(18);
    const v = new DataView(header.buffer);
    v.setUint16(0, 0x1c7c, true); // magic
    v.setUint16(2, 18, true); // header size
    v.setUint16(4, SAMPLE_RATE / 100, true);
    v.setUint16(6, 0, true); // bitrate, unknown for this stream
    v.setUint16(8, 1, true); // channels
    v.setUint16(10, FRAME_DURATION_US / 10, true);
    v.setUint16(12, 0, true); // rfu
    v.setUint32(14, Math.floor(payload.length / FRAME_BYTES), true);
    return concat(header, payload);
  }

  /** Decode to 16-bit mono PCM with a decoder you supply (for example a liblc3 WASM build). */
  decode(decoder: Lc3Decoder): Int16Array {
    const raw = this.raw();
    const chunks: Int16Array[] = [];
    let total = 0;
    for (let i = 0; i + FRAME_BYTES <= raw.length; i += FRAME_BYTES) {
      const pcm = decoder(raw.subarray(i, i + FRAME_BYTES));
      chunks.push(pcm);
      total += pcm.length;
    }
    const out = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/** Wrap 16-bit mono PCM in a WAV container. */
export function pcmToWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Bytes {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => (out[offset + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}
