// FILE ROLE: 00-core.js
// What this file does:
// - Reads the important HTML elements from control.html and stores them in variables.
// - Defines shared constants, cached page state, and small helper functions.
// - Exposes the common base that every later control-page file depends on.
// Why this file exists:
// - The other split files should not each query the DOM or redefine the same shared state.
// - Loading this file first guarantees that later files can reuse one shared source of truth.
const $ = (id) => document.getElementById(id);
// Reading guide:
// 1. The top of the file grabs HTML elements and stores them in variables.
// 2. The middle of the file contains helpers for Firebase, calibration, and controller commands.
// 3. The bottom of the file connects buttons and inputs to those helpers.
// 4. Detection math and model work live in the later control-page modules, but this file still calls into that logic.
// Architecture summary:
// - This file is the page coordinator. It does not run detection itself.
// - It owns operator-facing state such as stream URLs, controller config, Firebase sync, and calibration notes.
// - It exposes small shared helpers that control-detection.js reuses for HUD updates and formatting.
// - Its main job is to connect DOM events to the camera stream, ESP32 endpoints, and Firebase state.
// Search guide:
// - Ctrl+F `calibration` for the block that learns what the rig physically does when X+/Y+ are probed.
// - Ctrl+F `operator assist` for the card that translates detector hints into human button guidance.
// - Ctrl+F `Firebase` for database sync and auto-applied camera/controller URLs.
// - Ctrl+F `setStream` for camera URL normalization, retry candidates, and stream startup.
// - Ctrl+F `sendCmd` for direct ESP32 HTTP command requests.
// Key terms:
// - calibration: operator-entered observations that map firmware axes to real-world movement.
// - operator assist: UI-only guidance that tells the person how to re-center a target manually.
// - stream candidate: one possible camera URL tried during browser connection/retry logic.
// - controller config: firmware polarity/setup values fetched from the ESP32.
// - Firebase auto-apply: filling the page with camera/controller values learned from RTDB when no local override exists.
// Exam quick terms:
// - CORS: browser rule that must allow canvas pixel reads from the camera stream.
// - home position: saved servo center angles that the controller can return to.
// - telemetry: downloaded JSON history of detection passes and selected targets.
// - manual mapping: the difference between visible button labels and raw firmware commands.
// Load-order contract:
// - This file loads before the other split control-page modules.
// - Later files reuse these bindings directly instead of importing them.
// - If an element id changes in control.html, the fix often starts here.
// State-ownership summary:
// - Browser-local persistence keys are defined here once.
// - Runtime caches for stream, controller, and Firebase state also begin here.
// - The detector stack reads these values but intentionally does not redefine them.

/**
 * @typedef {{
 *   config: object|null,
 *   calibration: {
 *     xPositiveObserved: 'left'|'right'|'up'|'down'|'unknown',
 *     yPositiveObserved: 'left'|'right'|'up'|'down'|'unknown'
 *   }
 * }} ControllerState
 * Cached controller configuration plus operator-entered calibration notes.
 */

/**
 * @typedef {{
 *   syncStarted: boolean,
 *   unsubscribe: Function|null,
 *   rootRef: object|null,
 *   autoAppliedCamera: string,
 *   autoAppliedController: string,
 *   lastSnapshot: object|null
 * }} FirebaseState
 * Minimal Firebase listener state used to avoid duplicate subscriptions and repeated auto-apply behavior.
 */

// Section: DOM capture.
// Shared DOM references used by the control page and the detection overlay script.
// Many of these are optional so the UI can be simplified without forcing logic changes.
// Camera block: image element, placeholder, camera URL input, and top-level status text.
const feedImg = $('cameraFeed'); // <img> element that displays the live stream frames used by the detector.
const placeholder = $('cameraPlaceholder'); // Empty-state panel shown before a stream is connected or after failure.
const urlInput = $('cameraUrlInput'); // Text input where the operator types the camera base URL or stream URL.
const connectBtn = $('cameraConnectBtn'); // Button that applies the camera URL and starts stream loading.
const statusLabel = $('cameraStatus'); // Small text status that describes the current camera stream state.
// Manual controller block: stored controller URL and the visible movement / laser buttons.
const esp32IpInput = $('esp32IpInput'); // Text input for the ESP32 controller base URL.
const esp32ConnectBtn = $('esp32ConnectBtn'); // Button that stores the controller URL and syncs controller state.
const btnUp = $('btnUp'); // Manual button that sends the firmware command mapped to upward screen movement.
const btnDown = $('btnDown'); // Manual button that sends the firmware command mapped to downward screen movement.
const btnLeft = $('btnLeft'); // Manual button that steps the rig toward the left.
const btnRight = $('btnRight'); // Manual button that steps the rig toward the right.
const btnStopCursor = $('btnStopCursor'); // Manual button that sends the generic stop command.
const fireBtn = $('fireBtn'); // Manual button that attempts to enable the laser output.
const stopLaserBtn = $('stopLaserBtn'); // Manual button that attempts to disable the laser output.
const scanBtn = $('scanBtn'); // Placeholder scan button; current HTTP-only firmware does not support scan mode.
const stopBtn = $('stopBtn'); // Auto-follow toggle button (historical id retained for compatibility).
const logoutBtn = $('logoutBtn'); // Top-bar logout button.
// Overlay and console block: the detector paints on the canvas while console logs keep operator feedback visible.
const overlayCanvas = $('cameraOverlay'); // Transparent canvas drawn on top of the camera feed for boxes and reticles.
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null; // 2D drawing context used by the detection overlay.
const detectStatus = $('detectStatus'); // Badge showing coarse detector state like idle, loading, clear, possible, target.
const consolePanel = $('console'); // Rolling event log panel visible to the operator.
// Status and telemetry readouts: these cards are optional but, when present, mirror live tracking state.
const safetyDot = $('safetyDot'); // Colored dot showing safe/warn/danger at a glance.
const safetyVal = $('safetyVal'); // Text label paired with the safety dot.
const modeVal = $('modeVal'); // Readout showing whether the page is in manual or observe mode.
const profileVal = $('profileVal'); // Readout showing the active detection profile label.
const targetLabelVal = $('targetLabelVal'); // HUD field for the current target class label.
const targetScoreVal = $('targetScoreVal'); // HUD field for the current target confidence percentage.
const targetCenterVal = $('targetCenterVal'); // HUD field for the raw target center coordinates.
const targetCenterFilteredVal = $('targetCenterFilteredVal'); // HUD field for the smoothed target center coordinates.
const targetDeltaVal = $('targetDeltaVal'); // HUD field for pixel delta from center.
const targetDeltaNormVal = $('targetDeltaNormVal'); // HUD field for normalized delta from center.
const simCommandVal = $('simCommandVal'); // HUD field showing simulated pan/tilt movement labels and values.
const loopTimeVal = $('loopTimeVal'); // HUD field showing how long the last detection pass took.
const firebaseSyncVal = $('firebaseSyncVal'); // Status field for Firebase listener health.
const firebaseCameraVal = $('firebaseCameraVal'); // Read-only card value showing camera URL learned from Firebase.
const firebaseControllerVal = $('firebaseControllerVal'); // Read-only card value showing controller URL learned from Firebase.
const firebaseLaserVal = $('firebaseLaserVal'); // Read-only card value showing laser state learned from Firebase.
const firebaseHomeVal = $('firebaseHomeVal'); // Read-only card value showing saved home coordinates from Firebase.
// Detection tuning controls: these feed directly into the later control-page modules through shared helpers.
const detectBackendSelect = $('detectBackendSelect'); // Dropdown choosing between COCO and AeroYOLO detection engines.
const detectProfileSelect = $('detectProfileSelect'); // Dropdown choosing the label allow-list profile.
const strongThresholdInput = $('strongThresholdInput'); // Numeric input for full target confidence threshold.
const possibleThresholdInput = $('possibleThresholdInput'); // Numeric input for weaker possible-target threshold.
const smoothingInput = $('smoothingInput'); // Numeric input controlling tracking jitter smoothing strength.
const deadZoneInput = $('deadZoneInput'); // Numeric input controlling when simulated movement becomes HOLD.
const downloadTelemetryBtn = $('downloadTelemetryBtn'); // Button that exports in-memory telemetry as JSON.
const clearTelemetryBtn = $('clearTelemetryBtn'); // Button that empties the current telemetry buffer.
const assistMoveVal = $('assistMoveVal'); // Operator assist field describing movement in detector language.
const assistFrameVal = $('assistFrameVal'); // Operator assist field describing where the target sits in frame.
const assistButtonVal = $('assistButtonVal'); // Operator assist field translating detector hints into actual buttons.
const assistCenterVal = $('assistCenterVal'); // Operator assist field saying centered or off-center.
// Calibration controls: these map observed physical rig motion back to firmware axis directions.
const refreshControllerConfigBtn = $('refreshControllerConfigBtn'); // Button that re-fetches firmware axis config from the ESP32.
const centerRigBtn = $('centerRigBtn'); // Button that asks the rig to return to its configured center position.
const probeXPositiveBtn = $('probeXPositiveBtn'); // Probe button for a small positive X-axis nudge.
const probeXNegativeBtn = $('probeXNegativeBtn'); // Probe button for a small negative X-axis nudge.
const probeYPositiveBtn = $('probeYPositiveBtn'); // Probe button for a small positive Y-axis nudge.
const probeYNegativeBtn = $('probeYNegativeBtn'); // Probe button for a small negative Y-axis nudge.
const xObservedSelect = $('xObservedSelect'); // Dropdown where the operator records what X+ physically did.
const yObservedSelect = $('yObservedSelect'); // Dropdown where the operator records what Y+ physically did.
const saveCalibrationBtn = $('saveCalibrationBtn'); // Button that persists the current calibration observations.
const resetCalibrationBtn = $('resetCalibrationBtn'); // Button that clears saved calibration observations.
const controllerConfigVal = $('controllerConfigVal'); // Readout showing parsed firmware polarity config.
const calibrationPanVal = $('calibrationPanVal'); // Readout summarizing which axis is interpreted as pan.
const calibrationTiltVal = $('calibrationTiltVal'); // Readout summarizing which axis is interpreted as tilt.
const calibrationButtonsVal = $('calibrationButtonsVal'); // Readout summarizing button-to-direction meaning.

// These keys and small constants are shared by the control page and the detection script.
const STORAGE_KEY = 'skyshield_camera_base_url'; // localStorage key for the last successful camera URL.
const ESP32_STORAGE_KEY = 'esp32_ip'; // localStorage key for the last successful controller URL.
const ASSIST_CALIBRATION_STORAGE_KEY = 'skyshield_assist_calibration_v1'; // localStorage key for calibration notes.
const MAX_LOG_ROWS = 250; // Hard cap on visible console rows so the page does not grow forever.
const CALIBRATION_PROBE_DELTA_DEG = 5; // Probe step size, in degrees, for calibration nudges.

// Section: local runtime state.
// This page keeps only stream/controller/Firebase state here; detection state lives in the later control-page modules.
// Keeping these mutable values in one place lets the split files cooperate without passing large state objects around.
let streamCandidates = []; // Ordered list of fallback camera URLs generated from one user-entered base URL.
let streamCandidateIndex = 0; // Current position inside the retry candidate list.
let isLaserOn = false; // Cached browser-side belief about whether the laser is currently enabled.

// controllerState caches the last controller config so both calibration readouts and assist hints use one source of truth.
/** @type {ControllerState} */
const controllerState = {
  config: null,
  calibration: {
    xPositiveObserved: 'unknown', // What physical direction the rig moved when X positive was probed.
    yPositiveObserved: 'unknown', // What physical direction the rig moved when Y positive was probed.
  },
};

// Firebase state tracks a single root listener and whether values were auto-applied locally.
/** @type {FirebaseState} */
const firebaseState = {
  syncStarted: false, // Prevents starting multiple Firebase listeners for the same page.
  unsubscribe: null, // Reserved slot for future unsubscribe logic; current code uses rootRef directly.
  rootRef: null, // Firebase RTDB reference used for the root listener.
  autoAppliedCamera: '', // Last Firebase camera URL auto-applied in this tab when no local override exists.
  autoAppliedController: '', // Last Firebase controller URL auto-applied in this tab when no local override exists.
  lastSnapshot: null, // Last raw root snapshot data seen from Firebase.
};

// These are the operator-facing button labels that map to controller HTTP commands.
// The labels describe what the rig should do on screen, not the literal firmware endpoint name.
const MANUAL_BUTTON_COMMANDS = [
  { button: 'Left', command: 'step_right' }, // UI label Left intentionally sends the opposite firmware command so the rig moves left on screen.
  { button: 'Right', command: 'step_left' }, // UI label Right intentionally sends the opposite firmware command so the rig moves right on screen.
  { button: 'Up', command: 'servo_down' }, // UI label Up maps to servo_down because of the current rig orientation.
  { button: 'Down', command: 'servo_up' }, // UI label Down maps to servo_up because of the current rig orientation.
];

// Generic number parsing helper reused by detection settings and UI controls.
/**
 * @param {string|number} value - Raw input that should become a number.
 * @param {number} min - Lowest allowed result.
 * @param {number} max - Highest allowed result.
 * @param {number} fallback - Value to use when parsing fails.
 * @returns {number} Clamped numeric result.
 */

//clamping a value clamp between 
function clamp(value, min, max, fallback) {
  const n = Number.parseFloat(value); // Parsed floating-point version of the raw input.
  // Empty or invalid values fall back to a safe default so the UI cannot poison later calculations.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Event console keeps a capped rolling timeline of operator and detection messages.
/**
 * @param {string} message - Human-readable message to append to the console.
 * @param {string} variant - Optional CSS class for color styling.
 */
// EXAM: event console logging.
function logConsole(message, variant) {
  if (!consolePanel) return;
  const row = document.createElement('div'); // One rendered console row appended to the event log.
  if (variant) row.className = variant;
  // Prefix every line with local time so exported screenshots still show the event order clearly.
  row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  // The console is append-only during the session so operators can read event order directly.
  consolePanel.appendChild(row);
  while (consolePanel.children.length > MAX_LOG_ROWS) {
    consolePanel.removeChild(consolePanel.firstElementChild);
  }
  consolePanel.scrollTop = consolePanel.scrollHeight;
}

// Status helpers keep HUD updates consistent across UI, controller, and detection flows.
/**
 * @param {string} text - Short Firebase status label for the UI.
 */
// EXAM: firebase status badge.
function setFirebaseStatus(text) {
  // Write the current Firebase sync state into the status card if that card exists.
  if (firebaseSyncVal) firebaseSyncVal.textContent = text || 'Idle';
}

/**
 * @param {string} text - Badge text shown next to the camera status.
 * @param {string} variant - Space-separated Bootstrap classes for badge color.
 */
// EXAM: detection status badge.
function setDetectStatus(text, variant) {
  // Skip the update entirely if the detect badge is not on this page.
  if (!detectStatus) return;
  // Replace the visible label text first.
  detectStatus.textContent = text;
  // Reset the badge classes so old color classes do not accumulate forever.
  detectStatus.className = 'badge';
  // Apply the requested Bootstrap classes, defaulting to a neutral gray badge.
  (variant || 'bg-secondary').split(' ').forEach((cls) => detectStatus.classList.add(cls));
}

/**
 * @param {'ok'|'warn'|'danger'} state - Logical safety state.
 * @param {string} text - Optional custom label for the safety readout.
 */
// EXAM: safety state indicator.
function setSafetyState(state, text) {
  // The safety card has both a colored dot and a text label, so both are updated together.
  if (!(safetyDot && safetyVal)) return;
  // Remove all old status colors before deciding the new one.
  safetyDot.classList.remove('status-ok', 'status-warn', 'status-danger');
  // Convert the logical state name into the matching CSS class name.
  const cls = state === 'danger' ? 'status-danger' : state === 'warn' ? 'status-warn' : 'status-ok'; // CSS class corresponding to the logical safety state.
  // Apply the chosen color to the dot.
  safetyDot.classList.add(cls);
  // Show either the provided text or a built-in default for that state.
  safetyVal.textContent = text || (state === 'danger' ? 'Air target detected' : state === 'warn' ? 'Scanning' : 'Safe');
}

/**
 * @param {string} text - Operator mode label such as Manual or Observe.
 */
// EXAM: page mode label.
function setMode(text) {
  // The control page switches between labels like Manual and Observe.
  if (modeVal) modeVal.textContent = text || 'Manual';
}

// The detection script owns the profile catalog; this helper only renders its label in the HUD.
/**
 * @param {string} profileId - Id of the currently active detection profile.
 */
// EXAM: active detection profile label.
function setProfileStatus(profileId) {
  const profile = getProfile(profileId); // Fully resolved profile object so the UI can show its friendly label.
  if (profileVal) profileVal.textContent = profile.label;
}

// Firebase helpers normalize nullable values and safely walk nested RTDB snapshots.
/**
 * @param {*} value - Raw Firebase value.
 * @param {string} fallback - Placeholder used when the value is missing.
 * @returns {string} UI-friendly string value.
 */
// EXAM: Firebase value formatting.
function formatFirebaseValue(value, fallback) {
  // Convert truthy values to strings for the UI; otherwise fall back to a friendly placeholder.
  //condition ? ifTrue : ifFalse
  return value ? String(value) : (fallback || 'n/a');
}

/**
 * @param {*} value - Raw Firebase value that should contain a number.
 * @param {number|null} fallback - Value to use when parsing fails.
 * @returns {number|null} Parsed integer or fallback.
 */
// EXAM: Firebase numeric parsing.
function readFirebaseNumber(value, fallback) {
  // Firebase values can arrive as strings, so parse them as base-10 integers.
  const n = Number.parseInt(value, 10); // Parsed integer version of the raw Firebase value.
  // If parsing fails, preserve the caller's fallback value.
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object|null} data - Firebase snapshot converted to plain data.
 * @param {string|string[]} path - Nested path as an array or dotted string.
 * @param {*} fallback - Value returned when the path is missing.
 * @returns {*} Found value or fallback.
 */
// EXAM: nested Firebase path read.
function getFirebaseSnapshotValue(data, path, fallback) {
  // Accept either an array path like ['camera', 'state'] or a dotted string like 'camera.state'.
  const parts = Array.isArray(path) ? path : String(path || '').split('.'); // Ordered path segments used for nested lookup.
  // Start at the root snapshot object.
  let current = data; // Cursor that walks down the nested snapshot object.
  // Any missing branch short-circuits to the fallback instead of throwing on undefined access.
  // Walk through each segment of the path one by one.
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i]; // Current property name being looked up.
    // Ignore empty path pieces so accidental double dots do not break lookup.
    if (!key) continue;
    // If the path no longer matches the data shape, return the fallback immediately.
    if (!current || typeof current !== 'object' || !(key in current)) return fallback;
    // Move one level deeper into the snapshot object.
    current = current[key];
  }
  // Return the found value unless it is null/undefined, in which case use the fallback.
  return typeof current === 'undefined' || current === null ? fallback : current;
}

/**
 * @param {string} raw - Camera/controller URL from Firebase.
 * @returns {string} Normalized base URL string.
 */
// EXAM: Firebase URL normalization.
function normalizeFirebaseUrl(raw) {
  // Reuse the same URL normalization rules used for manually typed URLs.
  const normalized = normalizeBaseUrl(raw); // URL cleaned and expanded into a stable http://... form.
  // Always return a string so downstream UI code can rely on the type.
  return normalized || '';
}











/*
====================================================================
00-core.js — full exam explanation
====================================================================

what this file is:
this file is the base file of the control page.

it loads first.

the job of this file is to prepare shared things that the other files use:
- html elements from control.html
- storage keys
- shared runtime state
- controller state
- firebase state
- simple helper functions

this file does not run the ai model.
this file does not choose a target.
this file does not draw the target boxes by itself.
this file does not directly start the detection loop.

it gives the rest of the project the basic variables and helper functions they need.

====================================================================
basic javascript symbols used here
====================================================================

const:
creates a variable that cannot be reassigned later.
example:
const feedImg = $('cameraFeed');

that means feedImg will always refer to the same stored value.
but if the value is an object, the inside of the object can still change.

let:
creates a variable that can change later.
example:
let streamCandidates = [];

this is used when the value will be replaced or updated during runtime.

function:
creates reusable code.
example:
function clamp(value, min, max, fallback) {
  ...

the name is clamp.
the values 
 parentheses are parameters.
the code inside curly braces runs when the function is called.

=>:
arrow function.
example:
const $ = (id) => document.getElementById(id);

this means:
create a function that receives id and returns document.getElementById(id).

=:
assignment.
example:
let current = data;

this puts the value of data into current.

===:
strict comparison.
example:
state === 'danger'

checks if state is exactly the string 'danger'.

? and ::
ternary condition.
example:
state === 'danger' ? 'status-danger' : 'status-ok'

meaning:
if state is danger, use status-danger.
otherwise use status-ok.

||:
fallback OR.
example:
text || 'Idle'

meaning:
use text if it exists.
if text is empty, null, undefined, or false, use Idle.

&&:
AND.
example:
safetyDot && safetyVal

true only if both exist.

!:
NOT.
example:
if (!consolePanel) return;

meaning:
if consolePanel does not exist, stop the function.

null:
intentionally empty.
example:
config: null

means there is no config loaded yet.

[]:
array/list.
example:
let streamCandidates = [];

{}:
object with named properties.
example:
{
  config: null,
  calibration: {...}
}

.:
access property or function inside an object.
example:
document.getElementById(id)
means use getElementById from document.

return:
stops the function and sends a value back.

if:
runs code only when a condition is true.

while:
repeats while a condition is true.

for:
loop with a counter.

typeof:
checks the type of a value.
example:
typeof current !== 'object'

new:
creates a new object.
example:
new Date()

document:
the browser object representing the html page.

localStorage:
browser storage that stays saved after refresh.

====================================================================
$
====================================================================

code:
const $ = (id) => document.getElementById(id);

what it is:
$ is a short helper function.

it receives:
id

id means:
the id of an html element.

example:
$('cameraFeed')

same as:
document.getElementById('cameraFeed')

what it returns:
the html element if it exists.
null if it does not exist.

why it is useful:
instead of writing document.getElementById many times, the file writes $.

example:
const feedImg = $('cameraFeed');

this finds the html element:
id="cameraFeed"

====================================================================
ControllerState
====================================================================

this part is jsdoc documentation.
it does not run code.
it explains the expected shape of controllerState.

ControllerState contains:

config:
the controller configuration loaded from the esp32.
at the start it is null because the page has not fetched config yet.

calibration:
the saved observations from the operator.

xPositiveObserved:
what direction the rig physically moved when positive x was tested.
allowed values:
left
right
up
down
unknown

yPositiveObserved:
what direction the rig physically moved when positive y was tested.
allowed values:
left
right
up
down
unknown

why this matters:
servo wiring and physical mounting can reverse directions.
the code cannot assume that x positive really looks like right on the camera.
so the user records what actually happened.

====================================================================
FirebaseState
====================================================================

this is also jsdoc documentation.
it explains the expected shape of firebaseState.

syncStarted:
boolean.
false means firebase listener has not started yet.
true means it already started.

why:
prevents starting the same firebase listener multiple times.

unsubscribe:
reserved for future cleanup.
currently null in this file.

rootRef:
the firebase database root reference.
starts as null.
later can become db.ref('/');

autoAppliedCamera:
the last camera url that firebase automatically applied.

autoAppliedController:
the last controller url that firebase automatically applied.

lastSnapshot:
the last firebase data object received.

why firebaseState exists:
so the page remembers firebase listener status and does not keep applying the same firebase values again and again.

====================================================================
dom capture section
====================================================================

this section finds html elements and saves them in variables.

pattern:
const variableName = $('htmlId');

meaning:
find the html element with that id and store it.

if the element does not exist:
the value becomes null.

the rest of the code usually checks if the value exists before using it.

====================================================================
feedImg
====================================================================

code:
const feedImg = $('cameraFeed');

feedImg is the img element that displays the live camera stream.

expected html:
<img id="cameraFeed">

used for:
- showing esp32-cam video
- checking if the stream loaded
- reading naturalWidth and naturalHeight
- giving frames to the ai detector
- matching overlay size to the camera display

important:
without feedImg, detection cannot read camera frames.

====================================================================
placeholder
====================================================================

code:
const placeholder = $('cameraPlaceholder');

placeholder is the empty display shown when there is no active camera stream.

used when:
- stream is idle
- stream failed
- camera image is hidden

====================================================================
urlInput
====================================================================

code:
const urlInput = $('cameraUrlInput');

urlInput is the text box where the operator types the camera url.

examples:
10.12.22.5
http://10.12.22.5
http://10.12.22.5:81/stream

later, setStream uses this value to start the camera stream.

====================================================================
connectBtn
====================================================================

code:
const connectBtn = $('cameraConnectBtn');

connectBtn is the button that applies the camera url.

when clicked:
the init file reads urlInput.value and calls setStream.

====================================================================
statusLabel
====================================================================

code:
const statusLabel = $('cameraStatus');

statusLabel shows simple camera status text.

examples:
Stream idle
Streaming from http://...
Stream failed

====================================================================
esp32IpInput
====================================================================

code:
const esp32IpInput = $('esp32IpInput');

this is the text input for the controller esp32 url.

important:
this is not the esp32-cam.
this is the controller esp32 that receives movement and laser commands.

====================================================================
esp32ConnectBtn
====================================================================

code:
const esp32ConnectBtn = $('esp32ConnectBtn');

button that stores the controller url and starts controller sync.

later it can cause:
- syncLaserState()
- syncControllerConfig(true)

====================================================================
btnUp, btnDown, btnLeft, btnRight
====================================================================

these are the manual movement buttons.

btnUp:
button for visible up movement.

btnDown:
button for visible down movement.

btnLeft:
button for visible left movement.

btnRight:
button for visible right movement.

important:
the button name is what the operator wants to see on screen.
the real firmware command may be opposite because of servo direction.

example:
visible Left can send step_right.

====================================================================
btnStopCursor
====================================================================

manual stop movement button.

usually sends the stop command to the controller.

purpose:
stop servo/cursor movement.

====================================================================
fireBtn
====================================================================

manual laser on button.

it attempts to enable laser output through the controller.

====================================================================
stopLaserBtn
====================================================================

manual laser off button.

it attempts to disable laser output through the controller.

====================================================================
scanBtn
====================================================================

placeholder scan button.

the comment says the current http-only firmware does not support scan mode.

so this variable exists for ui compatibility or future use.

====================================================================
stopBtn
====================================================================

auto-follow toggle button.

the id is historical.
even though it is called stopBtn, it is used as Start/Stop Auto-Follow.

====================================================================
logoutBtn
====================================================================

top-bar logout button.

used by the auth/logout logic in init.

====================================================================
overlayCanvas
====================================================================

code:
const overlayCanvas = $('cameraOverlay');

this is the transparent canvas on top of the camera image.

used for:
- detection boxes
- center reticle
- target line
- simulated movement text

====================================================================
overlayCtx
====================================================================

code:
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;

meaning:
if overlayCanvas exists:
get its 2d drawing context.

if overlayCanvas does not exist:
use null.

overlayCtx is the object used to draw on the canvas.

why the check exists:
to avoid crashing if the html page does not contain cameraOverlay.

====================================================================
detectStatus
====================================================================

code:
const detectStatus = $('detectStatus');

badge showing detector status.

examples:
Detect idle
Detect: loading
Detect: clear
Detect: possible
Detect: target
Detect: error

====================================================================
consolePanel
====================================================================

code:
const consolePanel = $('console');

visible event log panel.

logConsole adds rows into this panel.

used for:
- stream messages
- controller messages
- detection messages
- firebase messages
- errors and warnings

====================================================================
safetyDot and safetyVal
====================================================================

safetyDot:
colored dot.

safetyVal:
text next to the dot.

states:
ok = safe
warn = scanning or possible problem
danger = air target detected

====================================================================
modeVal
====================================================================

shows current operator mode.

examples:
Manual
Observe

====================================================================
profileVal
====================================================================

shows the active detection profile label.

the profile data itself is owned by the detection settings file.

====================================================================
targetLabelVal
====================================================================

shows the selected target class.

example:
drone
aircraft
helicopter

====================================================================
targetScoreVal
====================================================================

shows target confidence percentage.

example:
87.4%

====================================================================
targetCenterVal
====================================================================

shows raw center coordinates of the selected detection box.

raw means before smoothing.

====================================================================
targetCenterFilteredVal
====================================================================

shows smoothed center coordinates.

filtered/smoothed center reduces jitter.

====================================================================
targetDeltaVal
====================================================================

shows pixel distance from screen center.

delta means difference.

example:
target is 40 pixels right of center.

====================================================================
targetDeltaNormVal
====================================================================

shows normalized distance from center.

normalized means converted to a stable range, usually around -1 to 1.

why:
different screen sizes can still be compared.

====================================================================
simCommandVal
====================================================================

shows simulated correction commands.

example:
LEFT_SMALL / UP_MED

meaning:
how the target should be moved/recentered according to the detector.

====================================================================
loopTimeVal
====================================================================

shows how long the last detection pass took.

usually in milliseconds.

====================================================================
firebaseSyncVal
====================================================================

shows firebase connection/listener status.

examples:
Idle
Listening
Live
Read failed

====================================================================
firebaseCameraVal
====================================================================

shows the camera url learned from firebase.

====================================================================
firebaseControllerVal
====================================================================

shows the controller url learned from firebase.

====================================================================
firebaseLaserVal
====================================================================

shows laser state learned from firebase.

examples:
On
Off
n/a

====================================================================
firebaseHomeVal
====================================================================

shows saved home position from firebase.

example:
90 / 90

usually means servo home x and home y.

====================================================================
detectBackendSelect
====================================================================

dropdown for choosing detector backend.

examples from later files:
COCO-SSD
AeroYOLO ONNX

backend means:
which ai detection engine runs.

====================================================================
detectProfileSelect
====================================================================

dropdown for choosing detection profile.

profile means:
which labels/classes are allowed to become tracked targets.

====================================================================
strongThresholdInput
====================================================================

numeric input for confirmed target confidence.

higher value:
less false alarms, but may miss weaker detections.

lower value:
more sensitive, but more false positives.

====================================================================
possibleThresholdInput
====================================================================

numeric input for possible target confidence.

this is weaker than strongThreshold.

used for warning state.

====================================================================
smoothingInput
====================================================================

numeric input for target smoothing strength.

smoothing reduces jitter in target center movement.

====================================================================
deadZoneInput
====================================================================

numeric input for center tolerance.

if target is inside dead zone:
movement guidance becomes HOLD.

meaning:
target is close enough to center.

====================================================================
downloadTelemetryBtn
====================================================================

button that downloads session telemetry as json.

telemetry means:
saved detection history from the current page session.

====================================================================
clearTelemetryBtn
====================================================================

button that clears telemetry memory.

====================================================================
assistMoveVal
====================================================================

operator assist field showing detector movement text.

example:
LEFT_SMALL / UP_MED

====================================================================
assistFrameVal
====================================================================

operator assist field showing where the target is in the frame.

example:
upper right
left
centered

====================================================================
assistButtonVal
====================================================================

operator assist field translating detector movement into actual button guidance.

example:
press Left 1 time.

====================================================================
assistCenterVal
====================================================================

operator assist field saying if target is centered or off-center.

====================================================================
refreshControllerConfigBtn
====================================================================

button that fetches controller config again from the esp32.

config can include:
x_dir
y_dir
homeX
homeY

====================================================================
centerRigBtn
====================================================================

button that asks the rig to return to its configured center position.

usually sends:
center

====================================================================
probeXPositiveBtn
====================================================================

button for a small positive x-axis test movement.

operator presses it and observes physical movement.

====================================================================
probeXNegativeBtn
====================================================================

button for a small negative x-axis test movement.

====================================================================
probeYPositiveBtn
====================================================================

button for a small positive y-axis test movement.

====================================================================
probeYNegativeBtn
====================================================================

button for a small negative y-axis test movement.

====================================================================
xObservedSelect
====================================================================

dropdown where the operator records what X+ physically did.

example:
if pressing X+ moved the rig left, choose left.

====================================================================
yObservedSelect
====================================================================

dropdown where the operator records what Y+ physically did.

====================================================================
saveCalibrationBtn
====================================================================

button that saves current calibration observations.

====================================================================
resetCalibrationBtn
====================================================================

button that clears saved calibration observations.

====================================================================
controllerConfigVal
====================================================================

readout showing parsed controller polarity/config values.

====================================================================
calibrationPanVal
====================================================================

readout explaining which axis is interpreted as pan.

pan means left/right movement.

====================================================================
calibrationTiltVal
====================================================================

readout explaining which axis is interpreted as tilt.

tilt means up/down movement.

====================================================================
calibrationButtonsVal
====================================================================

readout summarizing button-to-direction meaning.

====================================================================
STORAGE_KEY
====================================================================

code:
const STORAGE_KEY = 'skyshield_camera_base_url';

this is the localStorage key for the saved camera url.

why:
after refresh, the page can remember the last camera url.

====================================================================
ESP32_STORAGE_KEY
====================================================================

code:
const ESP32_STORAGE_KEY = 'esp32_ip';

this is the localStorage key for the saved controller esp32 url.

why:
after refresh, the page can remember the controller url.

====================================================================
ASSIST_CALIBRATION_STORAGE_KEY
====================================================================

code:
const ASSIST_CALIBRATION_STORAGE_KEY = 'skyshield_assist_calibration_v1';

this is the localStorage key for calibration notes.

v1 means version 1 of this storage format.

====================================================================
MAX_LOG_ROWS
====================================================================

code:
const MAX_LOG_ROWS = 250;

the visible console keeps maximum 250 rows.

why:
if log rows grew forever, the page could slow down.

====================================================================
CALIBRATION_PROBE_DELTA_DEG
====================================================================

code:
const CALIBRATION_PROBE_DELTA_DEG = 5;

calibration probe movement size is 5 degrees.

used by sendProbe in the transport file.

====================================================================
streamCandidates
====================================================================

code:
let streamCandidates = [];

list of possible camera stream urls.

example:
if user types:
http://10.12.22.5

the app might try:
http://10.12.22.5/stream
http://10.12.22.5

why:
different camera firmwares use different stream paths.

====================================================================
streamCandidateIndex
====================================================================

code:
let streamCandidateIndex = 0;

which stream url candidate is currently being tried.

0 means first candidate.
1 means second candidate.

====================================================================
isLaserOn
====================================================================

code:
let isLaserOn = false;

browser-side belief about laser state.

important:
this is not always guaranteed to be the real hardware truth.
it is updated from button actions, firebase, or controller status.

used for:
laser toggle fallback logic.

====================================================================
controllerState
====================================================================

code:
const controllerState = {
  config: null,
  calibration: {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  },
};

this object stores controller-related state.

config:
starts null.
later becomes esp32 controller config.

calibration:
stores what the user observed during physical calibration.

xPositiveObserved:
default unknown.
means the user has not yet recorded what X+ does.

yPositiveObserved:
default unknown.
means the user has not yet recorded what Y+ does.

why this object is const:
the variable controllerState should always point to the same object.
but the inside properties can still be updated.

====================================================================
firebaseState
====================================================================

code:
const firebaseState = {
  syncStarted: false,
  unsubscribe: null,
  rootRef: null,
  autoAppliedCamera: '',
  autoAppliedController: '',
  lastSnapshot: null,
};

syncStarted:
false at start.
true after firebase sync starts.

unsubscribe:
reserved for future listener cleanup.

rootRef:
firebase database reference.
starts null.

autoAppliedCamera:
last firebase camera url that was automatically applied.

autoAppliedController:
last firebase controller url that was automatically applied.

lastSnapshot:
last firebase snapshot data.

why:
keeps firebase sync organized and prevents duplicate behavior.

====================================================================
MANUAL_BUTTON_COMMANDS
====================================================================

code:
const MANUAL_BUTTON_COMMANDS = [
  { button: 'Left', command: 'step_right' },
  { button: 'Right', command: 'step_left' },
  { button: 'Up', command: 'servo_down' },
  { button: 'Down', command: 'servo_up' },
];

this array maps visible button labels to controller commands.

button:
what the operator sees/wants.

command:
the actual endpoint sent to esp32.

important:
they are intentionally opposite in some cases.

why:
because the physical rig orientation makes raw servo commands move opposite on screen.

example:
button Left sends command step_right.
that means step_right physically moves the target/camera left in this setup.

====================================================================
clamp(value, min, max, fallback)
====================================================================

purpose:
turn a raw value into a safe number inside an allowed range.

parameters:

value:
the raw thing to parse.
can be string or number.
examples:
"0.5"
0.5
"abc"
""

min:
lowest allowed result.

max:
highest allowed result.

fallback:
safe number to use if value is invalid.

code:
const n = Number.parseFloat(value);

meaning:
try to convert value into a decimal number.

examples:
Number.parseFloat("0.7") becomes 0.7
Number.parseFloat("abc") becomes NaN

code:
if (!Number.isFinite(n)) return fallback;

meaning:
if n is not a real valid number, return fallback.

Number.isFinite(n):
checks if n is a usable finite number.

!:
turns the result opposite.

code:
return Math.min(max, Math.max(min, n));

meaning:
keep n between min and max.

inner part:
Math.max(min, n)
prevents n from going below min.

outer part:
Math.min(max, ...)
prevents result from going above max.

example:
clamp(20, 0, 10, 5)
returns 10.

example:
clamp(-3, 0, 10, 5)
returns 0.

example:
clamp("abc", 0, 10, 5)
returns 5.

returns:
safe number.

====================================================================
logConsole(message, variant)
====================================================================

purpose:
adds a new message row to the visible console panel.

parameters:

message:
text to show.

variant:
optional css class for color/style.

examples:
text-info
text-warning
text-danger
text-success
text-muted

code:
if (!consolePanel) return;

meaning:
if the console element does not exist, stop.

why:
prevents crash on pages without console.

code:
const row = document.createElement('div');

meaning:
create a new div element in memory.
this div will become one log row.

code:
if (variant) row.className = variant;

meaning:
if a variant css class was provided, apply it to the row.

code:
row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

meaning:
set the visible text of the row.

new Date():
current date/time.

toLocaleTimeString():
turns current time into readable local time.

template string:
uses backticks and ${} to insert values.

example output:
[14:03:22] Detection loop started.

code:
consolePanel.appendChild(row);

meaning:
add the new row to the end of the console panel.

code:
while (consolePanel.children.length > MAX_LOG_ROWS) {
  consolePanel.removeChild(consolePanel.firstElementChild);
}

meaning:
while there are more than 250 rows:
remove the oldest row.

consolePanel.children.length:
number of child elements in console.

consolePanel.firstElementChild:
first row in the console.

removeChild:
removes that row from the html.

code:
consolePanel.scrollTop = consolePanel.scrollHeight;

meaning:
scroll console to the bottom so latest message is visible.

returns:
nothing.

====================================================================
setFirebaseStatus(text)
====================================================================

purpose:
updates the firebase status readout.

parameter:

text:
status text.

examples:
Idle
Listening
Live
SDK unavailable
Database unavailable

code:
if (firebaseSyncVal) firebaseSyncVal.textContent = text || 'Idle';

meaning:
if firebaseSyncVal element exists:
set its visible text.

text || 'Idle':
if text exists use text.
otherwise use Idle.

returns:
nothing.

====================================================================
setDetectStatus(text, variant)
====================================================================

purpose:
updates the detector status badge text and color.

parameters:

text:
visible text on the badge.

examples:
Detect idle
Detect: waiting
Detect: clear
Detect: possible
Detect: target

variant:
css/bootstrap classes.

examples:
bg-secondary
bg-success
bg-warning text-dark
bg-danger

code:
if (!detectStatus) return;

meaning:
if the badge element does not exist, stop.

code:
detectStatus.textContent = text;

meaning:
set the visible badge text.

code:
detectStatus.className = 'badge';

meaning:
reset all classes to only badge.

why:
old colors should not stay on the badge.

code:
(variant || 'bg-secondary').split(' ').forEach((cls) => detectStatus.classList.add(cls));

meaning:
if variant exists, use it.
otherwise use bg-secondary.

split(' '):
breaks a string into separate class names.

example:
'bg-warning text-dark'.split(' ')
becomes:
['bg-warning', 'text-dark']

forEach:
runs once for each class name.

cls:
current class name in the loop.

detectStatus.classList.add(cls):
adds that class to the badge.

returns:
nothing.

====================================================================
setSafetyState(state, text)
====================================================================

purpose:
updates safety dot color and safety text.

parameters:

state:
logical safety state.
allowed:
ok
warn
danger

text:
optional custom text.

code:
if (!(safetyDot && safetyVal)) return;

meaning:
if either safetyDot or safetyVal is missing, stop.

code:
safetyDot.classList.remove('status-ok', 'status-warn', 'status-danger');

meaning:
remove old safety color classes.

why:
the dot should only have the current state color.

code:
const cls = state === 'danger' ? 'status-danger' : state === 'warn' ? 'status-warn' : 'status-ok';

meaning:
choose css class according to state.

if state is danger:
use status-danger.

else if state is warn:
use status-warn.

otherwise:
use status-ok.

code:
safetyDot.classList.add(cls);

meaning:
apply the chosen color class to the dot.

code:
safetyVal.textContent = text || (state === 'danger' ? 'Air target detected' : state === 'warn' ? 'Scanning' : 'Safe');

meaning:
if custom text exists, show it.

otherwise:
danger -> Air target detected
warn -> Scanning
ok -> Safe

returns:
nothing.

====================================================================
setMode(text)
====================================================================

purpose:
updates the mode label.

parameter:

text:
mode label.

examples:
Manual
Observe

code:
if (modeVal) modeVal.textContent = text || 'Manual';

meaning:
if the mode element exists:
show text.
if text is empty:
show Manual.

returns:
nothing.

====================================================================
setProfileStatus(profileId)
====================================================================

purpose:
shows the active detection profile label in the hud.

parameter:

profileId:
id of the active detection profile.

example:
strict

code:
const profile = getProfile(profileId);

meaning:
call getProfile from the detection settings file.

important:
getProfile is not defined in this file.
it is defined in another file loaded later.

code:
if (profileVal) profileVal.textContent = profile.label;

meaning:
if profileVal element exists:
show the friendly label of the profile.

returns:
nothing.

dependency:
this works only when getProfile exists at runtime.

====================================================================
formatFirebaseValue(value, fallback)
====================================================================

purpose:
turns a firebase value into safe text for the ui.

parameters:

value:
raw firebase value.

fallback:
text to show when value is missing.

code:
return value ? String(value) : (fallback || 'n/a');

meaning:
if value is truthy:
convert it to string.

otherwise:
use fallback.
if fallback is also missing:
use n/a.

String(value):
converts value to text.

examples:
formatFirebaseValue('http://x')
returns 'http://x'

formatFirebaseValue('')
returns 'n/a'

formatFirebaseValue(null, 'empty')
returns 'empty'

returns:
string.

====================================================================
readFirebaseNumber(value, fallback)
====================================================================

purpose:
parses firebase value as an integer.

parameters:

value:
raw firebase value.

fallback:
value to return if parsing fails.

code:
const n = Number.parseInt(value, 10);

meaning:
try to parse value as base-10 integer.

10:
base 10 number system.

examples:
Number.parseInt('90', 10) returns 90.
Number.parseInt('abc', 10) returns NaN.

code:
return Number.isFinite(n) ? n : fallback;

meaning:
if n is a valid number, return n.
otherwise return fallback.

returns:
integer or fallback.

====================================================================
getFirebaseSnapshotValue(data, path, fallback)
====================================================================

purpose:
safely reads a nested value from firebase snapshot data.

why needed:
firebase data may be missing fields.
direct access like data.camera.state.urlBase could crash if camera is missing.
this function avoids that.

parameters:

data:
firebase snapshot converted to a normal object.

path:
where to look inside the object.

path can be:
array:
['camera', 'state', 'urlBase']

or dotted string:
'camera.state.urlBase'

fallback:
value returned if path does not exist.

code:
const parts = Array.isArray(path) ? path : String(path || '').split('.');

meaning:
if path is already an array, use it.

otherwise:
convert path to string and split it by dots.

path || '':
if path is missing, use empty string.

split('.'):
turns 'camera.state.urlBase' into:
['camera', 'state', 'urlBase']

code:
let current = data;

meaning:
start searching from the root object.

current is a cursor.
it moves deeper into the object on each loop.

code:
for (let i = 0; i < parts.length; i += 1) {

meaning:
loop through each path segment.

let i = 0:
start at first segment.

i < parts.length:
continue while there are still segments.

i += 1:
move to next segment after each loop.

code:
const key = parts[i];

meaning:
current path segment.

example:
camera
state
urlBase

code:
if (!key) continue;

meaning:
if key is empty, skip it.

why:
protects against accidental empty path pieces.

code:
if (!current || typeof current !== 'object' || !(key in current)) return fallback;

meaning:
return fallback if:
- current is missing
- current is not an object
- current does not contain this key

!(key in current):
means key is not found inside current.

code:
current = current[key];

meaning:
move one level deeper into the object.

example:
current = data['camera']
then current = camera['state']
then current = state['urlBase']

code:
return typeof current === 'undefined' || current === null ? fallback : current;

meaning:
after the loop:
if final value is undefined or null, return fallback.
otherwise return the found value.

returns:
found firebase value or fallback.

====================================================================
normalizeFirebaseUrl(raw)
====================================================================

purpose:
normalizes camera/controller url that came from firebase.

parameter:

raw:
raw url from firebase.

code:
const normalized = normalizeBaseUrl(raw);

meaning:
use the same normalization function as manually typed urls.

important:
normalizeBaseUrl is not defined in this file.
it is defined in the transport file.

it usually:
- trims spaces
- adds http:// if missing
- removes trailing slash

code:
return normalized || '';

meaning:
if normalized exists, return it.
otherwise return empty string.

returns:
string.

why:
downstream code can always expect a string, not null or undefined.

====================================================================
load order
====================================================================

00-core.js must load before the other control files.

why:
other files expect these names to already exist:
feedImg
overlayCanvas
overlayCtx
consolePanel
controllerState
firebaseState
STORAGE_KEY
ESP32_STORAGE_KEY
clamp
logConsole
setFirebaseStatus
setDetectStatus
setSafetyState
setMode
formatFirebaseValue
readFirebaseNumber
getFirebaseSnapshotValue
normalizeFirebaseUrl

if 00-core.js does not load first:
later files can throw ReferenceError because these variables/functions are missing.

====================================================================
simple exam summary
====================================================================

00-core.js is the shared foundation.

it connects javascript to html elements.
it stores shared state.
it stores localStorage keys.
it defines basic helpers for:
- number safety
- console logging
- firebase status
- detector badge status
- safety state
- mode label
- firebase value reading

the rest of the project builds on top of this file.

WHO-CALLS:
- html/control.html loads this file first.
- then 10-firebase.js, 20-calibration-and-target-guide.js, 30-transport.js, 40-init.js, 50-detection-state-settings.js, 60-calculate-target-position.js, 70-draw-target-overlay.js, 80-run-ai-models.js, 90-detection-loop.js, and 100-follow-automation.js all use the shared state and helpers from this file.
*/
