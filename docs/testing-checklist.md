# Detection And Bench-Test Checklist

Use this checklist to prove the demo is behaving as expected before any servo tracking test.

## Camera and stream

- Confirm `http://<camera-ip>/stream` opens directly in a browser
- Confirm `http://<camera-ip>/health` returns valid JSON
- Confirm the control page can load the stream without repeated reconnects
- Record stream resolution, fps, and visible latency

## Detection

- Test on known still images or captured frames from your current camera setup
- Test on recorded clips with a visible air target
- Test small and distant targets
- Test cluttered backgrounds such as trees, roofs, and clouds
- Log false positives on birds, kites, and non-air objects
- Sweep confidence thresholds and record misses vs false alarms

## Coordinate math

- Draw the frame center crosshair
- Draw the detected box center
- Draw the line from frame center to object center
- Log `dx`, `dy`, `normX`, and `normY`
- Check that center values are stable when the target is not moving

## Bench servo test

- Keep the laser disconnected or replace it with an LED
- Confirm controller `/status` and `/config` endpoints respond
- Start with `/center`
- Use the UI calibration probes to test `X+`, `X-`, `Y+`, and `Y-`
- Save the observed `X+` and `Y+` directions in the control page
- Test one axis at a time with small manual nudges
- Verify servo direction matches the UI labels
- Verify motion stays inside the configured angle limits
- Watch for chatter, overshoot, and dropped commands

## Required logs

- Save browser telemetry JSON for each session
- Save controller status snapshots before and after bench tests
- Record camera IP, controller IP, firmware version, and UI profile settings
