import { useEffect, useState } from "preact/hooks";
import { DotText, Icon, Preview, run, useApp } from "./common.tsx";

function Link() {
  const state = useApp();
  const { conn } = state;
  if (conn.state === "connected") return null;
  const working = conn.state !== "idle";
  const label = !conn.native && conn.missingArm === "right" ? "Choose the right arm" : "Connect glasses";
  return (
    <section class="card">
      <p class="lead">{working ? "Looking for your glasses…" : "Connect your G1"}</p>
      <p class="hint">
        {conn.message ||
          (conn.native
            ? "Take them out of the case and close the official app: an arm accepts one connection at a time."
            : "In a browser you choose each arm in turn. Close the official app first.")}
      </p>
      <div class="row">
        <button class="btn primary grow" disabled={working || !conn.bluetoothAvailable} onClick={run("Connecting", () => conn.connectGlasses())}>{label}</button>
        <button class="btn grow" disabled={working} onClick={run("Starting the simulator", () => conn.connectSimulator(state.settings.simulatorUrl))}>Use the simulator</button>
      </div>
      {!conn.bluetoothAvailable && <p class="hint">No Bluetooth access in this browser. Install the app, or use Chrome on Android or a computer.</p>}
    </section>
  );
}

/** Time, date, weather and both batteries: the same things the heads-up screen shows on the glasses. */
function Widgets() {
  const state = useApp();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);
  const b = state.conn.battery;
  const w = state.weather;
  const time = now.toLocaleTimeString(state.settings.twelveHour ? "en-US" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: state.settings.twelveHour }).replace(/ ?[AP]M/i, "");
  const temp = w ? (state.settings.fahrenheit ? `${Math.round(w.temperatureC * 1.8 + 32)}°F` : `${Math.round(w.temperatureC)}°C`) : null;
  const running = state.activities.current?.id === "hud";
  const connected = !!state.conn.g1;
  return (
    <section class="panel">
      <div class="panel-top">
        <span class="eyebrow">{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
        <span class="eyebrow">{temp ? `${temp} · ${w!.label}` : "No weather yet"}</span>
      </div>
      <DotText text={time} font="xl" dot={3} label={`Time ${time}`} />
      <div class="panel-bottom">
        <div class="cells">
          <div><span class="eyebrow">Left arm</span><span class="num">{b ? `${b.left}%` : "–"}</span></div>
          <div><span class="eyebrow">Right arm</span><span class="num">{b ? `${b.right}%` : "–"}</span></div>
        </div>
        <div class="panel-actions">
          <button class="btn small" disabled={!connected} onClick={run("Updating", async () => { await state.sync(true); state.say("Clock and weather updated."); })}>Weather</button>
          <button class={`btn small ${running ? "primary" : ""}`} disabled={!connected} onClick={run(running ? "Stopping" : "Starting", () => (running ? state.stop() : state.startHud()))}>
            {running ? "On glasses" : "To glasses"}
          </button>
        </div>
      </div>
    </section>
  );
}

function NowRunning() {
  const state = useApp();
  const { current, status, error } = state.activities;
  if (!current && !error) return null;
  return (
    <section class="running">
      <span class="live" aria-hidden="true" />
      <span class="grow">
        <span class="label">{current ? (current.id === "miniapps" && state.miniApp ? `Mini-apps · ${state.miniApp}` : current.title) : "Stopped"}</span>
        {(status || error) && <span class={error ? "error" : "hint"}>{error || status}</span>}
      </span>
      {current && <button class="btn small" onClick={run("Stopping", () => state.stop())}>Stop</button>}
    </section>
  );
}

/** Stand-ins for the touch bars, shown only when the "glasses" are the built-in simulator. */
function WearerStrip() {
  const { conn } = useApp();
  if (!conn.simulated || !conn.g1) return null;
  const sim = conn.preview;
  return (
    <div class="wearer" aria-label="Simulated touch bars">
      <button class="chip" onClick={() => sim.tap("left")}>Left tap</button>
      <button class="chip" onClick={() => sim.tap("right")}>Right tap</button>
      <button class="chip" onClick={() => sim.tap("right", 2)}>Double</button>
      <button class="chip" onClick={() => sim.tap("right", 3)}>Triple</button>
    </div>
  );
}

const TILES = [
  { id: "navigate", title: "Navigate", about: "Turn by turn, with your speed" },
  { id: "teleprompter", title: "Teleprompt", about: "Read a text hands-free" },
  { id: "assistant", title: "Assistant", about: "Ask, read the answer" },
  { id: "translate", title: "Translate", about: "Any language, on the lens" },
  { id: "notes", title: "Notes", about: "Lists and reminders" },
  { id: "message", title: "Quick text", about: "Show a line right now" },
] as const;

export function Home() {
  const state = useApp();
  const device = state.device;
  const connected = !!state.conn.g1;
  return (
    <>
      <Link />
      <Widgets />
      <Preview />
      <WearerStrip />
      <NowRunning />
      <div class="tiles">
        {TILES.map((t) => (
          <button key={t.id} class="tile" id={`tile-${t.id}`} onClick={() => state.open(t.id)}>
            <Icon name={t.id} size={26} />
            <span class="label">{t.title}</span>
            <span class="hint">{t.about}</span>
          </button>
        ))}
      </div>
      <section class="card">
        <label class="slider" for="brightness">
          <span class="label">Brightness</span>
          <input id="brightness" type="range" min={0} max={42} value={device?.brightness ?? 21} disabled={!connected || device?.autoBrightness}
            onChange={(e) => void state.attempt("Setting brightness", () => state.setDevice({ brightness: Number((e.target as HTMLInputElement).value) }))} />
          <output>{device?.autoBrightness ? "auto" : `${device?.brightness ?? 21}/42`}</output>
        </label>
      </section>
    </>
  );
}
