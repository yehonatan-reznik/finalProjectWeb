const $ = (id) => document.getElementById(id);

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
function clamp(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  // Empty or invalid values fall back to a safe default so the UI cannot poison later calculations.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Event console keeps a capped rolling timeline of operator and detection messages.
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
function setFirebaseStatus(text) {
  if (firebaseSyncVal) firebaseSyncVal.textContent = text || 'Idle';
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

// The detection script owns the profile catalog; this helper only renders its label in the HUD.
function setProfileStatus(profileId) {
  const profile = getProfile(profileId);
  if (profileVal) profileVal.textContent = profile.label;
}

// Firebase helpers normalize nullable values and safely walk nested RTDB snapshots.
function formatFirebaseValue(value, fallback) {
  return value ? String(value) : (fallback || 'n/a');
}

function readFirebaseNumber(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getFirebaseSnapshotValue(data, path, fallback) {
  const parts = Array.isArray(path) ? path : String(path || '').split('.');
  let current = data;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (!key) continue;
    if (!current || typeof current !== 'object' || !(key in current)) return fallback;
    current = current[key];
  }
  return typeof current === 'undefined' || current === null ? fallback : current;
}

function normalizeFirebaseUrl(raw) {
  const normalized = normalizeBaseUrl(raw);
  return normalized || '';
}

// Every Firebase snapshot can update the HUD and optionally auto-fill camera/controller URLs.
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
  if (firebaseState.syncStarted) return;
  firebaseState.syncStarted = true;
  if (!(window.SkyShieldAuth && typeof window.SkyShieldAuth.getDatabase === 'function')) {
    setFirebaseStatus('SDK unavailable');
    return;
  }
  const db = window.SkyShieldAuth.getDatabase();
  if (!db) {
    setFirebaseStatus('Database unavailable');
    return;
  }
  try {
    firebaseState.rootRef = db.ref('/');
    firebaseState.rootRef.on('value', (snapshot) => {
      applyFirebaseSnapshot(snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null);
    }, (error) => {
      console.error('Firebase RTDB listener failed.', error);
      setFirebaseStatus('Read failed');
      if (error && error.message) logConsole(`Firebase read failed: ${error.message}`, 'text-warning');
    });
    setFirebaseStatus('Listening');
  } catch (err) {
    console.error('Failed to start Firebase RTDB sync.', err);
    setFirebaseStatus('Init failed');
  }
}

// Calibration helpers translate physical rig behavior into user-friendly manual hints.
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
  // Convert raw axis direction plus firmware polarity into the practical movement caused by each HTTP command.
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

// This helper gives a neutral "frame position" description without turning it into automatic actuation.
function describeFramePosition(normX, normY, deadZone) {
  const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : '';
  const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : '';
  if (!horizontal && !vertical) return 'Centered';
  if (vertical && horizontal) return `${vertical}-${horizontal} of center`;
  return `${vertical || horizontal} of center`;
}

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
function updateOperatorAssistReadout() {
  const derived = deriveCalibration();
  const settings = getSettings();
  if (!trackingState.hasTarget) {
    setReadout(assistMoveVal, 'No target');
    setReadout(assistFrameVal, 'No target');
    setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');
    setReadout(assistCenterVal, 'Not centered');
    return;
  }

  const panAssist = parseSimLabel(trackingState.simPanLabel);
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel);
  const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold';
  const framePosition = describeFramePosition(trackingState.filteredNormX, trackingState.filteredNormY, settings.deadZone);

  if (centered) {
    setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');
    setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);
    setReadout(assistButtonVal, 'Hold position');
    setReadout(assistCenterVal, 'Centered');
    return;
  }

  const moveParts = [];
  if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);
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
function setReadout(el, text) {
  if (el) el.textContent = text;
}

function formatPoint(x, y) {
  return `${x.toFixed(0)}, ${y.toFixed(0)}`;
}

function formatNorm(x, y) {
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

// Camera stream URLs are normalized once so the retry logic can try `/stream` and the raw origin consistently.
function normalizeBaseUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  // Strip trailing slashes so later endpoint joins stay stable.
  return url.replace(/\/+$/, '');
}

function buildStreamCandidates(normalized) {
  try {
    const u = new URL(normalized);
    // Try the user-supplied path first, then common stream fallbacks.
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

// Stream setup only manages image source and detection loop lifecycle; the detector itself lives in control-detection.js.
function setStream(baseUrl) {
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

// Controller communication stays direct over local HTTP so movement remains local and low-latency.
function sendCmd(cmd) {
  const ip = localStorage.getItem(ESP32_STORAGE_KEY);
  if (!ip) {
    alert('Set the ESP32 address first.');
    return Promise.resolve(null);
  }
  // Local direct HTTP keeps manual control independent from Firebase round trips.
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

function syncControllerConfig(logSuccess) {
  return sendCmd('config').then(async (res) => {
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
  });
}

async function syncLaserState() {
  const res = await sendCmd('status');
  if (!res || !res.ok) return;
  const text = await res.text();
  const status = parseControllerStatusText(text);
  if (!status) return;
  // This flag lets the UI decide when the old toggle endpoint still needs to be used as a fallback.
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
}

async function sendProbe(axis, sign) {
  const delta = sign > 0 ? CALIBRATION_PROBE_DELTA_DEG : -CALIBRATION_PROBE_DELTA_DEG;
  const query = axis === 'x' ? `nudge?dx=${delta}` : `nudge?dy=${delta}`;
  const res = await sendCmd(query);
  if (!res || !res.ok) return;
  logConsole(`Calibration probe sent: ${axis.toUpperCase()}${sign > 0 ? '+' : '-'} (${delta > 0 ? '+' : ''}${delta} deg)`, 'text-info');
}

// Telemetry is recorded by the detection loop and downloaded here as a JSON file for later review.
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

// init wires together the UI once both control.js and control-detection.js have loaded.
function init() {
  // Reset HUD state first so the page always starts from a known baseline.
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
      sessionTelemetry.length = 0;
      logConsole('Session telemetry cleared.', 'text-muted');
    });
  }

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
      const res = await sendCmd('center');
      if (res && res.ok) logConsole('Rig centered for calibration.', 'text-info');
    });
  }
  if (probeXPositiveBtn) probeXPositiveBtn.addEventListener('click', () => sendProbe('x', 1));
  if (probeXNegativeBtn) probeXNegativeBtn.addEventListener('click', () => sendProbe('x', -1));
  if (probeYPositiveBtn) probeYPositiveBtn.addEventListener('click', () => sendProbe('y', 1));
  if (probeYNegativeBtn) probeYNegativeBtn.addEventListener('click', () => sendProbe('y', -1));

  if (urlInput) urlInput.placeholder = 'http://camera-ip:port/stream';
  if (esp32IpInput) esp32IpInput.placeholder = 'http://10.12.22.6';

  if (connectBtn && urlInput) {
    connectBtn.addEventListener('click', () => !setStream(urlInput.value) && alert('Enter a valid camera URL (e.g., http://10.0.0.12/stream)'));
  }
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
  if (esp32IpInput) esp32IpInput.addEventListener('keyup', (event) => event.key === 'Enter' && esp32ConnectBtn && esp32ConnectBtn.click());

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
      syncOverlaySize();
      logConsole('Camera stream connected.', 'text-success');
      if (overlayCanvas) overlayCanvas.classList.remove('d-none');
      // Only start inference after the browser confirms that the image element has real pixels to read.
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
