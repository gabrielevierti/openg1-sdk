/**
 * Turning what an arm was told into what the wearer would see.
 *
 * Bitmaps are exact: the pixels you sent are the pixels shown. Firmware text
 * is an approximation, and says so — the real font is not published, so lines
 * are drawn in a condensed stand-in at the same size and line pitch, and
 * "does it fit" is answered by the same metrics the SDK lays text out with. Use
 * the report to catch the failures a byte log cannot: a line wider than the
 * panel, a sixth line the firmware drops, ink in rows this pair cannot show.
 */
import { DEFAULT_LINES_PER_SCREEN, DISPLAY_HEIGHT, DISPLAY_WIDTH, ScreenStatus, TEXT_WIDTH } from "../generated.ts";
import { LINE_HEIGHT } from "../app.ts";
import type { SafeArea } from "../bitmap.ts";
import { Canvas } from "../canvas.ts";
import { getFont } from "../font.ts";
import { measure } from "../text.ts";
import type { ArmDisplay } from "./firmware.ts";

export const TEXT_MARGIN_X = (DISPLAY_WIDTH - TEXT_WIDTH) / 2;
export const TEXT_TOP = 2;

export interface RenderReport {
  kind: ArmDisplay["kind"];
  litPixels: number;
  /** Lit pixels in rows this pair's profile marks as hidden. Non-zero means you drew something nobody will read. */
  hiddenInk: number;
  /** Lines past the fifth: the firmware drops them. */
  truncatedLines: number;
  /** Lines wider than the text column: the firmware clips them. */
  overflowLines: string[];
  fits: boolean;
}

export interface RenderOptions {
  safeArea?: SafeArea;
  /** False when the display is off: not worn, or powered down. */
  visible?: boolean;
}

export function renderDisplay(display: ArmDisplay, o: RenderOptions = {}): { canvas: Canvas; report: RenderReport } {
  const canvas = new Canvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const report: RenderReport = {
    kind: display.kind,
    litPixels: 0,
    hiddenInk: 0,
    truncatedLines: 0,
    overflowLines: [],
    fits: true,
  };
  if (o.visible !== false) {
    if (display.kind === "image" && display.image) canvas.image(display.image, 0, 0, "copy");
    else if (display.kind === "text") renderText(canvas, display, report);
    else if (display.kind === "notification" && display.notification) renderNotification(canvas, display);
  }
  const [top, bottom] = o.safeArea ?? [0, 0];
  report.litPixels = canvas.bitmap.lit();
  report.hiddenInk = canvas.bitmap.litInRows(0, top) + canvas.bitmap.litInRows(DISPLAY_HEIGHT - bottom, DISPLAY_HEIGHT);
  report.fits = !report.truncatedLines && !report.overflowLines.length && !report.hiddenInk;
  return { canvas, report };
}

function renderText(canvas: Canvas, display: ArmDisplay, report: RenderReport): void {
  const font = getFont("fw");
  // The firmware does not wrap: each "\n"-separated line is drawn as sent.
  let lines = display.text.split("\n");
  if (lines.length > DEFAULT_LINES_PER_SCREEN) {
    report.truncatedLines = lines.length - DEFAULT_LINES_PER_SCREEN;
    lines = lines.slice(0, DEFAULT_LINES_PER_SCREEN);
  }
  lines.forEach((line, i) => {
    // Whether a line fits is judged by the SDK's own metrics — the model the
    // layout code uses — so a line `display.text` wrapped never reads as
    // overflow here. The stand-in font is then tightened to that width.
    let chars = [...line];
    if (measure(line) > TEXT_WIDTH) {
      report.overflowLines.push(line);
      while (chars.length && measure(chars.join("")) > TEXT_WIDTH) chars.pop();
    }
    const shown = chars.join("");
    const excess = font.measure(shown) - TEXT_WIDTH;
    const spacing = excess > 0 && chars.length > 1 ? -Math.ceil(excess / (chars.length - 1)) : 0;
    canvas.text(shown, TEXT_MARGIN_X, TEXT_TOP + i * LINE_HEIGHT, { font, spacing });
  });
  // The Even AI modes page through the answer; show where you are.
  const ai = display.mode !== ScreenStatus.TEXT_SHOW;
  if (ai && display.maxPage > 1) {
    const h = Math.max(6, Math.round(DISPLAY_HEIGHT / display.maxPage));
    const y = Math.round(((display.page - 1) / display.maxPage) * DISPLAY_HEIGHT);
    canvas.rect(DISPLAY_WIDTH - 6, Math.min(DISPLAY_HEIGHT - h, y), 3, h, { fill: true });
  }
}

function renderNotification(canvas: Canvas, display: ArmDisplay): void {
  const n = display.notification!;
  const x = TEXT_MARGIN_X;
  canvas.rect(x - 10, 6, TEXT_WIDTH + 20, DISPLAY_HEIGHT - 12, { radius: 10 });
  canvas.text(n.app || "Notification", x, 12, { font: "sm", maxWidth: TEXT_WIDTH });
  canvas.text(n.title, x, 32, { font: "md", maxWidth: TEXT_WIDTH });
  const body = [n.subtitle, n.message].filter(Boolean).join(" — ");
  canvas.textBox(body, x, 60, TEXT_WIDTH, DISPLAY_HEIGHT - 72, { font: "sm", maxLines: 3 });
}
