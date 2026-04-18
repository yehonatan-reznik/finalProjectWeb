# SkyShield Demo Repo

This repo now contains the full demo project:

- browser UI and local detection logic
- ESP32-CAM streaming firmware
- separate ESP32 servo/laser controller firmware
- local test images and source documents

## Current status

- Detection in the browser is working.
- The control page now shows filtered center offsets and simulated pan/tilt output.
- The control page now also includes manual-assist move hints and servo-calibration tools for bench testing.
- The detector still uses generic COCO-SSD classes, so this remains a demo and not a validated real-drone detector.

## Repo layout

```text
code/
  control.html
  index.html
  logs.html
  manual.html
  form.html
  css/
  js/
    auth.js
    pages/
  object-detection/
  tools/
    camera-proxy.mjs
  firmware/
    README.md
    ai_thinker_cam_http80/
      ai_thinker_cam_http80.ino
      README.md
      secrets.example.h
    skyshield_controller/
      README.md
      skyshield_controller.ino
      secrets.example.h
  test-assets/
    README.md
    images/
  docs/
    README.md
    source-material/
```

## Running the web app

Open `control.html` through a local server such as VS Code Live Server.

If the browser blocks stream access because of CORS, enable proxy mode in the UI and run:

```powershell
node tools/camera-proxy.mjs
```

## Manual assist and calibration

- `Operator Assist` turns the detection offset into manual guidance such as `PAN RIGHT_MED` or `TILT UP_SMALL`.
- `Servo Calibration` lets you send small `X` and `Y` nudges, record what `X+` and `Y+` physically do, and derive which axis is pan vs tilt.
- This remains manual-assist only. No automatic servo motion is generated from live detections.

## Firmware notes

- `firmware/ai_thinker_cam_http80/` is for the AI Thinker ESP32-CAM only.
- `firmware/skyshield_controller/` is for the separate ESP32 that drives servos and laser.
- Copy `secrets.example.h` to `secrets.h` in each firmware folder before compiling.
- `secrets.h` is ignored by Git.
- The controller firmware keeps the current web UI endpoints, adds JSON status/config endpoints, and rate-limits servo writes so bench tests are less noisy.

## Controller endpoints

- `/status`
- `/health`
- `/config`
- `/center`
- `/set?x=90&y=90`
- `/nudge?dx=5&dy=-5`
- legacy manual control endpoints still work for the web UI

## Validation assets

- `test-assets/images/` contains quick still-image checks for the browser detector.
- `docs/source-material/` contains the local project documents moved out of the workspace root.
- `docs/testing-checklist.md` captures the practical verification flow for detection and safe bench testing.
