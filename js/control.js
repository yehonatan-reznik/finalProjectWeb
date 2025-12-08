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
const DEFAULT_BASE_URL = 'http://10.119.108.61';
const FIREBASE_PATHS = {
  aim: 'aim',
  cameraIP: 'cameraIP',
  espIP: 'espIP',
  laserOn: 'laserOn'
};
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

const AIM_VALUES = {
  STOP: 0,
  UP: 1,
  DOWN: 2,
  RIGHT: 3,
  LEFT: 4
};
let dbInstance = null;
let aimRef = null;

function getDb() {
  if (!window.firebase || !firebase.database) {
    console.error('Firebase database SDK not available.');
    return null;
  }
  if (!dbInstance) {
    dbInstance = firebase.database();
  }
  return dbInstance;
}

function initAimChannel() {
  const database = getDb();
  if (!database) return;
  try {
    aimRef = database.ref(FIREBASE_PATHS.aim);
    // Initialize to stop.
    aimRef.set(AIM_VALUES.STOP).catch((err) => console.error('Failed to set initial aim', err));
  } catch (err) {
    console.error('Unable to initialize aim channel', err);
  }
}

function sendAim(value) {
  if (!aimRef) {
    console.error('Aim channel not ready; skipping command.');
    return;
  }
  aimRef.set(value).catch((err) => console.error('Failed to send aim command', err));
}

function sendCmd(cmd) {
  const ip = localStorage.getItem(ESP32_STORAGE_KEY);
  if (!ip) return alert('No ESP32 IP set!');
  fetch(`${ip}/${cmd}`).catch((err) => console.error('Command failed:', err));
}

function setLaserState(isOn) {
  const database = getDb();
  if (!database) return;
  database
    .ref(FIREBASE_PATHS.laserOn)
    .set(isOn ? 1 : 0)
    .catch((err) => console.error('Failed to update laser state', err));
}

function normalizeBaseUrl(raw) {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  return url.replace(/\/+$/, '');
}

function persistCameraIpToFirebase(value) {
  const database = getDb();
  if (!database) return;
  database
    .ref(FIREBASE_PATHS.cameraIP)
    .set(value)
    .catch((err) => console.error('Failed to sync camera IP', err));
}

function persistEsp32IpToFirebase(value) {
  const database = getDb();
  if (!database) return;
  database
    .ref(FIREBASE_PATHS.espIP)
    .set(value)
    .catch((err) => console.error('Failed to sync ESP32 IP', err));
}

function buildStreamCandidates(normalized) {
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

function applyEsp32Ip(rawValue, { syncToFirebase = false } = {}) {
  const normalized = normalizeBaseUrl(rawValue);
  if (!normalized) return '';
  if (esp32IpInput) {
    esp32IpInput.value = normalized;
  }
  localStorage.setItem(ESP32_STORAGE_KEY, normalized);
  if (syncToFirebase) {
    persistEsp32IpToFirebase(normalized);
  }
  return normalized;
}

function setStream(baseUrl, { syncToFirebase = false } = {}) {
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
  if (syncToFirebase) {
    persistCameraIpToFirebase(normalized);
  }
  return normalized;
}

function updateBaseFromInput(rawValue, syncToFirebase = false) {
  const normalized = setStream(rawValue, { syncToFirebase });
  if (normalized) {
    urlInput.value = normalized;
  }
  return normalized;
}

connectBtn.addEventListener('click', () => {
  updateBaseFromInput(urlInput.value, true);
});

urlInput.addEventListener('keyup', (event) => {
  if (event.key === 'Enter') {
    updateBaseFromInput(urlInput.value, true);
  }
});

if (esp32ConnectBtn && esp32IpInput) {
  const saveEsp32FromInput = () => {
    const normalized = applyEsp32Ip(esp32IpInput.value, { syncToFirebase: true });
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

feedImg.addEventListener('error', () => {
  if (streamCandidates.length && streamCandidateIndex < streamCandidates.length - 1) {
    streamCandidateIndex += 1;
    const nextUrl = streamCandidates[streamCandidateIndex];
    statusLabel.textContent = 'Retrying stream via ' + nextUrl;
    feedImg.src = nextUrl;
    return;
  }
  statusLabel.textContent = 'Stream error – check the address/port/path';
  feedImg.classList.add('d-none');
  placeholder.classList.remove('d-none');
});

if (cameraIpModal && modalInput && modalSaveBtn && modalResetBtn) {
  function showModalAlert(message, variant = 'danger') {
    if (!modalAlert) return;
    modalAlert.textContent = message;
    modalAlert.className = `alert alert-${variant}`;
    modalAlert.classList.remove('d-none');
  }

  function hideModalAlert() {
    if (!modalAlert) return;
    modalAlert.classList.add('d-none');
    modalAlert.textContent = '';
  }

  cameraIpModal.addEventListener('show.bs.modal', () => {
    modalInput.value = urlInput.value.trim() || DEFAULT_BASE_URL;
    hideModalAlert();
  });

  modalSaveBtn.addEventListener('click', () => {
    const normalized = updateBaseFromInput(modalInput.value, true);
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
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    updateBaseFromInput(local);
    return; // Prefer local override; do not auto-override from Firebase.
  }

  const database = getDb();
  if (database) {
    database
      .ref(FIREBASE_PATHS.cameraIP)
      .once('value')
      .then((snapshot) => {
        const value = snapshot.val();
        if (value) {
          updateBaseFromInput(value);
        } else if (DEFAULT_BASE_URL) {
          updateBaseFromInput(DEFAULT_BASE_URL);
        }
      })
      .catch((err) => console.error('Failed to load camera IP from Firebase', err));
  } else if (DEFAULT_BASE_URL) {
    updateBaseFromInput(DEFAULT_BASE_URL);
  }
}

function initEsp32Ip() {
  const local = localStorage.getItem(ESP32_STORAGE_KEY);
  if (local && esp32IpInput) {
    esp32IpInput.value = local;
  }

  const database = getDb();
  if (database) {
    database
      .ref(FIREBASE_PATHS.espIP)
      .once('value')
      .then((snapshot) => {
        const value = snapshot.val();
        if (value) {
          applyEsp32Ip(value);
        }
      })
      .catch((err) => console.error('Failed to load ESP32 IP from Firebase', err));

    database.ref(FIREBASE_PATHS.espIP).on('value', (snapshot) => {
      const value = snapshot.val();
      if (value) {
        applyEsp32Ip(value);
      }
    });
  }
}

function ensureLaserFlag() {
  const database = getDb();
  if (!database) return;
  database
    .ref(FIREBASE_PATHS.laserOn)
    .once('value')
    .then((snapshot) => {
      if (snapshot.val() === null) {
        return database.ref(FIREBASE_PATHS.laserOn).set(0);
      }
      return null;
    })
    .catch((err) => console.error('Failed to initialize laser flag', err));
}

function wireAimControls() {
  if (btnUp) btnUp.addEventListener('click', () => {
    sendCmd('servo_up');
    sendAim(AIM_VALUES.UP);
  });
  if (btnDown) btnDown.addEventListener('click', () => {
    sendCmd('servo_down');
    sendAim(AIM_VALUES.DOWN);
  });
  if (btnLeft) btnLeft.addEventListener('click', () => {
    sendCmd('step_left');
    sendAim(AIM_VALUES.LEFT);
  });
  if (btnRight) btnRight.addEventListener('click', () => {
    sendCmd('step_right');
    sendAim(AIM_VALUES.RIGHT);
  });
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => {
    sendCmd('stop');
    sendAim(AIM_VALUES.STOP);
  });
}

function wireActionButtons() {
  if (fireBtn) {
    fireBtn.addEventListener('click', () => {
      sendCmd('laser_on');
      setLaserState(true);
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', () => {
      sendCmd('laser_off');
      setLaserState(false);
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      sendCmd('stop');
      setLaserState(false);
      sendAim(AIM_VALUES.STOP);
    });
  }
}

function wireLogout() {
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
ensureLaserFlag();
initAimChannel();
wireAimControls();
wireActionButtons();
wireLogout();

if (window.SkyShieldAuth) {
  window.SkyShieldAuth.requireAuth();
} else {
  console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
}
