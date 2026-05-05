const DETECTION_SETTINGS_STORAGE_KEY = 'skyshield_detection_settings_v2';
const DRONE_MODEL_URL = '../models/aeroyolo.onnx';
const DEFAULT_DETECT_BACKEND_ID = 'aeroyolo';
const DETECT_INTERVAL_MS = 180;
const DETECT_MIN_IDLE_MS = 24;
// Low-resolution inference keeps browser inference responsive on normal laptops.
const DETECT_MAX_SOURCE_WIDTH = 384; 
const DETECT_MAX_SOURCE_HEIGHT = 384; 
const DRAW_THRESHOLD = 0.05; 
const LOST_LIMIT = 8; 
const MAX_TELEMETRY = 1200;
// Track-lock relaxes thresholds a bit when the next frame lands close to the last confirmed target.
const TRACK_LOCK_THRESHOLD_FACTOR = 0.6;
const TRACK_LOCK_DISTANCE_RATIO = 0.22;
const TRACK_LOCK_MIN_SCORE = 0.08;

// The detector can switch between a general browser model and the project-specific ONNX model.
/** @type {Record<string, DetectBackendConfig>} */
const DETECT_BACKENDS = {
  coco: { id: 'coco', label: 'COCO-SSD' },
  aeroyolo: { id: 'aeroyolo', label: 'AeroYOLO ONNX' },
};

// AeroYOLO exports numeric class ids, so this map turns the raw model output into readable labels.
const DRONE_MODEL_LABELS = {
  0: 'aircraft',
  1: 'drone',
  2: 'helicopter',
};
//strict = fewer allowed target classes
//broad = more allowed target classes

// Profiles decide which labels are considered real candidates for each backend.
// "strict" still allows the overlay to draw every raw detection, but only drone/helicopter can become tracked targets.
/** @type {Record<string, DetectProfile>} */
const PROFILES = {
  strict: {
    id: 'strict',
    label: 'Drone / rotorcraft focus',
    cocoLabels: ['airplane', 'aeroplane'],
    aeroyoloLabels: ['drone', 'helicopter'],
  },
  broad: {
    id: 'broad',
    label: 'Full air sweep',
    cocoLabels: ['airplane', 'aeroplane', 'bird', 'kite'],
    aeroyoloLabels: ['drone', 'aircraft', 'helicopter'],
  },
};

// Section: runtime state and caches.
// Detection runtime state is kept separate from controller/Firebase state so the page is easier to reason about.
// The TF.js model and the ONNX session are cached separately because only one backend is active at a time.
let detectTimer = null;
let detectLoopActive = false;
let detectModel = null;
let detectModelReady = false;
let droneDetectSession = null;
let droneDetectSessionReady = false;
let isDetecting = false;
let frameCounter = 0;
let lastDetectState = '';
let lastDetectLabel = '';
let detectBackendReady = false;
let detectSourceCanvas = null;
let detectSourceCtx = null;
const sessionTelemetry = [];

// trackingState stores the current target lock, its filtered center, and the derived operator assist values.
// control.js reads this object directly for status cards, simulated move hints, and telemetry download.
/** @type {TrackingState} */
const trackingState = {
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
};

window.SkyShieldTracking = trackingState;

// Section: settings and target-selection helpers.
// These helpers convert the settings controls into structured backend/profile configuration.
/**
 * @param {string} profileId - Saved or selected profile id.
 * @returns {object} Matching profile config object.
 */
function getProfile(profileId) {
  // Return the requested profile, or fall back to the strict/default one.
  return PROFILES[profileId] || PROFILES.strict;
}

/**
 * @param {string} backendId - Saved or selected backend id.
 * @returns {object} Matching backend config object.
 */
function getDetectBackend(backendId) {
  // Return the requested backend, or fall back to COCO if the value is unknown.
  return DETECT_BACKENDS[backendId] || DETECT_BACKENDS.coco;
}

/**
 * @param {object|null} profile - Active profile config.
 * @param {string} backendId - Active detector backend id.
 * @returns {string[]} Allowed labels for that profile/backend combination.
 */
function getProfileLabels(profile, backendId) {
  if (!profile) return [];
  // Each backend speaks different class names, so the active profile has backend-specific allow-lists.
  return backendId === 'aeroyolo' ? (profile.aeroyoloLabels || []) : (profile.cocoLabels || []);
}

// Settings are always read from the live controls first, then clamped to safe numeric ranges.
/**
 * @returns {DetectionSettings} Active detector settings.
 */
function getSettings() {
  // Read the backend selector from the page, falling back to the default backend id.
  const backend = getDetectBackend(detectBackendSelect ? detectBackendSelect.value : DEFAULT_DETECT_BACKEND_ID);
  // Read the profile selector from the page, falling back to strict mode.
  const profile = getProfile(detectProfileSelect ? detectProfileSelect.value : 'strict');
  // Clamp each numeric control so bad inputs cannot create impossible settings.
  const strongThreshold = clamp(strongThresholdInput && strongThresholdInput.value, 0.05, 0.99, 0.3);
  const possibleThreshold = clamp(possibleThresholdInput && possibleThresholdInput.value, 0.01, strongThreshold, 0.12);
  const smoothingAlpha = clamp(smoothingInput && smoothingInput.value, 0.05, 1, 0.35);
  const deadZone = clamp(deadZoneInput && deadZoneInput.value, 0, 0.5, 0.08);
  return { backend, profile, strongThreshold, possibleThreshold, smoothingAlpha, deadZone };
}

/**
 * Saves the current detector settings to localStorage.
 */
function saveSettings() {
  const settings = getSettings();
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
function loadSettings() {
  let saved = null;
  try {
    // Parse the persisted detector settings if they exist.
    saved = JSON.parse(localStorage.getItem(DETECTION_SETTINGS_STORAGE_KEY) || 'null');
  } catch (err) {
    console.warn('Failed to parse saved detection settings.', err);
  }
  // Recreate safe backend/profile objects from the saved ids.
  const backend = getDetectBackend((saved && saved.backendId) || DEFAULT_DETECT_BACKEND_ID);
  const profile = getProfile(saved && saved.profileId);
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
function hasTrackLock() {
  // A track lock exists only when we still have a target label and have not missed too many frames.
  return trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT && !!trackingState.label;
}

/**
 * @param {object|null} metrics - Candidate detection metrics in screen space.
 * @returns {boolean} True when the candidate is close to the locked target.
 */
function isNearLockedTarget(metrics) {
  if (!hasTrackLock() || !metrics || !overlayCanvas) return false;
  // Distance is normalized against the on-screen diagonal so the rule behaves similarly on different viewport sizes.
  const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
  const distance = Math.hypot(metrics.centerX - trackingState.filteredCenterX, metrics.centerY - trackingState.filteredCenterY);
  return distance / diag <= TRACK_LOCK_DISTANCE_RATIO;
}

// clearTargetTelemetry resets both the HUD readouts and the in-memory tracking state when a target is lost.
/**
 * Resets tracking state and all target-related UI readouts.
 */
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
function syncOverlaySize() {
  if (!(overlayCanvas && feedImg && feedImg.parentElement)) return;
  // Match the canvas to the displayed image container, not the raw image pixels, because drawing happens in screen space.
  overlayCanvas.width = Math.round(feedImg.parentElement.clientWidth || 0);
  overlayCanvas.height = Math.round(feedImg.parentElement.clientHeight || 0);
}

/**
 * Clears all overlay graphics from the canvas.
 */
function clearOverlay() {
  if (overlayCtx && overlayCanvas) {
    // Remove every old box/reticle pixel from the canvas.
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }
}

/**
 * @returns {{scale: number, offsetX: number, offsetY: number}|null} Display scaling info for the camera image.
 */
function getImageFit() {
  // If we do not yet know the actual image size, we cannot map detections to the screen.
  if (!(feedImg && feedImg.parentElement && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // Measure the displayed container size, not the raw image size.
  const width = feedImg.parentElement.clientWidth;
  const height = feedImg.parentElement.clientHeight;
  // object-fit: contain means the image scales uniformly until it fits inside the container.
  const scale = Math.min(width / feedImg.naturalWidth, height / feedImg.naturalHeight);
  const displayWidth = feedImg.naturalWidth * scale;
  const displayHeight = feedImg.naturalHeight * scale;
  return { scale, offsetX: (width - displayWidth) / 2, offsetY: (height - displayHeight) / 2 };
}

/**
 * @param {{bbox: number[]}} det - Detection object containing an image-space bbox.
 * @returns {object|null} Screen-space metrics for drawing and tracking.
 */
function computeMetrics(det) {
  syncOverlaySize();
  const fit = getImageFit();
  if (!fit) return null;
  // Unpack the model bbox, which is stored as [x, y, width, height].
  const [rawX, rawY, rawW, rawH] = det.bbox;
  // Convert raw image-space coordinates into displayed canvas-space coordinates.
  const x = rawX * fit.scale + fit.offsetX;
  const y = rawY * fit.scale + fit.offsetY;
  const w = rawW * fit.scale;
  const h = rawH * fit.scale;
  if (w <= 0 || h <= 0) return null;
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const screenCenterX = overlayCanvas.width / 2;
  const screenCenterY = overlayCanvas.height / 2;
  const deltaX = centerX - screenCenterX;
  // Positive deltaY means the target sits above center, which matches the later UP/DOWN assist labels.
  const deltaY = screenCenterY - centerY;
  // Normalized deltas collapse every viewport into a -1..1 range for simpler assist logic.
  const normX = screenCenterX ? Math.max(-1, Math.min(1, deltaX / screenCenterX)) : 0;
  const normY = screenCenterY ? Math.max(-1, Math.min(1, deltaY / screenCenterY)) : 0;
  return { x, y, w, h, centerX, centerY, deltaX, deltaY, normX, normY };
}

// Candidate ranking filters the raw model output into the single target the UI should track.
/**
 * @param {string} className - Candidate class label.
 * @param {object|null} metrics - Candidate metrics in screen space.
 * @param {object} settings - Active detector settings.
 * @returns {{possible: number, strong: number}} Thresholds for this candidate.
 */
function getDetectionThresholds(className, metrics, settings) {
  const base = {
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
function buildDetections(predictions, settings) {
  const labels = new Set(getProfileLabels(settings.profile, settings.backend.id));
  return predictions
    // Keep low-confidence clutter out of the overlay entirely.
    .filter((p) => (p.score || 0) >= DRAW_THRESHOLD)
    .map((p) => {
      const metrics = computeMetrics(p);
      const thresholds = getDetectionThresholds(p.class, metrics, settings);
      const score = p.score || 0;
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
function chooseCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, det) => {
    // Start ranking mostly by confidence score.
    let detRank = det.score || 0;
    let bestRank = best.score || 0;
    // When a target is already locked, penalize far-away boxes so the tracker stays stable.
    if (trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT) {
      const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
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
function smoothMetrics(raw, settings) {
  if (!trackingState.hasTarget || trackingState.missedFrames >= LOST_LIMIT) {
    return { centerX: raw.centerX, centerY: raw.centerY, deltaX: raw.deltaX, deltaY: raw.deltaY, normX: raw.normX, normY: raw.normY };
  }
  // Exponential smoothing makes the assist hints steadier without hiding larger target movement.
  const a = settings.smoothingAlpha;
  const centerX = trackingState.filteredCenterX + a * (raw.centerX - trackingState.filteredCenterX);
  const centerY = trackingState.filteredCenterY + a * (raw.centerY - trackingState.filteredCenterY);
  const dx = centerX - overlayCanvas.width / 2;
  const dy = overlayCanvas.height / 2 - centerY;
  const normX = overlayCanvas.width ? Math.max(-1, Math.min(1, dx / (overlayCanvas.width / 2))) : 0;
  const normY = overlayCanvas.height ? Math.max(-1, Math.min(1, dy / (overlayCanvas.height / 2))) : 0;
  return { centerX, centerY, deltaX: dx, deltaY: dy, normX, normY };
}

/**
 * @param {number} norm - Normalized offset along one axis.
 * @param {number} deadZone - Center tolerance where movement becomes HOLD.
 * @param {string} negLabel - Label used when movement should go negative on that axis.
 * @param {string} posLabel - Label used when movement should go positive on that axis.
 * @returns {{value: number, label: string}} Simulated movement output for one axis.
 */
function simAxis(norm, deadZone, negLabel, posLabel) {
  const mag = Math.abs(norm);
  if (mag < deadZone) return { value: 0, label: 'HOLD' };
  // Three coarse bands are enough for operator guidance and easier to read than raw float output.
  const step = mag >= 0.45 ? 1 : mag >= 0.22 ? 0.5 : 0.25;
  const suffix = mag >= 0.45 ? 'LARGE' : mag >= 0.22 ? 'MED' : 'SMALL';
  return { value: norm < 0 ? -step : step, label: `${norm < 0 ? negLabel : posLabel}_${suffix}` };
}

/**
 * @param {{normX: number, normY: number}} filtered - Smoothed normalized target offset.
 * @param {object} settings - Active detector settings.
 * @returns {{pan: number, tilt: number, panLabel: string, tiltLabel: string}} Simulated pan/tilt output.
 */
function simCommand(filtered, settings) {
  // Horizontal offset becomes a pan hint; vertical offset becomes a tilt hint.
  const pan = simAxis(filtered.normX, settings.deadZone, 'LEFT', 'RIGHT');
  const tilt = simAxis(filtered.normY, settings.deadZone, 'DOWN', 'UP');
  return { pan: pan.value, tilt: tilt.value, panLabel: pan.label, tiltLabel: tilt.label };
}

/**
 * @returns {string} Compact human-readable movement direction summary for the event console.
 */
function describeCameraMove() {
  // Parse the two axis hints that were already generated for the currently tracked target.
  const panAssist = parseSimLabel(trackingState.simPanLabel);
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel);
  const moves = [];
  if (panAssist.direction !== 'hold') moves.push(friendlyDirection(panAssist.direction));
  if (tiltAssist.direction !== 'hold') moves.push(friendlyDirection(tiltAssist.direction));
  return moves.length ? moves.join(' / ') : 'HOLD';
}

/**
 * @param {object} selected - Selected detection object.
 * @returns {string} One-line event console message describing the selected target.
 */
function buildTargetLogMessage(selected) {
  // Build one compact line for the event console with class, score, center, and suggested move.
  const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`;
  const x = trackingState.rawCenterX.toFixed(0);
  const y = trackingState.rawCenterY.toFixed(0);
  const move = describeCameraMove();
  return `Target detected: ${labelText} x=${x} y=${y} move=${move}`;
}

// Drawing helpers render both the full set of predictions and the currently selected target lock.
/**
 * Draws the fixed center reticle onto the overlay canvas.
 */
function drawReticle() {
  if (!(overlayCtx && overlayCanvas)) return;
  // The reticle is centered in the visible overlay so the operator can compare target offset to screen center.
  const cx = overlayCanvas.width / 2;
  const cy = overlayCanvas.height / 2;
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
function drawScene(detections, selected) {
  if (!(overlayCtx && overlayCanvas)) return;
  // Always resize/clear/redraw in that order so stale geometry never remains on screen.
  syncOverlaySize();
  clearOverlay();
  drawReticle();
  overlayCtx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  overlayCtx.textBaseline = 'top';
  detections.forEach((det) => {
    if (!det.metrics) return;
    const isSelected = det === selected;
    // Selected target = blue, strong candidate = red, possible candidate = amber, other detection = green.
    const stroke = isSelected ? '#38bdf8' : det.isStrong ? '#ff4d4d' : det.isCandidate ? '#f59e0b' : '#22c55e';
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = isSelected ? 3 : 2;
    overlayCtx.setLineDash(det.isCandidate && !det.isStrong && !isSelected ? [5, 3] : []);
    overlayCtx.strokeRect(det.metrics.x, det.metrics.y, det.metrics.w, det.metrics.h);
    // Non-candidate detections still get drawn so the operator can see what the model is seeing.
    const prefix = isSelected ? 'TRACK ' : det.isStrong ? 'TARGET ' : det.isCandidate ? 'POSSIBLE ' : '';
    const label = `${prefix}${det.class} ${((det.score || 0) * 100).toFixed(1)}%`;
    const width = overlayCtx.measureText(label).width + 8;
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(det.metrics.x, Math.max(0, det.metrics.y - 16), width, 16);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(label, det.metrics.x + 4, Math.max(0, det.metrics.y - 15));
    overlayCtx.restore();
  });
  if (trackingState.hasTarget) {
    // When a target is locked, also draw a line from the screen center to the filtered target center.
    const cx = overlayCanvas.width / 2;
    const cy = overlayCanvas.height / 2;
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
    const text = `SIM ${trackingState.simPanLabel} / ${trackingState.simTiltLabel}`;
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
function updateSelectedTarget(selected, settings, loopMs) {
  // Smooth the raw target center first so the UI is less jittery.
  const filtered = smoothMetrics(selected.metrics, settings);
  // Convert the filtered offset into manual movement hints.
  const sim = simCommand(filtered, settings);
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
function pushTelemetry(entry) {
  sessionTelemetry.push(entry);
  // Keep telemetry bounded in memory so a long session does not slowly grow the page footprint forever.
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

// The detection loop yields back to the browser between frames so UI and fetch handlers stay responsive.
/**
 * @returns {Promise<void>} Resolves after yielding one frame back to the browser event loop.
 */
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
function ensureDetectSourceSurface() {
  // Lazily create one reusable off-screen canvas instead of allocating a new one every frame.
  if (!detectSourceCanvas) detectSourceCanvas = document.createElement('canvas');
  if (!detectSourceCtx && detectSourceCanvas) detectSourceCtx = detectSourceCanvas.getContext('2d', { alpha: false });
  return detectSourceCanvas && detectSourceCtx ? { canvas: detectSourceCanvas, ctx: detectSourceCtx } : null;
}

/**
 * @returns {{source: HTMLImageElement|HTMLCanvasElement, scaleX: number, scaleY: number}|null} Inference source and scale info.
 */
function getDetectionSource() {
  if (!(feedImg && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // Calculate how much we can shrink the source while staying inside the configured max dimensions.
  const downscale = Math.min(
    1,
    DETECT_MAX_SOURCE_WIDTH / feedImg.naturalWidth,
    DETECT_MAX_SOURCE_HEIGHT / feedImg.naturalHeight
  );
  if (downscale >= 0.999) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const surface = ensureDetectSourceSurface();
  if (!surface) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const width = Math.max(1, Math.round(feedImg.naturalWidth * downscale));
  const height = Math.max(1, Math.round(feedImg.naturalHeight * downscale));
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
function rescalePredictionBBox(prediction, scaleX, scaleY) {
  if (!prediction || !Array.isArray(prediction.bbox) || prediction.bbox.length < 4) return prediction;
  // Expand the bbox back into the original image coordinate space after downscaled inference.
  const [x, y, w, h] = prediction.bbox;
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
function preprocessDroneDetectSource(modelWidth, modelHeight) {
  const surface = ensureDetectSourceSurface();
  if (!surface || !feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight) return null;
  const sourceWidth = feedImg.naturalWidth;
  const sourceHeight = feedImg.naturalHeight;
  // Letterboxing keeps the source aspect ratio while satisfying the fixed ONNX tensor size.
  const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const padX = Math.floor((modelWidth - drawWidth) / 2);
  const padY = Math.floor((modelHeight - drawHeight) / 2);
  // Resize the reusable canvas to exactly match the model input tensor size.
  if (surface.canvas.width !== modelWidth) surface.canvas.width = modelWidth;
  if (surface.canvas.height !== modelHeight) surface.canvas.height = modelHeight;
  surface.ctx.clearRect(0, 0, modelWidth, modelHeight);
  surface.ctx.fillStyle = '#727272';
  // Fill the letterbox padding with a neutral gray so empty areas are consistent frame to frame.
  surface.ctx.fillRect(0, 0, modelWidth, modelHeight);
  surface.ctx.drawImage(feedImg, padX, padY, drawWidth, drawHeight);
  const imageData = surface.ctx.getImageData(0, 0, modelWidth, modelHeight).data;
  const channelSize = modelWidth * modelHeight;
  // Allocate [R-plane][G-plane][B-plane] because ONNX expects CHW layout, not RGBA pixels.
  const input = new Float32Array(channelSize * 3);
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
function clampBboxToFeed(bbox) {
  if (!feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight || !Array.isArray(bbox) || bbox.length < 4) return bbox;
  // Clamp the decoded model box so drawing math never exceeds the image bounds.
  const [rawX, rawY, rawW, rawH] = bbox;
  const x = Math.max(0, Math.min(feedImg.naturalWidth, rawX));
  const y = Math.max(0, Math.min(feedImg.naturalHeight, rawY));
  const w = Math.max(0, Math.min(feedImg.naturalWidth - x, rawW));
  const h = Math.max(0, Math.min(feedImg.naturalHeight - y, rawH));
  return [x, y, w, h];
}

/**
 * @param {ArrayLike<number>} data - Flat ONNX output buffer.
 * @param {number} offset - Starting index of the current prediction row.
 * @param {{scale: number, padX: number, padY: number}} prepared - Letterbox metadata used to decode the row.
 * @returns {object|null} Decoded prediction in shared bbox format.
 */
function normalizeDroneModelPrediction(data, offset, prepared) {
  if (!prepared || !Number.isFinite(prepared.scale) || prepared.scale <= 0) return null;
  // Read one 6-value prediction row from the flat ONNX output buffer.
  const x1 = Number(data[offset]);
  const y1 = Number(data[offset + 1]);
  const x2 = Number(data[offset + 2]);
  const y2 = Number(data[offset + 3]);
  const scoreRaw = Number(data[offset + 4]);
  const classIdRaw = Number(data[offset + 5]);
  const score = Number.isFinite(scoreRaw) ? scoreRaw : 0;
  const classId = Number.isFinite(classIdRaw) ? Math.round(classIdRaw) : -1;
  // Unknown class ids are still preserved under a synthetic label so debugging output stays inspectable.
  const className = DRONE_MODEL_LABELS[classId] || `class_${classId}`;
  const width = Math.max(0, (x2 - x1) / prepared.scale);
  const height = Math.max(0, (y2 - y1) / prepared.scale);
  const bbox = clampBboxToFeed([
    (x1 - prepared.padX) / prepared.scale,
    (y1 - prepared.padY) / prepared.scale,
    width,
    height,
  ]);
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
async function ensureDetectBackend() {
  // Skip setup if it already happened or if TensorFlow is unavailable on this page.
  if (detectBackendReady || !window.tf) return;
  try {
    // Wait for TensorFlow.js runtime initialization to finish.
    await tf.ready();
    const currentBackend = typeof tf.getBackend === 'function' ? tf.getBackend() : '';
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
async function ensureDroneDetectSession() {
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
async function detectWithCoco() {
  const model = await ensureCocoDetectModel();
  if (!model) return [];
  const detectionSource = getDetectionSource();
  if (!detectionSource) return [];
  // Run COCO-SSD on either the original image or the downscaled off-screen canvas.
  const rawPredictions = await model.detect(detectionSource.source);
  return (detectionSource.scaleX === 1 && detectionSource.scaleY === 1)
    ? rawPredictions
    : rawPredictions.map((prediction) => rescalePredictionBBox(prediction, detectionSource.scaleX, detectionSource.scaleY));
}

/**
 * @returns {Promise<object[]>} Normalized predictions from the AeroYOLO backend.
 */
async function detectWithAeroYolo() {
  const session = await ensureDroneDetectSession();
  if (!session) return [];
  // Resolve the model input/output names from session metadata when possible.
  const inputName = session.inputNames && session.inputNames[0] ? session.inputNames[0] : 'images';
  const outputName = session.outputNames && session.outputNames[0] ? session.outputNames[0] : 'output0';
  const inputMeta = session.inputMetadata && session.inputMetadata[inputName] ? session.inputMetadata[inputName] : null;
  const dims = inputMeta && Array.isArray(inputMeta.dimensions) ? inputMeta.dimensions : [1, 3, 640, 640];
  const modelHeight = Number(dims[2]) || 640;
  const modelWidth = Number(dims[3]) || 640;
  const prepared = preprocessDroneDetectSource(modelWidth, modelHeight);
  if (!prepared) return [];
  // Build the input tensor in the exact shape expected by the model.
  const tensor = new ort.Tensor('float32', prepared.input, [1, 3, modelHeight, modelWidth]);
  // The session output is backend-specific, so the next block normalizes it into the shared prediction contract.
  const result = await session.run({ [inputName]: tensor });
  const outputTensor = result && result[outputName] ? result[outputName] : null;
  if (!outputTensor || !outputTensor.data || !Array.isArray(outputTensor.dims)) return [];
  // The current model returns one row per box, with 6 values per row: x1, y1, x2, y2, score, classId.
  const rows = outputTensor.dims[1] || 0;
  const stride = outputTensor.dims[2] || 6;
  const predictions = [];
  for (let i = 0; i < rows; i += 1) {
    const offset = i * stride;
    // Decode each output row into the shared { class, score, bbox } shape.
    const prediction = normalizeDroneModelPrediction(outputTensor.data, offset, prepared);
    if (prediction) predictions.push(prediction);
  }
  return predictions;
}

// runDetection is the core detection pass: predict, select, update the HUD, log, and export telemetry.
/**
 * @returns {Promise<void>} Resolves after one detection pass finishes.
 */
async function runDetection() {
  // Do not overlap detection passes or read from an empty/hidden stream.
  if (isDetecting || !feedImg || !feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  // Measure loop duration so the UI can show actual inference cadence.
  const startedAt = performance.now();
  try {
    const settings = getSettings();
    setProfileStatus(settings.profile.id);
    // Exactly one backend runs per frame. Everything after this point is intentionally backend-agnostic.
    const predictions = settings.backend.id === 'aeroyolo' ? await detectWithAeroYolo() : await detectWithCoco();
    const detections = buildDetections(predictions, settings);
    // Only candidate detections are allowed to compete for the single tracked target.
    const selected = chooseCandidate(detections.filter((det) => det.isCandidate && det.metrics));
    const loopMs = performance.now() - startedAt;
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
    const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`;
    const targetLogMessage = buildTargetLogMessage(selected);
    const deltaText = ` dx=${trackingState.filteredDeltaX.toFixed(0)} dy=${trackingState.filteredDeltaY.toFixed(0)}`;
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
    const text = err && err.message ? err.message : 'check camera address / stream';
    const corsBlocked = /tainted canvases|cross-origin|cross origin/i.test(text);
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
function scheduleNextDetection(delay) {
  if (!detectLoopActive) return;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    // Measure one loop so the next timeout can compensate for inference time.
    const startedAt = performance.now();
    await runDetection();
    // Keep a roughly fixed cadence: fast frames wait a little, slow frames continue almost immediately.
    scheduleNextDetection(Math.max(DETECT_MIN_IDLE_MS, DETECT_INTERVAL_MS - (performance.now() - startedAt)));
  }, Math.max(0, delay || 0));
}

/**
 * Starts the repeating detection loop if one is not already running. start detection
 */
function startDetectionLoop() {
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


/*
DETECT.JS FULL EXAM EXPLANATION COMMENT

This comment explains every important typedef, constant, global variable, state field, local variable idea, and function in detect.js. The purpose is that during the exam, if the teacher asks about a name like DRAW_THRESHOLD, runDetection, trackingState, smoothMetrics, detectWithAeroYolo, or any other function/variable, I can press Ctrl+F, search that exact name, read the explanation, and explain it clearly.

DetectBackendConfig:
DetectBackendConfig is a JSDoc typedef that describes one detection backend option. A backend is the detection engine/model that the system can use. It has id and label. id is the internal value used by the code, like "coco" or "aeroyolo". label is the readable name shown to the user, like "COCO-SSD" or "AeroYOLO ONNX".

DetectBackendConfig.id:
id is the internal short name of a detection backend. The code uses this value in comparisons, for example settings.backend.id === 'aeroyolo'. It is not mainly for display; it is for logic.

DetectBackendConfig.label:
label is the human-readable backend name. It is used so the UI or logs can show a clearer name instead of only the internal id.

DetectProfile:
DetectProfile is a JSDoc typedef that describes a detection profile. A profile decides which object labels are allowed to become tracked targets. The detector may see many objects, but the profile decides what counts as relevant.

DetectProfile.id:
id is the internal profile name, for example "strict" or "broad". The code saves and loads this id from settings.

DetectProfile.label:
label is the readable profile name, for example "Drone / rotorcraft focus" or "Full air sweep".

DetectProfile.cocoLabels:
cocoLabels is an array of labels that are accepted when the backend is COCO-SSD. COCO uses labels like airplane, aeroplane, bird, and kite.

DetectProfile.aeroyoloLabels:
aeroyoloLabels is an array of labels that are accepted when the backend is AeroYOLO. AeroYOLO uses labels like drone, aircraft, and helicopter.

DetectionMetrics:
DetectionMetrics is a JSDoc typedef that describes the geometry of one detection box after converting it from raw image coordinates into visible overlay coordinates. The model gives a box in image pixels, but the overlay is drawn on the displayed canvas, so the code must convert coordinates.

DetectionMetrics.x:
x is the left side of the detection box on the overlay canvas.

DetectionMetrics.y:
y is the top side of the detection box on the overlay canvas.

DetectionMetrics.w:
w is the width of the detection box on the overlay canvas.

DetectionMetrics.h:
h is the height of the detection box on the overlay canvas.

DetectionMetrics.centerX:
centerX is the horizontal center point of the detection box.

DetectionMetrics.centerY:
centerY is the vertical center point of the detection box.

DetectionMetrics.deltaX:
deltaX is how far the target center is from the screen center horizontally. Positive means the target is to the right of center. Negative means it is to the left.

DetectionMetrics.deltaY:
deltaY is how far the target center is from the screen center vertically. In this code, positive deltaY means the target is above the center, because the code calculates screenCenterY - centerY. This matches the later UP/DOWN assist labels.

DetectionMetrics.normX:
normX is the normalized horizontal offset from -1 to 1. It is easier for movement logic than raw pixels. -1 means far left, 0 means centered, 1 means far right.

DetectionMetrics.normY:
normY is the normalized vertical offset from -1 to 1. It is easier for movement logic than raw pixels. Positive means above center, negative means below center.

DetectionSettings:
DetectionSettings is a JSDoc typedef that describes all active detection settings after reading the UI controls. It contains backend, profile, strongThreshold, possibleThreshold, smoothingAlpha, and deadZone.

DetectionSettings.backend:
backend is the active detection backend object, for example the AeroYOLO backend or COCO backend.

DetectionSettings.profile:
profile is the active detection profile object, for example strict or broad.

DetectionSettings.strongThreshold:
strongThreshold is the confidence score needed for a detection to count as a strong real target. If a detection passes this threshold, the system can show danger/target status.

DetectionSettings.possibleThreshold:
possibleThreshold is the lower confidence score needed for a detection to count as a possible target. It is weaker than strongThreshold and creates a warning state instead of full target state.

DetectionSettings.smoothingAlpha:
smoothingAlpha controls how strongly the filtered target center follows the new raw detection center. Higher value means faster movement but more jitter. Lower value means smoother movement but slower response.

DetectionSettings.deadZone:
deadZone is the normalized center tolerance where the assist command becomes HOLD. If the target is close enough to the center, the system does not suggest moving.

TrackingState:
TrackingState is a JSDoc typedef that describes the shared target tracking state. trackingState stores the current target lock, filtered target position, movement hints, loop timing, and missed frame count.

TrackingState.hasTarget:
hasTarget is true when the system currently has a target lock. It is false when no target is selected.

TrackingState.isPossible:
isPossible is true when the current target is only a possible weak target and not a strong target. It is false when the selected target is strong.

TrackingState.label:
label stores the class name of the current target, for example "drone", "helicopter", or "aircraft".

TrackingState.score:
score stores the confidence score of the selected target from 0 to 1.

TrackingState.rawCenterX:
rawCenterX is the raw detected x center of the selected box before smoothing.

TrackingState.rawCenterY:
rawCenterY is the raw detected y center of the selected box before smoothing.

TrackingState.filteredCenterX:
filteredCenterX is the smoothed x center after applying smoothMetrics.

TrackingState.filteredCenterY:
filteredCenterY is the smoothed y center after applying smoothMetrics.

TrackingState.filteredDeltaX:
filteredDeltaX is the smoothed horizontal distance from screen center.

TrackingState.filteredDeltaY:
filteredDeltaY is the smoothed vertical distance from screen center.

TrackingState.filteredNormX:
filteredNormX is the smoothed normalized horizontal offset from -1 to 1.

TrackingState.filteredNormY:
filteredNormY is the smoothed normalized vertical offset from -1 to 1.

TrackingState.simPan: x axix
simPan is the simulated horizontal movement value. It can be 0 for HOLD, positive for right, negative for left, with values like 0.25, 0.5, or 1.

TrackingState.simTilt:
simTilt is the simulated vertical movement value. It can be 0 for HOLD, positive for up, negative for down, with values like 0.25, 0.5, or 1.

TrackingState.simPanLabel:
simPanLabel is the readable horizontal movement label, like HOLD, LEFT_SMALL, LEFT_MED, LEFT_LARGE, RIGHT_SMALL, RIGHT_MED, or RIGHT_LARGE.

TrackingState.simTiltLabel:
simTiltLabel is the readable vertical movement label, like HOLD, UP_SMALL, UP_MED, UP_LARGE, DOWN_SMALL, DOWN_MED, or DOWN_LARGE.

TrackingState.loopMs:
loopMs stores how many milliseconds the last detection pass took.

TrackingState.missedFrames:
missedFrames counts how many detection frames happened without finding a valid selected target. After too many misses, the target is cleared.

DETECTION_SETTINGS_STORAGE_KEY:
DETECTION_SETTINGS_STORAGE_KEY is the localStorage key used to save detection settings in the browser. Its value is "skyshield_detection_settings_v2". localStorage keeps the settings even after refreshing the page, so the backend, profile, thresholds, smoothing, and dead zone can be restored.

DRONE_MODEL_URL:
DRONE_MODEL_URL is the path to the AeroYOLO ONNX model file. Its value is "../models/aeroyolo.onnx". The function ensureDroneDetectSession uses this URL to load the project-specific drone detection model.

DEFAULT_DETECT_BACKEND_ID:
DEFAULT_DETECT_BACKEND_ID is the default backend id used when no saved setting exists. Its value is "aeroyolo", meaning the system prefers the AeroYOLO ONNX model by default.

DETECT_INTERVAL_MS:
DETECT_INTERVAL_MS is the target delay between detection passes, in milliseconds. Its value is 180, meaning the system tries to run detection roughly every 180ms. The loop also subtracts the actual detection time so the cadence stays more stable.

DETECT_MIN_IDLE_MS:
DETECT_MIN_IDLE_MS is the minimum delay between detection passes. Its value is 24ms. It prevents the detection loop from running nonstop with no time for the browser to paint the UI and handle other work.

DETECT_MAX_SOURCE_WIDTH:
DETECT_MAX_SOURCE_WIDTH is the maximum width used when downscaling the input frame for faster detection. Its value is 384. If the camera image is larger, getDetectionSource can resize it smaller before COCO-SSD detection.

DETECT_MAX_SOURCE_HEIGHT:
DETECT_MAX_SOURCE_HEIGHT is the maximum height used when downscaling the input frame for faster detection. Its value is 384. This helps detection run faster on normal laptops.

DRAW_THRESHOLD:
DRAW_THRESHOLD is the minimum confidence score needed for a prediction to be drawn at all. Its value is 0.05, meaning 5%. If a model prediction has score lower than 0.05, buildDetections filters it out and it will not be drawn on the overlay. This prevents very weak noise detections from cluttering the screen.

LOST_LIMIT:
LOST_LIMIT is the number of missed frames allowed before the target is considered lost. Its value is 8. If the system misses a valid target for 8 consecutive frames, clearTargetTelemetry is called and the old target data is cleared.

MAX_TELEMETRY:
MAX_TELEMETRY is the maximum number of telemetry entries stored in sessionTelemetry. Its value is 1200. pushTelemetry removes old entries when the array becomes longer than this, so memory usage does not grow forever.

TRACK_LOCK_THRESHOLD_FACTOR:
TRACK_LOCK_THRESHOLD_FACTOR is used when the tracker already has a target and a new detection is close to the previous one. Its value is 0.6, meaning the possible and strong thresholds can be relaxed to 60% of their normal value. This helps keep tracking stable when the model confidence briefly drops.

TRACK_LOCK_DISTANCE_RATIO:
TRACK_LOCK_DISTANCE_RATIO controls how close a new detection must be to the old target to count as the same locked target. Its value is 0.22. The code compares distance divided by screen diagonal, so it works on different screen sizes.

TRACK_LOCK_MIN_SCORE:
TRACK_LOCK_MIN_SCORE is the lowest score allowed when track-lock relaxes thresholds. Its value is 0.08. Even with relaxed thresholds, the code will not accept extremely tiny confidence values below this minimum.

DETECT_BACKENDS:
DETECT_BACKENDS is an object containing all available detection backends. It has a coco backend and an aeroyolo backend. The code uses it to convert a backend id into a full backend config.

DETECT_BACKENDS.coco:
DETECT_BACKENDS.coco describes the COCO-SSD backend. It has id "coco" and label "COCO-SSD". COCO-SSD is a general object detection model.

DETECT_BACKENDS.aeroyolo:
DETECT_BACKENDS.aeroyolo describes the AeroYOLO ONNX backend. It has id "aeroyolo" and label "AeroYOLO ONNX". This is the project-specific air target model.

DRONE_MODEL_LABELS:
DRONE_MODEL_LABELS converts numeric class IDs from AeroYOLO into readable labels. AeroYOLO outputs numbers, so the code maps them to text.

DRONE_MODEL_LABELS[0]:
DRONE_MODEL_LABELS[0] is "aircraft". If the model outputs class id 0, the code treats it as aircraft.

DRONE_MODEL_LABELS[1]:
DRONE_MODEL_LABELS[1] is "drone". If the model outputs class id 1, the code treats it as drone.

DRONE_MODEL_LABELS[2]:
DRONE_MODEL_LABELS[2] is "helicopter". If the model outputs class id 2, the code treats it as helicopter.

PROFILES:
PROFILES stores the target filtering profiles. A profile decides which detected labels are allowed to become selected targets. The overlay may still draw other detections, but only labels in the profile can become tracked targets.

PROFILES.strict:
PROFILES.strict is the strict profile. It focuses only on drone/rotorcraft style targets. For COCO it accepts airplane/aeroplane. For AeroYOLO it accepts drone/helicopter.

PROFILES.broad:
PROFILES.broad is the broader profile. It accepts more flying object labels. For COCO it accepts airplane, aeroplane, bird, and kite. For AeroYOLO it accepts drone, aircraft, and helicopter.

detectTimer:
detectTimer stores the setTimeout id for the next scheduled detection pass. stopDetectionLoop and scheduleNextDetection use it to cancel or replace the current timer.

detectLoopActive:
detectLoopActive is a boolean that says whether the repeating detection loop is active. startDetectionLoop sets it to true. stopDetectionLoop sets it to false. scheduleNextDetection checks it before scheduling the next frame.

detectModel:
detectModel stores the loaded COCO-SSD model object. It starts as null and is filled by ensureCocoDetectModel after cocoSsd.load() finishes.

detectModelReady:
detectModelReady is true after the COCO-SSD model has loaded successfully. It prevents loading the same model again every frame.

droneDetectSession:
droneDetectSession stores the loaded ONNX Runtime inference session for AeroYOLO. It starts as null and is filled by ensureDroneDetectSession.

droneDetectSessionReady:
droneDetectSessionReady is true after the AeroYOLO ONNX session is created successfully. It prevents creating the same ONNX session again every frame.

isDetecting:
isDetecting prevents detection passes from overlapping. runDetection returns immediately if isDetecting is already true. This matters because model inference is async and could otherwise start another pass before the previous pass finished.

frameCounter:
frameCounter counts how many telemetry frames have been recorded. It is incremented before telemetry rows are pushed.

lastDetectState:
lastDetectState stores the previous detection status, like clear, possible, target, or error. The code uses it to avoid repeating some console messages every frame.

lastDetectLabel:
lastDetectLabel stores the last label or error text used in logs. It helps avoid repeated warning/error logs when nothing changed.

detectBackendReady:
detectBackendReady says whether TensorFlow backend setup already ran. ensureDetectBackend uses it to avoid repeating tf.ready and backend switching.

detectSourceCanvas:
detectSourceCanvas is a reusable off-screen canvas used for resizing or preprocessing camera frames. Reusing one canvas is better than creating a new canvas every frame.

detectSourceCtx:
detectSourceCtx is the 2D drawing context of detectSourceCanvas. It is used to draw the camera image into the off-screen canvas.

sessionTelemetry:
sessionTelemetry is an array of telemetry objects. It stores frame-by-frame records such as clear, possible, target, or error, plus timing, label, score, center, delta, and simulated movement.

trackingState:
trackingState is the main shared object that stores the current target and movement hint information. It is updated by updateSelectedTarget and cleared by clearTargetTelemetry. control.js can read this object to show assist cards and export telemetry.

window.SkyShieldTracking:
window.SkyShieldTracking exposes trackingState globally on the browser window. This means other scripts or the browser console can access the current tracking state.

getProfile(profileId):
getProfile receives a profile id string and returns the matching profile object from PROFILES. If the id does not exist, it returns PROFILES.strict as a safe fallback. This prevents broken saved settings from crashing the detector.

profileId:
profileId is the input to getProfile. It is usually a saved or selected profile id like "strict" or "broad".

getDetectBackend(backendId):
getDetectBackend receives a backend id string and returns the matching backend object from DETECT_BACKENDS. If the id is unknown, it returns DETECT_BACKENDS.coco as a fallback.

backendId:
backendId is the input to getDetectBackend or getProfileLabels. It is usually "coco" or "aeroyolo". It decides which backend-specific settings or labels to use.

getProfileLabels(profile, backendId):
getProfileLabels returns the allowed labels for the chosen profile and backend. If backendId is "aeroyolo", it returns profile.aeroyoloLabels. Otherwise it returns profile.cocoLabels. This is needed because different models use different label names.

profile:
profile is the active DetectProfile object. It contains id, label, cocoLabels, and aeroyoloLabels. In getProfileLabels, if profile is missing, the function returns an empty array.

getSettings():
getSettings reads the live page controls and returns a clean settings object. It reads the backend selector, profile selector, strong threshold input, possible threshold input, smoothing input, and dead zone input. It uses clamp so bad input values stay inside safe ranges.

backend:
backend is a local variable in getSettings. It stores the active backend object returned from getDetectBackend. If the UI selector is missing, the code uses DEFAULT_DETECT_BACKEND_ID.

profile:
profile is a local variable in getSettings. It stores the active profile object returned from getProfile. If the UI selector is missing, the code uses "strict".

strongThreshold:
strongThreshold is a local variable in getSettings and also part of DetectionSettings. It is clamped between 0.05 and 0.99 with default 0.3. It controls the minimum score for strong target status.

possibleThreshold:
possibleThreshold is a local variable in getSettings and also part of DetectionSettings. It is clamped between 0.01 and strongThreshold with default 0.12. It controls the minimum score for possible target status.

smoothingAlpha:
smoothingAlpha is a local variable in getSettings and also part of DetectionSettings. It is clamped between 0.05 and 1 with default 0.35. It controls how smooth or responsive tracking movement is.

deadZone:
deadZone is a local variable in getSettings and also part of DetectionSettings. It is clamped between 0 and 0.5 with default 0.08. It controls how close to center the target must be before movement says HOLD.

saveSettings():
saveSettings reads current detection settings using getSettings and saves them into localStorage using DETECTION_SETTINGS_STORAGE_KEY. It saves backendId, profileId, strongThreshold, possibleThreshold, smoothingAlpha, and deadZone. Then it calls setProfileStatus so the UI reflects the active profile.

settings:
settings is a common local variable used in many functions. It normally stores the return value of getSettings, meaning backend, profile, strongThreshold, possibleThreshold, smoothingAlpha, and deadZone.

loadSettings():
loadSettings reads saved detector settings from localStorage and applies them back to the page controls. It safely parses JSON inside try/catch. If parsing fails or values are missing, it falls back to safe defaults.

saved:
saved is a local variable in loadSettings. It starts as null and becomes the parsed localStorage object if valid saved settings exist.

err:
err is a common catch variable. It stores the error object caught by catch blocks. The code uses it for console warnings or error messages.

hasTrackLock():
hasTrackLock returns true when the tracker still considers the previous target locked. It requires trackingState.hasTarget to be true, trackingState.missedFrames to be less than LOST_LIMIT, and trackingState.label to exist. This helps the code relax thresholds only while a target is still considered active.

isNearLockedTarget(metrics):
isNearLockedTarget checks whether a new detection is close enough to the old locked target. It uses the distance between metrics.centerX/centerY and trackingState.filteredCenterX/filteredCenterY. It divides by the overlay diagonal so the logic works on different screen sizes. It returns true only if the normalized distance is less than or equal to TRACK_LOCK_DISTANCE_RATIO.

metrics:
metrics is a common variable that stores screen-space detection geometry from computeMetrics. It contains x, y, w, h, centerX, centerY, deltaX, deltaY, normX, and normY.

diag:
diag is a local variable used in distance calculations. It stores the diagonal size of the overlay canvas using Math.hypot(width, height). Math.max(1, ...) prevents division by zero.

distance:
distance is a local variable in isNearLockedTarget. It stores the pixel distance between the new candidate center and the previous filtered center.

clearTargetTelemetry():
clearTargetTelemetry clears all target-related UI readouts and resets trackingState to neutral values. It sets label and score to empty/zero, centers and deltas to zero, sim labels to HOLD, missedFrames to 0, and then calls updateOperatorAssistReadout. It is used when the target is lost, when detection stops, or when an error happens.

syncOverlaySize():
syncOverlaySize sets overlayCanvas.width and overlayCanvas.height to match the displayed camera container size. This is important because drawing happens on the visible overlay canvas, not directly on the raw camera image pixels.

clearOverlay():
clearOverlay clears all old drawings from overlayCanvas by calling overlayCtx.clearRect over the whole canvas. It removes previous boxes, reticle lines, and target lines.

getImageFit():
getImageFit calculates how the raw camera image is displayed inside its container. Because the image uses object-fit: contain, the displayed image may have padding/offset. The function returns scale, offsetX, and offsetY so raw detection boxes can be converted correctly into overlay coordinates.

width:
width is a local variable in getImageFit and other functions. In getImageFit, it means the displayed parent container width.

height:
height is a local variable in getImageFit and other functions. In getImageFit, it means the displayed parent container height.

scale:
scale is used in getImageFit and preprocessDroneDetectSource. In getImageFit, scale converts raw image pixels to displayed overlay pixels. In preprocessDroneDetectSource, scale converts source image pixels to ONNX model input pixels while keeping aspect ratio.

displayWidth:
displayWidth is a local variable in getImageFit. It is the width of the camera image after scaling to fit the container.

displayHeight:
displayHeight is a local variable in getImageFit. It is the height of the camera image after scaling to fit the container.

offsetX:
offsetX is the horizontal empty space/padding between the container edge and the displayed image. It is needed because object-fit: contain may center the image with side padding.

offsetY:
offsetY is the vertical empty space/padding between the container edge and the displayed image. It is needed because object-fit: contain may center the image with top/bottom padding.

computeMetrics(det):
computeMetrics converts one detection box from raw image coordinates into visible overlay coordinates. It calls syncOverlaySize and getImageFit, unpacks det.bbox as [rawX, rawY, rawW, rawH], calculates x, y, w, h, centerX, centerY, deltaX, deltaY, normX, and normY, then returns those values. If the image is not ready or the box has invalid size, it returns null.

det:
det is a detection object. It usually contains class, score, and bbox. In computeMetrics, det.bbox is used to calculate screen-space geometry.

rawX:
rawX is the raw left x position of the model’s bounding box in image coordinates.

rawY:
rawY is the raw top y position of the model’s bounding box in image coordinates.

rawW:
rawW is the raw width of the model’s bounding box in image coordinates.

rawH:
rawH is the raw height of the model’s bounding box in image coordinates.

x:
x is the converted overlay x position of the detection box.

y:
y is the converted overlay y position of the detection box.

w:
w is the converted overlay width of the detection box.

h:
h is the converted overlay height of the detection box.

centerX:
centerX is the horizontal center of the detection box.

centerY:
centerY is the vertical center of the detection box.

screenCenterX:
screenCenterX is the horizontal center of the overlay canvas.

screenCenterY:
screenCenterY is the vertical center of the overlay canvas.

deltaX:
deltaX is the target’s horizontal offset from the screen center. Positive is right, negative is left.

deltaY:
deltaY is the target’s vertical offset from the screen center. In this code, positive means above center.

normX:
normX is deltaX normalized to the range -1 to 1.

normY:
normY is deltaY normalized to the range -1 to 1.

getDetectionThresholds(className, metrics, settings):
getDetectionThresholds returns the possible and strong thresholds for one candidate. Normally it returns settings.possibleThreshold and settings.strongThreshold. If there is already a track lock, the candidate has the same class as the locked target, and the candidate is near the locked target, the function relaxes thresholds using TRACK_LOCK_THRESHOLD_FACTOR while respecting TRACK_LOCK_MIN_SCORE.

className:
className is the candidate class label, like "drone", "aircraft", or "helicopter". getDetectionThresholds compares it to trackingState.label to know if it is the same target type.

base:
base is a local object in getDetectionThresholds. It stores the normal possible and strong thresholds before any track-lock relaxation.

buildDetections(predictions, settings):
buildDetections receives raw model predictions and turns them into decorated detection objects. It first creates a Set of allowed labels from the active profile. Then it filters out predictions below DRAW_THRESHOLD. For each remaining prediction, it calculates metrics, calculates thresholds, reads score, and adds isCandidate and isStrong. isCandidate means the detection is allowed to become a tracked target. isStrong means it is confident enough to be a real target/danger.

predictions:
predictions is an array of raw model outputs. Each prediction usually has class, score, and bbox.

labels:
labels is a Set of allowed class names for the current profile and backend. It makes label checking fast and clean with labels.has(p.class).

p:
p is one raw prediction inside buildDetections. It has p.class, p.score, and p.bbox.

thresholds:
thresholds is a local variable holding the possible and strong thresholds returned by getDetectionThresholds.

score:
score is the confidence score of a prediction. The code uses p.score || 0 so missing score becomes 0.

isCandidate:
isCandidate is added to a detection object. It is true when the prediction’s class is allowed by the profile and its score is at least the possible threshold.

isStrong:
isStrong is added to a detection object. It is true when the prediction’s class is allowed by the profile and its score is at least the strong threshold.

chooseCandidate(candidates):
chooseCandidate chooses the single best detection to track from all candidates. If there are no candidates, it returns null. Otherwise it uses reduce to compare candidates. It starts ranking by score, but if a target is already locked, it subtracts a distance penalty from detections that are farther away from the previous filtered center. This makes the tracker more stable and prevents jumping between boxes too easily.

candidates:
candidates is an array of detections that are already eligible to be tracked. Usually runDetection passes detections.filter(det => det.isCandidate && det.metrics).

best:
best is the current best detection while reduce compares candidates.

detRank:
detRank is the score used to rank the current detection. It starts as det.score and may be reduced by a distance penalty.

bestRank:
bestRank is the score used to rank the current best detection. It starts as best.score and may be reduced by a distance penalty.

smoothMetrics(raw, settings):
smoothMetrics smooths the selected target movement so the overlay and assist hints do not jump too much. If there is no previous target or too many frames were missed, it returns the raw values directly. Otherwise it uses exponential smoothing: new filtered center = old filtered center + alpha * difference between raw and old. Then it recalculates delta and normalized values from the filtered center.

raw:
raw is the unsmoothed DetectionMetrics object for the selected target.

a:
a is a local variable in smoothMetrics. It stores settings.smoothingAlpha. It controls how strongly the new raw value affects the filtered value.

dx:
dx is the filtered horizontal distance from the screen center.

dy:
dy is the filtered vertical distance from the screen center.

simAxis(norm, deadZone, negLabel, posLabel):
simAxis converts one normalized offset into a simulated movement value and label. If the absolute offset is inside deadZone, it returns value 0 and label HOLD. Otherwise it returns a step of 0.25, 0.5, or 1 depending on the magnitude. It uses negLabel when norm is negative and posLabel when norm is positive.

norm:
norm is the normalized offset for one axis. It is usually filtered.normX or filtered.normY.

mag:
mag is Math.abs(norm). It is the size of the offset without direction.

negLabel:
negLabel is the label used when norm is negative. For horizontal movement it is LEFT. For vertical movement it is DOWN.

posLabel:
posLabel is the label used when norm is positive. For horizontal movement it is RIGHT. For vertical movement it is UP.

step:
step is the movement strength. It becomes 1 for large offset, 0.5 for medium offset, and 0.25 for small offset.

suffix:
suffix is the readable size label. It becomes LARGE, MED, or SMALL.

simCommand(filtered, settings):
simCommand converts filtered target offset into pan and tilt assist commands. It calls simAxis for filtered.normX using LEFT/RIGHT labels, and simAxis for filtered.normY using DOWN/UP labels. It returns pan, tilt, panLabel, and tiltLabel.

filtered:
filtered is the smoothed metrics object returned by smoothMetrics. It includes centerX, centerY, deltaX, deltaY, normX, and normY.

pan:
pan is the horizontal movement result returned from simAxis. It contains value and label.

tilt:
tilt is the vertical movement result returned from simAxis. It contains value and label.

panLabel:
panLabel is the readable horizontal assist label.

tiltLabel:
tiltLabel is the readable vertical assist label.

describeCameraMove():
describeCameraMove creates a compact readable movement string for the event console. It parses trackingState.simPanLabel and trackingState.simTiltLabel, converts directions to friendly text, and joins them with " / ". If both are hold, it returns HOLD.

panAssist:
panAssist is the parsed result of trackingState.simPanLabel. It comes from parseSimLabel.

tiltAssist:
tiltAssist is the parsed result of trackingState.simTiltLabel. It comes from parseSimLabel.

moves:
moves is an array of readable movement directions. If pan or tilt is not hold, the direction is added to this array.

buildTargetLogMessage(selected):
buildTargetLogMessage creates one log line for a selected target. It includes the selected class, confidence percent, raw x/y center, and suggested move. The output looks like Target detected: drone 87.3% x=320 y=180 move=RIGHT / UP.

selected:
selected is the detection chosen as the tracked target. It contains class, score, metrics, isCandidate, and isStrong.

labelText:
labelText is a local string with the selected class and score percentage.

move:
move is the readable movement summary returned by describeCameraMove.

drawReticle():
drawReticle draws the fixed center reticle on the overlay canvas. It draws a crosshair and dashed circle at the screen center. The purpose is to show the operator where the center is so they can compare it to the target position.

cx:
cx is the x coordinate of the overlay center.

cy:
cy is the y coordinate of the overlay center.

drawScene(detections, selected):
drawScene draws the entire detection overlay. It resizes the overlay, clears old graphics, draws the reticle, loops over detections, draws boxes and labels, and if a target exists it also draws a line from center to filtered target center plus raw/filtered dots and SIM text.

detections:
detections is the array of decorated detection objects from buildDetections. These are the detections that passed DRAW_THRESHOLD.

isSelected:
isSelected is true when the current detection being drawn is the same object as selected.

stroke:
stroke is the color used for the detection box. Selected target uses blue, strong candidate uses red, possible candidate uses amber, and other detection uses green.

prefix:
prefix is the text before the label. It can be TRACK, TARGET, POSSIBLE, or empty.

label:
label is the text drawn above the box. It includes prefix, class name, and confidence percentage.

updateSelectedTarget(selected, settings, loopMs):
updateSelectedTarget updates all tracking data and visible HUD readouts for the selected target. It calls smoothMetrics, calls simCommand, updates every trackingState field, sets missedFrames to 0, writes label/score/center/delta/norm/sim/loopMs to the UI using setReadout, and calls updateOperatorAssistReadout.

loopMs:
loopMs is the number of milliseconds the current detection pass took. It is displayed in the UI and saved to telemetry.

pushTelemetry(entry):
pushTelemetry adds one telemetry entry to sessionTelemetry. If sessionTelemetry grows longer than MAX_TELEMETRY, it removes the oldest entries using shift. This keeps memory bounded during long sessions.

entry:
entry is one telemetry object. It may describe a clear frame, target frame, possible frame, or error frame.

yieldToBrowser():
yieldToBrowser gives control back to the browser between detection frames. If TensorFlow is available and tf.nextFrame exists, it uses that. If not, it falls back to requestAnimationFrame. This helps the browser update the overlay and UI instead of freezing.

ensureDetectSourceSurface():
ensureDetectSourceSurface creates and returns a reusable off-screen canvas and its 2D context. It only creates them once. This is used for downscaling COCO input and preparing ONNX input.

getDetectionSource():
getDetectionSource prepares the input source for COCO detection. If the camera image is already small enough, it returns feedImg directly with scaleX 1 and scaleY 1. If the image is large, it draws the image into a smaller off-screen canvas using DETECT_MAX_SOURCE_WIDTH and DETECT_MAX_SOURCE_HEIGHT, then returns that canvas plus scale factors so bounding boxes can later be scaled back.

downscale:
downscale is the resize ratio used in getDetectionSource. It is the smallest of 1, max width divided by natural width, and max height divided by natural height.

surface:
surface is the off-screen canvas and context returned by ensureDetectSourceSurface.

scaleX:
scaleX is the horizontal factor needed to convert a detection box from the downscaled canvas back to original image coordinates.

scaleY:
scaleY is the vertical factor needed to convert a detection box from the downscaled canvas back to original image coordinates.

rescalePredictionBBox(prediction, scaleX, scaleY):
rescalePredictionBBox takes a prediction made on a downscaled image and expands its bbox back to original image coordinates. It multiplies x and width by scaleX, and y and height by scaleY. If prediction or bbox is invalid, it returns the prediction unchanged.

prediction:
prediction is one model detection object. It usually contains class, score, and bbox.

preprocessDroneDetectSource(modelWidth, modelHeight):
preprocessDroneDetectSource prepares the camera frame for the AeroYOLO ONNX model. It creates a letterboxed image with the exact model size, keeps the original aspect ratio, fills empty padding with gray, reads pixel data, converts RGBA pixels into RGB float32 CHW format, and returns input, scale, padX, and padY.

modelWidth:
modelWidth is the width expected by the ONNX model input, usually 640.

modelHeight:
modelHeight is the height expected by the ONNX model input, usually 640.

sourceWidth:
sourceWidth is the natural width of the camera image.

sourceHeight:
sourceHeight is the natural height of the camera image.

drawWidth:
drawWidth is the width of the camera image after scaling into the ONNX model canvas.

drawHeight:
drawHeight is the height of the camera image after scaling into the ONNX model canvas.

padX:
padX is the horizontal padding added by letterboxing.

padY:
padY is the vertical padding added by letterboxing.

imageData:
imageData is the raw RGBA pixel data read from the prepared canvas.

channelSize:
channelSize is modelWidth * modelHeight. It is the number of pixels in one color channel.

input:
input is the Float32Array sent into the ONNX model. It stores RGB values in CHW order: all red pixels first, then all green pixels, then all blue pixels. Values are divided by 255 so they are in the 0 to 1 range.

pixel:
pixel is the pixel index used while converting RGBA imageData into CHW Float32Array input.

i:
i is the imageData array index. It jumps by 4 each loop because imageData stores R, G, B, A for each pixel.

clampBboxToFeed(bbox):
clampBboxToFeed makes sure a decoded bounding box stays inside the camera image dimensions. It prevents drawing math from using negative positions or widths/heights outside the image. If input is invalid, it returns bbox unchanged.

bbox:
bbox is a bounding box array in the format [x, y, width, height].

normalizeDroneModelPrediction(data, offset, prepared):
normalizeDroneModelPrediction reads one prediction row from the flat ONNX output buffer and converts it into the shared prediction format used by the rest of the code. The ONNX row has x1, y1, x2, y2, score, and classId. The function maps classId to class name, removes letterbox padding, rescales coordinates back to original feed space, clamps the bbox, and returns class, score, classId, and bbox.

data:
data is the flat ONNX output buffer. It contains many prediction rows one after another.

offset:
offset is the starting index of the current prediction row inside the flat data buffer.

prepared:
prepared is the object returned by preprocessDroneDetectSource. It contains scale, padX, padY, and input. normalizeDroneModelPrediction uses scale/padding to decode boxes correctly.

x1:
x1 is the left coordinate of the ONNX box in model input coordinates.

y1:
y1 is the top coordinate of the ONNX box in model input coordinates.

x2:
x2 is the right coordinate of the ONNX box in model input coordinates.

y2:
y2 is the bottom coordinate of the ONNX box in model input coordinates.

scoreRaw:
scoreRaw is the raw confidence score from the ONNX output.

classIdRaw:
classIdRaw is the raw class id from the ONNX output.

classId:
classId is the rounded numeric class id. It is used to look up DRONE_MODEL_LABELS.

className:
className is the readable class label. It comes from DRONE_MODEL_LABELS, or becomes class_<id> if the id is unknown.

ensureDetectBackend():
ensureDetectBackend prepares TensorFlow.js for COCO detection. It waits for tf.ready, checks the current backend, tries to switch to webgl if available, marks detectBackendReady true, and logs the backend. If setup fails, it still marks detectBackendReady true and warns in the console.

currentBackend:
currentBackend is the current TensorFlow backend name, such as cpu or webgl.

ensureCocoDetectModel():
ensureCocoDetectModel loads the COCO-SSD model if it is not already loaded. If detectModelReady and detectModel are already set, it returns the existing model. If cocoSsd is missing, it updates status and returns null. Otherwise it loads the model, saves it in detectModel, marks detectModelReady true, updates status, and returns the model.

model:
model is a local variable in detectWithCoco. It stores the loaded COCO model returned from ensureCocoDetectModel.

ensureDroneDetectSession():
ensureDroneDetectSession loads the AeroYOLO ONNX Runtime session if it is not already loaded. If the session already exists and is ready, it returns it. If ONNX Runtime Web is missing, it updates status and returns null. It sets WASM threads to 1, tries to create a session using webgpu and wasm, and if that fails, retries with wasm only. On success it stores the session and returns it.

primaryErr:
primaryErr is the error caught when the first ONNX session creation attempt with WebGPU fails. The code logs it, then retries using only WASM.

detectWithCoco():
detectWithCoco runs detection using COCO-SSD. It ensures the COCO model is loaded, gets the detection source, runs model.detect on the source image/canvas, and rescales bounding boxes if the source was downscaled. It returns normalized predictions.

detectionSource:
detectionSource is the object returned by getDetectionSource. It contains source, scaleX, and scaleY.

rawPredictions:
rawPredictions is the array returned by model.detect. It contains COCO detections before optional bbox rescaling.

detectWithAeroYolo():
detectWithAeroYolo runs detection using the AeroYOLO ONNX model. It ensures the ONNX session exists, finds input/output names, reads model dimensions, preprocesses the camera frame, creates an ONNX tensor, runs the session, reads output rows, normalizes each row with normalizeDroneModelPrediction, and returns predictions.

session:
session is the ONNX Runtime inference session returned by ensureDroneDetectSession.

inputName:
inputName is the ONNX model input name. The code reads session.inputNames[0], or falls back to "images".

outputName:
outputName is the ONNX model output name. The code reads session.outputNames[0], or falls back to "output0".

inputMeta:
inputMeta stores metadata for the ONNX input, if available.

dims:
dims is the ONNX input dimension array. If metadata is missing, it defaults to [1, 3, 640, 640].

prepared:
prepared is the preprocessed ONNX input object returned by preprocessDroneDetectSource.

tensor:
tensor is the ONNX Runtime Tensor object created from prepared.input. It has type float32 and shape [1, 3, modelHeight, modelWidth].

result:
result is the object returned by session.run. It contains output tensors by output name.

outputTensor:
outputTensor is the model output tensor selected from result[outputName].

rows:
rows is the number of prediction rows in the output tensor.

stride:
stride is the number of values per prediction row. In this model it is usually 6: x1, y1, x2, y2, score, classId.

predictions:
predictions is the final array of normalized prediction objects returned from detectWithAeroYolo.

runDetection():
runDetection is the main detection pass. It is the most important function in detect.js. It prevents overlapping runs, checks that the camera image exists and is loaded, marks isDetecting true, measures start time, gets settings, chooses the backend, runs model prediction, builds detections, chooses the best candidate, updates the target state or clears target state, draws the overlay, updates UI status, logs messages, and pushes telemetry. If an error happens, it catches it, shows an error status, clears target telemetry, logs the error, and records error telemetry. In finally, it yields to the browser and sets isDetecting false.

startedAt:
startedAt stores performance.now() at the beginning of runDetection. It is used to calculate loopMs.

selected:
selected is the single best detection chosen by chooseCandidate. If selected is null, there is no valid tracked target in that frame.

labelText:
labelText in runDetection is the selected class and confidence percentage.

targetLogMessage:
targetLogMessage is the full console message created by buildTargetLogMessage.

deltaText:
deltaText is a short string showing filtered dx and dy, used when logging possible targets.

text:
text is the human-readable error message inside the catch block of runDetection.

corsBlocked:
corsBlocked is true when the error message looks like a CORS/cross-origin canvas problem. If true, the UI says Detect: blocked (CORS) instead of a generic error.

stopDetectionLoop(reason):
stopDetectionLoop stops the detection loop. It sets detectLoopActive false, clears detectTimer, sets isDetecting false, clears overlay drawings, hides overlayCanvas, resets lastDetectState and lastDetectLabel, clears target telemetry, sets mode Manual, and sets status based on the reason. If reason is idle, it shows Detect idle and Safe. If reason is error, it shows Detect: stream error.

reason:
reason tells stopDetectionLoop why the loop stopped. It can be "idle", "error", or another string.

scheduleNextDetection(delay):
scheduleNextDetection schedules the next runDetection call using setTimeout. It first checks detectLoopActive. It clears any previous timer, then starts a new timer. After runDetection finishes, it calculates how long the pass took and schedules the next one using DETECT_INTERVAL_MS minus elapsed time, but never less than DETECT_MIN_IDLE_MS.

delay:
delay is the number of milliseconds to wait before starting the next detection pass.

startDetectionLoop():
startDetectionLoop starts the repeating detection loop if it is not already active and feedImg exists. It sets detectLoopActive true, updates UI status to Detect: starting, sets safety to Scanning, sets mode to Observe, logs Detection loop started, shows the overlayCanvas, and calls scheduleNextDetection(0) to start immediately.

init():
init is called at the bottom of detect.js. The function itself is defined in control.js, not detect.js. detect.js calls init after both control.js and detect.js are loaded, so the page can initialize with detection and control logic available.
*/









// Section: static config.