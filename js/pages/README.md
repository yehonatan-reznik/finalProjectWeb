# Page Scripts

This folder contains scripts that match the pages in `html/`.

- `control.js` handles dashboard UI wiring, manual ESP32 control, Firebase sync, and calibration helpers.
- `control-detection.js` handles model loading, object detection, overlay drawing, and telemetry.
- `login.js`, `logs.js`, `manual.js`, and `form.js` contain the lighter per-page behaviors for those pages.

The control page is split across `control.js` and `control-detection.js` so detector logic stays separate from the rest of the dashboard flow.
