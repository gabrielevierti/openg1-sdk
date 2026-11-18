import { useState } from "preact/hooks";
import { describeStep } from "../app.ts";
import type { Place, Profile } from "../nav/route.ts";
import { Card, DotText, duration, km, Preview, RouteMap, run, Screen, useApp } from "./common.tsx";

const PROFILES: { id: Profile; label: string }[] = [
  { id: "car", label: "Car" },
  { id: "moto", label: "Moto" },
  { id: "bike", label: "Bike" },
  { id: "foot", label: "Walk" },
];

const arrival = (seconds: number) => new Date(Date.now() + seconds * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function Active() {
  const state = useApp();
  const nav = state.nav!;
  const step = nav.step;
  const left = nav.progress ? nav.progress.etaS : nav.route.durationS;
  // What comes after the next manoeuvre, when it follows closely enough to matter.
  const following = nav.progress ? nav.route.steps[nav.progress.stepIndex + 1] : undefined;
  const then = following && nav.progress && following.atM - nav.route.steps[nav.progress.stepIndex]!.atM < 400 ? following : null;
  const over = step?.speedKmh !== undefined && step.speedLimitKmh !== undefined && step.speedKmh > step.speedLimitKmh;
  return (
    <>
      <Card title="Next" aside={<button class="btn small" onClick={run("Stopping", () => state.stop())}>End</button>}>
        {step ? (
          <>
            {step.distanceM ? <DotText text={km(step.distanceM)} font="lg" dot={2} /> : <p class="lead">Now</p>}
            <p class="label">{describeStep(step)}{step.road ? ` · ${step.road}` : ""}</p>
          </>
        ) : (
          <p class="hint">{state.activities.status || "Waiting for a location fix…"}</p>
        )}
        {state.activities.status && step && <p class="hint">{state.activities.status}</p>}
      </Card>
      {then && <p class="then">Then {describeStep(then).toLowerCase()}{then.road ? ` · ${then.road}` : ""}</p>}
      <div class="stats four card">
        <div><span class={`stat ${over ? "over" : ""}`}>{step?.speedKmh ?? "–"}</span><span class="hint">km/h{step?.speedLimitKmh ? ` · limit ${step.speedLimitKmh}` : ""}</span></div>
        <div><span class="stat">{arrival(left)}</span><span class="hint">Arrival</span></div>
        <div><span class="stat">{nav.progress ? km(nav.progress.remainingM) : km(nav.route.distanceM)}</span><span class="hint">To go</span></div>
        <div><span class="stat">{duration(left)}</span><span class="hint">Time left</span></div>
      </div>
      <RouteMap route={nav.route} alongM={nav.progress?.alongM ?? 0} />
      <Preview />
      <p class="fine">Keep the app open and the phone awake while navigating: a phone that locks pauses the app, and the glasses stop updating.</p>
    </>
  );
}

function Planned() {
  const state = useApp();
  const planned = state.planned!;
  const connected = !!state.conn.g1;
  return (
    <Card title={planned.destination.name} aside={<button class="btn small" onClick={() => { state.planned = null; state.changed(); }}>Change</button>}>
      <p class="hint">{planned.destination.detail}</p>
      {planned.options.length > 1 && (
        <div class="segmented" role="radiogroup" aria-label="Route">
          {planned.options.map((r, i) => (
            <button key={i} role="radio" aria-checked={r === planned.route} onClick={() => state.chooseRoute(i)}>
              {duration(r.durationS)} · {km(r.distanceM)}
            </button>
          ))}
        </div>
      )}
      <div class="stats">
        <div><span class="stat">{km(planned.route.distanceM)}</span><span class="hint">Distance</span></div>
        <div><span class="stat">{duration(planned.route.durationS)}</span><span class="hint">Time</span></div>
        <div><span class="stat">{arrival(planned.route.durationS)}</span><span class="hint">Arrival</span></div>
      </div>
      <div class="row">
        {!planned.demo && (
          <button class="btn primary" disabled={!connected} onClick={run("Starting", () => state.startNavigation(false))}>Start</button>
        )}
        <button class={`btn ${planned.demo ? "primary" : ""}`} disabled={!connected} onClick={run("Starting", () => state.startNavigation(true))}>
          Simulate the drive
        </button>
      </div>
      {!connected && <p class="hint">Connect the glasses (or the simulator) on the Home tab to start.</p>}
      <RouteMap route={planned.route} />
      <ol class="steps">
        {planned.route.steps.map((s, i) => (
          <li key={i}>
            <span class="at">{km(s.atM)}</span>
            <span>{describeStep(s)}{s.road ? ` · ${s.road}` : ""}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Search() {
  const state = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const choose = (place: Place) => void state.attempt("Finding a route", () => state.plan(place));
  return (
    <>
      <Card title="Where to?">
        <div class="segmented" role="radiogroup" aria-label="Way of travelling">
          {PROFILES.map((p) => (
            <button key={p.id} role="radio" aria-checked={state.settings.profile === p.id} onClick={() => state.set({ profile: p.id })}>{p.label}</button>
          ))}
        </div>
        {(state.settings.profile === "car" || state.settings.profile === "moto") && (
          <label class="field" for="avoid">
            Avoid
            <select id="avoid" value={state.settings.avoid} onChange={(e) => state.set({ avoid: (e.target as HTMLSelectElement).value as "none" })}>
              <option value="none">nothing</option>
              <option value="toll">toll roads</option>
              <option value="motorway">motorways</option>
              <option value="ferry">ferries</option>
            </select>
          </label>
        )}
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) void state.attempt("Searching", async () => setResults(await state.search(query.trim())));
          }}
        >
          <input id="destination" class="grow" type="search" placeholder="Address or place" aria-label="Destination" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <button class="btn primary" type="submit" disabled={!query.trim()}>Search</button>
        </form>
        {results && !results.length && <p class="hint">Nothing found for "{query}". Try adding the city.</p>}
        {results && results.length > 0 && (
          <ul class="places">
            {results.map((p, i) => (
              <li key={i}><button onClick={() => choose(p)}><span class="label">{p.name}</span><span class="hint">{p.detail}</span></button></li>
            ))}
          </ul>
        )}
      </Card>
      {state.settings.recentPlaces.length > 0 && (
        <Card title="Recent">
          <ul class="places">
            {state.settings.recentPlaces.map((p, i) => (
              <li key={i}><button onClick={() => choose(p)}><span class="label">{p.name}</span><span class="hint">{p.detail}</span></button></li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="No signal, no GPS?">
        <p class="hint">A short built-in route shows what navigation looks like on the glasses, without a network or a location.</p>
        <div class="row"><button class="btn" id="demo-route" onClick={() => state.planDemo()}>Load the demo route</button></div>
      </Card>
    </>
  );
}

export function NavigateScreen() {
  const state = useApp();
  const body = state.nav && state.activities.current?.id === "navigation" ? <Active /> : state.planned ? <Planned /> : <Search />;
  return <Screen title="Navigate">{body}</Screen>;
}
