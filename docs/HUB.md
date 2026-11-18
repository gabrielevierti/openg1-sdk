# The hub

The SDK as a JSON API. One process holds the connection — to a simulator, or to real glasses — and anything that can make an HTTP request can use it.

```sh
npx openg1 hub                         # with its own simulator; the page at / shows the result
npx openg1 hub --ble                   # with real glasses (npm install @stoprocent/noble)
npx openg1 hub --host 0.0.0.0 --token s3cret     # reachable from other devices; then a token is a good idea
```

By default the hub listens on 127.0.0.1 only and sends no CORS headers. `--host 0.0.0.0` exposes it to your network; `--cors` lets web pages on other origins call it; `--token` requires `Authorization: Bearer <token>` (or `?token=`).

## Calling it

`POST /v1/<namespace>/<method>` with a JSON object. Reads also work as `GET`.

```sh
curl -X POST localhost:8765/v1/display/text -H 'content-type: application/json' -d '{"text":"ciao"}'
# → {"ok":true,"result":{}}

curl localhost:8765/v1/info/battery
# → {"ok":true,"result":{"left":87,"right":87,"lowest":87}}
```

Errors come back as `{"ok":false,"error":{"name":…,"message":…}}` with a status that says whose problem it is: `400` the request, `503` the glasses are not connected, `504` an arm did not answer, `502` the glasses refused.

`GET /v1` lists the methods.

## Methods

| Method | Parameters |
| --- | --- |
| `status` | — |
| `display.text` | `text`, `pageDelayMs?` |
| `display.page` | `text`, `page?`, `maxPage?` — one screen you laid out yourself |
| `display.clear` | — |
| `display.draw` | `ops` (below), `crcDelayMs?`, `paceMs?` |
| `display.image` | `png` or `bmp` as base64, or the image as the raw request body; `fit?`, `dither?`, `threshold?`, `invert?` |
| `display.brightness` | `level` 0–42, `auto?` |
| `display.getBrightness` | — |
| `display.safeArea` | `top`, `bottom?` — rows you cannot see |
| `info.battery`, `info.firmware`, `info.uptime`, `info.serial` | — |
| `settings.silentMode` | `enabled` |
| `settings.headupAngle` | `degrees` 0–60 |
| `settings.wearDetection` | `enabled` |
| `settings.get` | — |
| `dashboard.setTime` | `epochMs?`, `twelveHour?` |
| `dashboard.setWeather` | `icon?`, `temperatureC?`, `fahrenheit?`, `twelveHour?` |
| `notifications.notify` | `title`, `message?`, `subtitle?`, `appName?`, `appId?` |
| `notifications.clear` | — |
| `navigation.update` | `maneuver`, `distanceM?`, `road?`, `remainingM?`, `etaS?`, `speedKmh?`, `speedLimitKmh?` |
| `navigation.stop` | — |
| `audio.start` | — |
| `audio.stop` | — returns `packets`, `seconds`, and the capture as a base64 `.lc3` file |
| `raw.send` | `command` (a name from the spec), `hex?`, `target?` — returns each arm's reply as hex |
| `raw.write` | `arm`, `hex` — arbitrary bytes, no reply awaited |

Maneuvers: `continue`, `turn_left`, `turn_right`, `slight_left`, `slight_right`, `sharp_left`, `sharp_right`, `u_turn`, `roundabout`, `merge`, `exit_left`, `exit_right`, `arrive`.

## Drawing

A screen is a list of operations on a 576×136 canvas, origin top-left. Later operations draw over earlier ones; `"on": false` erases.

```json
{ "ops": [
  { "op": "text", "text": "87", "x": 288, "y": 12, "font": "xl", "align": "center" },
  { "op": "text", "text": "km/h", "x": 288, "y": 92, "font": "md", "align": "center" },
  { "op": "progress", "x": 138, "y": 122, "width": 300, "height": 10, "value": 0.67 }
] }
```

| `op` | Fields |
| --- | --- |
| `text` | `text`, `x`, `y`, `font?`, `align?` (`left` `center` `right`), `baseline?` (`top` `middle` `alphabetic`), `scale?`, `maxWidth?` |
| `textBox` | `text`, `x`, `y`, `width`, `height`, `font?`, `align?`, `valign?`, `maxLines?` — word-wrapped |
| `line` | `x0`, `y0`, `x1`, `y1`, `lineWidth?` |
| `rect` | `x`, `y`, `width`, `height`, `fill?`, `radius?`, `lineWidth?` |
| `circle` | `x`, `y`, `r`, `fill?`, `lineWidth?` |
| `arc` | `x`, `y`, `r`, `start`, `end` (degrees, clockwise, 0 is up), `lineWidth?` |
| `polygon` | `points` (`[[x, y], …]`), `fill?`, `lineWidth?` |
| `progress` | `x`, `y`, `width`, `height`, `value` 0–1 |
| `arrow` | `x`, `y`, `size`, `angle?` (0 is straight ahead, 90 right, −90 left) |
| `battery` | `x`, `y`, `level` 0–100 |
| `invert` | `x`, `y`, `width`, `height` |

Fonts: `sm` 14 px, `md` 21 px, `fw` 21 px condensed, `lg` 36 px bold, `xl` 64 px bold (digits, `:.,-+%°/` and `kmh` only).

`GET /v1/status` returns `safeArea` (`[hiddenTop, hiddenBottom]`): keep your layout between those rows.

## Events

Two ways to hear what the wearer does.

**Server-sent events**, `GET /v1/events` — one JSON object per `data:` line. Works with `curl -N` and with any HTTP client that streams.

```text
data: {"type":"touch","arm":"right","raw":"f501","gesture":"single_tap","subcode":1}
data: {"type":"head","arm":"right","raw":"f502","up":true}
```

**WebSocket**, `ws://…/v1/events` — events arrive as `{"event":{…}}`, and the same socket takes calls:

```json
→ {"id": 1, "method": "display.text", "params": {"text": "ciao"}}
← {"id": 1, "ok": true, "result": {}}
```

Event types: `touch` (`gesture`: `single_tap`, `double_tap`, `triple_tap`, `hold_start`, `hold_end`), `head` (`up`), `wear` (`worn`), `battery` (`percent`), `charging`, `case`, `dashboard`, `ai-request`, `ai-stop`, `audio`, `disconnect`, `unknown`. Byte fields are hex strings.

## From Swift

Nothing to link: `URLSession` is enough. A sketch, not compiled as part of this repository:

```swift
struct Hub {
    var base = URL(string: "http://192.168.1.20:8765")!

    func call(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent("v1/" + method.replacingOccurrences(of: ".", with: "/")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: params)
        let (data, _) = try await URLSession.shared.data(for: request)
        let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard reply["ok"] as? Bool == true else {
            let message = (reply["error"] as? [String: Any])?["message"] as? String ?? "hub error"
            throw NSError(domain: "openg1", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return reply["result"] as? [String: Any] ?? [:]
    }
}

// try await Hub().call("display.text", ["text": "ciao"])
```

The hub has to run somewhere that holds the Bluetooth link — a computer with `--ble`, or a simulator. An iPhone app that should talk to the glasses directly, with no computer involved, needs one of the routes in [`PLATFORMS.md`](PLATFORMS.md#iphone).

Shell and Python clients: [`examples/hub/`](../examples/hub/).
