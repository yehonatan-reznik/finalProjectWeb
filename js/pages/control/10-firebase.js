// FILE ROLE: 10-firebase.js
// What this file does:
// - Connects the control page to Firebase Realtime Database.
// - Reads incoming Firebase snapshots and mirrors them into page values.
// - Optionally auto-fills the camera URL and controller URL from Firebase.
// Why this file exists:
// - Firebase sync is separate from direct ESP32 commands.
// - This file is only about shared cloud-side state and live updates, not manual control.
// Every Firebase snapshot can update the HUD and optionally auto-fill camera/controller URLs.
/**
 * @param {object|null} data - Latest RTDB root snapshot data.
 */
// EXAM: Firebase snapshot application and auto-fill.
function applyFirebaseSnapshot(data) {
  // Function flow:
  // 1. Read the newest Firebase snapshot.
  // 2. Extract camera/controller URLs and optional state values.
  // 3. Mirror those values into the read-only dashboard cards.
  // 4. Update browser-side cached flags like isLaserOn.
  // 5. Auto-apply URLs only if this browser has no stronger local override.
  firebaseState.lastSnapshot = data || null;
  // Read the camera URL from the newer nested shape first, then fall back to the older flat keys.
  // Support both the newer nested RTDB structure and the older root-level fallback keys.
  const cameraUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['camera', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'cameraIP', '')
  ); // Best available camera URL from either the nested or legacy schema.
  // Do the same fallback lookup for the controller URL.
  const controllerUrl = normalizeFirebaseUrl(
    getFirebaseSnapshotValue(data, ['controller', 'state', 'urlBase'], '') ||
    getFirebaseSnapshotValue(data, 'espIP', '')
  ); // Best available controller URL from either the nested or legacy schema.
  // Remaining status values are optional and may not exist on every firmware/database revision.
  const laserValue = getFirebaseSnapshotValue(data, ['controller', 'state', 'laserOn'], getFirebaseSnapshotValue(data, 'laserOn', null)); // Optional laser state mirrored from Firebase.
  const homeX = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeX'], getFirebaseSnapshotValue(data, 'homeX', null)), null); // Optional saved home X coordinate.
  const homeY = readFirebaseNumber(getFirebaseSnapshotValue(data, ['controller', 'config', 'homeY'], getFirebaseSnapshotValue(data, 'homeY', null)), null); // Optional saved home Y coordinate.

  // Mirror Firebase values into the read-only status cards before deciding whether anything should be auto-applied.
  if (firebaseCameraVal) firebaseCameraVal.textContent = formatFirebaseValue(cameraUrl);
  if (firebaseControllerVal) firebaseControllerVal.textContent = formatFirebaseValue(controllerUrl);
  if (firebaseLaserVal) firebaseLaserVal.textContent = laserValue === null || typeof laserValue === 'undefined' ? 'n/a' : (Number(laserValue) === 1 ? 'On' : 'Off');
  if (firebaseHomeVal) firebaseHomeVal.textContent = Number.isFinite(homeX) && Number.isFinite(homeY) ? `${homeX} / ${homeY}` : 'n/a';
  setFirebaseStatus('Live');

  // Keep the local laser flag synchronized even when the operator never pressed a laser button in this tab.
  if (laserValue !== null && typeof laserValue !== 'undefined') {
    isLaserOn = Number(laserValue) === 1;
  }

  // Only auto-apply Firebase values when the operator has not already saved a local override in this browser.
  if (!localStorage.getItem(STORAGE_KEY) && cameraUrl && firebaseState.autoAppliedCamera !== cameraUrl) {
    firebaseState.autoAppliedCamera = cameraUrl;
    if (urlInput) urlInput.value = cameraUrl;
    setStream(cameraUrl, { persist: false });
    logConsole(`Firebase camera URL loaded: ${cameraUrl}`, 'text-info');
  }

  if (!localStorage.getItem(ESP32_STORAGE_KEY) && controllerUrl && firebaseState.autoAppliedController !== controllerUrl) {
    firebaseState.autoAppliedController = controllerUrl;
    if (esp32IpInput) esp32IpInput.value = controllerUrl;
    // Pull live status/config immediately after learning the controller URL from Firebase.
    syncLaserState();
    syncControllerConfig(false).then((config) => {
      if (!config && !localStorage.getItem(ESP32_STORAGE_KEY)) firebaseState.autoAppliedController = '';
    });
    logConsole(`Firebase controller URL loaded: ${controllerUrl}`, 'text-info');
  }
}

// The control page listens at the RTDB root because camera IP, controller IP, and boot config share the same tree.
// EXAM: Firebase listener startup.
function startFirebaseSync() {
  // Why this exists:
  // - The page wants one live source of truth for discovered device URLs and boot-time state.
  // - Firebase is used as discovery/sync, not as the movement transport layer.
  // - One root listener is enough because camera + controller data live in the same RTDB tree.
  // Prevent duplicate listeners if init() or auth callbacks run more than once.
  if (firebaseState.syncStarted) return;
  firebaseState.syncStarted = true;
  // Make sure the auth wrapper exists and exposes the database getter.
  if (!(window.SkyShieldAuth && typeof window.SkyShieldAuth.getDatabase === 'function')) {
    setFirebaseStatus('SDK unavailable');
    return;
  }
  // Ask the auth wrapper for the already-created RTDB instance.
  const db = window.SkyShieldAuth.getDatabase(); // Shared RTDB instance created by the auth/bootstrap layer.
  if (!db) {
    setFirebaseStatus('Database unavailable');
    return;
  }
  try {
    // Listen at the root because this project stores camera, controller, and config data together.
    firebaseState.rootRef = db.ref('/');
    firebaseState.rootRef.on('value', (snapshot) => {
      // Convert the snapshot into plain data before handing it to the UI updater.
      applyFirebaseSnapshot(snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null);
    }, (error) => {
      console.error('Firebase RTDB listener failed.', error);
      setFirebaseStatus('Read failed');
      // Mirror the error into the event console so the operator can see it without DevTools.
      if (error && error.message) logConsole(`Firebase read failed: ${error.message}`, 'text-warning');
    });
    // This page never detaches the listener during normal use because the control dashboard is effectively single-screen.
    setFirebaseStatus('Listening');
  } catch (err) {
    console.error('Failed to start Firebase RTDB sync.', err);
    setFirebaseStatus('Init failed');
  }
}














/*
EXAM COMMENT GLOSSARY FOR 10-firebase.js FIREBASE REALTIME DATABASE SYNC

10-firebase.js:
This file connects the control page to Firebase Realtime Database. It reads live Firebase snapshots, mirrors camera/controller/laser/home values into the dashboard, and can auto-fill the camera URL or ESP32 controller URL if the browser does not already have a saved local value.

Firebase:
Cloud database/service used here for shared state and discovery. In this project Firebase is not the direct movement transport. Direct movement commands still go to the ESP32 over HTTP.

Firebase Realtime Database:
A Firebase database that can notify the page live whenever values change.

RTDB:
Short for Realtime Database.

Firebase snapshot:
A live database read result. It contains the latest data from a database path.

applyFirebaseSnapshot:
Reads the newest Firebase data object and applies it to the page. It extracts camera URL, controller URL, laser state, and saved home position, updates read-only dashboard fields, updates isLaserOn, and optionally auto-applies camera/controller URLs.

data:
The latest Firebase root snapshot data as a plain object. It can be null if the database path has no data.

firebaseState:
Shared object that stores Firebase sync state, such as whether sync started, latest snapshot, root reference, and whether Firebase values were already auto-applied.

firebaseState.lastSnapshot:
Stores the latest Firebase data object. Useful for debugging or later logic.

data || null:
If data exists, keep it. If it is empty/undefined, store null.

cameraUrl:
Best camera URL found in Firebase. The code checks the newer nested path first, then falls back to the older cameraIP key.

controllerUrl:
Best ESP32 controller URL found in Firebase. The code checks the newer nested path first, then falls back to the older espIP key.

normalizeFirebaseUrl:
Cleans a Firebase URL value into a safe string format. It usually wraps normalizeBaseUrl behavior.

getFirebaseSnapshotValue:
Safely reads a nested value from Firebase data. It avoids crashes when some keys are missing.

['camera', 'state', 'urlBase']:
Newer nested Firebase path for camera URL.

cameraIP:
Older legacy Firebase key for camera URL.

['controller', 'state', 'urlBase']:
Newer nested Firebase path for ESP32/controller URL.

espIP:
Older legacy Firebase key for ESP32/controller URL.

laserValue:
Optional laser state read from Firebase. It can come from controller.state.laserOn or older laserOn key.

['controller', 'state', 'laserOn']:
Newer nested Firebase path for laser state.

laserOn:
Older legacy Firebase key for laser state.

homeX:
Optional saved home X coordinate read from Firebase.

homeY:
Optional saved home Y coordinate read from Firebase.

readFirebaseNumber:
Converts a Firebase value into a number safely. If parsing fails, it returns fallback.

['controller', 'config', 'homeX']:
Newer nested Firebase path for saved home X.

['controller', 'config', 'homeY']:
Newer nested Firebase path for saved home Y.

firebaseCameraVal:
Dashboard field that shows the camera URL currently known from Firebase.

firebaseControllerVal:
Dashboard field that shows the ESP32/controller URL currently known from Firebase.

firebaseLaserVal:
Dashboard field that shows Firebase laser state as On, Off, or n/a.

firebaseHomeVal:
Dashboard field that shows saved home coordinates, usually homeX / homeY.

formatFirebaseValue:
Formats missing Firebase values as n/a and valid values as readable text.

Number(laserValue) === 1:
Treats laser value 1 as On. Any other numeric value is treated as Off.

Number.isFinite:
Checks whether a value is a real usable number.

`${homeX} / ${homeY}`:
Displays home coordinates as X / Y.

setFirebaseStatus:
Updates the Firebase sync status label in the dashboard.

setFirebaseStatus('Live'):
Shows that Firebase data has been received and applied.

isLaserOn:
Browser-side cached laser state. Firebase can update it even if the operator did not press the laser buttons in this tab.

laserValue !== null && typeof laserValue !== 'undefined':
Checks that Firebase actually provided a laser value before updating isLaserOn.

localStorage.getItem(STORAGE_KEY):
Checks whether this browser already has a saved camera URL. If it does, local value wins over Firebase auto-fill.

STORAGE_KEY:
localStorage key for the saved camera URL.

firebaseState.autoAppliedCamera:
Boolean that prevents Firebase camera URL from being auto-applied repeatedly.

urlInput:
Camera URL input on the page.

setStream(cameraUrl):
Starts loading the camera stream from the Firebase camera URL.

Firebase camera URL loaded:
Console message shown when Firebase auto-filled the camera URL.

localStorage.getItem(ESP32_STORAGE_KEY):
Checks whether this browser already has a saved ESP32/controller URL.

ESP32_STORAGE_KEY:
localStorage key for the saved ESP32/controller URL.

firebaseState.autoAppliedController:
Boolean that prevents Firebase controller URL from being auto-applied repeatedly.

esp32IpInput:
ESP32/controller URL input on the page.

localStorage.setItem(ESP32_STORAGE_KEY, controllerUrl):
Saves the Firebase controller URL locally after auto-applying it.

syncLaserState:
Fetches live ESP32 status after learning the controller URL.

syncControllerConfig(false):
Fetches ESP32 controller config without logging success.

Firebase controller URL loaded:
Console message shown when Firebase auto-filled the controller URL.

local override:
A saved value in this browser’s localStorage. The code respects local overrides so Firebase does not unexpectedly replace what the operator already chose.

startFirebaseSync:
Starts listening to Firebase Realtime Database. It prevents duplicate listeners, checks that the auth/database wrapper exists, gets the database instance, attaches a root listener, and updates Firebase status.

firebaseState.syncStarted:
True after Firebase sync was started. It prevents creating duplicate Firebase listeners.

if (firebaseState.syncStarted) return:
Stops the function if sync already started.

window.SkyShieldAuth:
Global authentication/bootstrap helper object used by this project.

window.SkyShieldAuth.getDatabase:
Function expected to return the Firebase Realtime Database instance.

typeof window.SkyShieldAuth.getDatabase === 'function':
Checks that getDatabase exists and is callable.

SDK unavailable:
Status shown when the Firebase/Auth wrapper is missing or does not expose getDatabase.

db:
Firebase Realtime Database instance returned by SkyShieldAuth.getDatabase.

Database unavailable:
Status shown when getDatabase did not return a valid database instance.

try/catch in startFirebaseSync:
Prevents Firebase startup errors from crashing the whole page.

firebaseState.rootRef:
Stores the Firebase database reference used for the root listener.

db.ref('/'):
Creates a Firebase reference to the root of the Realtime Database.

root listener:
A listener attached to the database root path. It sees camera, controller, and config updates in one place.

firebaseState.rootRef.on('value', ...):
Subscribes to live value updates from Firebase. The callback runs whenever the root data changes.

value:
Firebase event type meaning “give me the current value and future value changes.”

snapshot:
Firebase snapshot object passed into the listener callback.

snapshot.val:
Firebase method that returns the actual JavaScript data stored at the path.

typeof snapshot.val === 'function':
Safety check before calling snapshot.val.

applyFirebaseSnapshot(snapshot.val()):
Applies the latest Firebase database data to the dashboard.

error:
Firebase listener error object.

Firebase RTDB listener failed:
Developer-console error message when the listener cannot read from Firebase.

setFirebaseStatus('Read failed'):
Shows Firebase read failure in the dashboard.

error.message:
Readable Firebase error message.

Firebase read failed:
Visible event-console warning shown when Firebase read fails.

setFirebaseStatus('Listening'):
Shows that the Firebase listener was attached successfully. It may switch to Live after data arrives.

Failed to start Firebase RTDB sync:
Developer-console error if listener startup fails.

setFirebaseStatus('Init failed'):
Dashboard status shown when Firebase listener initialization fails.

cloud-side state:
Values stored in Firebase, such as camera/controller URLs and optional controller state.

direct ESP32 commands:
Manual movement/laser/status commands sent directly to the ESP32 using HTTP. This file does not send those movement commands.

auto-fill:
Automatically placing Firebase camera/controller URL into page inputs and starting setup, but only when localStorage has no saved override.

legacy schema:
Older flat Firebase keys like cameraIP, espIP, laserOn, homeX, and homeY.

nested schema:
Newer Firebase structure like camera.state.urlBase and controller.state.urlBase.

exam summary:
This file handles Firebase sync for the control dashboard. applyFirebaseSnapshot reads Firebase data, updates dashboard fields, syncs laser state, and auto-fills camera/controller URLs only when no local override exists. startFirebaseSync starts one live RTDB root listener after authentication/database setup is available. Firebase is used for discovery and shared state, while direct ESP32 HTTP commands are handled in the transport file.
*/
