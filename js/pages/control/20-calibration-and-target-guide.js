// FILE ROLE: 20-calibration-and-target-guide.js
// What this file does:
// - Stores and interprets calibration observations such as what X+ and Y+ really did physically.
// - Figures out pan axis, tilt axis, and the real meaning of the visible movement buttons.
// - Builds operator-assist messages like which way the target is off-center and which button the user should press.
// Why this file exists:
// - The rig's physical movement can differ from raw firmware command names.
// - This file turns hardware behavior into understandable human guidance.
// Section: calibration and operator assist.
// Reading guide:
// 1. The first helpers normalize direction words and decode detector labels like LEFT_SMALL.
// 2. The middle stores/restores calibration notes and interprets controller polarity.
// 3. The bottom builds operator-facing summaries and button guidance.
// Convention notes:
// - "Observed" means what the rig physically did during calibration.
// - "Derived" means the interpretation after firmware polarity is applied.
// - "Assist" means UI-only advice; this file itself does not move hardware.
// Calibration helpers translate physical rig behavior into user-friendly manual hints.
/**
 * @param {string} value - Direction text from saved state or a select box.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Normalized direction.
 */
// EXAM: observed direction normalization.
function normalizeObservedDirection(value) {
  // Only four directions are valid in calibration notes; everything else becomes unknown.
  return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';
}

/**
 * @param {'left'|'right'|'up'|'down'|'unknown'} direction - Direction to flip.
 * @returns {'left'|'right'|'up'|'down'|'unknown'} Opposite direction.
 */
// EXAM: opposite direction helper.
function getOppositeDirection(direction) {
  // Calibration often needs the opposite physical movement when firmware polarity is reversed.
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

/**
 * @param {'left'|'right'|'up'|'down'|'unknown'} direction - Observed movement direction.
 * @returns {'pan'|'tilt'|'unknown'} Which axis role that direction implies.
 */
// EXAM: axis role detection.
function axisRoleFromDirection(direction) {
  // Left/right movement describes the pan axis.
  if (direction === 'left' || direction === 'right') return 'pan';
  // Up/down movement describes the tilt axis.
  if (direction === 'up' || direction === 'down') return 'tilt';
  // Unknown directions cannot be mapped to an axis role.
  return 'unknown';
}

/**
 * @param {string} direction - Raw direction value.
 * @returns {string} Uppercase label for known directions.
 */
// EXAM: friendly direction text.
function friendlyDirection(direction) {
  // Uppercase known directions so the UI reads like a label, not like raw internal data.
  return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();
}

/**
 * @param {string} rawPositiveDirection - Physical movement caused by the axis's positive direction.
 * @param {number} signedFactor - Firmware polarity multiplier for the command being tested.
 * @returns {string} Derived movement direction caused by that command.
 */
// EXAM: firmware polarity to real movement.
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {
  // Start from the recorded "positive" physical movement for that firmware axis.
  const raw = normalizeObservedDirection(rawPositiveDirection); // Cleaned observed physical movement for the positive side of the axis.
  // If calibration is incomplete, we cannot derive a usable movement direction.
  if (raw === 'unknown') return 'unknown';
  // Positive factor keeps the direction; negative factor flips it.
  return signedFactor >= 0 ? raw : getOppositeDirection(raw);
}

/**
 * @param {string} label - Simulated movement label such as LEFT_SMALL or HOLD.
 * @returns {{label: string, direction: string, size: string, taps: number}} Parsed assist label.
 */
// EXAM: detector sim-label parsing.
function parseSimLabel(label) {
  // HOLD means the detector thinks no movement is needed on that axis.
  if (!label || label === 'HOLD') {
    return { label: 'HOLD', direction: 'hold', size: 'HOLD', taps: 0 };
  }
  // Split labels like LEFT_SMALL or UP_LARGE into separate pieces.
  const [directionRaw, sizeRaw] = String(label).split('_'); // Raw direction and magnitude pieces of a label like LEFT_SMALL.
  // Normalize case because UI labels and internal labels can vary.
  const direction = String(directionRaw || '').toLowerCase(); // Lowercased movement direction piece.
  const size = String(sizeRaw || 'SMALL').toUpperCase(); // Uppercased movement size piece.
  // Translate qualitative size into how many manual button taps the operator should make.
  // This is operator guidance only; automation may choose a different physical movement granularity.
  const taps = size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1; // Suggested button-tap count for the assist panel.
  return { label, direction, size, taps };
}

/**
 * Reads the two calibration dropdowns from the page and stores them in controllerState.
 */
// EXAM: read calibration from UI.
function readCalibrationFromControls() {
  // Read the two select boxes from the page and store them in shared calibration state.
  controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);
  controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);
}

/**
 * Pushes the saved calibration state back into the dropdowns.
 */
// EXAM: write calibration to UI.
function writeCalibrationControls() {
  // Push the saved calibration state back into the select boxes when the page loads or resets.
  if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
}

/**
 * Loads saved calibration notes from localStorage.
 */
// EXAM: load saved calibration.
function loadCalibration() {
  // Start with no saved object.
  let saved = null; // Parsed calibration JSON before it is validated and normalized.
  try {
    // Read the calibration JSON from localStorage if it exists.
    saved = JSON.parse(localStorage.getItem(ASSIST_CALIBRATION_STORAGE_KEY) || 'null');
  } catch (err) {
    // If the stored JSON is damaged, ignore it and keep defaults instead of crashing the page.
    console.warn('Failed to parse saved calibration.', err);
  }
  // Rebuild the calibration object with safe normalized values.
  controllerState.calibration = {
    xPositiveObserved: normalizeObservedDirection(saved && saved.xPositiveObserved),
    yPositiveObserved: normalizeObservedDirection(saved && saved.yPositiveObserved),
  };
  // Reflect the loaded values into the visible form controls.
  writeCalibrationControls();
}

// Current control.html does not render the calibration panel, so this save helper is retained for future UI restoration but is not reachable from the shipped page.
/**
 * @param {boolean} logChange - Whether to write a confirmation line to the event console.
 */
// EXAM: save calibration.
function saveCalibration(logChange) {
  // First copy the current dropdown selections into shared state.
  readCalibrationFromControls();
  // Persist that state into localStorage so it survives refreshes.
  localStorage.setItem(ASSIST_CALIBRATION_STORAGE_KEY, JSON.stringify(controllerState.calibration));
  if (logChange) {
    // Optionally show a log line so the operator knows the notes were actually saved.
    logConsole(`Calibration saved: X+=${friendlyDirection(controllerState.calibration.xPositiveObserved)}, Y+=${friendlyDirection(controllerState.calibration.yPositiveObserved)}`, 'text-info');
  }
}

// Current control.html does not render the calibration panel, so this reset helper is retained for future UI restoration but is not reachable from the shipped page.
/**
 * Clears saved calibration notes and resets the dropdowns to unknown.
 */
// EXAM: reset calibration.
function resetCalibration() {
  // Restore the default "unknown" state for both observed positive directions.
  controllerState.calibration = {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  };
  // Remove the saved copy so refreshes also start from a clean state.
  localStorage.removeItem(ASSIST_CALIBRATION_STORAGE_KEY);
  // Update the dropdowns to match the reset state.
  writeCalibrationControls();
}

/**
 * @param {*} value - Controller config field that should contain an integer.
 * @param {number} fallback - Value used when parsing fails.
 * @returns {number} Parsed config value.
 */
// EXAM: controller config parsing.
function getControllerConfigNumber(value, fallback) {
  // Controller config values also arrive as strings, so parse them as integers.
  const n = Number.parseInt(value, 10); // Parsed integer config value from the firmware response.
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @returns {{
 *   xObserved: string,
 *   yObserved: string,
 *   xRole: string,
 *   yRole: string,
 *   xDir: number,
 *   yDir: number,
 *   commands: Object,
 *   panSummary: string,
 *   tiltSummary: string,
 *   buttonSummary: string
 * }} Derived calibration interpretation used by the UI.
 */
// EXAM: derive calibration and manual meaning.
function deriveCalibration() {
  // Function goal:
  // - Take two operator observations: what X+ physically did and what Y+ physically did.
  // - Combine them with firmware polarity flags x_dir / y_dir.
  // - Deduce what each real HTTP command will do in physical screen space.
  // - Build short UI summaries that explain pan, tilt, and button meaning.
  // Read the operator's observed motion notes for the two positive directions.
  const xObserved = normalizeObservedDirection(controllerState.calibration.xPositiveObserved); // Physical motion observed when probing X positive.
  const yObserved = normalizeObservedDirection(controllerState.calibration.yPositiveObserved); // Physical motion observed when probing Y positive.
  // Infer which physical axis each observation most likely belongs to.
  const xRole = axisRoleFromDirection(xObserved); // Whether X behaved like pan, tilt, or unknown.
  const yRole = axisRoleFromDirection(yObserved); // Whether Y behaved like pan, tilt, or unknown.
  // Read firmware direction multipliers, defaulting to normal polarity if config is missing.
  const xDir = getControllerConfigNumber(controllerState.config && controllerState.config.x_dir, 1); // Firmware polarity multiplier for X.
  const yDir = getControllerConfigNumber(controllerState.config && controllerState.config.y_dir, 1); // Firmware polarity multiplier for Y.
  // Convert raw axis direction plus firmware polarity into the practical movement caused by each HTTP command.
  // Example: if X positive physically moves LEFT, then a negative-X command should move RIGHT.
  // This command map is the bridge from low-level firmware endpoint names to human "move left/right/up/down" language.
  const commands = { // Real movement direction caused by each firmware endpoint after calibration + polarity are applied.
    step_right: commandDirectionFromRawPositive(xObserved, xDir),
    step_left: commandDirectionFromRawPositive(xObserved, -xDir),
    servo_up: commandDirectionFromRawPositive(yObserved, yDir),
    servo_down: commandDirectionFromRawPositive(yObserved, -yDir),
  };

  let panSummary = 'unknown'; // Human-readable summary of which axis currently appears to be pan.
  // If the observed X motion behaved like left/right, X is the pan axis.
  if (xRole === 'pan') panSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like left/right, then Y must be pan.
  else if (yRole === 'pan') panSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  let tiltSummary = 'unknown'; // Human-readable summary of which axis currently appears to be tilt.
  // If the observed X motion behaved like up/down, X is the tilt axis.
  if (xRole === 'tilt') tiltSummary = `X (+ => ${friendlyDirection(xObserved)})`;
  // Otherwise, if Y behaved like up/down, then Y must be tilt.
  else if (yRole === 'tilt') tiltSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

  // Turn the per-command movement map into one short summary string for the status card.
  const buttonSummary = MANUAL_BUTTON_COMMANDS
    .map(({ button, command }) => `${button}=${friendlyDirection(commands[command])}`)
    .join(' | '); // One compact string explaining what every visible manual button really does.

  return { xObserved, yObserved, xRole, yRole, xDir, yDir, commands, panSummary, tiltSummary, buttonSummary };
}

/**
 * @param {string} direction - Desired physical movement direction.
 * @param {object} derived - Result object from deriveCalibration().
 * @returns {{button: string, command: string}|null} Matching manual button mapping.
 */
// EXAM: map desired movement to manual button.
function findManualButtonForDirection(direction, derived) {
  // Normalize the requested movement first so invalid inputs collapse to unknown.
  const target = normalizeObservedDirection(direction); // Cleaned desired movement direction requested by assist logic.
  if (target === 'unknown') return null;
  // Search the known button-command list for the one that would move in the requested direction.
  return MANUAL_BUTTON_COMMANDS.find(({ command }) => derived.commands[command] === target) || null;
}

/**
 * @param {string} axisName - Human-readable axis name such as Pan or Tilt.
 * @param {{direction: string, size: string, taps: number}|null} parsedLabel - Parsed sim label.
 * @param {object} derived - Result object from deriveCalibration().
 * @returns {string} Operator-friendly hint for that axis.
 */
// EXAM: operator assist axis text.
function formatAxisAssist(axisName, parsedLabel, derived) {
  // HOLD means this axis is already centered enough and needs no movement hint.
  if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;
  const button = findManualButtonForDirection(parsedLabel.direction, derived); // Best manual button mapping for the requested physical direction.
  // Build a human-readable movement label even if calibration is unfinished.
  const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`; // Fallback detector-language text if no calibrated button exists.
  // If calibration is incomplete, tell the operator that this is only a rough movement label.
  if (!button) return `${axisName}: ${moveText} (finish calibration)`;
  // Otherwise convert the detector hint into an actual button and tap count.
  return `${axisName}: ${button.button} x${parsedLabel.taps}`;
}

// This helper gives a neutral "frame position" description without turning it into automatic actuation.
/**
 * @param {number} normX - Horizontal normalized offset from -1 to 1.
 * @param {number} normY - Vertical normalized offset from -1 to 1.
 * @param {number} deadZone - Center tolerance used by the assist logic.
 * @returns {string} Plain-language frame position summary.
 */
// EXAM: target position description.
function describeFramePosition(normX, normY, deadZone) {
  const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : ''; // Horizontal phrase derived from X offset.
  const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : ''; // Vertical phrase derived from Y offset.
  if (!horizontal && !vertical) return 'Centered';
  if (vertical && horizontal) return `${vertical}-${horizontal} of center`;
  return `${vertical || horizontal} of center`;
}

/**
 * Rebuilds the calibration status card from the latest controller config and saved observations.
 */
// EXAM: calibration readout UI.
function updateCalibrationReadouts() {
  const derived = deriveCalibration(); // Current interpreted calibration result used to populate the setup card.
  if (controllerConfigVal) {
    setReadout(controllerConfigVal, controllerState.config ? `x_dir=${derived.xDir}, y_dir=${derived.yDir}` : 'n/a');
  }
  // These three summaries are what the operator actually needs during setup: which axis is pan, which is tilt, and which button moves where.
  setReadout(calibrationPanVal, derived.panSummary);
  setReadout(calibrationTiltVal, derived.tiltSummary);
  setReadout(calibrationButtonsVal, derived.buttonSummary);
}

// Operator Assist is UI-only; it reads simulated pan/tilt output from the detection tracking state.
/**
 * Rebuilds the assist card from the current target tracking state.
 */
// EXAM: operator assist readout.
function updateOperatorAssistReadout() {
  // Function flow:
  // 1. Read the latest calibration interpretation.
  // 2. Read the latest detector tracking state.
  // 3. If there is no target, show idle/setup guidance.
  // 4. If there is a target, convert detector hints into frame-position text.
  // 5. If calibration is complete, translate those hints into real button presses.
  const derived = deriveCalibration(); // Current calibration interpretation used to translate detector hints into physical buttons.
  const settings = getSettings(); // Current detector settings needed for dead-zone-aware frame descriptions.
  // If there is no active target, fill the assist panel with idle guidance.
  if (!trackingState.hasTarget) {
    setReadout(assistMoveVal, 'No target');
    setReadout(assistFrameVal, 'No target');
    setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');
    setReadout(assistCenterVal, 'Not centered');
    return;
  }

  const panAssist = parseSimLabel(trackingState.simPanLabel); // Parsed simulated pan movement from detector state.
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel); // Parsed simulated tilt movement from detector state.
  // The target is considered centered only when both axes say HOLD.
  // That keeps the assist card aligned with the same dead-zone logic used by the detector and follow modules.
  const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold'; // True only when neither axis requires movement.
  // Build a plain-language description of where the target sits in the frame.
  const framePosition = describeFramePosition(trackingState.filteredNormX, trackingState.filteredNormY, settings.deadZone); // Plain-language frame-location summary.

  if (centered) {
    // When both axes are in the dead zone, the panel intentionally shifts from movement advice to confirmation.
    setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');
    setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);
    setReadout(assistButtonVal, 'Hold position');
    setReadout(assistCenterVal, 'Centered');
    return;
  }

  const moveParts = []; // Detector-style movement instructions combined for the assist card.
  // Add a pan instruction only when the simulated pan axis needs movement.
  if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);
  // Add a tilt instruction only when the simulated tilt axis needs movement.
  if (tiltAssist.direction !== 'hold') moveParts.push(`TILT ${friendlyDirection(tiltAssist.direction)}_${tiltAssist.size}`);
  setReadout(assistMoveVal, moveParts.join(' / '));
  setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);

  const buttonParts = []; // Concrete manual-button instructions combined for the assist card.
  // The raw PAN/TILT hint is useful, but the operator really needs a concrete manual button sequence here.
  if (panAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Pan', panAssist, derived));
  if (tiltAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Tilt', tiltAssist, derived));
  setReadout(assistButtonVal, buttonParts.join(' / '));
  setReadout(assistCenterVal, trackingState.isPossible ? 'Off-center (possible)' : 'Off-center');
}









/*
====================================================================
20-calibration-and-target-guide.js — exam line-by-line guide
====================================================================

file purpose:
this file translates hardware movement into human instructions.

the detector can say:
LEFT_SMALL
UP_LARGE
HOLD

but the firmware command name is not always the real physical movement.

example:
the command step_right can physically move the camera left because of servo mounting.

this file uses:
- calibration observations: what X+ and Y+ really did
- controller config: x_dir and y_dir polarity
- detector hints: LEFT_SMALL, UP_MED, HOLD

and turns them into:
- pan/tilt meaning
- real command meaning
- operator button guidance

====================================================================
function normalizeObservedDirection(value)
====================================================================

what it does:
this function receives a raw direction value and makes sure it is one of the only valid calibration directions.

valid directions:
left
right
up
down

anything else becomes:
unknown

why:
calibration must not use broken values from localStorage or a bad dropdown value.

code:
function normalizeObservedDirection(value) {
  return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';
}

line:
function normalizeObservedDirection(value) {

meaning:
creates a function named normalizeObservedDirection.
it receives one parameter called value.
value is the raw direction we want to check.

line:
return ['left', 'right', 'up', 'down'].includes(value) ? value : 'unknown';

meaning:
make an array/list of allowed directions.
.includes(value) checks if value exists inside that list.

the ? : part means:
if value is valid, return value.
if value is not valid, return 'unknown'.

example:
normalizeObservedDirection('left') returns 'left'
normalizeObservedDirection('banana') returns 'unknown'
normalizeObservedDirection(null) returns 'unknown'

====================================================================
function getOppositeDirection(direction)
====================================================================

what it does:
this function receives a direction and returns the opposite direction.

why:
when firmware polarity is negative, or when the command is the opposite side of the axis, the movement must be flipped.

example:
if X+ moved left, then X- should move right.

code:
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

line:
function getOppositeDirection(direction) {

meaning:
creates a function named getOppositeDirection.
it receives one parameter called direction.

line:
switch (direction) {

meaning:
checks the value of direction against several possible cases.

line:
case 'left':
  return 'right';

meaning:
if direction is 'left', return 'right'.

line:
case 'right':
  return 'left';

meaning:
if direction is 'right', return 'left'.

line:
case 'up':
  return 'down';

meaning:
if direction is 'up', return 'down'.

line:
case 'down':
  return 'up';

meaning:
if direction is 'down', return 'up'.

line:
default:
  return 'unknown';

meaning:
if direction is none of the known directions, return 'unknown'.
the function does not guess.

====================================================================
function axisRoleFromDirection(direction)
====================================================================

what it does:
this function checks if a direction belongs to horizontal movement or vertical movement.

horizontal movement is:
pan

vertical movement is:
tilt

why:
after calibration, the app needs to know if X or Y controls pan/tilt.

code:
function axisRoleFromDirection(direction) {
  if (direction === 'left' || direction === 'right') return 'pan';
  if (direction === 'up' || direction === 'down') return 'tilt';
  return 'unknown';
}

line:
function axisRoleFromDirection(direction) {

meaning:
creates a function that receives a direction and returns the role of that direction.

line:
if (direction === 'left' || direction === 'right') return 'pan';

meaning:
if direction is exactly 'left' OR exactly 'right',
then this is horizontal movement,
so return 'pan'.

=== means exact comparison.
|| means OR.

line:
if (direction === 'up' || direction === 'down') return 'tilt';

meaning:
if direction is exactly 'up' OR exactly 'down',
then this is vertical movement,
so return 'tilt'.

line:
return 'unknown';

meaning:
if the direction is not left/right/up/down,
the function cannot know the axis role.

example:
axisRoleFromDirection('left') returns 'pan'
axisRoleFromDirection('up') returns 'tilt'
axisRoleFromDirection('unknown') returns 'unknown'

====================================================================
function friendlyDirection(direction)
====================================================================

what it does:
this function converts a valid direction into nice display text.

example:
left becomes LEFT
up becomes UP

why:
the UI and console messages are easier to read with uppercase directions.

code:
function friendlyDirection(direction) {
  return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();
}

line:
function friendlyDirection(direction) {

meaning:
creates a function that receives a direction and returns a display-friendly version.

line:
return normalizeObservedDirection(direction) === 'unknown' ? 'unknown' : direction.toUpperCase();

meaning:
first it checks if the direction is valid by using normalizeObservedDirection(direction).

if the normalized value is 'unknown':
return 'unknown'.

otherwise:
return direction.toUpperCase().

toUpperCase() changes lowercase text to uppercase.

example:
friendlyDirection('left') returns 'LEFT'
friendlyDirection('down') returns 'DOWN'
friendlyDirection('bad') returns 'unknown'

====================================================================
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor)
====================================================================

what it does:
this function calculates the real physical direction caused by a command.

it uses:
- what the positive side of the axis did during calibration
- whether the current command/polarity keeps that direction or flips it

example:
X+ physically moved left.

commandDirectionFromRawPositive('left', 1)
returns 'left'

commandDirectionFromRawPositive('left', -1)
returns 'right'

why:
positive factor means keep the observed direction.
negative factor means use the opposite direction.

code:
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {
  const raw = normalizeObservedDirection(rawPositiveDirection);
  if (raw === 'unknown') return 'unknown';
  return signedFactor >= 0 ? raw : getOppositeDirection(raw);
}

line:
function commandDirectionFromRawPositive(rawPositiveDirection, signedFactor) {

meaning:
creates a function.
rawPositiveDirection is what X+ or Y+ physically did.
signedFactor is the sign/polarity for this command.

line:
const raw = normalizeObservedDirection(rawPositiveDirection);

meaning:
clean the raw observed direction before using it.
if rawPositiveDirection is invalid, raw becomes 'unknown'.

line:
if (raw === 'unknown') return 'unknown';

meaning:
if calibration is missing or invalid,
the function cannot calculate real movement,
so it returns 'unknown'.

line:
return signedFactor >= 0 ? raw : getOppositeDirection(raw);

meaning:
if signedFactor is zero or positive, return the same observed direction.
if signedFactor is negative, return the opposite direction.

signedFactor >= 0:
checks if the sign is positive or zero.

getOppositeDirection(raw):
flips left/right or up/down.

used by:
deriveCalibration()

====================================================================
function parseSimLabel(label)
====================================================================

what it does:
this function converts detector movement text into parts the app can use.

detector labels look like:
LEFT_SMALL
RIGHT_MED
UP_LARGE
HOLD

this function extracts:
- direction
- size
- taps

why:
the assist UI cannot easily work with one string.
it needs direction and tap count separately.

code:
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

line:
function parseSimLabel(label) {

meaning:
creates a function that receives one detector label.

line:
if (!label || label === 'HOLD') {

meaning:
if label is missing OR label is exactly 'HOLD',
then no movement is needed.

!label means label is empty/null/undefined.
|| means OR.

line:
return { label: 'HOLD', direction: 'hold', size: 'HOLD', taps: 0 };

meaning:
return an object saying:
label is HOLD
direction is hold
size is HOLD
taps is 0

taps is 0 because the operator should not press anything.

line:
const [directionRaw, sizeRaw] = String(label).split('_');

meaning:
convert label to string,
split it at the underscore,
and store the first part in directionRaw and the second part in sizeRaw.

example:
'LEFT_SMALL'.split('_')
becomes:
['LEFT', 'SMALL']

so:
directionRaw = 'LEFT'
sizeRaw = 'SMALL'

line:
const direction = String(directionRaw || '').toLowerCase();

meaning:
if directionRaw exists, use it.
if not, use empty text.
then convert it to lowercase.

example:
'LEFT' becomes 'left'.

line:
const size = String(sizeRaw || 'SMALL').toUpperCase();

meaning:
if sizeRaw exists, use it.
if not, default to 'SMALL'.
then convert to uppercase.

why default SMALL:
small movement is safest when size is missing.

line:
const taps = size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1;

meaning:
if size is LARGE, taps = 3.
else if size is MED, taps = 2.
else taps = 1.

this turns movement size into simple button presses.

line:
return { label, direction, size, taps };

meaning:
return an object with the original label, parsed direction, parsed size, and tap count.

example:
parseSimLabel('UP_LARGE')
returns:
{
  label: 'UP_LARGE',
  direction: 'up',
  size: 'LARGE',
  taps: 3
}

====================================================================
function readCalibrationFromControls()
====================================================================

what it does:
this function reads the calibration dropdowns from the page and stores the values in controllerState.calibration.

why:
other functions use controllerState.calibration as the shared calibration memory.

code:
function readCalibrationFromControls() {
  controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);
  controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);
}

line:
function readCalibrationFromControls() {

meaning:
creates a function with no parameters.

line:
controllerState.calibration.xPositiveObserved = normalizeObservedDirection(xObservedSelect && xObservedSelect.value);

meaning:
read the X+ observed direction from the X dropdown,
clean it,
and save it into controllerState.calibration.xPositiveObserved.

xObservedSelect && xObservedSelect.value:
if xObservedSelect exists, use xObservedSelect.value.
if it does not exist, do not crash.

normalizeObservedDirection(...):
makes sure the value is left/right/up/down/unknown.

line:
controllerState.calibration.yPositiveObserved = normalizeObservedDirection(yObservedSelect && yObservedSelect.value);

meaning:
same thing for the Y+ dropdown.

example:
if dropdowns are:
X+ = left
Y+ = up

then state becomes:
controllerState.calibration.xPositiveObserved = 'left'
controllerState.calibration.yPositiveObserved = 'up'

====================================================================
function writeCalibrationControls()
====================================================================

what it does:
this function writes saved calibration values back into the dropdowns.

why:
when the page loads or resets, the visible dropdowns must match controllerState.calibration.

code:
function writeCalibrationControls() {
  if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);
  if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);
}

line:
function writeCalibrationControls() {

meaning:
creates a function with no parameters.

line:
if (xObservedSelect) xObservedSelect.value = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);

meaning:
if the X dropdown exists,
set its visible value to the saved X+ observation.

normalizeObservedDirection protects the dropdown from broken values.

line:
if (yObservedSelect) yObservedSelect.value = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);

meaning:
same thing for the Y dropdown.

====================================================================
function loadCalibration()
====================================================================

what it does:
this function loads calibration from localStorage when the page starts.

why:
without this, calibration would disappear after refresh.

code:
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

line:
function loadCalibration() {

meaning:
creates a function with no parameters.

line:
let saved = null;

meaning:
create a variable named saved.
it starts as null because nothing has been loaded yet.
let is used because saved will be changed.

line:
try {

meaning:
start a safe block for code that might fail.

line:
saved = JSON.parse(localStorage.getItem(ASSIST_CALIBRATION_STORAGE_KEY) || 'null');

meaning:
read saved calibration text from localStorage,
then convert it from JSON text into a JavaScript object.

localStorage.getItem(...):
reads browser storage.

ASSIST_CALIBRATION_STORAGE_KEY:
the key name where calibration is saved.

|| 'null':
if nothing was saved, use the string 'null'.

JSON.parse(...):
converts JSON text into a real object.

line:
} catch (err) {

meaning:
if the try block fails, catch the error in err.

line:
console.warn('Failed to parse saved calibration.', err);

meaning:
show a warning in the browser console.
the page does not crash.

line:
controllerState.calibration = {

meaning:
replace current calibration state with loaded safe values.

line:
xPositiveObserved: normalizeObservedDirection(saved && saved.xPositiveObserved),

meaning:
if saved exists, read saved.xPositiveObserved.
then clean it.
store it as xPositiveObserved.

saved && saved.xPositiveObserved:
prevents crash if saved is null.

line:
yPositiveObserved: normalizeObservedDirection(saved && saved.yPositiveObserved),

meaning:
same thing for Y+ observation.

line:
writeCalibrationControls();

meaning:
after loading memory, update the dropdowns so the UI shows the same values.

====================================================================
function saveCalibration(logChange)
====================================================================

what it does:
this function saves the current calibration dropdown values into localStorage.

why:
the calibration should survive refresh.

logChange controls whether to show a console message.

code:
function saveCalibration(logChange) {
  readCalibrationFromControls();
  localStorage.setItem(ASSIST_CALIBRATION_STORAGE_KEY, JSON.stringify(controllerState.calibration));
  if (logChange) {
    logConsole(`Calibration saved: X+=${friendlyDirection(controllerState.calibration.xPositiveObserved)}, Y+=${friendlyDirection(controllerState.calibration.yPositiveObserved)}`, 'text-info');
  }
}

line:
function saveCalibration(logChange) {

meaning:
creates a function.
logChange is a boolean-like parameter.
true means log the save action.
false means save silently.

line:
readCalibrationFromControls();

meaning:
first read the current dropdown values and put them into controllerState.calibration.

line:
localStorage.setItem(ASSIST_CALIBRATION_STORAGE_KEY, JSON.stringify(controllerState.calibration));

meaning:
save calibration into browser storage.

localStorage.setItem(key, value):
stores text under a key.

ASSIST_CALIBRATION_STORAGE_KEY:
the key name.

JSON.stringify(controllerState.calibration):
turns the calibration object into text because localStorage stores text only.

line:
if (logChange) {

meaning:
only run the log message if logChange is true.

line:
logConsole(`Calibration saved: X+=${friendlyDirection(controllerState.calibration.xPositiveObserved)}, Y+=${friendlyDirection(controllerState.calibration.yPositiveObserved)}`, 'text-info');

meaning:
write a message in the visible console.

friendlyDirection(...):
turns left into LEFT, up into UP, etc.

text-info:
css class for info-colored console row.

====================================================================
function resetCalibration()
====================================================================

what it does:
this function clears calibration completely.

after this:
the app no longer knows what X+ or Y+ physically do.

code:
function resetCalibration() {
  controllerState.calibration = {
    xPositiveObserved: 'unknown',
    yPositiveObserved: 'unknown',
  };
  localStorage.removeItem(ASSIST_CALIBRATION_STORAGE_KEY);
  writeCalibrationControls();
}

line:
function resetCalibration() {

meaning:
creates a function with no parameters.

line:
controllerState.calibration = {

meaning:
replace calibration memory with a new default object.

line:
xPositiveObserved: 'unknown',

meaning:
X+ movement is unknown.

line:
yPositiveObserved: 'unknown',

meaning:
Y+ movement is unknown.

line:
localStorage.removeItem(ASSIST_CALIBRATION_STORAGE_KEY);

meaning:
delete saved calibration from browser storage.

line:
writeCalibrationControls();

meaning:
update the dropdowns so they show unknown too.

====================================================================
function getControllerConfigNumber(value, fallback)
====================================================================

what it does:
this function safely reads x_dir or y_dir from controller config.

why:
ESP32 config might send numbers as text.
example:
"1"
"-1"

the calibration math needs real numbers.

code:
function getControllerConfigNumber(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

line:
function getControllerConfigNumber(value, fallback) {

meaning:
creates a function.
value is the raw controller config value.
fallback is the value to use if parsing fails.

line:
const n = Number.parseInt(value, 10);

meaning:
try to convert value into an integer.

10 means base 10.

example:
Number.parseInt("1", 10) gives 1.
Number.parseInt("-1", 10) gives -1.
Number.parseInt("abc", 10) gives NaN.

line:
return Number.isFinite(n) ? n : fallback;

meaning:
if n is a valid number, return n.
if not, return fallback.

example:
getControllerConfigNumber("-1", 1) returns -1.
getControllerConfigNumber(undefined, 1) returns 1.

====================================================================
function deriveCalibration()
====================================================================

what it does:
this is the main calibration calculation function.

it builds the real meaning of the hardware.

it takes:
- saved X+ observation
- saved Y+ observation
- controller x_dir polarity
- controller y_dir polarity

and returns:
- what X observed
- what Y observed
- whether X/Y are pan or tilt
- what each firmware command really does
- text summaries for the UI

code:
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

line:
function deriveCalibration() {

meaning:
creates the function.
it has no parameters because it reads shared state directly.

line:
const xObserved = normalizeObservedDirection(controllerState.calibration.xPositiveObserved);

meaning:
read what the operator saved for X+,
clean it,
and store it in xObserved.

example:
if X+ physically moved left,
xObserved = 'left'.

line:
const yObserved = normalizeObservedDirection(controllerState.calibration.yPositiveObserved);

meaning:
same thing for Y+.

line:
const xRole = axisRoleFromDirection(xObserved);

meaning:
check if X movement is pan, tilt, or unknown.

example:
if xObserved is left,
xRole = 'pan'.

line:
const yRole = axisRoleFromDirection(yObserved);

meaning:
same thing for Y.

line:
const xDir = getControllerConfigNumber(controllerState.config && controllerState.config.x_dir, 1);

meaning:
read x_dir from controller config safely.

controllerState.config && controllerState.config.x_dir:
if controllerState.config exists, read x_dir.
if config does not exist, do not crash.

fallback 1:
if x_dir is missing or invalid, assume normal polarity.

line:
const yDir = getControllerConfigNumber(controllerState.config && controllerState.config.y_dir, 1);

meaning:
same thing for y_dir.

line:
const commands = {

meaning:
create an object that stores the real physical movement of each firmware command.

line:
step_right: commandDirectionFromRawPositive(xObserved, xDir),

meaning:
calculate what step_right physically does.

it uses:
xObserved = what X+ did.
xDir = firmware X polarity.

example:
if X+ moved left and xDir is 1,
step_right becomes left.

line:
step_left: commandDirectionFromRawPositive(xObserved, -xDir),

meaning:
calculate what step_left physically does.

-xDir means the opposite side of the X axis.

example:
if step_right is left,
step_left should become right.

line:
servo_up: commandDirectionFromRawPositive(yObserved, yDir),

meaning:
calculate what servo_up physically does using Y+ and yDir.

line:
servo_down: commandDirectionFromRawPositive(yObserved, -yDir),

meaning:
calculate what servo_down physically does using the opposite of yDir.

line:
let panSummary = 'unknown';

meaning:
start pan summary as unknown.
it will change only if X or Y is clearly pan.

line:
if (xRole === 'pan') panSummary = `X (+ => ${friendlyDirection(xObserved)})`;

meaning:
if X is horizontal movement,
show that X is pan.

example:
X (+ => LEFT)

line:
else if (yRole === 'pan') panSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

meaning:
if X was not pan but Y is horizontal,
show that Y is pan.

line:
let tiltSummary = 'unknown';

meaning:
start tilt summary as unknown.

line:
if (xRole === 'tilt') tiltSummary = `X (+ => ${friendlyDirection(xObserved)})`;

meaning:
if X is vertical movement,
show that X is tilt.

line:
else if (yRole === 'tilt') tiltSummary = `Y (+ => ${friendlyDirection(yObserved)})`;

meaning:
if X was not tilt but Y is vertical,
show that Y is tilt.

line:
const buttonSummary = MANUAL_BUTTON_COMMANDS

meaning:
start building a readable summary from the manual button mapping array.

line:
.map(({ button, command }) => `${button}=${friendlyDirection(commands[command])}`)

meaning:
for each manual button mapping,
take the visible button name and the firmware command.

({ button, command }) is destructuring.
it extracts button and command from an object.

example object:
{ button: 'Left', command: 'step_right' }

button = 'Left'
command = 'step_right'

commands[command]:
look up what that command physically does.

example:
commands['step_right'] gives 'left'.

friendlyDirection(...):
turns left into LEFT.

result example:
Left=LEFT

line:
.join(' | ');

meaning:
combine all button summary pieces into one string separated by |.

example:
Left=LEFT | Right=RIGHT | Up=UP | Down=DOWN

line:
return { xObserved, yObserved, xRole, yRole, xDir, yDir, commands, panSummary, tiltSummary, buttonSummary };

meaning:
return all calculated calibration information as one object.

this shorthand means:
{
  xObserved: xObserved,
  yObserved: yObserved,
  ...
}

====================================================================
function findManualButtonForDirection(direction, derived)
====================================================================

what it does:
this function finds which visible manual button should be pressed to move in a desired physical direction.

example:
detector says move left.
this function finds the button whose command really moves left after calibration.

code:
function findManualButtonForDirection(direction, derived) {
  const target = normalizeObservedDirection(direction);
  if (target === 'unknown') return null;
  return MANUAL_BUTTON_COMMANDS.find(({ command }) => derived.commands[command] === target) || null;
}

line:
function findManualButtonForDirection(direction, derived) {

meaning:
creates a function.
direction is the desired physical movement.
derived is the object returned from deriveCalibration().

line:
const target = normalizeObservedDirection(direction);

meaning:
clean the wanted direction.

line:
if (target === 'unknown') return null;

meaning:
if the wanted direction is invalid,
there is no button to return.

line:
return MANUAL_BUTTON_COMMANDS.find(({ command }) => derived.commands[command] === target) || null;

meaning:
search MANUAL_BUTTON_COMMANDS and find the first button whose command causes the target direction.

MANUAL_BUTTON_COMMANDS.find(...):
loops through button mappings and returns the first matching item.

({ command }):
take only the command property from each mapping.

derived.commands[command]:
checks what physical direction this command causes.

=== target:
compare it to the wanted direction.

|| null:
if no match was found, return null instead of undefined.

example:
target = 'left'
command = 'step_right'
derived.commands.step_right = 'left'
match found.

return example:
{ button: 'Left', command: 'step_right' }

====================================================================
function formatAxisAssist(axisName, parsedLabel, derived)
====================================================================

what it does:
this function turns one detector axis hint into readable operator button text.

example output:
Pan: HOLD
Pan: Left x1
Tilt: Up x2
Pan: LEFT_SMALL (finish calibration)

code:
function formatAxisAssist(axisName, parsedLabel, derived) {
  if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;
  const button = findManualButtonForDirection(parsedLabel.direction, derived);
  const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`;
  if (!button) return `${axisName}: ${moveText} (finish calibration)`;
  return `${axisName}: ${button.button} x${parsedLabel.taps}`;
}

line:
function formatAxisAssist(axisName, parsedLabel, derived) {

meaning:
creates a function.

axisName:
text like Pan or Tilt.

parsedLabel:
object from parseSimLabel().
contains direction, size, taps.

derived:
object from deriveCalibration().
used to translate direction into real button.

line:
if (!parsedLabel || parsedLabel.direction === 'hold') return `${axisName}: HOLD`;

meaning:
if there is no parsed label,
or the detector says hold,
return text like:
Pan: HOLD

line:
const button = findManualButtonForDirection(parsedLabel.direction, derived);

meaning:
find which manual button causes the requested direction.

example:
direction is left.
function returns button Left if calibration says Left button moves left.

line:
const moveText = `${friendlyDirection(parsedLabel.direction)}_${parsedLabel.size}`;

meaning:
create fallback movement text.

example:
direction left + size SMALL becomes:
LEFT_SMALL

line:
if (!button) return `${axisName}: ${moveText} (finish calibration)`;

meaning:
if no matching button was found,
show the movement text but warn that calibration is not complete.

example:
Pan: LEFT_SMALL (finish calibration)

line:
return `${axisName}: ${button.button} x${parsedLabel.taps}`;

meaning:
return the actual operator instruction.

example:
Pan: Left x1

button.button:
visible button name.

parsedLabel.taps:
how many times to press.

====================================================================
function describeFramePosition(normX, normY, deadZone)
====================================================================

what it does:
this function describes where the target appears inside the frame.

it does not tell which button to press.
it only says target position.

examples:
Centered
right of center
above-left of center
below-right of center

code:
function describeFramePosition(normX, normY, deadZone) {
  const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : '';
  const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : '';
  if (!horizontal && !vertical) return 'Centered';
  if (vertical && horizontal) return `${vertical}-${horizontal} of center`;
  return `${vertical || horizontal} of center`;
}

line:
function describeFramePosition(normX, normY, deadZone) {

meaning:
creates a function.

normX:
horizontal normalized offset from center.

normY:
vertical normalized offset from center.

deadZone:
small center tolerance where movement is treated as centered.

line:
const horizontal = normX > deadZone ? 'right' : normX < -deadZone ? 'left' : '';

meaning:
if normX is bigger than deadZone,
target is right.

else if normX is smaller than negative deadZone,
target is left.

otherwise:
horizontal is empty.

line:
const vertical = normY > deadZone ? 'above' : normY < -deadZone ? 'below' : '';

meaning:
if normY is bigger than deadZone,
target is above.

else if normY is smaller than negative deadZone,
target is below.

otherwise:
vertical is empty.

line:
if (!horizontal && !vertical) return 'Centered';

meaning:
if there is no horizontal offset and no vertical offset,
the target is centered enough.

line:
if (vertical && horizontal) return `${vertical}-${horizontal} of center`;

meaning:
if both vertical and horizontal exist,
combine them.

example:
above-left of center

line:
return `${vertical || horizontal} of center`;

meaning:
if only one direction exists,
use that one.

example:
right of center

====================================================================
function updateCalibrationReadouts()
====================================================================

what it does:
this function updates the calibration status card in the UI.

it shows:
- controller polarity config
- pan axis summary
- tilt axis summary
- button meaning summary

code:
function updateCalibrationReadouts() {
  const derived = deriveCalibration();
  if (controllerConfigVal) {
    setReadout(controllerConfigVal, controllerState.config ? `x_dir=${derived.xDir}, y_dir=${derived.yDir}` : 'n/a');
  }
  setReadout(calibrationPanVal, derived.panSummary);
  setReadout(calibrationTiltVal, derived.tiltSummary);
  setReadout(calibrationButtonsVal, derived.buttonSummary);
}

line:
function updateCalibrationReadouts() {

meaning:
creates a function with no parameters.

line:
const derived = deriveCalibration();

meaning:
calculate the current full calibration meaning.

derived now contains:
xDir
yDir
panSummary
tiltSummary
buttonSummary
commands
and more.

line:
if (controllerConfigVal) {

meaning:
only update controllerConfigVal if that UI element exists.

line:
setReadout(controllerConfigVal, controllerState.config ? `x_dir=${derived.xDir}, y_dir=${derived.yDir}` : 'n/a');

meaning:
write text into the controller config readout.

if controllerState.config exists:
show x_dir and y_dir.

if controllerState.config is missing:
show n/a.

setReadout:
safe UI helper that writes text only when the element exists.

line:
setReadout(calibrationPanVal, derived.panSummary);

meaning:
show which axis is pan.

example:
X (+ => LEFT)

line:
setReadout(calibrationTiltVal, derived.tiltSummary);

meaning:
show which axis is tilt.

example:
Y (+ => UP)

line:
setReadout(calibrationButtonsVal, derived.buttonSummary);

meaning:
show what each visible button physically does.

example:
Left=LEFT | Right=RIGHT | Up=UP | Down=DOWN

====================================================================
function updateOperatorAssistReadout()
====================================================================

what it does:
this function updates the operator assist card.

it takes current detector state and calibration state,
then shows the operator:
- if there is no target
- where the target is
- what movement is needed
- what button to press
- whether the target is centered

this is the final function that turns AI tracking into human guidance.

code:
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

line:
function updateOperatorAssistReadout() {

meaning:
creates the function.
it has no parameters because it reads shared app state directly.

line:
const derived = deriveCalibration();

meaning:
calculate the current real hardware meaning.

derived tells this function:
- what X+ and Y+ mean
- what every firmware command physically does
- which button moves left/right/up/down

why needed here:
the detector only says directions like left/up.
derived lets the UI translate that into real buttons.

line:
const settings = getSettings();

meaning:
read the current detector settings.

settings contains values like:
deadZone
thresholds
profile
backend

why needed here:
this function uses settings.deadZone to describe if the target is centered enough.

line:
if (!trackingState.hasTarget) {

meaning:
check if there is currently no selected target.

trackingState.hasTarget:
true means detector has a current target.
false means no target.

! means NOT.

so:
if !trackingState.hasTarget
means:
if there is no target.

line:
setReadout(assistMoveVal, 'No target');

meaning:
write "No target" in the movement guidance field.

line:
setReadout(assistFrameVal, 'No target');

meaning:
write "No target" in the frame position field.

line:
setReadout(assistButtonVal, derived.xObserved === 'unknown' || derived.yObserved === 'unknown' ? 'Run calibration' : 'Wait for target');

meaning:
decide what button guidance should say when there is no target.

condition:
derived.xObserved === 'unknown' || derived.yObserved === 'unknown'

means:
if X calibration is unknown OR Y calibration is unknown.

if true:
show "Run calibration".

if false:
show "Wait for target".

why:
if calibration is missing, the operator should calibrate first.
if calibration is ready, the operator should just wait for detection.

line:
setReadout(assistCenterVal, 'Not centered');

meaning:
when there is no target, the system cannot say it is centered.
so it shows Not centered.

line:
return;

meaning:
stop the function here.
there is no target, so the rest of the target logic should not run.

line:
const panAssist = parseSimLabel(trackingState.simPanLabel);

meaning:
read the detector pan movement label and parse it.

example:
trackingState.simPanLabel = 'LEFT_SMALL'

parseSimLabel returns:
direction: left
size: SMALL
taps: 1

pan means horizontal correction.

line:
const tiltAssist = parseSimLabel(trackingState.simTiltLabel);

meaning:
read the detector tilt movement label and parse it.

example:
trackingState.simTiltLabel = 'UP_MED'

parseSimLabel returns:
direction: up
size: MED
taps: 2

tilt means vertical correction.

line:
const centered = panAssist.direction === 'hold' && tiltAssist.direction === 'hold';

meaning:
target is centered only if both axes say hold.

panAssist.direction === 'hold':
horizontal movement is not needed.

tiltAssist.direction === 'hold':
vertical movement is not needed.

&& means both must be true.

line:
const framePosition = describeFramePosition(trackingState.filteredNormX, trackingState.filteredNormY, settings.deadZone);

meaning:
create readable text that says where the target is in the frame.

trackingState.filteredNormX:
smoothed horizontal target offset.

trackingState.filteredNormY:
smoothed vertical target offset.

settings.deadZone:
how close to center counts as centered.

example result:
above-right of center

line:
if (centered) {

meaning:
if both pan and tilt are hold,
run the centered UI case.

line:
setReadout(assistMoveVal, trackingState.isPossible ? 'Centered (possible)' : 'Centered');

meaning:
write centered movement status.

if trackingState.isPossible is true:
show Centered (possible).

if false:
show Centered.

possible means the detection is weaker/not fully strong.

line:
setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);

meaning:
show where the target is in the frame.
if the target is only possible, add "(possible)".

line:
setReadout(assistButtonVal, 'Hold position');

meaning:
tell operator not to press movement buttons.

line:
setReadout(assistCenterVal, 'Centered');

meaning:
show that the target is centered.

line:
return;

meaning:
stop the function because centered case is finished.

line:
const moveParts = [];

meaning:
create an empty array to collect movement text.

example later:
['PAN LEFT_SMALL', 'TILT UP_MED']

line:
if (panAssist.direction !== 'hold') moveParts.push(`PAN ${friendlyDirection(panAssist.direction)}_${panAssist.size}`);

meaning:
if pan is not hold,
add a pan movement instruction.

friendlyDirection(panAssist.direction):
turns left into LEFT.

panAssist.size:
SMALL, MED, or LARGE.

example result:
PAN LEFT_SMALL

line:
if (tiltAssist.direction !== 'hold') moveParts.push(`TILT ${friendlyDirection(tiltAssist.direction)}_${tiltAssist.size}`);

meaning:
if tilt is not hold,
add a tilt movement instruction.

example:
TILT UP_MED

line:
setReadout(assistMoveVal, moveParts.join(' / '));

meaning:
combine all movement parts into one string and show it.

join(' / '):
puts " / " between array items.

example:
PAN LEFT_SMALL / TILT UP_MED

line:
setReadout(assistFrameVal, trackingState.isPossible ? `${framePosition} (possible)` : framePosition);

meaning:
show frame position.
if detection is only possible, add "(possible)".

line:
const buttonParts = [];

meaning:
create an empty array for actual button instructions.

example later:
['Pan: Left x1', 'Tilt: Up x2']

line:
if (panAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Pan', panAssist, derived));

meaning:
if pan needs movement,
convert pan detector hint into real button text.

formatAxisAssist uses:
- axis name: Pan
- parsed pan label
- derived calibration

example result:
Pan: Left x1

line:
if (tiltAssist.direction !== 'hold') buttonParts.push(formatAxisAssist('Tilt', tiltAssist, derived));

meaning:
same thing for tilt movement.

example result:
Tilt: Up x2

line:
setReadout(assistButtonVal, buttonParts.join(' / '));

meaning:
combine button instructions and show them.

example:
Pan: Left x1 / Tilt: Up x2

line:
setReadout(assistCenterVal, trackingState.isPossible ? 'Off-center (possible)' : 'Off-center');

meaning:
show that target is not centered.
if the target is only possible, mark it as possible.

====================================================================
quick example for the whole file
====================================================================

calibration:
X+ = left
Y+ = up

controller config:
x_dir = 1
y_dir = 1

deriveCalibration result:
step_right = left
step_left = right
servo_up = up
servo_down = down

detector state:
simPanLabel = LEFT_SMALL
simTiltLabel = HOLD

parseSimLabel gives:
pan direction left
pan size SMALL
pan taps 1

findManualButtonForDirection finds:
Left button

operator assist shows:
movement:
PAN LEFT_SMALL

button:
Pan: Left x1

center:
Off-center

====================================================================
one sentence exam answer
====================================================================

20-calibration-and-target-guide.js translates calibration observations and detector movement labels into readable pan/tilt summaries and real button instructions for the operator.

WHO-CALLS:
- html/control.html loads this file.
- 40-init.js calls loadCalibration(), saveCalibration(), resetCalibration(), updateCalibrationReadouts(), and updateOperatorAssistReadout().
- 30-transport.js uses getControllerConfigNumber() and refreshes the readouts from this file after config loads.
- 60-calculate-target-position.js uses parseSimLabel() and friendlyDirection().
- 100-follow-automation.js uses deriveCalibration(), parseSimLabel(), findManualButtonForDirection(), and getControllerConfigNumber().
*/
