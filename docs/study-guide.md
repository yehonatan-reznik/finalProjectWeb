# SkyShield Study Guide

This guide is written to help you study the project for a test or oral explanation. It focuses mainly on `code/js/pages/control.js`, then explains the HTML page structure, the auth layer, and both ESP32 firmware sketches.

The project is a browser-based ground control station for an ESP32 camera and a separate ESP32 servo/laser controller. The browser runs the AI detection locally, overlays boxes on the live stream, provides manual movement hints, and sends direct HTTP commands to the controller board. Firebase is used for authentication and for lightweight device discovery and state/config sync.

## 1. High-Level Architecture

There are four main parts:

1. The browser UI
   - Main page: `control.html`
   - Main logic: `js/pages/control.js`
   - Auth wrapper: `js/auth.js`
   - Login page logic: `js/pages/login.js`

2. The ESP32-CAM firmware
   - `firmware/ai_thinker_cam_http80/ai_thinker_cam_http80.ino`
   - Streams MJPEG video over HTTP.

3. The ESP32 controller firmware
   - `firmware/skyshield_controller/skyshield_controller.ino`
   - Controls two servos and a laser output over HTTP.

4. Firebase
   - Firebase Auth for login
   - Firebase Realtime Database for boot configuration and state sharing

The most important design point is this:

- Detection runs locally in the browser, not in the cloud.
- Manual servo commands are sent directly from browser to ESP32 over HTTP.
- Firebase is not used for every movement command. It is mainly used for:
  - boot-time configuration
  - publishing device IP/state
  - letting the website auto-discover URLs

That architecture is intentional because direct local HTTP control is much faster than routing movement through Firebase.

## 2. Main Data Flow

### Browser detection flow

1. User opens `control.html`.
2. Browser loads the camera stream.
3. Browser loads a model:
   - default: `AeroYOLO` ONNX model
   - fallback option: `COCO-SSD`
4. Browser runs detection on frames locally.
5. Browser draws bounding boxes and reticle overlays.
6. Browser calculates target center and manual guidance hints like `LEFT`, `RIGHT`, `UP`, `DOWN`.

### Manual control flow

1. User clicks direction buttons.
2. `control.js` sends HTTP requests like `/step_left` or `/servo_up`.
3. Controller ESP receives the request.
4. Controller updates servo angle and returns JSON.

### Firebase flow

1. On boot, the controller reads `homeX` and `homeY` from RTDB.
2. On boot, the controller writes its IP and state to RTDB.
3. On boot, the camera writes its IP and stream URLs to RTDB.
4. After login, the website listens to RTDB.
5. If local browser storage does not already contain IPs, the page auto-fills camera/controller URLs from Firebase.

## 3. `control.html` Explained

`control.html` is the main operator interface. It is only structure and markup; the dynamic behavior is in `control.js`.

### 3.1 Main layout

The page is split into:

- Left side:
  - live camera feed
  - overlay canvas for target boxes and reticle

- Right side:
  - ESP32 control address input
  - movement buttons
  - laser buttons
  - event console
  - status panels
  - Firebase panel
  - detection settings panel
  - operator assist panel
  - servo calibration panel

### 3.2 Important HTML elements

Important IDs that `control.js` depends on:

- Camera section
  - `cameraFeed`
  - `cameraOverlay`
  - `cameraPlaceholder`
  - `cameraUrlInput`
  - `cameraConnectBtn`
  - `cameraStatus`
  - `detectStatus`

- Control section
  - `esp32IpInput`
  - `esp32ConnectBtn`
  - `btnUp`
  - `btnDown`
  - `btnLeft`
  - `btnRight`
  - `btnStopCursor`
  - `fireBtn`
  - `stopLaserBtn`
  - `stopBtn`
  - `scanBtn`

- Status readouts
  - `safetyDot`
  - `safetyVal`
  - `modeVal`
  - `profileVal`
  - `targetLabelVal`
  - `targetScoreVal`
  - `targetCenterVal`
  - `targetCenterFilteredVal`
  - `targetDeltaVal`
  - `targetDeltaNormVal`
  - `simCommandVal`
  - `loopTimeVal`

- Firebase readouts
  - `firebaseSyncVal`
  - `firebaseCameraVal`
  - `firebaseControllerVal`
  - `firebaseLaserVal`
  - `firebaseHomeVal`

- Detection settings
  - `detectBackendSelect`
  - `detectProfileSelect`
  - `strongThresholdInput`
  - `possibleThresholdInput`
  - `smoothingInput`
  - `deadZoneInput`
  - `downloadTelemetryBtn`
  - `clearTelemetryBtn`

- Calibration
  - `refreshControllerConfigBtn`
  - `centerRigBtn`
  - `probeXPositiveBtn`
  - `probeXNegativeBtn`
  - `probeYPositiveBtn`
  - `probeYNegativeBtn`
  - `xObservedSelect`
  - `yObservedSelect`
  - `saveCalibrationBtn`
  - `resetCalibrationBtn`
  - `controllerConfigVal`
  - `calibrationPanVal`
  - `calibrationTiltVal`
  - `calibrationButtonsVal`

### 3.3 Scripts loaded by the page

At the bottom, the page loads:

- Bootstrap JS
- ONNX Runtime Web
- TensorFlow.js
- COCO-SSD
- Firebase App
- Firebase Auth
- Firebase Realtime Database
- `js/auth.js`
- `js/pages/control.js`

That means the HTML itself is mostly a shell. The real logic lives in JavaScript.

## 4. `auth.js` Explained

`auth.js` is a reusable Firebase auth module wrapped in an IIFE.

### What it does

- Initializes Firebase app with:
  - `apiKey`
  - `authDomain`
  - `databaseURL`
  - `projectId`
  - `storageBucket`
  - `messagingSenderId`
  - `appId`

- Creates:
  - `auth = firebase.auth(app)`
  - `database = firebase.database(app)` when available

### Main exported functions

- `loginWithEmail(email, password)`
  - does Firebase email/password login

- `logout()`
  - signs out

- `isAuthenticated()`
  - returns whether there is a logged-in user

- `onAuthChanged(callback)`
  - subscribes to login state changes

- `requireAuth(options)`
  - protects a page
  - redirects unauthenticated users to login page
  - optionally runs a callback when a user is authenticated

- `getDatabase()`
  - returns the RTDB instance for the page

### Why this matters

`control.js` does not initialize Firebase itself. It expects `auth.js` to have already created `window.SkyShieldAuth`.

## 5. `login.js` Explained

The login page logic is simple:

- gets the login form elements
- listens for submit
- calls `SkyShieldAuth.loginWithEmail()`
- redirects to `control.html` after successful authentication
- respects a `redirect` query parameter

This separation keeps login logic out of `control.js`.

## 6. `control.js` Full Explanation

This is the largest and most important file in the project. It has about 1471 lines and acts like the controller for the entire browser UI.

You can think of it as having these major sections:

1. DOM lookups and constants
2. state objects
3. small utility helpers
4. Firebase synchronization
5. saved settings and calibration
6. coordinate math and target metrics
7. detection filtering and target selection
8. overlay drawing
9. model loading and inference
10. stream handling
11. ESP32 HTTP commands
12. initialization and event binding

### 6.1 DOM references

The file starts by defining a helper:

```js
const $ = (id) => document.getElementById(id);
```

Then it caches almost every important DOM element from `control.html`.

This is important because:

- it avoids repeatedly calling `document.getElementById`
- it creates a direct mapping between HTML IDs and JS variables
- it makes the rest of the file easier to read

Examples:

- `feedImg` is the `<img>` that shows the camera stream
- `overlayCanvas` is the transparent canvas used for drawing boxes and reticle
- `fireBtn` and `stopLaserBtn` control the laser
- `targetLabelVal`, `targetScoreVal`, etc. are output readout spans

### 6.2 Constants

These constants define behavior:

- `STORAGE_KEY`
  - localStorage key for camera URL

- `ESP32_STORAGE_KEY`
  - localStorage key for controller URL

- `DETECTION_SETTINGS_STORAGE_KEY`
  - localStorage key for detection tuning

- `ASSIST_CALIBRATION_STORAGE_KEY`
  - localStorage key for manual calibration notes

- `DRONE_MODEL_URL`
  - path to ONNX model: `models/aeroyolo.onnx`

- `DEFAULT_DETECT_BACKEND_ID`
  - default detector backend is `aeroyolo`

- `DETECT_INTERVAL_MS = 180`
  - target detection loop timing
  - important: it is target cadence, not guaranteed inference time

- `DETECT_MIN_IDLE_MS = 24`
  - minimum delay before scheduling next loop

- `DETECT_MAX_SOURCE_WIDTH` and `DETECT_MAX_SOURCE_HEIGHT`
  - downscale camera feed for detection performance

- `DRAW_THRESHOLD = 0.05`
  - minimum score just to draw a detection

- `LOST_LIMIT = 8`
  - number of missed frames before target lock is cleared

- `MAX_LOG_ROWS = 250`
  - console log limit

- `MAX_TELEMETRY = 1200`
  - session telemetry entry limit

- `CALIBRATION_PROBE_DELTA_DEG = 5`
  - used when probing servo directions for calibration

- `TRACK_LOCK_THRESHOLD_FACTOR`, `TRACK_LOCK_DISTANCE_RATIO`, `TRACK_LOCK_MIN_SCORE`
  - these support sticky target locking so a tracked object is not lost too easily

### 6.3 Detector and label config

`DETECT_BACKENDS` defines two possible model backends:

- `coco`
- `aeroyolo`

`DRONE_MODEL_LABELS` maps ONNX output class IDs to text:

- `0 -> aircraft`
- `1 -> drone`
- `2 -> helicopter`

`PROFILES` defines semantic filtering rules:

- `strict`
  - focuses on rotorcraft/drone-like things

- `broad`
  - allows more classes such as bird and kite in COCO mode

This is important because the model may detect many things, but the UI chooses what classes to treat as actual candidates depending on the profile.

### 6.4 Runtime state

There are several important state groups.

#### General runtime variables

- `streamCandidates`
  - alternative URLs to try for stream loading

- `detectTimer`
  - timeout handle for the detection loop

- `detectLoopActive`
  - whether the loop is running

- `detectModel` / `detectModelReady`
  - COCO-SSD state

- `droneDetectSession` / `droneDetectSessionReady`
  - ONNX runtime session state

- `isDetecting`
  - prevents overlapping inference calls

- `isLaserOn`
  - browser-side laser state cache

- `frameCounter`
  - telemetry frame counter

- `lastDetectState` / `lastDetectLabel`
  - avoid repeated identical logs

#### `trackingState`

This object stores the current selected target:

- whether a target exists
- whether it is strong or only possible
- label and score
- raw center
- filtered center
- normalized offsets
- simulated movement hints
- loop time
- missed frame count

This is the heart of target tracking in the browser.

#### `controllerState`

This stores:

- controller config returned by `/config`
- operator calibration notes:
  - what direction X+ physically moves
  - what direction Y+ physically moves

#### `firebaseState`

This stores:

- whether Firebase listener already started
- the root reference
- whether camera URL was auto-applied from Firebase
- whether controller URL was auto-applied from Firebase
- last full snapshot received

### 6.5 Small utility functions

These functions are basic helpers:

- `clamp()`
  - clamps numeric input between min and max

- `getProfile()`
  - returns a valid profile object

- `getDetectBackend()`
  - returns a valid backend object

- `getProfileLabels()`
  - returns allowed labels based on profile + backend

- `hasTrackLock()`
  - whether there is a live target lock

- `isNearLockedTarget()`
  - whether a new detection is close to current lock

- `logConsole()`
  - appends message to event console with timestamp and row limit

- `setDetectStatus()`
  - updates badge showing detector status

- `setSafetyState()`
  - updates status dot and safety label

- `setMode()`
  - updates mode readout

- `setProfileStatus()`
  - updates profile label

These helpers are small, but they are used everywhere.

### 6.6 Firebase logic in `control.js`

This is one of the newer parts.

#### `formatFirebaseValue()`

Formats a value for UI output or `n/a`.

#### `readFirebaseNumber()`

Safely parses integer values such as `homeX`, `homeY`, `laserOn`.

#### `getFirebaseSnapshotValue(data, path, fallback)`

Reads nested values from a Firebase JSON snapshot.

Example:

- `['controller', 'config', 'homeX']`

This avoids repetitive `if (data && data.controller && ...)`.

#### `normalizeFirebaseUrl()`

Normalizes URL from Firebase into the same form used elsewhere in the UI.

#### `applyFirebaseSnapshot(data)`

This is the main RTDB snapshot consumer.

It reads:

- camera URL from:
  - `camera/state/urlBase`
  - fallback: `cameraIP`

- controller URL from:
  - `controller/state/urlBase`
  - fallback: `espIP`

- laser state from:
  - `controller/state/laserOn`
  - fallback: `laserOn`

- home angles from:
  - `controller/config/homeX/homeY`
  - fallback: root `homeX/homeY`

Then it updates the Firebase panel in the UI.

It also auto-applies URLs to the page only if localStorage does not already contain manual saved values. This is important:

- Firebase auto-fill happens only when browser does not already have stored IPs.
- If user has a saved local value, local value wins.

#### `startFirebaseSync()`

Starts the RTDB listener after login.

Process:

1. checks that sync has not already started
2. gets database from `SkyShieldAuth`
3. subscribes to root `/`
4. on each snapshot, calls `applyFirebaseSnapshot`
5. updates Firebase panel status like `Listening`, `Live`, `Read failed`

### 6.7 Detection settings and local storage

#### `getSettings()`

Builds a settings object from UI controls:

- backend
- profile
- strong threshold
- possible threshold
- smoothing alpha
- dead zone

#### `saveSettings()`

Saves detection settings to localStorage and updates profile display.

#### `loadSettings()`

Loads saved settings and pushes them back into the controls.

This means the detection tuning persists across page reloads.

### 6.8 Calibration logic

This is for understanding how the physical rig moves.

Problem:

- depending on mounting, a positive servo command may move left, right, up, or down
- the page needs to tell the user the correct manual button to press

Key functions:

- `normalizeObservedDirection()`
- `getOppositeDirection()`
- `axisRoleFromDirection()`
- `friendlyDirection()`
- `commandDirectionFromRawPositive()`
- `parseSimLabel()`

Calibration storage functions:

- `readCalibrationFromControls()`
- `writeCalibrationControls()`
- `loadCalibration()`
- `saveCalibration()`
- `resetCalibration()`

#### `deriveCalibration()`

This is one of the most important calibration functions.

It combines:

- operator-observed directions from local notes
- controller config values like `x_dir` and `y_dir`

It tries to answer:

- which axis is pan
- which axis is tilt
- which manual button corresponds to movement in a human-friendly direction

#### `findManualButtonForDirection()`

Given a desired direction such as `left`, it returns which actual UI button sends the correct command.

This is needed because the page’s abstract idea of movement is not always the same as the raw firmware command names.

#### `updateCalibrationReadouts()`

Writes derived calibration information to the right-side panel.

#### `updateOperatorAssistReadout()`

Shows the operator:

- what move is needed
- what button to press
- whether target is centered

This panel is manual assist only. It does not automatically move the servos.

### 6.9 Readouts and telemetry

Small helpers:

- `setReadout()`
- `formatPoint()`
- `formatNorm()`

#### `clearTargetTelemetry()`

Resets tracking state and readouts when there is no target or stream is stopped.

#### `pushTelemetry(entry)`

Adds telemetry to `sessionTelemetry` array and keeps it under the max size.

Telemetry stores:

- frame number
- timestamp
- state (`clear`, `target`, `possible`, `error`)
- backend
- profile
- loop time
- selected class and score
- raw and filtered centers
- normalized deltas
- simulated movement outputs

This is what later gets exported by `downloadTelemetry()`.

### 6.10 Geometry and overlay preparation

#### `syncOverlaySize()`

Makes overlay canvas match displayed image size.

#### `clearOverlay()`

Clears the canvas.

#### `getImageFit()`

Calculates how the camera image fits into the displayed box with `object-fit: contain`.

This is necessary because:

- detections come in image coordinates
- overlay must draw in display coordinates

Without this conversion, boxes would be misplaced.

#### `computeMetrics(det)`

Converts a detection bounding box into:

- screen-space x/y/w/h
- centerX / centerY
- delta from screen center
- normalized delta from -1 to 1

This is central because everything else depends on these metrics:

- target selection
- operator assist
- simulated commands
- overlay visuals

### 6.11 Detection thresholding and target selection

#### `getDetectionThresholds(className, metrics, settings)`

Normally thresholds are taken directly from settings.

But if:

- there is already a track lock
- the class matches current target
- the new detection is close to the locked target

then thresholds are relaxed slightly.

Why?

To keep target tracking stable when confidence briefly dips.

#### `buildDetections(predictions, settings)`

Transforms raw predictions into enriched detection objects:

- keeps only items above draw threshold
- computes metrics
- marks each as:
  - `isCandidate`
  - `isStrong`

#### `chooseCandidate(candidates)`

This is how the app selects one tracked target from all candidates.

Important:

- the model may return multiple boxes
- the UI draws all of them
- but only one becomes the active tracked target

Selection logic:

- starts from score
- if there is already a locked target, it penalizes candidates that are farther from the current filtered center

This makes tracking “sticky” instead of jumping between objects.

### 6.12 Smoothing and simulated operator commands

#### `smoothMetrics(raw, settings)`

Applies exponential smoothing using `smoothingAlpha`.

Purpose:

- reduce jitter
- stabilize center and delta values

#### `simAxis(norm, deadZone, negLabel, posLabel)`

Turns normalized offset into:

- direction label
- step size estimate

Example:

- very small offset inside dead zone -> `HOLD`
- medium offset -> `LEFT_MED`
- large offset -> `RIGHT_LARGE`

#### `simCommand(filtered, settings)`

Builds simulated pan and tilt movement suggestion from normalized target offset.

#### `describeCameraMove()`

Converts simulated command labels into readable text such as:

- `LEFT / UP`
- `HOLD`

#### `buildTargetLogMessage(selected)`

Formats console messages like:

- class
- confidence
- x/y position
- suggested move

### 6.13 Drawing functions

#### `drawReticle()`

Draws center crosshair and circular reticle.

#### `drawScene(detections, selected)`

This is the main overlay renderer.

It:

- clears the canvas
- draws reticle
- draws every detection box
- colors them differently:
  - selected track: blue
  - strong target: red
  - possible target: orange
  - other detection: green
- draws labels like `TRACK`, `TARGET`, `POSSIBLE`
- draws line from screen center to filtered target center
- draws raw and filtered center dots
- draws simulated movement text

Important design point:

- all detections can be shown
- but only one is treated as the active track

### 6.14 `updateSelectedTarget()`

This updates all tracking state after a target is chosen:

- raw center
- filtered center
- normalized deltas
- simulated outputs
- loop time

It also updates the visible status readouts:

- target label
- confidence
- raw center
- filtered center
- delta
- normalized delta
- sim command
- loop time

### 6.15 Detection source preparation

#### `yieldToBrowser()`

Lets the browser breathe between loops by yielding to `tf.nextFrame()` or `requestAnimationFrame`.

#### `ensureDetectSourceSurface()`

Creates reusable offscreen canvas and context for preprocessing.

#### `getDetectionSource()`

Downscales the source image if necessary to improve performance.

This is important because full-resolution frames are unnecessary for faster detection.

#### `rescalePredictionBBox()`

If detection ran on a downscaled image, this function scales boxes back to original image space.

#### `preprocessDroneDetectSource(modelWidth, modelHeight)`

This is the ONNX preprocessing path for AeroYOLO.

It:

- resizes image to model input aspect ratio
- letterboxes it with gray background
- reads pixel data
- converts it into a 3-channel `Float32Array`

That array becomes the model tensor.

#### `clampBboxToFeed()`

Ensures predicted boxes do not go outside image bounds.

#### `normalizeDroneModelPrediction()`

Converts ONNX output row into a prediction object:

- `class`
- `score`
- `classId`
- `bbox`

This is how raw ONNX output is turned into something the rest of the app can use.

### 6.16 Model loading

#### `ensureDetectBackend()`

For TensorFlow.js, it prefers `webgl` backend if available.

#### `ensureCocoDetectModel()`

Loads COCO-SSD if not already loaded.

#### `ensureDroneDetectSession()`

Loads ONNX model `models/aeroyolo.onnx`.

It tries:

1. `webgpu` + `wasm`
2. if that fails, fallback to `wasm` only

This improves compatibility while still preferring better performance.

### 6.17 Detection execution

#### `detectWithCoco()`

Runs COCO-SSD on browser image source and rescales boxes if needed.

#### `detectWithAeroYolo()`

Runs ONNX model:

1. gets input/output names
2. reads expected dimensions
3. preprocesses image
4. creates `ort.Tensor`
5. runs session
6. loops through model rows
7. normalizes each row into a prediction

### 6.18 `runDetection()`

This is the most important runtime function in the whole file.

It is the per-frame detection cycle.

Steps:

1. Guard against overlap or invalid stream
2. mark `isDetecting = true`
3. save start time
4. read settings
5. run either AeroYOLO or COCO
6. enrich raw predictions with metrics and thresholds
7. choose one candidate target
8. compute total loop time
9. if no target:
   - increase missed frame counter
   - clear telemetry after enough misses
   - draw detections but no selected track
   - set state to safe/clear
   - log once
   - push telemetry
10. if target exists:
   - update tracking state
   - draw scene
   - decide whether it is `target` or `possible`
   - update status badges
   - log target/possible state
   - push telemetry
11. on error:
   - detect CORS issues separately
   - mark detection as blocked/error
   - clear target state
   - log warning
12. finally:
   - yield to browser
   - clear `isDetecting`

This function controls the visible “AI behavior” of the system.

### 6.19 Stream management

#### `normalizeBaseUrl()`

Ensures camera/controller URLs have `http://` and no trailing slash.

#### `buildStreamCandidates()`

Builds alternative stream URLs from what user typed.

Example:

- if user typed base IP, it may try `/stream`
- if user typed a URL with path, it tries variants

#### `configureFeedCorsMode()`

Sets `crossOrigin = 'anonymous'` for the image element.

Needed so the page can draw video frames into a canvas for detection.

#### `setStream(baseUrl)`

Starts or clears the stream.

If empty:

- clears feed
- shows placeholder
- stops detection
- clears target state

If valid:

- stores normalized URL
- builds candidate stream URLs
- updates feed source
- hides placeholder
- updates status and logs

#### `stopDetectionLoop(reason)`

Stops scheduling and clears overlay state.

#### `scheduleNextDetection(delay)`

Schedules the next detection cycle.

Timing formula:

- run detection
- measure runtime
- wait `max(24 ms, 180 ms - runtime)` before next cycle

Important exam point:

- `180 ms` is a target cadence, not fixed response time
- the first run starts immediately

#### `startDetectionLoop()`

Starts the loop after stream loads.

### 6.20 ESP32 HTTP command layer

#### `sendCmd(cmd)`

Builds controller URL from localStorage and sends HTTP request:

- `fetch(`${ip}/${cmd}`)`

It logs warnings on non-OK responses and returns the response object.

This is the main browser-to-controller command path.

#### `parseControllerStatusText(text)`

Parses controller `/status` text.

It first tries JSON parsing.

If JSON fails, it falls back to regex matching for:

- laser
- x
- y

This makes it robust to older controller response formats.

#### `syncControllerConfig(logSuccess)`

Fetches `/config`, parses JSON, stores it in `controllerState.config`, and updates calibration/operator readouts.

#### `syncLaserState()`

Fetches `/status` and updates `isLaserOn`.

#### `sendProbe(axis, sign)`

Sends a small `nudge` request for calibration testing.

### 6.21 Telemetry download

`downloadTelemetry()` exports the in-memory telemetry array as JSON download.

This is useful for later analysis or test evidence.

### 6.22 `init()`

This is the startup function that wires the whole page together.

It does many things:

1. clears target state
2. loads saved detection settings
3. loads saved calibration notes
4. updates readouts
5. attaches change listeners to detection controls
6. attaches click listeners to telemetry buttons
7. attaches click listeners to calibration buttons
8. wires camera URL input
9. wires ESP32 controller input
10. wires movement buttons
11. wires laser buttons
12. wires logout button
13. adds stream load/error listeners
14. restores saved camera/controller URLs from localStorage
15. starts Firebase auth protection
16. starts Firebase RTDB sync after authentication

This is the “bootstrap” of the page.

### 6.23 Important behavior details examiners may ask about

#### Why does Up button send `servo_down`?

In `init()`:

- `btnUp -> sendCmd('servo_down')`
- `btnDown -> sendCmd('servo_up')`

That looks reversed at first. The reason is UI direction is based on what the operator sees on screen, while raw servo axis orientation may be opposite depending on mechanical setup. The app later uses calibration logic to explain directions correctly.

#### Is the system fully autonomous?

No.

Detection is automatic, but servo movement is manual-assist only. The system suggests movement but does not automatically drive servos from target tracking.

#### Does the app track multiple targets?

It can display multiple detections, but it actively tracks only one selected target at a time.

#### Does the AI run in the cloud?

No. Detection runs locally in the browser using ONNX Runtime Web or TensorFlow.js.

#### Does Firebase control movement?

No. Movement commands are direct local HTTP to the controller. Firebase is used for boot config and state discovery/sync.

## 7. Controller Firmware Explained

File:

- `firmware/skyshield_controller/skyshield_controller.ino`

Purpose:

- control two servos and laser output
- expose HTTP endpoints
- read startup angles from Firebase
- publish state to Firebase

### 7.1 Libraries

- `WiFi.h`
  - Wi-Fi networking

- `WebServer.h`
  - lightweight HTTP server

- `ESP32Servo.h`
  - servo control

- `HTTPClient.h`
  - outgoing HTTPS/HTTP requests to Firebase

- `WiFiClientSecure.h`
  - secure client used for HTTPS

- `ctype.h`
  - used in lightweight parsing helpers

### 7.2 Compile-time configuration macros

The sketch uses `#ifndef` defaults so behavior can be overridden from `secrets.h`.

Examples:

- servo pins
- laser pin
- min/max angles
- home angles
- servo step degrees
- minimum servo interval
- axis directions
- laser polarity
- servo output enable
- laser output enable
- Firebase URL/auth/sync interval

This is important because:

- firmware is configurable without editing the core logic file
- `secrets.h` can stay local and ignored by Git

### 7.3 Global state

Important variables:

- `homeXAngle`, `homeYAngle`
  - startup/home positions, possibly overridden from Firebase

- `xAngle`, `yAngle`
  - current servo angles

- `laserOn`
  - current laser state

- `lastAction`
  - last command name

- `lastServoWriteMs`
  - used for rate limiting

- `commandCount`
  - statistics/debug info

- `firebaseSyncPending`
  - whether controller should publish to Firebase

- `lastWifiConnected`
  - used to detect reconnect transitions

### 7.4 Firebase helper functions

#### `trimTrailingSlashes()`

Cleans RTDB base URL.

#### `firebaseEnabled()`

Checks whether database URL was configured.

#### `firebaseUrl(path)`

Builds a full RTDB REST URL ending with `.json`.

#### `firebaseRequest()`

Sends HTTPS request to Firebase using `HTTPClient`.

#### `parseJsonIntField()` and `parseJsonPrimitiveInt()`

Very lightweight parsing helpers so the firmware can extract integer values without a full JSON library.

#### `firebaseGetInt()`

Reads a root integer like `/homeX`.

#### `loadHomeAnglesFromFirebase()`

On boot:

1. tries `/controller/config`
2. extracts `homeX` and `homeY`
3. if missing, falls back to `/homeX` and `/homeY`
4. clamps them
5. copies them into `xAngle` and `yAngle`

This is what gives boot-time servo position from Firebase.

#### `publishFirebaseState()`

Publishes:

- root keys:
  - `espIP`
  - `laserOn`
  - `homeX`
  - `homeY`

- nested `controller` object:
  - `config.homeX`, `config.homeY`
  - `state.xAngle`, `state.yAngle`
  - `state.laserOn`
  - `state.wifi`
  - `state.ip`
  - `state.urlBase`
  - `state.rssi`
  - `state.heap`
  - `state.uptimeMs`
  - `state.lastAction`
  - `state.commandCount`

Current behavior:

- publishes once on boot
- publishes again when laser changes
- does not publish on every servo movement

That last point was changed intentionally to reduce control lag.

### 7.5 Servo helpers

#### `clampAngle()`

Keeps servo angle between safe minimum and maximum.

#### `servoCooldownMs()`

Implements movement rate limit.

#### `applyServoAngles()`

Writes current angles to both servos.

#### `applyLaserOutput()`

Sets laser pin high or low depending on polarity configuration.

#### `setLaser()`

Updates `laserOn`, applies output, and requests Firebase sync.

### 7.6 Status functions

#### `statusJson()`

Returns JSON string containing:

- current x/y
- home angles
- laser state
- output-enable flags
- servo cooldown
- Wi-Fi status
- IP
- RSSI
- heap
- uptime
- last action
- last command time
- command count

This is useful for browser status polling and debugging.

### 7.7 HTTP endpoints

The controller firmware exposes these endpoints:

- `/`
  - simple HTML summary page

- `/status`
  - JSON status

- `/health`
  - JSON wrapper with `ok: true`

- `/config`
  - static config + current home values

- `/center` or `/home`
  - move servos to home angles

- `/set?x=90&y=90`
  - set absolute angles

- `/nudge?dx=5&dy=-5`
  - relative movement

- `/servo_up`
- `/servo_down`
- `/step_left`
- `/step_right`
  - step-based manual commands

- `/laser_on`
- `/laser_off`
- `/laser_toggle`

- `/stop`
  - turns laser off

### 7.8 Why servo movement may feel slow

Important firmware reasons:

- `SERVO_STEP_DEG = 5`
  - each movement command only changes 5 degrees

- `SERVO_MIN_INTERVAL_MS = 80`
  - movement is rate-limited

This is why a single click may look like very small movement.

### 7.9 `setup()` and `loop()`

#### `setup()`

1. starts serial
2. configures laser pin
3. turns laser off
4. attaches servos
5. connects Wi-Fi
6. loads home angles from Firebase
7. applies home angles
8. publishes initial Firebase state
9. registers all HTTP routes
10. starts web server

#### `loop()`

1. handles incoming HTTP requests
2. reconnects Wi-Fi if needed
3. publishes to Firebase only when:
   - just reconnected
   - or `firebaseSyncPending` is true

Because movement no longer marks sync pending, ordinary movement is faster.

## 8. Camera Firmware Explained

File:

- `firmware/ai_thinker_cam_http80/ai_thinker_cam_http80.ino`

Purpose:

- initialize ESP32-CAM
- expose browser-friendly HTTP endpoints
- stream live MJPEG
- publish camera IP to Firebase

### 8.1 Camera setup

It defines all AI Thinker ESP32-CAM pin mappings:

- data pins
- VSYNC
- HREF
- PCLK
- SCCB pins
- power down and reset

### 8.2 Firebase behavior

This sketch also supports Firebase.

It publishes:

- root:
  - `cameraIP`

- nested:
  - `camera/state/ip`
  - `camera/state/urlBase`
  - `camera/state/streamUrl`
  - `camera/state/captureUrl`
  - `camera/state/healthUrl`
  - `camera/state/wifi`
  - `camera/state/rssi`
  - `camera/state/heap`
  - `camera/state/uptimeMs`

### 8.3 HTTP endpoints

- `/`
  - basic HTML info page with links

- `/stream`
  - live MJPEG stream

- `/capture`
  - single JPEG frame

- `/health`
  - simple JSON health status

### 8.4 Camera performance choices

If PSRAM exists:

- uses `VGA`
- better quality
- double frame buffer
- lower-latency grab mode

If PSRAM does not exist:

- falls back to smaller frame size and single buffer

### 8.5 `setup()` and `loop()`

#### `setup()`

1. starts serial
2. initializes camera
3. connects Wi-Fi
4. starts camera HTTP server
5. publishes Firebase state
6. prints URLs to serial

#### `loop()`

1. maintains Wi-Fi reconnects
2. republishes Firebase on reconnect or periodic interval

## 9. Firebase RTDB Structure

Current intended data shape is roughly:

```json
{
  "aim": 1,
  "cameraIP": "http://camera-ip/",
  "espIP": "http://controller-ip/",
  "laserOn": 0,
  "homeX": 90,
  "homeY": 90,
  "camera": {
    "state": {
      "urlBase": "http://camera-ip",
      "streamUrl": "http://camera-ip/stream",
      "captureUrl": "http://camera-ip/capture",
      "healthUrl": "http://camera-ip/health"
    }
  },
  "controller": {
    "config": {
      "homeX": 90,
      "homeY": 90
    },
    "state": {
      "urlBase": "http://controller-ip",
      "xAngle": 90,
      "yAngle": 90,
      "laserOn": 0
    }
  }
}
```

Examiner may ask why both root keys and nested keys exist.

Answer:

- root keys provide easy compatibility and quick manual inspection
- nested keys provide more structured state for the page and future expansion

## 10. Important Design Decisions

### Why detection is local in browser

- lower cost
- no cloud inference dependency
- avoids sending video to a server
- simpler architecture for demo

### Why movement uses direct HTTP

- much lower latency
- simpler than cloud command routing
- better for manual control

### Why Firebase is still used

- boot-time configuration
- state sharing across devices
- device discovery and auto-fill
- auth for protected UI

### Why only one target is actively tracked

- simpler manual-assist logic
- easier operator interpretation
- avoids oscillation between multiple detections

### Why smoothing is used

- raw detections jitter
- operator guidance becomes unstable without smoothing

### Why thresholds are relaxed during track lock

- prevents immediate loss of target when confidence dips briefly

## 11. Weaknesses and Tradeoffs

These are excellent things to mention in a test because they show understanding.

- It is not a true autonomous weapon or autonomous tracker.
- Servo control is still manual-assist.
- Detection is only as good as current browser model and camera quality.
- Single-target selection may ignore secondary targets.
- Browser inference speed depends on hardware.
- CORS from the camera matters because detection uses a canvas.
- Firebase sync is useful, but too much sync can hurt responsiveness.
- Controller firmware uses simple manual JSON parsing instead of a full JSON parser.
- The app stores URLs in localStorage, which can override Firebase auto-fill unless cleared.

## 12. Very Likely Questions and Answers

### Q: What is the role of `control.js`?

A:
It is the main client-side controller for the application. It connects UI controls to camera stream handling, AI inference, overlay drawing, operator assist logic, ESP32 HTTP commands, Firebase sync, telemetry, and calibration.

### Q: Where does the AI run?

A:
In the browser. AeroYOLO runs through ONNX Runtime Web, and COCO-SSD runs through TensorFlow.js.

### Q: Is `180 ms` the actual response time?

A:
No. It is the target loop cadence. The first detection starts immediately. Real measured time per run is `loopMs`, and future scheduling uses `max(24 ms, 180 ms - runtime)`.

### Q: Does the system track multiple targets?

A:
It can display multiple detections, but it actively selects and tracks only one target at a time.

### Q: How is target selection done?

A:
By score, with a distance penalty that prefers staying near the current locked target.

### Q: Why do we need `getImageFit()`?

A:
Because the image is displayed with `object-fit: contain`, so model/image coordinates must be transformed into display coordinates for correct overlay drawing.

### Q: Why is there both raw center and filtered center?

A:
Raw center is the direct detection result. Filtered center is smoothed for more stable operator guidance and better visual tracking.

### Q: What does operator assist do?

A:
It translates detected target offset into manual movement hints. It does not directly move the servos.

### Q: What does calibration do?

A:
It helps the user map physical servo directions to logical directions like left/right/up/down.

### Q: How does Firebase help the website?

A:
It lets the website auto-discover camera/controller URLs and display device state and home angles after login.

### Q: Why does the page sometimes not auto-fill from Firebase?

A:
Because `control.js` only auto-applies Firebase URLs if localStorage does not already contain saved URLs.

### Q: What is in telemetry?

A:
Per-frame detection state including timing, labels, confidence, raw/filtered centers, normalized offsets, and simulated commands.

### Q: Why were Firebase syncs reduced on servo movement?

A:
To avoid introducing lag in manual control. Direct local HTTP control should remain fast, while Firebase should be limited to boot config and state updates that matter.

### Q: What happens when the controller boots?

A:
It connects to Wi-Fi, reads home angles from Firebase, applies them to servos, publishes its state to Firebase, then starts serving HTTP endpoints.

### Q: What happens when the camera boots?

A:
It initializes the camera, connects to Wi-Fi, starts the stream server, publishes its URLs to Firebase, and prints endpoints to serial.

## 13. Fast Revision Summary

If you need a very short memory version:

- `control.html` = UI structure
- `auth.js` = Firebase auth and database setup
- `control.js` = brain of browser app
- camera firmware = stream provider
- controller firmware = servo/laser HTTP controller
- Firebase = login + boot config + device discovery/state
- AI = local in browser
- servo movement = direct HTTP, not Firebase
- operator assist = suggestions only, not automatic motion
- one active tracked target at a time

## 14. Best Way to Explain the Whole Project in One Minute

You can say:

“SkyShield is a browser-based ground control station that connects to two ESP32 devices: an ESP32-CAM for live streaming and a separate ESP32 for pan/tilt servo and laser control. The browser runs object detection locally using AeroYOLO or COCO-SSD, overlays results on the stream, and computes target center and manual guidance hints. The controller ESP exposes HTTP endpoints for movement and laser control, while Firebase is used for authentication, boot-time home-angle configuration, and sharing camera/controller IP addresses so the website can auto-fill them. The system is manual-assist, not autonomous servo tracking.”

That answer alone covers the architecture, AI, networking, control model, and Firebase role.
