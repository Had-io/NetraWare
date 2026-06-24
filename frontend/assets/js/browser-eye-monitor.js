import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380];

const DEFAULT_CONFIG = Object.freeze({
  calibrationDurationSeconds: 8,
  calibrationMinSamples: 30,
  earThresholdRatio: 0.68,
  eyeOpenThresholdRatio: 0.75,
  minBlinkDurationSeconds: 0.06,
  maxBlinkDurationSeconds: 0.80,
  minClosedFramesForBlink: 2,
  minSecondsBetweenBlinks: 0.12,
  perclosWindowSeconds: 60,
  perclosWarmupSeconds: 10,
  perclosMinClosedSeconds: 0.15,
  blinkWindowSeconds: 60,
  blinkRateWarmupSeconds: 15,
  reminderIntervalMinutes: 20,
  alertCooldownSeconds: 5,
  alertGracePeriodSeconds: 12,
  longEyeClosureSeconds: 2,
  frameGapResetSeconds: 2.5,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percent / 100;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function removeOutliersIqr(values) {
  if (values.length < 4) return [...values];
  const q1 = percentile(values, 25);
  const q3 = percentile(values, 75);
  const iqr = q3 - q1;
  if (iqr <= 0) return [...values];
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return values.filter((value) => value >= lower && value <= upper);
}

function euclideanDistance(pointA, pointB) {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

function calculateEar(points) {
  if (!Array.isArray(points) || points.length !== 6) return 0;
  const [p1, p2, p3, p4, p5, p6] = points;
  const vertical1 = euclideanDistance(p2, p6);
  const vertical2 = euclideanDistance(p3, p5);
  const horizontal = euclideanDistance(p1, p4);
  if (horizontal <= 0) return 0;
  return (vertical1 + vertical2) / (2 * horizontal);
}

class LocalCalibration {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.samples = [];
  }

  add(ear, nowSeconds) {
    if (this.startedAt === null) this.startedAt = nowSeconds;
    if (Number.isFinite(ear) && ear > 0) this.samples.push(ear);
  }

  elapsed(nowSeconds) {
    return this.startedAt === null ? 0 : Math.max(0, nowSeconds - this.startedAt);
  }

  progress(nowSeconds) {
    const timeProgress = this.elapsed(nowSeconds) / this.config.calibrationDurationSeconds;
    const sampleProgress = this.samples.length / this.config.calibrationMinSamples;
    return clamp(Math.min(timeProgress, sampleProgress), 0, 1);
  }

  isComplete(nowSeconds) {
    return this.elapsed(nowSeconds) >= this.config.calibrationDurationSeconds
      && this.samples.length >= this.config.calibrationMinSamples;
  }

  result(nowSeconds) {
    if (!this.isComplete(nowSeconds)) return null;
    const cleanSamples = removeOutliersIqr(this.samples);
    const cutoff = cleanSamples.length >= 5 ? percentile(cleanSamples, 40) : 0;
    const openSamples = cleanSamples.length >= 5
      ? cleanSamples.filter((value) => value >= cutoff)
      : cleanSamples;
    const baseline = openSamples.length
      ? openSamples.reduce((total, value) => total + value, 0) / openSamples.length
      : 0;
    if (!Number.isFinite(baseline) || baseline <= 0) return null;
    return {
      baselineEar: baseline,
      earThreshold: baseline * this.config.earThresholdRatio,
    };
  }
}

class LocalFatigueEngine {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.baselineEar = null;
    this.earThreshold = null;
    this.eyeOpenThreshold = null;
    this.sessionStartedAt = null;
    this.lastRestAt = null;
    this.lastAlertAt = null;
    this.evidenceStartedAt = null;
    this.pausedAt = null;
    this.totalBlinkCount = 0;
    this.lastBlinkAt = null;
    this.blinkTimestamps = [];
    this.eyeStateWindow = [];
    this.wasEyeClosed = false;
    this.closedStartedAt = null;
    this.closedFrameCount = 0;
    this.currentEyeClosedSeconds = 0;
  }

  timeOnlyUpdate(nowSeconds) {
    this.ensureStarted(nowSeconds);
    this.resetClosure();
    const lastSample = this.eyeStateWindow.length
      ? this.eyeStateWindow[this.eyeStateWindow.length - 1][0]
      : null;
    if (lastSample === null || nowSeconds - lastSample >= 0.5) {
      this.eyeStateWindow.push([nowSeconds, 0]);
    }
    this.prune(nowSeconds);
    const ear = this.baselineEar || 0;
    return this.buildResult({
      ear,
      isEyeClosed: false,
      blinkEvent: false,
      nowSeconds,
    });
  }

  setBaseline(baselineEar) {
    this.baselineEar = baselineEar;
    this.earThreshold = baselineEar * this.config.earThresholdRatio;
    this.eyeOpenThreshold = baselineEar * this.config.eyeOpenThresholdRatio;
  }

  start(nowSeconds) {
    this.sessionStartedAt = nowSeconds;
    this.lastRestAt = nowSeconds;
    this.lastAlertAt = null;
    this.evidenceStartedAt = nowSeconds;
    this.pausedAt = null;
    this.totalBlinkCount = 0;
    this.lastBlinkAt = null;
    this.blinkTimestamps = [];
    this.eyeStateWindow = [];
    this.resetClosure();
  }

  pause(nowSeconds) {
    if (this.sessionStartedAt === null || this.pausedAt !== null) return;
    this.pausedAt = nowSeconds;
    this.resetClosure();
  }

  resume(nowSeconds) {
    if (this.pausedAt === null) return;
    const pauseDuration = Math.max(0, nowSeconds - this.pausedAt);
    if (this.sessionStartedAt !== null) this.sessionStartedAt += pauseDuration;
    if (this.lastRestAt !== null) this.lastRestAt += pauseDuration;
    if (this.lastAlertAt !== null) this.lastAlertAt += pauseDuration;
    if (this.evidenceStartedAt !== null) this.evidenceStartedAt += pauseDuration;
    this.pausedAt = null;
    this.resetClosure();
  }

  markRest(nowSeconds) {
    this.resume(nowSeconds);
    this.lastRestAt = nowSeconds;
    this.lastAlertAt = null;
    this.evidenceStartedAt = nowSeconds;
    this.blinkTimestamps = [];
    this.eyeStateWindow = [];
    this.lastBlinkAt = null;
    this.resetClosure();
  }

  resetClosure() {
    this.wasEyeClosed = false;
    this.closedStartedAt = null;
    this.closedFrameCount = 0;
    this.currentEyeClosedSeconds = 0;
  }

  ensureStarted(nowSeconds) {
    if (this.sessionStartedAt === null) this.sessionStartedAt = nowSeconds;
    if (this.lastRestAt === null) this.lastRestAt = nowSeconds;
    if (this.evidenceStartedAt === null) this.evidenceStartedAt = nowSeconds;
    this.resume(nowSeconds);
  }

  update(ear, nowSeconds) {
    this.ensureStarted(nowSeconds);
    if (!Number.isFinite(ear) || ear <= 0) return this.updateMissing(nowSeconds);

    let isEyeClosed;
    if (this.wasEyeClosed) isEyeClosed = ear < this.eyeOpenThreshold;
    else isEyeClosed = ear <= this.earThreshold;

    let blinkEvent = false;
    if (isEyeClosed) {
      if (!this.wasEyeClosed) {
        this.wasEyeClosed = true;
        this.closedStartedAt = nowSeconds;
        this.closedFrameCount = 1;
        this.currentEyeClosedSeconds = 0;
      } else {
        this.closedFrameCount += 1;
        this.currentEyeClosedSeconds = Math.max(0, nowSeconds - this.closedStartedAt);
      }
    } else {
      if (this.wasEyeClosed && this.closedStartedAt !== null) {
        const closureDuration = Math.max(0, nowSeconds - this.closedStartedAt);
        blinkEvent = this.registerBlink(nowSeconds, closureDuration);
      }
      this.resetClosure();
    }

    const sustainedClosed = isEyeClosed
      && this.currentEyeClosedSeconds >= this.config.perclosMinClosedSeconds;
    this.eyeStateWindow.push([nowSeconds, sustainedClosed ? 1 : 0]);
    this.prune(nowSeconds);

    return this.buildResult({ ear, isEyeClosed, blinkEvent, nowSeconds });
  }

  updateMissing(nowSeconds) {
    this.ensureStarted(nowSeconds);
    this.resetClosure();
    this.prune(nowSeconds);
    const result = this.buildResult({
      ear: 0,
      isEyeClosed: false,
      blinkEvent: false,
      nowSeconds,
    });
    return {
      ...result,
      eye_state: "TIDAK_TERDETEKSI",
      status: "TIDAK_TERDETEKSI",
      message: "Wajah atau mata tidak terdeteksi dengan jelas.",
      fatigue_score: 0,
      should_alert: false,
    };
  }

  registerBlink(nowSeconds, closureDuration) {
    if (this.closedFrameCount < this.config.minClosedFramesForBlink) return false;
    if (closureDuration < this.config.minBlinkDurationSeconds) return false;
    if (closureDuration > this.config.maxBlinkDurationSeconds) return false;
    if (this.lastBlinkAt !== null
      && nowSeconds - this.lastBlinkAt < this.config.minSecondsBetweenBlinks) return false;
    this.totalBlinkCount += 1;
    this.lastBlinkAt = nowSeconds;
    this.blinkTimestamps.push(nowSeconds);
    return true;
  }

  prune(nowSeconds) {
    const perclosLimit = nowSeconds - this.config.perclosWindowSeconds;
    while (this.eyeStateWindow.length > 1 && this.eyeStateWindow[1][0] < perclosLimit) {
      this.eyeStateWindow.shift();
    }
    const blinkLimit = nowSeconds - this.config.blinkWindowSeconds;
    while (this.blinkTimestamps.length && this.blinkTimestamps[0] < blinkLimit) {
      this.blinkTimestamps.shift();
    }
  }

  evidenceDuration(nowSeconds) {
    return this.evidenceStartedAt === null ? 0 : Math.max(0, nowSeconds - this.evidenceStartedAt);
  }

  screenDuration(nowSeconds) {
    return this.sessionStartedAt === null ? 0 : Math.max(0, nowSeconds - this.sessionStartedAt);
  }

  durationSinceRest(nowSeconds) {
    return this.lastRestAt === null ? 0 : Math.max(0, nowSeconds - this.lastRestAt);
  }

  calculateBlinkRate(nowSeconds) {
    if (!this.blinkTimestamps.length) return 0;
    const observationStart = Math.max(
      this.evidenceStartedAt ?? nowSeconds,
      nowSeconds - this.config.blinkWindowSeconds,
    );
    const observationSeconds = Math.max(nowSeconds - observationStart, 1e-6);
    return Number(((this.blinkTimestamps.length / observationSeconds) * 60).toFixed(3));
  }

  calculatePerclos(nowSeconds) {
    if (this.eyeStateWindow.length < 2) return 0;
    const windowStart = Math.max(
      this.evidenceStartedAt ?? nowSeconds,
      nowSeconds - this.config.perclosWindowSeconds,
    );
    let closedSeconds = 0;
    let observedSeconds = 0;
    this.eyeStateWindow.forEach(([sampleTime, state], index) => {
      const nextTime = index + 1 < this.eyeStateWindow.length
        ? this.eyeStateWindow[index + 1][0]
        : nowSeconds;
      const intervalStart = Math.max(sampleTime, windowStart);
      const intervalEnd = Math.min(nextTime, nowSeconds);
      const interval = Math.max(0, intervalEnd - intervalStart);
      observedSeconds += interval;
      if (state === 1) closedSeconds += interval;
    });
    return observedSeconds > 0
      ? Number(clamp(closedSeconds / observedSeconds, 0, 1).toFixed(4))
      : 0;
  }

  calculateScore({ blinkRate, blinkRateReady, perclos, perclosReady, durationSinceRest }) {
    let score = 0;
    if (perclosReady) score += clamp(perclos / 0.40, 0, 1) * 45;
    score += clamp(
      this.currentEyeClosedSeconds / Math.max(this.config.longEyeClosureSeconds, 0.1),
      0,
      1,
    ) * 25;
    const minutesSinceRest = durationSinceRest / 60;
    const durationStart = this.config.reminderIntervalMinutes * 0.5;
    const durationSpan = Math.max(this.config.reminderIntervalMinutes - durationStart, 0.1);
    score += clamp((minutesSinceRest - durationStart) / durationSpan, 0, 1) * 20;
    if (blinkRateReady) {
      if (blinkRate < 8) score += clamp((8 - blinkRate) / 8, 0, 1) * 10;
      else if (blinkRate > 30) score += clamp((blinkRate - 30) / 20, 0, 1) * 10;
    }
    return Number(clamp(score, 0, 100).toFixed(2));
  }

  determineStatus({ fatigueScore, screenDuration, durationSinceRest, perclosReady }) {
    if (screenDuration < this.config.alertGracePeriodSeconds) {
      return ["NORMAL", "Mengumpulkan data awal monitoring."];
    }
    if (this.currentEyeClosedSeconds >= this.config.longEyeClosureSeconds) {
      return ["PERLU_ISTIRAHAT", "Mata terdeteksi tertutup cukup lama. Segera istirahat sejenak."];
    }
    if (durationSinceRest / 60 >= this.config.reminderIntervalMinutes) {
      return ["PERLU_ISTIRAHAT", "Waktu penggunaan layar sudah mencapai batas. Istirahat dan terapkan aturan 20-20-20."];
    }
    if (fatigueScore >= 70) {
      return ["PERLU_ISTIRAHAT", "Indikasi kelelahan mata cukup tinggi. Disarankan beristirahat."];
    }
    if (fatigueScore >= 40) {
      return ["WASPADA", "Terdapat tanda awal kelelahan mata. Alihkan pandangan dari layar sesaat."];
    }
    if (!perclosReady) return ["NORMAL", "Monitoring aktif; data PERCLOS sedang dikumpulkan."];
    return ["NORMAL", "Kondisi mata terpantau normal."];
  }

  buildResult({ ear, isEyeClosed, blinkEvent, nowSeconds }) {
    const screenDuration = this.screenDuration(nowSeconds);
    const durationSinceRest = this.durationSinceRest(nowSeconds);
    const evidenceDuration = this.evidenceDuration(nowSeconds);
    const perclosReady = evidenceDuration >= this.config.perclosWarmupSeconds
      && this.eyeStateWindow.length >= 2;
    const blinkRateReady = evidenceDuration >= this.config.blinkRateWarmupSeconds;
    const perclos = perclosReady ? this.calculatePerclos(nowSeconds) : 0;
    const blinkRate = blinkRateReady ? this.calculateBlinkRate(nowSeconds) : 0;
    const fatigueScore = this.calculateScore({
      blinkRate,
      blinkRateReady,
      perclos,
      perclosReady,
      durationSinceRest,
    });
    const [status, message] = this.determineStatus({
      fatigueScore,
      screenDuration,
      durationSinceRest,
      perclosReady,
    });
    let shouldAlert = false;
    if (status === "PERLU_ISTIRAHAT"
      && screenDuration >= this.config.alertGracePeriodSeconds
      && (this.lastAlertAt === null
        || nowSeconds - this.lastAlertAt >= this.config.alertCooldownSeconds)) {
      this.lastAlertAt = nowSeconds;
      shouldAlert = true;
    }

    return {
      ear_threshold: this.earThreshold ?? 0,
      is_eye_closed: isEyeClosed,
      eye_state: isEyeClosed ? "TERTUTUP" : "TERBUKA",
      blink_event: blinkEvent,
      blink_count_total: this.totalBlinkCount,
      blink_rate_per_minute: blinkRate,
      blink_rate_ready: blinkRateReady,
      perclos,
      perclos_ready: perclosReady,
      screen_duration_seconds: screenDuration,
      duration_since_last_rest_seconds: durationSinceRest,
      current_eye_closed_seconds: this.currentEyeClosedSeconds,
      fatigue_score: fatigueScore,
      status,
      message,
      should_alert: shouldAlert,
    };
  }
}

export class BrowserEyeMonitor {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.modelPath = options.modelPath || "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
    this.faceLandmarker = null;
    this.calibration = new LocalCalibration(this.config);
    this.engine = new LocalFatigueEngine(this.config);
    this.isCalibrated = false;
    this.lastVideoTime = -1;
    this.lastMediaPipeTimestampMs = -1;
    this.lastProcessedFrameAtMs = -1;
    this.lastResult = null;
    this.lastDetectionPayload = null;
  }

  async initialize() {
    if (this.faceLandmarker) return;
    const wasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
    const vision = await FilesetResolver.forVisionTasks(wasmRoot);
    const options = {
      baseOptions: {
        modelAssetPath: this.modelPath,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.45,
      minFacePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    };
    try {
      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
    } catch {
      options.baseOptions.delegate = "CPU";
      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
    }
  }

  reset() {
    this.calibration.reset();
    this.engine.reset();
    this.isCalibrated = false;
    this.lastVideoTime = -1;
    this.lastMediaPipeTimestampMs = -1;
    this.lastProcessedFrameAtMs = -1;
    this.lastResult = null;
    this.lastDetectionPayload = null;
  }

  pause(nowMs = performance.now()) {
    if (this.isCalibrated) this.engine.pause(nowMs / 1000);
  }

  resume(nowMs = performance.now()) {
    if (this.isCalibrated) this.engine.resume(nowMs / 1000);
  }

  markRest(nowMs = performance.now()) {
    if (this.isCalibrated) this.engine.markRest(nowMs / 1000);
  }

  createTimeOnlySnapshot(nowMs = performance.now(), { hidden = document.hidden } = {}) {
    if (!this.isCalibrated) return null;
    const nowSeconds = nowMs / 1000;
    const fatigue = this.engine.timeOnlyUpdate(nowSeconds);
    const last = this.lastResult || {};
    const detectionPayload = this.lastDetectionPayload || {
      image_width: last.image_width || 0,
      image_height: last.image_height || 0,
      left_eye_points: [],
      right_eye_points: [],
    };
    const message = fatigue.status === "PERLU_ISTIRAHAT"
      ? fatigue.message
      : (hidden
        ? "Timer layar tetap berjalan di background. Deteksi mata dilanjutkan otomatis saat tab aktif kembali."
        : "Timer layar tetap berjalan. Menunggu frame kamera berikutnya.");
    const snapshot = {
      success: true,
      phase: "MONITORING",
      message,
      is_calibrated: true,
      baseline_ear: this.engine.baselineEar || last.baseline_ear || 0,
      ear_left: last.ear_left || this.engine.baselineEar || 0,
      ear_right: last.ear_right || this.engine.baselineEar || 0,
      ear_avg: last.ear_avg || this.engine.baselineEar || 0,
      background_mode: true,
      save_interval_seconds: hidden ? 5 : 2,
      ...detectionPayload,
      ...fatigue,
      is_eye_closed: false,
      eye_state: hidden ? "BACKGROUND" : "MENUNGGU_FRAME",
      current_eye_closed_seconds: 0,
      message,
    };
    this.lastResult = snapshot;
    return snapshot;
  }

  processVideoFrame(video, nowMs = performance.now()) {
    if (!this.faceLandmarker || !video.videoWidth || !video.videoHeight) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    const frameGapSeconds = this.lastProcessedFrameAtMs >= 0
      ? Math.max(0, (nowMs - this.lastProcessedFrameAtMs) / 1000)
      : 0;
    if (this.isCalibrated && frameGapSeconds > this.config.frameGapResetSeconds) {
      this.engine.timeOnlyUpdate(nowMs / 1000);
    }
    this.lastProcessedFrameAtMs = nowMs;
    this.lastVideoTime = video.currentTime;

    // MediaPipe VIDEO mode requires timestamps to be strictly monotonically
    // increasing for the entire lifetime of this FaceLandmarker instance.
    // requestAnimationFrame timestamps can occasionally be slightly older than
    // a preceding performance.now() value, so guard the value explicitly.
    const requestedTimestampMs = Number.isFinite(nowMs) ? nowMs : performance.now();
    const mediaPipeTimestampMs = this.lastMediaPipeTimestampMs >= 0
      ? Math.max(requestedTimestampMs, this.lastMediaPipeTimestampMs + 1)
      : requestedTimestampMs;
    this.lastMediaPipeTimestampMs = mediaPipeTimestampMs;

    const result = this.faceLandmarker.detectForVideo(video, mediaPipeTimestampMs);
    const nowSeconds = mediaPipeTimestampMs / 1000;
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks) return this.handleMissing(video, nowSeconds);

    const toPixelPoint = (landmark) => ({
      x: landmark.x * video.videoWidth,
      y: landmark.y * video.videoHeight,
    });
    const leftEyePoints = LEFT_EYE_INDICES.map((index) => toPixelPoint(landmarks[index]));
    const rightEyePoints = RIGHT_EYE_INDICES.map((index) => toPixelPoint(landmarks[index]));
    const earLeft = calculateEar(leftEyePoints);
    const earRight = calculateEar(rightEyePoints);
    const earAvg = (earLeft + earRight) / 2;

    const detectionPayload = {
      image_width: video.videoWidth,
      image_height: video.videoHeight,
      left_eye_points: leftEyePoints,
      right_eye_points: rightEyePoints,
      ear_left: earLeft,
      ear_right: earRight,
      ear_avg: earAvg,
    };
    this.lastDetectionPayload = detectionPayload;

    if (!this.isCalibrated) {
      this.calibration.add(earAvg, nowSeconds);
      if (this.calibration.isComplete(nowSeconds)) {
        const calibrationResult = this.calibration.result(nowSeconds);
        if (calibrationResult) {
          this.engine.setBaseline(calibrationResult.baselineEar);
          this.engine.start(nowSeconds);
          this.isCalibrated = true;
          const fatigue = this.engine.update(earAvg, nowSeconds);
          this.lastResult = {
            success: true,
            phase: "CALIBRATION_DONE",
            message: "Kalibrasi berhasil. Monitoring lokal dimulai dari 00:00.",
            is_calibrated: true,
            baseline_ear: calibrationResult.baselineEar,
            calibration_progress: 1,
            ...detectionPayload,
            ...fatigue,
          };
          return this.lastResult;
        }
      }

      this.lastResult = {
        success: true,
        phase: "CALIBRATING",
        message: "Kalibrasi berjalan di browser. Tatap layar dan buka mata secara normal.",
        is_calibrated: false,
        calibration_progress: this.calibration.progress(nowSeconds),
        calibration_sample_count: this.calibration.samples.length,
        ear_threshold: 0,
        is_eye_closed: false,
        eye_state: "KALIBRASI",
        blink_event: false,
        blink_count_total: 0,
        blink_rate_per_minute: 0,
        blink_rate_ready: false,
        perclos: 0,
        perclos_ready: false,
        fatigue_score: 0,
        screen_duration_seconds: 0,
        duration_since_last_rest_seconds: 0,
        current_eye_closed_seconds: 0,
        status: "NORMAL",
        should_alert: false,
        ...detectionPayload,
      };
      return this.lastResult;
    }

    const fatigue = this.engine.update(earAvg, nowSeconds);
    this.lastResult = {
      success: true,
      phase: "MONITORING",
      is_calibrated: true,
      baseline_ear: this.engine.baselineEar,
      calibration_progress: 1,
      ...detectionPayload,
      ...fatigue,
    };
    return this.lastResult;
  }

  handleMissing(video, nowSeconds) {
    if (!this.isCalibrated) {
      this.lastResult = {
        success: false,
        phase: "CALIBRATING",
        message: "Wajah belum terdeteksi. Posisikan wajah di tengah kamera.",
        is_calibrated: false,
        calibration_progress: this.calibration.progress(nowSeconds),
        calibration_sample_count: this.calibration.samples.length,
        image_width: video.videoWidth,
        image_height: video.videoHeight,
        left_eye_points: [],
        right_eye_points: [],
        ear_left: 0,
        ear_right: 0,
        ear_avg: 0,
        ear_threshold: 0,
        is_eye_closed: false,
        eye_state: "TIDAK_TERDETEKSI",
        blink_event: false,
        blink_count_total: 0,
        blink_rate_per_minute: 0,
        blink_rate_ready: false,
        perclos: 0,
        perclos_ready: false,
        fatigue_score: 0,
        screen_duration_seconds: 0,
        duration_since_last_rest_seconds: 0,
        current_eye_closed_seconds: 0,
        status: "TIDAK_TERDETEKSI",
        should_alert: false,
      };
      return this.lastResult;
    }

    this.lastResult = {
      success: false,
      phase: "MONITORING",
      is_calibrated: true,
      baseline_ear: this.engine.baselineEar,
      calibration_progress: 1,
      image_width: video.videoWidth,
      image_height: video.videoHeight,
      left_eye_points: [],
      right_eye_points: [],
      ear_left: 0,
      ear_right: 0,
      ear_avg: 0,
      ...this.engine.updateMissing(nowSeconds),
    };
    return this.lastResult;
  }

  close() {
    this.faceLandmarker?.close?.();
    this.faceLandmarker = null;
  }
}
