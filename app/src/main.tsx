import { render } from "preact";
import { useState } from "preact/hooks";
import { app } from "./app.ts";
import { Apps } from "./ui/apps.tsx";
import { Icon, Notice, useApp } from "./ui/common.tsx";
import { Home } from "./ui/home.tsx";
import { NavigateScreen } from "./ui/navigate.tsx";
import { AssistantScreen, MessageScreen, NotesScreen, TeleprompterScreen, TranslateScreen } from "./ui/screens.tsx";
import { SettingsScreen } from "./ui/settings.tsx";

const TABS = [
  { id: "home", label: "Home", screen: Home },
  { id: "apps", label: "Apps", screen: Apps },
  { id: "settings", label: "Settings", screen: SettingsScreen },
] as const;

const SCREENS = {
  navigate: NavigateScreen,
  teleprompter: TeleprompterScreen,
  notes: NotesScreen,
  assistant: AssistantScreen,
  translate: TranslateScreen,
  message: MessageScreen,
};

function Shell() {
  const state = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("home");
  if (state.screen) {
    const Feature = SCREENS[state.screen];
    return <Feature />;
  }
  const current = TABS.find((t) => t.id === tab)!;
  const Tab = current.screen;
  const conn = state.conn;
  return (
    <>
      <header class="bar">
        <h1 class="brand">{tab === "home" ? "OpenG1" : current.label}</h1>
        <span class={`pill ${conn.state === "connected" ? "on" : ""}`}>
          {conn.state === "connected" ? (conn.kind === "simulator" ? "Simulator" : "Connected") : conn.state === "idle" ? "Offline" : "Connecting"}
        </span>
      </header>
      <main>
        <Notice />
        <Tab />
      </main>
      <nav class="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            <Icon name={t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

render(<Shell />, document.getElementById("root")!);

// Handy when poking at the app from a browser console.
(window as unknown as { openg1App: typeof app }).openg1App = app;
