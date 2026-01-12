let model;
let modelReady = false;
let isDetecting = false;
let lastDroneCenter = null;

const sourceImage = document.getElementById("sourceImage");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctx = overlayCanvas.getContext("2d");

const statusEl = document.getElementById("status");
const droneIndicator = document.getElementById("drone-indicator");
const detectButton = document.getElementById("detectButton");
const fileInput = document.getElementById("fileInput");
const espUrlInput = document.getElementById("espUrl");
const loadFromEspButton = document.getElementById("loadFromEsp");
const coordReadout = document.getElementById("coord-readout");
const pixelsPerUnitInput = document.getElementById("pixelsPerUnit");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function setDroneIndicator(state, text) {
  droneIndicator.className = "";
  if (state) {
    droneIndicator.classList.add(state);
  }
  droneIndicator.textContent = text || "";
}

function setCoordReadout(text) {
  if (!coordReadout) {
    return;
  }
  coordReadout.textContent = text || "";
}

function getPixelsPerUnit() {
  if (!pixelsPerUnitInput) {
    return 1;
  }
  const value = Number.parseFloat(pixelsPerUnitInput.value);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clearCoordReadout() {
  lastDroneCenter = null;
  setCoordReadout("");
}

function updateCoordReadout() {
  if (!lastDroneCenter) {
    return;
  }
  const pixelsPerUnit = getPixelsPerUnit();
  const imageCenterX = overlayCanvas.width / 2;
  const imageCenterY = overlayCanvas.height / 2;
  const relX = (lastDroneCenter.x - imageCenterX) / pixelsPerUnit;
  const relY = (imageCenterY - lastDroneCenter.y) / pixelsPerUnit;
  const unitLabel = Math.abs(pixelsPerUnit - 1) < 1e-6 ? "px" : "units";
  setCoordReadout(
    `Position (center=0,0): x=${relX.toFixed(2)} y=${relY.toFixed(2)} ${unitLabel}`
  );
}

function clearOverlay() {
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function resizeCanvasToImage() {
  if (!sourceImage.naturalWidth || !sourceImage.naturalHeight) {
    return;
  }
  overlayCanvas.width = sourceImage.clientWidth || sourceImage.naturalWidth;
  overlayCanvas.height = sourceImage.clientHeight || sourceImage.naturalHeight;
}

async function ensureModel() {
  if (modelReady && model) {
    return;
  }

  try {
    setStatus("טוען מודל COCO‑SSD (TensorFlow.js)...");
    model = await cocoSsd.load();
    modelReady = true;
    setStatus("המודל נטען. אפשר להריץ זיהוי.");
  } catch (err) {
    console.error(err);
    setStatus("שגיאה בטעינת המודל. בדוק חיבור אינטרנט.");
  }
}

async function runDetection() {
  if (isDetecting) {
    return;
  }

  if (!sourceImage.src) {
    setStatus("אין תמונה לניתוח. טען תמונה קודם.");
    return;
  }

  await ensureModel();
  if (!modelReady || !model) {
    return;
  }

  if (!sourceImage.complete || sourceImage.naturalWidth === 0) {
    setStatus("ממתין לטעינת התמונה...");
    await new Promise((resolve) => {
      sourceImage.onload = () => resolve();
      sourceImage.onerror = () => resolve();
    });
  }

  resizeCanvasToImage();
  clearOverlay();
  setStatus("מריץ זיהוי אובייקטים...");
  setDroneIndicator("", "");
  clearCoordReadout();
  isDetecting = true;
  detectButton.disabled = true;

  try {
    const predictions = await model.detect(sourceImage);
    clearOverlay();

    const droneLabels = ["airplane", "bird", "kite"];
    const droneDetections = [];
    const scaleX =
      (sourceImage.clientWidth || sourceImage.naturalWidth) /
      sourceImage.naturalWidth;
    const scaleY =
      (sourceImage.clientHeight || sourceImage.naturalHeight) /
      sourceImage.naturalHeight;

    predictions.forEach((p) => {
      const hasDroneLabel = droneLabels.includes(p.class);
      const score = p.score || 0;

      const [rawX, rawY, rawW, rawH] = p.bbox;

      const x = rawX * scaleX;
      const y = rawY * scaleY;
      const w = rawW * scaleX;
      const h = rawH * scaleY;

      ctx.lineWidth = 2;
      ctx.strokeStyle = hasDroneLabel ? "#f97316" : "#22c55e";
      ctx.strokeRect(x, y, w, h);

      const label = `${p.class} ${(score * 100).toFixed(1)}%`;
      ctx.font = "12px system-ui";
      const textWidth = ctx.measureText(label).width + 8;

      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x, Math.max(0, y - 18), textWidth, 18);

      ctx.fillStyle = "#f9fafb";
      ctx.fillText(label, x + 4, Math.max(10, y - 5));

      if (hasDroneLabel) {
        droneDetections.push(p);
      }
    });

    if (droneDetections.length === 0) {
      lastDroneCenter = null;
      setCoordReadout("Position: n/a (no drone detection).");
      setStatus("הזיהוי הסתיים.");
      setDroneIndicator("ok", "לא זוהה רחפן בתמונה.");
    } else {
      setStatus("הזיהוי הסתיים.");
      const best = droneDetections.reduce((a, b) =>
        (a.score || 0) > (b.score || 0) ? a : b
      );
      const scoreText = ((best.score || 0) * 100).toFixed(1) + "%";
      const [rawX, rawY, rawW, rawH] = best.bbox;
      const x = rawX * scaleX;
      const y = rawY * scaleY;
      const w = rawW * scaleX;
      const h = rawH * scaleY;
      lastDroneCenter = { x: x + w / 2, y: y + h / 2 };
      updateCoordReadout();
      setDroneIndicator(
        "alert",
        `זוהה רחפן בתמונה (label=${best.class}) בביטחון ≈ ${scoreText}.`
      );
      console.log("Drone-like detections:", droneDetections);
    }
  } catch (err) {
    console.error(err);
    setStatus("שגיאה במהלך הזיהוי. ראה קונסול.");
  } finally {
    isDetecting = false;
    detectButton.disabled = false;
  }
}

function loadImageFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    sourceImage.onload = () => {
      resizeCanvasToImage();
      clearOverlay();
      setDroneIndicator("", "");
      clearCoordReadout();
      setStatus("תמונה נטענה. אפשר להריץ זיהוי.");
      detectButton.disabled = false;
    };
    sourceImage.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function loadImageFromEsp(url) {
  if (!url) {
    setStatus("הכנס כתובת ESP32-CAM תקינה.");
    return;
  }
  sourceImage.onload = () => {
    resizeCanvasToImage();
    clearOverlay();
    setDroneIndicator("", "");
    clearCoordReadout();
    setStatus("תמונה מה‑ESP32 נטענה. אפשר להריץ זיהוי.");
    detectButton.disabled = false;
  };
  sourceImage.onerror = () => {
    setStatus("שגיאה בטעינת תמונה מה‑ESP32. בדוק את ה‑URL ו‑CORS.");
  };
  sourceImage.src = url;
}

detectButton.addEventListener("click", () => {
  runDetection();
});

fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) {
    loadImageFromFile(file);
  }
});

loadFromEspButton.addEventListener("click", () => {
  const url = espUrlInput.value.trim();
  loadImageFromEsp(url);
});

if (pixelsPerUnitInput) {
  pixelsPerUnitInput.addEventListener("input", () => {
    if (lastDroneCenter) {
      updateCoordReadout();
    }
  });
}

window.addEventListener("load", () => {
  detectButton.disabled = false;
  ensureModel();
});
