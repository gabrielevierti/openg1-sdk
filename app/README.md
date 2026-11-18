# OpenG1 app

A companion app for the G1, for iPhone and Android from one codebase: a web app built on the OpenG1 SDK, wrapped as a native app with [Capacitor](https://capacitorjs.com).

| | |
| --- | --- |
| **Home** | Connect, a clock/weather/battery panel you can put on the glasses, a live preview of the display, and the features below. |
| **Navigate** | Its own navigator: search, routes for car, motorbike, bike and walking, alternative routes to choose from, avoiding tolls, motorways or ferries, a route overview, speed against the limit, arrival time, automatic rerouting. |
| **Teleprompt** | Paging by tap or timer, a preview of every page on the phone, and "continue from page N" for a text you already started. |
| **Assistant, Translate** | Typed or dictated on the phone, answered on the glasses, through an AI service you configure yourself (any OpenAI-compatible one, or a local server). |
| **Notes, Quick text** | Kept on the phone, shown when you ask. |
| **Apps** | Mini-apps that take turns on the glasses: clock, timer, counter, status. |
| **Settings** | Silent mode, wear detection, look-up angle, the rows you cannot see (with a ruler to measure them), notification filters, light or dark appearance. |

## Try it without building anything

```sh
cd app
npm install
npm run dev          # http://localhost:5173
```

Tap **Use the simulator**: an emulated pair runs inside the app, with stand-ins for the touch bars. On the Navigate tab, **Load the demo route** and **Simulate the drive** show navigation with no network and no GPS.

In Chrome on Android or a computer the same page reaches real glasses over Web Bluetooth (you choose each arm in turn). `npm run build` writes the whole app to `www/index.html`, one file you can host anywhere over https.

## Build the native apps

You need a Mac with Xcode for iPhone, and Android Studio for Android. From `app/`:

```sh
npm install
npm run build
npx cap add ios          # once: creates ios/
npx cap add android      # once: creates android/
npm run ios              # build, sync, open Xcode
npm run android          # build, sync, open Android Studio
```

Then declare what the app uses.

**iPhone** — in `ios/App/App/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>OpenG1 connects to your glasses over Bluetooth.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>OpenG1 uses your location to navigate and to show the weather.</string>
```

**Android** — in `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

Run it on a phone from Xcode or Android Studio. With a free Apple ID an iPhone build lasts seven days before it needs re-signing; a developer account removes that.

## What has and has not been tested

- **Tested**: the whole app in a browser against its built-in simulator — connection, quick message, the demo drive from start to arrival, teleprompter paging and resuming, the assistant and translator against a stand-in service, the mini-app launcher, settings round-trips, notifications. The navigation maths has unit tests (`npm test`). Capacitor generates the Android project from this configuration.
- **Not tested**: the native builds have never been compiled or run, and nothing here has talked to real glasses. Search, routing and weather were written against the services' documented formats and tested with stand-in responses, not live calls. Expect a first session of fixing small things on a real phone.

## Things to know

- **Navigation cannot be called perfect from here.** The route following, rerouting and screens are tested against a simulated drive; nobody has driven with it yet, and the live map services were not reachable from where this was built. Motorbikes use car routing. "Avoid" depends on the routing server supporting it and falls back to the plain route when it does not.
- **Navigation is the app's own.** iOS does not let an app read directions from Google Maps, Apple Maps or Waze, so the app routes with OpenStreetMap data instead: Nominatim for search and the FOSSGIS OSRM servers for routes and speed limits. Both are free public services meant for personal use; the addresses are settings so you can point them at your own. Speed limits appear where the map has them.
- **Keep the app open while navigating.** A locked phone suspends a web-based app, and the glasses stop updating. A background mode needs a native plugin and is not in this version.
- **Notifications.** Once the glasses are paired in the phone's Bluetooth settings they receive notifications themselves; the app sets which kinds get through and can send a test. Forwarding arbitrary Android notifications needs a native listener service, also not in this version.
- **A frame takes about a second** to reach both arms. The navigator sends the newest screen whenever the last one has landed and skips the rest; "Plain text" in Settings is lighter still.
- **The assistant and translator need a service of yours.** Nothing is preconfigured. Enter an address, model and key under Settings → AI service; the key is stored on the phone in plain app storage. Speaking to the glasses is not supported: their microphone sends LC3 audio the SDK cannot decode yet, so questions are typed or dictated with the phone's keyboard.
- **The route overview is a line, not a map.** It shows the shape of the route and where you are on it, with no map tiles behind it.
- **Firmware updates** are left to the official app.

## Adding a mini-app

A mini-app is an ordinary `App` from the SDK. Write a class in [`src/features/miniapps.ts`](src/features/miniapps.ts) (or import one), add it to `CATALOG`, and it appears in the Apps tab. Develop it first with `npx openg1 sim your-app.ts` from the repository root: what runs there runs here.

## Layout

```text
src/
  app.ts              state and actions the screens observe
  connection.ts       native Bluetooth, Web Bluetooth, or a simulator; reconnection; preview
  activities.ts       one thing owns the display at a time
  nav/                geometry, OSRM routes, the route tracker, a built-in demo route
  features/           navigation, dashboard and weather, teleprompter, mini-apps, position sources
  ui/                 tabs and feature screens (Preact)
test/                 navigation and assistant tests
```
