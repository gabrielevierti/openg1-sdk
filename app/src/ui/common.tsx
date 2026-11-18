import type { ComponentChildren } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import { formatDistance, formatDuration, getFont, type FontName } from "openg1";
import type { Simulator } from "openg1/sim";
import { app } from "../app.ts";
import { pointAlong } from "../nav/geo.ts";
import type { Route } from "../nav/route.ts";

/** Re-render whenever the app's state changes. */
export function useApp(): typeof app {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => app.subscribe(() => bump(0)), []);
  return app;
}

/** Run an action from a button: progress, and a readable line if it fails. */
export const run = (label: string, fn: () => Promise<unknown>) => () => void app.attempt(label, fn);

export const km = (metres: number) => formatDistance(metres) || "0 m";
export const duration = (seconds: number) => formatDuration(seconds);

// -- icons: a small set of line glyphs, drawn for this app ---------------------------------

const PATHS: Record<string, string> = {
  home: "M4 11 12 4l8 7v8H4z M10 19v-5h4v5",
  apps: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  settings: "M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4h4V5z M6 15v4h4v-4z",
  navigate: "M6 20V11a4 4 0 0 1 4-4h8 M14 3l4 4-4 4",
  teleprompter: "M4 6h16 M4 11h16 M4 16h10 M17 14l3 2-3 2",
  assistant: "M5 5h14v10H11l-4 4v-4H5z M9 10h.01 M12 10h.01 M15 10h.01",
  translate: "M4 6h8 M8 4v2 M5 14c3-1 5-4 5-8 M6 9c1 2 3 4 5 5 M14 20l3-8 3 8 M15 18h4",
  notes: "M6 4h9l3 3v13H6z M9 10h6 M9 14h6",
  message: "M4 6h16v10H9l-5 4z",
  back: "M14 5l-7 7 7 7",
  hud: "M3 9h18v7H3z M7 13h4 M15 13h2",
};

export function Icon(props: { name: keyof typeof PATHS | string; size?: number }) {
  const size = props.size ?? 22;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">
      <path d={PATHS[props.name] ?? ""} />
    </svg>
  );
}

// -- dot-matrix text: the glasses' own pixels, as the app's display face --------------------

/** Text drawn with the SDK's bitmap fonts, one round dot per pixel. */
export function DotText(props: { text: string; font?: FontName; dot?: number; label?: string }) {
  const state = useApp();
  const ref = useRef<HTMLCanvasElement>(null);
  const font = getFont(props.font ?? "lg");
  const pitch = props.dot ?? 3;
  const width = Math.max(1, Math.ceil(font.measure(props.text)));
  const height = font.lineHeight;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * pitch * ratio;
    canvas.height = height * pitch * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = getComputedStyle(canvas).color;
    let pen = 0;
    for (const ch of props.text) {
      const g = font.glyph(ch);
      if (g) {
        for (let y = 0; y < g.height; y++) {
          for (let x = 0; x < g.width; x++) {
            const i = y * g.width + x;
            if (!(g.bits[i >> 3]! & (0x80 >> (i & 7)))) continue;
            ctx.beginPath();
            ctx.arc((pen + g.xoff + x + 0.5) * pitch, (g.yoff + y + 0.5) * pitch, pitch * 0.42, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      pen += font.advance(ch);
    }
  }, [props.text, props.font, pitch, state.settings.theme]);
  return <canvas ref={ref} class="dots" style={{ width: `${width * pitch}px`, aspectRatio: `${width} / ${height}` }} role="img" aria-label={props.label ?? props.text} />;
}

// -- building blocks ---------------------------------------------------------------------

export function Card(props: { title?: string; aside?: ComponentChildren; children: ComponentChildren; id?: string }) {
  return (
    <section class="card" id={props.id}>
      {props.title && (
        <div class="card-head">
          <h2>{props.title}</h2>
          {props.aside}
        </div>
      )}
      {props.children}
    </section>
  );
}

/** A feature opened over the tabs: a title bar with a way back. */
export function Screen(props: { title: string; children: ComponentChildren }) {
  const state = useApp();
  return (
    <>
      <header class="bar">
        <button class="icon-btn" aria-label="Back" onClick={() => state.open(null)}><Icon name="back" /></button>
        <h1>{props.title}</h1>
        <span class="icon-btn" aria-hidden="true" />
      </header>
      <main>
        <Notice />
        {props.children}
      </main>
    </>
  );
}

export function Notice() {
  const state = useApp();
  if (!state.busy && !state.notice) return null;
  return (
    <p class={`notice ${state.noticeIsError ? "bad" : ""}`} role="status" onClick={() => state.say("")}>
      {state.busy ? `${state.busy}…` : state.notice}
    </p>
  );
}

export function Toggle(props: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return (
    <label class="toggle-row" for={props.id}>
      <span>
        <span class="label">{props.label}</span>
        {props.hint && <span class="hint">{props.hint}</span>}
      </span>
      <input id={props.id} type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

/** What the glasses are showing right now, drawn from the preview simulator. */
export function Preview(props: { sim?: Simulator; note?: string }) {
  const state = useApp();
  const ref = useRef<HTMLCanvasElement>(null);
  const sim = props.sim ?? state.conn.preview;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(576, 136);
    const bits = sim.frame.bits;
    for (let y = 0; y < 136; y++) {
      for (let x = 0; x < 576; x++) {
        const lit = (bits[y * 72 + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const i = (y * 576 + x) * 4;
        image.data[i] = 96;
        image.data[i + 1] = 240;
        image.data[i + 2] = 150;
        image.data[i + 3] = lit ? 255 : 0;
      }
    }
    ctx.putImageData(image, 0, 0);
  });
  const empty = sim.left.display.kind === "none";
  const style = {
    "--hidden-top": `${(state.settings.hiddenTop / 136) * 100}%`,
    "--hidden-bottom": `${(state.settings.hiddenBottom / 136) * 100}%`,
  };
  return (
    <div class="lens" style={style} aria-label="What the glasses are showing">
      <div class="frame">
        <canvas ref={ref} width={576} height={136} />
        {empty && <p class="lens-note">{props.note ?? (state.conn.g1 ? "Display clear" : "Not connected")}</p>}
      </div>
    </div>
  );
}

/** The route as a line: where it goes, where you are on it. No map tiles, so it works offline. */
export function RouteMap(props: { route: Route; alongM?: number }) {
  const state = useApp();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    const { line, cumulative } = props.route;
    const k = Math.cos((line[0]!.lat * Math.PI) / 180);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of line) {
      minX = Math.min(minX, p.lon * k); maxX = Math.max(maxX, p.lon * k);
      minY = Math.min(minY, p.lat); maxY = Math.max(maxY, p.lat);
    }
    const pad = 22;
    const scale = Math.min((w - pad * 2) / Math.max(maxX - minX, 1e-9), (h - pad * 2) / Math.max(maxY - minY, 1e-9));
    const ox = (w - (maxX - minX) * scale) / 2;
    const oy = (h - (maxY - minY) * scale) / 2;
    const at = (p: { lat: number; lon: number }): [number, number] => [ox + (p.lon * k - minX) * scale, h - oy - (p.lat - minY) * scale];
    const css = getComputedStyle(canvas);
    const ink = css.color;
    const signal = css.getPropertyValue("--signal").trim() || ink;

    // A faint grid, so the line reads as a place rather than a squiggle.
    ctx.strokeStyle = css.getPropertyValue("--line").trim();
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 28) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 28) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }

    const stroke = (from: number, to: number, color: string, width: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < line.length; i++) {
        if (cumulative[i]! < from || cumulative[i]! > to) continue;
        const [x, y] = at(line[i]!);
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
    };
    const total = cumulative[cumulative.length - 1]!;
    const along = Math.max(0, Math.min(total, props.alongM ?? 0));
    stroke(0, total, ink, 4);
    if (along > 0) stroke(0, along, css.getPropertyValue("--soft").trim(), 4);

    const dot = (p: { lat: number; lon: number }, r: number, fill: string, ring?: string) => {
      const [x, y] = at(p);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = 2; ctx.stroke(); }
    };
    dot(line[0]!, 4, ink);
    const end = at(line[line.length - 1]!);
    ctx.fillStyle = ink; ctx.fillRect(end[0] - 6, end[1] - 6, 12, 12);
    if (props.alongM !== undefined) dot(pointAlong(line, cumulative, along), 7, signal, css.getPropertyValue("--surface").trim());
  }, [props.route, props.alongM, state.settings.theme]);
  return <canvas ref={ref} class="map" role="img" aria-label="Route overview" />;
}
