import { appUrl, postJson } from "./api.js?v=5.5.0";
import { BrowserEyeMonitor } from "./browser-eye-monitor.js?v=5.5.0";

const MODEL_PATH = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const METRIC_SYNC_INTERVAL_MS = 1000;
const CLOCK_INTERVAL_MS = 1000;
const STALE_FRAME_MS = 1500;
const BACKGROUND_SYNC_INTERVAL_MS = 5000;
const AUDIO_REPLAY_GUARD_MS = 4500;
const DESKTOP_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

const config = window.__NETRAWARE_FLOATING_CONFIG__ || {};
const sessionCode = String(config.sessionCode || "");

const $ = (id) => document.getElementById(id);
const video = $("floatingVideo");
const overlayCanvas = $("floatingOverlay");
const placeholder = $("floatingPlaceholder");

let stream = null;
let monitor = null;
let captureRunning = false;
let sessionEnded = false;
let closeSignalSent = false;
let animationFrameId = null;
let guardIntervalId = null;
let clockIntervalId = null;
let metricSyncInFlight = false;
let metricSyncPromise = Promise.resolve();
let lastMetricSyncAt = 0;
let lastBackgroundMetricSyncAt = 0;
let lastProcessedFrameAt = 0;
let lastMetric = null;
let audioContext = null;
let lastAudioAlertAt = 0;
let lastDesktopNotificationAt = 0;

function emit(type, payload = {}) {
  try {
    if (typeof window.__NETRAWARE_PARENT_BRIDGE__ === "function") {
      window.__NETRAWARE_PARENT_BRIDGE__({ type, payload });
    }
  } catch {}
  try {
    window.opener?.postMessage({ type, payload }, config.appOrigin || window.location.origin);
  } catch {}
}

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function show(element, visible = true) {
  element?.classList.toggle("hidden", !visible);
}

function formatNumber(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "0";
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function statusLabel(status) {
  return {
    NORMAL: "Normal",
    WASPADA: "Waspada",
    PERLU_ISTIRAHAT: "Perlu istirahat",
    TIDAK_TERDETEKSI: "Tidak terdeteksi",
    BERJALAN: "Siap dimulai",
    TANPA_DATA: "Tanpa data",
  }[status] || status || "-";
}

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  return audioContext;
}

async function playAlertSound() {
  const nowMs = Date.now();
  if (nowMs - lastAudioAlertAt < AUDIO_REPLAY_GUARD_MS) return;
  const context = getAudioContext();
  if (!context) return;
  try {
    if (context.state === "suspended") await context.resume();
    const start = context.currentTime + 0.02;
    const masterGain = context.createGain();
    masterGain.gain.setValueAtTime(0.0001, start);
    masterGain.gain.linearRampToValueAtTime(0.22, start + 0.03);
    masterGain.gain.setValueAtTime(0.22, start + 0.55);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.75);
    masterGain.connect(context.destination);
    [784, 988, 784].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const toneGain = context.createGain();
      const toneStart = start + index * 0.22;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, toneStart);
      toneGain.gain.setValueAtTime(0.0001, toneStart);
      toneGain.gain.exponentialRampToValueAtTime(1, toneStart + 0.015);
      toneGain.gain.setValueAtTime(1, toneStart + 0.13);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.18);
      oscillator.connect(toneGain);
      toneGain.connect(masterGain);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + 0.19);
    });
    lastAudioAlertAt = nowMs;
  } catch {}
}

function showDesktopNotification(data) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  if (now - lastDesktopNotificationAt < DESKTOP_NOTIFICATION_COOLDOWN_MS) return;
  lastDesktopNotificationAt = now;
  try {
    new Notification("NetraWare: waktunya istirahat mata", {
      body: data.message || "Alihkan pandangan dari layar dan istirahat sejenak.",
      tag: "netraware-rest-reminder",
      renotify: true,
    });
  } catch {}
}

function drawEye(context, points, stroke) {
  if (!points.length) return;
  context.save();
  context.strokeStyle = stroke;
  context.fillStyle = `${stroke}2b`;
  context.lineWidth = 3;
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.closePath();
  context.fill();
  context.stroke();
  points.forEach((point) => {
    context.beginPath();
    context.arc(point.x, point.y, 3, 0, Math.PI * 2);
    context.fillStyle = stroke;
    context.fill();
  });
  context.restore();
}

function drawOverlay(data) {
  const context = overlayCanvas.getContext("2d");
  const width = Number(data.image_width) || video.videoWidth || 640;
  const height = Number(data.image_height) || video.videoHeight || 480;
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  context.clearRect(0, 0, width, height);

  const left = Array.isArray(data.left_eye_points) ? data.left_eye_points : [];
  const right = Array.isArray(data.right_eye_points) ? data.right_eye_points : [];
  if (!left.length && !right.length) return;
  const stroke = data.blink_event ? "#f59e0b" : data.is_eye_closed ? "#ef4444" : "#22c55e";
  [left, right].forEach((points) => drawEye(context, points, stroke));
}

function updateFloatingUi(data) {
  drawOverlay(data);
  show(placeholder, false);
  text("floatingEar", formatNumber(data.ear_avg, 3));
  text("floatingBlink", String(data.blink_count_total || 0));
  text("floatingScore", formatNumber(data.fatigue_score, 1));
  text("floatingDuration", formatDuration(data.screen_duration_seconds));

  if (data.phase === "CALIBRATING") {
    const percent = Math.round((Number(data.calibration_progress) || 0) * 100);
    text("floatingStatusLabel", `Kalibrasi ${percent}%`);
    text("floatingStatusMessage", data.message || "Tatap layar dan buka mata secara normal.");
    return;
  }

  if (data.phase === "CALIBRATION_DONE") {
    text("floatingStatusLabel", "Monitoring aktif");
    text("floatingStatusMessage", data.message || "Kalibrasi selesai. Monitoring dimulai.");
    return;
  }

  text("floatingStatusLabel", statusLabel(data.status));
  text("floatingStatusMessage", data.message || "Monitoring aktif.");
  if (data.should_alert) {
    void playAlertSound();
    showDesktopNotification(data);
  }
}

async function ensureMonitor() {
  if (!monitor) {
    monitor = new BrowserEyeMonitor({
      modelPath: MODEL_PATH,
      calibrationDurationSeconds: 8,
    });
  }
  await monitor.initialize();
  return monitor;
}

function buildMetricPayload(data) {
  return {
    success: Boolean(data.success),
    phase: data.phase || "MONITORING",
    message: data.message || "Monitoring floating aktif.",
    is_calibrated: Boolean(data.is_calibrated),
    baseline_ear: data.baseline_ear ?? null,
    ear_left: Number(data.ear_left) || 0,
    ear_right: Number(data.ear_right) || 0,
    ear_avg: Number(data.ear_avg) || 0,
    ear_threshold: Number(data.ear_threshold) || 0,
    is_eye_closed: Boolean(data.is_eye_closed),
    eye_state: data.eye_state || "TIDAK_TERDETEKSI",
    blink_event: Boolean(data.blink_event),
    blink_count_total: Number(data.blink_count_total) || 0,
    blink_rate_per_minute: Number(data.blink_rate_per_minute) || 0,
    blink_rate_ready: Boolean(data.blink_rate_ready),
    perclos: Number(data.perclos) || 0,
    perclos_ready: Boolean(data.perclos_ready),
    screen_duration_seconds: Number(data.screen_duration_seconds) || 0,
    duration_since_last_rest_seconds: Number(data.duration_since_last_rest_seconds) || 0,
    current_eye_closed_seconds: Number(data.current_eye_closed_seconds) || 0,
    fatigue_score: Number(data.fatigue_score) || 0,
    status: data.status || "NORMAL",
    should_alert: Boolean(data.should_alert),
    save_interval_seconds: Math.max(0.25, Number(data.save_interval_seconds) || 1),
  };
}

function syncMetricToBackend(data, nowMs, force = false) {
  if (!data?.is_calibrated || !sessionCode) return Promise.resolve();
  if (metricSyncInFlight) return metricSyncPromise;
  if (!force && nowMs - lastMetricSyncAt < METRIC_SYNC_INTERVAL_MS) return Promise.resolve();

  metricSyncInFlight = true;
  lastMetricSyncAt = nowMs;
  metricSyncPromise = postJson(
    `/monitoring/client-metric/${encodeURIComponent(sessionCode)}`,
    buildMetricPayload(data),
  ).then((response) => {
    if (response.storage_ok === false) {
      emit("status", { label: "Penyimpanan bermasalah", level: "warning" });
    }
    return response;
  }).catch((error) => {
    emit("status", {
      label: "Sinkronisasi tertunda",
      level: "warning",
      message: `Monitoring tetap berjalan, tetapi sinkronisasi database gagal: ${error.message}`,
      messageType: "error",
    });
    throw error;
  }).finally(() => {
    metricSyncInFlight = false;
  });
  return metricSyncPromise;
}

function processDetectionFrame(nowMs = performance.now()) {
  if (!captureRunning || sessionEnded || !monitor) return null;
  try {
    const data = monitor.processVideoFrame(video, nowMs);
    if (!data) return null;
    lastProcessedFrameAt = nowMs;
    lastMetric = data;
    updateFloatingUi(data);
    emit("metric", data);
    void syncMetricToBackend(data, nowMs, data.phase === "CALIBRATION_DONE").catch(() => {});
    return data;
  } catch (error) {
    text("floatingStatusLabel", "Deteksi gagal");
    text("floatingStatusMessage", error.message || "MediaPipe gagal memproses frame.");
    emit("error", { message: error.message || "MediaPipe gagal memproses frame." });
    return null;
  }
}

function updateClockSnapshot({ forceSync = false, reason = "floating_clock" } = {}) {
  if (!captureRunning || sessionEnded || !monitor?.isCalibrated) return null;
  const nowMs = performance.now();
  const frameIsStale = !lastProcessedFrameAt || nowMs - lastProcessedFrameAt >= STALE_FRAME_MS;
  if (!frameIsStale && !forceSync) return lastMetric;

  const data = monitor.createClockSnapshot(nowMs, { hidden: false, reason });
  if (!data) return null;
  lastMetric = data;
  updateFloatingUi(data);
  emit("metric", data);

  const dueForSync = forceSync || data.should_alert || nowMs - lastBackgroundMetricSyncAt >= BACKGROUND_SYNC_INTERVAL_MS;
  if (dueForSync) {
    lastBackgroundMetricSyncAt = nowMs;
    void syncMetricToBackend(data, nowMs, true).catch(() => {});
  }
  return data;
}

function runLoop(nowMs = performance.now()) {
  if (!captureRunning || sessionEnded) return;
  processDetectionFrame(nowMs);
  animationFrameId = window.requestAnimationFrame(runLoop);
}

function startSchedulers() {
  stopSchedulers();
  animationFrameId = window.requestAnimationFrame(runLoop);
  guardIntervalId = window.setInterval(() => processDetectionFrame(performance.now()), 250);
  clockIntervalId = window.setInterval(() => updateClockSnapshot(), CLOCK_INTERVAL_MS);
}

function stopSchedulers() {
  if (animationFrameId !== null) {
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (guardIntervalId !== null) {
    window.clearInterval(guardIntervalId);
    guardIntervalId = null;
  }
  if (clockIntervalId !== null) {
    window.clearInterval(clockIntervalId);
    clockIntervalId = null;
  }
}

async function startWithStream(nextStream) {
  if (!sessionCode) {
    text("floatingStatusLabel", "Sesi tidak valid");
    text("floatingStatusMessage", "Kode sesi tidak ditemukan.");
    return;
  }
  if (!nextStream) {
    text("floatingStatusLabel", "Menunggu kamera");
    text("floatingStatusMessage", "Stream kamera belum diterima dari dashboard.");
    return;
  }

  stream = nextStream;
  video.srcObject = stream;
  show(placeholder, false);
  text("floatingStatusLabel", "Memuat MediaPipe");
  text("floatingStatusMessage", "Model deteksi wajah sedang dimuat di floating monitor.");
  emit("status", { label: "Memuat MediaPipe", level: "warning" });

  try {
    await video.play();
    await ensureMonitor();
    await postJson(`/monitoring/resume/${encodeURIComponent(sessionCode)}`).catch(() => {});
    captureRunning = true;
    sessionEnded = false;
    lastMetricSyncAt = 0;
    lastBackgroundMetricSyncAt = 0;
    lastProcessedFrameAt = 0;
    startSchedulers();
    emit("status", {
      label: "Floating monitor aktif",
      level: "success",
      message: "Floating monitor aktif. Silakan buka Word/aplikasi lain; jendela kecil ini menjaga deteksi tetap berjalan.",
      messageType: "success",
    });
  } catch (error) {
    text("floatingStatusLabel", "Gagal dimulai");
    text("floatingStatusMessage", error.message || "Floating monitor gagal dimulai.");
    emit("error", { message: error.message || "Floating monitor gagal dimulai." });
  }
}

async function markRest() {
  if (!sessionCode) return;
  try {
    await postJson(`/monitoring/rest/${encodeURIComponent(sessionCode)}`, { note: "Dicatat melalui floating monitor." });
    monitor?.markRest();
    text("floatingStatusLabel", "Istirahat dicatat");
    text("floatingStatusMessage", "Evidence temporal telah direset.");
    emit("status", { label: "Istirahat dicatat", level: "success", message: "Istirahat dicatat dari floating monitor.", messageType: "success" });
  } catch (error) {
    text("floatingStatusMessage", error.message || "Istirahat gagal dicatat.");
    emit("error", { message: error.message || "Istirahat gagal dicatat." });
  }
}

async function endSessionFromFloating() {
  if (sessionEnded) return;
  if (!confirm("Akhiri sesi monitoring ini?")) return;
  sessionEnded = true;
  try {
    const finalMetric = monitor?.isCalibrated
      ? monitor.createClockSnapshot(performance.now(), { hidden: false, reason: "floating_manual_end" })
      : lastMetric;
    if (finalMetric?.is_calibrated) {
      lastMetric = finalMetric;
      await syncMetricToBackend(finalMetric, performance.now(), true).catch(() => {});
      emit("metric", finalMetric);
    }
    stopSchedulers();
    stream?.getTracks().forEach((track) => track.stop());
    await postJson(`/monitoring/session/end/${encodeURIComponent(sessionCode)}`);
    closeSignalSent = true;
    emit("closed", { message: "Sesi selesai dari floating monitor." });
    try { window.close(); } catch {}
  } catch (error) {
    sessionEnded = false;
    text("floatingStatusLabel", "Gagal mengakhiri");
    text("floatingStatusMessage", error.message || "Sesi gagal diakhiri.");
    emit("error", { message: error.message || "Sesi gagal diakhiri." });
  }
}

function sendCloseSessionBeacon() {
  if (!sessionCode || sessionEnded || closeSignalSent) return;
  closeSignalSent = true;
  let finalMetric = lastMetric;
  try {
    if (monitor?.isCalibrated) {
      finalMetric = monitor.createClockSnapshot(performance.now(), { hidden: false, reason: "floating_close" }) || lastMetric;
    }
  } catch {}

  try {
    if (finalMetric?.is_calibrated) {
      const body = new Blob([JSON.stringify(buildMetricPayload(finalMetric))], { type: "application/json" });
      navigator.sendBeacon(appUrl(`/api/monitoring/session/close/${encodeURIComponent(sessionCode)}`), body);
    } else {
      navigator.sendBeacon(appUrl(`/api/monitoring/session/close/${encodeURIComponent(sessionCode)}`));
    }
  } catch {}
  emit("closed", { message: "Sesi ditutup karena floating monitor ditutup." });
}

function dispose({ suppressCloseBeacon = true } = {}) {
  if (suppressCloseBeacon) closeSignalSent = true;
  sessionEnded = true;
  stopSchedulers();
  stream?.getTracks().forEach((track) => track.stop());
}

window.__NETRAWARE_FLOATING_COMMAND__ = (command = {}) => {
  if (command.type === "markRest") {
    monitor?.markRest();
    return;
  }
  if (command.type === "dispose") {
    dispose({ suppressCloseBeacon: command.suppressCloseBeacon !== false });
  }
};

window.addEventListener("netraware-stream-ready", () => {
  void startWithStream(window.__NETRAWARE_STREAM__);
});

window.addEventListener("pagehide", sendCloseSessionBeacon);
window.addEventListener("beforeunload", sendCloseSessionBeacon);
$("floatingRestButton")?.addEventListener("click", markRest);
$("floatingEndButton")?.addEventListener("click", endSessionFromFloating);

emit("ready", { mode: config.mode || "floating" });
if (window.__NETRAWARE_STREAM__) {
  void startWithStream(window.__NETRAWARE_STREAM__);
}
