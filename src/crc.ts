/**
 * CRC-32 as the G1 expects it for bitmap transfers.
 *
 * Even's docs call it "Crc32Xz": the ordinary CRC-32/ISO-HDLC of zlib and PNG.
 * The G1-specific part is that the four storage-address bytes are prepended to
 * the image before the checksum is taken, and the result travels big endian.
 * A CRC over the file alone is rejected by the glasses.
 */
import { BMP_STORAGE_ADDRESS } from "./generated.ts";
import { concat, type Bytes } from "./bytes.ts";

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: ArrayLike<number>): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC for a bitmap transfer, address bytes included as the device does. */
export function bmpCrc(image: Bytes, address: ArrayLike<number> = BMP_STORAGE_ADDRESS): number {
  return crc32(concat(address, image));
}

export function crc32BE(value: number): Bytes {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}
