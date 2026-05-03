# AI Thinker ESP32-CAM

Use this sketch on the AI Thinker ESP32-CAM only.

Endpoints:

- `/`
- `/stream`
- `/capture`
- `/health`

Setup:

1. Copy `secrets.example.h` to `secrets.h`
2. Set Wi-Fi SSID and password
3. Optionally set the Firebase Realtime Database URL and auth token/secret
4. Flash the board
5. Open the printed IP in a browser and confirm `/stream` works before testing the web UI

If Firebase RTDB is configured, the camera publishes `cameraIP` at the root and detailed URLs under `camera/state`.
