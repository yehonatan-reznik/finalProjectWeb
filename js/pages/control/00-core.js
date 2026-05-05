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
