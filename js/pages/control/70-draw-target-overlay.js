// FILE ROLE: 70-draw-target-overlay.js
// What this file does:
// - Draws detection results on the overlay canvas.
// - Updates the visible detector readouts after one target is selected.
// - Commits the chosen target into shared tracking state and appends telemetry entries.
// Why this file exists:
// - Detection logic and drawing logic are kept separate.
// - This file is the visual/output layer of the detector.
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
  // The earlier control-page modules own the assist card, but it rebuilds from this shared tracking state.
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
