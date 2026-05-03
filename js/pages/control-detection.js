// Detection-only storage keys, model paths, and timing constants live here so control.js can stay focused on page flow.
// DRONE_MODEL_URL points at the real ONNX weight file used by the AeroYOLO path.
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

// Profiles decide which labels are considered real candidates for each backend.
// "strict" still allows the overlay to draw every raw detection, but only drone/helicopter can become tracked targets.
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

// These helpers convert the settings controls into structured backend/profile configuration.
function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES.strict;
}

function getDetectBackend(backendId) {
  return DETECT_BACKENDS[backendId] || DETECT_BACKENDS.coco;
}

function getProfileLabels(profile, backendId) {
  if (!profile) return [];
  // Each backend speaks different class names, so the active profile has backend-specific allow-lists.
  return backendId === 'aeroyolo' ? (profile.aeroyoloLabels || []) : (profile.cocoLabels || []);
}

// Settings are always read from the live controls first, then clamped to safe numeric ranges.
function getSettings() {
  const backend = getDetectBackend(detectBackendSelect ? detectBackendSelect.value : DEFAULT_DETECT_BACKEND_ID);
  const profile = getProfile(detectProfileSelect ? detectProfileSelect.value : 'strict');
  const strongThreshold = clamp(strongThresholdInput && strongThresholdInput.value, 0.05, 0.99, 0.3);
  const possibleThreshold = clamp(possibleThresholdInput && possibleThresholdInput.value, 0.01, strongThreshold, 0.12);
  const smoothingAlpha = clamp(smoothingInput && smoothingInput.value, 0.05, 1, 0.35);
  const deadZone = clamp(deadZoneInput && deadZoneInput.value, 0, 0.5, 0.08);
  return { backend, profile, strongThreshold, possibleThreshold, smoothingAlpha, deadZone };
}

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

function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DETECTION_SETTINGS_STORAGE_KEY) || 'null');
  } catch (err) {
    console.warn('Failed to parse saved detection settings.', err);
  }
  const backend = getDetectBackend((saved && saved.backendId) || DEFAULT_DETECT_BACKEND_ID);
  const profile = getProfile(saved && saved.profileId);
  if (detectBackendSelect) detectBackendSelect.value = backend.id;
  if (detectProfileSelect) detectProfileSelect.value = profile.id;
  if (strongThresholdInput) strongThresholdInput.value = String(clamp(saved && saved.strongThreshold, 0.05, 0.99, 0.3));
  if (possibleThresholdInput) possibleThresholdInput.value = String(clamp(saved && saved.possibleThreshold, 0.01, 0.95, 0.12));
  if (smoothingInput) smoothingInput.value = String(clamp(saved && saved.smoothingAlpha, 0.05, 1, 0.35));
  if (deadZoneInput) deadZoneInput.value = String(clamp(saved && saved.deadZone, 0, 0.5, 0.08));
  setProfileStatus(profile.id);
}

// Track-lock helpers allow a nearby follow-up detection to use slightly relaxed thresholds.
function hasTrackLock() {
  return trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT && !!trackingState.label;
}

function isNearLockedTarget(metrics) {
  if (!hasTrackLock() || !metrics || !overlayCanvas) return false;
  // Distance is normalized against the on-screen diagonal so the rule behaves similarly on different viewport sizes.
  const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
  const distance = Math.hypot(metrics.centerX - trackingState.filteredCenterX, metrics.centerY - trackingState.filteredCenterY);
  return distance / diag <= TRACK_LOCK_DISTANCE_RATIO;
}

// clearTargetTelemetry resets both the HUD readouts and the in-memory tracking state when a target is lost.
function clearTargetTelemetry() {
  setReadout(targetLabelVal, 'n/a');
  setReadout(targetScoreVal, 'n/a');
  setReadout(targetCenterVal, 'n/a');
  setReadout(targetCenterFilteredVal, 'n/a');
  setReadout(targetDeltaVal, 'n/a');
  setReadout(targetDeltaNormVal, 'n/a');
  setReadout(simCommandVal, 'HOLD / HOLD');
  setReadout(loopTimeVal, 'n/a');
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
function syncOverlaySize() {
  if (!(overlayCanvas && feedImg && feedImg.parentElement)) return;
  // Match the canvas to the displayed image container, not the raw image pixels, because drawing happens in screen space.
  overlayCanvas.width = Math.round(feedImg.parentElement.clientWidth || 0);
  overlayCanvas.height = Math.round(feedImg.parentElement.clientHeight || 0);
}

function clearOverlay() {
  if (overlayCtx && overlayCanvas) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }
}

function getImageFit() {
  if (!(feedImg && feedImg.parentElement && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  const width = feedImg.parentElement.clientWidth;
  const height = feedImg.parentElement.clientHeight;
  const scale = Math.min(width / feedImg.naturalWidth, height / feedImg.naturalHeight);
  const displayWidth = feedImg.naturalWidth * scale;
  const displayHeight = feedImg.naturalHeight * scale;
  return { scale, offsetX: (width - displayWidth) / 2, offsetY: (height - displayHeight) / 2 };
}

function computeMetrics(det) {
  syncOverlaySize();
  const fit = getImageFit();
  if (!fit) return null;
  const [rawX, rawY, rawW, rawH] = det.bbox;
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
  const deltaY = screenCenterY - centerY;
  // Normalized deltas collapse every viewport into a -1..1 range for simpler assist logic.
  const normX = screenCenterX ? Math.max(-1, Math.min(1, deltaX / screenCenterX)) : 0;
  const normY = screenCenterY ? Math.max(-1, Math.min(1, deltaY / screenCenterY)) : 0;
  return { x, y, w, h, centerX, centerY, deltaX, deltaY, normX, normY };
}

// Candidate ranking filters the raw model output into the single target the UI should track.
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

function buildDetections(predictions, settings) {
  const labels = new Set(getProfileLabels(settings.profile, settings.backend.id));
  return predictions
    // Keep low-confidence clutter out of the overlay entirely.
    .filter((p) => (p.score || 0) >= DRAW_THRESHOLD)
    .map((p) => {
      const metrics = computeMetrics(p);
      const thresholds = getDetectionThresholds(p.class, metrics, settings);
      const score = p.score || 0;
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

function chooseCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, det) => {
    let detRank = det.score || 0;
    let bestRank = best.score || 0;
    // When a target is already locked, penalize far-away boxes so the tracker stays stable.
    if (trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT) {
      const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
      detRank -= Math.hypot(det.metrics.centerX - trackingState.filteredCenterX, det.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
      bestRank -= Math.hypot(best.metrics.centerX - trackingState.filteredCenterX, best.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
    }
    return detRank > bestRank ? det : best;
  });
}

// Smoothing keeps the overlay and operator hints from jumping on every raw frame.
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

function simAxis(norm, deadZone, negLabel, posLabel) {
  const mag = Math.abs(norm);
  if (mag < deadZone) return { value: 0, label: 'HOLD' };
  // Three coarse bands are enough for operator guidance and easier to read than raw float output.
  const step = mag >= 0.45 ? 1 : mag >= 0.22 ? 0.5 : 0.25;
  const suffix = mag >= 0.45 ? 'LARGE' : mag >= 0.22 ? 'MED' : 'SMALL';
  return { value: norm < 0 ? -step : step, label: `${norm < 0 ? negLabel : posLabel}_${suffix}` };
}

function simCommand(filtered, settings) {
  const pan = simAxis(filtered.normX, settings.deadZone, 'LEFT', 'RIGHT');
  const tilt = simAxis(filtered.normY, settings.deadZone, 'DOWN', 'UP');
  return { pan: pan.value, tilt: tilt.value, panLabel: pan.label, tiltLabel: tilt.label };
}

function describeCameraMove() {
  const panAssist = parseSimLabel(trackingState.simPanLabel);
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel);
  const moves = [];
  if (panAssist.direction !== 'hold') moves.push(friendlyDirection(panAssist.direction));
  if (tiltAssist.direction !== 'hold') moves.push(friendlyDirection(tiltAssist.direction));
  return moves.length ? moves.join(' / ') : 'HOLD';
}

function buildTargetLogMessage(selected) {
  const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`;
  const x = trackingState.rawCenterX.toFixed(0);
  const y = trackingState.rawCenterY.toFixed(0);
  const move = describeCameraMove();
  return `Target detected: ${labelText} x=${x} y=${y} move=${move}`;
}

// Drawing helpers render both the full set of predictions and the currently selected target lock.
function drawReticle() {
  if (!(overlayCtx && overlayCanvas)) return;
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

function drawScene(detections, selected) {
  if (!(overlayCtx && overlayCanvas)) return;
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
function updateSelectedTarget(selected, settings, loopMs) {
  const filtered = smoothMetrics(selected.metrics, settings);
  const sim = simCommand(filtered, settings);
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
  setReadout(targetLabelVal, selected.isStrong ? selected.class : `Possible ${selected.class}`);
  setReadout(targetScoreVal, `${((selected.score || 0) * 100).toFixed(1)}%`);
  setReadout(targetCenterVal, formatPoint(selected.metrics.centerX, selected.metrics.centerY));
  setReadout(targetCenterFilteredVal, formatPoint(filtered.centerX, filtered.centerY));
  setReadout(targetDeltaVal, formatPoint(filtered.deltaX, filtered.deltaY));
  setReadout(targetDeltaNormVal, formatNorm(filtered.normX, filtered.normY));
  setReadout(simCommandVal, `${sim.panLabel} (${sim.pan.toFixed(2)}) / ${sim.tiltLabel} (${sim.tilt.toFixed(2)})`);
  setReadout(loopTimeVal, loopMs.toFixed(1));
  updateOperatorAssistReadout();
}

function pushTelemetry(entry) {
  sessionTelemetry.push(entry);
  // Keep telemetry bounded in memory so a long session does not slowly grow the page footprint forever.
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

// The detection loop yields back to the browser between frames so UI and fetch handlers stay responsive.
async function yieldToBrowser() {
  if (window.tf && typeof tf.nextFrame === 'function') {
    try {
      await tf.nextFrame();
      return;
    } catch (err) {
      console.warn('tf.nextFrame() failed, falling back to requestAnimationFrame.', err);
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Input preparation handles either low-resolution TF.js detection or the padded ONNX path.
function ensureDetectSourceSurface() {
  if (!detectSourceCanvas) detectSourceCanvas = document.createElement('canvas');
  if (!detectSourceCtx && detectSourceCanvas) detectSourceCtx = detectSourceCanvas.getContext('2d', { alpha: false });
  return detectSourceCanvas && detectSourceCtx ? { canvas: detectSourceCanvas, ctx: detectSourceCtx } : null;
}

function getDetectionSource() {
  if (!(feedImg && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
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

function rescalePredictionBBox(prediction, scaleX, scaleY) {
  if (!prediction || !Array.isArray(prediction.bbox) || prediction.bbox.length < 4) return prediction;
  const [x, y, w, h] = prediction.bbox;
  return {
    ...prediction,
    bbox: [x * scaleX, y * scaleY, w * scaleX, h * scaleY],
  };
}

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
  if (surface.canvas.width !== modelWidth) surface.canvas.width = modelWidth;
  if (surface.canvas.height !== modelHeight) surface.canvas.height = modelHeight;
  surface.ctx.clearRect(0, 0, modelWidth, modelHeight);
  surface.ctx.fillStyle = '#727272';
  surface.ctx.fillRect(0, 0, modelWidth, modelHeight);
  surface.ctx.drawImage(feedImg, padX, padY, drawWidth, drawHeight);
  const imageData = surface.ctx.getImageData(0, 0, modelWidth, modelHeight).data;
  const channelSize = modelWidth * modelHeight;
  const input = new Float32Array(channelSize * 3);
  // ONNX expects CHW float32 input in the 0..1 range.
  for (let pixel = 0, i = 0; i < imageData.length; i += 4, pixel += 1) {
    input[pixel] = imageData[i] / 255;
    input[channelSize + pixel] = imageData[i + 1] / 255;
    input[channelSize * 2 + pixel] = imageData[i + 2] / 255;
  }
  return { input, scale, padX, padY };
}

function clampBboxToFeed(bbox) {
  if (!feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight || !Array.isArray(bbox) || bbox.length < 4) return bbox;
  const [rawX, rawY, rawW, rawH] = bbox;
  const x = Math.max(0, Math.min(feedImg.naturalWidth, rawX));
  const y = Math.max(0, Math.min(feedImg.naturalHeight, rawY));
  const w = Math.max(0, Math.min(feedImg.naturalWidth - x, rawW));
  const h = Math.max(0, Math.min(feedImg.naturalHeight - y, rawH));
  return [x, y, w, h];
}

function normalizeDroneModelPrediction(data, offset, prepared) {
  if (!prepared || !Number.isFinite(prepared.scale) || prepared.scale <= 0) return null;
  const x1 = Number(data[offset]);
  const y1 = Number(data[offset + 1]);
  const x2 = Number(data[offset + 2]);
  const y2 = Number(data[offset + 3]);
  const scoreRaw = Number(data[offset + 4]);
  const classIdRaw = Number(data[offset + 5]);
  const score = Number.isFinite(scoreRaw) ? scoreRaw : 0;
  const classId = Number.isFinite(classIdRaw) ? Math.round(classIdRaw) : -1;
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

// Model bootstrap is backend-specific: TF.js for COCO-SSD and ONNX Runtime Web for AeroYOLO.
async function ensureDetectBackend() {
  if (detectBackendReady || !window.tf) return;
  try {
    await tf.ready();
    const currentBackend = typeof tf.getBackend === 'function' ? tf.getBackend() : '';
    if (currentBackend !== 'webgl' && typeof tf.findBackend === 'function' && tf.findBackend('webgl')) {
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

async function ensureCocoDetectModel() {
  if (detectModelReady && detectModel) return detectModel;
  if (!window.cocoSsd) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('COCO-SSD model missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
    await ensureDetectBackend();
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

async function ensureDroneDetectSession() {
  if (droneDetectSessionReady && droneDetectSession) return droneDetectSession;
  if (!(window.ort && ort.InferenceSession && ort.Tensor)) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('ONNX Runtime Web support missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
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
async function detectWithCoco() {
  const model = await ensureCocoDetectModel();
  if (!model) return [];
  const detectionSource = getDetectionSource();
  if (!detectionSource) return [];
  const rawPredictions = await model.detect(detectionSource.source);
  return (detectionSource.scaleX === 1 && detectionSource.scaleY === 1)
    ? rawPredictions
    : rawPredictions.map((prediction) => rescalePredictionBBox(prediction, detectionSource.scaleX, detectionSource.scaleY));
}

async function detectWithAeroYolo() {
  const session = await ensureDroneDetectSession();
  if (!session) return [];
  const inputName = session.inputNames && session.inputNames[0] ? session.inputNames[0] : 'images';
  const outputName = session.outputNames && session.outputNames[0] ? session.outputNames[0] : 'output0';
  const inputMeta = session.inputMetadata && session.inputMetadata[inputName] ? session.inputMetadata[inputName] : null;
  const dims = inputMeta && Array.isArray(inputMeta.dimensions) ? inputMeta.dimensions : [1, 3, 640, 640];
  const modelHeight = Number(dims[2]) || 640;
  const modelWidth = Number(dims[3]) || 640;
  const prepared = preprocessDroneDetectSource(modelWidth, modelHeight);
  if (!prepared) return [];
  const tensor = new ort.Tensor('float32', prepared.input, [1, 3, modelHeight, modelWidth]);
  const result = await session.run({ [inputName]: tensor });
  const outputTensor = result && result[outputName] ? result[outputName] : null;
  if (!outputTensor || !outputTensor.data || !Array.isArray(outputTensor.dims)) return [];
  // The current model returns one row per box, with 6 values per row: x1, y1, x2, y2, score, classId.
  const rows = outputTensor.dims[1] || 0;
  const stride = outputTensor.dims[2] || 6;
  const predictions = [];
  for (let i = 0; i < rows; i += 1) {
    const offset = i * stride;
    const prediction = normalizeDroneModelPrediction(outputTensor.data, offset, prepared);
    if (prediction) predictions.push(prediction);
  }
  return predictions;
}

// runDetection is the core detection pass: predict, select, update the HUD, log, and export telemetry.
async function runDetection() {
  if (isDetecting || !feedImg || !feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  const startedAt = performance.now();
  try {
    const settings = getSettings();
    setProfileStatus(settings.profile.id);
    const predictions = settings.backend.id === 'aeroyolo' ? await detectWithAeroYolo() : await detectWithCoco();
    const detections = buildDetections(predictions, settings);
    // Only candidate detections are allowed to compete for the single tracked target.
    const selected = chooseCandidate(detections.filter((det) => det.isCandidate && det.metrics));
    const loopMs = performance.now() - startedAt;
    if (!selected) {
      trackingState.missedFrames += 1;
      if (trackingState.missedFrames >= LOST_LIMIT) clearTargetTelemetry();
      drawScene(detections, null);
      setReadout(loopTimeVal, loopMs.toFixed(1));
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
      setDetectStatus('Detect: target', 'bg-danger');
      setSafetyState('danger', 'Air target detected');
      logConsole(targetLogMessage, 'text-danger');
      lastDetectState = 'target';
    } else {
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
    const text = err && err.message ? err.message : 'check camera address / stream';
    const corsBlocked = /tainted canvases|cross-origin|cross origin/i.test(text);
    setDetectStatus(corsBlocked ? 'Detect: blocked (CORS)' : 'Detect: error', corsBlocked ? 'bg-warning text-dark' : 'bg-danger');
    setSafetyState('warn', corsBlocked ? 'Detection blocked' : 'Scanning');
    clearTargetTelemetry();
    if (lastDetectState !== 'error' || lastDetectLabel !== text) logConsole(`Detection error: ${text}`, 'text-warning');
    lastDetectState = 'error';
    lastDetectLabel = text;
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'error', error: text });
  } finally {
    await yieldToBrowser();
    isDetecting = false;
  }
}

// Detection loop scheduling keeps a target cadence while respecting actual inference time.
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
    setDetectStatus('Detect idle', 'bg-secondary');
    setSafetyState('ok', 'Safe');
  } else if (reason === 'error') {
    setDetectStatus('Detect: stream error', 'bg-warning');
  }
}

function scheduleNextDetection(delay) {
  if (!detectLoopActive) return;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    const startedAt = performance.now();
    await runDetection();
    // Keep a roughly fixed cadence: fast frames wait a little, slow frames continue almost immediately.
    scheduleNextDetection(Math.max(DETECT_MIN_IDLE_MS, DETECT_INTERVAL_MS - (performance.now() - startedAt)));
  }, Math.max(0, delay || 0));
}

function startDetectionLoop() {
  if (detectLoopActive || !feedImg) return;
  detectLoopActive = true;
  setDetectStatus('Detect: starting', 'bg-warning');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole('Detection loop started.', 'text-info');
  if (overlayCanvas) overlayCanvas.classList.remove('d-none');
  scheduleNextDetection(0);
}

// control.js defines init(), but we call it here so both halves of the control page are loaded first.
init();
