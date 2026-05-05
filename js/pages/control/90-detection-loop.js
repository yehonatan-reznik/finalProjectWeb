// FILE ROLE: 90-detection-loop.js
// What this file does:
// - Runs one detection pass through runDetection().
// - Starts, repeats, and stops the live detection loop.
// - Handles detector status changes, clear/possible/target/error states, and startup ordering.
// - Calls init() after all split control-page files have loaded.
// Why this file exists:
// - The rest of the detector defines helpers, geometry, drawing, and backend logic.
// - This file is the orchestrator that actually makes the detector run repeatedly on live frames.
//START DETECTING
async function runDetection() {
  // Full frame pipeline:
  // 1. Guard against overlap and invalid stream state.
  // 2. Read the current detector settings.
  // 3. Run exactly one backend for this frame.
  // 4. Normalize predictions into one shared format.
  // 5. Filter and rank detections down to one selected target.
  // 6. Update HUD, overlay, logs, and telemetry.
  // 7. On failure, show a readable detector error instead of crashing silently.
  // Do not overlap detection passes or read from an empty/hidden stream.
  if (isDetecting || !feedImg || !feedImg.src || feedImg.classList.contains('d-none')) return;
  if (!feedImg.complete || feedImg.naturalWidth === 0) return;
  isDetecting = true;
  // Measure loop duration so the UI can show actual inference cadence.
  const startedAt = performance.now(); // Timestamp used to measure total duration of this detection pass.
  try {
    const settings = getSettings(); // Current detector settings snapshot used for this frame only.
    setProfileStatus(settings.profile.id);
    // Exactly one backend runs per frame. Everything after this point is intentionally backend-agnostic.
    //START DETECTING
    const predictions = settings.backend.id === 'aeroyolo' ? await detectWithAeroYolo() : await detectWithCoco(); // Shared-format raw predictions from the active backend.
    const detections = buildDetections(predictions, settings); // Decorated predictions including metrics and target flags.
    // Only candidate detections are allowed to compete for the single tracked target.
    const selected = chooseCandidate(detections.filter((det) => det.isCandidate && det.metrics)); // One chosen target, or null if nothing qualified.
    const loopMs = performance.now() - startedAt; // Measured end-to-end detector runtime for this pass.
    if (!selected) {
      // Count consecutive misses so the tracker can survive a few short dropouts.
      trackingState.missedFrames += 1;
      // We still draw all raw detections even when none qualified as a tracked air target.
      if (trackingState.missedFrames >= LOST_LIMIT) clearTargetTelemetry();
      drawScene(detections, null);
      setReadout(loopTimeVal, loopMs.toFixed(1));
      // Show the strongest seen class as a hint when the detector saw something, but nothing in-profile qualified.
      setDetectStatus(predictions.length ? `Detect: clear (${predictions.reduce((a, b) => (a.score || 0) > (b.score || 0) ? a : b).class})` : 'Detect: clear', 'bg-success');
      setSafetyState('ok', 'Safe');
      setMode('Observe');
      if (lastDetectState !== 'clear') logConsole('No configured air target detected.', 'text-success');
      lastDetectState = 'clear';
      lastDetectLabel = '';
      // Telemetry keeps every frame outcome so the operator can export a post-run timeline.
      pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'clear', backend: settings.backend.id, profile: settings.profile.id, loopMs: Number(loopMs.toFixed(2)), predictionCount: predictions.length });
      return;
    }

    updateSelectedTarget(selected, settings, loopMs);
    drawScene(detections, selected);
    const labelText = `${selected.class} ${((selected.score || 0) * 100).toFixed(1)}%`; // Compact class + confidence summary reused in UI/log logic.
    const targetLogMessage = buildTargetLogMessage(selected); // Full one-line console message for a strong target event.
    const deltaText = ` dx=${trackingState.filteredDeltaX.toFixed(0)} dy=${trackingState.filteredDeltaY.toFixed(0)}`; // Compact delta summary reused in possible-target logs.
    if (selected.isStrong) {
      // Strong candidates become full danger/target events.
      setDetectStatus('Detect: target', 'bg-danger');
      setSafetyState('danger', 'Air target detected');
      // Strong events are logged every time because they represent the primary operator-facing alarm state.
      logConsole(targetLogMessage, 'text-danger');
      lastDetectState = 'target';
    } else {
      // Possible candidates are shown with a warning state but not the full danger state.
      setDetectStatus('Detect: possible', 'bg-warning text-dark');
      setSafetyState('warn', 'Possible air target');
      if (lastDetectState !== 'possible' || lastDetectLabel !== labelText) logConsole(`Possible target: ${labelText}${deltaText}`, 'text-warning');
      lastDetectState = 'possible';
    }
    lastDetectLabel = labelText;
    pushTelemetry({
      frame: ++frameCounter,
      at: new Date().toISOString(),
      state: selected.isStrong ? 'target' : 'possible',
      backend: settings.backend.id,
      profile: settings.profile.id,
      loopMs: Number(loopMs.toFixed(2)),
      label: selected.class,
      score: Number((selected.score || 0).toFixed(4)),
      rawCenter: {
        x: Number(trackingState.rawCenterX.toFixed(2)),
        y: Number(trackingState.rawCenterY.toFixed(2)),
      },
      filteredCenter: {
        x: Number(trackingState.filteredCenterX.toFixed(2)),
        y: Number(trackingState.filteredCenterY.toFixed(2)),
      },
      filteredDelta: {
        x: Number(trackingState.filteredDeltaX.toFixed(2)),
        y: Number(trackingState.filteredDeltaY.toFixed(2)),
        normX: Number(trackingState.filteredNormX.toFixed(4)),
        normY: Number(trackingState.filteredNormY.toFixed(4)),
      },
      sim: {
        pan: trackingState.simPan,
        tilt: trackingState.simTilt,
        panLabel: trackingState.simPanLabel,
        tiltLabel: trackingState.simTiltLabel,
      },
    });
  } catch (err) {
    console.error('Detection failed', err);
    // Try to expose the most useful human-readable reason to the operator.
    const text = err && err.message ? err.message : 'check camera address / stream'; // Best available human-readable error message.
    const corsBlocked = /tainted canvases|cross-origin|cross origin/i.test(text); // Heuristic for common browser pixel-read/CORS failures.
    setDetectStatus(corsBlocked ? 'Detect: blocked (CORS)' : 'Detect: error', corsBlocked ? 'bg-warning text-dark' : 'bg-danger');
    setSafetyState('warn', corsBlocked ? 'Detection blocked' : 'Scanning');
    clearTargetTelemetry();
    if (lastDetectState !== 'error' || lastDetectLabel !== text) logConsole(`Detection error: ${text}`, 'text-warning');
    lastDetectState = 'error';
    lastDetectLabel = text;
    // Error telemetry is intentionally compact because it may happen repeatedly on a broken stream.
    pushTelemetry({ frame: ++frameCounter, at: new Date().toISOString(), state: 'error', error: text });
  } finally {
    // Yielding here gives the browser a chance to paint the latest HUD/overlay updates before the next pass starts.
    await yieldToBrowser();
    isDetecting = false;
  }
}

// Section: loop lifecycle.
// Detection loop scheduling keeps a target cadence while respecting actual inference time.
/**
 * @param {'idle'|'error'|string} reason - Why the loop is being stopped.
 */
// EXAM: stop the repeating detector loop.
function stopDetectionLoop(reason) {
  detectLoopActive = false;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = null;
  isDetecting = false;
  if (window.SkyShieldFollow && typeof window.SkyShieldFollow.disable === 'function') {
    window.SkyShieldFollow.disable({ silent: true, stopRig: true });
  }
  clearOverlay();
  // Stopping the loop always clears stale visuals so the operator never sees an old box on a disconnected feed.
  if (overlayCanvas) overlayCanvas.classList.add('d-none');
  lastDetectState = '';
  lastDetectLabel = '';
  clearTargetTelemetry();
  setMode('Manual');
  if (reason === 'idle') {
    // Idle is the normal "no stream" state.
    setDetectStatus('Detect idle', 'bg-secondary');
    setSafetyState('ok', 'Safe');
  } else if (reason === 'error') {
    // Error keeps the warning state visible because the operator may still expect a live feed.
    setDetectStatus('Detect: stream error', 'bg-warning');
  }
}

/**
 * @param {number} delay - Milliseconds to wait before the next detection pass.
 */
// EXAM: schedule the next detector pass.
function scheduleNextDetection(delay) {
  if (!detectLoopActive) return;
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    // Measure one loop so the next timeout can compensate for inference time.
    const startedAt = performance.now(); // Timestamp used to compensate the next schedule against actual work time.
    await runDetection();
    // Keep a roughly fixed cadence: fast frames wait a little, slow frames continue almost immediately.
    scheduleNextDetection(Math.max(DETECT_MIN_IDLE_MS, DETECT_INTERVAL_MS - (performance.now() - startedAt)));
  }, Math.max(0, delay || 0));
}

/**
 * Starts the repeating detection loop if one is not already running.
 */
// EXAM: start the repeating detector loop.
//START DETECTING
function startDetectionLoop() {
  // This is the main entry point for detection after the camera stream is ready.
  // From here, the page begins repeatedly running runDetection() on incoming frames.
  // Prevent duplicate loops from being started by repeated load events.
  if (detectLoopActive || !feedImg) return;
  detectLoopActive = true;
  // The loop starts immediately after the image confirms it has drawable pixels.
  setDetectStatus('Detect: starting', 'bg-warning');
  setSafetyState('warn', 'Scanning');
  setMode('Observe');
  logConsole('Detection loop started.', 'text-info');
  if (overlayCanvas) overlayCanvas.classList.remove('d-none');
  scheduleNextDetection(0);
}

// The earlier control-page modules define init(), but we call it here after the split control-page stack has loaded.
init();
