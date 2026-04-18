# Firmware

This folder contains the two-board embedded side of the demo.

## `ai_thinker_cam_http80/`

AI Thinker ESP32-CAM firmware.

Features:

- `/stream`
- `/capture`
- `/health`
- browser-friendly CORS headers
- lower-latency JPEG capture settings
- local folder README with setup notes

## `skyshield_controller/`

Separate ESP32 firmware for pan/tilt servos and laser control.

Features:

- manual motion endpoints used by the web UI
- JSON `/status`, `/health`, `/config`
- `/center`, `/set`, `/nudge`
- safe startup with laser off and servos centered
- servo command rate limiting to reduce chatter
- local folder README with wiring and endpoint notes

## Local setup

For each firmware folder:

1. Copy `secrets.example.h` to `secrets.h`
2. Set your Wi-Fi SSID and password
3. Compile and flash

`secrets.h` stays local and is ignored by Git.
