const $ = (id) => document.getElementById(id);
// Reading guide:
// 1. The top of the file grabs HTML elements and stores them in variables.
// 2. The middle of the file contains helpers for Firebase, calibration, and controller commands.
// 3. The bottom of the file connects buttons and inputs to those helpers.
// 4. Detection math and model work live in control-detection.js, but this file still calls into that logic.

// Shared DOM references used by the control page and the detection overlay script.
// Many of these are optional so the UI can be simplified without forcing logic changes.
// Camera block: image element, placeholder, camera URL input, and top-level status text.
const feedImg = $('cameraFeed');
const placeholder = $('cameraPlaceholder');
const urlInput = $('cameraUrlInput');
const connectBtn = $('cameraConnectBtn');
const statusLabel = $('cameraStatus');
// Manual controller block: stored controller URL and the visible movement / laser buttons.
const esp32IpInput = $('esp32IpInput');
const esp32ConnectBtn = $('esp32ConnectBtn');
const btnUp = $('btnUp');
const btnDown = $('btnDown');
const btnLeft = $('btnLeft');
const btnRight = $('btnRight');
const btnStopCursor = $('btnStopCursor');
const fireBtn = $('fireBtn');
const stopLaserBtn = $('stopLaserBtn');
const scanBtn = $('scanBtn');
const stopBtn = $('stopBtn');
const logoutBtn = $('logoutBtn');
// Overlay and console block: the detector paints on the canvas while console logs keep operator feedback visible.
const overlayCanvas = $('cameraOverlay');
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
const detectStatus = $('detectStatus');
const consolePanel = $('console');
// Status and telemetry readouts: these cards are optional but, when present, mirror live tracking state.
const safetyDot = $('safetyDot');
const safetyVal = $('safetyVal');
const modeVal = $('modeVal');
const profileVal = $('profileVal');
const targetLabelVal = $('targetLabelVal');
const targetScoreVal = $('targetScoreVal');
const targetCenterVal = $('targetCenterVal');
const targetCenterFilteredVal = $('targetCenterFilteredVal');
const targetDeltaVal = $('targetDeltaVal');
const targetDeltaNormVal = $('targetDeltaNormVal');
const simCommandVal = $('simCommandVal');
const loopTimeVal = $('loopTimeVal');
const firebaseSyncVal = $('firebaseSyncVal');
const firebaseCameraVal = $('firebaseCameraVal');
const firebaseControllerVal = $('firebaseControllerVal');
const firebaseLaserVal = $('firebaseLaserVal');
const firebaseHomeVal = $('firebaseHomeVal');
// Detection tuning controls: these feed directly into control-detection.js through shared helpers.
const detectBackendSelect = $('detectBackendSelect');
const detectProfileSelect = $('detectProfileSelect');
const strongThresholdInput = $('strongThresholdInput');
const possibleThresholdInput = $('possibleThresholdInput');
const smoothingInput = $('smoothingInput');
const deadZoneInput = $('deadZoneInput');
const downloadTelemetryBtn = $('downloadTelemetryBtn');
const clearTelemetryBtn = $('clearTelemetryBtn');
const assistMoveVal = $('assistMoveVal');
const assistFrameVal = $('assistFrameVal');
const assistButtonVal = $('assistButtonVal');
const assistCenterVal = $('assistCenterVal');
// Calibration controls: these map observed physical rig motion back to firmware axis directions.
const refreshControllerConfigBtn = $('refreshControllerConfigBtn');
const centerRigBtn = $('centerRigBtn');
const probeXPositiveBtn = $('probeXPositiveBtn');
const probeXNegativeBtn = $('probeXNegativeBtn');
const probeYPositiveBtn = $('probeYPositiveBtn');
const probeYNegativeBtn = $('probeYNegativeBtn');
const xObservedSelect = $('xObservedSelect');
const yObservedSelect = $('yObservedSelect');
const saveCalibrationBtn = $('saveCalibrationBtn');
const resetCalibrationBtn = $('resetCalibrationBtn');
const controllerConfigVal = $('controllerConfigVal');
const calibrationPanVal = $('calibrationPanVal');
const calibrationTiltVal = $('calibrationTiltVal');
const calibrationButtonsVal = $('calibrationButtonsVal');

// These keys and small constants are shared by the control page and the detection script.
const STORAGE_KEY = 'skyshield_camera_base_url';
const ESP32_STORAGE_KEY = 'esp32_ip';
const ASSIST_CALIBRATION_STORAGE_KEY = 'skyshield_assist_calibration_v1';
const MAX_LOG_ROWS = 250;
const CALIBRATION_PROBE_DELTA_DEG = 5;

// This page keeps only stream/controller/Firebase state here; detection state lives in control-detection.js.
let streamCandidates = [];
let streamCandidateIndex = 0;
let isLaserOn = false;

// controllerState caches the last controller config so both calibration readouts and assist hints use one source of truth.
const controllerState = {
  config: null,
  calibration: {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  },
};

// Firebase state tracks a single root listener and whether values were auto-applied locally.
const firebaseState = {
  syncStarted: false,
  unsubscribe: null,
  rootRef: null,
  autoAppliedCamera: false,
  autoAppliedController: false,
  lastSnapshot: null,
};

// These are the operator-facing button labels that map to controller HTTP commands.
const MANUAL_BUTTON_COMMANDS = [
  { button: 'Left', command: 'step_left' },
  { button: 'Right', command: 'step_right' },
  { button: 'Up', command: 'servo_down' },
  { button: 'Down', command: 'servo_up' },
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
  const n = Number.parseFloat(value);
  // Empty or invalid values fall back to a safe default so the UI cannot poison later calculations.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Event console keeps a capped rolling timeline of operator and detection messages.
/**
 * @param {string} message - Human-readable message to append to the console.
 * @param {string} variant - Optional CSS class for color styling.
 */
function logConsole(message, variant) {
  if (!consolePanel) return;
  const row = document.createElement('div');
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
function setFirebaseStatus(text) {
  // Write the current Firebase sync state into the status card if that card exists.
  if (firebaseSyncVal) firebaseSyncVal.textContent = text || 'Idle';
}

/**
 * @param {string} text - Badge text shown next to the camera status.
 * @param {string} variant - Space-separated Bootstrap classes for badge color.
 */
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
function setSafetyState(state, text) {
  // The safety card has both a colored dot and a text label, so both are updated together.
  if (!(safetyDot && safetyVal)) return;
  // Remove all old status colors before deciding the new one.
  safetyDot.classList.remove('status-ok', 'status-warn', 'status-danger');
  // Convert the logical state name into the matching CSS class name.
  const cls = state === 'danger' ? 'status-danger' : state === 'warn' ? 'status-warn' : 'status-ok';
  // Apply the chosen color to the dot.
  safetyDot.classList.add(cls);
  // Show either the provided text or a built-in default for that state.
  safetyVal.textContent = text || (state === 'danger' ? 'Air target detected' : state === 'warn' ? 'Scanning' : 'Safe');
}

/**
 * @param {string} text - Operator mode label such as Manual or Observe.
 */
function setMode(text) {
  // The control page switches between labels like Manual and Observe.
  if (modeVal) modeVal.textContent = text || 'Manual';
}

// The detection script owns the profile catalog; this helper only renders its label in the HUD.
/**
 * @param {string} profileId - Id of the currently active detection profile.
 */
function setProfileStatus(profileId) {
  const profile = getProfile(profileId);
  if (profileVal) profileVal.textContent = profile.label;
}

// Firebase helpers normalize nullable values and safely walk nested RTDB snapshots.
/**
 * @param {*} value - Raw Firebase value.
 * @param {string} fallback - Placeholder used when the value is missing.
 * @returns {string} UI-friendly string value.
 */
function formatFirebaseValue(value, fallback) {
  // Convert truthy values to strings for the UI; otherwise fall back to a friendly placeholder.
  return value ? String(value) : (fallback || 'n/a');
}

/**
 * @param {*} value - Raw Firebase value that should contain a number.
 * @param {number|null} fallback - Value to use when parsing fails.
 * @returns {number|null} Parsed integer or fallback.
 */
function readFirebaseNumber(value, fallback) {
  // Firebase values can arrive as strings, so parse them as base-10 integers.
  const n = Number.parseInt(value, 10);
  // If parsing fails, preserve the caller's fallback value.
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object|null} data - Firebase snapshot converted to plain data.
 * @param {string|string[]} path - Nested path as an array or dotted string.
 * @param {*} fallback - Value returned when the path is missing.
 * @returns {*} Found value or fallback.
 */
function getFirebaseSnapshotValue(data, path, fallback) {
  // Accept either an array path like ['camera', 'state'] or a dotted string like 'camera.state'.
  const parts = Array.isArray(path) ? path : String(path || '').split('.');
  // Start at the root snapshot object.
  let current = data;
  // Walk through each segment of the path one by one.
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
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
function normalizeFirebaseUrl(raw) {
  // Reuse the same URL normalization rules used for manually typed URLs.
  const normalized = normalizeBaseUrl(raw);
  // Always return a string so downstream UI code can rely on the type.
  return normalized || '';
}

// Every Firebase snapshot can update the HUD and optionally auto-fill camera/controller URLs.
/**
 * @param {object|null} data - Latest RTDB root snapshot data.
 */
function applyFirebaseSnapshot(data) {
  firebaseState.lastSnapshot = data || null;
  // Support both the newer nested RTDB structure and the older root-level fallback keys.
  const cameraUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['camera', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'cameraIP', '')
  );
  const controllerUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['controller', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'espIP', '')
  );
  const laserValue = getFirebaseSnapshotValue(data, ['controller', 'state', 'laserOn'], getFirebaseSnapshotValue(data, 'laserOn', null));
  const homeX = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeX'], getFirebaseSnapshotValue(data, 'homeX', null)), null);
  const homeY = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeY'], getFirebaseSnapshotValue(data, 'homeY', null)), null);

  if (firebaseCameraVal) firebaseCameraVal.textContent = formatFirebaseValue(cameraUrl);
  if (firebaseControllerVal) firebaseControllerVal.textContent = formatFirebaseValue(controllerUrl);
  if (firebaseLaserVal) firebaseLaserVal.textContent = laserValue === null || typeof laserValue === 'undefined' ? 'n/a' : (Number(laserValue) === 1 ? 'On' : 'Off');
  if (firebaseHomeVal) firebaseHomeVal.textContent = Number.isFinite(homeX) && Number.isFinite(homeY) ? `${homeX} / ${homeY}` : 'n/a';
  setFirebaseStatus('Live');

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

// The control page listens at the RTDB root because camera IP, controller IP, and boot config share the same tree.
function startFirebaseSync() {
  // Prevent duplicate listeners if init() or auth callbacks run more than once.
  if (firebaseState.syncStarted) return;
  firebaseState.syncStarted = true;
  // Make sure the auth wrapper exists and exposes the database getter.
  if (!(window.SkyShieldAuth && typeof window.SkyShieldAuth.getDatabase === 'function')) {
    setFirebaseStatus('SDK unavailable');
    return;
  }
  // Ask the auth wrapper for the already-created RTDB instance.
  const db = window.SkyShieldAuth.getDatabase();
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
    setFirebaseStatus('Listening');
  } catch (err) {
    console.error('Failed to start Firebase RTDB sync.', err);
    setFirebaseStatus('Init failed');
  }
}

// Calibration helpers translate physical rig behavior into user-friendly manual hints.
/**
 * @param {string} value - Direction text from saved state or a select box.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Normalized direction.
 */
function normalizeObservedDirection(value) {
  // Only four directions are valid in calibration notes; everything else becomes unknown.
  return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';
}

/**
 * @param {'left'|'right'|'up'|'down'|'unknown'} direction - Direction to flip.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Opposite direction.
 */
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
function friendlyDirection(direction) {
  // Uppercase known directions so the UI reads like a label, not like raw internal data.
  return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();
}

/**
 * @param {string} rawPositiveDirection - Physical movement caused by the axis's positive direction.
 * @param {number} signedFactor - Firmware polarity multiplier for the command being tested.
 * @returns {string} Derived movement direction caused by that command.
 */
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {
  // Start from the recorded "positive" physical movement for that firmware axis.
  const raw = normalizeObservedDirection(rawPositiveDirection);
  // If calibration is incomplete, we cannot derive a usable movement direction.
  if (raw === 'unknown') return 'unknown';
  // Positive factor keeps the direction; negative factor flips it.
  return signedFactor >= 0 ? raw : getOppositeDirection(raw);
}

/**
 * @param {string} label - Simulated movement label such as LEFT_SMALL or HOLD.
 * @returns {{label: string, direction: string, size: string, taps: number}} Parsed assist label.
 */
function parseSimLabel(label) {
  // HOLD means the detector thinks no movement is needed on that axis.
  if (!label || label === 'HOLD') {
    return { label: 'HOLD', direction: 'hold', size: 'HOLD', taps: 0 };
  }
  // Split labels like LEFT_SMALL or UP_LARGE into separate pieces.
  const [directionRaw, sizeRaw] = String(label).split('_');
  // Normalize case because UI labels and internal labels can vary.
  const direction = String(directionRaw || '').toLowerCase();
  const size = String(sizeRaw || 'SMALL').toUpperCase();
  // Translate qualitative size into how many manual button taps the operator should make.
  const taps = size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1;
  return { label, direction, size, taps };
}

/**
 * Reads the two calibration dropdowns from the page and stores them in controllerState.
 */
function readCalibrationFromControls() {
  // Read the two select boxes from the page and store them in shared calibration state.
  controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);
  controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);
}

/**
 * Pushes the saved calibration state back into the dropdowns.
 */
function writeCalibrationControls() {
  // Push the saved calibration state back into the select boxes when the page loads or resets.
  if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
}

/**
 * Loads saved calibration notes from localStorage.
 */
function loadCalibration() {
  // Start with no saved object.
  let saved = null;
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
function getControllerConfigNumber(value, fallback) {
  // Controller config values also arrive as strings, so parse them as integers.
  const n = Number.parseInt(value, 10);
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
function deriveCalibration() {
  // Read the operator's observed motion notes for the two positive directions.
  const xObserved = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  const yObserved = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
  // Infer which physical axis each observation most likely belongs to.
  const xRole = axisRoleFromDirection(xObserved);
  const yRole = axisRoleFromDirection(yObserved);
  // Read firmware direction multipliers, defaulting to normal polarity if config is missing.
  const xDir = getControllerConfigNumber(controllerState.config && controllerState.config.x_dir, 1);
  const yDir = getControllerConfigNumber(controllerState.config && controllerState.config.y_dir, 1);
  // Convert raw axis direction plus firmware polarity into the practical movement caused by each HTTP command.
  const commands = {
    step_right: commandDirectionFromRawPositive(xObserved, xDir),
    step_left: commandDirectionFromRawPositive(xObserved, -xDir),
    servo_up: commandDirectionFromRawPositive(yObserved, yDir),
    servo_down: commandDirectionFromRawPositive(yObserved, -yDir),
  };

  let panSummary = 'unknown';
  // If the observed X motion behaved like left/right, X is the pan axis.
  if (xRole === 'pan') panSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like left/right, then Y must be pan.
  else if (yRole === 'pan') panSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  let tiltSummary = 'unknown';
  // If the observed X motion behaved like up/down, X is the tilt axis.
  if (xRole === 'tilt') tiltSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like up/down, then Y must be tilt.
  else if (yRole === 'tilt') tiltSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  // Turn the per-command movement map into one short summary string for the status card.
  const buttonSummary = MANUAL_BUTTON_COMMANDS
    .map(({ button, command }) => `${button}=${friendlyDirection(commands[command])}`)
    .join(' | ');

  return { xObserved, yObserved, xRole, yRole, xDir, yDir, commands, panSummary, tiltSummary, buttonSummary };
}

/**
 * @param {string} direction - Desired physical movement direction.
 * @param {object} derived - Result object from deriveCalibration().
 * @returns {{button: string, command: string}|null} Matching manual button mapping.
 */
function findManualButtonForDirection(direction, derived) {
  // Normalize the requested movement first so invalid inputs collapse to unknown.
  const target = normalizeObservedDirection(direction);
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
function formatAxisAssist(axisName, parsedLabel, derived) {
  // HOLD means this axis is already centered enough and needs no movement hint.
  if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;
  const button = findManualButtonForDirection(parsedLabel.direction, derived);
  // Build a human-readable movement label even if calibration is unfinished.
  const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`;
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
function describeFramePosition(normX, normY, deadZone) {
  const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : '';
  const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : '';
  if (!horizontal && !vertical) return 'Centered';
  if (vertical && horizontal) return `${vertical}-${horizontal} of center`;
  return `${vertical || horizontal} of center`;
}

/**
 * Rebuilds the calibration status card from the latest controller config and saved observations.
 */
function updateCalibrationReadouts() {
  const derived = deriveCalibration();
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
function updateOperatorAssistReadout() {
  const derived = deriveCalibration();
  const settings = getSettings();
  // If there is no active target, fill the assist panel with idle guidance.
  if (!trackingState.hasTarget) {
    setReadout(assistMoveVal, 'No target');
    setReadout(assistFrameVal, 'No target');
    setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');
    setReadout(assistCenterVal, 'Not centered');
    return;
  }

  const panAssist = parseSimLabel(trackingState.simPanLabel);
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel);
  // The target is considered centered only when both axes say HOLD.
  const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold';
  // Build a plain-language description of where the target sits in the frame.
  const framePosition = describeFramePosition(trackingState.filteredNormX, trackingState.filteredNormY, settings.deadZone);

  if (centered) {
    setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');
    setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);
    setReadout(assistButtonVal, 'Hold position');
    setReadout(assistCenterVal, 'Centered');
    return;
  }

  const moveParts = [];
  // Add a pan instruction only when the simulated pan axis needs movement.
  if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);
  // Add a tilt instruction only when the simulated tilt axis needs movement.
  if (tiltAssist.direction !== 'hold') moveParts.push(`TILT ${friendlyDirection(tiltAssist.direction)}_${tiltAssist.size}`);
  setReadout(assistMoveVal, moveParts.join(' / '));
  setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);

  const buttonParts = [];
  if (panAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Pan', panAssist, derived));
  if (tiltAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Tilt', tiltAssist, derived));
  setReadout(assistButtonVal, buttonParts.join(' / '));
  setReadout(assistCenterVal, trackingState.isPossible ? 'Off-center (possible)' : 'Off-center');
}

// Lightweight formatting helpers are shared with the detection overlay script.
/**
 * @param {HTMLElement|null} el - DOM node whose text should be replaced.
 * @param {string} text - Text to show in that node.
 */
function setReadout(el, text) {
  // Most status spans are optional, so guard the DOM write.
  if (el) el.textContent = text;
}

/**
 * @param {number} x - X coordinate in pixels.
 * @param {number} y - Y coordinate in pixels.
 * @returns {string} Rounded pixel pair.
 */
function formatPoint(x, y) {
  // Show pixel positions as rounded whole numbers.
  return `${x.toFixed(0)}, ${y.toFixed(0)}`;
}

/**
 * @param {number} x - Normalized horizontal value.
 * @param {number} y - Normalized vertical value.
 * @returns {string} Two-decimal normalized pair.
 */
function formatNorm(x, y) {
  // Show normalized offsets with two decimals for readability.
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

// Camera stream URLs are normalized once so the retry logic can try `/stream` and the raw origin consistently.
/**
 * @param {string} raw - User-typed or Firebase-provided URL.
 * @returns {string} Normalized base URL.
 */
function normalizeBaseUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  // Strip trailing slashes so later endpoint joins stay stable.
  return url.replace(/\/+$/, '');
}

/**
 * @param {string} normalized - Already-normalized camera base URL.
 * @returns {string[]} Ordered list of stream URL candidates to try.
 */
function buildStreamCandidates(normalized) {
  try {
    // Parse the URL once so we can inspect origin and path safely.
    const u = new URL(normalized);
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
function configureFeedCorsMode() {
  // The detector reads pixels from the image, so the image must be requested with CORS enabled.
  if (feedImg) feedImg.crossOrigin = 'anonymous';
}

// Stream setup only manages image source and detection loop lifecycle; the detector itself lives in control-detection.js.
/**
 * @param {string} baseUrl - Camera base URL or stream URL.
 * @returns {string} Normalized base URL when successful, otherwise an empty string.
 */
function setStream(baseUrl) {
  // Normalize typed or Firebase-provided URLs into one consistent format.
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    streamCandidates = [];
    streamCandidateIndex = 0;
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
  const first = streamCandidates[0];
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
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

// Controller communication stays direct over local HTTP so movement remains local and low-latency.
/**
 * @param {string} cmd - Controller endpoint suffix such as status or step_left.
 * @returns {Promise<Response|null>} Fetch response when available, otherwise null.
 */
function sendCmd(cmd) {
  // Read the last saved controller base URL from localStorage.
  const ip = localStorage.getItem(ESP32_STORAGE_KEY);
  if (!ip) {
    alert('Set the ESP32 address first.');
    return Promise.resolve(null);
  }
  // Local direct HTTP keeps manual control independent from Firebase round trips.
  return fetch(`${ip}/${cmd}`, { cache: 'no-store' })
    .then(async (res) => {
      // If the controller answered with an error code, try to extract a useful message.
      if (!res.ok) {
        try {
          // Clone the response before reading its body so the original response can still be returned.
          const text = await res.clone().text();
          let message = text;
          try {
            // Prefer a structured JSON error if the controller returned one.
            const payload = JSON.parse(text);
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
function parseControllerStatusText(text) {
  // Empty status bodies are treated as unusable.
  if (!text) return null;
  try {
    // Newer firmware answers with JSON, so try that first.
    return JSON.parse(text);
  } catch (err) {
    // Older firmware responses can be plain text, so keep a regex fallback.
    const laserMatch = text.match(/laser[:=](\d)/i);
    const xMatch = text.match(/x[:=](-?\d+)/i);
    const yMatch = text.match(/y[:=](-?\d+)/i);
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
function syncControllerConfig(logSuccess) {
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
async function syncLaserState() {
  // Read the live status endpoint so the UI knows whether the laser is already on.
  const res = await sendCmd('status');
  if (!res || !res.ok) return;
  const text = await res.text();
  const status = parseControllerStatusText(text);
  if (!status) return;
  // This flag lets the UI decide when the old toggle endpoint still needs to be used as a fallback.
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
}

/**
 * @param {'x'|'y'} axis - Axis to nudge during calibration.
 * @param {number} sign - Positive or negative direction for the nudge.
 * @returns {Promise<void>} Completes after the probe request finishes.
 */
async function sendProbe(axis, sign) {
  // Convert the requested axis/sign pair into a small +/- degree nudge command.
  const delta = sign > 0 ? CALIBRATION_PROBE_DELTA_DEG : -CALIBRATION_PROBE_DELTA_DEG;
  const query = axis === 'x' ? `nudge?dx=${delta}` : `nudge?dy=${delta}`;
  const res = await sendCmd(query);
  if (!res || !res.ok) return;
  logConsole(`Calibration probe sent: ${axis.toUpperCase()}${sign > 0 ? '+' : '-'} (${delta > 0 ? '+' : ''}${delta} deg)`, 'text-info');
}

// Telemetry is recorded by the detection loop and downloaded here as a JSON file for later review.
/**
 * Downloads the in-memory telemetry array as a JSON file.
 */
function downloadTelemetry() {
  if (!sessionTelemetry.length) return logConsole('No telemetry to download yet.', 'text-warning');
  // Serialize the current session into nicely formatted JSON for later study.
  const blob = new Blob([JSON.stringify(sessionTelemetry, null, 2)], { type: 'application/json' });
  // Turn that blob into a temporary object URL that the browser can download.
  const url = URL.createObjectURL(blob);
  // Create a temporary link because browsers trigger downloads most reliably through a clicked <a>.
  const a = document.createElement('a');
  a.href = url;
  a.download = `skyshield-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// init wires together the UI once both control.js and control-detection.js have loaded.
/**
 * Wires the control page UI, restores saved settings, and starts auth/Firebase flow.
 */
function init() {
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
      lastDetectState = '';
      lastDetectLabel = '';
      const settings = getSettings();
      // Backend/profile changes can invalidate the current target lock, so the HUD is cleared.
      logConsole(`Detection mode updated: ${settings.backend.label}, ${settings.profile.label}`, 'text-info');
    });
  });

  [strongThresholdInput, possibleThresholdInput, smoothingInput, deadZoneInput].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      const settings = getSettings();
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
      const res = await sendCmd('center');
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

  if (esp32ConnectBtn && esp32IpInput) {
    esp32ConnectBtn.addEventListener('click', () => {
      const normalized = normalizeBaseUrl(esp32IpInput.value);
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

  // Direction buttons map directly to the firmware's HTTP command names.
  if (btnUp) btnUp.addEventListener('click', () => sendCmd('servo_down'));
  if (btnDown) btnDown.addEventListener('click', () => sendCmd('servo_up'));
  if (btnLeft) btnLeft.addEventListener('click', () => sendCmd('step_left'));
  if (btnRight) btnRight.addEventListener('click', () => sendCmd('step_right'));
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => sendCmd('stop'));

  if (fireBtn) {
    fireBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_on');
      // Fall back to the older toggle endpoint when the dedicated endpoint is unavailable.
      if (!(res && res.ok) && !isLaserOn) await sendCmd('laser_toggle');
      isLaserOn = true;
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_off');
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
        const next = streamCandidates[streamCandidateIndex];
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

  const savedCamera = localStorage.getItem(STORAGE_KEY);
  const savedEsp = localStorage.getItem(ESP32_STORAGE_KEY);
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
    // Auth is started last so all helpers are ready before Firebase callbacks begin updating the page.
    window.SkyShieldAuth.requireAuth({
      onAuthenticated: () => startFirebaseSync(),
    });
  } else {
    console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
  }
}
