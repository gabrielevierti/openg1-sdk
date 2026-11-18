/**
 * Drawing as data.
 *
 * A screen described as a JSON list of operations, so that anything that can
 * make an HTTP request — a Swift app, a Kotlin app, a Shortcut, curl — can put
 * a custom layout on the glasses through the hub without linking this
 * library. Each operation maps onto one {@link Canvas} method.
 *
 *     [
 *       { "op": "text", "text": "87", "x": 288, "y": 20, "font": "xl", "align": "center" },
 *       { "op": "progress", "x": 138, "y": 110, "width": 300, "height": 14, "value": 0.6 }
 *     ]
 */
import type { Canvas } from "./canvas.ts";
import { ProtocolError } from "./errors.ts";
import type { FontName } from "./font.ts";

type Align = "left" | "center" | "right";

export type DrawOp =
  | { op: "text"; text: string; x: number; y: number; font?: FontName; align?: Align; baseline?: "top" | "middle" | "alphabetic"; scale?: number; maxWidth?: number; on?: boolean }
  | { op: "textBox"; text: string; x: number; y: number; width: number; height: number; font?: FontName; align?: Align; valign?: "top" | "middle" | "bottom"; maxLines?: number; on?: boolean }
  | { op: "line"; x0: number; y0: number; x1: number; y1: number; lineWidth?: number; on?: boolean }
  | { op: "rect"; x: number; y: number; width: number; height: number; fill?: boolean; radius?: number; lineWidth?: number; on?: boolean }
  | { op: "circle"; x: number; y: number; r: number; fill?: boolean; lineWidth?: number; on?: boolean }
  | { op: "arc"; x: number; y: number; r: number; start: number; end: number; lineWidth?: number; on?: boolean }
  | { op: "polygon"; points: [number, number][]; fill?: boolean; lineWidth?: number; on?: boolean }
  | { op: "progress"; x: number; y: number; width: number; height: number; value: number }
  | { op: "arrow"; x: number; y: number; size: number; angle?: number }
  | { op: "battery"; x: number; y: number; level: number }
  | { op: "invert"; x: number; y: number; width: number; height: number };

const FONTS = new Set(["sm", "md", "fw", "lg", "xl"]);

/** Apply a list of drawing operations to a canvas, validating as it goes. */
export function applyDrawOps(canvas: Canvas, ops: readonly DrawOp[]): void {
  if (!Array.isArray(ops)) throw new ProtocolError("ops must be an array of drawing operations");
  ops.forEach((raw, index) => {
    const o = raw as Record<string, unknown> & { op: string };
    const where = `ops[${index}] (${String(o?.op)})`;
    const num = (key: string, fallback?: number): number => {
      const v = o[key] ?? fallback;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ProtocolError(`${where}: "${key}" must be a number`);
      return v;
    };
    const str = (key: string): string => {
      if (typeof o[key] !== "string") throw new ProtocolError(`${where}: "${key}" must be a string`);
      return o[key] as string;
    };
    const font = (): FontName | undefined => {
      if (o.font === undefined) return undefined;
      if (!FONTS.has(o.font as string)) throw new ProtocolError(`${where}: font must be one of sm, md, fw, lg, xl`);
      return o.font as FontName;
    };
    const on = o.on === undefined ? true : Boolean(o.on);
    const lineWidth = o.lineWidth === undefined ? undefined : num("lineWidth");

    switch (o.op) {
      case "text":
        canvas.text(str("text"), num("x"), num("y"), {
          font: font(),
          align: o.align as Align | undefined,
          baseline: o.baseline as "top" | undefined,
          scale: o.scale === undefined ? undefined : num("scale"),
          maxWidth: o.maxWidth === undefined ? undefined : num("maxWidth"),
          on,
        });
        break;
      case "textBox":
        canvas.textBox(str("text"), num("x"), num("y"), num("width"), num("height"), {
          font: font(),
          align: o.align as Align | undefined,
          valign: o.valign as "top" | undefined,
          maxLines: o.maxLines === undefined ? undefined : num("maxLines"),
          on,
        });
        break;
      case "line":
        canvas.line(num("x0"), num("y0"), num("x1"), num("y1"), { width: lineWidth, on });
        break;
      case "rect":
        canvas.rect(num("x"), num("y"), num("width"), num("height"), {
          fill: Boolean(o.fill),
          radius: o.radius === undefined ? undefined : num("radius"),
          width: lineWidth,
          on,
        });
        break;
      case "circle":
        canvas.circle(num("x"), num("y"), num("r"), { fill: Boolean(o.fill), width: lineWidth, on });
        break;
      case "arc":
        canvas.arc(num("x"), num("y"), num("r"), num("start"), num("end"), { width: lineWidth, on });
        break;
      case "polygon": {
        const points = o.points;
        if (!Array.isArray(points) || points.some((p) => !Array.isArray(p) || p.length !== 2)) {
          throw new ProtocolError(`${where}: "points" must be a list of [x, y] pairs`);
        }
        canvas.polygon(points as [number, number][], { fill: Boolean(o.fill), width: lineWidth, on });
        break;
      }
      case "progress":
        canvas.progress(num("x"), num("y"), num("width"), num("height"), num("value"));
        break;
      case "arrow":
        canvas.arrow(num("x"), num("y"), num("size"), num("angle", 0));
        break;
      case "battery":
        canvas.battery(num("x"), num("y"), num("level"));
        break;
      case "invert":
        canvas.invertRect(num("x"), num("y"), num("width"), num("height"));
        break;
      default:
        throw new ProtocolError(
          `${where}: unknown operation. Use text, textBox, line, rect, circle, arc, polygon, progress, arrow, battery or invert.`,
        );
    }
  });
}
