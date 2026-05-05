const $ = (id) => document.getElementById(id);
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
const stopBtn = $('stopBtn'); // Stop button for halting automatic or continuous controller movement.
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
// Detection tuning controls: these feed directly into control-detection.js through shared helpers.
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
// This page keeps only stream/controller/Firebase state here; detection state lives in control-detection.js.
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
  autoAppliedCamera: false, // Guards against repeatedly overwriting the camera URL with Firebase data.
  autoAppliedController: false, // Guards against repeatedly overwriting the controller URL with Firebase data.
  lastSnapshot: null, // Last raw root snapshot data seen from Firebase.
};

// These are the operator-facing button labels that map to controller HTTP commands.
const MANUAL_BUTTON_COMMANDS = [
  { button: 'Left', command: 'step_left' }, // UI label Left triggers the firmware endpoint step_left.
  { button: 'Right', command: 'step_right' }, // UI label Right triggers the firmware endpoint step_right.
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
//keep a value inside allowed limits
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

// Every Firebase snapshot can update the HUD and optionally auto-fill camera/controller URLs.
/**
 * @param {object|null} data - Latest RTDB root snapshot data.
 */
// EXAM: Firebase snapshot application and auto-fill.
function applyFirebaseSnapshot(data) {
  // Function flow:
  // 1. Read the newest Firebase snapshot.
  // 2. Extract camera/controller URLs and optional state values.
  // 3. Mirror those values into the read-only dashboard cards.
  // 4. Update browser-side cached flags like isLaserOn.
  // 5. Auto-apply URLs only if this browser has no stronger local override.
  firebaseState.lastSnapshot = data || null;
  // Read the camera URL from the newer nested shape first, then fall back to the older flat keys.
  // Support both the newer nested RTDB structure and the older root-level fallback keys.
  const cameraUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['camera', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'cameraIP', '')
  ); // Best available camera URL from either the nested or legacy schema.
  // Do the same fallback lookup for the controller URL.
  const controllerUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['controller', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'espIP', '')
  ); // Best available controller URL from either the nested or legacy schema.
  // Remaining status values are optional and may not exist on every firmware/database revision.
  const laserValue = getFirebaseSnapshotValue(data, ['controller', 'state', 'laserOn'], getFirebaseSnapshotValue(data, 'laserOn', null)); // Optional laser state mirrored from Firebase.
  const homeX = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeX'], getFirebaseSnapshotValue(data, 'homeX', null)), null); // Optional saved home X coordinate.
  const homeY = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeY'], getFirebaseSnapshotValue(data, 'homeY', null)), null); // Optional saved home Y coordinate.

  // Mirror Firebase values into the read-only status cards before deciding whether anything should be auto-applied.
  if (firebaseCameraVal) firebaseCameraVal.textContent = formatFirebaseValue(cameraUrl);
  if (firebaseControllerVal) firebaseControllerVal.textContent = formatFirebaseValue(controllerUrl);
  if (firebaseLaserVal) firebaseLaserVal.textContent = laserValue === null || typeof laserValue === 'undefined' ? 'n/a' : (Number(laserValue) === 1 ? 'On' : 'Off');
  if (firebaseHomeVal) firebaseHomeVal.textContent = Number.isFinite(homeX) && Number.isFinite(homeY) ? `${homeX} / ${homeY}` : 'n/a';
  setFirebaseStatus('Live');

  // Keep the local laser flag synchronized even when the operator never pressed a laser button in this tab.
  if (laserValue !== null && typeof laserValue !== 'undefined') {
    isLaserOn = Number(laserValue) === 1;
  }

  // Only auto-apply Firebase values when the operator has not already saved a local override in this browser.
  if (!localStorage.getItem(STORAGE_KEY) && cameraUrl && !firebaseState.autoAppliedCamera) {
    firebaseState.autoAppliedCamera = true;
    if (urlInput) urlInput.value = cameraUrl;
    setStream(cameraUrl);
    logConsole(`Firebase camera URL loaded: ${cameraUrl}`, 'text-info');
  }

  if (!localStorage.getItem(ESP32_STORAGE_KEY) && controllerUrl && !firebaseState.autoAppliedController) {
    firebaseState.autoAppliedController = true;
    if (esp32IpInput) esp32IpInput.value = controllerUrl;
    localStorage.setItem(ESP32_STORAGE_KEY, controllerUrl);
    // Pull live status/config immediately after learning the controller URL from Firebase.
    syncLaserState();
    syncControllerConfig(false);
    logConsole(`Firebase controller URL loaded: ${controllerUrl}`, 'text-info');
  }
}


//async means the function works with things that take time, without freezing the page.

// The control page listens at the RTDB root because camera IP, controller IP, and boot config share the same tree.
// EXAM: Firebase listener startup.
function startFirebaseSync() {
  // Why this exists:
  // - The page wants one live source of truth for discovered device URLs and boot-time state.
  // - Firebase is used as discovery/sync, not as the movement transport layer.
  // - One root listener is enough because camera + controller data live in the same RTDB tree.
  // Prevent duplicate listeners if init() or auth callbacks run more than once.
  if (firebaseState.syncStarted) return;
  firebaseState.syncStarted = true;
  // Make sure the auth wrapper exists and exposes the database getter.
  if (!(window.SkyShieldAuth && typeof window.SkyShieldAuth.getDatabase === 'function')) {
    setFirebaseStatus('SDK unavailable');
    return;
  }
  // Ask the auth wrapper for the already-created RTDB instance.
  const db = window.SkyShieldAuth.getDatabase(); // Shared RTDB instance created by the auth/bootstrap layer.
  if (!db) {
    setFirebaseStatus('Database unavailable');
    return;
  }
  try {
    // Listen at the root because this project stores camera, controller, and config data together.
    firebaseState.rootRef = db.ref('/');
    firebaseState.rootRef.on('value', (snapshot) => {
      // Convert the snapshot into plain data before handing it to the UI updater.
      applyFirebaseSnapshot(snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null);
    }, (error) => {
      console.error('Firebase RTDB listener failed.', error);
      setFirebaseStatus('Read failed');
      // Mirror the error into the event console so the operator can see it without DevTools.
      if (error && error.message) logConsole(`Firebase read failed: ${error.message}`, 'text-warning');
    });
    // This page never detaches the listener during normal use because the control dashboard is effectively single-screen.
    setFirebaseStatus('Listening');
  } catch (err) {
    console.error('Failed to start Firebase RTDB sync.', err);
    setFirebaseStatus('Init failed');
  }
}

// Section: calibration and operator assist.
// Calibration helpers translate physical rig behavior into user-friendly manual hints.
/**
 * @param {string} value - Direction text from saved state or a select box.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Normalized direction.
 */
// EXAM: observed direction normalization.
function normalizeObservedDirection(value) {
  // Only four directions are valid in calibration notes; everything else becomes unknown.
  return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';
}

/**
 * @param {'left'|'right'|'up'|'down'|'unknown'} direction - Direction to flip.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Opposite direction.
 */
// EXAM: opposite direction helper.
function getOppositeDirection(direction) {
  // Calibration often needs the opposite physical movement when firmware polarity is reversed.
  switch (direction) {
    case 'left':
      return 'right';
    case 'right':
      return 'left';
    case 'up':
      return 'down';
    case 'down':
      return 'up';
    default:
      return 'unknown';
  }
}

/**
 * @param {'left'|'right'|'up'|'down'|'unknown'} direction - Observed movement direction.
 * @returns {'pan'|'tilt'|'unknown'} Which axis role that direction implies.
 */
// EXAM: axis role detection.
function axisRoleFromDirection(direction) {
  // Left/right movement describes the pan axis.
  if (direction === 'left' || direction === 'right') return 'pan';
  // Up/down movement describes the tilt axis.
  if (direction === 'up' || direction === 'down') return 'tilt';
  // Unknown directions cannot be mapped to an axis role.
  return 'unknown';
}

/**
 * @param {string} direction - Raw direction value.
 * @returns {string} Uppercase label for known directions.
 */
// EXAM: friendly direction text.
function friendlyDirection(direction) {
  // Uppercase known directions so the UI reads like a label, not like raw internal data.
  return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();
}

/**
 * @param {string} rawPositiveDirection - Physical movement caused by the axis's positive direction.
 * @param {number} signedFactor - Firmware polarity multiplier for the command being tested.
 * @returns {string} Derived movement direction caused by that command.
 */
// EXAM: firmware polarity to real movement.
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {
  // Start from the recorded "positive" physical movement for that firmware axis.
  const raw = normalizeObservedDirection(rawPositiveDirection); // Cleaned observed physical movement for the positive side of the axis.
  // If calibration is incomplete, we cannot derive a usable movement direction.
  if (raw === 'unknown') return 'unknown';
  // Positive factor keeps the direction; negative factor flips it.
  return signedFactor >= 0 ? raw : getOppositeDirection(raw);
}

/**
 * @param {string} label - Simulated movement label such as LEFT_SMALL or HOLD.
 * @returns {{label: string, direction: string, size: string, taps: number}} Parsed assist label.
 */
// EXAM: detector sim-label parsing.
function parseSimLabel(label) {
  // HOLD means the detector thinks no movement is needed on that axis.
  if (!label || label === 'HOLD') {
    return { label: 'HOLD', direction: 'hold', size: 'HOLD', taps: 0 };
  }
  // Split labels like LEFT_SMALL or UP_LARGE into separate pieces.
  const [directionRaw, sizeRaw] = String(label).split('_'); // Raw direction and magnitude pieces of a label like LEFT_SMALL.
  // Normalize case because UI labels and internal labels can vary.
  const direction = String(directionRaw || '').toLowerCase(); // Lowercased movement direction piece.
  const size = String(sizeRaw || 'SMALL').toUpperCase(); // Uppercased movement size piece.
  // Translate qualitative size into how many manual button taps the operator should make.
  const taps = size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1; // Suggested button-tap count for the assist panel.
  return { label, direction, size, taps };
}

/**
 * Reads the two calibration dropdowns from the page and stores them in controllerState.
 */
// EXAM: read calibration from UI.
function readCalibrationFromControls() {
  // Read the two select boxes from the page and store them in shared calibration state.
  controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);
  controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);
}

/**
 * Pushes the saved calibration state back into the dropdowns.
 */
// EXAM: write calibration to UI.
function writeCalibrationControls() {
  // Push the saved calibration state back into the select boxes when the page loads or resets.
  if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
}

/**
 * Loads saved calibration notes from localStorage.
 */
// EXAM: load saved calibration.
function loadCalibration() {
  // Start with no saved object.
  let saved = null; // Parsed calibration JSON before it is validated and normalized.
  try {
    // Read the calibration JSON from localStorage if it exists.
    saved = JSON.parse(localStorage.getItem(ASSIST_CALIBRATION_STORAGE_KEY) || 'null');
  } catch (err) {
    // If the stored JSON is damaged, ignore it and keep defaults instead of crashing the page.
    console.warn('Failed to parse saved calibration.', err);
  }
  // Rebuild the calibration object with safe normalized values.
  controllerState.calibration = {
    xPositiveObserved: normalizeObservedDirection(saved && saved.xPositiveObserved),
    yPositiveObserved: normalizeObservedDirection(saved && saved.yPositiveObserved),
  };
  // Reflect the loaded values into the visible form controls.
  writeCalibrationControls();
}

/**
 * @param {boolean} logChange - Whether to write a confirmation line to the event console.
 */
// EXAM: save calibration.
function saveCalibration(logChange) {
  // First copy the current dropdown selections into shared state.
  readCalibrationFromControls();
  // Persist that state into localStorage so it survives refreshes.
  localStorage.setItem(ASSIST_CALIBRATION_STORAGE_KEY, JSON.stringify(controllerState.calibration));
  if (logChange) {
    // Optionally show a log line so the operator knows the notes were actually saved.
    logConsole(`Calibration saved: X+=${friendlyDirection(controllerState.calibration.xPositiveObserved)}, Y+=${friendlyDirection(controllerState.calibration.yPositiveObserved)}`, 'text-info');
  }
}

/**
 * Clears saved calibration notes and resets the dropdowns to unknown.
 */
// EXAM: reset calibration.
function resetCalibration() {
  // Restore the default "unknown" state for both observed positive directions.
  controllerState.calibration = {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  };
  // Remove the saved copy so refreshes also start from a clean state.
  localStorage.removeItem(ASSIST_CALIBRATION_STORAGE_KEY);
  // Update the dropdowns to match the reset state.
  writeCalibrationControls();
}

/**
 * @param {*} value - Controller config field that should contain an integer.
 * @param {number} fallback - Value used when parsing fails.
 * @returns {number} Parsed config value.
 */
// EXAM: controller config parsing.
function getControllerConfigNumber(value, fallback) {
  // Controller config values also arrive as strings, so parse them as integers.
  const n = Number.parseInt(value, 10); // Parsed integer config value from the firmware response.
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @returns {{
 *   xObserved: string,
 *   yObserved: string,
 *   xRole: string,
 *   yRole: string,
 *   xDir: number,
 *   yDir: number,
 *   commands: Object,
 *   panSummary: string,
 *   tiltSummary: string,
 *   buttonSummary: string
 * }} Derived calibration interpretation used by the UI.
 */
// EXAM: derive calibration and manual meaning.
function deriveCalibration() {
  // Function goal:
  // - Take two operator observations: what X+ physically did and what Y+ physically did.
  // - Combine them with firmware polarity flags x_dir / y_dir.
  // - Deduce what each real HTTP command will do in physical screen space.
  // - Build short UI summaries that explain pan, tilt, and button meaning.
  // Read the operator's observed motion notes for the two positive directions.
  const xObserved = normalizeObservedDirection(controllerState.calibration.xPositiveObserved); // Physical motion observed when probing X positive.
  const yObserved = normalizeObservedDirection(controllerState.calibration.yPositiveObserved); // Physical motion observed when probing Y positive.
  // Infer which physical axis each observation most likely belongs to.
  const xRole = axisRoleFromDirection(xObserved); // Whether X behaved like pan, tilt, or unknown.
  const yRole = axisRoleFromDirection(yObserved); // Whether Y behaved like pan, tilt, or unknown.
  // Read firmware direction multipliers, defaulting to normal polarity if config is missing.
  const xDir = getControllerConfigNumber(controllerState.config && controllerState.config.x_dir, 1); // Firmware polarity multiplier for X.
  const yDir = getControllerConfigNumber(controllerState.config && controllerState.config.y_dir, 1); // Firmware polarity multiplier for Y.
  // Convert raw axis direction plus firmware polarity into the practical movement caused by each HTTP command.
  // Example: if X positive physically moves LEFT, then a negative-X command should move RIGHT.
  const commands = { // Real movement direction caused by each firmware endpoint after calibration + polarity are applied.
    step_right: commandDirectionFromRawPositive(xObserved, xDir),
    step_left: commandDirectionFromRawPositive(xObserved, -xDir),
    servo_up: commandDirectionFromRawPositive(yObserved, yDir),
    servo_down: commandDirectionFromRawPositive(yObserved, -yDir),
  };

  let panSummary = 'unknown'; // Human-readable summary of which axis currently appears to be pan.
  // If the observed X motion behaved like left/right, X is the pan axis.
  if (xRole === 'pan') panSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like left/right, then Y must be pan.
  else if (yRole === 'pan') panSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  let tiltSummary = 'unknown'; // Human-readable summary of which axis currently appears to be tilt.
  // If the observed X motion behaved like up/down, X is the tilt axis.
  if (xRole === 'tilt') tiltSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like up/down, then Y must be tilt.
  else if (yRole === 'tilt') tiltSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  // Turn the per-command movement map into one short summary string for the status card.
  const buttonSummary = MANUAL_BUTTON_COMMANDS
    .map(({ button, command }) => `${button}=${friendlyDirection(commands[command])}`)
    .join(' | '); // One compact string explaining what every visible manual button really does.

  return { xObserved, yObserved, xRole, yRole, xDir, yDir, commands, panSummary, tiltSummary, buttonSummary };
}

/**
 * @param {string} direction - Desired physical movement direction.
 * @param {object} derived - Result object from deriveCalibration().
 * @returns {{button: string, command: string}|null} Matching manual button mapping.
 */
// EXAM: map desired movement to manual button.
function findManualButtonForDirection(direction, derived) {
  // Normalize the requested movement first so invalid inputs collapse to unknown.
  const target = normalizeObservedDirection(direction); // Cleaned desired movement direction requested by assist logic.
  if (target === 'unknown') return null;
  // Search the known button-command list for the one that would move in the requested direction.
  return MANUAL_BUTTON_COMMANDS.find(({ command }) => derived.commands[command] === target) || null;
}

/**
 * @param {string} axisName - Human-readable axis name such as Pan or Tilt.
 * @param {{direction: string, size: string, taps: number}|null} parsedLabel - Parsed sim label.
 * @param {object} derived - Result object from deriveCalibration().
 * @returns {string} Operator-friendly hint for that axis.
 */
// EXAM: operator assist axis text.
function formatAxisAssist(axisName, parsedLabel, derived) {
  // HOLD means this axis is already centered enough and needs no movement hint.
  if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;
  const button = findManualButtonForDirection(parsedLabel.direction, derived); // Best manual button mapping for the requested physical direction.
  // Build a human-readable movement label even if calibration is unfinished.
  const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`; // Fallback detector-language text if no calibrated button exists.
  // If calibration is incomplete, tell the operator that this is only a rough movement label.
  if (!button) return `${axisName}: ${moveText} (finish calibration)`;
  // Otherwise convert the detector hint into an actual button and tap count.
  return `${axisName}: ${button.button} x${parsedLabel.taps}`;
}

// This helper gives a neutral "frame position" description without turning it into automatic actuation.
/**
 * @param {number} normX - Horizontal normalized offset from -1 to 1.
 * @param {number} normY - Vertical normalized offset from -1 to 1.
 * @param {number} deadZone - Center tolerance used by the assist logic.
 * @returns {string} Plain-language frame position summary.
 */
// EXAM: target position description.
function describeFramePosition(normX, normY, deadZone) {
  const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : ''; // Horizontal phrase derived from X offset.
  const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : ''; // Vertical phrase derived from Y offset.
  if (!horizontal && !vertical) return 'Centered';
  if (vertical && horizontal) return `${vertical}-${horizontal} of center`;
  return `${vertical || horizontal} of center`;
}

/**
 * Rebuilds the calibration status card from the latest controller config and saved observations.
 */
// EXAM: calibration readout UI.
function updateCalibrationReadouts() {
  const derived = deriveCalibration(); // Current interpreted calibration result used to populate the setup card.
  if (controllerConfigVal) {
    setReadout(controllerConfigVal, controllerState.config ? `x_dir=${derived.xDir}, y_dir=${derived.yDir}` : 'n/a');
  }
  // These three summaries are what the operator actually needs during setup: which axis is pan, which is tilt, and which button moves where.
  setReadout(calibrationPanVal, derived.panSummary);
  setReadout(calibrationTiltVal, derived.tiltSummary);
  setReadout(calibrationButtonsVal, derived.buttonSummary);
}

// Operator Assist is UI-only; it reads simulated pan/tilt output from the detection tracking state.
/**
 * Rebuilds the assist card from the current target tracking state.
 */
// EXAM: operator assist readout.
function updateOperatorAssistReadout() {
  // Function flow:
  // 1. Read the latest calibration interpretation.
  // 2. Read the latest detector tracking state.
  // 3. If there is no target, show idle/setup guidance.
  // 4. If there is a target, convert detector hints into frame-position text.
  // 5. If calibration is complete, translate those hints into real button presses.
  const derived = deriveCalibration(); // Current calibration interpretation used to translate detector hints into physical buttons.
  const settings = getSettings(); // Current detector settings needed for dead-zone-aware frame descriptions.
  // If there is no active target, fill the assist panel with idle guidance.
  if (!trackingState.hasTarget) {
    setReadout(assistMoveVal, 'No target');
    setReadout(assistFrameVal, 'No target');
    setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');
    setReadout(assistCenterVal, 'Not centered');
    return;
  }

  const panAssist = parseSimLabel(trackingState.simPanLabel); // Parsed simulated pan movement from detector state.
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel); // Parsed simulated tilt movement from detector state.
  // The target is considered centered only when both axes say HOLD.
  const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold'; // True only when neither axis requires movement.
  // Build a plain-language description of where the target sits in the frame.
  const framePosition = describeFramePosition(trackingState.filteredNormX, trackingState.filteredNormY, settings.deadZone); // Plain-language frame-location summary.

  if (centered) {
    // When both axes are in the dead zone, the panel intentionally shifts from movement advice to confirmation.
    setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');
    setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);
    setReadout(assistButtonVal, 'Hold position');
    setReadout(assistCenterVal, 'Centered');
    return;
  }

  const moveParts = []; // Detector-style movement instructions combined for the assist card.
  // Add a pan instruction only when the simulated pan axis needs movement.
  if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);
  // Add a tilt instruction only when the simulated tilt axis needs movement.
  if (tiltAssist.direction !== 'hold') moveParts.push(`TILT ${friendlyDirection(tiltAssist.direction)}_${tiltAssist.size}`);
  setReadout(assistMoveVal, moveParts.join(' / '));
  setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);

  const buttonParts = []; // Concrete manual-button instructions combined for the assist card.
  // The raw PAN/TILT hint is useful, but the operator really needs a concrete manual button sequence here.
  if (panAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Pan', panAssist, derived));
  if (tiltAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Tilt', tiltAssist, derived));
  setReadout(assistButtonVal, buttonParts.join(' / '));
  setReadout(assistCenterVal, trackingState.isPossible ? 'Off-center (possible)' : 'Off-center');
}

// Section: camera stream and controller transport.
// Lightweight formatting helpers are shared with the detection overlay script.
/**
 * @param {HTMLElement|null} el - DOM node whose text should be replaced.
 * @param {string} text - Text to show in that node.
 */
// EXAM: safe text write helper.
function setReadout(el, text) {
  // Most status spans are optional, so guard the DOM write.
  if (el) el.textContent = text;
}

/**
 * @param {number} x - X coordinate in pixels.
 * @param {number} y - Y coordinate in pixels.
 * @returns {string} Rounded pixel pair.
 */
// EXAM: point formatting.
function formatPoint(x, y) {
  // Show pixel positions as rounded whole numbers.
  return `${x.toFixed(0)}, ${y.toFixed(0)}`;
}

/**
 * @param {number} x - Normalized horizontal value.
 * @param {number} y - Normalized vertical value.
 * @returns {string} Two-decimal normalized pair.
 */
// EXAM: normalized coordinate formatting.
function formatNorm(x, y) {
  // Show normalized offsets with two decimals for readability.
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

// Camera stream URLs are normalized once so the retry logic can try `/stream` and the raw origin consistently.
/**
 * @param {string} raw - User-typed or Firebase-provided URL.
 * @returns {string} Normalized base URL.
 */
// EXAM: controller/camera base URL normalization.
function normalizeBaseUrl(raw) {
  let url = (raw || '').trim(); // Trimmed operator-entered URL before protocol normalization.
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  // Strip trailing slashes so later endpoint joins stay stable.
  return url.replace(/\/+$/, '');
}

/**
 * @param {string} normalized - Already-normalized camera base URL.
 * @returns {string[]} Ordered list of stream URL candidates to try.
 */
// EXAM: stream fallback candidate list.
function buildStreamCandidates(normalized) {
  try {
    // Parse the URL once so we can inspect origin and path safely.
    const u = new URL(normalized); // Parsed URL object used to safely inspect origin and pathname.
    // Try the user-supplied path first, then common stream fallbacks.
    if (u.pathname && u.pathname !== '/') return [...new Set([normalized, u.origin + '/stream', u.origin])];
    // If the user typed only the base host, try the standard /stream path first.
    return [normalized + '/stream', normalized];
  } catch (err) {
    console.error('Invalid camera URL', err);
    return [];
  }
}

/**
 * Ensures the image element requests the stream with CORS enabled so canvas reads work.
 */
// EXAM: camera CORS mode.
function configureFeedCorsMode() {
  // The detector reads pixels from the image, so the image must be requested with CORS enabled.
  if (feedImg) feedImg.crossOrigin = 'anonymous';
}

// Stream setup only manages image source and detection loop lifecycle; the detector itself lives in control-detection.js.
/**
 * @param {string} baseUrl - Camera base URL or stream URL.
 * @returns {string} Normalized base URL when successful, otherwise an empty string.
 */
// EXAM: camera stream startup and retry state.
function setStream(baseUrl) {
  // Function flow:
  // 1. Normalize the camera URL into one stable base form.
  // 2. If empty, tear everything down and return to idle.
  // 3. If valid, build a short list of fallback stream URLs.
  // 4. Point the shared <img> element at the first candidate.
  // 5. Update HUD state and save the normalized base URL.
  // Normalize typed or Firebase-provided URLs into one consistent format.
  const normalized = normalizeBaseUrl(baseUrl); // Canonicalized camera URL used for stream setup and local persistence.
  if (!normalized) {
    streamCandidates = [];
    streamCandidateIndex = 0;
    // An empty URL means the operator wants to fully tear down the current stream session.
    // Clearing the stream also resets the detector and HUD so the page visibly returns to an idle state.
    if (feedImg) {
      feedImg.src = '';
      feedImg.classList.add('d-none');
    }
    if (placeholder) placeholder.classList.remove('d-none');
    setReadout(statusLabel, 'Stream idle');
    localStorage.removeItem(STORAGE_KEY);
    stopDetectionLoop('idle');
    clearTargetTelemetry();
    setMode('Manual');
    return '';
  }
  configureFeedCorsMode();
  // Build a short retry list so the page can try common stream URL variations automatically.
  streamCandidates = buildStreamCandidates(normalized);
  streamCandidateIndex = 0;
  const first = streamCandidates[0]; // First stream candidate attempted immediately.
  if (!first) return '';
  // Point the image element at the first candidate stream URL.
  feedImg.src = first;
  feedImg.classList.remove('d-none');
  if (placeholder) placeholder.classList.add('d-none');
  setReadout(statusLabel, `Streaming from ${first}`);
  setDetectStatus('Detect: waiting', 'bg-secondary');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole(`Attempting camera stream: ${first}`, 'text-muted');
  // Store the normalized base URL instead of the first candidate so future retries can be rebuilt consistently.
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

// Controller communication stays direct over local HTTP so movement remains local and low-latency.
/**
 * @param {string} cmd - Controller endpoint suffix such as status or step_left.
 * @returns {Promise<Response|null>} Fetch response when available, otherwise null.
 */
// EXAM: direct ESP32 HTTP command send.
function sendCmd(cmd) {
  // Function flow:
  // 1. Read the saved controller base URL.
  // 2. Send one direct HTTP request to that ESP32 endpoint.
  // 3. If the controller answered with an error, log a readable reason.
  // 4. If the network call itself failed, log a connection-level failure.
  // 5. Return the Response so callers can parse status/config bodies themselves.
  // Read the last saved controller base URL from localStorage.
  const ip = localStorage.getItem(ESP32_STORAGE_KEY); // Saved ESP32 base URL used for direct HTTP commands.
  if (!ip) {
    alert('Set the ESP32 address first.');
    return Promise.resolve(null);
  }
  // Local direct HTTP keeps manual control independent from Firebase round trips.
  return fetch(`${ip}/${cmd}`, { cache: 'no-store' })
    .then(async (res) => {
      // Success responses are returned untouched; only the error path needs extra explanation/logging.
      // If the controller answered with an error code, try to extract a useful message.
      if (!res.ok) {
        try {
          // Clone the response before reading its body so the original response can still be returned.
          const text = await res.clone().text(); // Response body copied for console-friendly error reporting.
          let message = text; // Human-readable error text eventually shown in the event console.
          try {
            // Prefer a structured JSON error if the controller returned one.
            const payload = JSON.parse(text); // Structured JSON error payload when the firmware provides one.
            if (payload && payload.error) message = payload.error;
          } catch (err) {
            // Keep raw response text when the controller returns non-JSON content.
          }
          logConsole(`Controller rejected ${cmd}: ${message}`, 'text-warning');
        } catch (err) {
          console.warn(`Failed to read controller error for ${cmd}.`, err);
        }
      }
      return res;
    })
    .catch((err) => {
      // Network errors end up here, for example when the controller host is offline.
      console.error(`Command ${cmd} failed:`, err);
      logConsole(`Controller command failed: ${cmd}`, 'text-danger');
      return null;
    });
}

/**
 * @param {string} text - Raw controller status body.
 * @returns {{laser: number|null, x: number|null, y: number|null}|object|null} Parsed status object.
 */
// EXAM: parse controller status response.
function parseControllerStatusText(text) {
  // Empty status bodies are treated as unusable.
  if (!text) return null;
  try {
    // Newer firmware answers with JSON, so try that first.
    return JSON.parse(text);
  } catch (err) {
    // Older firmware responses can be plain text, so keep a regex fallback.
    const laserMatch = text.match(/laser[:=](\d)/i); // Regex match for legacy plain-text laser state.
    const xMatch = text.match(/x[:=](-?\d+)/i); // Regex match for legacy plain-text X position.
    const yMatch = text.match(/y[:=](-?\d+)/i); // Regex match for legacy plain-text Y position.
    return {
      laser: laserMatch ? Number.parseInt(laserMatch[1], 10) : null,
      x: xMatch ? Number.parseInt(xMatch[1], 10) : null,
      y: yMatch ? Number.parseInt(yMatch[1], 10) : null,
    };
  }
}

/**
 * @param {boolean} logSuccess - Whether to write a success message to the event console.
 * @returns {Promise<object|null>} Parsed controller config object.
 */
// EXAM: fetch controller config.
function syncControllerConfig(logSuccess) {
  // Why this matters:
  // - The detector can say "move left", but the page still needs to know which HTTP command really moves left.
  // - That depends on firmware polarity values such as x_dir and y_dir.
  // - So the UI refreshes calibration/assist cards immediately after config is fetched.
  // Ask the controller for its current config so calibration hints match the real firmware state.
  return sendCmd('config').then(async (res) => {
    if (!res || !res.ok) {
      // Clear the cached config when the request fails so the UI does not show stale values.
      controllerState.config = null;
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      return null;
    }
    try {
      // Parse the JSON config body and cache it for later helper functions.
      controllerState.config = await res.json();
      // These readouts depend on controller polarity, so update them immediately after new config arrives.
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      if (logSuccess) logConsole(`Controller config loaded: x_dir=${getControllerConfigNumber(controllerState.config.x_dir, 1)}, y_dir=${getControllerConfigNumber(controllerState.config.y_dir, 1)}`, 'text-info');
      return controllerState.config;
    } catch (err) {
      console.error('Failed to parse controller config.', err);
      // Parsing failure is treated the same as a missing config.
      controllerState.config = null;
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      if (logSuccess) logConsole('Controller config parse failed.', 'text-warning');
      return null;
    }
  });
}

/**
 * @returns {Promise<void>} Completes after the laser state cache is refreshed.
 */
// EXAM: laser state sync.
async function syncLaserState() {
  // Read the live status endpoint so the UI knows whether the laser is already on.
  const res = await sendCmd('status'); // Raw HTTP response from the controller status endpoint.
  if (!res || !res.ok) return;
  const text = await res.text(); // Body text of the status response, regardless of JSON or plain-text format.
  const status = parseControllerStatusText(text); // Parsed internal status object in a stable shape.
  if (!status) return;
  // This flag lets the UI decide when the old toggle endpoint still needs to be used as a fallback.
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
}

/**
 * @param {'x'|'y'} axis - Axis to nudge during calibration.
 * @param {number} sign - Positive or negative direction for the nudge.
 * @returns {Promise<void>} Completes after the probe request finishes.
 */
// EXAM: calibration probe command.
async function sendProbe(axis, sign) {
  // Convert the requested axis/sign pair into a small +/- degree nudge command.
  const delta = sign > 0 ? CALIBRATION_PROBE_DELTA_DEG : -CALIBRATION_PROBE_DELTA_DEG; // Signed degree step sent for the probe.
  const query = axis === 'x' ? `nudge?dx=${delta}` : `nudge?dy=${delta}`; // Firmware endpoint query string for the selected axis/sign.
  const res = await sendCmd(query); // Response returned by the calibration probe request.
  if (!res || !res.ok) return;
  logConsole(`Calibration probe sent: ${axis.toUpperCase()}${sign > 0 ? '+' : '-'} (${delta > 0 ? '+' : ''}${delta} deg)`, 'text-info');
}

// Telemetry is recorded by the detection loop and downloaded here as a JSON file for later review.
/**
 * Downloads the in-memory telemetry array as a JSON file.
 */
// EXAM: telemetry JSON export.
function downloadTelemetry() {
  if (!sessionTelemetry.length) return logConsole('No telemetry to download yet.', 'text-warning');
  // Serialize the current session into nicely formatted JSON for later study.
  const blob = new Blob([JSON.stringify(sessionTelemetry, null, 2)], { type: 'application/json' }); // Generated JSON file content wrapped as a browser Blob.
  // Turn that blob into a temporary object URL that the browser can download.
  const url = URL.createObjectURL(blob); // Temporary browser URL pointing to the generated telemetry file.
  // Create a temporary link because browsers trigger downloads most reliably through a clicked <a>.
  const a = document.createElement('a'); // Temporary anchor element used to trigger download.
  a.href = url;
  a.download = `skyshield-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Section: page bootstrap and event wiring.
// init wires together the UI once both control.js and control-detection.js have loaded.
/**
 * Wires the control page UI, restores saved settings, and starts auth/Firebase flow.
 */
// EXAM: control page bootstrap.
function init() {
  // Startup order matters:
  // 1. Reset visible HUD state.
  // 2. Restore persisted detection/calibration settings.
  // 3. Rebuild readouts that depend on that restored state.
  // 4. Attach event listeners.
  // 5. Rehydrate saved URLs and start Firebase/auth integration.
  // Reset HUD state first so the page always starts from a known baseline.
  clearTargetTelemetry();
  loadSettings();
  loadCalibration();
  // The old proxy mode is no longer used, so clear that legacy flag on startup.
  localStorage.removeItem('skyshield_camera_proxy_enabled');
  updateCalibrationReadouts();
  updateOperatorAssistReadout();

  // When backend/profile dropdowns change, save them and clear old tracking state.
  [detectBackendSelect, detectProfileSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      clearTargetTelemetry();
      // These globals live in control-detection.js and suppress stale state labels across backend/profile switches.
      lastDetectState = '';
      lastDetectLabel = '';
      const settings = getSettings(); // Fresh settings snapshot used only for the change log line.
      // Backend/profile changes can invalidate the current target lock, so the HUD is cleared.
      logConsole(`Detection mode updated: ${settings.backend.label}, ${settings.profile.label}`, 'text-info');
    });
  });

  [strongThresholdInput, possibleThresholdInput, smoothingInput, deadZoneInput].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      const settings = getSettings(); // Fresh settings snapshot used only for the tuning-change log line.
      // These values directly affect confidence filtering and the simulated move hint.
      logConsole(`Detection settings updated: ${settings.backend.label}, ${settings.profile.label}, strong=${settings.strongThreshold.toFixed(2)}, possible=${settings.possibleThreshold.toFixed(2)}, alpha=${settings.smoothingAlpha.toFixed(2)}, deadZone=${settings.deadZone.toFixed(2)}`, 'text-info');
    });
  });

  if (downloadTelemetryBtn) downloadTelemetryBtn.addEventListener('click', downloadTelemetry);
  if (clearTelemetryBtn) {
    clearTelemetryBtn.addEventListener('click', () => {
      // Reuse the same telemetry array object and just empty it in place.
      sessionTelemetry.length = 0;
      logConsole('Session telemetry cleared.', 'text-muted');
    });
  }

  // Calibration listener group:
  // - dropdown changes keep controllerState.calibration in sync
  // - save/reset buttons let the operator explicitly persist or clear observations
  // - refresh/probe/center buttons talk to the real controller hardware
  // Keep calibration state and readouts synced whenever either observed-direction dropdown changes.
  [xObservedSelect, yObservedSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveCalibration(false);
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
    });
  });

  if (saveCalibrationBtn) {
    saveCalibrationBtn.addEventListener('click', () => {
      saveCalibration(true);
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
    });
  }

  if (resetCalibrationBtn) {
    resetCalibrationBtn.addEventListener('click', () => {
      resetCalibration();
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      logConsole('Calibration notes cleared.', 'text-muted');
    });
  }

  if (refreshControllerConfigBtn) refreshControllerConfigBtn.addEventListener('click', () => syncControllerConfig(true));
  if (centerRigBtn) {
    centerRigBtn.addEventListener('click', async () => {
      // Ask the controller to move back to its configured center position.
      const res = await sendCmd('center'); // Response returned by the controller center command.
      if (res && res.ok) logConsole('Rig centered for calibration.', 'text-info');
    });
  }
  // These four probe buttons send tiny nudges so the operator can observe real physical motion.
  if (probeXPositiveBtn) probeXPositiveBtn.addEventListener('click', () => sendProbe('x', 1));
  if (probeXNegativeBtn) probeXNegativeBtn.addEventListener('click', () => sendProbe('x', -1));
  if (probeYPositiveBtn) probeYPositiveBtn.addEventListener('click', () => sendProbe('y', 1));
  if (probeYNegativeBtn) probeYNegativeBtn.addEventListener('click', () => sendProbe('y', -1));

  // Refresh the placeholder text so the page always shows the expected URL format.
  if (urlInput) urlInput.placeholder = 'http://camera-ip:port/stream';
  if (esp32IpInput) esp32IpInput.placeholder = 'http://10.12.22.6';

  if (connectBtn && urlInput) {
    // Clicking Set tries to start the stream; if normalization fails, show a simple alert.
    connectBtn.addEventListener('click', () => !setStream(urlInput.value) && alert('Enter a valid camera URL (e.g., http://10.0.0.12/stream)'));
  }
  // Pressing Enter in the camera input triggers the same action as clicking Set.
  if (urlInput) urlInput.addEventListener('keyup', (event) => event.key === 'Enter' && connectBtn && connectBtn.click());

  // Controller URL group:
  // - normalize and save the base URL
  // - immediately fetch live laser state and controller config
  // - let Enter behave like the visible Connect button
  if (esp32ConnectBtn && esp32IpInput) {
    esp32ConnectBtn.addEventListener('click', () => {
      const normalized = normalizeBaseUrl(esp32IpInput.value); // Canonicalized controller URL entered by the operator.
      if (!normalized) return alert('Enter the ESP32 IP (e.g., http://10.12.22.6)');
      esp32IpInput.value = normalized;
      localStorage.setItem(ESP32_STORAGE_KEY, normalized);
      // Once the operator confirms the controller URL, sync both state and config right away.
      syncLaserState();
      syncControllerConfig(true);
    });
  }
  // Pressing Enter in the controller input behaves like clicking Connect.
  if (esp32IpInput) esp32IpInput.addEventListener('keyup', (event) => event.key === 'Enter' && esp32ConnectBtn && esp32ConnectBtn.click());

  // Manual command group:
  // These button handlers are intentionally thin.
  // The visible labels are operator-friendly, while the sent command names match the firmware API.
  // Direction buttons map directly to the firmware's HTTP command names.
  if (btnUp) btnUp.addEventListener('click', () => sendCmd('servo_down'));
  if (btnDown) btnDown.addEventListener('click', () => sendCmd('servo_up'));
  if (btnLeft) btnLeft.addEventListener('click', () => sendCmd('step_left'));
  if (btnRight) btnRight.addEventListener('click', () => sendCmd('step_right'));
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => sendCmd('stop'));

  if (fireBtn) {
    fireBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_on'); // Preferred dedicated "laser on" endpoint response.
      // Fall back to the older toggle endpoint when the dedicated endpoint is unavailable.
      if (!(res && res.ok) && !isLaserOn) await sendCmd('laser_toggle');
      isLaserOn = true;
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_off'); // Preferred dedicated "laser off" endpoint response.
      if (!(res && res.ok) && isLaserOn) await sendCmd('laser_toggle');
      isLaserOn = false;
    });
  }
  if (stopBtn) stopBtn.addEventListener('click', () => sendCmd('stop'));
  if (scanBtn) scanBtn.addEventListener('click', () => alert('Scan mode is not available on the HTTP-only firmware.'));

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        if (window.SkyShieldAuth && window.SkyShieldAuth.logout) await window.SkyShieldAuth.logout();
      } catch (err) {
        console.error('Logout failed', err);
      } finally {
        window.location.href = 'index.html';
      }
    });
  }

  // Camera load/error group:
  // - load event means the image has real pixels, so the overlay and detector may start
  // - error event means try the next candidate URL before fully giving up
  if (feedImg) {
    feedImg.addEventListener('load', () => {
      // Once the image has real pixels, resize the overlay to match it.
      syncOverlaySize();
      logConsole('Camera stream connected.', 'text-success');
      if (overlayCanvas) overlayCanvas.classList.remove('d-none');
      // Only start inference after the browser confirms that the image element has real pixels to read.
      startDetectionLoop();
    });
    feedImg.addEventListener('error', () => {
      // Stop the old detection loop before trying another URL candidate.
      stopDetectionLoop('error');
      if (streamCandidates.length && streamCandidateIndex < streamCandidates.length - 1) {
        streamCandidateIndex += 1;
        const next = streamCandidates[streamCandidateIndex]; // Next fallback stream URL built from the original camera address.
        // Each retry is just another URL form for the same camera, not a different persisted stream choice.
        setReadout(statusLabel, `Retrying stream via ${next}`);
        logConsole(`Stream retry: ${next}`, 'text-warning');
        feedImg.src = next;
        return;
      }
      // If every candidate fails, return to the placeholder so the page clearly shows a disconnected state.
      setReadout(statusLabel, 'Stream error - check address / CORS / path');
      logConsole('Tip: if the stream opens in a tab but inference fails, confirm the camera still sends CORS headers.', 'text-warning');
      logConsole('Stream failed for all candidates.', 'text-danger');
      feedImg.classList.add('d-none');
      if (placeholder) placeholder.classList.remove('d-none');
    });
  }

  // Saved-state restore group:
  // - restore controller first so the assist/calibration cards can refresh early
  // - restore camera second so stream loading can begin automatically
  // - if nothing is saved, show the page in an explicit idle state
  const savedCamera = localStorage.getItem(STORAGE_KEY); // Previously saved camera URL restored on page load.
  const savedEsp = localStorage.getItem(ESP32_STORAGE_KEY); // Previously saved controller URL restored on page load.
  if (savedEsp && esp32IpInput) {
    esp32IpInput.value = savedEsp;
    // Restore the last controller immediately so the page behaves like a persistent dashboard.
    syncLaserState();
    syncControllerConfig(false);
  }
  if (savedCamera) {
    if (urlInput) urlInput.value = savedCamera;
    // Restore the last stream URL so the operator can resume with minimal re-entry.
    setStream(savedCamera);
  } else {
    setReadout(statusLabel, 'Stream idle');
    if (placeholder) placeholder.classList.remove('d-none');
    if (feedImg) feedImg.classList.add('d-none');
  }

  window.addEventListener('resize', syncOverlaySize);
  if (window.SkyShieldAuth) {
    // Protected-page flow:
    // - requireAuth waits for Firebase auth state
    // - only authenticated users stay on the page
    // - once authenticated, Firebase RTDB sync begins
    // Auth is started last so all helpers are ready before Firebase callbacks begin updating the page.
    window.SkyShieldAuth.requireAuth({
      onAuthenticated: () => startFirebaseSync(),
    });
  } else {
    console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
  }
}












// Reading guide:
// 1. The top of the file grabs HTML elements and stores them in variables.
// 2. The middle of the file contains helpers for Firebase, calibration, and controller commands.
// 3. The bottom of the file connects buttons and inputs to those helpers.
// 4. Detection math and model work live in control-detection.js, but this file still calls into that logic.
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
 *   autoAppliedCamera: boolean,
 *   autoAppliedController: boolean,
 *   lastSnapshot: object|null
 * }} FirebaseState
 * Minimal Firebase listener state used to avoid duplicate subscriptions and repeated auto-apply behavior.
 */
/*
CONTROL.JS FULL EXAM CTRL+F EXPLANATION COMMENT

This file is the main control-page coordinator for the SkyShield dashboard. It does not run the AI detection model itself. The AI detection loop, model inference, target selection, and overlay detection math live in control-detection.js. This file controls the page: it grabs HTML elements, connects buttons to actions, manages the camera stream URL, sends direct HTTP commands to the ESP32 controller, reads and writes localStorage settings, listens to Firebase, handles calibration notes, updates the operator assist card, and starts the page when init() runs. During the exam, search any variable or function name with Ctrl+F and read the explanation.

$:
$ is a short helper function. It receives an id string and returns document.getElementById(id). Instead of writing document.getElementById many times, the code writes $('cameraFeed'), $('btnUp'), etc. It makes DOM capture shorter.

id:
id is the parameter of $. It is the HTML element id that the function searches for.

ControllerState:
ControllerState is a JSDoc typedef that describes the controller state object. It stores the latest controller firmware config and the calibration notes entered by the operator.

ControllerState.config:
config stores the controller configuration fetched from the ESP32, usually from the config endpoint. It can include values like x_dir and y_dir, which describe firmware polarity. It starts as null until config is loaded.

ControllerState.calibration:
calibration stores the operator’s observed physical movement notes. It explains what physically happened when X+ or Y+ was tested.

ControllerState.calibration.xPositiveObserved:
xPositiveObserved stores what direction the rig physically moved when the X positive direction was probed. It can be left, right, up, down, or unknown.

ControllerState.calibration.yPositiveObserved:
yPositiveObserved stores what direction the rig physically moved when the Y positive direction was probed. It can be left, right, up, down, or unknown.

FirebaseState:
FirebaseState is a JSDoc typedef that describes the Firebase listener state. It prevents duplicate listeners and remembers whether Firebase values were already auto-applied to the page.

FirebaseState.syncStarted:
syncStarted is true after Firebase sync has started. It prevents startFirebaseSync from creating multiple listeners.

FirebaseState.unsubscribe:
unsubscribe is a reserved field for a future unsubscribe function. In this code it is mostly a placeholder.

FirebaseState.rootRef:
rootRef stores the Firebase Realtime Database root reference. The code listens to this root reference for value changes.

FirebaseState.autoAppliedCamera:
autoAppliedCamera prevents Firebase from repeatedly overwriting the local camera URL after it has already auto-filled it once.

FirebaseState.autoAppliedController:
autoAppliedController prevents Firebase from repeatedly overwriting the local ESP32 controller URL after it has already auto-filled it once.

FirebaseState.lastSnapshot:
lastSnapshot stores the last Firebase root snapshot data as a plain object. It is useful for remembering the latest database state.

feedImg:
feedImg is the <img> element that displays the live camera stream. The detector reads frames from this image. When a stream connects, feedImg.src is set to a stream URL. When there is no stream, it is hidden.

placeholder:
placeholder is the empty-state panel shown when no camera stream is connected or when the stream fails.

urlInput:
urlInput is the text input where the operator types the camera URL or stream URL.

connectBtn:
connectBtn is the button that applies the camera URL from urlInput and starts the stream by calling setStream.

statusLabel:
statusLabel is the small text label that shows the current camera stream status, such as Stream idle, Streaming from..., Retrying stream..., or Stream error.

esp32IpInput:
esp32IpInput is the text input where the operator types the ESP32 controller base URL.

esp32ConnectBtn:
esp32ConnectBtn is the button that saves the ESP32 controller URL, then syncs laser state and controller config.

btnUp:
btnUp is the manual Up button. In this rig, it sends the firmware command servo_down because the physical orientation is reversed in the current setup.

btnDown:
btnDown is the manual Down button. In this rig, it sends the firmware command servo_up because of the current rig orientation.

btnLeft:
btnLeft is the manual Left button. It sends the firmware command step_left.

btnRight:
btnRight is the manual Right button. It sends the firmware command step_right.

btnStopCursor:
btnStopCursor is the manual stop button for movement. It sends the firmware command stop.

fireBtn:
fireBtn is the manual laser-on button. In safe project explanation, this is only a manual operator button, not automatic firing. It tries the laser_on endpoint first and falls back to laser_toggle only if needed.

stopLaserBtn:
stopLaserBtn is the manual laser-off button. It tries the laser_off endpoint first and falls back to laser_toggle only if needed.

scanBtn:
scanBtn is a placeholder scan-mode button. In this code it only shows an alert because scan mode is not available on the HTTP-only firmware.

stopBtn:
stopBtn is another stop button. It sends the stop command to the controller.

logoutBtn:
logoutBtn is the top-bar logout button. It calls SkyShieldAuth.logout if available, then redirects to index.html.

overlayCanvas:
overlayCanvas is the transparent canvas placed on top of the camera feed. control-detection.js draws boxes, reticles, lines, and target markers on this canvas.

overlayCtx:
overlayCtx is the 2D drawing context of overlayCanvas. It is used by the detection overlay drawing code. If overlayCanvas does not exist, overlayCtx is null.

detectStatus:
detectStatus is the detector status badge. It shows states like Detect idle, Detect: waiting, Detect: loading, Detect: clear, Detect: possible, Detect: target, or Detect: error.

consolePanel:
consolePanel is the visible event log panel. logConsole appends messages to it.

safetyDot:
safetyDot is the colored safety indicator dot. It changes CSS class based on ok, warn, or danger state.

safetyVal:
safetyVal is the text next to the safety dot. It displays labels like Safe, Scanning, Possible air target, or Air target detected.

modeVal:
modeVal displays the current page mode, such as Manual or Observe.

profileVal:
profileVal displays the active detection profile label. setProfileStatus updates it.

targetLabelVal:
targetLabelVal displays the current detected target label, such as drone, helicopter, aircraft, or n/a.

targetScoreVal:
targetScoreVal displays the current target confidence score as a percentage.

targetCenterVal:
targetCenterVal displays the raw target center coordinates.

targetCenterFilteredVal:
targetCenterFilteredVal displays the smoothed target center coordinates.

targetDeltaVal:
targetDeltaVal displays the target offset from screen center in pixels.

targetDeltaNormVal:
targetDeltaNormVal displays the target offset from screen center as normalized values.

simCommandVal:
simCommandVal displays the simulated pan/tilt command labels and values, such as RIGHT_SMALL or UP_MED.

loopTimeVal:
loopTimeVal displays how long the last detection pass took in milliseconds.

firebaseSyncVal:
firebaseSyncVal displays the current Firebase sync state, such as Idle, Listening, Live, SDK unavailable, or Read failed.

firebaseCameraVal:
firebaseCameraVal displays the camera URL learned from Firebase.

firebaseControllerVal:
firebaseControllerVal displays the controller URL learned from Firebase.

firebaseLaserVal:
firebaseLaserVal displays the laser state learned from Firebase, usually On, Off, or n/a.

firebaseHomeVal:
firebaseHomeVal displays saved home coordinates from Firebase if available.

detectBackendSelect:
detectBackendSelect is the dropdown for choosing the detector backend, for example COCO or AeroYOLO. control-detection.js reads this through getSettings.

detectProfileSelect:
detectProfileSelect is the dropdown for choosing the detection profile, such as strict or broad.

strongThresholdInput:
strongThresholdInput is the numeric input for the strong target threshold. A detection must pass this confidence level to become a strong target.

possibleThresholdInput:
possibleThresholdInput is the numeric input for the possible target threshold. A detection passing this but not strongThreshold becomes a possible target.

smoothingInput:
smoothingInput controls tracking smoothing. Higher value means faster but more jumpy. Lower value means smoother but slower.

deadZoneInput:
deadZoneInput controls the center tolerance. If the target is inside the dead zone, the assist says HOLD.

downloadTelemetryBtn:
downloadTelemetryBtn is the button that exports sessionTelemetry as a JSON file.

clearTelemetryBtn:
clearTelemetryBtn is the button that empties the current telemetry array.

assistMoveVal:
assistMoveVal is the operator assist field showing detector-language movement, such as PAN LEFT_SMALL or TILT UP_MED.

assistFrameVal:
assistFrameVal describes where the target is in the frame, such as right of center or above-left of center.

assistButtonVal:
assistButtonVal translates movement hints into actual manual button guidance, such as Pan: Left x2.

assistCenterVal:
assistCenterVal shows whether the target is Centered, Off-center, or Not centered.

refreshControllerConfigBtn:
refreshControllerConfigBtn is the button that re-fetches the ESP32 controller config.

centerRigBtn:
centerRigBtn is the button that sends the center command to return the rig to its configured center position.

probeXPositiveBtn:
probeXPositiveBtn sends a small positive X-axis calibration nudge.

probeXNegativeBtn:
probeXNegativeBtn sends a small negative X-axis calibration nudge.

probeYPositiveBtn:
probeYPositiveBtn sends a small positive Y-axis calibration nudge.

probeYNegativeBtn:
probeYNegativeBtn sends a small negative Y-axis calibration nudge.

xObservedSelect:
xObservedSelect is the dropdown where the operator records what direction X+ physically moved.

yObservedSelect:
yObservedSelect is the dropdown where the operator records what direction Y+ physically moved.

saveCalibrationBtn:
saveCalibrationBtn saves the current calibration dropdown values to localStorage.

resetCalibrationBtn:
resetCalibrationBtn clears saved calibration notes and resets both observations to unknown.

controllerConfigVal:
controllerConfigVal displays the parsed controller config, especially x_dir and y_dir.

calibrationPanVal:
calibrationPanVal displays which axis is interpreted as pan.

calibrationTiltVal:
calibrationTiltVal displays which axis is interpreted as tilt.

calibrationButtonsVal:
calibrationButtonsVal displays what each visible manual button physically does after calibration.

STORAGE_KEY:
STORAGE_KEY is the localStorage key for the saved camera URL. Its value is skyshield_camera_base_url.

ESP32_STORAGE_KEY:
ESP32_STORAGE_KEY is the localStorage key for the saved ESP32 controller URL. Its value is esp32_ip.

ASSIST_CALIBRATION_STORAGE_KEY:
ASSIST_CALIBRATION_STORAGE_KEY is the localStorage key for saved calibration observations. Its value is skyshield_assist_calibration_v1.

MAX_LOG_ROWS:
MAX_LOG_ROWS limits the visible console log to 250 rows. logConsole removes old rows after this limit so the page does not grow forever.

CALIBRATION_PROBE_DELTA_DEG:
CALIBRATION_PROBE_DELTA_DEG is the probe step size in degrees. Its value is 5. sendProbe uses it to send small calibration nudges.

streamCandidates:
streamCandidates is an array of possible camera stream URLs. It is built from one normalized URL so the browser can try fallbacks like /stream or the raw origin.

streamCandidateIndex:
streamCandidateIndex stores which stream candidate is currently being tried.

isLaserOn:
isLaserOn is the browser-side cached belief about whether the laser is currently enabled. It is updated by Firebase, syncLaserState, fireBtn, and stopLaserBtn.

controllerState:
controllerState stores the latest controller config and calibration notes. deriveCalibration reads this object to understand what physical movement each command causes.

controllerState.config:
controllerState.config stores the latest firmware config fetched from the controller. It can include x_dir and y_dir.

controllerState.calibration:
controllerState.calibration stores xPositiveObserved and yPositiveObserved.

firebaseState:
firebaseState stores Firebase listener state. It prevents duplicate sync and tracks the last Firebase snapshot.

MANUAL_BUTTON_COMMANDS:
MANUAL_BUTTON_COMMANDS maps visible button names to firmware command names. It is used by deriveCalibration and findManualButtonForDirection to translate detector movement hints into manual button instructions.

MANUAL_BUTTON_COMMANDS Left:
The Left visible button maps to the firmware command step_left.

MANUAL_BUTTON_COMMANDS Right:
The Right visible button maps to the firmware command step_right.

MANUAL_BUTTON_COMMANDS Up:
The Up visible button maps to servo_down because of the current rig orientation.

MANUAL_BUTTON_COMMANDS Down:
The Down visible button maps to servo_up because of the current rig orientation.

clamp(value, min, max, fallback):
clamp converts a raw value into a number and keeps it inside a safe range. If the value cannot be parsed as a number, it returns fallback. control-detection.js uses this helper for detection thresholds and tuning values.

value:
value is the raw input given to clamp. It may be a string from an input box or a number.

min:
min is the lowest allowed number.

max:
max is the highest allowed number.

fallback:
fallback is the safe default returned when value is invalid.

n:
n is the parsed number inside clamp, read with Number.parseFloat.

logConsole(message, variant):
logConsole adds a line to the visible event console. It creates a div, optionally applies a CSS class, prefixes the message with local time, appends it to consolePanel, removes old rows past MAX_LOG_ROWS, and scrolls to the bottom.

message:
message is the text shown in the console log.

variant:
variant is an optional CSS class used to color the log line, such as text-info, text-warning, text-danger, or text-success.

row:
row is the div element created for one console log line.

setFirebaseStatus(text):
setFirebaseStatus writes the Firebase status text into firebaseSyncVal. If text is empty, it shows Idle.

text:
text is the status label shown to the user.

setDetectStatus(text, variant):
setDetectStatus updates the detector status badge. It sets the badge text, resets the class to badge, and then applies Bootstrap color classes from variant.

variant:
variant is the Bootstrap class string for the badge, for example bg-secondary, bg-success, bg-warning text-dark, or bg-danger.

setSafetyState(state, text):
setSafetyState updates the safety dot and safety text. state can be ok, warn, or danger. It removes old status classes, adds the correct new class, and shows custom text or a default label.

state:
state is the logical safety state: ok, warn, or danger.

cls:
cls is the CSS class chosen from the state. It becomes status-ok, status-warn, or status-danger.

setMode(text):
setMode updates modeVal with the current mode, usually Manual or Observe. If no text is provided, it defaults to Manual.

setProfileStatus(profileId):
setProfileStatus reads a detection profile using getProfile(profileId) and writes its friendly label to profileVal. getProfile is defined in control-detection.js.

profileId:
profileId is the id of the active detection profile, like strict or broad.

formatFirebaseValue(value, fallback):
formatFirebaseValue converts a Firebase value into a string for display. If the value is missing, it returns fallback or n/a.

readFirebaseNumber(value, fallback):
readFirebaseNumber parses a Firebase value as an integer. If parsing fails, it returns fallback.

getFirebaseSnapshotValue(data, path, fallback):
getFirebaseSnapshotValue safely reads a nested value from Firebase data. path can be an array like ['camera','state','urlBase'] or a dotted string like camera.state.urlBase. If any part is missing, it returns fallback.

data:
data is the Firebase snapshot converted into a plain JavaScript object.

path:
path is the nested path to read.

parts:
parts is the array of path pieces used during lookup.

current:
current is the cursor that walks through the nested object.

key:
key is the current property name being checked.

normalizeFirebaseUrl(raw):
normalizeFirebaseUrl cleans a URL from Firebase using normalizeBaseUrl. It always returns a string, even if the input is missing.

raw:
raw is the raw camera/controller URL from Firebase or user input.

normalized:
normalized is the cleaned URL returned by normalizeBaseUrl.

applyFirebaseSnapshot(data):
applyFirebaseSnapshot receives the latest Firebase RTDB snapshot data and applies it to the dashboard. It reads camera URL, controller URL, laser state, and home coordinates. It updates the Firebase status cards, updates isLaserOn, and auto-fills camera/controller URLs only if there is no localStorage override.

cameraUrl:
cameraUrl is the best camera URL found in Firebase. The code first checks the newer nested path camera.state.urlBase, then falls back to the older root key cameraIP.

controllerUrl:
controllerUrl is the best controller URL found in Firebase. The code first checks controller.state.urlBase, then falls back to espIP.

laserValue:
laserValue is the optional laser state from Firebase. It can come from controller.state.laserOn or the older laserOn key.

homeX:
homeX is the saved home X coordinate read from Firebase.

homeY:
homeY is the saved home Y coordinate read from Firebase.

startFirebaseSync():
startFirebaseSync starts the Firebase Realtime Database listener. It prevents duplicate listeners, checks that SkyShieldAuth and getDatabase exist, gets the database object, listens at the root path '/', and calls applyFirebaseSnapshot whenever data changes.

db:
db is the Firebase Realtime Database instance returned by window.SkyShieldAuth.getDatabase().

snapshot:
snapshot is the Firebase value event snapshot. snapshot.val() returns the actual data.

error:
error is the Firebase listener error object if reading fails.

normalizeObservedDirection(value):
normalizeObservedDirection accepts only left, right, up, down, or unknown. If the input is anything else, it returns unknown. This keeps calibration state safe and predictable.

getOppositeDirection(direction):
getOppositeDirection returns the opposite of a direction. left becomes right, right becomes left, up becomes down, down becomes up, and anything unknown stays unknown.

direction:
direction is a physical movement direction such as left, right, up, down, hold, or unknown.

axisRoleFromDirection(direction):
axisRoleFromDirection decides whether a direction belongs to pan or tilt. left/right means pan. up/down means tilt. unknown means unknown.

friendlyDirection(direction):
friendlyDirection makes known directions uppercase for UI display. For example left becomes LEFT. Unknown stays unknown.

commandDirectionFromRawPositive(rawPositiveDirection, signedFactor):
commandDirectionFromRawPositive calculates the real physical movement caused by a command. It starts with the observed positive direction of an axis. If signedFactor is positive, it keeps that direction. If signedFactor is negative, it flips to the opposite direction.

rawPositiveDirection:
rawPositiveDirection is what the operator observed for the positive side of an axis.

signedFactor:
signedFactor is the command polarity. Positive keeps direction, negative flips direction.

raw:
raw is the normalized observed direction inside commandDirectionFromRawPositive.

parseSimLabel(label):
parseSimLabel parses detector movement labels like LEFT_SMALL, RIGHT_MED, UP_LARGE, or HOLD. It returns an object with label, direction, size, and taps. HOLD becomes direction hold and taps 0. SMALL means 1 tap, MED means 2 taps, LARGE means 3 taps.

label:
label is the simulated movement label from trackingState, such as HOLD or LEFT_SMALL.

directionRaw:
directionRaw is the first part of a label before the underscore, like LEFT.

sizeRaw:
sizeRaw is the second part of a label after the underscore, like SMALL.

direction:
direction is the lowercased movement direction after parsing.

size:
size is the movement size after parsing, usually SMALL, MED, LARGE, or HOLD.

taps:
taps is the suggested number of manual button taps based on size.

readCalibrationFromControls():
readCalibrationFromControls reads xObservedSelect and yObservedSelect from the page and stores normalized values into controllerState.calibration.

writeCalibrationControls():
writeCalibrationControls writes controllerState.calibration values back into xObservedSelect and yObservedSelect. It is used after loading or resetting calibration.

loadCalibration():
loadCalibration loads saved calibration notes from localStorage. It parses JSON from ASSIST_CALIBRATION_STORAGE_KEY. If parsing fails, it keeps defaults. Then it normalizes the values and writes them into the dropdowns.

saved:
saved is the parsed calibration object from localStorage.

saveCalibration(logChange):
saveCalibration reads calibration dropdowns into controllerState, saves them to localStorage, and optionally logs a confirmation line.

logChange:
logChange controls whether the function writes a confirmation message to the console.

resetCalibration():
resetCalibration sets xPositiveObserved and yPositiveObserved back to unknown, removes the saved calibration from localStorage, and updates the dropdowns.

getControllerConfigNumber(value, fallback):
getControllerConfigNumber parses a controller config value as an integer. If parsing fails, it returns fallback. It is used for firmware polarity fields like x_dir and y_dir.

deriveCalibration():
deriveCalibration is the main calibration interpretation function. It combines the operator’s observed directions with controller firmware polarity values. It figures out which axis is pan, which axis is tilt, what each command physically does, and builds readable summaries for the calibration UI.

xObserved:
xObserved is the normalized physical movement observed when X+ was probed.

yObserved:
yObserved is the normalized physical movement observed when Y+ was probed.

xRole:
xRole is the axis role inferred from xObserved. It can be pan, tilt, or unknown.

yRole:
yRole is the axis role inferred from yObserved. It can be pan, tilt, or unknown.

xDir:
xDir is the firmware polarity multiplier for X, read from controllerState.config.x_dir or defaulting to 1.

yDir:
yDir is the firmware polarity multiplier for Y, read from controllerState.config.y_dir or defaulting to 1.

commands:
commands is an object that maps firmware commands to real physical movement directions after calibration and polarity are applied. It includes step_right, step_left, servo_up, and servo_down.

commands.step_right:
commands.step_right is the physical movement caused by the step_right endpoint after calibration.

commands.step_left:
commands.step_left is the physical movement caused by the step_left endpoint after calibration.

commands.servo_up:
commands.servo_up is the physical movement caused by the servo_up endpoint after calibration.

commands.servo_down:
commands.servo_down is the physical movement caused by the servo_down endpoint after calibration.

panSummary:
panSummary is a readable explanation of which axis acts as pan. It might say X (+ => LEFT), Y (+ => RIGHT), or unknown.

tiltSummary:
tiltSummary is a readable explanation of which axis acts as tilt. It might say X (+ => UP), Y (+ => DOWN), or unknown.

buttonSummary:
buttonSummary is a compact string showing what each visible manual button really does after calibration.

findManualButtonForDirection(direction, derived):
findManualButtonForDirection receives a desired physical direction and a derived calibration object. It searches MANUAL_BUTTON_COMMANDS to find which visible button would move in that direction. It returns the matching button/command object or null.

target:
target is the normalized desired movement direction.

derived:
derived is the object returned by deriveCalibration.

formatAxisAssist(axisName, parsedLabel, derived):
formatAxisAssist converts one detector axis hint into operator-friendly text. If the hint is HOLD, it returns Pan: HOLD or Tilt: HOLD. If calibration is incomplete, it says finish calibration. If calibration is complete, it returns the manual button and tap count.

axisName:
axisName is a readable axis name, usually Pan or Tilt.

parsedLabel:
parsedLabel is the parsed result from parseSimLabel.

button:
button is the manual button mapping found by findManualButtonForDirection.

moveText:
moveText is fallback detector-language text like LEFT_SMALL if no calibrated button is found.

describeFramePosition(normX, normY, deadZone):
describeFramePosition converts normalized target offset into plain language. It returns Centered, right of center, left of center, above of center, below of center, above-right of center, etc.

normX:
normX is the normalized horizontal target offset.

normY:
normY is the normalized vertical target offset.

horizontal:
horizontal is the text left, right, or empty based on normX and deadZone.

vertical:
vertical is the text above, below, or empty based on normY and deadZone.

updateCalibrationReadouts():
updateCalibrationReadouts rebuilds the calibration status card. It calls deriveCalibration, then updates controllerConfigVal, calibrationPanVal, calibrationTiltVal, and calibrationButtonsVal.

updateOperatorAssistReadout():
updateOperatorAssistReadout rebuilds the operator assist card. It reads calibration using deriveCalibration, reads current detection settings using getSettings, reads trackingState from control-detection.js, then shows either no-target guidance, centered status, or manual button guidance.

settings:
settings in updateOperatorAssistReadout is the current detection settings object from getSettings. It provides deadZone.

trackingState:
trackingState is defined in control-detection.js. This file reads it to know if there is a target and what simulated pan/tilt labels were produced.

panAssist:
panAssist is the parsed version of trackingState.simPanLabel.

tiltAssist:
tiltAssist is the parsed version of trackingState.simTiltLabel.

centered:
centered is true when both panAssist and tiltAssist say hold.

framePosition:
framePosition is the plain-language target position returned by describeFramePosition.

moveParts:
moveParts is an array of detector-language movement strings like PAN LEFT_SMALL.

buttonParts:
buttonParts is an array of actual manual-button instructions like Pan: Left x2.

setReadout(el, text):
setReadout safely writes text into a DOM element. If the element does not exist, it does nothing. This lets the page work even if some optional readout cards are removed.

el:
el is the DOM element to update.

formatPoint(x, y):
formatPoint formats x and y pixel coordinates as rounded whole numbers, like 320, 180.

formatNorm(x, y):
formatNorm formats normalized x and y values with two decimals, like 0.25, -0.14.

normalizeBaseUrl(raw):
normalizeBaseUrl cleans a user-entered or Firebase-provided URL. It trims spaces, adds http:// if no protocol exists, and removes trailing slashes. If the result is empty, it returns an empty string.

url:
url is the cleaned internal URL string inside normalizeBaseUrl.

buildStreamCandidates(normalized):
buildStreamCandidates creates a list of possible camera stream URLs to try. If the user supplied a specific path, it tries that first, then origin + /stream, then origin. If the user supplied only the base host, it tries base + /stream first, then the base.

normalized:
normalized is a cleaned camera base URL or stream URL.

u:
u is the parsed URL object created with new URL(normalized).

configureFeedCorsMode():
configureFeedCorsMode sets feedImg.crossOrigin to anonymous. This matters because the detector reads pixels from the image through a canvas, and browser CORS rules can block canvas pixel reads without proper camera headers.

setStream(baseUrl):
setStream starts or stops the camera stream. It normalizes the URL. If the URL is empty, it clears the stream, removes the saved camera URL, stops detection, clears target telemetry, and returns idle. If the URL is valid, it configures CORS, builds streamCandidates, sets feedImg.src to the first candidate, updates UI status, saves the normalized URL, and returns it.

baseUrl:
baseUrl is the raw camera URL or stream URL provided by the user or Firebase.

first:
first is the first stream URL candidate that the page tries immediately.

sendCmd(cmd):
sendCmd sends a direct HTTP request to the ESP32 controller. It reads the saved ESP32 base URL from localStorage, then fetches `${ip}/${cmd}` with cache disabled. If there is no saved IP, it alerts the user. If the response is not ok, it tries to read a useful error message. If the network fails, it logs a command failure and returns null.

cmd:
cmd is the controller endpoint suffix, such as status, config, step_left, servo_up, center, or stop.

ip:
ip is the saved ESP32 controller base URL from localStorage.

res:
res is the fetch Response object returned by the controller.

payload:
payload is a parsed JSON error body if the controller returned structured JSON.

parseControllerStatusText(text):
parseControllerStatusText parses the controller status response. It first tries JSON. If JSON parsing fails, it falls back to regex parsing for older plain-text responses containing laser, x, or y values.

text:
text is the raw controller status body.

laserMatch:
laserMatch is the regex result for laser state in older plain-text status.

xMatch:
xMatch is the regex result for X position in older plain-text status.

yMatch:
yMatch is the regex result for Y position in older plain-text status.

syncControllerConfig(logSuccess):
syncControllerConfig fetches the controller config by calling sendCmd('config'). If the response fails, it clears controllerState.config and updates calibration/assist readouts. If successful, it parses JSON, stores it in controllerState.config, updates readouts, optionally logs x_dir/y_dir, and returns the config.

logSuccess:
logSuccess controls whether successful config loading is written to the console.

syncLaserState():
syncLaserState fetches the controller status by calling sendCmd('status'). It reads the response body, parses it using parseControllerStatusText, and updates isLaserOn if a laser number exists.

status:
status is the parsed controller status object.

sendProbe(axis, sign):
sendProbe sends a small calibration nudge command. axis is x or y. sign is positive or negative. It converts that into a delta using CALIBRATION_PROBE_DELTA_DEG, builds a nudge query, sends it with sendCmd, and logs success if the controller accepted it.

axis:
axis is the axis being probed, either x or y.

sign:
sign decides whether the probe is positive or negative.

delta:
delta is the signed degree amount sent to the controller. It is +5 or -5 by default.

query:
query is the endpoint query string, like nudge?dx=5 or nudge?dy=-5.

downloadTelemetry():
downloadTelemetry downloads the current sessionTelemetry array as a JSON file. If there is no telemetry, it logs a warning. Otherwise it creates a Blob, creates a temporary object URL, creates a temporary anchor, triggers a download, removes the anchor, and revokes the URL.

sessionTelemetry:
sessionTelemetry is defined in control-detection.js. This file uses it for downloading or clearing telemetry.

blob:
blob is the generated JSON file content wrapped in a browser Blob.

a:
a is a temporary anchor element used to trigger the browser download.

init():
init is the main startup function for the control page. It resets the HUD, loads saved detection settings, loads saved calibration, clears legacy proxy mode, updates calibration and assist cards, attaches all event listeners, restores saved camera/controller URLs, starts stream loading if a saved camera exists, listens for window resize, and starts Firebase auth/sync if SkyShieldAuth exists.

clearTargetTelemetry:
clearTargetTelemetry is defined in control-detection.js. init calls it at startup so the target HUD starts clean.

loadSettings:
loadSettings is defined in control-detection.js. init calls it to restore detection backend/profile/threshold settings.

lastDetectState:
lastDetectState is defined in control-detection.js. init resets it when detection backend or profile changes so old detection state does not stay in logs.

lastDetectLabel:
lastDetectLabel is defined in control-detection.js. init resets it when detection backend or profile changes.

getSettings:
getSettings is defined in control-detection.js. This file uses it to read active detection settings for logs and assist readouts.

saveSettings:
saveSettings is defined in control-detection.js. init calls it when detection controls change.

downloadTelemetryBtn click:
When downloadTelemetryBtn is clicked, init calls downloadTelemetry.

clearTelemetryBtn click:
When clearTelemetryBtn is clicked, init empties sessionTelemetry by setting sessionTelemetry.length = 0.

xObservedSelect and yObservedSelect change:
When either calibration dropdown changes, init saves calibration, updates calibration readouts, and updates operator assist.

saveCalibrationBtn click:
When saveCalibrationBtn is clicked, init saves calibration with a console log, updates calibration readouts, and updates operator assist.

resetCalibrationBtn click:
When resetCalibrationBtn is clicked, init resets calibration, updates readouts, updates assist, and logs that calibration notes were cleared.

refreshControllerConfigBtn click:
When refreshControllerConfigBtn is clicked, init calls syncControllerConfig(true).

centerRigBtn click:
When centerRigBtn is clicked, init sends the center command and logs success if the response is ok.

probeXPositiveBtn click:
When probeXPositiveBtn is clicked, init calls sendProbe('x', 1).

probeXNegativeBtn click:
When probeXNegativeBtn is clicked, init calls sendProbe('x', -1).

probeYPositiveBtn click:
When probeYPositiveBtn is clicked, init calls sendProbe('y', 1).

probeYNegativeBtn click:
When probeYNegativeBtn is clicked, init calls sendProbe('y', -1).

connectBtn click:
When connectBtn is clicked, init calls setStream(urlInput.value). If setStream returns empty, it alerts the user to enter a valid camera URL.

urlInput keyup:
When Enter is pressed inside urlInput, init triggers connectBtn.click().

esp32ConnectBtn click:
When esp32ConnectBtn is clicked, init normalizes the ESP32 URL, saves it to localStorage, then calls syncLaserState and syncControllerConfig(true).

esp32IpInput keyup:
When Enter is pressed inside esp32IpInput, init triggers esp32ConnectBtn.click().

btnUp click:
When btnUp is clicked, init sends servo_down.

btnDown click:
When btnDown is clicked, init sends servo_up.

btnLeft click:
When btnLeft is clicked, init sends step_left.

btnRight click:
When btnRight is clicked, init sends step_right.

btnStopCursor click:
When btnStopCursor is clicked, init sends stop.

fireBtn click:
When fireBtn is clicked, init tries laser_on first. If that fails and isLaserOn is false, it tries laser_toggle. Then it sets isLaserOn true. This is manual UI control only and should be treated as safety-supervised project behavior, not automatic actuation.

stopLaserBtn click:
When stopLaserBtn is clicked, init tries laser_off first. If that fails and isLaserOn is true, it tries laser_toggle. Then it sets isLaserOn false.

stopBtn click:
When stopBtn is clicked, init sends stop.

scanBtn click:
When scanBtn is clicked, init shows an alert saying scan mode is not available on the HTTP-only firmware.

logoutBtn click:
When logoutBtn is clicked, init tries SkyShieldAuth.logout, then redirects to index.html.

feedImg load:
When feedImg loads successfully, the browser has real image pixels. init calls syncOverlaySize, logs that the camera stream connected, shows overlayCanvas, and starts the detection loop using startDetectionLoop.

feedImg error:
When feedImg fails to load, init stops the detection loop with stopDetectionLoop('error'). If more streamCandidates exist, it tries the next URL. If all fail, it updates status, logs troubleshooting messages, hides feedImg, and shows placeholder.

next:
next is the next fallback stream URL used after a camera load error.

savedCamera:
savedCamera is the previously saved camera URL loaded from localStorage during init.

savedEsp:
savedEsp is the previously saved ESP32 controller URL loaded from localStorage during init.

window resize:
When the browser window resizes, init calls syncOverlaySize so the detection overlay still matches the displayed camera size.

SkyShieldAuth:
SkyShieldAuth is the authentication/bootstrap object expected on window. init uses requireAuth to protect the page and start Firebase sync only after authentication.

requireAuth:
requireAuth is called with onAuthenticated. After the user is authenticated, startFirebaseSync begins listening to Firebase.

onAuthenticated:
onAuthenticated is the callback that starts Firebase sync after authentication succeeds.

Important exam architecture explanation:
control.js is the page coordinator. It owns DOM references, camera connection, controller connection, Firebase sync, manual commands, calibration, telemetry download, and UI readouts. control-detection.js owns AI model loading, detection inference, target selection, trackingState updates, and overlay drawing. The two files communicate through shared globals like feedImg, overlayCanvas, setReadout, logConsole, clamp, getSettings, trackingState, sessionTelemetry, startDetectionLoop, stopDetectionLoop, and clearTargetTelemetry.

Important safety explanation:
The code keeps detection guidance and hardware commands separated. The detector produces UI guidance and simulated movement hints. Manual buttons send controller commands. There is no automatic laser firing inside this file. In a real demonstration, laser-related controls should only be used in a supervised, safe, legal lab setup with proper precautions.
*/













