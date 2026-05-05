// FILE ROLE: 80-detection-backends.js
// This file prepares model inputs and backend execution: source-frame preprocessing, ONNX output decoding,
// TensorFlow/ONNX runtime loading, and one-frame inference helpers for COCO and AeroYOLO.
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










/*
EXAM COMMENT GLOSSARY FOR FRAME PREPROCESSING AND MODEL INFERENCE

getDetectionSource:
Prepares the camera frame for COCO-SSD detection. If the image is small enough, it uses feedImg directly. If the image is too large, it downscales the frame into an off-screen canvas to make detection faster.

feedImg:
The image element that displays the live camera stream. The detection code reads pixels from this element.

feedImg.naturalWidth:
The real pixel width of the camera frame. If it is missing or zero, the frame is not ready.

feedImg.naturalHeight:
The real pixel height of the camera frame. If it is missing or zero, the frame is not ready.

DETECT_MAX_SOURCE_WIDTH:
The maximum width allowed for the downscaled COCO input. It helps keep browser inference fast.

DETECT_MAX_SOURCE_HEIGHT:
The maximum height allowed for the downscaled COCO input. It helps reduce the amount of pixels the model must process.

downscale:
The scale factor used to shrink the camera frame. It is calculated so the frame stays inside DETECT_MAX_SOURCE_WIDTH and DETECT_MAX_SOURCE_HEIGHT. If downscale is 1, the original image is used.

Math.min:
Chooses the smallest value. Here it makes sure the downscale factor does not exceed the max width or height.

downscale >= 0.999:
Means the image is already close enough to the allowed size, so the code can use feedImg directly without resizing.

source:
The image or canvas that will be sent into the detector. It can be feedImg or the off-screen canvas.

scaleX:
The horizontal scale factor used to convert boxes from downscaled canvas coordinates back to original image coordinates.

scaleY:
The vertical scale factor used to convert boxes from downscaled canvas coordinates back to original image coordinates.

ensureDetectSourceSurface:
Returns a reusable off-screen canvas and 2D context. Reusing it avoids creating a new canvas every frame.

surface:
The object returned by ensureDetectSourceSurface. It contains surface.canvas and surface.ctx.

surface.canvas:
The off-screen canvas used for resizing or preprocessing the camera frame.

surface.ctx:
The 2D drawing context of the off-screen canvas.

width:
The downscaled width used for the COCO inference source.

height:
The downscaled height used for the COCO inference source.

Math.round:
Rounds a number to the nearest whole number. Used because canvas width and height must be integer pixels.

Math.max(1, ...):
Makes sure width or height never becomes 0. A canvas cannot be useful with 0 pixels.

surface.ctx.clearRect:
Clears the previous frame from the off-screen canvas.

surface.ctx.drawImage:
Draws the camera frame into the off-screen canvas at the selected size.

rescalePredictionBBox:
Takes a prediction made on a downscaled image and scales its bounding box back to the original image size.

prediction:
One detection result from the model. It usually has class, score, and bbox.

prediction.bbox:
The bounding box of a detection. It is stored as [x, y, width, height].

Array.isArray:
Checks if prediction.bbox is really an array.

bbox.length < 4:
Means the bounding box does not have enough values. A valid bbox needs x, y, width, and height.

x:
The left coordinate of a bounding box.

y:
The top coordinate of a bounding box.

w:
The width of a bounding box.

h:
The height of a bounding box.

...prediction:
Spread syntax. It copies all existing fields from prediction into a new object.

bbox: [x * scaleX, y * scaleY, w * scaleX, h * scaleY]:
Creates a new bounding box expanded back to original image coordinates.

preprocessDroneDetectSource:
Prepares the camera frame for the AeroYOLO ONNX model. It resizes the image with letterboxing, reads pixels, converts them into Float32Array format, and returns the tensor input plus scale and padding metadata.

modelWidth:
The width expected by the ONNX model input, usually 640.

modelHeight:
The height expected by the ONNX model input, usually 640.

ONNX preprocessing:
The process of converting the camera image into the exact input format the ONNX model expects.

sourceWidth:
The original width of the live camera frame.

sourceHeight:
The original height of the live camera frame.

letterboxing:
Resizing an image while keeping its aspect ratio and adding padding to fill the required model size. It prevents stretching the image.

scale:
The resize factor used during letterboxing. It preserves the original image aspect ratio.

drawWidth:
The width of the camera image after it is resized inside the ONNX input canvas.

drawHeight:
The height of the camera image after it is resized inside the ONNX input canvas.

padX:
The horizontal padding added by letterboxing. It is used later to decode bounding boxes back to the original image.

padY:
The vertical padding added by letterboxing. It is used later to decode bounding boxes back to the original image.

Math.floor:
Rounds down to a whole number. Used for padding values.

surface.canvas.width !== modelWidth:
Checks whether the off-screen canvas needs to be resized to match the ONNX model input width.

surface.canvas.height !== modelHeight:
Checks whether the off-screen canvas needs to be resized to match the ONNX model input height.

surface.ctx.fillStyle:
Sets the fill color used by fillRect.

#727272:
Neutral gray color used for letterbox padding areas.

surface.ctx.fillRect:
Fills the full model input canvas with gray before drawing the resized camera image.

surface.ctx.getImageData:
Reads raw pixel data from the canvas.

imageData:
The raw RGBA pixel buffer from the canvas. Every pixel has four values: red, green, blue, alpha.

channelSize:
The number of pixels in one color channel. It equals modelWidth * modelHeight.

Float32Array:
A typed array that stores 32-bit floating-point numbers. ONNX Runtime uses this for model input.

input:
The final ONNX input buffer. It stores RGB values in CHW order and values are normalized to 0..1.

CHW:
Channel, Height, Width format. It means all red values first, then all green values, then all blue values.

RGBA:
Red, Green, Blue, Alpha pixel format used by canvas imageData.

0..1 range:
Pixel values are divided by 255 so the model receives decimals between 0 and 1 instead of 0 to 255.

for loop in preprocessDroneDetectSource:
Loops over every pixel in imageData. i moves by 4 because imageData is RGBA. pixel moves by 1 because input is arranged by pixel position.

pixel:
The current pixel number while copying values into the CHW input buffer.

i:
The current index inside the RGBA imageData array.

imageData[i] / 255:
Red channel value normalized from 0..255 into 0..1.

imageData[i + 1] / 255:
Green channel value normalized from 0..255 into 0..1.

imageData[i + 2] / 255:
Blue channel value normalized from 0..255 into 0..1.

input[pixel]:
Stores red channel data.

input[channelSize + pixel]:
Stores green channel data after the red channel plane.

input[channelSize * 2 + pixel]:
Stores blue channel data after the red and green channel planes.

return { input, scale, padX, padY }:
Returns the prepared ONNX input data and the metadata needed later to convert model boxes back to original image coordinates.

clampBboxToFeed:
Makes sure a bounding box stays inside the visible camera frame. It prevents negative coordinates or boxes going outside the image.

bbox:
A bounding box array in [x, y, width, height] format.

rawX:
The original decoded x coordinate before clamping.

rawY:
The original decoded y coordinate before clamping.

rawW:
The original decoded width before clamping.

rawH:
The original decoded height before clamping.

Math.max(0, ...):
Prevents negative coordinates or negative width/height.

Math.min(feedImg.naturalWidth, rawX):
Prevents the x coordinate from going beyond the image width.

Math.min(feedImg.naturalHeight, rawY):
Prevents the y coordinate from going beyond the image height.

feedImg.naturalWidth - x:
Maximum possible width remaining from x to the right edge of the image.

feedImg.naturalHeight - y:
Maximum possible height remaining from y to the bottom edge of the image.

return [x, y, w, h]:
Returns a safe bounding box inside the image bounds.

normalizeDroneModelPrediction:
Decodes one row from the ONNX model output into the shared prediction format used by the rest of the detector.

data:
The flat ONNX output buffer. It contains prediction rows one after another.

offset:
The starting index of the current prediction row inside data.

prepared:
The metadata returned by preprocessDroneDetectSource. It contains scale, padX, and padY.

prepared.scale:
The letterbox scale factor used during preprocessing. Needed to undo model-space scaling.

prepared.padX:
The horizontal padding added during letterboxing. Needed to remove padding from x coordinates.

prepared.padY:
The vertical padding added during letterboxing. Needed to remove padding from y coordinates.

Number.isFinite:
Checks if a value is a real finite number. It filters out NaN or Infinity.

x1:
The left coordinate from the ONNX output row.

y1:
The top coordinate from the ONNX output row.

x2:
The right coordinate from the ONNX output row.

y2:
The bottom coordinate from the ONNX output row.

scoreRaw:
The raw confidence score from the ONNX output row.

classIdRaw:
The raw class id from the ONNX output row.

score:
The safe confidence score. If scoreRaw is invalid, score becomes 0.

classId:
The safe rounded class id. If classIdRaw is invalid, classId becomes -1.

Math.round:
Rounds classIdRaw to the nearest integer because class ids must be whole numbers.

DRONE_MODEL_LABELS:
A map that converts numeric model class ids into readable labels like aircraft, drone, or helicopter.

className:
The readable class label. If the id is unknown, the code creates a label like class_5.

class_${classId}:
Fallback label for unknown model class ids. Useful for debugging.

width in normalizeDroneModelPrediction:
The decoded bounding box width after undoing the model scale.

height in normalizeDroneModelPrediction:
The decoded bounding box height after undoing the model scale.

(x1 - prepared.padX) / prepared.scale:
Converts the left coordinate from padded model coordinates back to original image coordinates.

(y1 - prepared.padY) / prepared.scale:
Converts the top coordinate from padded model coordinates back to original image coordinates.

clampBboxToFeed in normalizeDroneModelPrediction:
Makes the decoded box safe before returning it.

return { class, score, classId, bbox }:
Returns a prediction object in the same shared format as COCO-SSD predictions.

ensureDetectBackend:
Initializes TensorFlow.js backend for COCO-SSD. It waits for TensorFlow to be ready and tries to use WebGL for faster browser inference.

detectBackendReady:
Boolean flag that says TensorFlow backend setup already happened.

window.tf:
The TensorFlow.js global object. If it is missing, TensorFlow-based detection cannot be prepared.

tf.ready:
Waits until TensorFlow.js runtime is initialized.

tf.getBackend:
Returns the current TensorFlow backend name, such as cpu or webgl.

currentBackend:
The TensorFlow backend currently active before switching.

tf.findBackend('webgl'):
Checks if the WebGL backend is available.

tf.setBackend('webgl'):
Switches TensorFlow.js to WebGL backend for faster GPU/browser inference.

webgl:
TensorFlow backend that uses browser graphics/GPU acceleration.

logConsole(`TF backend...`):
Writes the active TensorFlow backend into the operator console.

ensureCocoDetectModel:
Loads and caches the COCO-SSD model. If already loaded, it returns the cached model.

detectModelReady:
Boolean flag saying the COCO model has already loaded.

detectModel:
The cached COCO-SSD model instance.

window.cocoSsd:
The global COCO-SSD library object. If it is missing, the COCO model cannot load.

setDetectStatus('Detect: model missing'):
Shows that the needed model library is missing.

setDetectStatus('Detect: loading'):
Shows that the model is loading.

cocoSsd.load:
Loads the COCO-SSD model bundle.

setDetectStatus('Detect: ready'):
Shows that detection model loading succeeded.

Detection model load failed:
Error message shown when COCO-SSD fails to load.

ensureDroneDetectSession:
Loads and caches the AeroYOLO ONNX Runtime inference session.

droneDetectSessionReady:
Boolean flag saying the ONNX session is already loaded and ready.

droneDetectSession:
The cached ONNX Runtime inference session.

window.ort:
The ONNX Runtime Web global object.

ort.InferenceSession:
ONNX Runtime class used to create a model inference session.

ort.Tensor:
ONNX Runtime class used to create input tensors.

ONNX Runtime Web:
Browser library that can run ONNX machine-learning models.

DRONE_MODEL_URL:
Path to the AeroYOLO ONNX model file.

ort.env.wasm.numThreads = 1:
Limits WASM execution to one thread to keep resource usage predictable.

executionProviders:
List of runtimes ONNX Runtime can try. This code tries webgpu and wasm first.

webgpu:
Modern browser GPU acceleration backend. Faster when supported.

wasm:
WebAssembly backend. Slower than GPU sometimes, but more widely supported.

graphOptimizationLevel: 'all':
Asks ONNX Runtime to optimize the model graph as much as possible.

primaryErr:
The error from the first attempt to create the ONNX session with WebGPU/WASM. The code catches it and retries with WASM only.

AeroYOLO WebGPU session failed:
Console warning meaning WebGPU failed, but the code will retry with WASM.

AeroYOLO model loaded:
Console message meaning the ONNX model session loaded successfully.

AeroYOLO model load failed:
Error message meaning the ONNX model could not be loaded.

detectWithCoco:
Runs one COCO-SSD detection pass. It loads the model if needed, gets the detection source, runs model.detect, and rescales boxes if the image was downscaled.

model:
The loaded COCO-SSD model instance.

detectionSource:
The prepared source for COCO inference. It contains source, scaleX, and scaleY.

model.detect:
COCO-SSD function that runs object detection on an image or canvas.

rawPredictions:
Predictions returned directly from COCO-SSD.

rawPredictions.map:
Creates a new predictions array after rescaling each bounding box.

detectWithAeroYolo:
Runs one AeroYOLO ONNX detection pass. It ensures the session exists, prepares the frame, builds the input tensor, runs the model, decodes output rows, and returns shared-format predictions.

session:
The ONNX inference session returned by ensureDroneDetectSession.

inputName:
The ONNX input tensor name. The code reads it from session.inputNames or falls back to images.

outputName:
The ONNX output tensor name. The code reads it from session.outputNames or falls back to output0.

session.inputNames:
Array of input names from the ONNX model.

session.outputNames:
Array of output names from the ONNX model.

inputMeta:
Optional metadata about the ONNX input.

session.inputMetadata:
Metadata object that can include input dimensions.

dims:
The input shape expected by the model. Usually [1, 3, 640, 640].

[1, 3, 640, 640]:
Common ONNX input shape: batch size 1, 3 color channels, height 640, width 640.

modelHeight:
The model input height read from dims[2], fallback 640.

modelWidth:
The model input width read from dims[3], fallback 640.

prepared:
The result of preprocessDroneDetectSource. It contains input, scale, padX, and padY.

new ort.Tensor:
Creates an ONNX tensor object from the prepared Float32Array.

'float32':
The tensor data type. The ONNX model expects 32-bit floating-point input.

[1, 3, modelHeight, modelWidth]:
The tensor shape: one image, three color channels, model height, model width.

tensor:
The final ONNX input tensor for the current frame.

session.run:
Runs ONNX model inference.

{ [inputName]: tensor }:
Object passed into session.run. The dynamic key [inputName] assigns the tensor to the model’s real input name.

result:
The object returned from session.run. It contains output tensors.

outputTensor:
The main prediction tensor selected from result using outputName.

outputTensor.data:
Flat array containing raw output prediction values.

outputTensor.dims:
Shape of the output tensor.

rows:
Number of prediction rows returned by the model.

stride:
Number of values in each prediction row. In this model it is usually 6: x1, y1, x2, y2, score, classId.

predictions:
Array that collects decoded shared-format predictions.

for loop in detectWithAeroYolo:
Loops through every output row from the ONNX model.

i:
Current prediction row index.

offset in detectWithAeroYolo:
Starting index of the current row inside the flat output buffer. Calculated as i * stride.

prediction in detectWithAeroYolo:
One decoded prediction returned by normalizeDroneModelPrediction.

predictions.push:
Adds a decoded prediction to the predictions array.

return predictions:
Returns all decoded AeroYOLO detections in shared format.

shared prediction format:
The common object shape used by the rest of the detector. It contains class, score, and bbox, no matter whether the backend was COCO or AeroYOLO.

exam summary:
This section prepares frames and runs model inference. getDetectionSource prepares a possibly downscaled source for COCO. rescalePredictionBBox converts COCO boxes back to real image size. preprocessDroneDetectSource prepares CHW float32 letterboxed input for AeroYOLO. normalizeDroneModelPrediction decodes ONNX rows into normal predictions. ensureDetectBackend and ensureCocoDetectModel prepare COCO/TensorFlow. ensureDroneDetectSession prepares AeroYOLO/ONNX Runtime. detectWithCoco and detectWithAeroYolo run one inference pass and return predictions.
*/