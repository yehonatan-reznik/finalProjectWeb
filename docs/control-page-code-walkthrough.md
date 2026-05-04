# Control Page Code Walkthrough

This file is the "read it once from top to bottom" guide for the control page code.

It explains:
- `js/pages/control.js`
- `js/pages/control-detection.js`

It is not a literal one-paragraph explanation for all 2,000+ lines. That would be unreadable.
Instead, it explains the files in file order, with line ranges, what each block does, and what sentence you should say when presenting it.

## Useful Commands

Print `control.js` with line numbers:

```powershell
$i=0; Get-Content 'js/pages/control.js' | ForEach-Object { $i++; '{0}:{1}' -f $i, $_ }
```

Print `control-detection.js` with line numbers:

```powershell
$i=0; Get-Content 'js/pages/control-detection.js' | ForEach-Object { $i++; '{0}:{1}' -f $i, $_ }
```

Print only a range:

```powershell
$i=0; Get-Content 'js/pages/control-detection.js' | ForEach-Object { $i++; if($i -ge 977 -and $i -le 1084){ '{0}:{1}' -f $i, $_ } }
```

## Big Picture

The control page is split into two files on purpose.

- `control.js` is the page coordinator.
- `control-detection.js` is the detection engine.

`control.js` handles:
- DOM references
- stream URL setup
- Firebase sync
- ESP32 HTTP commands
- calibration
- operator assist card
- page startup

`control-detection.js` handles:
- model settings
- loading TF.js / ONNX models
- reading camera pixels
- turning predictions into one chosen target
- drawing overlays
- exporting telemetry

The mental model is:

`camera stream -> browser reads frame -> model predicts -> code filters/ranks boxes -> one target is chosen -> HUD/overlay/assist update`

---

## `control.js` Walkthrough

File: [control.js](/c:/Users/Owner/Desktop/website/code/js/pages/control.js:1)

### 1. Lines 1-34: intro comments and typedefs

- Line 1 defines `$`, a tiny helper for `document.getElementById`.
- Lines 2-11 explain the file's role.
- Lines 13-22 define `ControllerState`.
- Lines 24-34 define `FirebaseState`.

Say this:
"The top of `control.js` documents the page's architecture and the shapes of the main state objects."

### 2. Lines 36-108: DOM capture

This section grabs every important HTML element once and stores it in a constant.

Main groups:
- lines 39-44: camera feed and camera URL controls
- lines 45-57: ESP32 / controller buttons
- lines 58-62: overlay canvas and event console
- lines 63-80: status cards and telemetry readouts
- lines 81-93: detection tuning controls
- lines 94-108: calibration controls

Say this:
"This block caches all the page elements so the rest of the code can work with direct references instead of repeatedly querying the DOM."

### 3. Lines 110-150: constants and local page state

- Lines 111-115 define storage keys and small constants.
- Lines 119-121 store stream retry state and laser state.
- Lines 125-131 create `controllerState`.
- Lines 135-142 create `firebaseState`.
- Lines 145-150 map visible button labels to firmware commands.

Say this:
"This section defines the browser-side state that belongs to the control page itself, separate from detection state."

### 4. Lines 152-241: shared small helpers

- `clamp()` on lines 160-165 safely limits numeric input.
- `logConsole()` on lines 172-183 appends timestamped messages to the page console.
- `setFirebaseStatus()` on lines 189-192 updates the Firebase status card.
- `setDetectStatus()` on lines 198-207 updates the detection badge.
- `setSafetyState()` on lines 213-224 updates the safety dot and label.
- `setMode()` on lines 229-232 updates `Manual` / `Observe`.
- `setProfileStatus()` on lines 238-241 updates the current profile label.

Say this:
"These helpers keep all the visual status updates consistent."

### 5. Lines 243-389: Firebase reading and auto-apply

- `formatFirebaseValue()` on lines 249-252 turns values into friendly text.
- `readFirebaseNumber()` on lines 259-263 parses numeric snapshot values.
- `getFirebaseSnapshotValue()` on lines 272-289 safely walks nested Firebase data.
- `normalizeFirebaseUrl()` on lines 295-299 normalizes URLs from Firebase.
- `applyFirebaseSnapshot()` on lines 306-353:
  - saves the snapshot
  - extracts camera/controller URLs
  - extracts laser/home values
  - updates the read-only cards
  - optionally auto-fills stream and controller URLs if local storage has no override
- `startFirebaseSync()` on lines 356-389 starts one RTDB root listener and routes every snapshot into `applyFirebaseSnapshot()`

Say this:
"Firebase is used as a shared source of truth for camera and controller info, but local browser values still win if the operator already saved them."

### 6. Lines 391-716: calibration and operator assist

This is one of the most important `control.js` sections.

- `normalizeObservedDirection()` on lines 397-400 only accepts `left/right/up/down/unknown`.
- `getOppositeDirection()` on lines 406-419 flips a direction.
- `axisRoleFromDirection()` on lines 426-433 decides whether an observed movement belongs to pan or tilt.
- `friendlyDirection()` on lines 439-442 formats directions for UI display.
- `commandDirectionFromRawPositive()` on lines 449-456 converts firmware polarity plus observed motion into real command meaning.
- `parseSimLabel()` on lines 462-475 parses strings like `LEFT_SMALL`.
- `readCalibrationFromControls()` on lines 480-484 copies dropdown values into shared state.
- `writeCalibrationControls()` on lines 489-493 writes shared state back to the dropdowns.
- `loadCalibration()` on lines 498-515 restores saved calibration from `localStorage`.
- `saveCalibration()` on lines 520-529 persists calibration.
- `resetCalibration()` on lines 534-544 resets calibration to unknown.
- `getControllerConfigNumber()` on lines 551-555 safely parses firmware config values.
- `deriveCalibration()` on lines 571-608 is the core logic:
  - it reads observed directions
  - reads controller polarity config
  - deduces which firmware command causes which physical movement
  - builds human-readable summaries
- `findManualButtonForDirection()` on lines 615-621 maps a desired movement direction to the matching manual button.
- `formatAxisAssist()` on lines 629-639 converts a simulated movement hint into a concrete operator instruction.
- `describeFramePosition()` on lines 648-654 turns normalized offsets into phrases like `right of center`.
- `updateCalibrationReadouts()` on lines 659-668 updates the calibration status card.
- `updateOperatorAssistReadout()` on lines 674-716 reads `trackingState` from `control-detection.js` and translates it into operator guidance.

Say this:
"This block turns raw detector output into instructions a human operator can actually use."

### 7. Lines 718-980: stream, controller, and telemetry helpers

- `setReadout()` on lines 724-727 safely writes text into an optional DOM node.
- `formatPoint()` on lines 734-737 formats pixel coordinates.
- `formatNorm()` on lines 744-747 formats normalized offsets.
- `normalizeBaseUrl()` on lines 754-760 cleans up user-entered URLs.
- `buildStreamCandidates()` on lines 766-778 creates retry options like `host/stream` and `host`.
- `configureFeedCorsMode()` on lines 783-786 sets `crossOrigin = 'anonymous'` so detection can read pixels.
- `setStream()` on lines 793-831:
  - tears down the stream when URL is empty
  - builds stream candidates
  - points `feedImg.src` at the first candidate
  - updates HUD mode/status
  - saves the normalized URL
- `sendCmd()` on lines 838-875 sends direct HTTP commands to the ESP32.
- `parseControllerStatusText()` on lines 881-898 parses either JSON or plain-text controller status.
- `syncControllerConfig()` on lines 904-932 fetches firmware config and updates calibration/assist UI.
- `syncLaserState()` on lines 937-946 refreshes cached laser state.
- `sendProbe()` on lines 953-960 sends small calibration nudges.
- `downloadTelemetry()` on lines 966-980 downloads the detection telemetry array as JSON.

Say this:
"This section is where the page connects to the real world: camera stream in, ESP32 commands out, telemetry exported."

### 8. Lines 982-end: page startup and event wiring

`init()` is the page bootstrap function.

Main steps inside `init()`:
- lines 987-1001 restore persisted settings and reset visible state
- lines 1003-1024 wire detection setting controls
- lines 1026-1033 wire telemetry buttons
- lines 1035-1059 wire calibration controls
- lines 1061-1073 wire controller config refresh, centering, and probes
- lines 1075-1098 wire camera/controller URL inputs
- lines 1100-1123 wire manual movement and laser buttons
- lines 1125-1135 wire logout
- lines 1137-1165 wire `feedImg` load/error behavior
- lines 1167 onward restore saved camera/controller values from `localStorage`

Important behavior:
- when `feedImg` loads, `startDetectionLoop()` is called
- when `feedImg` errors, the page retries alternate stream URLs

Say this:
"`init()` is the place where all helpers become a working page."

### One-Sentence Summary for `control.js`

`control.js` is the browser-side coordinator that wires the UI to Firebase, the camera stream, the ESP32 controller, and the detector.

---

## `control-detection.js` Walkthrough

File: [control-detection.js](/c:/Users/Owner/Desktop/website/code/js/pages/control-detection.js:1)

### 1. Lines 1-14: file-level explanation

These comments explain that the file:
- reads camera frames
- runs one of two detector backends
- filters and ranks detections
- draws overlays
- stores telemetry

They also state that this file depends on globals created by `control.js`.

Say this:
"The detector file owns the ML pipeline, but it relies on UI and helper functions from `control.js`."

### 2. Lines 16-84: JSDoc typedefs

These blocks document the shapes of:
- `DetectBackendConfig`
- `DetectProfile`
- `DetectionMetrics`
- `DetectionSettings`
- `TrackingState`

These are for readability and tooling. They do not execute runtime behavior.

### 3. Lines 86-101: static constants

This section defines:
- localStorage key for detection settings
- ONNX model path
- default backend
- loop interval values
- maximum source dimensions
- draw threshold
- lost-target tolerance
- telemetry cap
- track-lock tuning numbers

Say this:
"These constants control how fast detection runs, how much state is remembered, and how strict the pipeline is."

### 4. Lines 103-133: backend and profile config

- `DETECT_BACKENDS` defines the two engines:
  - `coco`
  - `aeroyolo`
- `DRONE_MODEL_LABELS` converts AeroYOLO numeric class ids into text labels
- `PROFILES` define which classes count as real targets under `strict` and `broad`

Say this:
"This block answers two questions: which model is running, and which predicted labels are allowed to become targets."

### 5. Lines 135-177: detector runtime state

This block creates:
- loop timer state
- model/session caches
- flags like `isDetecting`
- reusable off-screen drawing surface
- telemetry array
- `trackingState`, the live shared target object

`window.SkyShieldTracking = trackingState` exposes the tracking object globally.

Say this:
"This block stores everything the detector needs between frames."

### 6. Lines 179-266: settings helpers

- `getProfile()` returns a valid profile or falls back to `strict`
- `getDetectBackend()` returns a valid backend or falls back to `coco`
- `getProfileLabels()` chooses the correct label allow-list for the active backend
- `getSettings()` reads the live form controls and clamps them
- `saveSettings()` persists detector settings to `localStorage`
- `loadSettings()` restores persisted settings and writes them back to the UI

Say this:
"This section turns raw form values into one clean detector settings object."

### 7. Lines 268-325: target lock and reset

- `hasTrackLock()` says whether the previous target is still considered alive
- `isNearLockedTarget()` checks whether a new detection is spatially close to the old target
- `clearTargetTelemetry()` wipes the selected target from both the HUD and `trackingState`

Say this:
"This block controls whether the detector should stay loyal to the previous target or fully reset."

### 8. Lines 327-391: box geometry conversion

- `syncOverlaySize()` makes the overlay canvas match the displayed feed size
- `clearOverlay()` erases old drawings
- `getImageFit()` computes how the image was scaled inside the container
- `computeMetrics()` converts one model bbox from image coordinates to screen coordinates and computes:
  - box position and size
  - target center
  - delta from screen center
  - normalized offsets

Say this:
"This is the math that translates model output into something the UI can draw and reason about."

### 9. Lines 393-458: detection filtering and ranking

- `getDetectionThresholds()` optionally relaxes thresholds for a nearby previously locked target
- `buildDetections()`:
  - removes ultra-low-confidence clutter
  - computes screen metrics
  - marks each prediction as `isCandidate` and/or `isStrong`
- `chooseCandidate()` picks one best target, mostly by confidence but with a distance penalty when track lock exists

Say this:
"This block turns many raw predictions into one chosen target."

### 10. Lines 460-507: smoothing and simulated motion

- `smoothMetrics()` reduces jitter using exponential smoothing
- `simAxis()` converts one normalized offset into labels like `HOLD`, `LEFT_SMALL`, `UP_LARGE`
- `simCommand()` builds combined pan/tilt guidance from both axes

Say this:
"This section converts exact geometry into stable, human-readable movement hints."

### 11. Lines 509-533: logging helpers

- `describeCameraMove()` converts current simulated labels into short move text
- `buildTargetLogMessage()` builds a single readable event-console line for a detected target

Say this:
"These helpers turn detector state into log text for the operator."

### 12. Lines 535-618: overlay drawing

- `drawReticle()` paints the fixed center crosshair
- `drawScene()`:
  - clears the canvas
  - redraws the reticle
  - draws each detection with color-coding
  - highlights the selected target
  - draws line from center to filtered target center
  - draws raw and filtered target points
  - shows simulated movement text

Say this:
"This block is the visual output of the detector."

### 13. Lines 620-670: commit selected target and telemetry

- `updateSelectedTarget()`:
  - smooths the chosen target
  - computes simulated move guidance
  - writes everything into `trackingState`
  - updates HUD readouts
  - triggers operator assist refresh
- `pushTelemetry()` adds one telemetry record and trims old entries

Say this:
"Once a target is chosen, this section makes it the official current target for the rest of the page."

### 14. Lines 672-687: browser yielding

- `yieldToBrowser()` gives control back to the browser between frames using `tf.nextFrame()` or `requestAnimationFrame()`

Say this:
"This prevents the detection loop from freezing rendering or input."

### 15. Lines 689-831: frame preparation and output normalization

- `ensureDetectSourceSurface()` lazily creates an off-screen canvas
- `getDetectionSource()` downsizes the feed for COCO inference when needed
- `rescalePredictionBBox()` scales COCO boxes back to original image size
- `preprocessDroneDetectSource()` prepares the feed for ONNX:
  - letterboxes to model size
  - reads pixel data
  - converts it to CHW float32 tensor data in `0..1`
- `clampBboxToFeed()` keeps decoded ONNX boxes inside valid image bounds
- `normalizeDroneModelPrediction()` converts one ONNX output row into the shared prediction shape

Say this:
"This section makes two very different model backends look identical to the rest of the pipeline."

### 16. Lines 834-925: runtime/model loading

- `ensureDetectBackend()` prepares TensorFlow.js and prefers `webgl`
- `ensureCocoDetectModel()` loads `coco-ssd`
- `ensureDroneDetectSession()` loads the ONNX session:
  - tries `webgpu`
  - falls back to `wasm`

Say this:
"This block loads the browser-side ML runtime and the models only when needed."

### 17. Lines 927-975: backend-specific inference

- `detectWithCoco()`:
  - gets the COCO model
  - gets the inference source
  - runs `model.detect(...)`
  - rescales boxes if the source was downscaled
- `detectWithAeroYolo()`:
  - gets the ONNX session
  - reads input dimensions
  - preprocesses the frame into a tensor
  - runs `session.run(...)`
  - decodes every output row

Say this:
"This block is where the actual AI inference happens."

### 18. Lines 977-1084: one full detection pass

`runDetection()` is the core of the file.

Main steps:
- reject invalid conditions like hidden feed or overlapping runs
- mark `isDetecting = true`
- read current settings
- run the selected backend
- build decorated detections
- choose one candidate target
- if no target:
  - increase missed-frame count
  - maybe clear target state
  - draw raw detections
  - update status to `clear`
  - push telemetry
- if target exists:
  - update selected target state
  - draw target scene
  - update danger/possible status
  - log messages
  - push telemetry
- if error:
  - detect CORS-like failures
  - show warning/error status
  - clear target state
  - log telemetry error
- finally:
  - yield back to browser
  - clear `isDetecting`

Say this:
"`runDetection()` performs exactly one full cycle from current frame to updated UI."

### 19. Lines 1086-1142: loop lifecycle

- `stopDetectionLoop()` stops the timer, hides stale overlay, clears state, and resets mode/status
- `scheduleNextDetection()` waits a computed delay, runs one pass, then schedules the next pass
- `startDetectionLoop()` flips the loop on and starts scheduling frames

Say this:
"These functions control when detection starts, stops, and how often it repeats."

### 20. Lines 1144-1145: startup handoff

- `init()` is called here even though `init()` is defined in `control.js`

This matters because:
- `control.js` defines the page bootstrap
- `control-detection.js` is loaded after it
- calling `init()` here ensures both halves of the system are available first

Say this:
"The detector file finishes by starting the page bootstrap after both scripts have loaded."

### One-Sentence Summary for `control-detection.js`

`control-detection.js` is the browser-side ML pipeline that turns camera frames into one chosen target plus overlay, status, assist hints, and telemetry.

---

## End-to-End Runtime Flow

Here is the whole control page flow in order:

1. `control-detection.js` loads after `control.js`.
2. `control-detection.js` calls `init()`.
3. `init()` restores saved settings, wires all UI events, and restores camera/controller URLs if present.
4. `setStream()` puts the camera URL into `feedImg.src`.
5. When the image loads, `startDetectionLoop()` begins.
6. The loop schedules repeated calls to `runDetection()`.
7. `runDetection()` reads settings and calls either:
   - `detectWithAeroYolo()`, or
   - `detectWithCoco()`
8. Raw predictions are normalized into a shared format.
9. `buildDetections()` marks which boxes are candidates and strong detections.
10. `chooseCandidate()` picks one target.
11. `updateSelectedTarget()` writes the target into shared state.
12. `drawScene()` paints the overlay.
13. `updateOperatorAssistReadout()` converts tracking state into operator guidance.
14. `pushTelemetry()` records the result.
15. `scheduleNextDetection()` waits and repeats.

---

## Short Oral Script

If you need to explain this quickly to someone, use this:

"The control page is split into two files. `control.js` manages the page, the stream URL, Firebase, ESP32 commands, calibration, and startup. `control-detection.js` is the actual detector: it loads the browser ML runtime, reads frames from the camera image element, runs either COCO or AeroYOLO, filters predictions based on the selected profile and thresholds, chooses one best target, draws the overlay, updates shared tracking state, and exports telemetry. The operator assist in `control.js` reads that shared tracking state and translates it into human guidance instead of automatic actuation."

---

## Best Way To Study

Read in this order:

1. `control.js` lines 1-241
2. `control.js` lines 243-716
3. `control-detection.js` lines 1-266
4. `control-detection.js` lines 327-670
5. `control-detection.js` lines 689-1084
6. `control.js` `init()` section

That order works because it matches how the page is mentally layered:
- shared UI/helpers
- calibration/control logic
- detector config/state
- detector geometry and ranking
- detector inference loop
- final page wiring
