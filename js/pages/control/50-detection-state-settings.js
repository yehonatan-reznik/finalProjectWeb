// FILE ROLE: 50-detection-state-settings.js
// What this file does:
// - Defines detection configuration such as backend choices, profiles, thresholds, and timing constants.
// - Stores live detection state such as the current tracked target and the telemetry session array.
// - Provides helpers for reading detector settings and clearing/resetting tracked-target values.
// Why this file exists:
// - The detector needs one central place for configuration and shared runtime state.
// - Other detection files read and update this state instead of duplicating it.
// Detection-only storage keys, model paths, and timing constants live here so control.js can stay focused on page flow.
// DRONE_MODEL_URL points at the real ONNX weight file used by the AeroYOLO path.
// Reading guide:
// 1. The top of this file defines detector settings and runtime state.
// 2. The middle converts model output into one tracked target plus UI hints.
// 3. The bottom loads models, runs inference, and schedules the repeating detection loop.
// Pipeline summary:
// - A camera frame is read from the shared <img> element created by control.js.
// - The selected backend turns that frame into raw predictions.
// - Predictions are filtered by profile and confidence, then ranked down to one tracked target.
// - The chosen target updates shared tracking state, on-screen overlay graphics, and exported telemetry.
// - No automatic actuation happens here; outputs are guidance only.
// Dependency summary:
// - This file intentionally reuses globals from control.js such as feedImg, overlayCanvas, setReadout(), logConsole(), and clamp().
// Search guide:
// - Ctrl+F `threshold` for confidence rules that decide ignored/possible/strong detections.
// - Ctrl+F `track lock` for logic that tries to stay with the previous target across nearby frames.
// - Ctrl+F `telemetry` for exported frame-by-frame history.
// - Ctrl+F `sim` or `operator assist` for human guidance labels like LEFT_SMALL / HOLD.
// - Ctrl+F `AeroYOLO` or `COCO` for backend-specific loading and inference code.
// Key terms:
// - threshold: minimum confidence score needed before a detection is accepted.
// - possible target: weaker detection that passed the lower threshold but not the strong one.
// - strong target: higher-confidence detection treated as a full danger/target state.
// - dead zone: center area where the target is considered aligned enough to say HOLD.
// - track lock: temporary memory of the previous target that slightly relaxes thresholds nearby.
// - telemetry: in-memory record of each detection pass used for later download and review.
// Exam quick terms:
// - AeroYOLO: the project-specific ONNX model used for drone-focused detection.
// - COCO-SSD: the generic TensorFlow.js detector used as the alternate backend.
// - overlay space: the displayed camera space where boxes and reticles are drawn.
// - smoothing: blending between old and new target centers to reduce jitter.
// - CORS: browser security rule that can block pixel reads from the camera image.

/**
 * @typedef {{
 *   id: string,
 *   label: string
 * }} DetectBackendConfig
 * Selectable detector backend description.
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   cocoLabels: string[],
 *   aeroyoloLabels: string[]
 * }} DetectProfile
 * Profile-level allow-list deciding which model classes can become tracked targets.
 */

/**
 * @typedef {{
 *   x: number,
 *   y: number,
 *   w: number,
 *   h: number,
 *   centerX: number,
 *   centerY: number,
 *   deltaX: number,
 *   deltaY: number,
 *   normX: number,
 *   normY: number
 * }} DetectionMetrics
 * Detection box geometry translated from image space into displayed overlay space.
 */

/**
 * @typedef {{
 *   backend: DetectBackendConfig,
 *   profile: DetectProfile,
 *   strongThreshold: number,
 *   possibleThreshold: number,
 *   smoothingAlpha: number,
 *   deadZone: number
 * }} DetectionSettings
 * Fully resolved detector settings read from the page controls.
 */

/**
 * @typedef {{
 *   hasTarget: boolean,
 *   isPossible: boolean,
 *   label: string,
 *   score: number,
 *   rawCenterX: number,
 *   rawCenterY: number,
 *   filteredCenterX: number,
 *   filteredCenterY: number,
 *   filteredDeltaX: number,
 *   filteredDeltaY: number,
 *   filteredNormX: number,
 *   filteredNormY: number,
 *   simPan: number,
 *   simTilt: number,
 *   simPanLabel: string,
 *   simTiltLabel: string,
 *   loopMs: number,
 *   missedFrames: number
 * }} TrackingState
 * Shared target-lock state consumed by both the detector and the control-page assist UI.
 */

// Section: static config.
const DETECTION_SETTINGS_STORAGE_KEY = 'skyshield_detection_settings_v2'; // localStorage key for persisted detector tuning.
const DRONE_MODEL_URL = '../models/aeroyolo.onnx'; // Relative URL to the project-specific ONNX model file.
const DEFAULT_DETECT_BACKEND_ID = 'aeroyolo'; // Backend automatically selected when the page has no saved preference.
const DETECT_INTERVAL_MS = 180; // Target cadence between completed detection passes.
const DETECT_MIN_IDLE_MS = 24; // Minimum breathing room left for browser painting/input even on fast machines.
// Low-resolution inference keeps browser inference responsive on normal laptops.
const DETECT_MAX_SOURCE_WIDTH = 384; // Maximum width used when downscaling frames for the COCO path.
const DETECT_MAX_SOURCE_HEIGHT = 384; // Maximum height used when downscaling frames for the COCO path.
const DRAW_THRESHOLD = 0.05; // Minimum confidence required before a raw prediction is even drawn.
const LOST_LIMIT = 8; // Number of consecutive misses allowed before the tracker fully forgets the last target.
const MAX_TELEMETRY = 1200; // Hard cap on telemetry rows kept in browser memory.
// Track-lock relaxes thresholds a bit when the next frame lands close to the last confirmed target.
const TRACK_LOCK_THRESHOLD_FACTOR = 0.6; // Multiply thresholds by this factor when a new box looks like the same target.
const TRACK_LOCK_DISTANCE_RATIO = 0.22; // Maximum normalized distance for a candidate to count as "near" the old target.
const TRACK_LOCK_MIN_SCORE = 0.08; // Lower bound so track-lock cannot reduce thresholds into useless noise.

// The detector can switch between a general browser model and the project-specific ONNX model.
/** @type {Record<string, DetectBackendConfig>} */
const DETECT_BACKENDS = {
  coco: { id: 'coco', label: 'COCO-SSD' }, // Generic TensorFlow.js object detector used as the fallback/general backend.
  aeroyolo: { id: 'aeroyolo', label: 'AeroYOLO ONNX' }, // Project-specific ONNX detector tuned more directly for air targets.
};

// AeroYOLO exports numeric class ids, so this map turns the raw model output into readable labels.
const DRONE_MODEL_LABELS = {
  0: 'aircraft', // Fixed label name for ONNX class id 0.
  1: 'drone', // Fixed label name for ONNX class id 1.
  2: 'helicopter', // Fixed label name for ONNX class id 2.
};

// Profiles decide which labels are considered real candidates for each backend.
// "strict" still allows the overlay to draw every raw detection, but only drone/helicopter can become tracked targets.
/** @type {Record<string, DetectProfile>} */
const PROFILES = {
  strict: {
    id: 'strict', // Internal id for the narrow target profile.
    label: 'Drone / rotorcraft focus', // User-facing label shown in the control page.
    cocoLabels: ['airplane', 'aeroplane'], // COCO labels allowed to become targets in strict mode.
    aeroyoloLabels: ['drone', 'helicopter'], // AeroYOLO labels allowed to become targets in strict mode.
  },
  broad: {
    id: 'broad', // Internal id for the wider target profile.
    label: 'Full air sweep', // User-facing label shown in the control page.
    cocoLabels: ['airplane', 'aeroplane', 'bird', 'kite'], // Wider COCO allow-list that intentionally accepts more possible aerial shapes.
    aeroyoloLabels: ['drone', 'aircraft', 'helicopter'], // Wider AeroYOLO allow-list that includes aircraft too.
  },
};

// Section: runtime state and caches.
// Detection runtime state is kept separate from controller/Firebase state so the page is easier to reason about.
// The TF.js model and the ONNX session are cached separately because only one backend is active at a time.
let detectTimer = null; // Timer id for the next scheduled detection pass.
let detectLoopActive = false; // True while the repeating detector loop is supposed to keep running.
let detectModel = null; // Cached COCO-SSD model instance after first successful load.
let detectModelReady = false; // Guards repeated COCO model loading work.
let droneDetectSession = null; // Cached ONNX Runtime session for AeroYOLO.
let droneDetectSessionReady = false; // Guards repeated ONNX session creation work.
let isDetecting = false; // Prevents two detection passes from running on the same page at once.
let frameCounter = 0; // Monotonic counter used in telemetry rows to preserve ordering.
let lastDetectState = ''; // Last coarse state logged to the console: clear, possible, target, or error.
let lastDetectLabel = ''; // Last label/message associated with the coarse state to reduce duplicate logs.
let detectBackendReady = false; // Tracks whether TensorFlow backend initialization was already attempted.
let detectSourceCanvas = null; // Reusable off-screen canvas used for frame resizing and ONNX preprocessing.
let detectSourceCtx = null; // 2D context for that reusable off-screen canvas.
const sessionTelemetry = []; // In-memory ring-like buffer of recent detection telemetry rows.

// trackingState stores the current target lock, its filtered center, and the derived operator assist values.
// control.js reads this object directly for status cards, simulated move hints, and telemetry download.
/** @type {TrackingState} */
const trackingState = {
  hasTarget: false, // True only when the pipeline currently considers one target locked.
  isPossible: false, // True when the target exists but did not pass the stronger threshold.
  label: '', // Current target class label like drone or helicopter.
  score: 0, // Current target confidence score as a 0..1 float.
  rawCenterX: 0, // Raw unsmoothed X center of the selected target in overlay space.
  rawCenterY: 0, // Raw unsmoothed Y center of the selected target in overlay space.
  filteredCenterX: 0, // Smoothed X center used for operator guidance and track stability.
  filteredCenterY: 0, // Smoothed Y center used for operator guidance and track stability.
  filteredDeltaX: 0, // Smoothed horizontal distance from screen center in pixels.
  filteredDeltaY: 0, // Smoothed vertical distance from screen center in pixels.
  filteredNormX: 0, // Smoothed horizontal distance normalized to the range roughly -1..1.
  filteredNormY: 0, // Smoothed vertical distance normalized to the range roughly -1..1.
  simPan: 0, // Numeric pan guidance derived from the normalized horizontal offset.
  simTilt: 0, // Numeric tilt guidance derived from the normalized vertical offset.
  simPanLabel: 'HOLD', // Human-readable pan guidance like HOLD or LEFT_SMALL.
  simTiltLabel: 'HOLD', // Human-readable tilt guidance like HOLD or UP_MED.
  loopMs: 0, // Measured duration of the last full detection pass.
  missedFrames: 0, // Consecutive frames in which no valid target was selected.
};

window.SkyShieldTracking = trackingState;

// Section: settings and target-selection helpers.
// These helpers convert the settings controls into structured backend/profile configuration.
/**
 * @param {string} profileId - Saved or selected profile id.
 * @returns {object} Matching profile config object.
 */
// EXAM: detection profile lookup.
function getProfile(profileId) {
  // Return the requested profile, or fall back to the strict/default one.
  return PROFILES[profileId] || PROFILES.strict;
}

/**
 * @param {string} backendId - Saved or selected backend id.
 * @returns {object} Matching backend config object.
 */
// EXAM: detection backend lookup.
function getDetectBackend(backendId) {
  // Return the requested backend, or fall back to COCO if the value is unknown.
  return DETECT_BACKENDS[backendId] || DETECT_BACKENDS.coco;
}

/**
 * @param {object|null} profile - Active profile config.
 * @param {string} backendId - Active detector backend id.
 * @returns {string[]} Allowed labels for that profile/backend combination.
 */
// EXAM: backend-specific allowed labels.
function getProfileLabels(profile, backendId) {
  if (!profile) return [];
  // Each backend speaks different class names, so the active profile has backend-specific allow-lists.
  return backendId === 'aeroyolo' ? (profile.aeroyoloLabels || []) : (profile.cocoLabels || []);
}

// Settings are always read from the live controls first, then clamped to safe numeric ranges.
/**
 * @returns {DetectionSettings} Active detector settings.
 */
// EXAM: read live detector settings.
function getSettings() {
  // Read the backend selector from the page, falling back to the default backend id.
  const backend = getDetectBackend(detectBackendSelect ? detectBackendSelect.value : DEFAULT_DETECT_BACKEND_ID); // Fully resolved backend object chosen by the operator.
  // Read the profile selector from the page, falling back to strict mode.
  const profile = getProfile(detectProfileSelect ? detectProfileSelect.value : 'strict'); // Fully resolved profile object chosen by the operator.
  // Clamp each numeric control so bad inputs cannot create impossible settings.
  const strongThreshold = clamp(strongThresholdInput && strongThresholdInput.value, 0.05, 0.99, 0.3); // Confidence needed for a full red "target" state.
  const possibleThreshold = clamp(possibleThresholdInput && possibleThresholdInput.value, 0.01, strongThreshold, 0.12); // Lower confidence needed for amber "possible target" state.
  const smoothingAlpha = clamp(smoothingInput && smoothingInput.value, 0.05, 1, 0.35); // Blend factor used by exponential smoothing of target movement.
  const deadZone = clamp(deadZoneInput && deadZoneInput.value, 0, 0.5, 0.08); // Center tolerance where simulated movement becomes HOLD.
  return { backend, profile, strongThreshold, possibleThreshold, smoothingAlpha, deadZone };
}

/**
 * Saves the current detector settings to localStorage.
 */
// EXAM: persist detector settings.
function saveSettings() {
  const settings = getSettings(); // Snapshot of the currently visible detector tuning controls.
  // Persist the exact knobs shown in the UI so refreshes reopen with the same detector behavior.
  localStorage.setItem(DETECTION_SETTINGS_STORAGE_KEY, JSON.stringify({
    backendId: settings.backend.id,
    profileId: settings.profile.id,
    strongThreshold: settings.strongThreshold,
    possibleThreshold: settings.possibleThreshold,
    smoothingAlpha: settings.smoothingAlpha,
    deadZone: settings.deadZone,
  }));
  setProfileStatus(settings.profile.id);
}

/**
 * Loads detector settings from localStorage and applies them to the page controls.
 */
// EXAM: restore detector settings.
function loadSettings() {
  let saved = null; // Raw parsed object loaded from localStorage before validation/defaulting.
  try {
    // Parse the persisted detector settings if they exist.
    saved = JSON.parse(localStorage.getItem(DETECTION_SETTINGS_STORAGE_KEY) || 'null');
  } catch (err) {
    console.warn('Failed to parse saved detection settings.', err);
  }
  // Recreate safe backend/profile objects from the saved ids.
  const backend = getDetectBackend((saved && saved.backendId) || DEFAULT_DETECT_BACKEND_ID); // Safe backend object rebuilt from saved data.
  const profile = getProfile(saved && saved.profileId); // Safe profile object rebuilt from saved data.
  // Push those saved values back into the visible UI controls.
  if (detectBackendSelect) detectBackendSelect.value = backend.id;
  if (detectProfileSelect) detectProfileSelect.value = profile.id;
  if (strongThresholdInput) strongThresholdInput.value = String(clamp(saved && saved.strongThreshold, 0.05, 0.99, 0.3));
  if (possibleThresholdInput) possibleThresholdInput.value = String(clamp(saved && saved.possibleThreshold, 0.01, 0.95, 0.12));
  if (smoothingInput) smoothingInput.value = String(clamp(saved && saved.smoothingAlpha, 0.05, 1, 0.35));
  if (deadZoneInput) deadZoneInput.value = String(clamp(saved && saved.deadZone, 0, 0.5, 0.08));
  setProfileStatus(profile.id);
}

// Track-lock helpers allow a nearby follow-up detection to use slightly relaxed thresholds.
/**
 * @returns {boolean} True when the tracker still considers the previous target locked.
 */
// EXAM: check whether a target lock still exists.
function hasTrackLock() {
  // A track lock exists only when we still have a target label and have not missed too many frames.
  return trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT && !!trackingState.label;
}

/**
 * @param {object|null} metrics - Candidate detection metrics in screen space.
 * @returns {boolean} True when the candidate is close to the locked target.
 */
// EXAM: compare a new box to the previous lock.
function isNearLockedTarget(metrics) {
  if (!hasTrackLock() || !metrics || !overlayCanvas) return false;
  // Distance is normalized against the on-screen diagonal so the rule behaves similarly on different viewport sizes.
  const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height)); // Overlay diagonal used to normalize distance across screen sizes.
  const distance = Math.hypot(metrics.centerX - trackingState.filteredCenterX, metrics.centerY - trackingState.filteredCenterY); // Pixel distance between candidate center and current filtered target center.
  return distance / diag <= TRACK_LOCK_DISTANCE_RATIO;
}

// clearTargetTelemetry resets both the HUD readouts and the in-memory tracking state when a target is lost.
/**
 * Resets tracking state and all target-related UI readouts.
 */
// EXAM: clear target state and HUD readouts.
function clearTargetTelemetry() {
  // Reset every visible target readout to a neutral placeholder.
  setReadout(targetLabelVal, 'n/a');
  setReadout(targetScoreVal, 'n/a');
  setReadout(targetCenterVal, 'n/a');
  setReadout(targetCenterFilteredVal, 'n/a');
  setReadout(targetDeltaVal, 'n/a');
  setReadout(targetDeltaNormVal, 'n/a');
  setReadout(simCommandVal, 'HOLD / HOLD');
  setReadout(loopTimeVal, 'n/a');
  // Also wipe the in-memory target state so later frames start from a clean slate.
  Object.assign(trackingState, {
    hasTarget: false,
    isPossible: false,
    label: '',
    score: 0,
    rawCenterX: 0,
    rawCenterY: 0,
    filteredCenterX: 0,
    filteredCenterY: 0,
    filteredDeltaX: 0,
    filteredDeltaY: 0,
    filteredNormX: 0,
    filteredNormY: 0,
    simPan: 0,
    simTilt: 0,
    simPanLabel: 'HOLD',
    simTiltLabel: 'HOLD',
    loopMs: 0,
    missedFrames: 0,
  });
  updateOperatorAssistReadout();
}
