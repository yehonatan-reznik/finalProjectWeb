// === DOM bindings for camera UI ===
const feedImg = document.getElementById('cameraFeed');
const placeholder = document.getElementById('cameraPlaceholder');
const urlInput = document.getElementById('cameraUrlInput');
const connectBtn = document.getElementById('cameraConnectBtn');
const statusLabel = document.getElementById('cameraStatus');
const cameraIpModal = document.getElementById('cameraIpModal');
const modalInput = document.getElementById('modalCameraBase');
const modalAlert = document.getElementById('cameraIpModalAlert');
const modalSaveBtn = document.getElementById('cameraIpSaveBtn');
const modalResetBtn = document.getElementById('cameraIpResetBtn');
// === DOM bindings for ESP32 control ===
const esp32IpInput = document.getElementById('esp32IpInput');
const esp32ConnectBtn = document.getElementById('esp32ConnectBtn');
// === Local storage keys and defaults ===
const STORAGE_KEY = 'skyshield_camera_base_url';
const ESP32_STORAGE_KEY = 'esp32_ip';
const DEFAULT_BASE_URL = '';
// === DOM bindings for control buttons ===
const btnUp = document.getElementById('btnUp');
const btnDown = document.getElementById('btnDown');
const btnLeft = document.getElementById('btnLeft');
const btnRight = document.getElementById('btnRight');
const btnStopCursor = document.getElementById('btnStopCursor');
const fireBtn = document.getElementById('fireBtn');
const stopLaserBtn = document.getElementById('stopLaserBtn');
const scanBtn = document.getElementById('scanBtn');
const stopBtn = document.getElementById('stopBtn');
const logoutBtn = document.getElementById('logoutBtn');
// === DOM bindings for detection overlay + status ===
const overlayCanvas = document.getElementById('cameraOverlay');
const overlayCtx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
const detectStatus = document.getElementById('detectStatus');
const consolePanel = document.getElementById('console');
const safetyDot = document.getElementById('safetyDot');
const safetyVal = document.getElementById('safetyVal');
// === Runtime state ===
let streamCandidates = [];
let streamCandidateIndex = 0;
let isLaserOn = false;
let detectTimer = null;
let detectModel = null;
let detectModelReady = false;
let isDetecting = false;
let lastDroneState = null;
let lastDroneLabel = '';

// === Detection constants ===
const DRONE_LABELS = ['airplane', 'bird', 'kite'];
const DETECT_INTERVAL_MS = 700;
const DETECT_SCORE_THRESHOLD = 0.45;

// === Send commands to ESP32 controller ===
function sendCmd(cmd) {
  // Send a control command directly to the ESP32 over HTTP.
  const ip = localStorage.getItem(ESP32_STORAGE_KEY);
  if (!ip) {
    alert('Set the ESP32 address first.');
    return;
  }
  const target = `${ip}/${cmd}`;
  fetch(target)
    .then((res) => {
      if (!res.ok) {
        console.warn(`Command ${cmd} responded with status ${res.status}`);
      }
    })
    .catch((err) => console.error(`Command ${cmd} failed:`, err));
}

// === Append a message to the console panel ===
function logConsole(message, variant) {
  if (!consolePanel) return;
  const entry = document.createElement('div');
  if (variant) {
    entry.className = variant;
  }
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${message}`;
  consolePanel.appendChild(entry);
  consolePanel.scrollTop = consolePanel.scrollHeight;
}

// === Update the detection badge with color/status ===
function setDetectStatus(text, variant) {
  if (!detectStatus) return;
  detectStatus.textContent = text;
  detectStatus.className = 'badge';
  const classes = (variant || 'bg-secondary').split(' ');
  classes.forEach((cls) => detectStatus.classList.add(cls));
}

// === Update the safety indicator (dot + text) ===
function setSafetyState(state, text) {
  if (!safetyDot || !safetyVal) return;
  safetyDot.classList.remove('status-ok', 'status-warn', 'status-danger');
  if (state === 'danger') {
    safetyDot.classList.add('status-danger');
    safetyVal.textContent = text || 'Drone detected';
  } else if (state === 'warn') {
    safetyDot.classList.add('status-warn');
    safetyVal.textContent = text || 'Scanning';
  } else {
    safetyDot.classList.add('status-ok');
    safetyVal.textContent = text || 'Safe';
  }
}

// === Keep overlay canvas sized to the camera container ===
function syncOverlaySize() {
  if (!overlayCanvas || !feedImg) return;
  const container = feedImg.parentElement;
  if (!container) return;
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;
  overlayCanvas.width = Math.round(width);
  overlayCanvas.height = Math.round(height);
}

// === Clear all drawings from the overlay canvas ===
function clearOverlay() {
  if (!overlayCtx || !overlayCanvas) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// === Compute how the image fits inside the container ===
function getImageFit() {
  if (!feedImg) return null;
  const container = feedImg.parentElement;
  if (!container) return null;
  const naturalWidth = feedImg.naturalWidth;
  const naturalHeight = feedImg.naturalHeight;
  if (!naturalWidth || !naturalHeight) return null;
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  if (!containerWidth || !containerHeight) return null;
  const objectFit = window.getComputedStyle(feedImg).objectFit || 'contain';
  const scale =
    objectFit === 'cover'
      ? Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight)
      : Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
  const displayWidth = naturalWidth * scale;
  const displayHeight = naturalHeight * scale;
  const offsetX = (containerWidth - displayWidth) / 2;
  const offsetY = (containerHeight - displayHeight) / 2;
  return { scale, offsetX, offsetY };
}

// === Draw bounding boxes and labels for detections ===
function drawDetections(detections) {
  if (!overlayCtx || !overlayCanvas) return;
  syncOverlaySize();
  clearOverlay();
  if (!detections.length) return;
  const fit = getImageFit();
  if (!fit) return;
  const { scale, offsetX, offsetY } = fit;
  overlayCtx.lineWidth = 2;
  overlayCtx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  overlayCtx.textBaseline = 'top';
  detections.forEach((det) => {
    const score = det.score || 0;
    const [rawX, rawY, rawW, rawH] = det.bbox;
    const x = rawX * scale + offsetX;
    const y = rawY * scale + offsetY;
    const w = rawW * scale;
    const h = rawH * scale;
    if (w <= 0 || h <= 0) return;
    overlayCtx.strokeStyle = '#ff4d4d';
    overlayCtx.strokeRect(x, y, w, h);
    const label = `${det.class} ${(score * 100).toFixed(1)}%`;
    const textWidth = overlayCtx.measureText(label).width + 8;
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    overlayCtx.fillRect(x, Math.max(0, y - 16), textWidth, 16);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(label, x + 4, Math.max(0, y - 15));
  });
}

// === Load the COCO-SSD model once and reuse it ===
async function ensureDetectModel() {
  if (detectModelReady && detectModel) {
    return detectModel;
  }
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

// === Start periodic detection loop ===
function startDetectionLoop() {
  if (detectTimer || !feedImg) return;
  setDetectStatus('Detect: starting', 'bg-warning');
  setSafetyState('warn', 'Scanning');
  if (overlayCanvas) {
    overlayCanvas.classList.remove('d-none');
  }
  detectTimer = setInterval(() => {
    runDetection();
  }, DETECT_INTERVAL_MS);
}

// === Stop detection loop and reset UI ===
function stopDetectionLoop(reason) {
  if (detectTimer) {
    clearInterval(detectTimer);
    detectTimer = null;
  }
  isDetecting = false;
  clearOverlay();
  if (overlayCanvas) {
    overlayCanvas.classList.add('d-none');
  }
  lastDroneState = null;
  lastDroneLabel = '';
  if (reason === 'idle') {
    setDetectStatus('Detect idle', 'bg-secondary');
    setSafetyState('ok', 'Safe');
  } else if (reason === 'error') {
    setDetectStatus('Detect: stream error', 'bg-warning');
  }
}

// === Run a single detection pass ===
async function runDetection() {
  if (isDetecting || !feedImg) return;
  if (!feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  try {
    const model = await ensureDetectModel();
    if (!model) return;
    const predictions = await model.detect(feedImg);
    const droneDetections = predictions.filter(
      (p) =>
        DRONE_LABELS.includes(p.class) &&
        (p.score || 0) >= DETECT_SCORE_THRESHOLD
    );
    drawDetections(droneDetections);
    if (droneDetections.length) {
      const best = droneDetections.reduce((a, b) =>
        (a.score || 0) > (b.score || 0) ? a : b
      );
      const scoreText = ((best.score || 0) * 100).toFixed(1);
      const labelText = `${best.class} ${scoreText}%`;
      setDetectStatus('Detect: drone', 'bg-danger');
      setSafetyState('danger', 'Drone detected');
      if (lastDroneState !== true || lastDroneLabel !== labelText) {
        logConsole(`Drone-like detection: ${labelText}`, 'text-danger');
      }
      lastDroneState = true;
      lastDroneLabel = labelText;
    } else {
      setDetectStatus('Detect: clear', 'bg-success');
      setSafetyState('ok', 'Safe');
      if (lastDroneState !== false) {
        logConsole('No drone detected.', 'text-success');
      }
      lastDroneState = false;
      lastDroneLabel = '';
    }
  } catch (err) {
    console.error('Detection failed', err);
    setDetectStatus('Detect: error', 'bg-danger');
    setSafetyState('warn', 'Scanning');
    if (lastDroneState !== null) {
      logConsole('Detection error (check CORS/stream).', 'text-warning');
    }
    lastDroneState = null;
    lastDroneLabel = '';
  } finally {
    isDetecting = false;
  }
}

// === Normalize a user-provided URL ===
function normalizeBaseUrl(raw) {
  // Clean and standardize a user-provided base URL.
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  return url.replace(/\/+$/, '');
}

// === Build a list of possible stream endpoints ===
function buildStreamCandidates(normalized) {
  // Generate possible stream URLs based on a base address.
  try {
    const u = new URL(normalized);
    const hasCustomPath = u.pathname && u.pathname !== '/';
    const candidates = [];
    if (hasCustomPath) {
      candidates.push(normalized);
    } else {
      const base = normalized;
      candidates.push(base + '/stream'); // common default
      if (!u.port) {
        candidates.push(base + ':81/stream'); // typical AI Thinker port
      }
      candidates.push(base); // root fallback
    }
    return [...new Set(candidates)];
  } catch (err) {
    console.error('Invalid URL for stream candidates', err);
    return [];
  }
}

// === Save and apply ESP32 IP address ===
function applyEsp32Ip(rawValue) {
  // Normalize and persist the ESP32 IP locally.
  const normalized = normalizeBaseUrl(rawValue);
  if (!normalized) return '';
  if (esp32IpInput) {
    esp32IpInput.value = normalized;
  }
  localStorage.setItem(ESP32_STORAGE_KEY, normalized);
  return normalized;
}

// === Configure camera stream and update UI ===
function setStream(baseUrl) {
  // Configure the camera stream URL and update UI/storage.
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    feedImg.src = '';
    feedImg.classList.add('d-none');
    placeholder.classList.remove('d-none');
    statusLabel.textContent = 'Stream idle';
    localStorage.removeItem(STORAGE_KEY);
    stopDetectionLoop('idle');
    return '';
  }

  streamCandidates = buildStreamCandidates(normalized);
  streamCandidateIndex = 0;
  const streamUrl = streamCandidates[streamCandidateIndex] || '';

  feedImg.src = streamUrl;
  feedImg.classList.remove('d-none');
  placeholder.classList.add('d-none');
  statusLabel.textContent = 'Streaming from ' + streamUrl;
  setDetectStatus('Detect: waiting', 'bg-secondary');
  setSafetyState('warn', 'Scanning');
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

// === Apply base URL input to stream ===
function updateBaseFromInput(rawValue) {
  // Apply a camera URL from user input.
  const normalized = setStream(rawValue);
  if (normalized && urlInput) {
    urlInput.value = normalized;
  }
  return normalized;
}

// === Wire camera URL input + button ===
if (connectBtn && urlInput) {
  const saveCameraUrl = () => {
    const normalized = updateBaseFromInput(urlInput.value);
    if (!normalized) {
      alert('Enter a valid camera URL (e.g., http://10.0.0.12:81/stream)');
    }
  };

  connectBtn.addEventListener('click', saveCameraUrl);

  urlInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      saveCameraUrl();
    }
  });
}

// === Wire ESP32 IP input + button ===
if (esp32ConnectBtn && esp32IpInput) {
  const saveEsp32FromInput = () => {
    const normalized = applyEsp32Ip(esp32IpInput.value);
    if (!normalized) {
      alert('Enter the ESP32 IP (e.g., http://10.12.22.6)');
    }
  };

  esp32ConnectBtn.addEventListener('click', saveEsp32FromInput);
  esp32IpInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      saveEsp32FromInput();
    }
  });
}

// === Handle camera image load/error ===
if (feedImg) {
  feedImg.addEventListener('load', () => {
    syncOverlaySize();
    if (overlayCanvas) {
      overlayCanvas.classList.remove('d-none');
    }
    startDetectionLoop();
  });

  feedImg.addEventListener('error', () => {
    stopDetectionLoop('error');
    if (streamCandidates.length && streamCandidateIndex < streamCandidates.length - 1) {
      streamCandidateIndex += 1;
      const nextUrl = streamCandidates[streamCandidateIndex];
      statusLabel.textContent = 'Retrying stream via ' + nextUrl;
      feedImg.src = nextUrl;
      return;
    }
    statusLabel.textContent = 'Stream error - check the address/port/path';
    feedImg.classList.add('d-none');
    placeholder.classList.remove('d-none');
  });
}

// === Optional camera IP modal handlers ===
if (cameraIpModal && modalInput && modalSaveBtn && modalResetBtn) {
  function showModalAlert(message, variant = 'danger') {
    // Display a feedback message inside the camera IP modal.
    if (!modalAlert) return;
    modalAlert.textContent = message;
    modalAlert.className = `alert alert-${variant}`;
    modalAlert.classList.remove('d-none');
  }

  function hideModalAlert() {
    // Hide any visible alert inside the camera IP modal.
    if (!modalAlert) return;
    modalAlert.classList.add('d-none');
    modalAlert.textContent = '';
  }

  cameraIpModal.addEventListener('show.bs.modal', () => {
    modalInput.value = urlInput.value.trim() || DEFAULT_BASE_URL;
    hideModalAlert();
  });

  modalSaveBtn.addEventListener('click', () => {
    const normalized = updateBaseFromInput(modalInput.value);
    if (!normalized) {
      showModalAlert('Enter a valid IP or URL such as http://10.119.108.61');
      return;
    }
    hideModalAlert();
    if (window.bootstrap && bootstrap.Modal) {
      const modalInstance = bootstrap.Modal.getInstance(cameraIpModal);
      if (modalInstance) {
        modalInstance.hide();
      }
    }
  });

  modalResetBtn.addEventListener('click', () => {
    modalInput.value = DEFAULT_BASE_URL;
    hideModalAlert();
  });
}

// === Initialize camera base URL from storage ===
function initCameraBase() {
  // Load camera base URL from local storage or defaults.
  if (urlInput) {
    urlInput.placeholder = 'http://camera-ip:port/stream';
    urlInput.readOnly = false;
  }

  const saved = localStorage.getItem(STORAGE_KEY) || DEFAULT_BASE_URL;
  if (saved) {
    updateBaseFromInput(saved);
  } else {
    if (statusLabel) statusLabel.textContent = 'Stream idle';
    if (placeholder) placeholder.classList.remove('d-none');
    if (feedImg) feedImg.classList.add('d-none');
  }
}

// === Initialize ESP32 IP from storage ===
function initEsp32Ip() {
  // Load ESP32 IP from local storage.
  if (esp32IpInput) {
    esp32IpInput.placeholder = 'http://10.12.22.6';
  }
  const local = localStorage.getItem(ESP32_STORAGE_KEY);
  if (local && esp32IpInput) {
    esp32IpInput.value = local;
  }
}

// === Wire directional aim controls ===
function wireAimControls() {
  // Attach click handlers for directional aim buttons.
  if (btnUp) btnUp.addEventListener('click', () => {
    sendCmd('servo_up');
  });
  if (btnDown) btnDown.addEventListener('click', () => {
    sendCmd('servo_down');
  });
  if (btnLeft) btnLeft.addEventListener('click', () => {
    sendCmd('step_left');
  });
  if (btnRight) btnRight.addEventListener('click', () => {
    sendCmd('step_right');
  });
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => {
    sendCmd('stop');
  });
}

// === Wire action buttons (laser/stop/scan) ===
function wireActionButtons() {
  // Attach click handlers for fire/stop/laser buttons.
  const ensureLaserState = (targetOn) => {
    if (isLaserOn === targetOn) return;
    sendCmd('laser_toggle');
    isLaserOn = targetOn;
  };

  if (fireBtn) {
    fireBtn.addEventListener('click', () => {
      ensureLaserState(true);
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', () => {
      ensureLaserState(false);
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      sendCmd('stop');
    });
  }
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      alert('Scan mode is not available on the HTTP-only firmware.');
    });
  }
}

// === Wire logout button ===
function wireLogout() {
  // Attach logout behavior and redirect to login page.
  if (!logoutBtn) return;
  logoutBtn.addEventListener('click', async () => {
    try {
      if (window.SkyShieldAuth && window.SkyShieldAuth.logout) {
        await window.SkyShieldAuth.logout();
      }
    } catch (err) {
      console.error('Logout failed', err);
    } finally {
      window.location.href = 'index.html';
    }
  });
}

// === Run startup initialization ===
initCameraBase();
initEsp32Ip();
wireAimControls();
wireActionButtons();
wireLogout();
// === Keep overlay synced on resize ===
window.addEventListener('resize', () => {
  syncOverlaySize();
});

// === Protect page by requiring authentication ===
if (window.SkyShieldAuth) {
  window.SkyShieldAuth.requireAuth();
} else {
  console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
}
