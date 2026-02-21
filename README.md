# SkyShield Web App

This folder contains the operator web UI and browser-side logic.

## Structure

```text
code/
  control.html              # Main control page (camera, detection, turret controls)
  index.html                # Login page
  form.html                 # Mission form page
  logs.html                 # Logs page
  manual.html               # Operator manual page
  css/
    style.css               # Shared styling
  js/
    auth.js                 # Shared auth/session logic
    pages/
      control.js            # Main control page logic
      login.js              # Login page logic
      form.js               # Form page logic
      logs.js               # Logs page logic
      manual.js             # Manual page logic
  object-detection/
    index.html              # Standalone detection test page
    detect.js               # Standalone detection logic
  tools/
    camera-proxy.mjs        # Local CORS proxy for ESP32-CAM streams
```

## Dev Notes

- Open `control.html` through a local server (for example VS Code Live Server).
- If ESP32-CAM stream blocks detection due to CORS, enable proxy in Control page and run:

```powershell
node code/tools/camera-proxy.mjs
```

- Page scripts were moved to `js/pages/` to keep shared vs page-specific code separated.

