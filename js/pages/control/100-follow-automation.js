// FILE ROLE: 100-follow-automation.js
// What this file does:
// - Turns detector guidance into optional automatic controller commands.
// - Owns the auto-follow timer and the Start/Stop Auto-Follow button state.
// - Shuts the controller down cleanly when follow mode is disabled.
// Why this file exists:
// - The detector already knows where the target is, but follow mode must remain optional.
// - Keeping it isolated lets the rest of the control stack stay focused on detection and transport.
// Reading guide:
// 1. The top defines follow cadence and how coarse detector sizes map into controller movement.
// 2. The middle translates detector pan/tilt hints into real controller commands.
// 3. The bottom owns the follow timer lifecycle and exposes the public window.SkyShieldFollow API.
// Separation-of-concerns notes:
// - This file never runs model inference itself.
// - It consumes shared trackingState values produced by the detector stack.
// - It also avoids owning calibration logic by delegating physical-direction lookup to 20-calibration-and-target-guide.js.

const FOLLOW_INTERVAL_MS = 80; // Follow polls quickly, but each target update is consumed only once so stale frames cannot cause repeated overshoot.
const HOLD_TOLERANCE = 0.01; // Ignore tiny target drift that is already visually centered.
const MAX_FALLBACK_TAPS_PER_STEP = 1; // Legacy step-command fallback stays intentionally conservative to avoid large jumps.
const FOLLOW_NUDGE_DEG_BY_SIZE = {
  SMALL: 1,
  MED: 2,
  LARGE: 3,
}; // Auto-follow uses smaller nudge increments than the legacy 5-degree step endpoints.

let followEnabled = false; // True while auto-follow is armed.
let followTimer = null; // Timer id for the next scheduled follow step.
let followPrefersNudge = true; // Disabled only if the controller rejects the finer nudge endpoint.
let lastFollowTrackingSeq = 0; // Last trackingState.updateSeq already consumed by follow so stale detector frames are never replayed.
const DEFAULT_FOLLOW_DIRECTION_COMMANDS = {
  left: 'step_left',
  right: 'step_right',
  up: 'servo_up',
  down: 'servo_down',
}; // Auto-follow fallback must not depend on the UI button labels, which are presentation-level aliases.

/**
 * Checks whether the page currently knows where to send controller commands.
 * @returns {boolean} True when the controller URL is available from local state or the current input.
 */
function hasControllerAddress() {
  return !!(localStorage.getItem(ESP32_STORAGE_KEY) || normalizeBaseUrl(esp32IpInput && esp32IpInput.value));
}

/**
 * Maps a plain physical direction word to the default legacy controller command.
 * @returns {string|null} Default controller command for a plain physical direction.
 */
function getDefaultCommandForDirection(direction) {
  return DEFAULT_FOLLOW_DIRECTION_COMMANDS[String(direction || '').toLowerCase()] || null;
}

/**
 * Refreshes the Start/Stop Auto-Follow button so its text and styling match follow state.
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
 * Verifies that auto-follow has the minimum controller and stream prerequisites before starting.
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
 * Translates a desired real-world movement into the exact controller command to send.
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
 * Converts the detector's SMALL/MED/LARGE follow hint into a conservative nudge size in degrees.
 * @param {string} size - Simulated movement size such as SMALL, MED, or LARGE.
 * @returns {number} Conservative nudge size in degrees for that follow step.
 */
function getFollowNudgeDegrees(size) {
  return FOLLOW_NUDGE_DEG_BY_SIZE[String(size || 'SMALL').toUpperCase()] || FOLLOW_NUDGE_DEG_BY_SIZE.SMALL;
}

/**
 * Detects whether a failed nudge request means the firmware lacks nudge support entirely.
 * @param {Response|null} response - Controller response from a nudge attempt.
 * @returns {boolean} True only when the firmware likely does not support the nudge endpoint.
 */
function isNudgeUnsupportedResponse(response) {
  return !!(response && [404, 405, 501].includes(response.status));
}

/**
 * Checks whether both calibration directions have been captured well enough to trust derived mappings.
 * @returns {boolean} True when both calibration directions have been recorded.
 */
function hasCompleteCalibration() {
  return !!(
    controllerState &&
    controllerState.calibration &&
    controllerState.calibration.xPositiveObserved !== 'unknown' &&
    controllerState.calibration.yPositiveObserved !== 'unknown'
  );
}

/**
 * Combines the chosen follow moves into one signed `/nudge?dx=...&dy=...` query when possible.
 * @param {{command: string, size: string}[]} moves - Commands derived from the current detector frame.
 * @param {object|null} derived - Current calibration interpretation.
 * @returns {string} Combined nudge command query, or an empty string when no nudge mapping is possible.
 */
function buildFollowNudgeCommand(moves, derived) {
  if (!moves.length || !derived) return '';
  const xDir = getControllerConfigNumber(derived.xDir, 1);
  const yDir = getControllerConfigNumber(derived.yDir, 1);
  let dx = 0;
  let dy = 0;

  // Each move already encodes the real physical direction; this loop only converts that into signed nudge degrees.
  for (const move of moves) {
    const magnitude = getFollowNudgeDegrees(move.size);
    switch (move.command) {
      case 'step_right':
        dx += magnitude * xDir;
        break;
      case 'step_left':
        dx -= magnitude * xDir;
        break;
      case 'servo_up':
        dy += magnitude * yDir;
        break;
      case 'servo_down':
        dy -= magnitude * yDir;
        break;
      default:
        return '';
    }
  }

  const queryParts = [];
  if (dx) queryParts.push(`dx=${dx}`);
  if (dy) queryParts.push(`dy=${dy}`);
  return queryParts.length ? `nudge?${queryParts.join('&')}` : '';
}

/**
 * Reads the current detector labels and converts them into calibrated movement commands for this frame.
 * @returns {{derived: object|null, moves: {axis: string, command: string, taps: number, size: string, strength: number}[]}} Commands that should run for the current detector frame.
 */
function resolveMovementCommands() {
  const derived = typeof deriveCalibration === 'function' ? deriveCalibration() : null;
  const moves = [];
  const pan = parseSimLabel(trackingState.simPanLabel);
  const tilt = parseSimLabel(trackingState.simTiltLabel);
  // Using the same parsed labels as the operator-assist panel keeps human guidance and automation aligned.

  const panCommand = resolveDirectionCommand(pan.direction, derived);
  if (panCommand) {
    moves.push({
      axis: 'pan',
      command: panCommand,
      taps: Math.min(pan.taps, MAX_FALLBACK_TAPS_PER_STEP),
      size: pan.size,
      strength: Math.abs(trackingState.filteredNormX),
    });
  }

  const tiltCommand = resolveDirectionCommand(tilt.direction, derived);
  if (tiltCommand) {
    moves.push({
      axis: 'tilt',
      command: tiltCommand,
      taps: Math.min(tilt.taps, MAX_FALLBACK_TAPS_PER_STEP),
      size: tilt.size,
      strength: Math.abs(trackingState.filteredNormY),
    });
  }

  return { derived, moves };
}

/**
 * Chooses the single safest legacy fallback move when a combined nudge cannot be used.
 * @param {{axis: string, command: string, taps: number, size: string, strength: number}[]} moves - Candidate fallback moves for the current detector frame.
 * @returns {{axis: string, command: string, taps: number, size: string, strength: number}[]} Single best fallback move.
 */
function pickFallbackMoves(moves) {
  if (moves.length <= 1) return moves;
  // The legacy single-axis step fallback cannot safely send pan + tilt back-to-back on every frame,
  // because the controller rate-limits rapid servo updates. Pick the strongest axis and let the next
  // fresh detector frame decide whether the other axis still needs correction.
  const ranked = [...moves].sort((a, b) => {
    const degreeDelta = getFollowNudgeDegrees(b.size) - getFollowNudgeDegrees(a.size);
    if (degreeDelta) return degreeDelta;
    const strengthDelta = b.strength - a.strength;
    if (strengthDelta) return strengthDelta;
    if (a.axis === b.axis) return 0;
    return a.axis === 'pan' ? -1 : 1;
  });
  return [ranked[0]];
}

/**
 * Executes one auto-follow cycle from the newest available tracking update.
 * Runs one auto-follow pass using the latest shared tracking state.
 */
async function performFollowStep() {
  if (!followEnabled || !trackingState.hasTarget) return;
  const currentTrackingSeq = trackingState.updateSeq || 0;
  // Follow consumes each detector update once. Without this guard, a slow-moving or frozen target can
  // trigger repeated nudges from stale tracking data and drive the rig too far in one direction.
  if (currentTrackingSeq === lastFollowTrackingSeq) return;
  lastFollowTrackingSeq = currentTrackingSeq;
  if (
    Math.abs(trackingState.filteredNormX) < HOLD_TOLERANCE &&
    Math.abs(trackingState.filteredNormY) < HOLD_TOLERANCE
  ) {
    // Small residual offsets are ignored here so follow does not chatter when the target is already effectively centered.
    return;
  }

  const { derived, moves } = resolveMovementCommands();
  if (!moves.length) return;

  if (followPrefersNudge) {
    const nudgeCommand = buildFollowNudgeCommand(moves, derived);
    if (nudgeCommand) {
      const response = await sendCmd(nudgeCommand);
      if (response && response.ok) {
        logConsole(`Auto-follow: ${nudgeCommand}`, 'text-info');
        return;
      }
      // Only a real "endpoint unsupported" style response disables the nudge path; temporary cooldowns must not force a permanent downgrade.
      if (isNudgeUnsupportedResponse(response)) {
        followPrefersNudge = false;
        logConsole('Auto-follow nudges unavailable; using legacy step commands.', 'text-warning');
      }
      // Whether the failure was network-related, rate-limited, or unsupported, stop this cycle here and
      // wait for the next detector update instead of stacking extra fallback moves onto stale guidance.
      return;
    }
  }

  const fallbackMoves = pickFallbackMoves(moves);
  for (const { command, taps } of fallbackMoves) {
    for (let i = 0; i < taps; i += 1) {
      const response = await sendCmd(command);
      if (!response || !response.ok) return;
    }
  }

  logConsole(`Auto-follow: ${fallbackMoves.map((move) => `${move.command} x${move.taps}`).join(', ')}`, 'text-info');
}

/**
 * Arms the timer that triggers the next auto-follow cycle.
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
 * Sends a last stop command so the rig does not keep moving after auto-follow shuts down.
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
 * Enables auto-follow after validating prerequisites and refreshing controller config if needed.
 * Turns auto-follow on.
 * @returns {Promise<boolean>} True when the mode becomes enabled.
 */
async function enableFollow() {
  if (followEnabled) return true;
  if (!canEnableFollow()) {
    syncFollowButtonState();
    return false;
  }
  // Follow should start only after the latest controller polarity/config has been fetched. Otherwise the
  // fallback path may guess directions from defaults that do not match the current rig wiring.
  if (!controllerState.config && typeof syncControllerConfig === 'function') {
    await syncControllerConfig(false);
  }
  if (!controllerState.config) {
    logConsole('Auto-follow needs controller config first. Reconnect the ESP32 controller and try again.', 'text-warning');
    syncFollowButtonState();
    return false;
  }
  followEnabled = true;
  followPrefersNudge = true;
  lastFollowTrackingSeq = 0;
  syncFollowButtonState();
  if (!hasCompleteCalibration()) {
    logConsole('Auto-follow is using the default direction map. Run calibration if movement still looks reversed.', 'text-warning');
  }
  logConsole('Auto-follow enabled.', 'text-info');
  scheduleNextFollow();
  return true;
}

/**
 * Disables auto-follow, clears its timer, and optionally sends a final stop command to the rig.
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
  lastFollowTrackingSeq = 0;
  syncFollowButtonState();
  // Optional stopRig=false is used only by teardown paths that do not want one extra controller stop call.
  if (stopRig) await stopRigIfPossible();
  if (wasEnabled && !silent) logConsole('Auto-follow disabled.', 'text-muted');
  return wasEnabled;
}

/**
 * Switches the main Auto-Follow button between enable and disable behavior.
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

/*
WHO-CALLS:
- html/control.html loads this file after the detection loop file.
- 40-init.js calls window.SkyShieldFollow.toggle() and disable().
- 90-detection-loop.js calls window.SkyShieldFollow.disable().
- while running, this file reads trackingState from 50-detection-state-settings.js, uses calibration helpers from 20-calibration-and-target-guide.js, and sends movement commands through 30-transport.js.
*/
