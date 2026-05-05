// FILE ROLE: 20-calibration.js
// What this file does:
// - Stores and interprets calibration observations such as what X+ and Y+ really did physically.
// - Figures out pan axis, tilt axis, and the real meaning of the visible movement buttons.
// - Builds operator-assist messages like which way the target is off-center and which button the user should press.
// Why this file exists:
// - The rig's physical movement can differ from raw firmware command names.
// - This file turns hardware behavior into understandable human guidance.
// Section: calibration and operator assist.
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
EXAM COMMENT GLOSSARY FOR 20-calibration.js CALIBRATION AND OPERATOR ASSIST

20-calibration.js:
This file handles calibration and operator-assist logic. It does not run AI detection and does not send automatic movement. It translates physical rig behavior into readable UI guidance, so the operator can understand what direction the rig moves and which manual button matches detector guidance.

calibration:
Calibration means checking what the real rig does when the firmware moves X or Y. The code needs this because a command like X+ might physically move left, right, up, or down depending on wiring, servo mounting, and firmware polarity.

operator assist:
Operator assist is the UI guidance that tells the user where the target is and what manual movement/button would help center it. It is guidance only.

normalizeObservedDirection:
Cleans a direction value. It only accepts left, right, up, down. Anything else becomes unknown. This prevents invalid saved data or broken select-box values from entering calibration logic.

value:
The raw direction text from saved calibration or from a dropdown.

['left', 'right', 'up', 'down'].includes(value):
Checks whether value is one of the four valid movement directions.

unknown:
Fallback direction used when calibration is missing, invalid, or incomplete.

getOppositeDirection:
Returns the opposite physical direction. left becomes right, right becomes left, up becomes down, and down becomes up. If the direction is unknown, it returns unknown.

direction:
The direction that needs to be flipped.

switch:
JavaScript structure used to return different values depending on direction.

axisRoleFromDirection:
Decides whether an observed movement belongs to pan, tilt, or unknown. left/right means pan. up/down means tilt. unknown means the axis role cannot be determined.

pan:
Horizontal movement axis. Pan means left/right movement.

tilt:
Vertical movement axis. Tilt means up/down movement.

friendlyDirection:
Turns known directions into uppercase display labels, like LEFT, RIGHT, UP, DOWN. If the direction is invalid or unknown, it returns unknown.

direction.toUpperCase:
Converts text to uppercase for cleaner UI labels.

commandDirectionFromRawPositive:
Combines observed positive-axis direction with firmware polarity. It answers: “If this command is sent, what real physical direction will the rig move?”

rawPositiveDirection:
The physical movement observed when the positive side of an axis was tested, for example X+ moved left.

signedFactor:
Firmware polarity multiplier. Positive keeps the direction. Negative flips it.

raw:
The cleaned observed positive direction after normalizeObservedDirection.

signedFactor >= 0:
Means keep the original observed direction.

getOppositeDirection(raw):
Used when polarity is negative, so the movement direction flips.

parseSimLabel:
Parses detector movement labels like LEFT_SMALL, RIGHT_MED, UP_LARGE, or HOLD. It converts the label into direction, size, and suggested number of taps.

label:
The simulated movement label produced by detection logic.

HOLD:
Means no movement is needed on that axis because the target is close enough to center.

directionRaw:
The first part of a movement label before the underscore. Example: LEFT in LEFT_SMALL.

sizeRaw:
The second part of a movement label after the underscore. Example: SMALL in LEFT_SMALL.

String(label).split('_'):
Splits labels like LEFT_SMALL into two parts: LEFT and SMALL.

direction:
Lowercase movement direction from the label.

size:
Uppercase movement size from the label. Usually SMALL, MED, or LARGE.

taps:
Suggested number of manual button taps. SMALL gives 1 tap, MED gives 2 taps, LARGE gives 3 taps.

size === 'LARGE' ? 3 : size === 'MED' ? 2 : 1:
Ternary logic that converts movement size into tap count.

readCalibrationFromControls:
Reads the X+ and Y+ calibration dropdowns from the page and saves the cleaned values into controllerState.calibration.

controllerState:
Shared controller-related state object. It stores controller config and calibration notes.

controllerState.calibration:
Object storing the operator’s calibration observations.

xPositiveObserved:
The observed physical direction when X positive was tested.

yPositiveObserved:
The observed physical direction when Y positive was tested.

xObservedSelect:
Dropdown where the operator selects what X+ physically did.

yObservedSelect:
Dropdown where the operator selects what Y+ physically did.

writeCalibrationControls:
Writes the saved calibration values back into the dropdowns. Used when the page loads or calibration resets.

loadCalibration:
Loads saved calibration notes from localStorage. If saved JSON is broken or missing, it uses safe unknown values.

saved:
Parsed calibration object loaded from localStorage.

JSON.parse:
Converts a JSON string back into a JavaScript object.

localStorage.getItem:
Reads saved data from browser localStorage.

ASSIST_CALIBRATION_STORAGE_KEY:
localStorage key where calibration notes are saved.

try/catch in loadCalibration:
Prevents broken saved JSON from crashing the page.

console.warn:
Logs a warning in the browser console without stopping the app.

saveCalibration:
Saves the current calibration dropdown values into localStorage. It can also write a confirmation message to the event console.

logChange:
Boolean parameter. If true, saveCalibration logs a confirmation message. If false, it saves quietly.

readCalibrationFromControls in saveCalibration:
Copies the current dropdown values into controllerState before saving.

localStorage.setItem:
Saves a string value in browser storage.

JSON.stringify:
Converts controllerState.calibration into a JSON string for localStorage.

Calibration saved:
Console message showing saved X+ and Y+ observations.

resetCalibration:
Clears saved calibration notes and resets both X+ and Y+ observations to unknown.

localStorage.removeItem:
Deletes saved calibration from browser storage.

writeCalibrationControls in resetCalibration:
Updates the dropdowns so they visually show unknown after reset.

getControllerConfigNumber:
Safely parses a controller config value into an integer. If parsing fails, it returns a fallback.

value:
Raw config value from controller config. It might be a number or a string.

fallback:
Default value used if parsing fails.

Number.parseInt(value, 10):
Parses value as a base-10 integer.

Number.isFinite:
Checks whether the parsed number is valid and not NaN or Infinity.

deriveCalibration:
The main calibration interpretation function. It combines operator observations with firmware polarity values and produces real movement meaning for commands and buttons.

xObserved:
Cleaned physical direction observed when X+ was probed.

yObserved:
Cleaned physical direction observed when Y+ was probed.

xRole:
Whether X behaves like pan, tilt, or unknown.

yRole:
Whether Y behaves like pan, tilt, or unknown.

xDir:
Firmware polarity multiplier for X axis. Read from controllerState.config.x_dir. Defaults to 1.

yDir:
Firmware polarity multiplier for Y axis. Read from controllerState.config.y_dir. Defaults to 1.

controllerState.config:
Controller firmware config object loaded from the ESP32.

controllerState.config.x_dir:
Firmware X-axis polarity value.

controllerState.config.y_dir:
Firmware Y-axis polarity value.

commands:
Object that maps firmware HTTP commands to real physical directions after calibration and polarity are applied.

commands.step_right:
Real physical movement caused by the step_right endpoint.

commands.step_left:
Real physical movement caused by the step_left endpoint.

commands.servo_up:
Real physical movement caused by the servo_up endpoint.

commands.servo_down:
Real physical movement caused by the servo_down endpoint.

step_right:
Firmware command usually related to X movement.

step_left:
Firmware command usually related to opposite X movement.

servo_up:
Firmware command usually related to Y movement.

servo_down:
Firmware command usually related to opposite Y movement.

panSummary:
Readable summary of which axis acts as pan. Example: X (+ => LEFT).

tiltSummary:
Readable summary of which axis acts as tilt. Example: Y (+ => UP).

buttonSummary:
Readable summary explaining what each visible manual button really does after calibration.

MANUAL_BUTTON_COMMANDS:
Array that maps visible button names to firmware command names. deriveCalibration uses it to build the button summary and operator assist uses it to find matching buttons.

map:
Array method that transforms each item into a new value.

join(' | '):
Combines button summary parts into one readable string separated by vertical bars.

findManualButtonForDirection:
Finds which visible manual button should be pressed for a desired physical movement direction.

direction in findManualButtonForDirection:
The desired physical movement direction, like left, right, up, or down.

derived:
The object returned by deriveCalibration. It includes the real direction caused by each command.

target:
Cleaned requested direction.

MANUAL_BUTTON_COMMANDS.find:
Searches the manual button list and returns the first button whose command creates the desired physical direction.

derived.commands[command]:
The real physical direction produced by a firmware command.

formatAxisAssist:
Turns one parsed detector movement hint into operator-friendly text. It can return HOLD, a calibrated button instruction, or a warning to finish calibration.

axisName:
Readable axis name, usually Pan or Tilt.

parsedLabel:
Parsed detector sim label from parseSimLabel.

button:
Matching manual button returned by findManualButtonForDirection.

moveText:
Fallback text like LEFT_SMALL or UP_MED when calibration is incomplete.

finish calibration:
Message shown when the code cannot translate detector movement into a real button because calibration is incomplete.

`${axisName}: ${button.button} x${parsedLabel.taps}`:
Final calibrated button instruction. Example: Pan: Left x2.

describeFramePosition:
Creates a simple text description of where the target is in the frame, using normalized x/y offsets and deadZone.

normX:
Normalized horizontal target offset from -1 to 1.

normY:
Normalized vertical target offset from -1 to 1.

deadZone:
Center tolerance. If the offset is inside this area, the target is treated as centered on that axis.

horizontal:
Text result for x position: right, left, or empty.

vertical:
Text result for y position: above, below, or empty.

Centered:
Returned when both horizontal and vertical offsets are inside the dead zone.

above-right of center:
Example output when the target is above and right of the center.

updateCalibrationReadouts:
Updates the calibration status card in the UI. It shows controller config, pan axis summary, tilt axis summary, and button meaning summary.

derived in updateCalibrationReadouts:
Current calibration interpretation returned by deriveCalibration.

controllerConfigVal:
HUD field showing controller config values like x_dir and y_dir.

calibrationPanVal:
HUD field showing which axis acts as pan.

calibrationTiltVal:
HUD field showing which axis acts as tilt.

calibrationButtonsVal:
HUD field showing what each manual button physically does.

setReadout:
Helper that safely writes text into a UI element.

n/a:
Means not available, usually because controller config is missing.

updateOperatorAssistReadout:
Rebuilds the operator assist card from current calibration and current detection tracking state.

trackingState:
Shared detection state object. It tells whether a target exists and stores movement hints.

trackingState.hasTarget:
True when there is an active target.

trackingState.simPanLabel:
Horizontal detector movement hint, like HOLD, LEFT_SMALL, or RIGHT_MED.

trackingState.simTiltLabel:
Vertical detector movement hint, like HOLD, UP_SMALL, or DOWN_MED.

trackingState.filteredNormX:
Smoothed normalized horizontal target offset.

trackingState.filteredNormY:
Smoothed normalized vertical target offset.

trackingState.isPossible:
True when target is possible/weak rather than strong.

settings:
Current detector settings from getSettings.

getSettings:
Reads current detection settings, including deadZone.

settings.deadZone:
Center tolerance used by describeFramePosition.

No target:
Assist text shown when no active target exists.

Run calibration:
Assist button text shown when there is no target and calibration is incomplete.

Wait for target:
Assist button text shown when calibration is ready but no target exists.

assistMoveVal:
UI field showing detector-style movement, like PAN LEFT_SMALL / TILT UP_MED.

assistFrameVal:
UI field showing target position in frame, like above-right of center.

assistButtonVal:
UI field showing actual manual button hints, like Pan: Left x2.

assistCenterVal:
UI field showing whether the target is centered or off-center.

panAssist:
Parsed version of trackingState.simPanLabel.

tiltAssist:
Parsed version of trackingState.simTiltLabel.

centered:
True when both pan and tilt directions are hold.

framePosition:
Plain-language target location returned by describeFramePosition.

Centered (possible):
Assist text shown when a possible target is centered.

Hold position:
Button guidance shown when the target is already centered.

moveParts:
Array of detector-style movement instructions.

PAN:
Prefix used for horizontal movement guidance.

TILT:
Prefix used for vertical movement guidance.

buttonParts:
Array of concrete manual button instructions.

formatAxisAssist('Pan', panAssist, derived):
Converts pan guidance into a manual button instruction.

formatAxisAssist('Tilt', tiltAssist, derived):
Converts tilt guidance into a manual button instruction.

Off-center:
Means the target is outside the dead zone and needs movement guidance.

Off-center (possible):
Means a possible/weak target is outside the dead zone.

exam summary:
This file turns calibration observations into useful operator guidance. normalizeObservedDirection cleans direction input. getOppositeDirection and commandDirectionFromRawPositive handle polarity. axisRoleFromDirection decides pan vs tilt. parseSimLabel turns labels like LEFT_SMALL into direction/size/taps. loadCalibration, saveCalibration, and resetCalibration persist setup notes. deriveCalibration explains what each firmware command and manual button really does. updateCalibrationReadouts updates calibration UI. updateOperatorAssistReadout converts detector movement hints into readable frame position and manual button guidance.
*/