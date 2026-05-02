# SkyShield Demo Repo

This repo contains the current browser-based ground control demo:

- live ESP32-CAM streaming in the browser
- local AeroYOLO ONNX detection on the operator PC
- separate ESP32 controller firmware for servos and laser
- bench-test assets, docs, and reference material

## Current status

- Detection in the browser is working with `AeroYOLO` as the default backend.
- `COCO-SSD` remains available as a generic fallback inside the Detection Lab.
- The control page shows target center, filtered offsets, manual move hints, and session telemetry.
- Stream handling is direct browser-to-camera HTTP with no local proxy in the standard setup.

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
  models/
    aeroyolo.onnx
  object-detection/
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

The current ESP32-CAM firmware already sends browser-friendly CORS headers, so the expected path is direct streaming from the browser without a local proxy layer.

## Detection and operator assist

- `AeroYOLO` is the default browser detector for `aircraft`, `drone`, and `helicopter`.
- `Operator Assist` turns the target offset into manual guidance such as `LEFT`, `RIGHT`, `UP`, or `DOWN`.
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
