// FILE ROLE: 40-init.js
// What this file does:
// - Runs page startup through init().
// - Restores saved settings and URLs.
// - Attaches click/change/load/error listeners to the page controls.
// - Connects the earlier helper files together into one working dashboard.
// Why this file exists:
// - The earlier files mostly define helpers and state.
// - This file is the integration point that wires everything into actual page behavior.
// Section: page bootstrap and event wiring.
// init wires together the UI once the split control-page modules have loaded.
/**
 * Wires the control page UI, restores saved settings, and starts auth/Firebase flow.
 */
// EXAM: control page bootstrap.
function init() {
  // Startup order matters:
  // 1. Reset visible HUD state.
  // 2. Restore persisted detection/calibration settings.
  // 3. Rebuild readouts that depend on that restored state.
  // 4. Attach event listeners.
  // 5. Rehydrate saved URLs and start Firebase/auth integration.
  // Reset HUD state first so the page always starts from a known baseline.
  clearTargetTelemetry();
  loadSettings();
  loadCalibration();
  // The old proxy mode is no longer used, so clear that legacy flag on startup.
  localStorage.removeItem('skyshield_camera_proxy_enabled');
  updateCalibrationReadouts();
  updateOperatorAssistReadout();

  // When backend/profile dropdowns change, save them and clear old tracking state.
  [detectBackendSelect, detectProfileSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      clearTargetTelemetry();
      // These globals live in the later control-page modules and suppress stale state labels across backend/profile switches.
      lastDetectState = '';
      lastDetectLabel = '';
      const settings = getSettings(); // Fresh settings snapshot used only for the change log line.
      // Backend/profile changes can invalidate the current target lock, so the HUD is cleared.
      logConsole(`Detection mode updated: ${settings.backend.label}, ${settings.profile.label}`, 'text-info');
    });
  });

  [strongThresholdInput, possibleThresholdInput, smoothingInput, deadZoneInput].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      const settings = getSettings(); // Fresh settings snapshot used only for the tuning-change log line.
      // These values directly affect confidence filtering and the simulated move hint.
      logConsole(`Detection settings updated: ${settings.backend.label}, ${settings.profile.label}, strong=${settings.strongThreshold.toFixed(2)}, possible=${settings.possibleThreshold.toFixed(2)}, alpha=${settings.smoothingAlpha.toFixed(2)}, deadZone=${settings.deadZone.toFixed(2)}`, 'text-info');
    });
  });

  if (downloadTelemetryBtn) downloadTelemetryBtn.addEventListener('click', downloadTelemetry);
  if (clearTelemetryBtn) {
    clearTelemetryBtn.addEventListener('click', () => {
      // Reuse the same telemetry array object and just empty it in place.
      sessionTelemetry.length = 0;
      logConsole('Session telemetry cleared.', 'text-muted');
    });
  }

  // Calibration listener group:
  // - dropdown changes keep controllerState.calibration in sync
  // - save/reset buttons let the operator explicitly persist or clear observations
  // - refresh/probe/center buttons talk to the real controller hardware
  // Keep calibration state and readouts synced whenever either observed-direction dropdown changes.
  [xObservedSelect, yObservedSelect].filter(Boolean).forEach((el) => {
    el.addEventListener('change', () => {
      saveCalibration(false);
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
    });
  });

  if (saveCalibrationBtn) {
    saveCalibrationBtn.addEventListener('click', () => {
      saveCalibration(true);
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
    });
  }

  if (resetCalibrationBtn) {
    resetCalibrationBtn.addEventListener('click', () => {
      resetCalibration();
      updateCalibrationReadouts();
      updateOperatorAssistReadout();
      logConsole('Calibration notes cleared.', 'text-muted');
    });
  }

  if (refreshControllerConfigBtn) refreshControllerConfigBtn.addEventListener('click', () => syncControllerConfig(true));
  if (centerRigBtn) {
    centerRigBtn.addEventListener('click', async () => {
      // Ask the controller to move back to its configured center position.
      const res = await sendCmd('center'); // Response returned by the controller center command.
      if (res && res.ok) logConsole('Rig centered for calibration.', 'text-info');
    });
  }
  // These four probe buttons send tiny nudges so the operator can observe real physical motion.
  if (probeXPositiveBtn) probeXPositiveBtn.addEventListener('click', () => sendProbe('x', 1));
  if (probeXNegativeBtn) probeXNegativeBtn.addEventListener('click', () => sendProbe('x', -1));
  if (probeYPositiveBtn) probeYPositiveBtn.addEventListener('click', () => sendProbe('y', 1));
  if (probeYNegativeBtn) probeYNegativeBtn.addEventListener('click', () => sendProbe('y', -1));

  // Refresh the placeholder text so the page always shows the expected URL format.
  if (urlInput) urlInput.placeholder = 'http://camera-ip:port/stream';
  if (esp32IpInput) esp32IpInput.placeholder = 'http://10.12.22.6';

  if (connectBtn && urlInput) {
    // Clicking Set tries to start the stream; if normalization fails, show a simple alert.
    connectBtn.addEventListener('click', () => !setStream(urlInput.value) && alert('Enter a valid camera URL (e.g., http://10.0.0.12/stream)'));
  }
  // Pressing Enter in the camera input triggers the same action as clicking Set.
  if (urlInput) urlInput.addEventListener('keyup', (event) => event.key === 'Enter' && connectBtn && connectBtn.click());

  // Controller URL group:
  // - normalize and save the base URL
  // - immediately fetch live laser state and controller config
  // - let Enter behave like the visible Connect button
  if (esp32ConnectBtn && esp32IpInput) {
    esp32ConnectBtn.addEventListener('click', () => {
      const normalized = normalizeBaseUrl(esp32IpInput.value); // Canonicalized controller URL entered by the operator.
      if (!normalized) return alert('Enter the ESP32 IP (e.g., http://10.12.22.6)');
      esp32IpInput.value = normalized;
      localStorage.setItem(ESP32_STORAGE_KEY, normalized);
      // Once the operator confirms the controller URL, sync both state and config right away.
      syncLaserState();
      syncControllerConfig(true);
    });
  }
  // Pressing Enter in the controller input behaves like clicking Connect.
  if (esp32IpInput) esp32IpInput.addEventListener('keyup', (event) => event.key === 'Enter' && esp32ConnectBtn && esp32ConnectBtn.click());

  // Manual command group:
  // These button handlers are intentionally thin.
  // The visible labels are operator-friendly, while the sent command names match the firmware API.
  // Direction buttons map directly to the firmware's HTTP command names.
  if (btnUp) btnUp.addEventListener('click', () => sendCmd('servo_down'));
  if (btnDown) btnDown.addEventListener('click', () => sendCmd('servo_up'));
  if (btnLeft) btnLeft.addEventListener('click', () => sendCmd('step_right'));
  if (btnRight) btnRight.addEventListener('click', () => sendCmd('step_left'));
  if (btnStopCursor) btnStopCursor.addEventListener('click', () => sendCmd('stop'));

  if (fireBtn) {
    fireBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_on'); // Preferred dedicated "laser on" endpoint response.
      // Fall back to the older toggle endpoint when the dedicated endpoint is unavailable.
      if (!(res && res.ok) && !isLaserOn) await sendCmd('laser_toggle');
      isLaserOn = true;
    });
  }
  if (stopLaserBtn) {
    stopLaserBtn.addEventListener('click', async () => {
      const res = await sendCmd('laser_off'); // Preferred dedicated "laser off" endpoint response.
      if (!(res && res.ok) && isLaserOn) await sendCmd('laser_toggle');
      isLaserOn = false;
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      if (!(window.SkyShieldFollow && typeof window.SkyShieldFollow.toggle === 'function')) {
        logConsole('Auto-follow module unavailable.', 'text-warning');
        return;
      }
      await window.SkyShieldFollow.toggle();
    });
  }
  if (scanBtn) scanBtn.addEventListener('click', () => alert('Scan mode is not available on the HTTP-only firmware.'));

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        if (window.SkyShieldFollow && typeof window.SkyShieldFollow.disable === 'function') {
          await window.SkyShieldFollow.disable({ silent: true, stopRig: true });
        }
        if (window.SkyShieldAuth && window.SkyShieldAuth.logout) await window.SkyShieldAuth.logout();
      } catch (err) {
        console.error('Logout failed', err);
      } finally {
        window.location.href = 'index.html';
      }
    });
  }

// Camera load/error group:
// - load event means the image has real pixels, so the overlay and detector may start
// - error event means try the next candidate URL before fully giving up
//START DETECTING
  if (feedImg) {
    feedImg.addEventListener('load', () => {
      // Once the image has real pixels, resize the overlay to match it.
      syncOverlaySize();
      logConsole('Camera stream connected.', 'text-success');
      if (overlayCanvas) overlayCanvas.classList.remove('d-none');
      // Only start inference after the browser confirms that the image element has real pixels to read.
      //START DETECTING
      // Detection begins here by starting the repeating detection loop.
      startDetectionLoop();
    });
    feedImg.addEventListener('error', () => {
      // Stop the old detection loop before trying another URL candidate.
      stopDetectionLoop('error');
      if (streamCandidates.length && streamCandidateIndex < streamCandidates.length - 1) {
        streamCandidateIndex += 1;
        const next = streamCandidates[streamCandidateIndex]; // Next fallback stream URL built from the original camera address.
        // Each retry is just another URL form for the same camera, not a different persisted stream choice.
        setReadout(statusLabel, `Retrying stream via ${next}`);
        logConsole(`Stream retry: ${next}`, 'text-warning');
        feedImg.src = next;
        return;
      }
      // If every candidate fails, return to the placeholder so the page clearly shows a disconnected state.
      setReadout(statusLabel, 'Stream error - check address / CORS / path');
      logConsole('Tip: if the stream opens in a tab but inference fails, confirm the camera still sends CORS headers.', 'text-warning');
      logConsole('Stream failed for all candidates.', 'text-danger');
      if (!localStorage.getItem(STORAGE_KEY)) firebaseState.autoAppliedCamera = '';
      feedImg.classList.add('d-none');
      if (placeholder) placeholder.classList.remove('d-none');
    });
  }

  // Saved-state restore group:
  // - restore controller first so the assist/calibration cards can refresh early
  // - restore camera second so stream loading can begin automatically
  // - if nothing is saved, show the page in an explicit idle state
  const savedCamera = localStorage.getItem(STORAGE_KEY); // Previously saved camera URL restored on page load.
  const savedEsp = localStorage.getItem(ESP32_STORAGE_KEY); // Previously saved controller URL restored on page load.
  if (savedEsp && esp32IpInput) {
    esp32IpInput.value = savedEsp;
    // Restore the last controller immediately so the page behaves like a persistent dashboard.
    syncLaserState();
    syncControllerConfig(false);
  }
  if (savedCamera) {
    if (urlInput) urlInput.value = savedCamera;
    // Restore the last stream URL so the operator can resume with minimal re-entry.
    setStream(savedCamera);
  } else {
    setReadout(statusLabel, 'Stream idle');
    if (placeholder) placeholder.classList.remove('d-none');
    if (feedImg) feedImg.classList.add('d-none');
  }

  window.addEventListener('resize', syncOverlaySize);
  if (window.SkyShieldAuth) {
    // Protected-page flow:
    // - requireAuth waits for Firebase auth state
    // - only authenticated users stay on the page
    // - once authenticated, Firebase RTDB sync begins
    // Auth is started last so all helpers are ready before Firebase callbacks begin updating the page.
    window.SkyShieldAuth.requireAuth({
      onAuthenticated: () => startFirebaseSync(),
    });
  } else {
    console.error('SkyShieldAuth module missing. Protected routes may be vulnerable.');
  }
}
