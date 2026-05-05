// FILE ROLE: 70-detection-overlay.js
// This file owns detector drawing and target commit logic: it renders the overlay, writes selected-target values
// into the shared tracking state, updates the HUD readouts, and appends per-frame telemetry entries.
function drawScene(detections, selected) {
  // Drawing layers:
  // 1. Clear the canvas and redraw the center reticle.
  // 2. Draw every visible detection box so the operator sees model output, not just the chosen target.
  // 3. Color-code boxes by importance.
  // 4. If a target is locked, draw the center-to-target line and the simulated move summary.
  if (!(overlayCtx && overlayCanvas)) return;
  // Always resize/clear/redraw in that order so stale geometry never remains on screen.
  syncOverlaySize();
  clearOverlay();
  drawReticle();
  overlayCtx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  overlayCtx.textBaseline = 'top';
  detections.forEach((det) => {
    if (!det.metrics) return;
    const isSelected = det === selected; // True only for the detection currently chosen as the tracked target.
    // Selected target = blue, strong candidate = red, possible candidate = amber, other detection = green.
    const stroke = isSelected ? '#38bdf8' : det.isStrong ? '#ff4d4d' : det.isCandidate ? '#f59e0b' : '#22c55e'; // Per-box color chosen by target importance.
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = isSelected ? 3 : 2;
    overlayCtx.setLineDash(det.isCandidate && !det.isStrong && !isSelected ? [5, 3] : []);
    overlayCtx.strokeRect(det.metrics.x, det.metrics.y, det.metrics.w, det.metrics.h);
    // Non-candidate detections still get drawn so the operator can see what the model is seeing.
    const prefix = isSelected ? 'TRACK ' : det.isStrong ? 'TARGET ' : det.isCandidate ? 'POSSIBLE ' : ''; // Text prefix that tells the operator how important this box is.
    const label = `${prefix}${det.class} ${((det.score || 0) * 100).toFixed(1)}%`; // Full overlay label shown above the box.
    const width = overlayCtx.measureText(label).width + 8; // Background width needed for the label text plus padding.
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(det.metrics.x, Math.max(0, det.metrics.y - 16), width, 16);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(label, det.metrics.x + 4, Math.max(0, det.metrics.y - 15));
    overlayCtx.restore();
  });
  if (trackingState.hasTarget) {
    // When a target is locked, also draw a line from the screen center to the filtered target center.
    const cx = overlayCanvas.width / 2; // Horizontal center of the visible overlay.
    const cy = overlayCanvas.height / 2; // Vertical center of the visible overlay.
    overlayCtx.save();
    overlayCtx.strokeStyle = trackingState.isPossible ? '#f59e0b' : '#38bdf8';
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx, cy);
    overlayCtx.lineTo(trackingState.filteredCenterX, trackingState.filteredCenterY);
    overlayCtx.stroke();
    const text = `SIM ${trackingState.simPanLabel} / ${trackingState.simTiltLabel}`; // Compact simulated movement summary drawn into the overlay.
    overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.fillRect(10, 10, overlayCtx.measureText(text).width + 12, 18);
    overlayCtx.fillStyle = '#f8fafc';
    overlayCtx.fillText(text, 16, 12);
    overlayCtx.restore();
  }
}

// updateSelectedTarget bridges raw detections into the HUD, operator assist, and exported telemetry.
/**
 * @param {object} selected - Detection chosen as the tracked target.
 * @param {object} settings - Active detector settings.
 * @param {number} loopMs - Measured duration of the current detection pass.
 */
// EXAM: commit the chosen target into shared state.
function updateSelectedTarget(selected, settings, loopMs) {
  // This is the handoff point from "model result" to "shared app state".
  // After this function runs:
  // - trackingState holds the official target
  // - HUD cards show its position/score
  // - operator assist can rebuild from trackingState alone
  // Smooth the raw target center first so the UI is less jittery.
  const filtered = smoothMetrics(selected.metrics, settings); // Smoothed version of the selected target geometry.
  // Convert the filtered offset into manual movement hints.
  const sim = simCommand(filtered, settings); // Simulated pan/tilt guidance derived from the smoothed geometry.
  // Cache the chosen target and all derived values into shared runtime state.
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
  // Mirror that cached state into the visible readout cards.
  setReadout(targetLabelVal, selected.isStrong ? selected.class : `Possible ${selected.class}`);
  setReadout(targetScoreVal, `${((selected.score || 0) * 100).toFixed(1)}%`);
  setReadout(targetCenterVal, formatPoint(selected.metrics.centerX, selected.metrics.centerY));
  setReadout(targetCenterFilteredVal, formatPoint(filtered.centerX, filtered.centerY));
  setReadout(targetDeltaVal, formatPoint(filtered.deltaX, filtered.deltaY));
  setReadout(targetDeltaNormVal, formatNorm(filtered.normX, filtered.normY));
  setReadout(simCommandVal, `${sim.panLabel} (${sim.pan.toFixed(2)}) / ${sim.tiltLabel} (${sim.tilt.toFixed(2)})`);
  setReadout(loopTimeVal, loopMs.toFixed(1));
  // control.js owns the assist card, but it rebuilds from this shared tracking state.
  updateOperatorAssistReadout();
}

/**
 * @param {object} entry - Telemetry row to append to the rolling session buffer.
 */
// EXAM: append one telemetry row.
function pushTelemetry(entry) {
  sessionTelemetry.push(entry);
  // Keep telemetry bounded in memory so a long session does not slowly grow the page footprint forever.
  while (sessionTelemetry.length > MAX_TELEMETRY) sessionTelemetry.shift();
}

// The detection loop yields back to the browser between frames so UI and fetch handlers stay responsive.
/**
 * @returns {Promise<void>} Resolves after yielding one frame back to the browser event loop.
 */
// EXAM: yield control back to the browser.
async function yieldToBrowser() {
  if (window.tf && typeof tf.nextFrame === 'function') {
    try {
      // tf.nextFrame is TensorFlow's preferred way to yield in graphics-heavy loops.
      await tf.nextFrame();
      return;
    } catch (err) {
      console.warn('tf.nextFrame() failed, falling back to requestAnimationFrame.', err);
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Section: frame preparation and backend normalization.
// Input preparation handles either low-resolution TF.js detection or the padded ONNX path.
/**
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}|null} Reusable off-screen surface.
 */
// EXAM: prepare reusable off-screen canvas.
function ensureDetectSourceSurface() {
  // Lazily create one reusable off-screen canvas instead of allocating a new one every frame.
  if (!detectSourceCanvas) detectSourceCanvas = document.createElement('canvas');
  if (!detectSourceCtx && detectSourceCanvas) detectSourceCtx = detectSourceCanvas.getContext('2d', { alpha: false });
  return detectSourceCanvas && detectSourceCtx ? { canvas: detectSourceCanvas, ctx: detectSourceCtx } : null;
}






/*
EXAM COMMENT GLOSSARY FOR DETECTION OVERLAY, TARGET STATE, TELEMETRY, AND BROWSER YIELDING

70-detection-overlay.js:
This file is responsible for drawing detections on the overlay canvas, committing the selected target into trackingState, updating HUD readouts, appending telemetry rows, yielding back to the browser, and preparing a reusable off-screen canvas.

drawScene:
Draws the visual detection overlay for one frame. It clears old drawings, draws the center reticle, draws every detection box, color-codes boxes by importance, writes labels above boxes, and if a target is locked, draws a line from screen center to the filtered target center plus the simulated movement text.

detections:
Array of detection objects to draw. These detections already passed basic filtering and usually contain class, score, metrics, isCandidate, and isStrong.

selected:
The one detection chosen as the tracked target. It is highlighted differently from the other detections. If selected is null, the function draws detections but no tracked target.

overlayCtx:
The 2D canvas drawing context used to draw rectangles, text, lines, and filled backgrounds on overlayCanvas.

overlayCanvas:
The transparent canvas placed above the camera feed. Detection boxes, reticle, target lines, and movement text are drawn on it.

if (!(overlayCtx && overlayCanvas)) return:
Guard check. If the canvas or drawing context does not exist, drawing cannot happen, so the function stops.

syncOverlaySize:
Resizes overlayCanvas so it matches the displayed camera area. This prevents boxes from being drawn in the wrong position after resize or layout changes.

clearOverlay:
Clears old drawings from the overlay canvas so previous boxes do not remain on screen.

drawReticle:
Draws the fixed center reticle/crosshair. This helps the operator compare the target position to the screen center.

overlayCtx.font:
Sets the font used for detection labels drawn on the canvas.

IBM Plex Mono:
The monospace font used for technical overlay text, making labels look consistent with the dashboard.

overlayCtx.textBaseline:
Controls how text is positioned vertically. top means the y coordinate is the top of the text box.

detections.forEach:
Loops through every detection and draws it on the overlay.

det:
One detection object inside the detections array.

det.metrics:
The screen-space geometry of the detection. It contains x, y, w, h, centerX, centerY, deltaX, deltaY, normX, and normY. If metrics is missing, the box cannot be drawn.

if (!det.metrics) return:
Skips this detection if it has no valid screen-space geometry.

isSelected:
True when the current detection object is the same object as selected. It means this detection is the tracked target.

stroke:
The color used for the detection rectangle. It changes based on importance: selected target, strong candidate, possible candidate, or other detection.

#38bdf8:
Blue color used for the selected tracked target.

#ff4d4d:
Red color used for strong target candidates.

#f59e0b:
Amber color used for possible target candidates.

#22c55e:
Green color used for other visible detections that are not target candidates.

det.isStrong:
True when the detection passed the strong confidence threshold. Strong detections are considered real target-level detections.

det.isCandidate:
True when the detection class is allowed by the current profile and passed the possible threshold. Candidate detections can compete to become selected.

overlayCtx.save:
Saves the current canvas drawing state. This lets the code change colors, line width, and dash style temporarily.

overlayCtx.restore:
Restores the previous canvas drawing state after drawing one detection. This prevents styles from leaking into the next drawing operation.

overlayCtx.strokeStyle:
Sets the color for lines and rectangle outlines.

overlayCtx.lineWidth:
Sets the thickness of drawn lines. Selected target uses thicker line width than normal boxes.

overlayCtx.setLineDash:
Controls dashed lines. Possible-but-not-strong candidates use dashed boxes to show weaker confidence.

[5, 3]:
Dash pattern for the canvas line. It means 5 pixels drawn, 3 pixels gap, repeated.

overlayCtx.strokeRect:
Draws only the outline of the detection rectangle. It uses det.metrics.x, det.metrics.y, det.metrics.w, and det.metrics.h.

prefix:
Text prefix added before the class label. It can be TRACK, TARGET, POSSIBLE, or empty.

TRACK:
Overlay prefix for the selected target currently being tracked.

TARGET:
Overlay prefix for strong target candidates.

POSSIBLE:
Overlay prefix for possible target candidates.

label:
The full text drawn above the box. It contains prefix, class name, and confidence percent, for example TRACK drone 82.4%.

det.class:
The detected object class label, for example drone, aircraft, helicopter, bird, or kite.

det.score:
The confidence score of this detection. It is multiplied by 100 to show a percentage.

toFixed(1):
Formats a number with one digit after the decimal point. Used for confidence percentage.

overlayCtx.measureText:
Measures how wide the label text will be on the canvas. This lets the code draw a background rectangle behind the text.

width:
The width of the label background rectangle. It is measured text width plus padding.

overlayCtx.fillStyle:
Sets the fill color for filled rectangles and text.

rgba(0,0,0,0.7):
Semi-transparent black. Used as the background behind overlay labels so text stays readable over the camera feed.

overlayCtx.fillRect:
Draws a filled rectangle. Here it draws the dark background behind the label text.

Math.max(0, det.metrics.y - 16):
Keeps the label background from being drawn above the top edge of the canvas.

#f8fafc:
Light text color used for overlay labels.

overlayCtx.fillText:
Draws text on the canvas.

trackingState.hasTarget:
True when the system currently has a locked target. If true, drawScene also draws the line from center to target and simulated movement text.

cx:
The x coordinate of the overlay center. Calculated as overlayCanvas.width / 2.

cy:
The y coordinate of the overlay center. Calculated as overlayCanvas.height / 2.

trackingState.isPossible:
True when the locked target is only possible, not strong. The overlay uses amber for possible target line and blue for stronger target line.

overlayCtx.beginPath:
Starts a new canvas path for drawing custom lines or shapes.

overlayCtx.moveTo:
Moves the drawing cursor to the starting point of a line.

overlayCtx.lineTo:
Adds a line from the current point to a new point.

trackingState.filteredCenterX:
The smoothed x coordinate of the target center. It is used instead of raw center to reduce jitter.

trackingState.filteredCenterY:
The smoothed y coordinate of the target center. It is used instead of raw center to reduce jitter.

overlayCtx.stroke:
Actually draws the path that was built with moveTo and lineTo.

text:
In drawScene, text is the simulated movement overlay string, for example SIM LEFT_SMALL / UP_MED.

trackingState.simPanLabel:
Readable horizontal movement hint, such as HOLD, LEFT_SMALL, RIGHT_MED.

trackingState.simTiltLabel:
Readable vertical movement hint, such as HOLD, UP_SMALL, DOWN_MED.

updateSelectedTarget:
Commits the chosen selected detection into the shared trackingState and updates the visible HUD. It is the handoff point from model result to app state.

selected in updateSelectedTarget:
The detection object chosen as the tracked target.

settings in updateSelectedTarget:
The active detector settings. Used for smoothing and simulated movement logic.

loopMs in updateSelectedTarget:
How long the current detection pass took in milliseconds.

smoothMetrics:
Smooths the selected target geometry so the target marker and movement hints do not jump too much between frames.

filtered:
The smoothed version of selected.metrics. It contains smoothed center, delta, and normalized offset values.

selected.metrics:
Raw geometry of the selected target before smoothing.

simCommand:
Converts the smoothed target offset into simulated pan/tilt movement hints.

sim:
The simulated movement result from simCommand. It contains pan, tilt, panLabel, and tiltLabel.

trackingState:
Shared object that stores the official current target state. Other files like control.js read it for status cards and operator assist.

trackingState.hasTarget = true:
Marks that a valid target is currently locked.

trackingState.isPossible = !selected.isStrong:
Stores whether the selected target is possible/weak instead of strong.

trackingState.label:
Stores the selected target class name.

trackingState.score:
Stores the selected target confidence score.

trackingState.rawCenterX:
Stores the selected target’s raw x center before smoothing.

trackingState.rawCenterY:
Stores the selected target’s raw y center before smoothing.

trackingState.filteredCenterX:
Stores the smoothed target x center.

trackingState.filteredCenterY:
Stores the smoothed target y center.

trackingState.filteredDeltaX:
Stores the smoothed horizontal offset from screen center in pixels.

trackingState.filteredDeltaY:
Stores the smoothed vertical offset from screen center in pixels.

trackingState.filteredNormX:
Stores the smoothed horizontal offset normalized from -1 to 1.

trackingState.filteredNormY:
Stores the smoothed vertical offset normalized from -1 to 1.

trackingState.simPan:
Stores the numeric horizontal simulated movement value.

trackingState.simTilt:
Stores the numeric vertical simulated movement value.

trackingState.simPanLabel:
Stores the readable horizontal simulated movement label.

trackingState.simTiltLabel:
Stores the readable vertical simulated movement label.

trackingState.loopMs:
Stores how long the current detection pass took.

trackingState.missedFrames = 0:
Resets missed frame count because a valid target was found.

setReadout:
Safely writes text into a HUD element. If the element does not exist, it does nothing.

targetLabelVal:
HUD field for the current target label.

selected.isStrong ? selected.class : `Possible ${selected.class}`:
Shows normal class label for strong targets and Possible class label for weaker targets.

targetScoreVal:
HUD field for confidence percentage.

targetCenterVal:
HUD field for the raw selected target center.

targetCenterFilteredVal:
HUD field for the smoothed selected target center.

targetDeltaVal:
HUD field for smoothed pixel offset from center.

targetDeltaNormVal:
HUD field for normalized offset from center.

simCommandVal:
HUD field showing simulated pan/tilt labels and values.

loopTimeVal:
HUD field showing detection loop time.

formatPoint:
Formats x and y coordinates as readable text, usually rounded pixel values.

formatNorm:
Formats normalized x and y values as readable decimals.

sim.pan.toFixed(2):
Formats numeric pan value with two digits after the decimal.

sim.tilt.toFixed(2):
Formats numeric tilt value with two digits after the decimal.

updateOperatorAssistReadout:
Rebuilds the operator assist card using trackingState. The assist card belongs to control.js, but it reads the target state updated here.

pushTelemetry:
Appends one telemetry entry to sessionTelemetry and keeps the telemetry array from growing too large.

entry:
One telemetry row object. It can describe clear, possible, target, or error frame data.

sessionTelemetry:
Array storing recent detection telemetry entries for download or debugging.

MAX_TELEMETRY:
Maximum number of telemetry entries kept in memory.

sessionTelemetry.push:
Adds a new telemetry row to the end of the array.

sessionTelemetry.length:
Number of telemetry rows currently stored.

sessionTelemetry.shift:
Removes the oldest telemetry row from the beginning of the array.

while (sessionTelemetry.length > MAX_TELEMETRY):
Keeps removing old telemetry entries until the array is within the memory limit.

yieldToBrowser:
Allows the browser to update the UI before the next detection pass. It helps keep the page responsive during repeated inference.

window.tf:
TensorFlow.js global object. If it exists, the code can use tf.nextFrame.

tf.nextFrame:
TensorFlow.js helper that waits until the next animation frame. It is useful in graphics-heavy loops.

requestAnimationFrame:
Browser function that runs code on the next screen repaint. Used as a fallback when tf.nextFrame is not available.

Promise:
JavaScript object representing async work that finishes later. Here it wraps requestAnimationFrame so yieldToBrowser can be awaited.

resolve:
Function used inside Promise to mark the async wait as finished.

catch (err) in yieldToBrowser:
If tf.nextFrame fails, the code logs a warning and uses requestAnimationFrame instead.

console.warn:
Writes a warning to the browser developer console.

ensureDetectSourceSurface:
Creates or reuses an off-screen canvas and its 2D context. It is used for frame preprocessing without touching the visible camera image.

detectSourceCanvas:
Reusable off-screen canvas variable. It starts null and is created only when needed.

detectSourceCtx:
2D drawing context for detectSourceCanvas. It starts null and is created only when needed.

document.createElement('canvas'):
Creates a new canvas element in memory.

getContext('2d', { alpha: false }):
Gets the 2D drawing context for the off-screen canvas. alpha false means the canvas does not need transparency, which can be more efficient.

alpha: false:
Canvas option saying the canvas is opaque. This can improve performance for preprocessing.

return { canvas: detectSourceCanvas, ctx: detectSourceCtx }:
Returns the reusable canvas and context pair.

return null in ensureDetectSourceSurface:
Means the off-screen canvas or context could not be created.

exam summary:
This file section draws detection results and commits selected target data. drawScene paints boxes, labels, reticle, target line, and movement text. updateSelectedTarget writes the chosen target into trackingState and updates HUD readouts. pushTelemetry stores frame history while limiting memory. yieldToBrowser keeps the browser responsive between frames. ensureDetectSourceSurface prepares a reusable off-screen canvas for preprocessing frames.
*/