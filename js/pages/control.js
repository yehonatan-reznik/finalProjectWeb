const $ = (id) => document.getElementById(id);

const feedImg = $('cameraFeed');
const placeholder = $('cameraPlaceholder');
const urlInput = $('cameraUrlInput');
const connectBtn = $('cameraConnectBtn');
const statusLabel = $('cameraStatus');
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
const overlayCanvas = $('cameraOverlay');
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
const detectStatus = $('detectStatus');
const consolePanel = $('console');
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
const detectBackendSelect = $('detectBackendSelect');
const detectProfileSelect = $('detectProfileSelect');
const strongThresholdInput = $('strongThresholdInput');
const possibleThresholdInput = $('possibleThresholdInput');
const smoothingInput = $('smoothingInput');
const deadZoneInput = $('deadZoneInput');
const downloadTelemetryBtn = $('downloadTelemetryBtn');
const clearTelemetryBtn = $('clearTelemetryBtn');
const assistMoveVal = $('assistMoveVal');
const assistButtonVal = $('assistButtonVal');
const assistCenterVal = $('assistCenterVal');
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

const STORAGE_KEY = 'skyshield_camera_base_url';
const ESP32_STORAGE_KEY = 'esp32_ip';
const DETECTION_SETTINGS_STORAGE_KEY = 'skyshield_detection_settings_v2';
const ASSIST_CALIBRATION_STORAGE_KEY = 'skyshield_assist_calibration_v1';
const DRONE_MODEL_URL = 'models/aeroyolo.onnx';
const DEFAULT_DETECT_BACKEND_ID = 'aeroyolo';
const DETECT_INTERVAL_MS = 180;
const DETECT_MIN_IDLE_MS = 24;
const DETECT_MAX_SOURCE_WIDTH = 384;
const DETECT_MAX_SOURCE_HEIGHT = 384;
const DRAW_THRESHOLD = 0.05;
const LOST_LIMIT = 8;
const MAX_LOG_ROWS = 250;
const MAX_TELEMETRY = 1200;
const CALIBRATION_PROBE_DELTA_DEG = 5;
const TRACK_LOCK_THRESHOLD_FACTOR = 0.6;
const TRACK_LOCK_DISTANCE_RATIO = 0.22;
const TRACK_LOCK_MIN_SCORE = 0.08;

const DETECT_BACKENDS = {
  coco: { id: 'coco', label: 'COCO-SSD' },
  aeroyolo: { id: 'aeroyolo', label: 'AeroYOLO ONNX' },
};

const DRONE_MODEL_LABELS = {
  0: 'aircraft',
  1: 'drone',
  2: 'helicopter',
};

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

let streamCandidates = [];
let streamCandidateIndex = 0;
let detectTimer = null;
let detectLoopActive = false;
let detectModel = null;
let detectModelReady = false;
let droneDetectSession = null;
let droneDetectSessionReady = false;
let isDetecting = false;
let isLaserOn = false;
let frameCounter = 0;
let lastDetectState = '';
let lastDetectLabel = '';
let detectBackendReady = false;
let detectSourceCanvas = null;
let detectSourceCtx = null;
const sessionTelemetry = [];

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

const controllerState = {
  config: null,
  calibration: {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  },
};

const MANUAL_BUTTON_COMMANDS = [
  { button: 'Left', command: 'step_left' },
  { button: 'Right', command: 'step_right' },
  { button: 'Up', command: 'servo_down' },
  { button: 'Down', command: 'servo_up' },
];

function clamp(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES.strict;
}

function getDetectBackend(backendId) {
  return DETECT_BACKENDS[backendId] || DETECT_BACKENDS.coco;
}

function getProfileLabels(profile, backendId) {
  if (!profile) return [];
  return backendId === 'aeroyolo' ? (profile.aeroyoloLabels || []) : (profile.cocoLabels || []);
}

function hasTrackLock() {
  return trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT && !!trackingState.label;
}

function isNearLockedTarget(metrics) {
  if (!hasTrackLock() || !metrics || !overlayCanvas) return false;
  const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
  const distance = Math.hypot(metrics.centerX - trackingState.filteredCenterX, metrics.centerY - trackingState.filteredCenterY);
  return distance / diag <= TRACK_LOCK_DISTANCE_RATIO;
}

function logConsole(message, variant) {
  if (!consolePanel) return;
  const row = document.createElement('div');
  if (variant) row.className = variant;
  row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  consolePanel.appendChild(row);
  while (consolePanel.children.length > MAX_LOG_ROWS) {
    consolePanel.removeChild(consolePanel.firstElementChild);
  }
  consolePanel.scrollTop = consolePanel.scrollHeight;
}

function setDetectStatus(text, variant) {
  if (!detectStatus) return;
  detectStatus.textContent = text;
  detectStatus.className = 'badge';
  (variant || 'bg-secondary').split(' ').forEach((cls) => detectStatus.classList.add(cls));
}

function setSafetyState(state, text) {
  if (!(safetyDot && safetyVal)) return;
  safetyDot.classList.remove('status-ok', 'status-warn', 'status-danger');
  const cls = state === 'danger' ? 'status-danger' : state === 'warn' ? 'status-warn' : 'status-ok';
  safetyDot.classList.add(cls);
  safetyVal.textContent = text || (state === 'danger' ? 'Air target detected' : state === 'warn' ? 'Scanning' : 'Safe');
}

function setMode(text) {
  if (modeVal) modeVal.textContent = text || 'Manual';
}

function setProfileStatus(profileId) {
  const profile = getProfile(profileId);
  if (profileVal) profileVal.textContent = profile.label;
}

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

function normalizeObservedDirection(value) {
  return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';
}

function getOppositeDirection(direction) {
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

function axisRoleFromDirection(direction) {
  if (direction === 'left' || direction === 'right') return 'pan';
  if (direction === 'up' || direction === 'down') return 'tilt';
  return 'unknown';
}

function friendlyDirection(direction) {
  return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();
}

function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {
  const raw = normalizeObservedDirection(rawPositiveDirection);
  if (raw === 'unknown') return 'unknown';
  return signedFactor >= 0 ? raw : getOppositeDirection(raw);
}

function parseSimLabel(label) {
  if (!label || label === 'HOLD') {
    return { label: 'HOLD', direction: 'hold', size: 'HOLD', taps: 0 };
  }
  const [directionRaw, sizeRaw] = String(label).split('_');
  const direction = String(directionRaw || '').toLowerCase();
  const size = String(sizeRaw || 'SMALL').toUpperCase();
  const taps = size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1;
  return { label, direction, size, taps };
}

function readCalibrationFromControls() {
  controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);
  controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);
}

function writeCalibrationControls() {
  if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
}

function loadCalibration() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(ASSIST_CALIBRATION_STORAGE_KEY) || 'null');
  } catch (err) {
    console.warn('Failed to parse saved calibration.', err);
  }
  controllerState.calibration = {
    xPositiveObserved: normalizeObservedDirection(saved && saved.xPositiveObserved),
    yPositiveObserved: normalizeObservedDirection(saved && saved.yPositiveObserved),
  };
  writeCalibrationControls();
}

function saveCalibration(logChange) {
  readCalibrationFromControls();
  localStorage.setItem(ASSIST_CALIBRATION_STORAGE_KEY, JSON.stringify(controllerState.calibration));
  if (logChange) {
    logConsole(`Calibration saved: X+=${friendlyDirection(controllerState.calibration.xPositiveObserved)}, Y+=${friendlyDirection(controllerState.calibration.yPositiveObserved)}`, 'text-info');
  }
}

function resetCalibration() {
  controllerState.calibration = {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  };
  localStorage.removeItem(ASSIST_CALIBRATION_STORAGE_KEY);
  writeCalibrationControls();
}

function getControllerConfigNumber(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function deriveCalibration() {
  const xObserved = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  const yObserved = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
  const xRole = axisRoleFromDirection(xObserved);
  const yRole = axisRoleFromDirection(yObserved);
  const xDir = getControllerConfigNumber(controllerState.config && controllerState.config.x_dir, 1);
  const yDir = getControllerConfigNumber(controllerState.config && controllerState.config.y_dir, 1);
  const commands = {
    step_right: commandDirectionFromRawPositive(xObserved, xDir),
    step_left: commandDirectionFromRawPositive(xObserved, -xDir),
    servo_up: commandDirectionFromRawPositive(yObserved, yDir),
    servo_down: commandDirectionFromRawPositive(yObserved, -yDir),
  };

  let panSummary = 'unknown';
  if (xRole === 'pan') panSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  else if (yRole === 'pan') panSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  let tiltSummary = 'unknown';
  if (xRole === 'tilt') tiltSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  else if (yRole === 'tilt') tiltSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  const buttonSummary = MANUAL_BUTTON_COMMANDS
    .map(({ button, command }) => `${button}=${friendlyDirection(commands[command])}`)
    .join(' | ');

  return { xObserved, yObserved, xRole, yRole, xDir, yDir, commands, panSummary, tiltSummary, buttonSummary };
}

function findManualButtonForDirection(direction, derived) {
  const target = normalizeObservedDirection(direction);
  if (target === 'unknown') return null;
  return MANUAL_BUTTON_COMMANDS.find(({ command }) => derived.commands[command] === target) || null;
}

function formatAxisAssist(axisName, parsedLabel, derived) {
  if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;
  const button = findManualButtonForDirection(parsedLabel.direction, derived);
  const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`;
  if (!button) return `${axisName}: ${moveText} (finish calibration)`;
  return `${axisName}: ${button.button} x${parsedLabel.taps}`;
}

function updateCalibrationReadouts() {
  const derived = deriveCalibration();
  if (controllerConfigVal) {
    setReadout(controllerConfigVal, controllerState.config ? `x_dir=${derived.xDir}, y_dir=${derived.yDir}` : 'n/a');
  }
  setReadout(calibrationPanVal, derived.panSummary);
  setReadout(calibrationTiltVal, derived.tiltSummary);
  setReadout(calibrationButtonsVal, derived.buttonSummary);
}

function updateOperatorAssistReadout() {
  const derived = deriveCalibration();
  if (!trackingState.hasTarget) {
    setReadout(assistMoveVal, 'No target');
    setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');
    setReadout(assistCenterVal, 'Not centered');
    return;
  }

  const panAssist = parseSimLabel(trackingState.simPanLabel);
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel);
  const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold';

  if (centered) {
    setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');
    setReadout(assistButtonVal, 'Hold position');
    setReadout(assistCenterVal, 'Centered');
    return;
  }

  const moveParts = [];
  if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);
  if (tiltAssist.direction !== 'hold') moveParts.push(`TILT ${friendlyDirection(tiltAssist.direction)}_${tiltAssist.size}`);
  setReadout(assistMoveVal, moveParts.join(' / '));

  const buttonParts = [];
  if (panAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Pan', panAssist, derived));
  if (tiltAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Tilt', tiltAssist, derived));
  setReadout(assistButtonVal, buttonParts.join(' / '));
  setReadout(assistCenterVal, trackingState.isPossible ? 'Off-center (possible)' : 'Off-center');
}

function setReadout(el, text) {
  if (el) el.textContent = text;
}

function formatPoint(x, y) {
  return `${x.toFixed(0)}, ${y.toFixed(0)}`;
}

function formatNorm(x, y) {
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

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

function syncOverlaySize() {
  if (!(overlayCanvas && feedImg && feedImg.parentElement)) return;
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
  const normX = screenCenterX ? Math.max(-1, Math.min(1, deltaX / screenCenterX)) : 0;
  const normY = screenCenterY ? Math.max(-1, Math.min(1, deltaY / screenCenterY)) : 0;
  return { x, y, w, h, centerX, centerY, deltaX, deltaY, normX, normY };
}

function getDetectionThresholds(className, metrics, settings) {
  const base = {
    possible: settings.possibleThreshold,
    strong: settings.strongThreshold,
  };
  if (!(hasTrackLock() && className === trackingState.label && isNearLockedTarget(metrics))) return base;
  return {
    possible: Math.max(TRACK_LOCK_MIN_SCORE, base.possible * TRACK_LOCK_THRESHOLD_FACTOR),
    strong: Math.max(TRACK_LOCK_MIN_SCORE, base.strong * TRACK_LOCK_THRESHOLD_FACTOR),
  };
}

function buildDetections(predictions, settings) {
  const labels = new Set(getProfileLabels(settings.profile, settings.backend.id));
  return predictions
    .filter((p) => (p.score || 0) >= DRAW_THRESHOLD)
    .map((p) => {
      const metrics = computeMetrics(p);
      const thresholds = getDetectionThresholds(p.class, metrics, settings);
      const score = p.score || 0;
      return {
        ...p,
        metrics,
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
    if (trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT) {
      const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height));
      detRank -= Math.hypot(det.metrics.centerX - trackingState.filteredCenterX, det.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
      bestRank -= Math.hypot(best.metrics.centerX - trackingState.filteredCenterX, best.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
    }
    return detRank > bestRank ? det : best;
  });
}

function smoothMetrics(raw, settings) {
  if (!trackingState.hasTarget || trackingState.missedFrames >= LOST_LIMIT) {
    return { centerX: raw.centerX, centerY: raw.centerY, deltaX: raw.deltaX, deltaY: raw.deltaY, normX: raw.normX, normY: raw.normY };
  }
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
    const stroke = isSelected ? '#38bdf8' : det.isStrong ? '#ff4d4d' : det.isCandidate ? '#f59e0b' : '#22c55e';
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = isSelected ? 3 : 2;
    overlayCtx.setLineDash(det.isCandidate && !det.isStrong && !isSelected ? [5, 3] : []);
    overlayCtx.strokeRect(det.metrics.x, det.metrics.y, det.metrics.w, det.metrics.h);
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
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

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
  return {
    class: className,
    score,
    classId,
    bbox,
  };
}

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
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: selected.isStrong ? 'target' : 'possible', backend: settings.backend.id, profile: settings.profile.id, loopMs: Number(loopMs.toFixed(2)), label: selected.class, score: Number((selected.score || 0).toFixed(4)), rawCenter: { x: Number(trackingState.rawCenterX.toFixed(2)), y: Number(trackingState.rawCenterY.toFixed(2)) }, filteredCenter: { x: Number(trackingState.filteredCenterX.toFixed(2)), y: Number(trackingState.filteredCenterY.toFixed(2)) }, filteredDelta: { x: Number(trackingState.filteredDeltaX.toFixed(2)), y: Number(trackingState.filteredDeltaY.toFixed(2)), normX: Number(trackingState.filteredNormX.toFixed(4)), normY: Number(trackingState.filteredNormY.toFixed(4)) }, sim: { pan: trackingState.simPan, tilt: trackingState.simTilt, panLabel: trackingState.simPanLabel, tiltLabel: trackingState.simTiltLabel } });
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

function normalizeBaseUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

function buildStreamCandidates(normalized) {
  try {
    const u = new URL(normalized);
    if (u.pathname && u.pathname !== '/') return [...new Set([normalized, u.origin + '/stream', u.origin])];
    return [normalized + '/stream', normalized];
  } catch (err) {
    console.error('Invalid camera URL', err);
    return [];
  }
}

function configureFeedCorsMode() {
  if (feedImg) feedImg.crossOrigin = 'anonymous';
}

function setStream(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    streamCandidates = [];
    streamCandidateIndex = 0;
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
  streamCandidates = buildStreamCandidates(normalized);
  streamCandidateIndex = 0;
  const first = streamCandidates[0];
  if (!first) return '';
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

function stopDetectionLoop(reason) {
  detectLoopActive = false;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = null;
  isDetecting = false;
  clearOverlay();
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

function sendCmd(cmd) {
  const ip = localStorage.getItem(ESP32_STORAGE_KEY);
  if (!ip) {
    alert('Set the ESP32 address first.');
    return Promise.resolve(null);
  }
  return fetch(`${ip}/${cmd}`, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) {
        try {
          const text = await res.clone().text();
          let message = text;
          try {
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
      console.error(`Command ${cmd} failed:`, err);
      logConsole(`Controller command failed: ${cmd}`, 'text-danger');
      return null;
    });
}

function parseControllerStatusText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
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

async function syncControllerConfig(logSuccess) {
  const res = await sendCmd('config');
  if (!res || !res.ok) {
    controllerState.config = null;
    updateCalibrationReadouts();
    updateOperatorAssistReadout();
    return null;
  }
  try {
    controllerState.config = await res.json();
    updateCalibrationReadouts();
    updateOperatorAssistReadout();
    if (logSuccess) logConsole(`Controller config loaded: x_dir=${getControllerConfigNumber(controllerState.config.x_dir, 1)}, y_dir=${getControllerConfigNumber(controllerState.config.y_dir, 1)}`, 'text-info');
    return controllerState.config;
  } catch (err) {
    console.error('Failed to parse controller config.', err);
    controllerState.config = null;
    updateCalibrationReadouts();
    updateOperatorAssistReadout();
    if (logSuccess) logConsole('Controller config parse failed.', 'text-warning');
    return null;
  }
}

async function syncLaserState() {
  const res = await sendCmd('status');
  if (!res || !res.ok) return;
  const text = await res.text();
  const status = parseControllerStatusText(text);
  if (!status) return;
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
}

async function sendProbe(axis, sign) {
  const delta = sign > 0 ? CALIBRATION_PROBE_DELTA_DEG : -CALIBRATION_PROBE_DELTA_DEG;
  const query = axis === 'x' ? `nudge?dx=${delta}` : `nudge?dy=${delta}`;
  const res = await sendCmd(query);
  if (!res || !res.ok) return;
  logConsole(`Calibration probe sent: ${axis.toUpperCase()}${sign > 0 ? '+' : '-'} (${delta > 0 ? '+' : ''}${delta} deg)`, 'text-info');
}

function downloadTelemetry() {
  if (!sessionTelemetry.length) return logConsole('No telemetry to download yet.', 'text-warning');
  const blob = new Blob([JSON.stringify(sessionTelemetry, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skyshield-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function init() {
  clearTargetTelemetry();
  loadSettings();
  loadCalibration();
  localStorage.removeItem('skyshield_camera_proxy_enabled');
  updateCalibrationReadouts();
  updateOperatorAssistReadout();
  [detectBackendSelect, detectProfileSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      clearTargetTelemetry();
      lastDetectState = '';
      lastDetectLabel = '';
      const s = getSettings();
      logConsole(`Detection mode updated: ${s.backend.label}, ${s.profile.label}`, 'text-info');
    });
  });
  [strongThresholdInput, possibleThresholdInput, smoothingInput, deadZoneInput].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      const s = getSettings();
      logConsole(`Detection settings updated: ${s.backend.label}, ${s.profile.label}, strong=${s.strongThreshold.toFixed(2)}, possible=${s.possibleThreshold.toFixed(2)}, alpha=${s.smoothingAlpha.toFixed(2)}, deadZone=${s.deadZone.toFixed(2)}`, 'text-info');
    });
  });
  if (downloadTelemetryBtn) downloadTelemetryBtn.addEventListener('click', downloadTelemetry);
  if (clearTelemetryBtn) clearTelemetryBtn.addEventListener('click', () => {
    sessionTelemetry.length = 0;
    logConsole('Session telemetry cleared.', 'text-muted');
  });
  [xObservedSelect, yObservedSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveCalibration(false);
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
    });
  });
  if (saveCalibrationBtn) saveCalibrationBtn.addEventListener('click', () => {
    saveCalibration(true);
    updateCalibrationReadouts();
    updateOperatorAssistReadout();
  });
  if (resetCalibrationBtn) resetCalibrationBtn.addEventListener('click', () => {
    resetCalibration();
    updateCalibrationReadouts();
    updateOperatorAssistReadout();
    logConsole('Calibration notes cleared.', 'text-muted');
  });
  if (refreshControllerConfigBtn) refreshControllerConfigBtn.addEventListener('click', () => syncControllerConfig(true));
  if (centerRigBtn) centerRigBtn.addEventListener('click', async () => {
    const res = await sendCmd('center');
    if (res && res.ok) logConsole('Rig centered for calibration.', 'text-info');
  });
  if (probeXPositiveBtn) probeXPositiveBtn.addEventListener('click', () => sendProbe('x', 1));
  if (probeXNegativeBtn) probeXNegativeBtn.addEventListener('click', () => sendProbe('x', -1));
  if (probeYPositiveBtn) probeYPositiveBtn.addEventListener('click', () => sendProbe('y', 1));
  if (probeYNegativeBtn) probeYNegativeBtn.addEventListener('click', () => sendProbe('y', -1));
  if (urlInput) urlInput.placeholder = 'http://camera-ip:port/stream';
  if (esp32IpInput) esp32IpInput.placeholder = 'http://10.12.22.6';
  if (connectBtn && urlInput) connectBtn.addEventListener('click', () => !setStream(urlInput.value) && alert('Enter a valid camera URL (e.g., http://10.0.0.12/stream)'));
  if (urlInput) urlInput.addEventListener('keyup', (event) => event.key === 'Enter' && connectBtn && connectBtn.click());
  if (esp32ConnectBtn && esp32IpInput) esp32ConnectBtn.addEventListener('click', () => {
    const normalized = normalizeBaseUrl(esp32IpInput.value);
    if (!normalized) return alert('Enter the ESP32 IP (e.g., http://10.12.22.6)');
    esp32IpInput.value = normalized;
    localStorage.setItem(ESP32_STORAGE_KEY, normalized);
    syncLaserState();
    syncControllerConfig(true);
  });
  if (esp32IpInput) esp32IpInput.addEventListener('keyup', (event) => event.key === 'Enter' && esp32ConnectBtn && esp32ConnectBtn.click());
  if (btnUp) btnUp.addEventListener('click', () => sendCmd('servo_down'));
  if (btnDown) btnDown.addEventListener('click', () => sendCmd('servo_up'));
  if (btnLeft) btnLeft.addEventListener('click', () => sendCmd('step_left'));
  if (btnRight) btnRight.addEventListener('click', () => sendCmd('step_right'));
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => sendCmd('stop'));
  if (fireBtn) fireBtn.addEventListener('click', async () => {
    const res = await sendCmd('laser_on');
    if (!(res && res.ok) && !isLaserOn) await sendCmd('laser_toggle');
    isLaserOn = true;
  });
  if (stopLaserBtn) stopLaserBtn.addEventListener('click', async () => {
    const res = await sendCmd('laser_off');
    if (!(res && res.ok) && isLaserOn) await sendCmd('laser_toggle');
    isLaserOn = false;
  });
  if (stopBtn) stopBtn.addEventListener('click', () => sendCmd('stop'));
  if (scanBtn) scanBtn.addEventListener('click', () => alert('Scan mode is not available on the HTTP-only firmware.'));
  if (logoutBtn) logoutBtn.addEventListener('click', async () => {
    try {
      if (window.SkyShieldAuth && window.SkyShieldAuth.logout) await window.SkyShieldAuth.logout();
    } catch (err) {
      console.error('Logout failed', err);
    } finally {
      window.location.href = 'index.html';
    }
  });
  if (feedImg) {
    feedImg.addEventListener('load', () => {
      syncOverlaySize();
      logConsole('Camera stream connected.', 'text-success');
      if (overlayCanvas) overlayCanvas.classList.remove('d-none');
      startDetectionLoop();
    });
    feedImg.addEventListener('error', () => {
      stopDetectionLoop('error');
      if (streamCandidates.length && streamCandidateIndex < streamCandidates.length - 1) {
        streamCandidateIndex += 1;
        const next = streamCandidates[streamCandidateIndex];
        setReadout(statusLabel, `Retrying stream via ${next}`);
        logConsole(`Stream retry: ${next}`, 'text-warning');
        feedImg.src = next;
        return;
      }
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
    syncLaserState();
    syncControllerConfig(false);
  }
  if (savedCamera) {
    if (urlInput) urlInput.value = savedCamera;
    setStream(savedCamera);
  } else {
    setReadout(statusLabel, 'Stream idle');
    if (placeholder) placeholder.classList.remove('d-none');
    if (feedImg) feedImg.classList.add('d-none');
  }
  window.addEventListener('resize', syncOverlaySize);
  if (window.SkyShieldAuth) window.SkyShieldAuth.requireAuth();
  else console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
}

init();
