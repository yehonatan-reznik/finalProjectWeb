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
const esp32IpInput = document.getElementById('esp32IpInput');
const esp32ConnectBtn = document.getElementById('esp32ConnectBtn');
const STORAGE_KEY = 'skyshield_camera_base_url';
const ESP32_STORAGE_KEY = 'esp32_ip';
const DEFAULT_BASE_URL = '';
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
let streamCandidates = [];
let streamCandidateIndex = 0;

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

function normalizeBaseUrl(raw) {
  // Clean and standardize a user-provided base URL.
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  return url.replace(/\/+$/, '');
}

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

function setStream(baseUrl) {
  // Configure the camera stream URL and update UI/storage.
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    feedImg.src = '';
    feedImg.classList.add('d-none');
    placeholder.classList.remove('d-none');
    statusLabel.textContent = 'Stream idle';
    localStorage.removeItem(STORAGE_KEY);
    return '';
  }

  streamCandidates = buildStreamCandidates(normalized);
  streamCandidateIndex = 0;
  const streamUrl = streamCandidates[streamCandidateIndex] || '';

  feedImg.src = streamUrl;
  feedImg.classList.remove('d-none');
  placeholder.classList.add('d-none');
  statusLabel.textContent = 'Streaming from ' + streamUrl;
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

function updateBaseFromInput(rawValue) {
  // Apply a camera URL from user input.
  const normalized = setStream(rawValue);
  if (normalized && urlInput) {
    urlInput.value = normalized;
  }
  return normalized;
}

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

if (feedImg) {
  feedImg.addEventListener('error', () => {
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

function wireActionButtons() {
  // Attach click handlers for fire/stop/laser buttons.
  if (fireBtn) {
    fireBtn.addEventListener('click', () => {
      sendCmd('laser_on');
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', () => {
      sendCmd('laser_off');
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

initCameraBase();
initEsp32Ip();
wireAimControls();
wireActionButtons();
wireLogout();

if (window.SkyShieldAuth) {
  window.SkyShieldAuth.requireAuth();
} else {
  console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
}
