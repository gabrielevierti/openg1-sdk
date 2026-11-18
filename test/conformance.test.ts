/**
 * The contract every binding must satisfy: protocol/vectors.json, byte for
 * byte. The Python SDK passes the same file, so passing here means the two
 * implementations put identical bytes on the wire.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  bmpCrc,
  COMMANDS,
  commands,
  crc32,
  decode,
  encodeFramed,
  encodeRaw,
  fromHex,
  splitUtf8,
  toHex,
} from "../src/index.ts";

interface Vector {
  kind: "encode" | "decode" | "crc" | "crc_bmp" | "split";
  name: string;
  command?: string;
  seq?: number | null;
  body?: string;
  input?: string;
  limit?: number;
  expect: unknown;
}

const { vectors } = JSON.parse(readFileSync(new URL("../protocol/vectors.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};

test("there are vectors of every kind", () => {
  const kinds = new Set(vectors.map((v) => v.kind));
  assert.deepEqual([...kinds].sort(), ["crc", "crc_bmp", "decode", "encode", "split"]);
  assert.ok(vectors.length >= 83);
});

for (const v of vectors) {
  test(`vector ${v.name}`, () => {
    switch (v.kind) {
      case "encode": {
        const spec = COMMANDS[v.command!]!;
        // The vector's body is everything after the constant prefix the spec declares.
        const body = commands.command(v.command!, fromHex(v.body!)).body;
        const out = spec.framed ? encodeFramed(spec.opcode, v.seq ?? 0, body) : encodeRaw(spec.opcode, body);
        assert.equal(toHex(out), v.expect);
        break;
      }
      case "decode": {
        const e = v.expect as { opcode: number; framed: boolean; seq: number | null; payload: string; trailer: string };
        const p = decode(fromHex(v.input!));
        assert.equal(p.opcode, e.opcode);
        assert.equal(p.framed, e.framed);
        assert.equal(p.seq, e.seq);
        assert.equal(toHex(p.payload), e.payload);
        assert.equal(toHex(p.trailer), e.trailer);
        break;
      }
      case "crc":
        assert.equal(crc32(fromHex(v.input!)).toString(16).padStart(8, "0"), v.expect);
        break;
      case "crc_bmp":
        assert.equal(bmpCrc(fromHex(v.input!)).toString(16).padStart(8, "0"), v.expect);
        break;
      case "split":
        assert.deepEqual(
          splitUtf8(fromHex(v.input!), v.limit!).map((p) => toHex(p)),
          v.expect,
        );
        break;
    }
  });
}
