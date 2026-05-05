// FILE ROLE: 30-transport.js
// What this file does:
// - Starts and manages the camera stream URL used by the browser.
// - Sends HTTP commands to the ESP32 controller.
// - Reads controller status, syncs controller-related values, and downloads telemetry.
// Why this file exists:
// - This is the communication layer of the page.
// - It is the file that actually talks to outside devices and stream endpoints.
// Section: camera stream and controller transport.
// Lightweight formatting helpers are shared with the detection overlay script.
/**
 * @param {HTMLElement|null} el - DOM node whose text should be replaced.
 * @param {string} text - Text to show in that node.
 */
// EXAM: safe text write helper.
function setReadout(el, text) {
  // Most status spans are optional, so guard the DOM write.
  if (el) el.textContent = text;
}

/**
 * @param {number} x - X coordinate in pixels.
 * @param {number} y - Y coordinate in pixels.
 * @returns {string} Rounded pixel pair.
 */
// EXAM: point formatting.
function formatPoint(x, y) {
  // Show pixel positions as rounded whole numbers.
  return `${x.toFixed(0)}, ${y.toFixed(0)}`;
}

/**
 * @param {number} x - Normalized horizontal value.
 * @param {number} y - Normalized vertical value.
 * @returns {string} Two-decimal normalized pair.
 */
// EXAM: normalized coordinate formatting.
function formatNorm(x, y) {
  // Show normalized offsets with two decimals for readability.
  return `${x.toFixed(2)}, ${y.toFixed(2)}`;
}

// Camera stream URLs are normalized once so the retry logic can try `/stream` and the raw origin consistently.
/**
 * @param {string} raw - User-typed or Firebase-provided URL.
 * @returns {string} Normalized base URL.
 */
// EXAM: controller/camera base URL normalization.
function normalizeBaseUrl(raw) {
  let url = (raw || '').trim(); // Trimmed operator-entered URL before protocol normalization.
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  // Strip trailing slashes so later endpoint joins stay stable.
  return url.replace(/\/+$/, '');
}

/**
 * @param {string} normalized - Already-normalized camera base URL.
 * @returns {string[]} Ordered list of stream URL candidates to try.
 */
// EXAM: stream fallback candidate list.
function buildStreamCandidates(normalized) {
  try {
    // Parse the URL once so we can inspect origin and path safely.
    const u = new URL(normalized); // Parsed URL object used to safely inspect origin and pathname.
    // Try the user-supplied path first, then common stream fallbacks.
    if (u.pathname && u.pathname !== '/') return [...new Set([normalized, u.origin + '/stream', u.origin])];
    // If the user typed only the base host, try the standard /stream path first.
    return [normalized + '/stream', normalized];
  } catch (err) {
    console.error('Invalid camera URL', err);
    return [];
  }
}

/**
 * Ensures the image element requests the stream with CORS enabled so canvas reads work.
 */
// EXAM: camera CORS mode.
function configureFeedCorsMode() {
  // The detector reads pixels from the image, so the image must be requested with CORS enabled.
  if (feedImg) feedImg.crossOrigin = 'anonymous';
}

// Stream setup only manages image source and detection loop lifecycle; the detector itself lives in control-detection.js.
/**
 * @param {string} baseUrl - Camera base URL or stream URL.
 * @param {{persist?: boolean}=} options - Whether this stream should become the local saved override.
 * @returns {string} Normalized base URL when successful, otherwise an empty string.
 */
// EXAM: camera stream startup and retry state.
function setStream(baseUrl, options) {
  // Function flow:
  // 1. Normalize the camera URL into one stable base form.
  // 2. If empty, tear everything down and return to idle.
  // 3. If valid, build a short list of fallback stream URLs.
  // 4. Point the shared <img> element at the first candidate.
  // 5. Update HUD state and save the normalized base URL.
  const persist = !options || options.persist !== false; // Firebase auto-apply should not silently become a local override.
  // Normalize typed or Firebase-provided URLs into one consistent format.
  const normalized = normalizeBaseUrl(baseUrl); // Canonicalized camera URL used for stream setup and local persistence.
  if (!normalized) {
    streamCandidates = [];
    streamCandidateIndex = 0;
    // An empty URL means the operator wants to fully tear down the current stream session.
    // Clearing the stream also resets the detector and HUD so the page visibly returns to an idle state.
    if (feedImg) {
      feedImg.src = '';
      feedImg.classList.add('d-none');
    }
    if (placeholder) placeholder.classList.remove('d-none');
    setReadout(statusLabel, 'Stream idle');
    if (persist) localStorage.removeItem(STORAGE_KEY);
    stopDetectionLoop('idle');
    clearTargetTelemetry();
    setMode('Manual');
    return '';
  }
  configureFeedCorsMode();
  // Build a short retry list so the page can try common stream URL variations automatically.
  streamCandidates = buildStreamCandidates(normalized);
  streamCandidateIndex = 0;
  const first = streamCandidates[0]; // First stream candidate attempted immediately.
  if (!first) return '';
  // Point the image element at the first candidate stream URL.
  feedImg.src = first;
  feedImg.classList.remove('d-none');
  if (placeholder) placeholder.classList.add('d-none');
  setReadout(statusLabel, `Streaming from ${first}`);
  setDetectStatus('Detect: waiting', 'bg-secondary');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole(`Attempting camera stream: ${first}`, 'text-muted');
  // Store the normalized base URL instead of the first candidate so future retries can be rebuilt consistently.
  if (persist) localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

// Controller communication stays direct over local HTTP so movement remains local and low-latency.
/**
 * @param {string} cmd - Controller endpoint suffix such as status or step_left.
 * @returns {Promise<Response|null>} Fetch response when available, otherwise null.
 */
// EXAM: direct ESP32 HTTP command send.
function sendCmd(cmd) {
  // Function flow:
  // 1. Read the saved controller base URL.
  // 2. Send one direct HTTP request to that ESP32 endpoint.
  // 3. If the controller answered with an error, log a readable reason.
  // 4. If the network call itself failed, log a connection-level failure.
  // 5. Return the Response so callers can parse status/config bodies themselves.
  // Read the last saved controller base URL from localStorage.
  const ip = localStorage.getItem(ESP32_STORAGE_KEY) || normalizeBaseUrl(esp32IpInput && esp32IpInput.value); // Saved or currently displayed ESP32 base URL used for direct HTTP commands.
  if (!ip) {
    alert('Set the ESP32 address first.');
    return Promise.resolve(null);
  }
  // Local direct HTTP keeps manual control independent from Firebase round trips.
  return fetch(`${ip}/${cmd}`, { cache: 'no-store' })
    .then(async (res) => {
      // Success responses are returned untouched; only the error path needs extra explanation/logging.
      // If the controller answered with an error code, try to extract a useful message.
      if (!res.ok) {
        try {
          // Clone the response before reading its body so the original response can still be returned.
          const text = await res.clone().text(); // Response body copied for console-friendly error reporting.
          let message = text; // Human-readable error text eventually shown in the event console.
          try {
            // Prefer a structured JSON error if the controller returned one.
            const payload = JSON.parse(text); // Structured JSON error payload when the firmware provides one.
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
      // Network errors end up here, for example when the controller host is offline.
      console.error(`Command ${cmd} failed:`, err);
      logConsole(`Controller command failed: ${cmd}`, 'text-danger');
      return null;
    });
}

/**
 * @param {string} text - Raw controller status body.
 * @returns {{laser: number|null, x: number|null, y: number|null}|object|null} Parsed status object.
 */
// EXAM: parse controller status response.
function parseControllerStatusText(text) {
  // Empty status bodies are treated as unusable.
  if (!text) return null;
  try {
    // Newer firmware answers with JSON, so try that first.
    return JSON.parse(text);
  } catch (err) {
    // Older firmware responses can be plain text, so keep a regex fallback.
    const laserMatch = text.match(/laser[:=](\d)/i); // Regex match for legacy plain-text laser state.
    const xMatch = text.match(/x[:=](-?\d+)/i); // Regex match for legacy plain-text X position.
    const yMatch = text.match(/y[:=](-?\d+)/i); // Regex match for legacy plain-text Y position.
    return {
      laser: laserMatch ? Number.parseInt(laserMatch[1], 10) : null,
      x: xMatch ? Number.parseInt(xMatch[1], 10) : null,
      y: yMatch ? Number.parseInt(yMatch[1], 10) : null,
    };
  }
}

/**
 * @param {boolean} logSuccess - Whether to write a success message to the event console.
 * @returns {Promise<object|null>} Parsed controller config object.
 */
// EXAM: fetch controller config.
function syncControllerConfig(logSuccess) {
  // Why this matters:
  // - The detector can say "move left", but the page still needs to know which HTTP command really moves left.
  // - That depends on firmware polarity values such as x_dir and y_dir.
  // - So the UI refreshes calibration/assist cards immediately after config is fetched.
  // Ask the controller for its current config so calibration hints match the real firmware state.
  return sendCmd('config').then(async (res) => {
    if (!res || !res.ok) {
      // Clear the cached config when the request fails so the UI does not show stale values.
      controllerState.config = null;
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      return null;
    }
    try {
      // Parse the JSON config body and cache it for later helper functions.
      controllerState.config = await res.json();
      // These readouts depend on controller polarity, so update them immediately after new config arrives.
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      if (logSuccess) logConsole(`Controller config loaded: x_dir=${getControllerConfigNumber(controllerState.config.x_dir, 1)}, y_dir=${getControllerConfigNumber(controllerState.config.y_dir, 1)}`, 'text-info');
      return controllerState.config;
    } catch (err) {
      console.error('Failed to parse controller config.', err);
      // Parsing failure is treated the same as a missing config.
      controllerState.config = null;
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      if (logSuccess) logConsole('Controller config parse failed.', 'text-warning');
      return null;
    }
  });
}

/**
 * @returns {Promise<void>} Completes after the laser state cache is refreshed.
 */
// EXAM: laser state sync.
async function syncLaserState() {
  // Read the live status endpoint so the UI knows whether the laser is already on.
  const res = await sendCmd('status'); // Raw HTTP response from the controller status endpoint.
  if (!res || !res.ok) return;
  const text = await res.text(); // Body text of the status response, regardless of JSON or plain-text format.
  const status = parseControllerStatusText(text); // Parsed internal status object in a stable shape.
  if (!status) return;
  // This flag lets the UI decide when the old toggle endpoint still needs to be used as a fallback.
  if (typeof status.laser === 'number') isLaserOn = status.laser === 1;
}

/**
 * @param {'x'|'y'} axis - Axis to nudge during calibration.
 * @param {number} sign - Positive or negative direction for the nudge.
 * @returns {Promise<void>} Completes after the probe request finishes.
 */
// EXAM: calibration probe command.
async function sendProbe(axis, sign) {
  // Convert the requested axis/sign pair into a small +/- degree nudge command.
  const delta = sign > 0 ? CALIBRATION_PROBE_DELTA_DEG : -CALIBRATION_PROBE_DELTA_DEG; // Signed degree step sent for the probe.
  const query = axis === 'x' ? `nudge?dx=${delta}` : `nudge?dy=${delta}`; // Firmware endpoint query string for the selected axis/sign.
  const res = await sendCmd(query); // Response returned by the calibration probe request.
  if (!res || !res.ok) return;
  logConsole(`Calibration probe sent: ${axis.toUpperCase()}${sign > 0 ? '+' : '-'} (${delta > 0 ? '+' : ''}${delta} deg)`, 'text-info');
}

// Telemetry is recorded by the detection loop and downloaded here as a JSON file for later review.
/**
 * Downloads the in-memory telemetry array as a JSON file.
 */
// EXAM: telemetry JSON export.
function downloadTelemetry() {
  if (!sessionTelemetry.length) return logConsole('No telemetry to download yet.', 'text-warning');
  // Serialize the current session into nicely formatted JSON for later study.
  const blob = new Blob([JSON.stringify(sessionTelemetry, null, 2)], { type: 'application/json' }); // Generated JSON file content wrapped as a browser Blob.
  // Turn that blob into a temporary object URL that the browser can download.
  const url = URL.createObjectURL(blob); // Temporary browser URL pointing to the generated telemetry file.
  // Create a temporary link because browsers trigger downloads most reliably through a clicked <a>.
  const a = document.createElement('a'); // Temporary anchor element used to trigger download.
  a.href = url;
  a.download = `skyshield-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
