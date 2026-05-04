// FILE ROLE: 80-detection-backends.js
// What this file does:
// - Prepares the camera frame for the active AI backend.
// - Loads the COCO or AeroYOLO model/runtime when needed.
// - Runs one inference pass and converts backend-specific output into a shared detection format.
// Why this file exists:
// - COCO and AeroYOLO use different runtimes and input/output shapes.
// - This file hides those backend differences from the rest of the detector.
/**
 * @returns {{source: HTMLImageElement|HTMLCanvasElement, scaleX: number, scaleY: number}|null} Inference source and scale info.
 */
// EXAM: prepare source frame for COCO detection.
function getDetectionSource() {
  if (!(feedImg && feedImg.naturalWidth && feedImg.naturalHeight)) return null;
  // COCO-SSD is lighter than AeroYOLO, but it still benefits from shrinking large frames.
  // This path optionally downscales the stream into a reusable off-screen canvas.
  // Later, rescalePredictionBBox() maps boxes back to the original image coordinates.
  // Calculate how much we can shrink the source while staying inside the configured max dimensions.
  const downscale = Math.min(
    1,
    DETECT_MAX_SOURCE_WIDTH / feedImg.naturalWidth,
    DETECT_MAX_SOURCE_HEIGHT / feedImg.naturalHeight
  ); // Shrink factor chosen so the source stays within the configured inference budget.
  if (downscale >= 0.999) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const surface = ensureDetectSourceSurface(); // Reusable off-screen canvas pair used to avoid allocating a new surface each frame.
  if (!surface) return { source: feedImg, scaleX: 1, scaleY: 1 };
  const width = Math.max(1, Math.round(feedImg.naturalWidth * downscale)); // Downscaled inference width.
  const height = Math.max(1, Math.round(feedImg.naturalHeight * downscale)); // Downscaled inference height.
  // COCO-SSD can work directly on the image element, but this smaller canvas reduces per-frame inference cost a lot.
  // Resize into an off-screen canvas instead of mutating the visible image element.
  if (surface.canvas.width !== width) surface.canvas.width = width;
  if (surface.canvas.height !== height) surface.canvas.height = height;
  surface.ctx.clearRect(0, 0, width, height);
  surface.ctx.drawImage(feedImg, 0, 0, width, height);
  return {
    source: surface.canvas,
    scaleX: feedImg.naturalWidth / width,
    scaleY: feedImg.naturalHeight / height,
  };
}

/**
 * @param {object} prediction - Detection result returned from downscaled inference.
 * @param {number} scaleX - Horizontal expansion factor back to original pixels.
 * @param {number} scaleY - Vertical expansion factor back to original pixels.
 * @returns {object} Prediction with bbox scaled back to original image size.
 */
// EXAM: restore downscaled COCO boxes to real image size.
function rescalePredictionBBox(prediction, scaleX, scaleY) {
  if (!prediction || !Array.isArray(prediction.bbox) || prediction.bbox.length < 4) return prediction;
  // Expand the bbox back into the original image coordinate space after downscaled inference.
  const [x, y, w, h] = prediction.bbox; // Bbox returned from the lower-resolution source image.
  return {
    ...prediction,
    bbox: [x * scaleX, y * scaleY, w * scaleX, h * scaleY],
  };
}

/**
 * @param {number} modelWidth - Width expected by the ONNX model.
 * @param {number} modelHeight - Height expected by the ONNX model.
 * @returns {{input: Float32Array, scale: number, padX: number, padY: number}|null} Prepared tensor data and letterbox info.
 */
// EXAM: preprocess frame for AeroYOLO ONNX input.
function preprocessDroneDetectSource(modelWidth, modelHeight) {
  // ONNX preprocessing steps:
  // 1. Resize the reusable canvas to the model input size.
  // 2. Letterbox the original frame so aspect ratio is preserved.
  // 3. Read RGBA pixels from the canvas.
  // 4. Repack them into CHW float32 format in the 0..1 range.
  // 5. Return both the tensor data and the scale/padding needed to decode boxes later.
  const surface = ensureDetectSourceSurface(); // Reusable canvas/context pair used for ONNX preprocessing.
  if (!surface || !feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight) return null;
  const sourceWidth = feedImg.naturalWidth; // Original stream frame width.
  const sourceHeight = feedImg.naturalHeight; // Original stream frame height.
  // Letterboxing keeps the source aspect ratio while satisfying the fixed ONNX tensor size.
  const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight); // Letterbox scale factor that preserves aspect ratio.
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale)); // Width of the image content inside the model input tensor.
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale)); // Height of the image content inside the model input tensor.
  const padX = Math.floor((modelWidth - drawWidth) / 2); // Horizontal left/right letterbox padding.
  const padY = Math.floor((modelHeight - drawHeight) / 2); // Vertical top/bottom letterbox padding.
  // Resize the reusable canvas to exactly match the model input tensor size.
  if (surface.canvas.width !== modelWidth) surface.canvas.width = modelWidth;
  if (surface.canvas.height !== modelHeight) surface.canvas.height = modelHeight;
  surface.ctx.clearRect(0, 0, modelWidth, modelHeight);
  surface.ctx.fillStyle = '#727272';
  // Fill the letterbox padding with a neutral gray so empty areas are consistent frame to frame.
  surface.ctx.fillRect(0, 0, modelWidth, modelHeight);
  surface.ctx.drawImage(feedImg, padX, padY, drawWidth, drawHeight);
  const imageData = surface.ctx.getImageData(0, 0, modelWidth, modelHeight).data; // Flat RGBA pixel buffer for the resized letterboxed frame.
  const channelSize = modelWidth * modelHeight; // Number of pixels per color channel in the model input.
  // Allocate [R-plane][G-plane][B-plane] because ONNX expects CHW layout, not RGBA pixels.
  const input = new Float32Array(channelSize * 3); // Final CHW float input buffer consumed by ONNX Runtime.
  // ONNX expects CHW float32 input in the 0..1 range.
  for (let pixel = 0, i = 0; i < imageData.length; i += 4, pixel += 1) {
    input[pixel] = imageData[i] / 255;
    input[channelSize + pixel] = imageData[i + 1] / 255;
    input[channelSize * 2 + pixel] = imageData[i + 2] / 255;
  }
  return { input, scale, padX, padY };
}

/**
 * @param {number[]} bbox - Bounding box to clamp into the visible feed dimensions.
 * @returns {number[]} Safe bbox inside the feed bounds.
 */
// EXAM: clamp decoded box to image bounds.
function clampBboxToFeed(bbox) {
  if (!feedImg || !feedImg.naturalWidth || !feedImg.naturalHeight || !Array.isArray(bbox) || bbox.length < 4) return bbox;
  // Clamp the decoded model box so drawing math never exceeds the image bounds.
  const [rawX, rawY, rawW, rawH] = bbox; // Raw decoded bbox before enforcing image bounds.
  const x = Math.max(0, Math.min(feedImg.naturalWidth, rawX)); // Left edge clamped into the visible image width.
  const y = Math.max(0, Math.min(feedImg.naturalHeight, rawY)); // Top edge clamped into the visible image height.
  const w = Math.max(0, Math.min(feedImg.naturalWidth - x, rawW)); // Width clamped so the box does not extend past the image.
  const h = Math.max(0, Math.min(feedImg.naturalHeight - y, rawH)); // Height clamped so the box does not extend past the image.
  return [x, y, w, h];
}

/**
 * @param {ArrayLike<number>} data - Flat ONNX output buffer.
 * @param {number} offset - Starting index of the current prediction row.
 * @param {{scale: number, padX: number, padY: number}} prepared - Letterbox metadata used to decode the row.
 * @returns {object|null} Decoded prediction in shared bbox format.
 */
// EXAM: decode one ONNX row into shared prediction format.
function normalizeDroneModelPrediction(data, offset, prepared) {
  if (!prepared || !Number.isFinite(prepared.scale) || prepared.scale <= 0) return null;
  // Read one 6-value prediction row from the flat ONNX output buffer.
  const x1 = Number(data[offset]); // Raw left coordinate from the ONNX output row.
  const y1 = Number(data[offset + 1]); // Raw top coordinate from the ONNX output row.
  const x2 = Number(data[offset + 2]); // Raw right coordinate from the ONNX output row.
  const y2 = Number(data[offset + 3]); // Raw bottom coordinate from the ONNX output row.
  const scoreRaw = Number(data[offset + 4]); // Raw confidence score from the ONNX output row.
  const classIdRaw = Number(data[offset + 5]); // Raw class id from the ONNX output row.
  const score = Number.isFinite(scoreRaw) ? scoreRaw : 0; // Safe normalized confidence score.
  const classId = Number.isFinite(classIdRaw) ? Math.round(classIdRaw) : -1; // Safe integer class id.
  // Unknown class ids are still preserved under a synthetic label so debugging output stays inspectable.
  const className = DRONE_MODEL_LABELS[classId] || `class_${classId}`; // Human-readable label looked up from the class map.
  const width = Math.max(0, (x2 - x1) / prepared.scale); // Decoded bbox width after undoing model-space scaling.
  const height = Math.max(0, (y2 - y1) / prepared.scale); // Decoded bbox height after undoing model-space scaling.
  const bbox = clampBboxToFeed([
    (x1 - prepared.padX) / prepared.scale,
    (y1 - prepared.padY) / prepared.scale,
    width,
    height,
  ]); // Final bbox converted back into original image coordinates and clamped into bounds.
  // Convert the raw model row into the same shape returned by COCO-SSD so the rest of the pipeline stays shared.
  return {
    class: className,
    score,
    classId,
    bbox,
  };
}

// Section: model bootstrapping and inference.
// Model bootstrap is backend-specific: TF.js for COCO-SSD and ONNX Runtime Web for AeroYOLO.
/**
 * @returns {Promise<void>} Resolves after TensorFlow backend selection is complete.
 */
// EXAM: initialize TensorFlow backend.
async function ensureDetectBackend() {
  // Skip setup if it already happened or if TensorFlow is unavailable on this page.
  if (detectBackendReady || !window.tf) return;
  try {
    // Wait for TensorFlow.js runtime initialization to finish.
    await tf.ready();
    const currentBackend = typeof tf.getBackend === 'function' ? tf.getBackend() : ''; // TensorFlow backend currently active before any switch attempt.
    if (currentBackend !== 'webgl' && typeof tf.findBackend === 'function' && tf.findBackend('webgl')) {
      // Prefer WebGL for browser inference if it exists.
      await tf.setBackend('webgl');
      await tf.ready();
    }
    detectBackendReady = true;
    if (typeof tf.getBackend === 'function') logConsole(`TF backend: ${tf.getBackend()}`, 'text-muted');
  } catch (err) {
    detectBackendReady = true;
    console.warn('Failed to switch TensorFlow backend.', err);
  }
}

/**
 * @returns {Promise<object|null>} Loaded COCO-SSD model instance.
 */
// EXAM: load and cache COCO-SSD.
async function ensureCocoDetectModel() {
  // Reuse the already-loaded model if it is present.
  if (detectModelReady && detectModel) return detectModel;
  if (!window.cocoSsd) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('COCO-SSD model missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
    await ensureDetectBackend();
    // Load the COCO-SSD model bundle from the global library.
    detectModel = await cocoSsd.load();
    detectModelReady = true;
    setDetectStatus('Detect: ready', 'bg-success');
    logConsole('Detection model loaded.', 'text-success');
    return detectModel;
  } catch (err) {
    console.error('Detection model load failed', err);
    setDetectStatus('Detect: load failed', 'bg-danger');
    logConsole('Detection model load failed.', 'text-danger');
    return null;
  }
}

/**
 * @returns {Promise<object|null>} Loaded ONNX Runtime inference session.
 */
// EXAM: load and cache the AeroYOLO ONNX session.
async function ensureDroneDetectSession() {
  // Backend strategy:
  // - Prefer WebGPU because browser GPU inference is faster when available.
  // - Fall back to WASM so the detector still runs on weaker or unsupported machines.
  // - Cache the session because creating it is expensive compared to a normal frame pass.
  // Reuse the already-created ONNX session if it is ready.
  if (droneDetectSessionReady && droneDetectSession) return droneDetectSession;
  if (!(window.ort && ort.InferenceSession && ort.Tensor)) {
    setDetectStatus('Detect: model missing', 'bg-danger');
    logConsole('ONNX Runtime Web support missing.', 'text-danger');
    return null;
  }
  setDetectStatus('Detect: loading', 'bg-warning');
  try {
    // Use one WASM thread to keep resource use predictable on small machines.
    if (ort.env && ort.env.wasm) ort.env.wasm.numThreads = 1;
    try {
      droneDetectSession = await ort.InferenceSession.create(DRONE_MODEL_URL, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (primaryErr) {
      // WebGPU is preferred, but WASM keeps the detector usable on machines without it.
      console.warn('AeroYOLO WebGPU session failed, retrying with WASM only.', primaryErr);
      droneDetectSession = await ort.InferenceSession.create(DRONE_MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    }
    droneDetectSessionReady = true;
    setDetectStatus('Detect: ready', 'bg-success');
    logConsole('AeroYOLO model loaded.', 'text-success');
    return droneDetectSession;
  } catch (err) {
    console.error('AeroYOLO model load failed', err);
    setDetectStatus('Detect: load failed', 'bg-danger');
    logConsole('AeroYOLO model load failed.', 'text-danger');
    return null;
  }
}

// Each backend returns normalized prediction objects with a class, confidence score, and bbox.
/**
 * @returns {Promise<object[]>} Normalized predictions from the COCO backend.
 */
// EXAM: run one COCO inference pass.
async function detectWithCoco() {
  const model = await ensureCocoDetectModel(); // Cached or newly loaded COCO model instance.
  if (!model) return [];
  const detectionSource = getDetectionSource(); // Original image or downscaled off-screen source used for COCO inference.
  if (!detectionSource) return [];
  // Run COCO-SSD on either the original image or the downscaled off-screen canvas.
  const rawPredictions = await model.detect(detectionSource.source); // Raw predictions produced by COCO-SSD for this frame.
  return (detectionSource.scaleX === 1 && detectionSource.scaleY === 1)
    ? rawPredictions
    : rawPredictions.map((prediction) => rescalePredictionBBox(prediction, detectionSource.scaleX, detectionSource.scaleY));
}

/**
 * @returns {Promise<object[]>} Normalized predictions from the AeroYOLO backend.
 */
// EXAM: run one AeroYOLO inference pass.
async function detectWithAeroYolo() {
  // Function flow:
  // 1. Ensure the ONNX session exists.
  // 2. Read model input dimensions from session metadata.
  // 3. Preprocess the current frame into an ONNX tensor.
  // 4. Run the model.
  // 5. Decode every output row into the shared { class, score, bbox } format.
  const session = await ensureDroneDetectSession(); // Cached or newly created ONNX inference session.
  if (!session) return [];
  // Resolve the model input/output names from session metadata when possible.
  const inputName = session.inputNames && session.inputNames[0] ? session.inputNames[0] : 'images'; // Effective ONNX input tensor name.
  const outputName = session.outputNames && session.outputNames[0] ? session.outputNames[0] : 'output0'; // Effective ONNX output tensor name.
  const inputMeta = session.inputMetadata && session.inputMetadata[inputName] ? session.inputMetadata[inputName] : null; // Optional ONNX metadata describing input dimensions.
  const dims = inputMeta && Array.isArray(inputMeta.dimensions) ? inputMeta.dimensions : [1, 3, 640, 640]; // Fallback-safe ONNX input shape.
  const modelHeight = Number(dims[2]) || 640; // Height expected by the ONNX model input tensor.
  const modelWidth = Number(dims[3]) || 640; // Width expected by the ONNX model input tensor.
  const prepared = preprocessDroneDetectSource(modelWidth, modelHeight); // Preprocessed image tensor data + letterbox metadata.
  if (!prepared) return [];
  // Build the input tensor in the exact shape expected by the model.
  const tensor = new ort.Tensor('float32', prepared.input, [1, 3, modelHeight, modelWidth]); // Final ONNX input tensor for one frame.
  // The session output is backend-specific, so the next block normalizes it into the shared prediction contract.
  const result = await session.run({ [inputName]: tensor }); // Raw map of ONNX output tensors returned for this frame.
  const outputTensor = result && result[outputName] ? result[outputName] : null; // Main prediction tensor selected by output name.
  if (!outputTensor || !outputTensor.data || !Array.isArray(outputTensor.dims)) return [];
  // The current model returns one row per box, with 6 values per row: x1, y1, x2, y2, score, classId.
  const rows = outputTensor.dims[1] || 0; // Number of predicted boxes returned by the model.
  const stride = outputTensor.dims[2] || 6; // Number of scalar values stored per predicted row.
  const predictions = []; // Shared-format predictions accumulated from decoded ONNX rows.
  for (let i = 0; i < rows; i += 1) {
    const offset = i * stride; // Starting index of the current row inside the flat output buffer.
    // Decode each output row into the shared { class, score, bbox } shape.
    const prediction = normalizeDroneModelPrediction(outputTensor.data, offset, prepared); // Decoded shared-format prediction for this row.
    if (prediction) predictions.push(prediction);
  }
  return predictions;
}

// runDetection is the core detection pass: predict, select, update the HUD, log, and export telemetry.
/**
 * @returns {Promise<void>} Resolves after one detection pass finishes.
 */
// EXAM: full detection pipeline for one frame.
