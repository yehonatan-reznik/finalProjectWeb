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

// Overlay geometry converts detections from image space into the displayed canvas space.
/**
 * Sizes the overlay canvas to match the displayed camera container.
 */
// EXAM: match overlay canvas to displayed image size.
function syncOverlaySize() {
  if (!(overlayCanvas && feedImg && feedImg.parentElement)) return;
  // Match the canvas to the displayed image container, not the raw image pixels, because drawing happens in screen space.
  overlayCanvas.width = Math.round(feedImg.parentElement.clientWidth || 0);
  overlayCanvas.height = Math.round(feedImg.parentElement.clientHeight || 0);
}

/**
 * Clears all overlay graphics from the canvas.
 */
// EXAM: wipe overlay drawings.
function clearOverlay() {
  if (overlayCtx && overlayCanvas) {
    // Remove every old box/reticle pixel from the canvas.
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }
}

/**
 * @returns {{scale: number, offsetX: number, offsetY: number}|null} Display scaling info for the camera image.
 */
// EXAM: compute how the image is fitted into the viewport.
function getImageFit() {
  // If we do not yet know the actual image size, we cannot map detections to the screen.
  if (!(feedImg && feedImg.parentElement && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // Measure the displayed container size, not the raw image size.
  const width = feedImg.parentElement.clientWidth; // Actual displayed width of the image container in CSS pixels.
  const height = feedImg.parentElement.clientHeight; // Actual displayed height of the image container in CSS pixels.
  // object-fit: contain means the image scales uniformly until it fits inside the container.
  const scale = Math.min(width / feedImg.naturalWidth, height / feedImg.naturalHeight); // Contain-scale factor used by the browser for the image.
  const displayWidth = feedImg.naturalWidth * scale; // Visible width of the image content after contain-scaling.
  const displayHeight = feedImg.naturalHeight * scale; // Visible height of the image content after contain-scaling.
  return { scale, offsetX: (width - displayWidth) / 2, offsetY: (height - displayHeight) / 2 };
}

/**
 * @param {{bbox: number[]}} det - Detection object containing an image-space bbox.
 * @returns {object|null} Screen-space metrics for drawing and tracking.
 */
// EXAM: convert image-space bbox into overlay-space metrics.
function computeMetrics(det) {
  syncOverlaySize();
  const fit = getImageFit(); // Mapping data that converts raw image pixels into on-screen canvas coordinates.
  if (!fit) return null;
  // Unpack the model bbox, which is stored as [x, y, width, height].
  const [rawX, rawY, rawW, rawH] = det.bbox; // Raw model bbox encoded as image-space x, y, width, height.
  // Convert raw image-space coordinates into displayed canvas-space coordinates.
  const x = rawX * fit.scale + fit.offsetX; // Screen-space left edge after scale + contain offset.
  const y = rawY * fit.scale + fit.offsetY; // Screen-space top edge after scale + contain offset.
  const w = rawW * fit.scale; // Screen-space width after scale.
  const h = rawH * fit.scale; // Screen-space height after scale.
  if (w <= 0 || h <= 0) return null;
  const centerX = x + w / 2; // Horizontal center of the detection box on screen.
  const centerY = y + h / 2; // Vertical center of the detection box on screen.
  const screenCenterX = overlayCanvas.width / 2; // Horizontal center of the visible camera viewport.
  const screenCenterY = overlayCanvas.height / 2; // Vertical center of the visible camera viewport.
  const deltaX = centerX - screenCenterX; // Positive means target is to the right of center.
  // Positive deltaY means the target sits above center, which matches the later UP/DOWN assist labels.
  const deltaY = screenCenterY - centerY;
  // Normalized deltas collapse every viewport into a -1..1 range for simpler assist logic.
  const normX = screenCenterX ? Math.max(-1, Math.min(1, deltaX / screenCenterX)) : 0; // Right/left offset scaled to a stable range.
  const normY = screenCenterY ? Math.max(-1, Math.min(1, deltaY / screenCenterY)) : 0; // Up/down offset scaled to a stable range.
  return { x, y, w, h, centerX, centerY, deltaX, deltaY, normX, normY };
}

// Candidate ranking filters the raw model output into the single target the UI should track.
/**
 * @param {string} className - Candidate class label.
 * @param {object|null} metrics - Candidate metrics in screen space.
 * @param {object} settings - Active detector settings.
 * @returns {{possible: number, strong: number}} Thresholds for this candidate.
 */
// EXAM: possible/strong threshold logic with track-lock relaxation.
function getDetectionThresholds(className, metrics, settings) {
  const base = { // Base thresholds before any track-lock relaxation is applied.
    possible: settings.possibleThreshold,
    strong: settings.strongThreshold,
  };
  // Only the same nearby target gets the relaxed "track lock" thresholds.
  if (!(hasTrackLock() && className === trackingState.label && isNearLockedTarget(metrics))) return base;
  return {
    possible: Math.max(TRACK_LOCK_MIN_SCORE, base.possible * TRACK_LOCK_THRESHOLD_FACTOR),
    strong: Math.max(TRACK_LOCK_MIN_SCORE, base.strong * TRACK_LOCK_THRESHOLD_FACTOR),
  };
}

/**
 * @param {object[]} predictions - Raw model predictions.
 * @param {object} settings - Active detector settings.
 * @returns {object[]} Decorated detection objects with metrics and candidate flags.
 */
// EXAM: decorate raw predictions into candidate objects.
function buildDetections(predictions, settings) {
  const labels = new Set(getProfileLabels(settings.profile, settings.backend.id)); // Fast lookup table of labels allowed by the current profile/backend pair.
  return predictions
    // Keep low-confidence clutter out of the overlay entirely.
    .filter((p) => (p.score || 0) >= DRAW_THRESHOLD)
    .map((p) => {
      const metrics = computeMetrics(p); // Screen-space geometry derived from the raw prediction bbox.
      const thresholds = getDetectionThresholds(p.class, metrics, settings); // Possible/strong thresholds for this specific candidate.
      const score = p.score || 0; // Defensive normalized confidence score.
      // Every backend is normalized into the same decorated detection shape so selection/drawing code can stay shared.
      return {
        ...p,
        metrics,
        // isCandidate means "allow this into target selection"; isStrong means "show this as a real target".
        // A candidate is allowed to compete for tracking; a strong candidate is good enough to count as a real target.
        isCandidate: labels.has(p.class) && score >= thresholds.possible,
        isStrong: labels.has(p.class) && score >= thresholds.strong,
      };
    });
}

/**
 * @param {object[]} candidates - Candidate detections already filtered for track eligibility.
 * @returns {object|null} Single best detection to track.
 */
// EXAM: choose the one active target.
function chooseCandidate(candidates) {
  // Selection rule:
  // - Start with confidence score as the main ranking signal.
  // - If a target was already locked, subtract a distance penalty from far-away boxes.
  // - This keeps the tracker stable without making jumps impossible.
  if (!candidates.length) return null;
  return candidates.reduce((best, det) => {
    // Start ranking mostly by confidence score.
    let detRank = det.score || 0; // Working rank for the challenger candidate.
    let bestRank = best.score || 0; // Working rank for the current best candidate.
    // When a target is already locked, penalize far-away boxes so the tracker stays stable.
    if (trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT) {
      const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height)); // Used to normalize the distance penalty.
      // This penalty does not block jumps entirely; it just requires a farther box to be materially more confident.
      detRank -= Math.hypot(det.metrics.centerX - trackingState.filteredCenterX, det.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
      bestRank -= Math.hypot(best.metrics.centerX - trackingState.filteredCenterX, best.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
    }
    return detRank > bestRank ? det : best;
  });
}

// Smoothing keeps the overlay and operator hints from jumping on every raw frame.
/**
 * @param {DetectionMetrics} raw - Unsmooth candidate metrics for the selected target.
 * @param {DetectionSettings} settings - Active detector settings.
 * @returns {{centerX: number, centerY: number, deltaX: number, deltaY: number, normX: number, normY: number}} Smoothed metrics.
 */
// EXAM: smooth target motion.
function smoothMetrics(raw, settings) {
  if (!trackingState.hasTarget || trackingState.missedFrames >= LOST_LIMIT) {
    return { centerX: raw.centerX, centerY: raw.centerY, deltaX: raw.deltaX, deltaY: raw.deltaY, normX: raw.normX, normY: raw.normY };
  }
  // Exponential smoothing makes the assist hints steadier without hiding larger target movement.
  const a = settings.smoothingAlpha; // Blend factor: higher values follow the raw target more aggressively.
  const centerX = trackingState.filteredCenterX + a * (raw.centerX - trackingState.filteredCenterX); // Smoothed X center.
  const centerY = trackingState.filteredCenterY + a * (raw.centerY - trackingState.filteredCenterY); // Smoothed Y center.
  const dx = centerX - overlayCanvas.width / 2; // Smoothed horizontal delta from screen center.
  const dy = overlayCanvas.height / 2 - centerY; // Smoothed vertical delta from screen center with positive meaning above center.
  const normX = overlayCanvas.width ? Math.max(-1, Math.min(1, dx / (overlayCanvas.width / 2))) : 0; // Smoothed normalized horizontal offset.
  const normY = overlayCanvas.height ? Math.max(-1, Math.min(1, dy / (overlayCanvas.height / 2))) : 0; // Smoothed normalized vertical offset.
  return { centerX, centerY, deltaX: dx, deltaY: dy, normX, normY };
}

/**
 * @param {number} norm - Normalized offset along one axis.
 * @param {number} deadZone - Center tolerance where movement becomes HOLD.
 * @param {string} negLabel - Label used when movement should go negative on that axis.
 * @param {string} posLabel - Label used when movement should go positive on that axis.
 * @returns {{value: number, label: string}} Simulated movement output for one axis.
 */
// EXAM: convert one normalized axis into HOLD/LEFT/RIGHT style guidance.
function simAxis(norm, deadZone, negLabel, posLabel) {
  const mag = Math.abs(norm); // Direction-free strength of the offset on this axis.
  if (mag < deadZone) return { value: 0, label: 'HOLD' };
  // Three coarse bands are enough for operator guidance and easier to read than raw float output.
  const step = mag >= 0.45 ? 1 : mag >= 0.22 ? 0.5 : 0.25; // Coarse numeric strength sent to simulated guidance.
  const suffix = mag >= 0.45 ? 'LARGE' : mag >= 0.22 ? 'MED' : 'SMALL'; // Human-readable size band paired with the numeric step.
  return { value: norm < 0 ? -step : step, label: `${norm < 0 ? negLabel : posLabel}_${suffix}` };
}

/**
 * @param {{normX: number, normY: number}} filtered - Smoothed normalized target offset.
 * @param {object} settings - Active detector settings.
 * @returns {{pan: number, tilt: number, panLabel: string, tiltLabel: string}} Simulated pan/tilt output.
 */
// EXAM: convert target offset into simulated pan/tilt guidance.
function simCommand(filtered, settings) {
  // Horizontal offset becomes a pan hint; vertical offset becomes a tilt hint.
  const pan = simAxis(filtered.normX, settings.deadZone, 'LEFT', 'RIGHT'); // Horizontal guidance derived from the filtered target offset.
  const tilt = simAxis(filtered.normY, settings.deadZone, 'DOWN', 'UP'); // Vertical guidance derived from the filtered target offset.
  return { pan: pan.value, tilt: tilt.value, panLabel: pan.label, tiltLabel: tilt.label };
}

/**
 * @returns {string} Compact human-readable movement direction summary for the event console.
 */
// EXAM: human-readable movement summary.
function describeCameraMove() {
  // Parse the two axis hints that were already generated for the currently tracked target.
  const panAssist = parseSimLabel(trackingState.simPanLabel); // Parsed current pan hint from shared tracking state.
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel); // Parsed current tilt hint from shared tracking state.
  const moves = []; // Human-readable movement directions that will be joined into one log string.
  if (panAssist.direction !== 'hold') moves.push(friendlyDirection(panAssist.direction));
  if (tiltAssist.direction !== 'hold') moves.push(friendlyDirection(tiltAssist.direction));
  return moves.length ? moves.join(' / ') : 'HOLD';
}

/**
 * @param {object} selected - Selected detection object.
 * @returns {string} One-line event console message describing the selected target.
 */
// EXAM: operator-facing target log line.
function buildTargetLogMessage(selected) {
  // Build one compact line for the event console with class, score, center, and suggested move.
  const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`; // Short class + confidence summary.
  const x = trackingState.rawCenterX.toFixed(0); // Raw X center rounded for compact logging.
  const y = trackingState.rawCenterY.toFixed(0); // Raw Y center rounded for compact logging.
  const move = describeCameraMove(); // Current simplified movement guidance string.
  return `Target detected: ${labelText} x=${x} y=${y} move=${move}`;
}

// Drawing helpers render both the full set of predictions and the currently selected target lock.
/**
 * Draws the fixed center reticle onto the overlay canvas.
 */
// EXAM: draw center reticle.
function drawReticle() {
  if (!(overlayCtx && overlayCanvas)) return;
  // The reticle is centered in the visible overlay so the operator can compare target offset to screen center.
  const cx = overlayCanvas.width / 2; // Horizontal center of the visible overlay.
  const cy = overlayCanvas.height / 2; // Vertical center of the visible overlay.
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(56,189,248,0.9)';
  overlayCtx.lineWidth = 1.2;
  overlayCtx.beginPath();
  overlayCtx.moveTo(cx - 22, cy);
  overlayCtx.lineTo(cx + 22, cy);
  overlayCtx.moveTo(cx, cy - 22);
  overlayCtx.lineTo(cx, cy + 22);
  overlayCtx.stroke();
  overlayCtx.setLineDash([4, 4]);
  overlayCtx.beginPath();
  overlayCtx.arc(cx, cy, 30, 0, Math.PI * 2);
  overlayCtx.stroke();
  overlayCtx.restore();
}

/**
 * @param {object[]} detections - All detections that should be drawn.
 * @param {object|null} selected - Detection currently chosen as the tracked target.
 */
// EXAM: draw boxes, labels, path line, and guidance overlay.
function drawScene(detections, selected) {
  // Drawing layers:
  // 1. Clear the canvas and redraw the center reticle.
  // 2. Draw every visible detection box so the operator sees model output, not just the chosen target.
  // 3. Color-code boxes by importance.
  // 4. If a target is locked, draw the center-to-target line and the simulated move summary.
  if (!(overlayCtx && overlayCanvas)) return;
  // Always resize/clear/redraw in that order so stale geometry never remains on screen.
  syncOverlaySize();
  clearOverlay();
  drawReticle();
  overlayCtx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  overlayCtx.textBaseline = 'top';
  detections.forEach((det) => {
    if (!det.metrics) return;
    const isSelected = det === selected; // True only for the detection currently chosen as the tracked target.
    // Selected target = blue, strong candidate = red, possible candidate = amber, other detection = green.
    const stroke = isSelected ? '#38bdf8' : det.isStrong ? '#ff4d4d' : det.isCandidate ? '#f59e0b' : '#22c55e'; // Per-box color chosen by target importance.
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = isSelected ? 3 : 2;
    overlayCtx.setLineDash(det.isCandidate && !det.isStrong && !isSelected ? [5, 3] : []);
    overlayCtx.strokeRect(det.metrics.x, det.metrics.y, det.metrics.w, det.metrics.h);
    // Non-candidate detections still get drawn so the operator can see what the model is seeing.
    const prefix = isSelected ? 'TRACK ' : det.isStrong ? 'TARGET ' : det.isCandidate ? 'POSSIBLE ' : ''; // Text prefix that tells the operator how important this box is.
    const label = `${prefix}${det.class} ${((det.score || 0) * 100).toFixed(1)}%`; // Full overlay label shown above the box.
    const width = overlayCtx.measureText(label).width + 8; // Background width needed for the label text plus padding.
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(det.metrics.x, Math.max(0, det.metrics.y - 16), width, 16);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(label, det.metrics.x + 4, Math.max(0, det.metrics.y - 15));
    overlayCtx.restore();
  });
  if (trackingState.hasTarget) {
    // When a target is locked, also draw a line from the screen center to the filtered target center.
    const cx = overlayCanvas.width / 2; // Horizontal center of the visible overlay.
    const cy = overlayCanvas.height / 2; // Vertical center of the visible overlay.
    overlayCtx.save();
    overlayCtx.strokeStyle = trackingState.isPossible ? '#f59e0b' : '#38bdf8';
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx, cy);
    overlayCtx.lineTo(trackingState.filteredCenterX, trackingState.filteredCenterY);
    overlayCtx.stroke();
    overlayCtx.fillStyle = '#f97316';
    overlayCtx.beginPath();
    overlayCtx.arc(trackingState.rawCenterX, trackingState.rawCenterY, 4, 0, Math.PI * 2);
    overlayCtx.fill();
    overlayCtx.fillStyle = trackingState.isPossible ? '#f59e0b' : '#38bdf8';
    overlayCtx.beginPath();
    overlayCtx.arc(trackingState.filteredCenterX, trackingState.filteredCenterY, 5, 0, Math.PI * 2);
    overlayCtx.fill();
    const text = `SIM ${trackingState.simPanLabel} / ${trackingState.simTiltLabel}`; // Compact simulated movement summary drawn into the overlay.
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(10, 10, overlayCtx.measureText(text).width + 12, 18);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(text, 16, 12);
    overlayCtx.restore();
  }
}

// updateSelectedTarget bridges raw detections into the HUD, operator assist, and exported telemetry.
/**
 * @param {object} selected - Detection chosen as the tracked target.
 * @param {object} settings - Active detector settings.
 * @param {number} loopMs - Measured duration of the current detection pass.
 */
// EXAM: commit the chosen target into shared state.
function updateSelectedTarget(selected, settings, loopMs) {
  // This is the handoff point from "model result" to "shared app state".
  // After this function runs:
  // - trackingState holds the official target
  // - HUD cards show its position/score
  // - operator assist can rebuild from trackingState alone
  // Smooth the raw target center first so the UI is less jittery.
  const filtered = smoothMetrics(selected.metrics, settings); // Smoothed version of the selected target geometry.
  // Convert the filtered offset into manual movement hints.
  const sim = simCommand(filtered, settings); // Simulated pan/tilt guidance derived from the smoothed geometry.
  // Cache the chosen target and all derived values into shared runtime state.
  trackingState.hasTarget = true;
  trackingState.isPossible = !selected.isStrong;
  trackingState.label = selected.class;
  trackingState.score = selected.score || 0;
  trackingState.rawCenterX = selected.metrics.centerX;
  trackingState.rawCenterY = selected.metrics.centerY;
  trackingState.filteredCenterX = filtered.centerX;
  trackingState.filteredCenterY = filtered.centerY;
  trackingState.filteredDeltaX = filtered.deltaX;
  trackingState.filteredDeltaY = filtered.deltaY;
  trackingState.filteredNormX = filtered.normX;
  trackingState.filteredNormY = filtered.normY;
  trackingState.simPan = sim.pan;
  trackingState.simTilt = sim.tilt;
  trackingState.simPanLabel = sim.panLabel;
  trackingState.simTiltLabel = sim.tiltLabel;
  trackingState.loopMs = loopMs;
  trackingState.missedFrames = 0;
  // Mirror that cached state into the visible readout cards.
  setReadout(targetLabelVal, selected.isStrong ? selected.class : `Possible ${selected.class}`);
  setReadout(targetScoreVal, `${((selected.score || 0) * 100).toFixed(1)}%`);
  setReadout(targetCenterVal, formatPoint(selected.metrics.centerX, selected.metrics.centerY));
  setReadout(targetCenterFilteredVal, formatPoint(filtered.centerX, filtered.centerY));
  setReadout(targetDeltaVal, formatPoint(filtered.deltaX, filtered.deltaY));
  setReadout(targetDeltaNormVal, formatNorm(filtered.normX, filtered.normY));
  setReadout(simCommandVal, `${sim.panLabel} (${sim.pan.toFixed(2)}) / ${sim.tiltLabel} (${sim.tilt.toFixed(2)})`);
  setReadout(loopTimeVal, loopMs.toFixed(1));
  // control.js owns the assist card, but it rebuilds from this shared tracking state.
  updateOperatorAssistReadout();
}

/**
 * @param {object} entry - Telemetry row to append to the rolling session buffer.
 */
// EXAM: append one telemetry row.
function pushTelemetry(entry) {
  sessionTelemetry.push(entry);
  // Keep telemetry bounded in memory so a long session does not slowly grow the page footprint forever.
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

// The detection loop yields back to the browser between frames so UI and fetch handlers stay responsive.
/**
 * @returns {Promise<void>} Resolves after yielding one frame back to the browser event loop.
 */
// EXAM: yield control back to the browser.
async function yieldToBrowser() {
  if (window.tf && typeof tf.nextFrame === 'function') {
    try {
      // tf.nextFrame is TensorFlow's preferred way to yield in graphics-heavy loops.
      await tf.nextFrame();
      return;
    } catch (err) {
      console.warn('tf.nextFrame() failed, falling back to requestAnimationFrame.', err);
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Section: frame preparation and backend normalization.
// Input preparation handles either low-resolution TF.js detection or the padded ONNX path.
/**
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}|null} Reusable off-screen surface.
 */
// EXAM: prepare reusable off-screen canvas.
function ensureDetectSourceSurface() {
  // Lazily create one reusable off-screen canvas instead of allocating a new one every frame.
  if (!detectSourceCanvas) detectSourceCanvas = document.createElement('canvas');
  if (!detectSourceCtx && detectSourceCanvas) detectSourceCtx = detectSourceCanvas.getContext('2d', { alpha: false });
  return detectSourceCanvas && detectSourceCtx ? { canvas: detectSourceCanvas, ctx: detectSourceCtx } : null;
}

/**
 * @returns {{source: HTMLImageElement|HTMLCanvasElement, scaleX: number, scaleY: number}|null} Inference source and scale info.
 */
// EXAM: prepare source frame for COCO detection.
function getDetectionSource() {
  if (!(feedImg && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // COCO-SSD is lighter than AeroYOLO, but it still benefits from shrinking large frames.
  // This path optionally downscales the stream into a reusable off-screen canvas.
  // Later, rescalePredictionBBox() maps boxes back to the original image coordinates.
  // Calculate how much we can shrink the source while staying inside the configured max dimensions.
  const downscale = Math.min(
    1,
    DETECT_MAX_SOURCE_WIDTH / feedImg.naturalWidth,
    DETECT_MAX_SOURCE_HEIGHT / feedImg.naturalHeight
  ); // Shrink factor chosen so the source stays within the configured inference budget.
  if (downscale >= 0.999) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const surface = ensureDetectSourceSurface(); // Reusable off-screen canvas pair used to avoid allocating a new surface each frame.
  if (!surface) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const width = Math.max(1, Math.round(feedImg.naturalWidth * downscale)); // Downscaled inference width.
  const height = Math.max(1, Math.round(feedImg.naturalHeight * downscale)); // Downscaled inference height.
  // COCO-SSD can work directly on the image element, but this smaller canvas reduces per-frame inference cost a lot.
  // Resize into an off-screen canvas instead of mutating the visible image element.
  if (surface.canvas.width !== width) surface.canvas.width = width;
  if (surface.canvas.height !== height) surface.canvas.height = height;
  surface.ctx.clearRect(0, 0, width, height);
  surface.ctx.drawImage(feedImg, 0, 0, width, height);
  return {
    source: surface.canvas,
    scaleX: feedImg.naturalWidth / width,
    scaleY: feedImg.naturalHeight / height,
  };
}

/**
 * @param {object} prediction - Detection result returned from downscaled inference.
 * @param {number} scaleX - Horizontal expansion factor back to original pixels.
 * @param {number} scaleY - Vertical expansion factor back to original pixels.
 * @returns {object} Prediction with bbox scaled back to original image size.
 */
// EXAM: restore downscaled COCO boxes to real image size.
function rescalePredictionBBox(prediction, scaleX, scaleY) {
  if (!prediction || !Array.isArray(prediction.bbox) || prediction.bbox.length < 4) return prediction;
  // Expand the bbox back into the original image coordinate space after downscaled inference.
  const [x, y, w, h] = prediction.bbox; // Bbox returned from the lower-resolution source image.
  return {
    ...prediction,
    bbox: [x * scaleX, y * scaleY, w * scaleX, h * scaleY],
  };
}

/**
 * @param {number} modelWidth - Width expected by the ONNX model.
 * @param {number} modelHeight - Height expected by the ONNX model.
 * @returns {{input: Float32Array, scale: number, padX: number, padY: number}|null} Prepared tensor data and letterbox info.
 */
// EXAM: preprocess frame for AeroYOLO ONNX input.
function preprocessDroneDetectSource(modelWidth, modelHeight) {
  // ONNX preprocessing steps:
  // 1. Resize the reusable canvas to the model input size.
  // 2. Letterbox the original frame so aspect ratio is preserved.
  // 3. Read RGBA pixels from the canvas.
  // 4. Repack them into CHW float32 format in the 0..1 range.
  // 5. Return both the tensor data and the scale/padding needed to decode boxes later.
  const surface = ensureDetectSourceSurface(); // Reusable canvas/context pair used for ONNX preprocessing.
  if (!surface || !feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight) return null;
  const sourceWidth = feedImg.naturalWidth; // Original stream frame width.
  const sourceHeight = feedImg.naturalHeight; // Original stream frame height.
  // Letterboxing keeps the source aspect ratio while satisfying the fixed ONNX tensor size.
  const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight); // Letterbox scale factor that preserves aspect ratio.
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale)); // Width of the image content inside the model input tensor.
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale)); // Height of the image content inside the model input tensor.
  const padX = Math.floor((modelWidth - drawWidth) / 2); // Horizontal left/right letterbox padding.
  const padY = Math.floor((modelHeight - drawHeight) / 2); // Vertical top/bottom letterbox padding.
  // Resize the reusable canvas to exactly match the model input tensor size.
  if (surface.canvas.width !== modelWidth) surface.canvas.width = modelWidth;
  if (surface.canvas.height !== modelHeight) surface.canvas.height = modelHeight;
  surface.ctx.clearRect(0, 0, modelWidth, modelHeight);
  surface.ctx.fillStyle = '#727272';
  // Fill the letterbox padding with a neutral gray so empty areas are consistent frame to frame.
  surface.ctx.fillRect(0, 0, modelWidth, modelHeight);
  surface.ctx.drawImage(feedImg, padX, padY, drawWidth, drawHeight);
  const imageData = surface.ctx.getImageData(0, 0, modelWidth, modelHeight).data; // Flat RGBA pixel buffer for the resized letterboxed frame.
  const channelSize = modelWidth * modelHeight; // Number of pixels per color channel in the model input.
  // Allocate [R-plane][G-plane][B-plane] because ONNX expects CHW layout, not RGBA pixels.
  const input = new Float32Array(channelSize * 3); // Final CHW float input buffer consumed by ONNX Runtime.
  // ONNX expects CHW float32 input in the 0..1 range.
  for (let pixel = 0, i = 0; i < imageData.length; i += 4, pixel += 1) {
    input[pixel] = imageData[i] / 255;
    input[channelSize + pixel] = imageData[i + 1] / 255;
    input[channelSize * 2 + pixel] = imageData[i + 2] / 255;
  }
  return { input, scale, padX, padY };
}

/**
 * @param {number[]} bbox - Bounding box to clamp into the visible feed dimensions.
 * @returns {number[]} Safe bbox inside the feed bounds.
 */
// EXAM: clamp decoded box to image bounds.
function clampBboxToFeed(bbox) {
  if (!feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight || !Array.isArray(bbox) || bbox.length < 4) return bbox;
  // Clamp the decoded model box so drawing math never exceeds the image bounds.
  const [rawX, rawY, rawW, rawH] = bbox; // Raw decoded bbox before enforcing image bounds.
  const x = Math.max(0, Math.min(feedImg.naturalWidth, rawX)); // Left edge clamped into the visible image width.
  const y = Math.max(0, Math.min(feedImg.naturalHeight, rawY)); // Top edge clamped into the visible image height.
  const w = Math.max(0, Math.min(feedImg.naturalWidth - x, rawW)); // Width clamped so the box does not extend past the image.
  const h = Math.max(0, Math.min(feedImg.naturalHeight - y, rawH)); // Height clamped so the box does not extend past the image.
  return [x, y, w, h];
}

/**
 * @param {ArrayLike<number>} data - Flat ONNX output buffer.
 * @param {number} offset - Starting index of the current prediction row.
 * @param {{scale: number, padX: number, padY: number}} prepared - Letterbox metadata used to decode the row.
 * @returns {object|null} Decoded prediction in shared bbox format.
 */
// EXAM: decode one ONNX row into shared prediction format.
function normalizeDroneModelPrediction(data, offset, prepared) {
  if (!prepared || !Number.isFinite(prepared.scale) || prepared.scale <= 0) return null;
  // Read one 6-value prediction row from the flat ONNX output buffer.
  const x1 = Number(data[offset]); // Raw left coordinate from the ONNX output row.
  const y1 = Number(data[offset + 1]); // Raw top coordinate from the ONNX output row.
  const x2 = Number(data[offset + 2]); // Raw right coordinate from the ONNX output row.
  const y2 = Number(data[offset + 3]); // Raw bottom coordinate from the ONNX output row.
  const scoreRaw = Number(data[offset + 4]); // Raw confidence score from the ONNX output row.
  const classIdRaw = Number(data[offset + 5]); // Raw class id from the ONNX output row.
  const score = Number.isFinite(scoreRaw) ? scoreRaw : 0; // Safe normalized confidence score.
  const classId = Number.isFinite(classIdRaw) ? Math.round(classIdRaw) : -1; // Safe integer class id.
  // Unknown class ids are still preserved under a synthetic label so debugging output stays inspectable.
  const className = DRONE_MODEL_LABELS[classId] || `class_${classId}`; // Human-readable label looked up from the class map.
  const width = Math.max(0, (x2 - x1) / prepared.scale); // Decoded bbox width after undoing model-space scaling.
  const height = Math.max(0, (y2 - y1) / prepared.scale); // Decoded bbox height after undoing model-space scaling.
  const bbox = clampBboxToFeed([
    (x1 - prepared.padX) / prepared.scale,
    (y1 - prepared.padY) / prepared.scale,
    width,
    height,
  ]); // Final bbox converted back into original image coordinates and clamped into bounds.
  // Convert the raw model row into the same shape returned by COCO-SSD so the rest of the pipeline stays shared.
  return {
    class: className,
    score,
    classId,
    bbox,
  };
}

// Section: model bootstrapping and inference.
// Model bootstrap is backend-specific: TF.js for COCO-SSD and ONNX Runtime Web for AeroYOLO.
/**
 * @returns {Promise<void>} Resolves after TensorFlow backend selection is complete.
 */
// EXAM: initialize TensorFlow backend.
async function ensureDetectBackend() {
  // Skip setup if it already happened or if TensorFlow is unavailable on this page.
  if (detectBackendReady || !window.tf) return;
  try {
    // Wait for TensorFlow.js runtime initialization to finish.
    await tf.ready();
    const currentBackend = typeof tf.getBackend === 'function' ? tf.getBackend() : ''; // TensorFlow backend currently active before any switch attempt.
    if (currentBackend !== 'webgl' && typeof tf.findBackend === 'function' && tf.findBackend('webgl')) {
      // Prefer WebGL for browser inference if it exists.
      await tf.setBackend('webgl');
      await tf.ready();
    }
    detectBackendReady = true;
    if (typeof tf.getBackend === 'function') logConsole(`TF backend: ${tf.getBackend()}`, 'text-muted');
  } catch (err) {
    detectBackendReady = true;
    console.warn('Failed to switch TensorFlow backend.', err);
  }
}

/**
 * @returns {Promise<object|null>} Loaded COCO-SSD model instance.
 */
// EXAM: load and cache COCO-SSD.
async function ensureCocoDetectModel() {
  // Reuse the already-loaded model if it is present.
  if (detectModelReady && detectModel) return detectModel;
  if (!window.cocoSsd) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('COCO-SSD model missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
    await ensureDetectBackend();
    // Load the COCO-SSD model bundle from the global library.
    detectModel = await cocoSsd.load();
    detectModelReady = true;
    setDetectStatus('Detect: ready', 'bg-success');
    logConsole('Detection model loaded.', 'text-success');
    return detectModel;
  } catch (err) {
    console.error('Detection model load failed', err);
    setDetectStatus('Detect: load failed', 'bg-danger');
    logConsole('Detection model load failed.', 'text-danger');
    return null;
  }
}

/**
 * @returns {Promise<object|null>} Loaded ONNX Runtime inference session.
 */
// EXAM: load and cache the AeroYOLO ONNX session.
async function ensureDroneDetectSession() {
  // Backend strategy:
  // - Prefer WebGPU because browser GPU inference is faster when available.
  // - Fall back to WASM so the detector still runs on weaker or unsupported machines.
  // - Cache the session because creating it is expensive compared to a normal frame pass.
  // Reuse the already-created ONNX session if it is ready.
  if (droneDetectSessionReady && droneDetectSession) return droneDetectSession;
  if (!(window.ort && ort.InferenceSession && ort.Tensor)) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('ONNX Runtime Web support missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
    // Use one WASM thread to keep resource use predictable on small machines.
    if (ort.env && ort.env.wasm) ort.env.wasm.numThreads = 1;
    try {
      droneDetectSession = await ort.InferenceSession.create(DRONE_MODEL_URL, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (primaryErr) {
      // WebGPU is preferred, but WASM keeps the detector usable on machines without it.
      console.warn('AeroYOLO WebGPU session failed, retrying with WASM only.', primaryErr);
      droneDetectSession = await ort.InferenceSession.create(DRONE_MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    }
    droneDetectSessionReady = true;
    setDetectStatus('Detect: ready', 'bg-success');
    logConsole('AeroYOLO model loaded.', 'text-success');
    return droneDetectSession;
  } catch (err) {
    console.error('AeroYOLO model load failed', err);
    setDetectStatus('Detect: load failed', 'bg-danger');
    logConsole('AeroYOLO model load failed.', 'text-danger');
    return null;
  }
}

// Each backend returns normalized prediction objects with a class, confidence score, and bbox.
/**
 * @returns {Promise<object[]>} Normalized predictions from the COCO backend.
 */
// EXAM: run one COCO inference pass.
async function detectWithCoco() {
  const model = await ensureCocoDetectModel(); // Cached or newly loaded COCO model instance.
  if (!model) return [];
  const detectionSource = getDetectionSource(); // Original image or downscaled off-screen source used for COCO inference.
  if (!detectionSource) return [];
  // Run COCO-SSD on either the original image or the downscaled off-screen canvas.
  const rawPredictions = await model.detect(detectionSource.source); // Raw predictions produced by COCO-SSD for this frame.
  return (detectionSource.scaleX === 1 && detectionSource.scaleY === 1)
    ? rawPredictions
    : rawPredictions.map((prediction) => rescalePredictionBBox(prediction, detectionSource.scaleX, detectionSource.scaleY));
}

/**
 * @returns {Promise<object[]>} Normalized predictions from the AeroYOLO backend.
 */
// EXAM: run one AeroYOLO inference pass.
async function detectWithAeroYolo() {
  // Function flow:
  // 1. Ensure the ONNX session exists.
  // 2. Read model input dimensions from session metadata.
  // 3. Preprocess the current frame into an ONNX tensor.
  // 4. Run the model.
  // 5. Decode every output row into the shared { class, score, bbox } format.
  const session = await ensureDroneDetectSession(); // Cached or newly created ONNX inference session.
  if (!session) return [];
  // Resolve the model input/output names from session metadata when possible.
  const inputName = session.inputNames && session.inputNames[0] ? session.inputNames[0] : 'images'; // Effective ONNX input tensor name.
  const outputName = session.outputNames && session.outputNames[0] ? session.outputNames[0] : 'output0'; // Effective ONNX output tensor name.
  const inputMeta = session.inputMetadata && session.inputMetadata[inputName] ? session.inputMetadata[inputName] : null; // Optional ONNX metadata describing input dimensions.
  const dims = inputMeta && Array.isArray(inputMeta.dimensions) ? inputMeta.dimensions : [1, 3, 640, 640]; // Fallback-safe ONNX input shape.
  const modelHeight = Number(dims[2]) || 640; // Height expected by the ONNX model input tensor.
  const modelWidth = Number(dims[3]) || 640; // Width expected by the ONNX model input tensor.
  const prepared = preprocessDroneDetectSource(modelWidth, modelHeight); // Preprocessed image tensor data + letterbox metadata.
  if (!prepared) return [];
  // Build the input tensor in the exact shape expected by the model.
  const tensor = new ort.Tensor('float32', prepared.input, [1, 3, modelHeight, modelWidth]); // Final ONNX input tensor for one frame.
  // The session output is backend-specific, so the next block normalizes it into the shared prediction contract.
  const result = await session.run({ [inputName]: tensor }); // Raw map of ONNX output tensors returned for this frame.
  const outputTensor = result && result[outputName] ? result[outputName] : null; // Main prediction tensor selected by output name.
  if (!outputTensor || !outputTensor.data || !Array.isArray(outputTensor.dims)) return [];
  // The current model returns one row per box, with 6 values per row: x1, y1, x2, y2, score, classId.
  const rows = outputTensor.dims[1] || 0; // Number of predicted boxes returned by the model.
  const stride = outputTensor.dims[2] || 6; // Number of scalar values stored per predicted row.
  const predictions = []; // Shared-format predictions accumulated from decoded ONNX rows.
  for (let i = 0; i < rows; i += 1) {
    const offset = i * stride; // Starting index of the current row inside the flat output buffer.
    // Decode each output row into the shared { class, score, bbox } shape.
    const prediction = normalizeDroneModelPrediction(outputTensor.data, offset, prepared); // Decoded shared-format prediction for this row.
    if (prediction) predictions.push(prediction);
  }
  return predictions;
}

// runDetection is the core detection pass: predict, select, update the HUD, log, and export telemetry.
/**
 * @returns {Promise<void>} Resolves after one detection pass finishes.
 */
// EXAM: full detection pipeline for one frame.
//START DETECTING
async function runDetection() {
  // Full frame pipeline:
  // 1. Guard against overlap and invalid stream state.
  // 2. Read the current detector settings.
  // 3. Run exactly one backend for this frame.
  // 4. Normalize predictions into one shared format.
  // 5. Filter and rank detections down to one selected target.
  // 6. Update HUD, overlay, logs, and telemetry.
  // 7. On failure, show a readable detector error instead of crashing silently.
  // Do not overlap detection passes or read from an empty/hidden stream.
  if (isDetecting || !feedImg || !feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  // Measure loop duration so the UI can show actual inference cadence.
  const startedAt = performance.now(); // Timestamp used to measure total duration of this detection pass.
  try {
    const settings = getSettings(); // Current detector settings snapshot used for this frame only.
    setProfileStatus(settings.profile.id);
    // Exactly one backend runs per frame. Everything after this point is intentionally backend-agnostic.
    //START DETECTING
    const predictions = settings.backend.id === 'aeroyolo' ? await detectWithAeroYolo() : await detectWithCoco(); // Shared-format raw predictions from the active backend.
    const detections = buildDetections(predictions, settings); // Decorated predictions including metrics and target flags.
    // Only candidate detections are allowed to compete for the single tracked target.
    const selected = chooseCandidate(detections.filter((det) => det.isCandidate && det.metrics)); // One chosen target, or null if nothing qualified.
    const loopMs = performance.now() - startedAt; // Measured end-to-end detector runtime for this pass.
    if (!selected) {
      // Count consecutive misses so the tracker can survive a few short dropouts.
      trackingState.missedFrames += 1;
      // We still draw all raw detections even when none qualified as a tracked air target.
      if (trackingState.missedFrames >= LOST_LIMIT) clearTargetTelemetry();
      drawScene(detections, null);
      setReadout(loopTimeVal, loopMs.toFixed(1));
      // Show the strongest seen class as a hint when the detector saw something, but nothing in-profile qualified.
      setDetectStatus(predictions.length ? `Detect: clear (${predictions.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b).class})` : 'Detect: clear', 'bg-success');
      setSafetyState('ok', 'Safe');
      setMode('Observe');
      if (lastDetectState !== 'clear') logConsole('No configured air target detected.', 'text-success');
      lastDetectState = 'clear';
      lastDetectLabel = '';
      // Telemetry keeps every frame outcome so the operator can export a post-run timeline.
      pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'clear', backend: settings.backend.id, profile: settings.profile.id, loopMs: Number(loopMs.toFixed(2)), predictionCount: predictions.length });
      return;
    }

    updateSelectedTarget(selected, settings, loopMs);
    drawScene(detections, selected);
    const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`; // Compact class + confidence summary reused in UI/log logic.
    const targetLogMessage = buildTargetLogMessage(selected); // Full one-line console message for a strong target event.
    const deltaText = ` dx=${trackingState.filteredDeltaX.toFixed(0)} dy=${trackingState.filteredDeltaY.toFixed(0)}`; // Compact delta summary reused in possible-target logs.
    if (selected.isStrong) {
      // Strong candidates become full danger/target events.
      setDetectStatus('Detect: target', 'bg-danger');
      setSafetyState('danger', 'Air target detected');
      // Strong events are logged every time because they represent the primary operator-facing alarm state.
      logConsole(targetLogMessage, 'text-danger');
      lastDetectState = 'target';
    } else {
      // Possible candidates are shown with a warning state but not the full danger state.
      setDetectStatus('Detect: possible', 'bg-warning text-dark');
      setSafetyState('warn', 'Possible air target');
      if (lastDetectState !== 'possible' || lastDetectLabel !== labelText) logConsole(`Possible target: ${labelText}${deltaText}`, 'text-warning');
      lastDetectState = 'possible';
    }
    lastDetectLabel = labelText;
    pushTelemetry({
      frame: ++frameCounter,
      at: new Date().toISOString(),
      state: selected.isStrong ? 'target' : 'possible',
      backend: settings.backend.id,
      profile: settings.profile.id,
      loopMs: Number(loopMs.toFixed(2)),
      label: selected.class,
      score: Number((selected.score || 0).toFixed(4)),
      rawCenter: {
        x: Number(trackingState.rawCenterX.toFixed(2)),
        y: Number(trackingState.rawCenterY.toFixed(2)),
      },
      filteredCenter: {
        x: Number(trackingState.filteredCenterX.toFixed(2)),
        y: Number(trackingState.filteredCenterY.toFixed(2)),
      },
      filteredDelta: {
        x: Number(trackingState.filteredDeltaX.toFixed(2)),
        y: Number(trackingState.filteredDeltaY.toFixed(2)),
        normX: Number(trackingState.filteredNormX.toFixed(4)),
        normY: Number(trackingState.filteredNormY.toFixed(4)),
      },
      sim: {
        pan: trackingState.simPan,
        tilt: trackingState.simTilt,
        panLabel: trackingState.simPanLabel,
        tiltLabel: trackingState.simTiltLabel,
      },
    });
  } catch (err) {
    console.error('Detection failed', err);
    // Try to expose the most useful human-readable reason to the operator.
    const text = err && err.message ? err.message : 'check camera address / stream'; // Best available human-readable error message.
    const corsBlocked = /tainted canvases|cross-origin|cross origin/i.test(text); // Heuristic for common browser pixel-read/CORS failures.
    setDetectStatus(corsBlocked ? 'Detect: blocked (CORS)' : 'Detect: error', corsBlocked ? 'bg-warning text-dark' : 'bg-danger');
    setSafetyState('warn', corsBlocked ? 'Detection blocked' : 'Scanning');
    clearTargetTelemetry();
    if (lastDetectState !== 'error' || lastDetectLabel !== text) logConsole(`Detection error: ${text}`, 'text-warning');
    lastDetectState = 'error';
    lastDetectLabel = text;
    // Error telemetry is intentionally compact because it may happen repeatedly on a broken stream.
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'error', error: text });
  } finally {
    // Yielding here gives the browser a chance to paint the latest HUD/overlay updates before the next pass starts.
    await yieldToBrowser();
    isDetecting = false;
  }
}

// Section: loop lifecycle.
// Detection loop scheduling keeps a target cadence while respecting actual inference time.
/**
 * @param {'idle'|'error'|string} reason - Why the loop is being stopped.
 */
// EXAM: stop the repeating detector loop.
function stopDetectionLoop(reason) {
  detectLoopActive = false;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = null;
  isDetecting = false;
  clearOverlay();
  // Stopping the loop always clears stale visuals so the operator never sees an old box on a disconnected feed.
  if (overlayCanvas) overlayCanvas.classList.add('d-none');
  lastDetectState = '';
  lastDetectLabel = '';
  clearTargetTelemetry();
  setMode('Manual');
  if (reason === 'idle') {
    // Idle is the normal "no stream" state.
    setDetectStatus('Detect idle', 'bg-secondary');
    setSafetyState('ok', 'Safe');
  } else if (reason === 'error') {
    // Error keeps the warning state visible because the operator may still expect a live feed.
    setDetectStatus('Detect: stream error', 'bg-warning');
  }
}

/**
 * @param {number} delay - Milliseconds to wait before the next detection pass.
 */
// EXAM: schedule the next detector pass.
function scheduleNextDetection(delay) {
  if (!detectLoopActive) return;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    // Measure one loop so the next timeout can compensate for inference time.
    const startedAt = performance.now(); // Timestamp used to compensate the next schedule against actual work time.
    await runDetection();
    // Keep a roughly fixed cadence: fast frames wait a little, slow frames continue almost immediately.
    scheduleNextDetection(Math.max(DETECT_MIN_IDLE_MS, DETECT_INTERVAL_MS - (performance.now() - startedAt)));
  }, Math.max(0, delay || 0));
}

/**
 * Starts the repeating detection loop if one is not already running.
 */
// EXAM: start the repeating detector loop.
//START DETECTING
function startDetectionLoop() {
  // This is the main entry point for detection after the camera stream is ready.
  // From here, the page begins repeatedly running runDetection() on incoming frames.
  // Prevent duplicate loops from being started by repeated load events.
  if (detectLoopActive || !feedImg) return;
  detectLoopActive = true;
  // The loop starts immediately after the image confirms it has drawable pixels.
  setDetectStatus('Detect: starting', 'bg-warning');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole('Detection loop started.', 'text-info');
  if (overlayCanvas) overlayCanvas.classList.remove('d-none');
  scheduleNextDetection(0);
}

// control.js defines init(), but we call it here so both halves of the control page are loaded first.
init();
