// FILE ROLE: 100-follow-automation.js
// What this file does:
// - Turns detector guidance into optional automatic controller commands.
// - Owns the auto-follow timer and the Start/Stop Auto-Follow button state.
// - Shuts the controller down cleanly when follow mode is disabled.
// Why this file exists:
// - The detector already knows where the target is, but follow mode must remain optional.
// - Keeping it isolated lets the rest of the control stack stay focused on detection and transport.

const FOLLOW_INTERVAL_MS = 180; // Follow cadence matched to the detector loop so commands do not pile up faster than target updates.
const HOLD_TOLERANCE = 0.01; // Ignore tiny target drift that is already visually centered.
const MAX_TAPS_PER_STEP = 3; // Cap repeated step commands so one frame cannot overdrive the rig.

let followEnabled = false; // True while auto-follow is armed.
let followTimer = null; // Timer id for the next scheduled follow step.

/**
 * @returns {boolean} True when the controller URL is available from local state or the current input.
 */
function hasControllerAddress() {
  return !!(localStorage.getItem(ESP32_STORAGE_KEY) || normalizeBaseUrl(esp32IpInput && esp32IpInput.value));
}

/**
 * @returns {string|null} Default controller command for a plain physical direction.
 */
function getDefaultCommandForDirection(direction) {
  const target = String(direction || '').toLowerCase();
  const button = MANUAL_BUTTON_COMMANDS.find(({ button: label }) => label.toLowerCase() === target);
  return button ? button.command : null;
}

/**
 * Updates the visible follow button so its label always matches the current state.
 */
function syncFollowButtonState() {
  if (!stopBtn) return;
  stopBtn.className = followEnabled ? 'btn btn-outline-light hud-button' : 'btn btn-outline-info hud-button';
  stopBtn.innerHTML = followEnabled
    ? '<i class="bi bi-stop-circle me-2"></i>Stop Auto-Follow'
    : '<i class="bi bi-play-circle me-2"></i>Start Auto-Follow';
}

/**
 * @returns {boolean} True when follow mode has the minimum prerequisites to start safely.
 */
function canEnableFollow() {
  if (!hasControllerAddress()) {
    logConsole('Auto-follow needs the ESP32 controller address first.', 'text-warning');
    return false;
  }
  if (!feedImg || !feedImg.src || feedImg.classList.contains('d-none')) {
    logConsole('Auto-follow needs a live camera stream first.', 'text-warning');
    return false;
  }
  return true;
}

/**
 * @param {string} direction - Desired physical movement direction.
 * @param {object|null} derived - Current calibration interpretation.
 * @returns {string|null} Matching controller command.
 */
function resolveDirectionCommand(direction, derived) {
  if (!direction || direction === 'hold') return null;
  const calibrated = derived && typeof findManualButtonForDirection === 'function'
    ? findManualButtonForDirection(direction, derived)
    : null;
  return calibrated ? calibrated.command : getDefaultCommandForDirection(direction);
}

/**
 * @returns {{command: string, taps: number}[]} Commands that should run for the current detector frame.
 */
function resolveMovementCommands() {
  const derived = typeof deriveCalibration === 'function' ? deriveCalibration() : null;
  const moves = [];
  const pan = parseSimLabel(trackingState.simPanLabel);
  const tilt = parseSimLabel(trackingState.simTiltLabel);

  const panCommand = resolveDirectionCommand(pan.direction, derived);
  if (panCommand) {
    moves.push({
      command: panCommand,
      taps: Math.min(pan.taps, MAX_TAPS_PER_STEP),
    });
  }

  const tiltCommand = resolveDirectionCommand(tilt.direction, derived);
  if (tiltCommand) {
    moves.push({
      command: tiltCommand,
      taps: Math.min(tilt.taps, MAX_TAPS_PER_STEP),
    });
  }

  return moves;
}

/**
 * Runs one auto-follow pass using the latest shared tracking state.
 */
async function performFollowStep() {
  if (!followEnabled || !trackingState.hasTarget) return;
  if (
    Math.abs(trackingState.filteredNormX) < HOLD_TOLERANCE &&
    Math.abs(trackingState.filteredNormY) < HOLD_TOLERANCE
  ) {
    return;
  }

  const moves = resolveMovementCommands();
  if (!moves.length) return;

  for (const { command, taps } of moves) {
    for (let i = 0; i < taps; i += 1) {
      const response = await sendCmd(command);
      if (!response || !response.ok) return;
    }
  }

  logConsole(`Auto-follow: ${moves.map((move) => `${move.command} x${move.taps}`).join(', ')}`, 'text-info');
}

/**
 * Schedules the next follow pass.
 */
function scheduleNextFollow() {
  if (!followEnabled) return;
  followTimer = setTimeout(async () => {
    await performFollowStep();
    scheduleNextFollow();
  }, FOLLOW_INTERVAL_MS);
}

/**
 * Sends a final stop command to the controller when follow mode is turned off.
 */
async function stopRigIfPossible() {
  if (!hasControllerAddress()) return;
  const response = await sendCmd('stop');
  if (!response || !response.ok) {
    logConsole('Auto-follow stop command failed.', 'text-warning');
  }
}

/**
 * Turns auto-follow on.
 * @returns {Promise<boolean>} True when the mode becomes enabled.
 */
async function enableFollow() {
  if (followEnabled) return true;
  if (!canEnableFollow()) {
    syncFollowButtonState();
    return false;
  }
  followEnabled = true;
  syncFollowButtonState();
  logConsole('Auto-follow enabled.', 'text-info');
  scheduleNextFollow();
  return true;
}

/**
 * Turns auto-follow off.
 * @param {{silent?: boolean, stopRig?: boolean}=} options - Optional shutdown controls for teardown paths.
 * @returns {Promise<boolean>} True when the mode was disabled from an enabled state.
 */
async function disableFollow(options) {
  const silent = !!(options && options.silent);
  const stopRig = !options || options.stopRig !== false;
  const wasEnabled = followEnabled;
  followEnabled = false;
  if (followTimer) clearTimeout(followTimer);
  followTimer = null;
  syncFollowButtonState();
  if (stopRig) await stopRigIfPossible();
  if (wasEnabled && !silent) logConsole('Auto-follow disabled.', 'text-muted');
  return wasEnabled;
}

/**
 * Toggles auto-follow from the main control button.
 * @returns {Promise<boolean>} True when follow ends up enabled.
 */
async function toggleFollow() {
  if (followEnabled) {
    await disableFollow({ stopRig: true });
    return false;
  }
  return enableFollow();
}

window.SkyShieldFollow = {
  disable: disableFollow,
  enable: enableFollow,
  isEnabled: () => followEnabled,
  syncUi: syncFollowButtonState,
  toggle: toggleFollow,
};

syncFollowButtonState();
