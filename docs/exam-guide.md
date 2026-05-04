# SkyShield Exam Guide

This file is the fast-search companion to the longer [study-guide.md](/c:/Users/Owner/Desktop/website/code/docs/study-guide.md:1).

Use it during an exam when you need to answer quickly and then jump into the real code with `Ctrl+F`.

## How To Use It

1. Read the question.
2. Find the matching topic below.
3. `Ctrl+F` the suggested term in the suggested file.
4. If you need the long explanation, open `docs/study-guide.md`.

## Question -> Search Map

| If they ask about... | First file to open | Search for |
| --- | --- | --- |
| Where the AI runs | `docs/study-guide.md` | `Where does the AI run?` |
| Which file manages the page | `js/pages/control.js` | `Reading guide` |
| Which file does detection | `js/pages/control-detection.js` | `Pipeline summary` |
| What `threshold` means | `js/pages/control-detection.js` | `threshold` |
| Difference between possible and strong target | `js/pages/control-detection.js` | `possible target` |
| What `dead zone` means | `js/pages/control-detection.js` | `dead zone` |
| What `track lock` means | `js/pages/control-detection.js` | `track lock` |
| Where telemetry is stored/exported | `js/pages/control-detection.js` | `telemetry` |
| How target selection works | `js/pages/control-detection.js` | `chooseCandidate` |
| How smoothing works | `js/pages/control-detection.js` | `smoothMetrics` |
| Why overlay boxes line up with the image | `js/pages/control-detection.js` | `getImageFit` |
| Why `Up` may send `servo_down` | `js/pages/control.js` | `MANUAL_BUTTON_COMMANDS` |
| What operator assist means | `js/pages/control.js` | `operator assist` |
| What calibration means | `js/pages/control.js` | `calibration` |
| How Firebase helps | `js/pages/control.js` | `Firebase auto-apply` |
| How the stream URL is built/retried | `js/pages/control.js` | `setStream` |
| How ESP32 commands are sent | `js/pages/control.js` | `sendCmd` |
| What auth does | `js/auth.js` | `requireAuth` |
| How login redirect works | `js/auth.js` or `js/pages/login.js` | `redirect` |
| Which HTML id is used for the camera | `html/control.html` | `cameraFeed` |
| Which CSS styles the camera shell | `css/style.css` | `camera` |
| What CORS breaks | `docs/study-guide.md` | `CORS` |
| What AeroYOLO is | `js/pages/control-detection.js` | `AeroYOLO` |
| What COCO-SSD is | `js/pages/control-detection.js` | `COCO-SSD` |

## Best Code Search Terms

- `EXAM:`
- `threshold`
- `possible target`
- `strong target`
- `dead zone`
- `track lock`
- `telemetry`
- `operator assist`
- `calibration`
- `setStream`
- `sendCmd`
- `Firebase`
- `ESP32`
- `AeroYOLO`
- `COCO-SSD`
- `CORS`

## File Roles In One Line

- `js/pages/control.js`: page coordinator for UI, stream, controller, Firebase, calibration, and startup.
- `js/pages/control-detection.js`: browser-side detector, target selection, overlay, and telemetry pipeline.
- `js/auth.js`: shared Firebase auth/database bootstrap and route guard.
- `js/pages/login.js`: login-page submit and redirect behavior.
- `html/control.html`: operator dashboard markup and element ids.
- `css/style.css`: shared dashboard appearance and responsive layout.

## Fast Oral Answers

### Where does the AI run?

In the browser on the user machine. The website only serves the page code and model files.

### Is the system autonomous?

No. Detection is automatic, but movement/laser actions are still human-controlled HTTP commands.

### Why use Firebase?

For login, boot-time configuration, and sharing camera/controller addresses. Not for every movement command.

### Why use direct HTTP to the controller?

It is faster and more responsive than routing servo commands through Firebase.

### Why keep both raw center and filtered center?

Raw center is the immediate detection output. Filtered center is smoothed so guidance is less jittery.

### Why are there two thresholds?

One lower threshold marks a weak `possible` target, and one higher threshold marks a full `strong` target.

### Why does track lock exist?

To stay with the same target across nearby frames and reduce flicker when confidence dips slightly.
