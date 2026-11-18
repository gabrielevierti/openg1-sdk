import { CATALOG } from "../features/miniapps.ts";
import { run, useApp } from "./common.tsx";

export function Apps() {
  const state = useApp();
  const chosen = state.settings.miniApps;
  const connected = !!state.conn.g1;
  const running = state.activities.current?.id === "miniapps";
  return (
    <>
      <div class="section-head"><h2>Mini-apps</h2></div>
      <p class="hint pad">Small screens that take turns on the glasses. Pick the ones you want, start, and triple-tap a touch bar to switch.</p>
      <ul class="list">
        {CATALOG.map((a) => (
          <li key={a.id}>
            <label class="grow check" for={`mini-${a.id}`}>
              <input id={`mini-${a.id}`} type="checkbox" checked={chosen.includes(a.id)}
                onChange={(e) => {
                  const on = (e.target as HTMLInputElement).checked;
                  state.set({ miniApps: on ? CATALOG.map((c) => c.id).filter((id) => id === a.id || chosen.includes(id)) : chosen.filter((id) => id !== a.id) });
                }} />
              <span><span class="label">{a.title}</span><span class="hint">{a.about}</span></span>
            </label>
            {running && state.miniApp === a.title && <span class="pill on">On screen</span>}
          </li>
        ))}
      </ul>
      {running ? (
        <button class="btn" onClick={run("Stopping", () => state.stop())}>Stop</button>
      ) : (
        <button class="btn primary" id="start-miniapps" disabled={!connected || !chosen.length} onClick={run("Starting", () => state.startMiniApps())}>Start on the glasses</button>
      )}
      {!connected && <p class="hint pad">Connect the glasses on the Home tab first.</p>}
    </>
  );
}
