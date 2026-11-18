import { useState } from "preact/hooks";
import { DEFAULT_ENDPOINTS } from "../nav/route.ts";
import { Card, run, Toggle, useApp } from "./common.tsx";

function NumberField(props: { id: string; label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return (
    <label class="field" for={props.id}>
      {props.label}
      <input
        id={props.id}
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => {
          const v = Math.round(Number((e.target as HTMLInputElement).value));
          if (Number.isFinite(v)) props.onChange(Math.max(props.min, Math.min(props.max, v)));
        }}
      />
    </label>
  );
}

function Notifications() {
  const state = useApp();
  const s = state.settings;
  const connected = !!state.conn.g1;
  const [appName, setAppName] = useState("");
  const [appId, setAppId] = useState("");
  return (
    <Card title="Notifications">
      <p class="hint">
        The glasses show notifications themselves once they are paired with the phone in its Bluetooth settings; what the app controls is which ones get through.
        {state.conn.native ? "" : " Forwarding Android notifications needs the installed app."}
      </p>
      <Toggle id="n-calls" label="Calls" checked={s.notifyCalls} onChange={(v) => state.set({ notifyCalls: v })} />
      <Toggle id="n-messages" label="Messages" checked={s.notifyMessages} onChange={(v) => state.set({ notifyMessages: v })} />
      <Toggle id="n-calendar" label="Calendar" checked={s.notifyCalendar} onChange={(v) => state.set({ notifyCalendar: v })} />
      <Toggle id="n-mail" label="Mail" checked={s.notifyMail} onChange={(v) => state.set({ notifyMail: v })} />
      {s.notifyApps.length > 0 && (
        <ul class="places">
          {s.notifyApps.map((a) => (
            <li key={a.id} class="note">
              <span><span class="label">{a.name}</span><span class="hint">{a.id}</span></span>
              <button class="btn small" onClick={() => state.set({ notifyApps: s.notifyApps.filter((x) => x.id !== a.id) })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!appName.trim() || !appId.trim()) return;
          state.set({ notifyApps: [...s.notifyApps.filter((a) => a.id !== appId.trim()), { id: appId.trim(), name: appName.trim() }] });
          setAppName("");
          setAppId("");
        }}
      >
        <input id="n-app-name" class="grow" placeholder="App name" aria-label="App name" value={appName} onInput={(e) => setAppName((e.target as HTMLInputElement).value)} />
        <input id="n-app-id" class="grow" placeholder="Bundle or package id" aria-label="Bundle or package id" value={appId} onInput={(e) => setAppId((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit">Add app</button>
      </form>
      <div class="row">
        <button class="btn primary" disabled={!connected} onClick={run("Saving", async () => { await state.applyNotifications(); state.say("Notification settings sent to the glasses."); })}>Send to the glasses</button>
        <button class="btn" disabled={!connected} onClick={run("Sending", () => state.g1.notifications.notify({ appName: "OpenG1", title: "Test notification", message: "If you can read this, notifications reach your glasses." }))}>Send a test</button>
      </div>
    </Card>
  );
}

export function SettingsScreen() {
  const state = useApp();
  const s = state.settings;
  const d = state.device;
  const connected = !!state.conn.g1;
  const dev = (label: string, patch: Parameters<typeof state.setDevice>[0]) => void state.attempt(label, () => state.setDevice(patch));
  return (
    <>
      <Card title="Glasses">
        {!connected && <p class="hint">Connect to change these: they are stored on the glasses.</p>}
        <Toggle id="auto-brightness" label="Automatic brightness" hint="Follow the light sensor" checked={d?.autoBrightness ?? false} disabled={!connected} onChange={(v) => dev("Saving", { autoBrightness: v })} />
        <Toggle id="silent" label="Silent mode" hint="No display and no sounds until you turn it off" checked={d?.silent ?? false} disabled={!connected} onChange={(v) => dev("Saving", { silent: v })} />
        <Toggle id="wear" label="Wear detection" hint="Sleep when you take them off" checked={d?.wearDetection ?? true} disabled={!connected} onChange={(v) => dev("Saving", { wearDetection: v })} />
        <label class="slider" for="headup">
          <span class="label">Look-up angle</span>
          <input id="headup" type="range" min={0} max={60} value={d?.headupAngle ?? 30} disabled={!connected} onChange={(e) => dev("Saving", { headupAngle: Number((e.target as HTMLInputElement).value) })} />
          <output>{d?.headupAngle ?? 30}°</output>
        </label>
      </Card>

      <Card title="Your fit">
        <p class="hint">Depending on how the glasses sit, some rows at the top or bottom of the display are out of sight. Show the ruler, read the first and last number you can see, and enter how many rows are hidden.</p>
        <div class="row">
          <NumberField id="hidden-top" label="Hidden at the top" value={s.hiddenTop} min={0} max={100} onChange={(v) => state.set({ hiddenTop: v })} />
          <NumberField id="hidden-bottom" label="Hidden at the bottom" value={s.hiddenBottom} min={0} max={100} onChange={(v) => state.set({ hiddenBottom: v })} />
        </div>
        <div class="row">
          <button class="btn" disabled={!connected} onClick={run("Drawing", () => state.startCalibration())}>Show the ruler</button>
        </div>
      </Card>

      <Notifications />

      <Card title="Navigation">
        <label class="field" for="nav-style">
          On the glasses
          <select id="nav-style" value={s.navStyle} onChange={(e) => state.set({ navStyle: (e.target as HTMLSelectElement).value as "graphic" | "text" })}>
            <option value="graphic">Arrow and speed (drawn)</option>
            <option value="text">Plain text (lighter on the battery)</option>
          </select>
        </label>
        <label class="field" for="routing-url">
          Routing server
          <input id="routing-url" value={s.endpoints.routing} onChange={(e) => state.set({ endpoints: { ...s.endpoints, routing: (e.target as HTMLInputElement).value.trim() || DEFAULT_ENDPOINTS.routing } })} />
        </label>
        <label class="field" for="search-url">
          Search server
          <input id="search-url" value={s.endpoints.search} onChange={(e) => state.set({ endpoints: { ...s.endpoints, search: (e.target as HTMLInputElement).value.trim() || DEFAULT_ENDPOINTS.search } })} />
        </label>
        <p class="hint">Maps and routes come from OpenStreetMap through free public servers meant for personal use. Point these at your own for anything bigger.</p>
      </Card>

      <Card title="AI service">
        <p class="hint">For the assistant and the translator. Any service that speaks the OpenAI chat format, or a local one such as Ollama. The key is kept on this phone only.</p>
        <label class="field" for="ai-endpoint">
          Address
          <input id="ai-endpoint" placeholder="https://…/v1" autocapitalize="off" autocorrect="off" value={s.aiEndpoint} onChange={(e) => state.set({ aiEndpoint: (e.target as HTMLInputElement).value.trim() })} />
        </label>
        <label class="field" for="ai-model">
          Model
          <input id="ai-model" placeholder="model name" autocapitalize="off" autocorrect="off" value={s.aiModel} onChange={(e) => state.set({ aiModel: (e.target as HTMLInputElement).value.trim() })} />
        </label>
        <label class="field" for="ai-key">
          Key
          <input id="ai-key" type="password" placeholder="leave empty for a local server" autocomplete="off" value={s.aiKey} onChange={(e) => state.set({ aiKey: (e.target as HTMLInputElement).value.trim() })} />
        </label>
      </Card>

      <Card title="Appearance">
        <div class="segmented" role="radiogroup" aria-label="Appearance">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={s.theme === t} onClick={() => state.set({ theme: t })}>
              {t === "system" ? "Like the phone" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </Card>

      <Card title="App">
        <Toggle id="auto-sync" label="Set the clock on connection" checked={s.autoSync} onChange={(v) => state.set({ autoSync: v })} />
        <Toggle id="auto-reconnect" label="Reconnect automatically" hint="When the link drops, in the installed app" checked={s.autoReconnect} onChange={(v) => state.set({ autoReconnect: v })} />
        <Toggle id="twelve-hour" label="12-hour clock" checked={s.twelveHour} onChange={(v) => state.set({ twelveHour: v })} />
        <Toggle id="fahrenheit" label="Fahrenheit" checked={s.fahrenheit} onChange={(v) => state.set({ fahrenheit: v })} />
        <label class="field" for="sim-url">
          Simulator address
          <input id="sim-url" placeholder="built in (or ws://192.168.1.20:8765)" value={s.simulatorUrl} onChange={(e) => state.set({ simulatorUrl: (e.target as HTMLInputElement).value.trim() })} />
        </label>
        {connected && (
          <div class="row"><button class="btn danger" onClick={run("Disconnecting", () => state.disconnect())}>Disconnect</button></div>
        )}
      </Card>

      <p class="fine">OpenG1 is an independent, open-source project. Not affiliated with Even Realities. Firmware updates are left to the official app. Map data © OpenStreetMap contributors; weather by Open-Meteo.</p>
    </>
  );
}
