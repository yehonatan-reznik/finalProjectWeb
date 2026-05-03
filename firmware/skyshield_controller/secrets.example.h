#pragma once

#define SKYSHIELD_WIFI_SSID "YOUR_WIFI_SSID"
#define SKYSHIELD_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Optional Firebase Realtime Database sync.
// Database URL example: "https://skyshield-45d5e-default-rtdb.firebaseio.com"
// If your RTDB rules are not public for these paths, set SKYSHIELD_FIREBASE_AUTH
// to an allowed auth token or database secret.
#define SKYSHIELD_FIREBASE_DATABASE_URL ""
#define SKYSHIELD_FIREBASE_AUTH ""
#define SKYSHIELD_FIREBASE_SYNC_INTERVAL_MS 30000UL

// Optional controller tuning.
// Leave these at the defaults unless your pan/tilt rig needs different wiring or limits.
#define SKYSHIELD_SERVO_X_DIR 1
#define SKYSHIELD_SERVO_Y_DIR 1
#define SKYSHIELD_ENABLE_SERVO_OUTPUT 1
#define SKYSHIELD_ENABLE_LASER_OUTPUT 1
