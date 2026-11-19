import { FilesetResolver, HandLandmarker } from './assets/vendor/mediapipe/vision_bundle.mjs';

const ui = {
  flowerFrame: document.querySelector('#flowerFrame'),
  flowerCanvas: document.querySelector('#flowerCanvas'),
  frameStatus: document.querySelector('#frameStatus'),
  frameFallback: document.querySelector('#frameFallback'),
  frameProgress: document.querySelector('#frameProgress'),
  frameProgressText: document.querySelector('#frameProgressText'),
  opennessPercent: document.querySelector('#opennessPercent'),
  stageName: document.querySelector('#stageName'),
  stageMeterFill: document.querySelector('#stageMeterFill'),
  sequencePosition: document.querySelector('#sequencePosition'),
  slider: document.querySelector('#opennessSlider'),
  controlModeText: document.querySelector('#controlModeText'),
  manualModeBtn: document.querySelector('#manualModeBtn'),
  gestureModeBtn: document.querySelector('#gestureModeBtn'),
  statusText: document.querySelector('#statusText'),
  cameraPreview: document.querySelector('.camera-preview'),
  cameraCanvas: document.querySelector('#cameraCanvas'),
  cameraPlaceholder: document.querySelector('#cameraPlaceholder'),
  cameraPlaceholderText: document.querySelector('#cameraPlaceholderText'),
  cameraLoading: document.querySelector('#cameraLoading'),
  cameraState: document.querySelector('#cameraState'),
  cameraButton: document.querySelector('#cameraButton'),
  cameraButtonText: document.querySelector('#cameraButtonText'),
  iconIdle: document.querySelector('.icon-idle'),
  iconLoading: document.querySelector('.icon-loading'),
  iconActive: document.querySelector('.icon-active'),
  cameraVideo: document.querySelector('#cameraVideo')
};

const DETECTION_INTERVAL_MS = 1000 / 22;
const PINCH_CLOSED = 0.16;
const PINCH_OPEN = 1.12;
const GESTURE_TAU_MS = 140;
const GESTURE_DEAD_ZONE = 0.008;
const RENDER_TAU_MS = 52;
const FRAME_LOAD_WORKERS = 6;
const WASM_PATH = new URL('./assets/vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_PATH = new URL('./assets/models/hand_landmarker.task', import.meta.url).href;
const FRAME_MANIFEST_URL = new URL('./assets/growth-frames/frames.json', import.meta.url);

const state = {
  frames: [],
  bitmaps: [],
  loadedCount: 0,
  failedCount: 0,
  mediaReady: false,
  mediaDuration: 0,
  value: 0,
  target: 0,
  mode: 'manual',
  lastRenderTime: performance.now(),
  lastPercent: -1,
  lastDrawnValue: -1,
  lastCanvasWidth: 0,
  lastCanvasHeight: 0,
  detector: null,
  detectorPromise: null,
  stream: null,
  cameraRunning: false,
  cameraStarting: false,
  detectionTimer: 0,
  lastCameraTime: -1,
  lastLandmarks: null,
  handWasPresent: false,
  gestureRaw: 0,
  gestureSmoothed: 0,
  lastGestureTime: 0
};

const flowerContext = ui.flowerCanvas.getContext('2d');
const cameraContext = ui.cameraCanvas.getContext('2d', { alpha: false });

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(a, b, width, height) {
  return Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
}

function stageFor(value) {
  if (value < 0.18) return '花苞';
  if (value < 0.46) return '初绽';
  if (value < 0.78) return '半开';
  return '盛放';
}

function setStatus(message, options = {}) {
  const isError = Boolean(options.error);
  if (ui.statusText.textContent === message && ui.statusText.classList.contains('is-error') === isError) {
    return;
  }
  ui.statusText.textContent = message;
  ui.statusText.classList.toggle('is-error', isError);
}

function setCameraButton(mode) {
  const isLoading = mode === 'loading';
  const isActive = mode === 'active';
  ui.cameraButton.disabled = isLoading;
  ui.cameraButton.classList.toggle('is-active', isActive);
  ui.cameraButton.setAttribute('aria-pressed', String(isActive));
  ui.iconIdle.hidden = isLoading || isActive;
  ui.iconLoading.hidden = !isLoading;
  ui.iconActive.hidden = !isActive;
  ui.cameraButtonText.textContent = isLoading ? '正在开启' : isActive ? '关闭摄像头' : '开启摄像头';
}

function setMode(mode, options = {}) {
  if (mode === 'gesture' && !state.cameraRunning) return;
  state.mode = mode;
  const isManual = mode === 'manual';

  ui.manualModeBtn.classList.toggle('is-active', isManual);
  ui.gestureModeBtn.classList.toggle('is-active', !isManual);
  ui.manualModeBtn.setAttribute('aria-pressed', String(isManual));
  ui.gestureModeBtn.setAttribute('aria-pressed', String(!isManual));
  ui.controlModeText.textContent = isManual ? '手动' : '手势';

  if (isManual) state.target = Number(ui.slider.value) / 100;
  if (!options.quiet) setStatus(isManual ? '手动控制就绪' : '等待手部进入画面');
}

function updateFrameProgress() {
  const total = state.frames.length || 30;
  const done = state.loadedCount + state.failedCount;
  ui.frameProgress.max = total;
  ui.frameProgress.value = done;

  if (!state.frames.length) {
    ui.frameProgressText.textContent = '影像准备中';
  } else if (done < total) {
    ui.frameProgressText.textContent = `影像 ${done} / ${total}`;
  } else if (state.failedCount) {
    ui.frameProgressText.textContent = `影像 ${state.loadedCount} / ${total}`;
  } else {
    ui.frameProgressText.textContent = '影像就绪';
  }
}

function showFrameError() {
  state.mediaReady = false;
  ui.frameStatus.hidden = true;
  ui.frameFallback.hidden = false;
  ui.flowerFrame.dataset.ready = 'false';
  ui.frameProgress.value = 0;
  ui.frameProgressText.textContent = '影像载入失败';
}

async function fetchFrame(frame) {
  const response = await fetch(frame.src, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Frame ${frame.id} returned ${response.status}`);

  const blob = await response.blob();
  try {
    return await createImageBitmap(blob);
  } catch {
    const image = new Image();
    image.src = URL.createObjectURL(blob);
    await image.decode();
    return image;
  }
}

async function loadFrame(index) {
  state.bitmaps[index] = await fetchFrame(state.frames[index]);
  state.loadedCount += 1;
  updateFrameProgress();
}

async function loadAllFrames() {
  let cursor = 0;
  const worker = async () => {
    while (cursor < state.frames.length) {
      const index = cursor;
      cursor += 1;
      try {
        await loadFrame(index);
      } catch {
        state.failedCount += 1;
        updateFrameProgress();
      }
    }
  };

  await Promise.all(Array.from({ length: FRAME_LOAD_WORKERS }, worker));
}

async function loadGrowthFrames() {
  try {
    const response = await fetch(FRAME_MANIFEST_URL);
    if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
    const manifest = await response.json();
    if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
      throw new Error('Manifest contains no frames');
    }

    state.frames = manifest.frames.map((file, index) => ({
      id: index,
      src: new URL(`./assets/growth-frames/${file}`, import.meta.url).href
    }));
    state.bitmaps = Array(state.frames.length);
    state.mediaDuration = Number(manifest.duration) || 0;
    updateFrameProgress();
    await loadAllFrames();

    if (state.loadedCount === 0) throw new Error('No frames could be loaded');

    state.mediaReady = true;
    ui.frameStatus.hidden = true;
    ui.frameFallback.hidden = true;
    ui.flowerFrame.dataset.ready = 'true';
    state.lastPercent = -1;
    state.lastDrawnValue = -1;
    drawFlower(state.value);
    updateReadout(state.value);
  } catch {
    showFrameError();
  }
}

function resizeCanvas(canvas, context, cssWidth, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: cssWidth, height: cssHeight };
}

function nearestLoadedIndex(index) {
  for (let offset = 0; offset < state.bitmaps.length; offset += 1) {
    const before = index - offset;
    if (before >= 0 && state.bitmaps[before]) return before;
    const after = index + offset;
    if (after < state.bitmaps.length && state.bitmaps[after]) return after;
  }
  return -1;
}

function drawCoveredBitmap(bitmap, width, height, alpha) {
  if (alpha <= 0.001) return;
  const scale = Math.max(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  flowerContext.globalAlpha = alpha;
  flowerContext.drawImage(
    bitmap,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

function drawFlower(value) {
  const width = ui.flowerCanvas.clientWidth;
  const height = ui.flowerCanvas.clientHeight;
  if (!width || !height || state.loadedCount === 0) return;

  const size = resizeCanvas(ui.flowerCanvas, flowerContext, width, height);
  flowerContext.clearRect(0, 0, size.width, size.height);
  flowerContext.imageSmoothingEnabled = true;
  flowerContext.imageSmoothingQuality = 'high';

  const total = state.frames.length;
  const position = clamp(value) * (total - 1);
  const baseIndex = Math.min(total - 1, Math.floor(position));
  const nextIndex = Math.min(total - 1, baseIndex + 1);
  const fraction = baseIndex === nextIndex ? 0 : position - baseIndex;
  const frameA = nearestLoadedIndex(baseIndex);
  const frameB = nearestLoadedIndex(nextIndex);
  if (frameA < 0 || frameB < 0) return;

  drawCoveredBitmap(state.bitmaps[frameA], size.width, size.height, 1);
  if (frameA !== frameB) {
    drawCoveredBitmap(state.bitmaps[frameB], size.width, size.height, fraction);
  }
  flowerContext.globalAlpha = 1;

  state.lastDrawnValue = value;
  state.lastCanvasWidth = width;
  state.lastCanvasHeight = height;
  ui.flowerFrame.dataset.frameA = String(frameA);
  ui.flowerFrame.dataset.frameB = String(frameB);
  ui.flowerFrame.dataset.blend = fraction.toFixed(3);
  ui.flowerFrame.dataset.position = clamp(value).toFixed(3);
}

function updateReadout(value) {
  const percent = Math.round(value * 100);
  if (percent === state.lastPercent) return;

  state.lastPercent = percent;
  const stage = stageFor(value);
  const duration = state.mediaDuration || 0;
  const elapsed = duration ? clamp(value) * duration : 0;

  ui.opennessPercent.textContent = String(percent);
  ui.stageName.textContent = stage;
  ui.stageMeterFill.style.width = `${clamp(value) * 100}%`;
  ui.sequencePosition.textContent = duration
    ? `${elapsed.toFixed(1)} / ${duration.toFixed(1)} 秒`
    : '影像载入中';
  ui.flowerCanvas.setAttribute('aria-label', `花朵开放度 ${percent}%，${stage}`);
  ui.slider.setAttribute('aria-valuetext', `开放度 ${percent}%，${stage}`);

  if (state.mode === 'gesture') ui.slider.value = (clamp(value) * 100).toFixed(1);
  document.documentElement.style.setProperty('--range-progress', `${clamp(value) * 100}%`);
}

function renderFlower(timestamp) {
  const delta = Math.min(64, Math.max(0, timestamp - state.lastRenderTime));
  state.lastRenderTime = timestamp;
  const smoothing = 1 - Math.exp(-delta / RENDER_TAU_MS);
  const difference = state.target - state.value;
  state.value = Math.abs(difference) < 0.0004 ? state.target : state.value + difference * smoothing;

  const width = ui.flowerCanvas.clientWidth;
  const height = ui.flowerCanvas.clientHeight;
  const sizeChanged = width !== state.lastCanvasWidth || height !== state.lastCanvasHeight;
  if (state.mediaReady && (Math.abs(state.value - state.lastDrawnValue) > 0.0004 || sizeChanged)) {
    drawFlower(state.value);
  }
  updateReadout(state.value);
  requestAnimationFrame(renderFlower);
}

function pinchedOpenness(landmarks) {
  const width = ui.cameraVideo.videoWidth || 1280;
  const height = ui.cameraVideo.videoHeight || 720;
  const pinch = distance(landmarks[4], landmarks[8], width, height);
  const palm = distance(landmarks[5], landmarks[17], width, height);
  if (palm < 1) return 0;
  return clamp((pinch / palm - PINCH_CLOSED) / (PINCH_OPEN - PINCH_CLOSED));
}

function updateGesture(landmarks, timestamp) {
  if (!state.handWasPresent) {
    state.handWasPresent = true;
    state.gestureRaw = state.value;
    state.gestureSmoothed = state.value;
    state.lastGestureTime = timestamp;
  }

  let raw = pinchedOpenness(landmarks);
  if (Math.abs(raw - state.gestureRaw) < GESTURE_DEAD_ZONE) raw = state.gestureRaw;
  state.gestureRaw = raw;

  const delta = clamp(timestamp - state.lastGestureTime, 1, 100);
  const smoothing = 1 - Math.exp(-delta / GESTURE_TAU_MS);
  state.gestureSmoothed += (raw - state.gestureSmoothed) * smoothing;
  state.lastGestureTime = timestamp;

  if (state.mode === 'gesture') state.target = state.gestureSmoothed;
}

function drawCameraPreview(landmarks) {
  const width = ui.cameraCanvas.width;
  const height = ui.cameraCanvas.height;
  cameraContext.setTransform(1, 0, 0, 1, 0, 0);
  cameraContext.fillStyle = '#050705';
  cameraContext.fillRect(0, 0, width, height);

  const videoWidth = ui.cameraVideo.videoWidth;
  const videoHeight = ui.cameraVideo.videoHeight;
  if (!videoWidth || !videoHeight) return;

  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  cameraContext.save();
  cameraContext.translate(width, 0);
  cameraContext.scale(-1, 1);
  cameraContext.drawImage(ui.cameraVideo, offsetX, offsetY, drawWidth, drawHeight);
  cameraContext.restore();

  if (!landmarks) return;

  const points = landmarks.map((landmark) => ({
    x: offsetX + (1 - landmark.x) * drawWidth,
    y: offsetY + landmark.y * drawHeight
  }));

  cameraContext.lineWidth = 1.35;
  cameraContext.strokeStyle = 'rgba(205, 222, 157, 0.62)';
  cameraContext.beginPath();
  for (const connection of HandLandmarker.HAND_CONNECTIONS) {
    const start = points[connection.start];
    const end = points[connection.end];
    if (!start || !end) continue;
    cameraContext.moveTo(start.x, start.y);
    cameraContext.lineTo(end.x, end.y);
  }
  cameraContext.stroke();

  cameraContext.fillStyle = 'rgba(244, 239, 223, 0.88)';
  for (const [index, current] of points.entries()) {
    cameraContext.beginPath();
    cameraContext.arc(current.x, current.y, index === 4 || index === 8 ? 2.8 : 2, 0, Math.PI * 2);
    cameraContext.fill();
  }
}

function releaseCamera() {
  state.cameraRunning = false;
  state.lastCameraTime = -1;
  state.lastLandmarks = null;
  state.handWasPresent = false;
  window.clearTimeout(state.detectionTimer);
  state.detectionTimer = 0;

  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  ui.cameraVideo.pause();
  ui.cameraVideo.srcObject = null;
}

function resetCameraPreview(message = '摄像头未开启') {
  ui.cameraPreview.classList.remove('is-live');
  ui.cameraPlaceholder.hidden = false;
  ui.cameraPlaceholderText.textContent = message;
  ui.cameraLoading.hidden = true;
  ui.cameraState.textContent = '待机';
  cameraContext.setTransform(1, 0, 0, 1, 0, 0);
  cameraContext.clearRect(0, 0, ui.cameraCanvas.width, ui.cameraCanvas.height);
}

function stopCamera(message = '摄像头已关闭，手动控制继续可用') {
  releaseCamera();
  state.cameraStarting = false;
  resetCameraPreview();
  ui.gestureModeBtn.disabled = true;
  setCameraButton('idle');
  setMode('manual', { quiet: true });
  setStatus(message);
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) {
    return '当前页面不是安全上下文，请通过 HTTPS 或 localhost 打开。';
  }
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝，请使用滑块继续体验。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未找到可用摄像头，请使用滑块继续体验。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头可能被其他软件占用，请关闭占用程序后重试。';
    case 'OverconstrainedError':
      return '摄像头不支持当前画面参数，请更换设备或使用滑块。';
    default:
      return '摄像头无法开启，请检查设备后重试，或使用滑块继续。';
  }
}

function failCamera(message, placeholder = '摄像头不可用') {
  releaseCamera();
  state.cameraStarting = false;
  resetCameraPreview(placeholder);
  ui.cameraState.textContent = '不可用';
  ui.gestureModeBtn.disabled = true;
  setCameraButton('idle');
  setMode('manual', { quiet: true });
  setStatus(message, { error: true });
}

async function createDetector() {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55
  });

  try {
    return await HandLandmarker.createFromOptions(vision, options('GPU'));
  } catch {
    return HandLandmarker.createFromOptions(vision, options('CPU'));
  }
}

function ensureDetector() {
  if (state.detector) return Promise.resolve(state.detector);
  if (!state.detectorPromise) {
    state.detectorPromise = createDetector()
      .then((detector) => {
        state.detector = detector;
        return detector;
      })
      .finally(() => {
        state.detectorPromise = null;
      });
  }
  return state.detectorPromise;
}

function processHands(result, timestamp) {
  if (!result.landmarks?.length) {
    state.lastLandmarks = null;
    state.handWasPresent = false;
    ui.cameraState.textContent = '寻找手部';
    if (state.mode === 'gesture') setStatus('未检测到手，花朵保持原位');
    return;
  }

  let bestIndex = 0;
  let bestConfidence = -1;
  for (let index = 0; index < result.landmarks.length; index += 1) {
    const confidence = result.handedness?.[index]?.[0]?.score ?? 0;
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestIndex = index;
    }
  }

  state.lastLandmarks = result.landmarks[bestIndex];
  updateGesture(state.lastLandmarks, timestamp);
  ui.cameraState.textContent = '已识别';
  setStatus(state.mode === 'gesture' ? '手势控制中' : '手动控制中');
}

function runDetection() {
  if (!state.cameraRunning || !state.detector) return;

  try {
    if (ui.cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      drawCameraPreview(state.lastLandmarks);
      if (ui.cameraVideo.currentTime !== state.lastCameraTime) {
        state.lastCameraTime = ui.cameraVideo.currentTime;
        const timestamp = performance.now();
        const result = state.detector.detectForVideo(ui.cameraVideo, timestamp);
        processHands(result, timestamp);
      }
    }
  } catch {
    failCamera('手势识别出现异常，请重试或使用滑块。', '识别异常');
    return;
  }

  state.detectionTimer = window.setTimeout(runDetection, DETECTION_INTERVAL_MS);
}

async function startCamera() {
  if (state.cameraStarting) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    failCamera(
      window.isSecureContext
        ? '浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。'
        : '当前页面不是安全上下文，请通过 HTTPS 或 localhost 打开。'
    );
    return;
  }

  state.cameraStarting = true;
  setCameraButton('loading');
  setStatus('正在请求摄像头权限');
  ui.cameraState.textContent = '连接中';
  ui.cameraPlaceholder.hidden = false;
  ui.cameraPlaceholderText.textContent = '等待摄像头权限';

  let modelFailed = false;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 }
      }
    });

    ui.cameraVideo.srcObject = state.stream;
    await ui.cameraVideo.play();
    ui.cameraPreview.classList.add('is-live');
    ui.cameraPlaceholder.hidden = true;
    ui.cameraLoading.hidden = false;
    ui.cameraState.textContent = '载入中';
    setStatus('正在载入手势识别模型');

    try {
      await ensureDetector();
    } catch (error) {
      modelFailed = true;
      throw error;
    }

    state.cameraRunning = true;
    state.lastCameraTime = -1;
    ui.cameraLoading.hidden = true;
    ui.cameraState.textContent = '寻找手部';
    ui.gestureModeBtn.disabled = false;
    setCameraButton('active');
    setMode('gesture', { quiet: true });
    setStatus('等待手部进入画面');
    runDetection();
  } catch (error) {
    if (modelFailed) {
      failCamera('手势模型加载失败，请使用滑块继续体验。', '模型载入失败');
    } else {
      failCamera(cameraErrorMessage(error), '摄像头未开启');
    }
  } finally {
    state.cameraStarting = false;
  }
}

async function toggleCamera() {
  if (state.cameraStarting) return;
  if (state.cameraRunning) {
    stopCamera();
  } else {
    await startCamera();
  }
}

function bindControls() {
  ui.slider.addEventListener('input', () => {
    setMode('manual', { quiet: true });
    state.target = Number(ui.slider.value) / 100;
    setStatus('手动控制就绪');
  });

  ui.manualModeBtn.addEventListener('click', () => setMode('manual'));
  ui.gestureModeBtn.addEventListener('click', () => setMode('gesture'));
  ui.cameraButton.addEventListener('click', toggleCamera);
  window.addEventListener('pagehide', releaseCamera);
}

function initialize() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.6 } });
  }
  bindControls();
  updateFrameProgress();
  updateReadout(0);
  requestAnimationFrame(renderFlower);
  loadGrowthFrames();
}

initialize();

window.__flowerExperience = {
  getState: () => ({
    mode: state.mode,
    openness: state.value,
    target: state.target,
    mediaReady: state.mediaReady,
    mediaDuration: state.mediaDuration,
    loadedFrames: state.loadedCount,
    failedFrames: state.failedCount,
    cameraRunning: state.cameraRunning,
    handPresent: state.handWasPresent
  })
};
