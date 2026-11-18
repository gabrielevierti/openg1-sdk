#!/bin/sh
# The hub from a shell. Start it first:  npx openg1 hub
# (add --ble to drive real glasses instead of the simulator)
HUB=${HUB:-http://127.0.0.1:8765}
json='content-type: application/json'

curl -s -X POST "$HUB/v1/display/text" -H "$json" -d '{"text":"ciao from curl"}'; echo
curl -s "$HUB/v1/info/battery"; echo

# A custom screen, described as drawing operations.
curl -s -X POST "$HUB/v1/display/draw" -H "$json" -d '{
  "ops": [
    {"op": "text", "text": "87", "x": 288, "y": 12, "font": "xl", "align": "center"},
    {"op": "text", "text": "km/h", "x": 288, "y": 92, "font": "md", "align": "center"},
    {"op": "progress", "x": 138, "y": 122, "width": 300, "height": 10, "value": 0.67}
  ]
}'; echo

# A picture: any PNG, fitted and dithered to the panel.
# curl -s -X POST "$HUB/v1/display/image" -H 'content-type: image/png' --data-binary @photo.png

# Every gesture, as it happens (ctrl-c to stop).
curl -sN "$HUB/v1/events"
