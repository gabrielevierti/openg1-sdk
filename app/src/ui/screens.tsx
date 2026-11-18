import { useState } from "preact/hooks";
import { aiConfigured } from "../features/assistant.ts";
import type { Note } from "../settings.ts";
import { Card, run, Screen, useApp } from "./common.tsx";

export function MessageScreen() {
  const state = useApp();
  const [message, setMessage] = useState("");
  const connected = !!state.conn.g1;
  return (
    <Screen title="Quick text">
      <Card>
        <form class="stack" onSubmit={(e) => { e.preventDefault(); if (message.trim()) void state.attempt("Sending", () => state.sendText(message.trim())); }}>
          <textarea id="quick-message" rows={3} placeholder="Text to show on the glasses" aria-label="Message" value={message} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
          <div class="row">
            <button class="btn primary grow" type="submit" disabled={!connected || !message.trim()}>Show</button>
            <button class="btn" type="button" disabled={!connected} onClick={run("Clearing", async () => { await state.stop(); await state.g1.display.clear(); })}>Clear the display</button>
          </div>
        </form>
        {!connected && <p class="hint">Connect the glasses on the Home tab first.</p>}
      </Card>
    </Screen>
  );
}

function Pager() {
  const state = useApp();
  const control = state.teleprompter!;
  return (
    <>
      <Card>
        <p class="lead">Page {control.page + 1} <span class="soft">of {control.pages}</span></p>
        <div class="row">
          <button class="btn grow" disabled={control.page === 0} onClick={() => control.go(-1)}>Back</button>
          <button class="btn primary grow" disabled={control.page >= control.pages - 1} onClick={() => control.go(1)}>Next</button>
          <button class="btn" onClick={run("Stopping", () => state.stop())}>Stop</button>
        </div>
        <p class="hint">On the glasses: right tap forward, left tap back, double tap to the start.</p>
      </Card>
      <ol class="pages">
        {control.texts.map((text, i) => (
          <li key={i} class={i === control.page ? "current" : i < control.page ? "read" : ""}>
            <button onClick={() => control.go(i - control.page)}>{text}</button>
          </li>
        ))}
      </ol>
    </>
  );
}

export function TeleprompterScreen() {
  const state = useApp();
  const connected = !!state.conn.g1;
  const text = state.settings.teleprompterText;
  const running = state.activities.current?.id === "teleprompter" && state.teleprompter;
  const last = state.lastPage(text);
  return (
    <Screen title="Teleprompt">
      {running ? <Pager /> : (
        <Card>
          <textarea id="teleprompter-text" rows={9} placeholder="Paste a speech, a recipe, a checklist…" aria-label="Text to read" value={text}
            onInput={(e) => state.set({ teleprompterText: (e.target as HTMLTextAreaElement).value })} />
          <label class="field" for="teleprompter-auto">
            Turn pages
            <select id="teleprompter-auto" value={String(state.settings.teleprompterAutoS)} onChange={(e) => state.set({ teleprompterAutoS: Number((e.target as HTMLSelectElement).value) })}>
              <option value="0">with taps only</option>
              <option value="5">every 5 seconds</option>
              <option value="8">every 8 seconds</option>
              <option value="12">every 12 seconds</option>
              <option value="20">every 20 seconds</option>
            </select>
          </label>
          <div class="row">
            <button class="btn primary grow" disabled={!connected || !text.trim()} onClick={run("Starting", () => state.startTeleprompter("Teleprompter", text))}>Start</button>
            {last > 0 && text.trim() && (
              <button class="btn grow" disabled={!connected} onClick={run("Starting", () => state.startTeleprompter("Teleprompter", text, true))}>Continue from page {last + 1}</button>
            )}
          </div>
          {!connected && <p class="hint">Connect the glasses on the Home tab first.</p>}
        </Card>
      )}
    </Screen>
  );
}

export function NotesScreen() {
  const state = useApp();
  const [editing, setEditing] = useState<Note | null>(null);
  const notes = state.settings.notes;
  const connected = !!state.conn.g1;
  const save = (note: Note) => {
    const rest = notes.filter((n) => n.id !== note.id);
    state.set({ notes: note.title.trim() || note.body.trim() ? [note, ...rest] : rest });
    setEditing(null);
  };
  return (
    <Screen title="Notes">
      {editing ? (
        <Card>
          <input id="note-title" placeholder="Title" aria-label="Title" value={editing.title} onInput={(e) => setEditing({ ...editing, title: (e.target as HTMLInputElement).value })} />
          <textarea id="note-body" rows={6} placeholder="What you want in front of your eyes" aria-label="Note" value={editing.body} onInput={(e) => setEditing({ ...editing, body: (e.target as HTMLTextAreaElement).value })} />
          <div class="row">
            <button class="btn primary grow" onClick={() => save(editing)}>Save</button>
            <button class="btn" onClick={() => setEditing(null)}>Cancel</button>
            {notes.some((n) => n.id === editing.id) && (
              <button class="btn danger" onClick={() => { state.set({ notes: notes.filter((n) => n.id !== editing.id) }); setEditing(null); }}>Delete</button>
            )}
          </div>
        </Card>
      ) : (
        <>
          <button class="btn primary" id="new-note" onClick={() => setEditing({ id: String(Date.now()), title: "", body: "" })}>New note</button>
          {!notes.length && <p class="hint pad">Shopping lists, door codes, the three points of your talk. Kept on this phone; shown on the glasses when you ask.</p>}
          <ul class="list">
            {notes.map((n) => (
              <li key={n.id}>
                <button class="grow" onClick={() => setEditing(n)}><span class="label">{n.title || "Untitled"}</span><span class="hint">{n.body.slice(0, 80)}</span></button>
                <button class="btn small" disabled={!connected} onClick={run("Showing", () => state.startTeleprompter(n.title || "Note", n.body || n.title))}>Show</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}

function NeedsAi() {
  const state = useApp();
  return (
    <Card>
      <p class="lead">Bring your own AI</p>
      <p class="hint">The assistant and the translator use a service you choose: any that speaks the OpenAI chat format, including one running on your own computer. Enter its address and model in Settings.</p>
      <div class="row"><button class="btn primary" onClick={() => { state.open(null); state.say("Open the Settings tab and fill in “AI service”."); }}>Got it</button></div>
    </Card>
  );
}

export function AssistantScreen() {
  const state = useApp();
  const [question, setQuestion] = useState("");
  const send = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    void state.attempt("Thinking", () => state.askAssistant(q));
  };
  return (
    <Screen title="Assistant">
      {!aiConfigured(state.ai) ? <NeedsAi /> : (
        <>
          <div class="chat">
            {!state.chat.length && <p class="hint pad">Type a question, or dictate it with the keyboard's microphone. The answer appears here and on the glasses.</p>}
            {state.chat.map((m, i) => <p key={i} class={`bubble ${m.role}`}>{m.content}</p>)}
          </div>
          <form class="row ask" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input id="ask" class="grow" placeholder="Ask anything" aria-label="Question" value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
            <button class="btn primary" type="submit" disabled={!question.trim() || !!state.busy}>Ask</button>
          </form>
          {state.chat.length > 0 && <button class="btn small" onClick={() => { state.chat = []; state.changed(); }}>New conversation</button>}
        </>
      )}
    </Screen>
  );
}

const LANGUAGES = ["English", "Italian", "Spanish", "French", "German", "Portuguese", "Arabic", "Chinese", "Japanese"];

export function TranslateScreen() {
  const state = useApp();
  const [text, setText] = useState("");
  return (
    <Screen title="Translate">
      {!aiConfigured(state.ai) ? <NeedsAi /> : (
        <>
          <Card>
            <textarea id="translate-text" rows={4} placeholder="Type or dictate what you want translated" aria-label="Text to translate" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
            <label class="field" for="translate-to">
              Into
              <select id="translate-to" value={state.settings.translateTo} onChange={(e) => state.set({ translateTo: (e.target as HTMLSelectElement).value })}>
                {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <div class="row"><button class="btn primary grow" disabled={!text.trim() || !!state.busy} onClick={run("Translating", () => state.translateText(text.trim()))}>Translate</button></div>
          </Card>
          {state.translation && (
            <Card>
              <p class="hint">{state.translation.source}</p>
              <p class="lead">{state.translation.result}</p>
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
