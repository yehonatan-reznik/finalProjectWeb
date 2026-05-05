// FILE ROLE: 60-detection-geometry.js
// This file converts raw detections into usable screen-space geometry: overlay sizing, image fit,
// center/delta calculations, smoothing, threshold checks, and target-candidate ranking helpers.
// Overlay geometry converts detections from image space into the displayed canvas space.
/**
 * Sizes the overlay canvas to match the displayed camera container.
 */
// EXAM: match overlay canvas to displayed image size.
function syncOverlaySize() {
  if (!(overlayCanvas && feedImg && feedImg.parentElement)) return;
  // Match the canvas to the displayed image container, not the raw image pixels, because drawing happens in screen space.
  overlayCanvas.width = Math.round(feedImg.parentElement.clientWidth || 0);
  overlayCanvas.height = Math.round(feedImg.parentElement.clientHeight || 0);
}

/**
 * Clears all overlay graphics from the canvas.
 */
// EXAM: wipe overlay drawings.
function clearOverlay() {
  if (overlayCtx && overlayCanvas) {
    // Remove every old box/reticle pixel from the canvas.
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }
}

/**
 * @returns {{scale: number, offsetX: number, offsetY: number}|null} Display scaling info for the camera image.
 */
// EXAM: compute how the image is fitted into the viewport.
function getImageFit() {
  // If we do not yet know the actual image size, we cannot map detections to the screen.
  if (!(feedImg && feedImg.parentElement && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // Measure the displayed container size, not the raw image size.
  const width = feedImg.parentElement.clientWidth; // Actual displayed width of the image container in CSS pixels.
  const height = feedImg.parentElement.clientHeight; // Actual displayed height of the image container in CSS pixels.
  // object-fit: contain means the image scales uniformly until it fits inside the container.
  const scale = Math.min(width / feedImg.naturalWidth, height / feedImg.naturalHeight); // Contain-scale factor used by the browser for the image.
  const displayWidth = feedImg.naturalWidth * scale; // Visible width of the image content after contain-scaling.
  const displayHeight = feedImg.naturalHeight * scale; // Visible height of the image content after contain-scaling.
  return { scale, offsetX: (width - displayWidth) / 2, offsetY: (height - displayHeight) / 2 };
}

/**
 * @param {{bbox: number[]}} det - Detection object containing an image-space bbox.
 * @returns {object|null} Screen-space metrics for drawing and tracking.
 */
// EXAM: convert image-space bbox into overlay-space metrics.
function computeMetrics(det) {
  syncOverlaySize();
  const fit = getImageFit(); // Mapping data that converts raw image pixels into on-screen canvas coordinates.
  if (!fit) return null;
  // Unpack the model bbox, which is stored as [x, y, width, height].
  const [rawX, rawY, rawW, rawH] = det.bbox; // Raw model bbox encoded as image-space x, y, width, height.
  // Convert raw image-space coordinates into displayed canvas-space coordinates.
  const x = rawX * fit.scale + fit.offsetX; // Screen-space left edge after scale + contain offset.
  const y = rawY * fit.scale + fit.offsetY; // Screen-space top edge after scale + contain offset.
  const w = rawW * fit.scale; // Screen-space width after scale.
  const h = rawH * fit.scale; // Screen-space height after scale.
  if (w <= 0 || h <= 0) return null;
  const centerX = x + w / 2; // Horizontal center of the detection box on screen.
  const centerY = y + h / 2; // Vertical center of the detection box on screen.
  const screenCenterX = overlayCanvas.width / 2; // Horizontal center of the visible camera viewport.
  const screenCenterY = overlayCanvas.height / 2; // Vertical center of the visible camera viewport.
  const deltaX = centerX - screenCenterX; // Positive means target is to the right of center.
  // Positive deltaY means the target sits above center, which matches the later UP/DOWN assist labels.
  const deltaY = screenCenterY - centerY;
  // Normalized deltas collapse every viewport into a -1..1 range for simpler assist logic.
  const normX = screenCenterX ? Math.max(-1, Math.min(1, deltaX / screenCenterX)) : 0; // Right/left offset scaled to a stable range.
  const normY = screenCenterY ? Math.max(-1, Math.min(1, deltaY / screenCenterY)) : 0; // Up/down offset scaled to a stable range.
  return { x, y, w, h, centerX, centerY, deltaX, deltaY, normX, normY };
}

// Candidate ranking filters the raw model output into the single target the UI should track.
/**
 * @param {string} className - Candidate class label.
 * @param {object|null} metrics - Candidate metrics in screen space.
 * @param {object} settings - Active detector settings.
 * @returns {{possible: number, strong: number}} Thresholds for this candidate.
 */
// EXAM: possible/strong threshold logic with track-lock relaxation.
function getDetectionThresholds(className, metrics, settings) {
  const base = { // Base thresholds before any track-lock relaxation is applied.
    possible: settings.possibleThreshold,
    strong: settings.strongThreshold,
  };
  // Only the same nearby target gets the relaxed "track lock" thresholds.
  if (!(hasTrackLock() && className === trackingState.label && isNearLockedTarget(metrics))) return base;
  return {
    possible: Math.max(TRACK_LOCK_MIN_SCORE, base.possible * TRACK_LOCK_THRESHOLD_FACTOR),
    strong: Math.max(TRACK_LOCK_MIN_SCORE, base.strong * TRACK_LOCK_THRESHOLD_FACTOR),
  };
}

/**
 * @param {object[]} predictions - Raw model predictions.
 * @param {object} settings - Active detector settings.
 * @returns {object[]} Decorated detection objects with metrics and candidate flags.
 */
// EXAM: decorate raw predictions into candidate objects.
function buildDetections(predictions, settings) {
  const labels = new Set(getProfileLabels(settings.profile, settings.backend.id)); // Fast lookup table of labels allowed by the current profile/backend pair.
  return predictions
    // Keep low-confidence clutter out of the overlay entirely.
    .filter((p) => (p.score || 0) >= DRAW_THRESHOLD)
    .map((p) => {
      const metrics = computeMetrics(p); // Screen-space geometry derived from the raw prediction bbox.
      const thresholds = getDetectionThresholds(p.class, metrics, settings); // Possible/strong thresholds for this specific candidate.
      const score = p.score || 0; // Defensive normalized confidence score.
      // Every backend is normalized into the same decorated detection shape so selection/drawing code can stay shared.
      return {
        ...p,
        metrics,
        // isCandidate means "allow this into target selection"; isStrong means "show this as a real target".
        // A candidate is allowed to compete for tracking; a strong candidate is good enough to count as a real target.
        isCandidate: labels.has(p.class) && score >= thresholds.possible,
        isStrong: labels.has(p.class) && score >= thresholds.strong,
      };
    });
}

/**
 * @param {object[]} candidates - Candidate detections already filtered for track eligibility.
 * @returns {object|null} Single best detection to track.
 */
// EXAM: choose the one active target.
function chooseCandidate(candidates) {
  // Selection rule:
  // - Start with confidence score as the main ranking signal.
  // - If a target was already locked, subtract a distance penalty from far-away boxes.
  // - This keeps the tracker stable without making jumps impossible.
  if (!candidates.length) return null;
  return candidates.reduce((best, det) => {
    // Start ranking mostly by confidence score.
    let detRank = det.score || 0; // Working rank for the challenger candidate.
    let bestRank = best.score || 0; // Working rank for the current best candidate.
    // When a target is already locked, penalize far-away boxes so the tracker stays stable.
    if (trackingState.hasTarget && trackingState.missedFrames < LOST_LIMIT) {
      const diag = Math.max(1, Math.hypot(overlayCanvas.width, overlayCanvas.height)); // Used to normalize the distance penalty.
      // This penalty does not block jumps entirely; it just requires a farther box to be materially more confident.
      detRank -= Math.hypot(det.metrics.centerX - trackingState.filteredCenterX, det.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
      bestRank -= Math.hypot(best.metrics.centerX - trackingState.filteredCenterX, best.metrics.centerY - trackingState.filteredCenterY) / diag * 0.35;
    }
    return detRank > bestRank ? det : best;
  });
}

// Smoothing keeps the overlay and operator hints from jumping on every raw frame.
/**
 * @param {DetectionMetrics} raw - Unsmooth candidate metrics for the selected target.
 * @param {DetectionSettings} settings - Active detector settings.
 * @returns {{centerX: number, centerY: number, deltaX: number, deltaY: number, normX: number, normY: number}} Smoothed metrics.
 */
// EXAM: smooth target motion.
function smoothMetrics(raw, settings) {
  if (!trackingState.hasTarget || trackingState.missedFrames >= LOST_LIMIT) {
    return { centerX: raw.centerX, centerY: raw.centerY, deltaX: raw.deltaX, deltaY: raw.deltaY, normX: raw.normX, normY: raw.normY };
  }
  // Exponential smoothing makes the assist hints steadier without hiding larger target movement.
  const a = settings.smoothingAlpha; // Blend factor: higher values follow the raw target more aggressively.
  const centerX = trackingState.filteredCenterX + a * (raw.centerX - trackingState.filteredCenterX); // Smoothed X center.
  const centerY = trackingState.filteredCenterY + a * (raw.centerY - trackingState.filteredCenterY); // Smoothed Y center.
  const dx = centerX - overlayCanvas.width / 2; // Smoothed horizontal delta from screen center.
  const dy = overlayCanvas.height / 2 - centerY; // Smoothed vertical delta from screen center with positive meaning above center.
  const normX = overlayCanvas.width ? Math.max(-1, Math.min(1, dx / (overlayCanvas.width / 2))) : 0; // Smoothed normalized horizontal offset.
  const normY = overlayCanvas.height ? Math.max(-1, Math.min(1, dy / (overlayCanvas.height / 2))) : 0; // Smoothed normalized vertical offset.
  return { centerX, centerY, deltaX: dx, deltaY: dy, normX, normY };
}

/**
 * @param {number} norm - Normalized offset along one axis.
 * @param {number} deadZone - Center tolerance where movement becomes HOLD.
 * @param {string} negLabel - Label used when movement should go negative on that axis.
 * @param {string} posLabel - Label used when movement should go positive on that axis.
 * @returns {{value: number, label: string}} Simulated movement output for one axis.
 */
// EXAM: convert one normalized axis into HOLD/LEFT/RIGHT style guidance.
function simAxis(norm, deadZone, negLabel, posLabel) {
  const mag = Math.abs(norm); // Direction-free strength of the offset on this axis.
  if (mag < deadZone) return { value: 0, label: 'HOLD' };
  // Three coarse bands are enough for operator guidance and easier to read than raw float output.
  const step = mag >= 0.45 ? 1 : mag >= 0.22 ? 0.5 : 0.25; // Coarse numeric strength sent to simulated guidance.
  const suffix = mag >= 0.45 ? 'LARGE' : mag >= 0.22 ? 'MED' : 'SMALL'; // Human-readable size band paired with the numeric step.
  return { value: norm < 0 ? -step : step, label: `${norm < 0 ? negLabel : posLabel}_${suffix}` };
}

/**
 * @param {{normX: number, normY: number}} filtered - Smoothed normalized target offset.
 * @param {object} settings - Active detector settings.
 * @returns {{pan: number, tilt: number, panLabel: string, tiltLabel: string}} Simulated pan/tilt output.
 */
// EXAM: convert target offset into simulated pan/tilt guidance.
function simCommand(filtered, settings) {
  // Horizontal offset becomes a pan hint; vertical offset becomes a tilt hint.
  const pan = simAxis(filtered.normX, settings.deadZone, 'LEFT', 'RIGHT'); // Horizontal guidance derived from the filtered target offset.
  const tilt = simAxis(filtered.normY, settings.deadZone, 'DOWN', 'UP'); // Vertical guidance derived from the filtered target offset.
  return { pan: pan.value, tilt: tilt.value, panLabel: pan.label, tiltLabel: tilt.label };
}

/**
 * @returns {string} Compact human-readable movement direction summary for the event console.
 */
// EXAM: human-readable movement summary.
function describeCameraMove() {
  // Parse the two axis hints that were already generated for the currently tracked target.
  const panAssist = parseSimLabel(trackingState.simPanLabel); // Parsed current pan hint from shared tracking state.
  const tiltAssist = parseSimLabel(trackingState.simTiltLabel); // Parsed current tilt hint from shared tracking state.
  const moves = []; // Human-readable movement directions that will be joined into one log string.
  if (panAssist.direction !== 'hold') moves.push(friendlyDirection(panAssist.direction));
  if (tiltAssist.direction !== 'hold') moves.push(friendlyDirection(tiltAssist.direction));
  return moves.length ? moves.join(' / ') : 'HOLD';
}

/**
 * @param {object} selected - Selected detection object.
 * @returns {string} One-line event console message describing the selected target.
 */
// EXAM: operator-facing target log line.
function buildTargetLogMessage(selected) {
  // Build one compact line for the event console with class, score, center, and suggested move.
  const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`; // Short class + confidence summary.
  const x = trackingState.rawCenterX.toFixed(0); // Raw X center rounded for compact logging.
  const y = trackingState.rawCenterY.toFixed(0); // Raw Y center rounded for compact logging.
  const move = describeCameraMove(); // Current simplified movement guidance string.
  return `Target detected: ${labelText} x=${x} y=${y} move=${move}`;
}

// Drawing helpers render both the full set of predictions and the currently selected target lock.
/**
 * Draws the fixed center reticle onto the overlay canvas.
 */
// EXAM: draw center reticle.
function drawReticle() {
  if (!(overlayCtx && overlayCanvas)) return;
  // The reticle is centered in the visible overlay so the operator can compare target offset to screen center.
  const cx = overlayCanvas.width / 2; // Horizontal center of the visible overlay.
  const cy = overlayCanvas.height / 2; // Vertical center of the visible overlay.
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(56,189,248,0.9)';
  overlayCtx.lineWidth = 1.2;
  overlayCtx.beginPath();
  overlayCtx.moveTo(cx - 22, cy);
  overlayCtx.lineTo(cx + 22, cy);
  overlayCtx.moveTo(cx, cy - 22);
  overlayCtx.lineTo(cx, cy + 22);
  overlayCtx.stroke();
  overlayCtx.restore();
}

/**
 * @param {object[]} detections - All detections that should be drawn.
 * @param {object|null} selected - Detection currently chosen as the tracked target.
 */
// EXAM: draw boxes, labels, path line, and guidance overlay.




/*
EXAM COMMENT GLOSSARY FOR DETECTION GEOMETRY, TARGET RANKING, SMOOTHING, AND MOVEMENT HINTS

60-detection-geometry.js:
This file converts raw model detections into screen-space geometry. It handles overlay sizing, image scaling, bounding-box conversion, target thresholds, candidate ranking, smoothing, simulated movement hints, target log messages, and the center reticle.

syncOverlaySize:
Matches overlayCanvas size to the displayed camera container. This is important because drawing happens on the visible overlay, not directly on the raw camera image.

overlayCanvas:
The transparent canvas drawn on top of the camera feed.

feedImg:
The camera image element that displays the stream.

feedImg.parentElement:
The camera image container. Its displayed size is used to size the overlay canvas.

clientWidth:
The displayed CSS pixel width of an element.

clientHeight:
The displayed CSS pixel height of an element.

overlayCanvas.width:
The actual drawing width of the overlay canvas.

overlayCanvas.height:
The actual drawing height of the overlay canvas.

Math.round:
Rounds a value to the nearest whole number. Canvas width and height should be whole pixels.

clearOverlay:
Clears all previous drawings from the overlay canvas, including boxes, lines, labels, and the reticle.

overlayCtx:
The 2D drawing context used to draw on overlayCanvas.

overlayCtx.clearRect:
Clears a rectangular area of the canvas. Here it clears the whole overlay.

getImageFit:
Calculates how the raw camera image is displayed inside the visible container. It returns scale, offsetX, and offsetY.

object-fit: contain:
Means the image is scaled uniformly until it fits inside the container without cropping. This can create empty space on the sides or top/bottom.

width in getImageFit:
The displayed width of the camera container.

height in getImageFit:
The displayed height of the camera container.

feedImg.naturalWidth:
The real pixel width of the camera image.

feedImg.naturalHeight:
The real pixel height of the camera image.

scale in getImageFit:
The factor used to convert raw image pixels into displayed canvas pixels.

displayWidth:
The visible width of the image content after scaling.

displayHeight:
The visible height of the image content after scaling.

offsetX:
Horizontal padding caused by object-fit contain. It is added when converting raw x coordinates to screen x coordinates.

offsetY:
Vertical padding caused by object-fit contain. It is added when converting raw y coordinates to screen y coordinates.

computeMetrics:
Converts one raw detection bounding box from image-space coordinates into overlay-space coordinates. It also calculates center point, distance from screen center, and normalized offsets.

det:
One detection object from the model or decorated detection list.

det.bbox:
Bounding box from the model in the format [x, y, width, height].

fit:
The mapping object returned by getImageFit. It contains scale, offsetX, and offsetY.

rawX:
Raw bounding-box x position in original image pixels.

rawY:
Raw bounding-box y position in original image pixels.

rawW:
Raw bounding-box width in original image pixels.

rawH:
Raw bounding-box height in original image pixels.

x:
Bounding-box left edge after converting into overlay/screen coordinates.

y:
Bounding-box top edge after converting into overlay/screen coordinates.

w:
Bounding-box width after scaling into overlay/screen coordinates.

h:
Bounding-box height after scaling into overlay/screen coordinates.

w <= 0 || h <= 0:
Invalid box check. If width or height is zero or negative, the detection cannot be used.

centerX:
Horizontal center of the detection box on the overlay.

centerY:
Vertical center of the detection box on the overlay.

screenCenterX:
Horizontal center of the visible camera viewport.

screenCenterY:
Vertical center of the visible camera viewport.

deltaX:
Horizontal distance from the screen center. Positive means the target is to the right. Negative means it is to the left.

deltaY:
Vertical distance from the screen center. In this code, positive means the target is above center and negative means below center.

normX:
Normalized horizontal offset from -1 to 1. This makes movement logic independent of screen size.

normY:
Normalized vertical offset from -1 to 1. This makes movement logic independent of screen size.

Math.max(-1, Math.min(1, value)):
Clamps a normalized value into the range -1 to 1.

getDetectionThresholds:
Returns the possible and strong confidence thresholds for one candidate. It can relax thresholds if the tracker already has a lock on the same nearby target.

className:
The detected label being evaluated, for example drone, aircraft, or helicopter.

metrics:
Screen-space geometry for the candidate detection.

settings:
Current detector settings. It includes possibleThreshold, strongThreshold, smoothingAlpha, deadZone, backend, and profile.

base:
Object containing the normal possible and strong thresholds before track-lock relaxation.

settings.possibleThreshold:
Lower threshold for a possible target warning.

settings.strongThreshold:
Higher threshold for a strong target/danger state.

hasTrackLock:
Checks whether the tracker still considers the previous target locked.

trackingState.label:
The class label of the current locked target.

isNearLockedTarget:
Checks whether the new candidate is close to the previous locked target.

TRACK_LOCK_MIN_SCORE:
Minimum score allowed when relaxing thresholds. Prevents the tracker from accepting extremely weak detections.

TRACK_LOCK_THRESHOLD_FACTOR:
Multiplier used to relax thresholds for the same nearby locked target.

buildDetections:
Turns raw predictions into decorated detection objects. It filters out very weak predictions, computes metrics, calculates thresholds, and adds isCandidate and isStrong flags.

predictions:
Raw model prediction array.

labels:
A Set of allowed class labels for the current profile and backend.

new Set:
Creates a lookup set. labels.has(...) is faster and cleaner than searching an array every time.

getProfileLabels:
Returns the labels allowed by the current profile/backend combination.

settings.profile:
The active detection profile.

settings.backend.id:
The active detector backend id.

DRAW_THRESHOLD:
Minimum confidence required for a prediction to be drawn at all. Predictions below this are treated as clutter.

filter:
Array method that keeps only items matching a condition.

map:
Array method that transforms each item into a new item.

p:
One raw prediction inside buildDetections.

p.score:
Confidence score of the raw prediction.

p.class:
Class label of the raw prediction.

metrics in buildDetections:
Screen-space geometry calculated by computeMetrics.

thresholds:
Possible/strong threshold object returned by getDetectionThresholds.

score:
Safe confidence score. If p.score is missing, it becomes 0.

...p:
Spread syntax. Copies all original prediction fields into the new decorated detection object.

isCandidate:
True when the detection class is allowed by the active profile and score is at least the possible threshold.

isStrong:
True when the detection class is allowed by the active profile and score is at least the strong threshold.

chooseCandidate:
Chooses the one active target from candidate detections. It mostly ranks by confidence score, but if a target is already locked, it penalizes boxes that are far away from the previous target.

candidates:
Array of detections that are allowed to become the tracked target.

if (!candidates.length) return null:
If there are no candidates, no target can be selected.

reduce:
Array method used to compare all candidates and keep the best one.

best:
The current best candidate while reduce is running.

det in chooseCandidate:
The challenger candidate being compared against best.

detRank:
Working ranking score for the challenger candidate.

bestRank:
Working ranking score for the current best candidate.

trackingState.hasTarget:
True when a target is currently locked.

trackingState.missedFrames:
Counts how many frames were missed since the last valid target.

LOST_LIMIT:
Maximum missed frames before the previous target is considered lost.

diag:
The diagonal length of the overlay canvas. Used to normalize distance penalty.

Math.hypot:
Calculates distance using the Pythagorean formula. Used for screen diagonal and distance between target centers.

distance penalty:
A score reduction applied to candidates far away from the previous locked target. It helps prevent target jumping.

0.35:
Strength of the distance penalty in chooseCandidate. Farther boxes need better confidence to beat the current target.

smoothMetrics:
Smooths the selected target movement so the HUD, overlay, and assist hints do not jump too sharply between frames.

raw:
The unsmoothed metrics of the selected target.

trackingState.filteredCenterX:
Previous smoothed x center.

trackingState.filteredCenterY:
Previous smoothed y center.

settings.smoothingAlpha:
Blend factor controlling smoothing. Higher follows the raw target faster. Lower is smoother but slower.

a:
Short local variable for settings.smoothingAlpha.

exponential smoothing:
Formula where the new smoothed value moves part of the way from the old value to the new raw value.

centerX in smoothMetrics:
Smoothed horizontal target center.

centerY in smoothMetrics:
Smoothed vertical target center.

dx:
Smoothed horizontal offset from screen center.

dy:
Smoothed vertical offset from screen center, with positive meaning above center.

normX in smoothMetrics:
Smoothed normalized horizontal offset.

normY in smoothMetrics:
Smoothed normalized vertical offset.

simAxis:
Converts one normalized offset into a simulated movement value and label. It decides HOLD, SMALL, MED, or LARGE movement for one axis.

norm:
Normalized offset for one axis. Negative and positive represent opposite directions.

deadZone:
Center tolerance. If the target offset is smaller than deadZone, the output becomes HOLD.

negLabel:
Label used when norm is negative, for example LEFT or DOWN.

posLabel:
Label used when norm is positive, for example RIGHT or UP.

mag:
Absolute size of norm without direction.

Math.abs:
Removes sign from a number. Example: Math.abs(-0.3) is 0.3.

HOLD:
Movement label meaning the target is close enough to center on that axis and no movement is needed.

step:
Numeric simulated movement strength. 0.25 means small, 0.5 means medium, 1 means large.

suffix:
Text size label. It can be SMALL, MED, or LARGE.

0.45:
Threshold for LARGE movement.

0.22:
Threshold for MED movement.

0.25:
Small movement step value.

0.5:
Medium movement step value.

1:
Large movement step value.

simCommand:
Converts smoothed normalized target offset into pan and tilt movement hints.

filtered:
Smoothed target metrics returned by smoothMetrics.

pan:
Horizontal simulated movement result from simAxis.

tilt:
Vertical simulated movement result from simAxis.

filtered.normX:
Horizontal offset used for pan guidance.

filtered.normY:
Vertical offset used for tilt guidance.

LEFT:
Pan direction label when target is left.

RIGHT:
Pan direction label when target is right.

DOWN:
Tilt direction label when target is below center.

UP:
Tilt direction label when target is above center.

panLabel:
Readable horizontal movement label, like HOLD, LEFT_SMALL, RIGHT_MED.

tiltLabel:
Readable vertical movement label, like HOLD, UP_SMALL, DOWN_MED.

describeCameraMove:
Creates a compact human-readable movement summary for console logs. It reads sim labels from trackingState, parses them, and returns directions like LEFT / UP or HOLD.

parseSimLabel:
Parses labels like LEFT_SMALL or HOLD into direction, size, and taps.

panAssist:
Parsed pan movement label.

tiltAssist:
Parsed tilt movement label.

moves:
Array of movement directions used to build the final console string.

friendlyDirection:
Turns direction text into a readable direction label, usually uppercase.

moves.join(' / '):
Combines movement parts into one string separated by slash.

buildTargetLogMessage:
Builds one readable console log message for a selected target. It includes class, confidence, raw x/y center, and movement hint.

selected:
The chosen tracked detection.

labelText:
Class name plus confidence percentage, for example drone 82.5%.

trackingState.rawCenterX:
Raw x center of the selected target.

trackingState.rawCenterY:
Raw y center of the selected target.

toFixed(0):
Formats a number with zero digits after the decimal. Used for compact pixel logging.

move:
Human-readable movement summary returned by describeCameraMove.

Target detected:
Console message prefix used when a strong target is detected.

drawReticle:
Draws the fixed center crosshair on the overlay canvas. The reticle helps the operator see where the target is compared to the center.

cx in drawReticle:
Horizontal center of overlayCanvas.

cy in drawReticle:
Vertical center of overlayCanvas.

overlayCtx.save:
Saves the current canvas drawing style state.

overlayCtx.strokeStyle:
Sets line color for reticle drawing.

rgba(56,189,248,0.9):
Blue reticle line color with slight transparency.

overlayCtx.lineWidth:
Sets the reticle line thickness.

overlayCtx.beginPath:
Starts a new drawing path.

overlayCtx.moveTo:
Moves the drawing cursor to a coordinate without drawing yet.

overlayCtx.lineTo:
Adds a line segment from the current point to another coordinate.

cx - 22:
Left point of the horizontal reticle line.

cx + 22:
Right point of the horizontal reticle line.

cy - 22:
Top point of the vertical reticle line.

cy + 22:
Bottom point of the vertical reticle line.

overlayCtx.stroke:
Draws the lines created in the current path.

overlayCtx.restore:
Restores the previous canvas drawing style state.

exam summary:
This section takes model predictions and turns them into usable target geometry. syncOverlaySize keeps the overlay aligned with the camera. getImageFit and computeMetrics convert raw boxes into screen coordinates. getDetectionThresholds and buildDetections decide which predictions are possible or strong targets. chooseCandidate picks one target. smoothMetrics reduces jitter. simAxis and simCommand create movement hints. describeCameraMove and buildTargetLogMessage create readable console messages. drawReticle draws the center crosshair.
*/