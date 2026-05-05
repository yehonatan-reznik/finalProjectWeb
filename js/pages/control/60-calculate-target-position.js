// FILE ROLE: 60-calculate-target-position.js
// What this file does:
// - Converts raw model bounding boxes into screen-space values the UI can use.
// - Calculates center points, deltas from screen center, normalized offsets, and smoothed target motion.
// - Decides which detections are good candidates and helps choose one target.
// Why this file exists:
// - Model output by itself is just raw numbers.
// - This file turns those numbers into geometry and decision data for tracking.
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
