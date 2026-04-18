const $ = (id) => document.getElementById(id);

const feedImg = $('cameraFeed');
const placeholder = $('cameraPlaceholder');
const urlInput = $('cameraUrlInput');
const connectBtn = $('cameraConnectBtn');
const statusLabel = $('cameraStatus');
const proxyToggle = $('proxyToggle');
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
const detectProfileSelect = $('detectProfileSelect');
const strongThresholdInput = $('strongThresholdInput');
const possibleThresholdInput = $('possibleThresholdInput');
const smoothingInput = $('smoothingInput');
const deadZoneInput = $('deadZoneInput');
const downloadTelemetryBtn = $('downloadTelemetryBtn');
const clearTelemetryBtn = $('clearTelemetryBtn');

const STORAGE_KEY = 'skyshield_camera_base_url';
const ESP32_STORAGE_KEY = 'esp32_ip';
const PROXY_ENABLED_STORAGE_KEY = 'skyshield_camera_proxy_enabled';
const DETECTION_SETTINGS_STORAGE_KEY = 'skyshield_detection_settings_v2';
const DEFAULT_PROXY_URL = 'http://127.0.0.1:3001/proxy?url=';
const DETECT_INTERVAL_MS = 180;
const DRAW_THRESHOLD = 0.05;
const LOST_LIMIT = 8;
const MAX_LOG_ROWS = 250;
const MAX_TELEMETRY = 1200;

const PROFILES = {
  strict: { id: 'strict', label: 'Strict aircraft', labels: ['airplane', 'aeroplane'] },
  broad: { id: 'broad', label: 'Broad air-target demo', labels: ['airplane', 'aeroplane', 'bird', 'kite'] },
};

let streamCandidates = [];
let streamCandidateIndex = 0;
let detectTimer = null;
let detectLoopActive = false;
let detectModel = null;
let detectModelReady = false;
let isDetecting = false;
let isLaserOn = false;
let frameCounter = 0;
let lastDetectState = '';
let lastDetectLabel = '';
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

function clamp(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES.strict;
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
  const profile = getProfile(detectProfileSelect ? detectProfileSelect.value : 'strict');
  const strongThreshold = clamp(strongThresholdInput && strongThresholdInput.value, 0.05, 0.99, 0.3);
  const possibleThreshold = clamp(possibleThresholdInput && possibleThresholdInput.value, 0.01, strongThreshold, 0.12);
  const smoothingAlpha = clamp(smoothingInput && smoothingInput.value, 0.05, 1, 0.35);
  const deadZone = clamp(deadZoneInput && deadZoneInput.value, 0, 0.5, 0.08);
  return { profile, strongThreshold, possibleThreshold, smoothingAlpha, deadZone };
}

function saveSettings() {
  const settings = getSettings();
  localStorage.setItem(DETECTION_SETTINGS_STORAGE_KEY, JSON.stringify({
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
  const profile = getProfile(saved && saved.profileId);
  if (detectProfileSelect) detectProfileSelect.value = profile.id;
  if (strongThresholdInput) strongThresholdInput.value = String(clamp(saved && saved.strongThreshold, 0.05, 0.99, 0.3));
  if (possibleThresholdInput) possibleThresholdInput.value = String(clamp(saved && saved.possibleThreshold, 0.01, 0.95, 0.12));
  if (smoothingInput) smoothingInput.value = String(clamp(saved && saved.smoothingAlpha, 0.05, 1, 0.35));
  if (deadZoneInput) deadZoneInput.value = String(clamp(saved && saved.deadZone, 0, 0.5, 0.08));
  setProfileStatus(profile.id);
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
  });
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
}

function pushTelemetry(entry) {
  sessionTelemetry.push(entry);
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

async function ensureDetectModel() {
  if (detectModelReady && detectModel) return detectModel;
  if (!window.cocoSsd) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('COCO-SSD model missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
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

async function runDetection() {
  if (isDetecting || !feedImg || !feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  const startedAt = performance.now();
  try {
    const settings = getSettings();
    setProfileStatus(settings.profile.id);
    const model = await ensureDetectModel();
    if (!model) return;
    const labels = new Set(settings.profile.labels);
    const predictions = await model.detect(feedImg);
    const detections = predictions.filter((p) => (p.score || 0) >= DRAW_THRESHOLD).map((p) => ({
      ...p,
      metrics: computeMetrics(p),
      isCandidate: labels.has(p.class) && (p.score || 0) >= settings.possibleThreshold,
      isStrong: labels.has(p.class) && (p.score || 0) >= settings.strongThreshold,
    }));
    const selected = chooseCandidate(detections.filter((det) => det.isCandidate && det.metrics));
    const loopMs = performance.now() - startedAt;
    if (!selected) {
      trackingState.missedFrames += 1;
      drawScene(detections, null);
      if (trackingState.missedFrames >= LOST_LIMIT) clearTargetTelemetry();
      setReadout(loopTimeVal, loopMs.toFixed(1));
      setDetectStatus(predictions.length ? `Detect: clear (${predictions.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b).class})` : 'Detect: clear', 'bg-success');
      setSafetyState('ok', 'Safe');
      setMode('Observe');
      if (lastDetectState !== 'clear') logConsole('No configured air target detected.', 'text-success');
      lastDetectState = 'clear';
      lastDetectLabel = '';
      pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'clear', profile: settings.profile.id, loopMs: Number(loopMs.toFixed(2)), predictionCount: predictions.length });
      return;
    }
    updateSelectedTarget(selected, settings, loopMs);
    drawScene(detections, selected);
    const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`;
    const deltaText = ` dx=${trackingState.filteredDeltaX.toFixed(0)} dy=${trackingState.filteredDeltaY.toFixed(0)}`;
    if (selected.isStrong) {
      setDetectStatus('Detect: target', 'bg-danger');
      setSafetyState('danger', 'Air target detected');
      if (lastDetectState !== 'target' || lastDetectLabel !== labelText) logConsole(`Target detected: ${labelText}${deltaText}`, 'text-danger');
      lastDetectState = 'target';
    } else {
      setDetectStatus('Detect: possible', 'bg-warning text-dark');
      setSafetyState('warn', 'Possible air target');
      if (lastDetectState !== 'possible' || lastDetectLabel !== labelText) logConsole(`Possible target: ${labelText}${deltaText}`, 'text-warning');
      lastDetectState = 'possible';
    }
    lastDetectLabel = labelText;
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: selected.isStrong ? 'target' : 'possible', profile: settings.profile.id, loopMs: Number(loopMs.toFixed(2)), label: selected.class, score: Number((selected.score || 0).toFixed(4)), rawCenter: { x: Number(trackingState.rawCenterX.toFixed(2)), y: Number(trackingState.rawCenterY.toFixed(2)) }, filteredCenter: { x: Number(trackingState.filteredCenterX.toFixed(2)), y: Number(trackingState.filteredCenterY.toFixed(2)) }, filteredDelta: { x: Number(trackingState.filteredDeltaX.toFixed(2)), y: Number(trackingState.filteredDeltaY.toFixed(2)), normX: Number(trackingState.filteredNormX.toFixed(4)), normY: Number(trackingState.filteredNormY.toFixed(4)) }, sim: { pan: trackingState.simPan, tilt: trackingState.simTilt, panLabel: trackingState.simPanLabel, tiltLabel: trackingState.simTiltLabel } });
  } catch (err) {
    console.error('Detection failed', err);
    const text = err && err.message ? err.message : 'check CORS / proxy / stream';
    const corsBlocked = /tainted canvases|cross-origin|cross origin/i.test(text);
    setDetectStatus(corsBlocked ? 'Detect: blocked (CORS / proxy)' : 'Detect: error', corsBlocked ? 'bg-warning text-dark' : 'bg-danger');
    setSafetyState('warn', corsBlocked ? 'Detection blocked' : 'Scanning');
    clearTargetTelemetry();
    if (lastDetectState !== 'error' || lastDetectLabel !== text) logConsole(`Detection error: ${text}`, 'text-warning');
    lastDetectState = 'error';
    lastDetectLabel = text;
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'error', error: text });
  } finally {
    isDetecting = false;
  }
}

function normalizeBaseUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

function isProxyEnabled() {
  return proxyToggle ? proxyToggle.checked : localStorage.getItem(PROXY_ENABLED_STORAGE_KEY) === '1';
}

function buildStreamRequestUrl(url) {
  return isProxyEnabled() ? DEFAULT_PROXY_URL + encodeURIComponent(url) : url;
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
  streamCandidates = buildStreamCandidates(normalized).map((directUrl) => ({ directUrl, requestUrl: buildStreamRequestUrl(directUrl) }));
  streamCandidateIndex = 0;
  const first = streamCandidates[0];
  if (!first) return '';
  feedImg.src = first.requestUrl;
  feedImg.classList.remove('d-none');
  if (placeholder) placeholder.classList.add('d-none');
  setReadout(statusLabel, `Streaming from ${first.directUrl}${isProxyEnabled() ? ' (via proxy)' : ''}`);
  setDetectStatus('Detect: waiting', 'bg-secondary');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole(`Attempting camera stream: ${first.directUrl}`, 'text-muted');
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
    scheduleNextDetection(Math.max(0, DETECT_INTERVAL_MS - (performance.now() - startedAt)));
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

async function syncLaserState() {
  const res = await sendCmd('status');
  if (!res || !res.ok) return;
  const text = await res.text();
  const status = parseControllerStatusText(text);
  if (!status) return;
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
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
  if (proxyToggle) {
    proxyToggle.checked = localStorage.getItem(PROXY_ENABLED_STORAGE_KEY) === '1';
    proxyToggle.addEventListener('change', () => {
      localStorage.setItem(PROXY_ENABLED_STORAGE_KEY, proxyToggle.checked ? '1' : '0');
      if (urlInput && urlInput.value.trim()) setStream(urlInput.value.trim());
    });
  }
  [detectProfileSelect, strongThresholdInput, possibleThresholdInput, smoothingInput, deadZoneInput].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      const s = getSettings();
      logConsole(`Detection settings updated: ${s.profile.label}, strong=${s.strongThreshold.toFixed(2)}, possible=${s.possibleThreshold.toFixed(2)}, alpha=${s.smoothingAlpha.toFixed(2)}, deadZone=${s.deadZone.toFixed(2)}`, 'text-info');
    });
  });
  if (downloadTelemetryBtn) downloadTelemetryBtn.addEventListener('click', downloadTelemetry);
  if (clearTelemetryBtn) clearTelemetryBtn.addEventListener('click', () => {
    sessionTelemetry.length = 0;
    logConsole('Session telemetry cleared.', 'text-muted');
  });
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
        setReadout(statusLabel, `Retrying stream via ${next.directUrl}${isProxyEnabled() ? ' (via proxy)' : ''}`);
        logConsole(`Stream retry: ${next.directUrl}`, 'text-warning');
        feedImg.src = next.requestUrl;
        return;
      }
      setReadout(statusLabel, isProxyEnabled() ? 'Stream error - check camera address or proxy status' : 'Stream error - check address / CORS / path');
      if (!isProxyEnabled()) logConsole('Tip: if the stream opens in a tab but inference fails, confirm camera CORS headers or use proxy mode.', 'text-warning');
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
