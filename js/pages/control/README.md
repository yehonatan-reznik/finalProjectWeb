# Control Page Code Guide

This folder contains the full runtime for `html/control.html`.

The control page is the main operator dashboard of the project. It is where:

- the browser receives the `ESP32-CAM` stream
- the browser loads and runs the AI detector
- the UI shows status, overlays, guidance, and telemetry
- the browser sends direct commands to the controller `ESP32`

This README is meant to explain the code in this folder in a practical way:

- what each file owns
- why the files are split
- what loads first
- where the AI runs
- how the image is processed
- how one target is selected
- how movement guidance and auto-follow work

## 1. Big Picture

The control page is split into small files on purpose.

The split keeps the code easier to maintain:

- one area owns DOM and shared page state
- one area owns Firebase sync
- one area owns calibration and operator guidance
- one area owns transport
- one area owns model loading and inference
- one area owns the repeating detection loop
- one area owns optional auto-follow

The main mental model is:

`ESP32-CAM stream -> browser image -> browser AI inference -> target selection -> overlay + guidance -> optional controller command`

## 2. What Runs Where

### `ESP32-CAM`

The camera board does not run the AI model.

It only:

- captures the live image
- exposes `/stream`
- serves the image to the browser over HTTP

### Browser

The browser is the real control station.

It does the heavy work:

- loads the stream into the page
- reads image pixels
- loads the AI model
- runs detection
- chooses a target
- computes target position
- draws overlay graphics
- sends servo and laser commands to the controller board

### Controller `ESP32`

The controller board does not run detection.

It only:

- receives HTTP commands
- moves the servos
- toggles the laser
- reports state/config

### Firebase

Firebase is not the live movement transport.

It is used for:

- login/auth support
- camera/controller discovery
- mirrored state such as URLs and laser state
- saved home angles

It is not used for:

- AI inference
- live pixel processing
- real-time servo transport

## 3. Load Order

These files are loaded by `html/control.html` in this order:

1. `00-core.js`
2. `10-firebase.js`
3. `20-calibration-and-target-guide.js`
4. `30-transport.js`
5. `40-init.js`
6. `50-detection-state-settings.js`
7. `60-calculate-target-position.js`
8. `70-draw-target-overlay.js`
9. `80-run-ai-models.js`
10. `90-detection-loop.js`
11. `100-follow-automation.js`

This order matters because later files reuse globals created by earlier files.

## 4. Runtime Overview

At startup the page does this:

1. capture DOM elements and create shared state
2. restore saved settings from localStorage
3. restore saved calibration
4. attach click/change/load/error listeners
5. restore saved camera and controller URLs
6. wait for auth
7. start Firebase sync after auth
8. set the camera stream URL
9. wait for the image to load
10. start the repeating detection loop

## 5. File-by-File Explanation

## `00-core.js`

This is the shared foundation for the whole page.

It does not run detection itself. Its job is to define the common values that the rest of the files use.

### Main responsibilities

- caches the important DOM elements from `control.html`
- defines browser storage keys
- defines small page-level state objects
- defines common UI helper functions

### Important DOM references

This file captures the main page elements once and stores them in constants:

- `feedImg`: the live camera `<img>`
- `overlayCanvas` / `overlayCtx`: transparent drawing layer above the camera
- `urlInput`: camera URL input
- `esp32IpInput`: controller URL input
- movement buttons
- laser buttons
- follow button
- status cards
- telemetry readouts
- calibration controls

This matters because all later files reuse these references instead of calling `document.getElementById(...)` again and again.

### Important shared state

This file also creates the browser-side state used by the rest of the runtime:

- `streamCandidates`
- `streamCandidateIndex`
- `isLaserOn`
- `controllerState`
- `firebaseState`
- `MANUAL_BUTTON_COMMANDS`

#### `controllerState`

Stores:

- the last fetched controller config
- calibration observations like what `X+` and `Y+` physically did

#### `firebaseState`

Stores:

- whether Firebase sync already started
- the Firebase root ref
- the last snapshot
- which camera/controller values were auto-applied

### Important helper functions

- `clamp()`
  - safely restricts a number to a range

- `logConsole()`
  - appends timestamped rows into the event console

- `setFirebaseStatus()`
  - updates the Firebase status readout

- `setDetectStatus()`
  - updates the detection badge

- `setSafetyState()`
  - updates the safety dot and safety label

- `setMode()`
  - shows whether the page is in `Manual` or `Observe`

- `setProfileStatus()`
  - writes the active detection profile label

- `formatFirebaseValue()`, `readFirebaseNumber()`, `getFirebaseSnapshotValue()`, `normalizeFirebaseUrl()`
  - these help the Firebase module safely read mixed snapshot shapes

In short: `00-core.js` is the file that gives the rest of the runtime one shared language.

## `10-firebase.js`

This file owns Firebase Realtime Database reading and UI auto-fill.

It does not move hardware. It does not run AI.

### Main responsibilities

- listens to Firebase RTDB
- reads camera and controller data from the root snapshot
- mirrors those values into the UI
- auto-fills the camera/controller URL only when the browser does not already have a saved override

### Main functions

#### `applyFirebaseSnapshot(data)`

This is the main snapshot consumer.

It:

1. stores the latest raw snapshot
2. reads camera URL from the new nested schema or old flat schema
3. reads controller URL from the new nested schema or old flat schema
4. reads `laserOn`, `homeX`, `homeY`
5. updates the read-only Firebase cards
6. syncs `isLaserOn`
7. optionally auto-applies camera/controller values when localStorage does not already override them

Important behavior:

- local browser values win over Firebase
- Firebase only fills blank local state

#### `startFirebaseSync()`

This starts the RTDB listener.

It:

- prevents duplicate listeners
- gets the database instance from `window.SkyShieldAuth`
- listens at the root path `/`
- sends each snapshot to `applyFirebaseSnapshot()`

In short: this file makes Firebase a passive shared-state source, not an active motion controller.

## `20-calibration-and-target-guide.js`

This file explains to the human operator what the rig is really doing.

The reason this file exists is that the mechanical installation can make raw firmware command names misleading.

Example:

- a command named `step_right` may visually move the rig left on screen
- a command named `servo_up` may visually move the image down

So this file translates mechanical reality into human-readable guidance.

### Main responsibilities

- store calibration notes
- infer which axis is pan and which is tilt
- map firmware polarity into real movement direction
- turn detector hints into readable operator instructions

### Main function groups

#### Direction normalization

- `normalizeObservedDirection()`
- `getOppositeDirection()`
- `axisRoleFromDirection()`
- `friendlyDirection()`

These are the small building blocks that turn raw text into stable directional meanings.

#### Detector label parsing

- `parseSimLabel()`

This converts labels like:

- `LEFT_SMALL`
- `RIGHT_MED`
- `UP_LARGE`
- `HOLD`

into structured data:

- direction
- size
- number of suggested button taps

#### Calibration persistence

- `readCalibrationFromControls()`
- `writeCalibrationControls()`
- `loadCalibration()`
- `saveCalibration()`
- `resetCalibration()`

These keep the operator's physical observations saved across refreshes.

#### Controller config interpretation

- `getControllerConfigNumber()`
- `deriveCalibration()`

`deriveCalibration()` is one of the key functions in the whole control page.

It combines:

- what the user observed physically
- what the controller config says about `x_dir` and `y_dir`

and produces:

- which axis is pan
- which axis is tilt
- what each manual button really does physically

#### Operator assist

- `findManualButtonForDirection()`
- `formatAxisAssist()`
- `describeFramePosition()`
- `updateCalibrationReadouts()`
- `updateOperatorAssistReadout()`

These functions make the UI say things like:

- target is left of center
- press `Right` two times
- target is centered

In short: this file is the translation layer between detection math and human understanding.

## `30-transport.js`

This file owns communication with the outside world.

### Main responsibilities

- normalize camera/controller URLs
- connect the camera stream
- retry stream URL candidates
- send HTTP commands to the controller
- fetch controller state/config
- export telemetry

### Main helper functions

- `setReadout()`
- `formatPoint()`
- `formatNorm()`

These are lightweight formatting helpers reused by later detector files.

### Stream functions

#### `normalizeBaseUrl(raw)`

Makes sure URLs are stable:

- adds `http://` when missing
- trims trailing slashes

#### `buildStreamCandidates(normalized)`

Creates a fallback list like:

- exact typed path
- `/stream`
- origin root

This is why the page can retry multiple stream forms automatically.

#### `configureFeedCorsMode()`

Sets:

- `feedImg.crossOrigin = 'anonymous'`

This is critical.

Without it, the browser may refuse canvas pixel reads, and the detector cannot inspect the image.

#### `setStream(baseUrl, options)`

This is the stream entry point.

It:

1. normalizes the input URL
2. clears the stream if the value is empty
3. builds fallback candidates
4. sets `feedImg.src`
5. updates status labels
6. saves the normalized URL when appropriate

This function starts image loading, but not detection itself.

Detection only begins later when the image fires its `load` event.

### Controller functions

#### `sendCmd(cmd)`

This is the main controller transport function.

It:

- reads the controller base URL
- calls `fetch(`${ip}/${cmd}`)`
- logs errors in operator-friendly form
- returns the raw `Response` so callers can parse JSON or text

Important architecture note:

live controller commands go directly over local HTTP, not Firebase.

#### `parseControllerStatusText(text)`

Parses controller responses:

- JSON first
- regex fallback for older text responses

#### `syncControllerConfig(logSuccess)`

Calls `/config`, stores the response in `controllerState.config`, and updates calibration/operator-assist readouts.

#### `syncLaserState()`

Queries the controller for the current laser state and updates browser-side state.

#### `sendProbe(axis, sign)`

Used by calibration UI to send small nudges so the operator can observe what the rig physically does.

#### `downloadTelemetry()`

Exports the in-memory detection session as JSON.

In short: this file is the transport layer for both stream and controller traffic.

## `40-init.js`

This file is the integration point that turns all the helper files into a working application.

### Main responsibility

`init()` is the startup function for the page.

### What `init()` does

#### Restores state

- resets HUD state
- loads saved detector settings
- loads saved calibration
- clears the old proxy flag
- updates calibration and assist cards

#### Wires detector controls

It attaches listeners to:

- backend dropdown
- profile dropdown
- threshold inputs
- smoothing
- dead zone

When these controls change, it:

- saves settings
- clears stale target state
- logs the change

#### Wires telemetry buttons

- export telemetry
- clear telemetry

#### Wires calibration controls

- calibration dropdowns
- save/reset calibration
- refresh controller config
- center rig
- probe X/Y positive and negative

#### Wires camera controls

- camera URL input
- `Set` button
- Enter key behavior

#### Wires controller controls

- controller URL input
- `Connect` button
- Enter key behavior

#### Wires manual commands

- up/down/left/right buttons
- stop
- laser on/off
- auto-follow button
- scan placeholder
- logout

#### Wires stream events

This is one of the key startup points:

- on `feedImg.load`:
  - sync overlay size
  - show overlay
  - start detection loop

- on `feedImg.error`:
  - stop detection
  - try next stream candidate
  - eventually show disconnected state

#### Restores saved URLs

- restores saved controller URL first
- restores saved camera URL second

#### Starts auth and Firebase

At the end, `requireAuth()` confirms the user is signed in.

Once authenticated:

- `startFirebaseSync()` begins

In short: `40-init.js` is the file that makes the page come alive.

## `50-detection-state-settings.js`

This file is the central store for detector config and detector runtime state.

### Main responsibilities

- define detector constants
- define available backends
- define profiles
- store detection loop state
- store current tracking state
- load/save detection settings
- reset target state safely

### Important constants

- `DETECTION_SETTINGS_STORAGE_KEY`
- `DRONE_MODEL_URL`
- `DEFAULT_DETECT_BACKEND_ID`
- `DETECT_INTERVAL_MS`
- `DETECT_MIN_IDLE_MS`
- `DETECT_MAX_SOURCE_WIDTH`
- `DETECT_MAX_SOURCE_HEIGHT`
- `DRAW_THRESHOLD`
- `LOST_LIMIT`
- `MAX_TELEMETRY`
- track-lock constants

### Available backends

- `coco`
- `aeroyolo`

### Profiles

Profiles decide which labels count as real candidates.

- `strict`
  - narrower target acceptance

- `broad`
  - wider aerial class acceptance

### Runtime caches

This file owns the main detector caches:

- loop timer
- current detect loop active flag
- cached COCO model
- cached ONNX session
- overlap guard
- telemetry array
- off-screen canvas/context

### `trackingState`

This is one of the most important shared objects in the control page.

It stores:

- whether a target exists
- whether the target is strong or possible
- label and score
- raw center
- filtered center
- filtered deltas
- normalized offsets
- simulated pan/tilt output
- loop timing
- missed frame count

Later files read and mutate this single object.

### Key functions

- `getProfile()`
- `getDetectBackend()`
- `getProfileLabels()`
- `getSettings()`
- `saveSettings()`
- `loadSettings()`
- `hasTrackLock()`
- `isNearLockedTarget()`
- `clearTargetTelemetry()`

`clearTargetTelemetry()` is the standard reset path when the detector loses trust in the current target.

In short: this file is the detector's shared memory.

## `60-calculate-target-position.js`

This file turns raw predictions into geometry and movement meaning.

### Main responsibilities

- map image-space boxes to overlay-space
- compute center and offset values
- filter and rank target candidates
- smooth motion
- convert offsets into `LEFT/RIGHT/UP/DOWN/HOLD` guidance

### Geometry functions

- `syncOverlaySize()`
  - makes the overlay canvas match the displayed camera container

- `clearOverlay()`
  - wipes old overlay pixels

- `getImageFit()`
  - computes how the image is displayed inside the container when `object-fit: contain` is used

- `computeMetrics(det)`
  - converts image-space bbox into:
    - `x`
    - `y`
    - `w`
    - `h`
    - `centerX`
    - `centerY`
    - `deltaX`
    - `deltaY`
    - `normX`
    - `normY`

### Candidate filtering

- `getDetectionThresholds()`
  - returns the possible and strong thresholds for a detection
  - applies relaxed thresholds when track-lock says the candidate is probably the same target as before

- `buildDetections()`
  - turns raw predictions into decorated detections
  - adds:
    - metrics
    - `isCandidate`
    - `isStrong`

### Target selection

- `chooseCandidate()`
  - chooses one best detection
  - mainly by score
  - but penalizes distant detections when a target is already locked

This helps prevent the tracker from jumping wildly between objects.

### Smoothing and guidance

- `smoothMetrics()`
  - applies exponential smoothing to target motion

- `simAxis()`
  - turns one normalized axis into `HOLD`, `LEFT_SMALL`, `RIGHT_MED`, etc.

- `simCommand()`
  - combines the horizontal and vertical simulated outputs

### Logging helpers

- `describeCameraMove()`
- `buildTargetLogMessage()`

### Overlay helper

- `drawReticle()`
  - draws the center crosshair

In short: this file is the math bridge between AI output and operator meaning.

## `70-draw-target-overlay.js`

This file owns the visible detector output.

### Main responsibilities

- draw boxes and labels
- draw target line and movement summary
- update the HUD from the selected target
- append telemetry

### `drawScene(detections, selected)`

This paints one full overlay frame.

It:

1. resizes the overlay canvas
2. clears the old frame
3. draws the center reticle
4. draws all detections
5. color-codes them
6. highlights the selected target
7. draws the line from screen center to filtered target center
8. draws the simulated movement text

### `updateSelectedTarget(selected, settings, loopMs)`

This is one of the key handoff points in the detector.

It:

- smooths the selected target
- computes simulated pan/tilt guidance
- updates `trackingState`
- updates all target-related HUD cards
- updates loop timing
- updates operator assist

It also contains target-centering behavior:

- when the target becomes centered, it sends `laser_on`
- when the target leaves the centered zone, it sends `laser_off`

So this file is not just visual. It also bridges selected detection into shared app state and centering events.

### Other functions

- `pushTelemetry()`
  - appends one telemetry row and keeps the buffer bounded

- `yieldToBrowser()`
  - yields back to the browser between frames so UI updates can paint

- `ensureDetectSourceSurface()`
  - creates and reuses one off-screen canvas/context for preprocessing

In short: this file is the output layer of the detector.

## `80-run-ai-models.js`

This file owns all backend-specific model work.

It hides the differences between:

- `AeroYOLO ONNX`
- `COCO-SSD`

so the rest of the detector can work with one common prediction format.

### Main responsibilities

- prepare pixels for inference
- lazily load the model/runtime
- run one inference pass
- normalize outputs into `{ class, score, bbox }`

### COCO pipeline

#### `getDetectionSource()`

For COCO:

- if the source image is already small enough, use `feedImg` directly
- otherwise draw it into the off-screen canvas at smaller resolution

This keeps COCO inference lighter.

#### `rescalePredictionBBox()`

When downscaling was used, this converts the bbox back into the original image coordinates.

### AeroYOLO preprocessing

#### `preprocessDroneDetectSource(modelWidth, modelHeight)`

This is the most important image-to-model function.

It:

1. reads the current stream frame from `feedImg`
2. computes a letterbox scale to fit the ONNX input size
3. draws the image into the off-screen canvas
4. fills padding with gray
5. reads RGBA pixels using `getImageData()`
6. converts the data into CHW `Float32Array`
7. returns the tensor data and the scaling/padding info needed for later decoding

### Output decoding

- `clampBboxToFeed()`
- `normalizeDroneModelPrediction()`

These convert one ONNX output row into:

- class label
- score
- bbox in original image coordinates

### Runtime loading

#### `ensureDetectBackend()`

For TensorFlow.js:

- waits for TF runtime
- prefers `webgl` when available

#### `ensureCocoDetectModel()`

Loads the `COCO-SSD` model lazily and caches it.

#### `ensureDroneDetectSession()`

Loads the ONNX model lazily and caches it.

It:

- tries `webgpu` first
- falls back to `wasm`

### Inference entry points

#### `detectWithCoco()`

- gets source image/canvas
- runs `model.detect(...)`
- rescales boxes if needed

#### `detectWithAeroYolo()`

- ensures the ONNX session exists
- gets model input shape
- preprocesses the frame
- creates an ONNX tensor
- runs `session.run(...)`
- decodes all rows into shared prediction objects

In short: this file is where the browser really becomes an AI detector.

## `90-detection-loop.js`

This file is the detector orchestrator.

It is the file that actually makes the detector run again and again.

### Main responsibilities

- run one full detection pass
- start the repeating loop
- stop the loop cleanly
- schedule the next pass with timing compensation

### `runDetection()`

This is the core detection cycle.

Its flow is:

1. guard against overlap
2. make sure the image is valid and loaded
3. read current settings
4. run exactly one backend
5. normalize predictions into detections
6. choose one target
7. update UI for clear / possible / target
8. draw overlay
9. push telemetry
10. handle errors
11. yield to the browser

#### Clear state

If no valid selected target exists:

- missed frame count increases
- stale state may be cleared
- overlay still shows visible raw detections
- detector status becomes `clear`

#### Possible state

If the selected detection passes the lower threshold but not the strong one:

- detector status becomes `possible`
- safety becomes warning

#### Target state

If the selected detection passes the strong threshold:

- detector status becomes `target`
- safety becomes danger
- target log line is written

### Loop control

- `stopDetectionLoop(reason)`
  - clears timers
  - clears overlay
  - resets target state
  - disables auto-follow if needed

- `scheduleNextDetection(delay)`
  - uses a timeout
  - compensates for time already spent in the current pass

- `startDetectionLoop()`
  - sets initial detector state
  - starts scheduling immediately

In short: this file is the main heartbeat of browser detection.

## `100-follow-automation.js`

This file owns optional automatic movement.

Detection can run without follow.
Follow depends on detection, but detection does not depend on follow.

### Main responsibilities

- read tracking state
- convert tracking guidance into controller commands
- manage the follow timer
- update the follow button state

### Main follow state

- `followEnabled`
- `followTimer`
- `followPrefersNudge`

### Key functions

- `hasControllerAddress()`
  - checks whether movement can even be sent

- `getDefaultCommandForDirection()`
  - maps a plain direction into a default command

- `syncFollowButtonState()`
  - updates the button label and color

- `canEnableFollow()`
  - requires both controller URL and live camera stream

- `resolveDirectionCommand()`
  - tries calibrated movement mapping first

- `getFollowNudgeDegrees()`
  - maps `SMALL/MED/LARGE` into movement size

- `buildFollowNudgeCommand()`
  - converts the chosen moves into one `/nudge?dx=...&dy=...` command when possible

- `resolveMovementCommands()`
  - reads `trackingState.simPanLabel` and `trackingState.simTiltLabel`
  - converts them into physical controller commands

- `performFollowStep()`
  - one follow cycle
  - ignores tiny near-centered drift
  - prefers `nudge`
  - falls back to legacy step commands if needed

- `scheduleNextFollow()`
  - repeats the follow cycle

- `stopRigIfPossible()`
  - sends `stop` when shutting down

- `enableFollow()`, `disableFollow()`, `toggleFollow()`
  - public control for follow mode

At the bottom, the file exposes:

- `window.SkyShieldFollow`

So the rest of the page can call it.

In short: this file is the optional motion automation layer.

## 6. Exact AI Image Path

This is the most important part for understanding where the AI really runs.

### The image path

1. the `ESP32-CAM` serves `/stream`
2. the browser sets that URL into `feedImg.src`
3. the browser waits for `feedImg` to finish loading
4. detection starts only after the image has real drawable pixels

### The processing path for AeroYOLO

1. `runDetection()` calls `detectWithAeroYolo()`
2. `detectWithAeroYolo()` calls `preprocessDroneDetectSource()`
3. the browser copies the current image into an off-screen canvas
4. the browser resizes and letterboxes that image
5. the browser reads raw pixel data from the canvas
6. the browser converts pixels into a `Float32Array`
7. the browser creates an ONNX tensor
8. ONNX Runtime Web runs the model in the browser
9. output rows are decoded into shared detections

### The processing path for COCO

1. `runDetection()` calls `detectWithCoco()`
2. the browser either uses `feedImg` directly or downscales it into the off-screen canvas
3. TensorFlow.js runs `COCO-SSD` in the browser
4. predictions are normalized into the same shared format

So the answer to "where the AI runs" is:

- in the operator browser
- on the operator machine
- using browser GPU or browser WASM

not on the camera and not on Firebase.

## 7. End-to-End Flow

Here is the full runtime sequence in simple order:

1. operator opens `control.html`
2. shared DOM and state are created
3. saved settings and calibration are restored
4. auth confirms the user
5. Firebase sync starts
6. camera URL is restored or auto-filled
7. `setStream()` points the page to the camera stream
8. `feedImg` loads
9. `startDetectionLoop()` starts
10. `runDetection()` begins repeating
11. model inference runs in the browser
12. detections are filtered and ranked
13. one target is selected
14. target geometry is computed
15. overlay and status cards update
16. operator assist updates
17. optional auto-follow may move the controller
18. next detection cycle runs

## 8. Important Design Choices

### Why use an `<img>` instead of a `<video>`?

Because the ESP32-CAM provides an MJPEG-like HTTP stream that is easy to display directly in an image element.

### Why is CORS important?

Because the browser detector must copy image pixels into a canvas.

Without the right CORS behavior:

- the image may still display
- but the detector will fail because the canvas becomes unreadable

### Why keep detection in the browser?

Because it:

- avoids sending raw frames to a backend server
- keeps movement latency lower
- allows the operator machine to do the heavy AI work instead of the ESP32

### Why keep movement outside Firebase?

Because direct local HTTP is much better for real-time actuation than round-tripping through cloud state.

## 9. Where To Edit When You Want To Change Something

If you want to change:

- HTML element IDs:
  - start in `00-core.js`

- Firebase auto-fill behavior:
  - edit `10-firebase.js`

- operator guidance wording:
  - edit `20-calibration-and-target-guide.js`

- stream connection logic:
  - edit `30-transport.js`

- page event wiring:
  - edit `40-init.js`

- thresholds, profiles, detector defaults:
  - edit `50-detection-state-settings.js`

- target geometry and guidance math:
  - edit `60-calculate-target-position.js`

- overlay drawing:
  - edit `70-draw-target-overlay.js`

- model loading or preprocessing:
  - edit `80-run-ai-models.js`

- the main detection loop:
  - edit `90-detection-loop.js`

- auto-follow behavior:
  - edit `100-follow-automation.js`

## 10. Practical Debugging Tips

- If the stream does not appear:
  - check the camera URL and `/stream`

- If the stream appears but detection fails:
  - check CORS first

- If the detector loads but boxes are wrong:
  - check preprocessing, profile, and threshold settings

- If guidance is correct but movement is wrong:
  - check controller config and calibration

- If follow mode does nothing:
  - check that the controller address is set
  - check that a target exists
  - check controller endpoint responses

- If Firebase values are not filling:
  - check auth
  - check RTDB path contents
  - check whether localStorage already overrides those fields

## 11. Final Summary

The control runtime is a browser-side command center.

Its architecture is:

- stream from the `ESP32-CAM`
- process everything in the browser
- show detection and movement guidance in the UI
- send direct commands to a separate controller `ESP32`

The most important technical idea is this:

the camera board does not run the AI.
the browser does.

That design is the reason this code is split the way it is:

- shared page state
- Firebase sync
- calibration
- transport
- detector configuration
- geometry and target selection
- overlay drawing
- model loading and inference
- loop orchestration
- optional follow automation
