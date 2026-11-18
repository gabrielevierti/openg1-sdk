"""The hub from Python, with nothing but the standard library.

    npx openg1 hub            # in one terminal
    python3 examples/hub/hub_client.py

This is the HTTP route, for scripts in any language. For a Python program that
talks the BLE protocol itself, use the SDK in ../../python instead.
"""
import json
import urllib.request

HUB = "http://127.0.0.1:8765"


def call(method: str, **params):
    """POST /v1/<method> and return the result, raising on an error reply."""
    request = urllib.request.Request(
        f"{HUB}/v1/{method.replace('.', '/')}",
        data=json.dumps(params).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)["result"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(json.load(error)["error"]["message"]) from None


def events():
    """Yield events from the hub's server-sent event stream."""
    with urllib.request.urlopen(f"{HUB}/v1/events") as stream:
        for line in stream:
            if line.startswith(b"data: "):
                yield json.loads(line[6:])


if __name__ == "__main__":
    call("display.text", text="ciao from Python")
    print("battery:", call("info.battery"))
    call(
        "display.draw",
        ops=[
            {"op": "text", "text": "21°", "x": 288, "y": 20, "font": "xl", "align": "center"},
            {"op": "text", "text": "Milano", "x": 288, "y": 100, "font": "md", "align": "center"},
        ],
    )
    print("waiting for gestures (tap a touch bar in the simulator)…")
    for event in events():
        print(event["type"], event.get("gesture", ""), event["arm"])
        if event["type"] == "touch" and event["gesture"] == "double_tap":
            call("display.clear")
            break
