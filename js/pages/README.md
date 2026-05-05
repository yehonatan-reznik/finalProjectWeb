# Page Scripts

This folder contains scripts that match the pages in `html/`.

- `control/` contains the split control-page runtime in dependency order.
- `control/00-core.js` through `control/40-init.js` cover dashboard wiring, manual ESP32 control, Firebase sync, and calibration helpers.
- `control/50-detection-state-settings.js` through `control/100-follow-automation.js` cover detection, overlay drawing, telemetry, and optional auto-follow.
- `login.js`, `logs.js`, `manual.js`, and `form.js` contain the lighter per-page behaviors for those pages.

The control page is intentionally split into smaller files so page coordination, detection, and follow automation can evolve independently.
