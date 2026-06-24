import { appUrl, downloadFromApi, getJson, postJson, setReportAccessToken } from "./api.js?v=5.4.1";
import { initTheme } from "./theme.js?v=5.4.1";
import { BrowserEyeMonitor } from "./browser-eye-monitor.js?v=5.4.1";

const $ = (id) => document.getElementById(id);
const METRIC_SYNC_INTERVAL_MS = 1000;

let stream = null;
let captureRunning = false;
let animationFrameId = null;
let browserMonitor = null;
let metricSyncInFlight = false;
let metricSyncPromise = Promise.resolve();
let localSessionInitialized = false;
let lastMetricSyncAt = 0;
let lastLocalMetric = null;
let localFrameCount = 0;
let localFpsWindowStartedAt = 0;
let sessionEnded = false;
let metricLogs = [];
let lastMetricLogAt = 0;
let consecutiveFrameErrors = 0;
let audioContext = null;
let lastAudioAlertAt = 0;

const AUDIO_ENABLED_KEY = "netraware-audio-enabled";
const AUDIO_VOLUME_KEY = "netraware-audio-volume";
const DEFAULT_AUDIO_VOLUME = 70;
const AUDIO_REPLAY_GUARD_MS = 4500;

const video = $("videoElement");
const overlayCanvas = $("eyeOverlayCanvas");

function sessionCode() {
  return new URLSearchParams(location.search).get("session_code") || "";
}

function userCode() {
  return sessionStorage.getItem("netraware-user-code") || "-";
}

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function show(id, visible = true) {
  $(id)?.classList.toggle("hidden", !visible);
}

function disable(id, value) {
  if ($(id)) $(id).disabled = value;
}

function message(value, type = "") {
  const element = $("dashboardMessage");
  element.textContent = value || "";
  element.className = `inline-message ${type}`;
}

function connection(label, type = "neutral") {
  const element = $("connectionStatus");
  element.textContent = label;
  element.className = `status-chip ${type}`;
}

function readStoredBoolean(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function readStoredVolume() {
  try {
    const raw = localStorage.getItem(AUDIO_VOLUME_KEY);
    if (raw === null) return DEFAULT_AUDIO_VOLUME;
    const stored = Number(raw);
    return Number.isFinite(stored) ? Math.max(0, Math.min(100, stored)) : DEFAULT_AUDIO_VOLUME;
  } catch {
    return DEFAULT_AUDIO_VOLUME;
  }
}

function audioEnabled() {
  return Boolean($("audioEnabled")?.checked);
}

function audioVolume() {
  return Math.max(0, Math.min(100, Number($("audioVolume")?.value) || 0));
}

function updateAudioControls() {
  const enabled = audioEnabled();
  const volume = audioVolume();
  text("audioEnabledLabel", enabled ? "Aktif" : "Nonaktif");
  text("audioVolumeValue", `${volume}%`);
  disable("audioVolume", !enabled);
  disable("testAudioButton", !enabled || volume === 0);
}

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  return audioContext;
}

function unlockAudio() {
  if (!audioEnabled()) return;
  const context = getAudioContext();
  if (context?.state === "suspended") context.resume().catch(() => {});
}

async function playAlertSound({ force = false } = {}) {
  if (!force && !audioEnabled()) return false;
  const volume = audioVolume();
  if (volume <= 0) return false;

  const nowMs = Date.now();
  if (!force && nowMs - lastAudioAlertAt < AUDIO_REPLAY_GUARD_MS) return false;

  const context = getAudioContext();
  if (!context) {
    message("Browser tidak mendukung notifikasi audio Web Audio.", "error");
    return false;
  }

  try {
    if (context.state === "suspended") await context.resume();
    const start = context.currentTime + 0.02;
    const masterGain = context.createGain();
    masterGain.gain.setValueAtTime(0.0001, start);
    masterGain.gain.linearRampToValueAtTime((volume / 100) * 0.28, start + 0.03);
    masterGain.gain.setValueAtTime((volume / 100) * 0.28, start + 0.55);
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

    if (!force) lastAudioAlertAt = nowMs;
    return true;
  } catch {
    message("Suara diblokir browser. Tekan tombol ‘Uji suara’ atau aktifkan kamera sekali untuk memberi izin audio.", "error");
    return false;
  }
}

function initializeAudioSettings() {
  $("audioEnabled").checked = readStoredBoolean(AUDIO_ENABLED_KEY, true);
  $("audioVolume").value = String(readStoredVolume());
  updateAudioControls();

  $("audioEnabled").addEventListener("change", () => {
    try { localStorage.setItem(AUDIO_ENABLED_KEY, String(audioEnabled())); } catch {}
    updateAudioControls();
    if (audioEnabled()) unlockAudio();
  });

  $("audioVolume").addEventListener("input", () => {
    try { localStorage.setItem(AUDIO_VOLUME_KEY, String(audioVolume())); } catch {}
    updateAudioControls();
  });

  $("testAudioButton").addEventListener("click", async () => {
    const played = await playAlertSound({ force: true });
    if (played) message(`Uji suara diputar pada volume ${audioVolume()}%.`, "success");
  });
}

function formatNumber(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "0";
}

function formatPercent(value) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
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

function eyeStateLabel(data) {
  if (data.blink_event) return "Kedip terdeteksi";
  if (data.eye_state === "TERTUTUP" || data.is_eye_closed) return "Tertutup";
  if (data.eye_state === "TERBUKA") return "Terbuka";
  if (data.eye_state === "KALIBRASI") return "Kalibrasi";
  return "Tidak terdeteksi";
}

function updateStatusCard(status) {
  const card = $("statusCard");
  card.classList.remove("normal", "warning", "danger", "neutral");
  card.classList.add(status === "PERLU_ISTIRAHAT" ? "danger" : status === "WASPADA" ? "warning" : status === "TIDAK_TERDETEKSI" ? "neutral" : "normal");
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100)));
  text("calibrationPercent", `${percent}%`);
  $("calibrationProgress").style.width = `${percent}%`;
}

function updateMetrics(data) {
  text("eyeStateValue", eyeStateLabel(data));
  text("earValue", formatNumber(data.ear_avg, 3));
  text("earThresholdValue", formatNumber(data.ear_threshold, 3));
  text("blinkRateValue", data.blink_rate_ready ? formatNumber(data.blink_rate_per_minute, 2) : "Mengumpulkan…");
  text("blinkTotalValue", String(data.blink_count_total || 0));
  text("perclosValue", data.perclos_ready ? formatPercent(data.perclos) : "Mengumpulkan…");
  text("fatigueScoreValue", formatNumber(data.fatigue_score, 1));
  text("screenDurationValue", formatDuration(data.screen_duration_seconds));
  text("restDurationValue", formatDuration(data.duration_since_last_rest_seconds));
}

function updateDashboard(data) {
  drawEyeOverlay(data);

  if (data.phase === "CALIBRATING") {
    setProgress(data.calibration_progress);
    text("phaseLabel", data.success ? "Kalibrasi personal sedang berjalan." : "Posisikan wajah di tengah kamera.");
    text("statusLabel", data.success ? "Kalibrasi" : "Wajah belum terbaca");
    text("statusMessage", data.message || "Menunggu data.");
    text("eyeStateValue", data.success ? "Kalibrasi" : "Tidak terdeteksi");
    text("earValue", formatNumber(data.ear_avg, 3));
    updateStatusCard(data.success ? "NORMAL" : "TIDAK_TERDETEKSI");
    connection(data.success ? "Kalibrasi" : "Mencari wajah", data.success ? "warning" : "neutral");
    return;
  }

  if (data.phase === "CALIBRATION_DONE") {
    setProgress(1);
    text("phaseLabel", "Kalibrasi selesai. Timer monitoring dimulai dari 00:00.");
    text("statusLabel", "Normal");
    text("statusMessage", data.message);
    updateMetrics(data);
    updateStatusCard("NORMAL");
    connection("Monitoring aktif", "success");
    message("Kalibrasi berhasil. PERCLOS dan blink rate akan tampil setelah data awal mencukupi.", "success");
    return;
  }

  if (data.phase === "MONITORING") {
    text("phaseLabel", data.success ? "Monitoring aktif." : "Monitoring aktif, tetapi wajah belum terbaca.");
    text("statusLabel", statusLabel(data.status));
    text("statusMessage", data.message || "-");
    updateMetrics(data);
    updateStatusCard(data.status);
    if (data.storage_ok === false) {
      connection("Monitoring aktif • penyimpanan bermasalah", "warning");
      message(data.storage_warning || "Monitoring berjalan, tetapi data metrik belum dapat disimpan.", "error");
    } else {
      connection(data.success ? "Monitoring aktif" : "Wajah tidak terbaca", data.success ? "success" : "neutral");
    }
    if (data.success) appendMetricLog(data);
    const needsRest = data.status === "PERLU_ISTIRAHAT";
    show("alertBanner", needsRest);
    if (needsRest) text("alertMessage", data.message);
    if (data.should_alert) void playAlertSound();
  }
}

function drawEyeOverlay(data) {
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

function appendMetricLog(data) {
  const now = Date.now();
  if (!data.blink_event && now - lastMetricLogAt < 1000) return;
  lastMetricLogAt = now;
  metricLogs.unshift({
    time: new Date().toLocaleTimeString("id-ID"),
    ear: data.ear_avg,
    blink: data.blink_rate_ready ? formatNumber(data.blink_rate_per_minute, 2) : "-",
    perclos: data.perclos_ready ? formatPercent(data.perclos) : "-",
    score: formatNumber(data.fatigue_score, 1),
    status: statusLabel(data.status),
  });
  metricLogs = metricLogs.slice(0, 10);
  $("metricLogBody").innerHTML = metricLogs.map((item) => `
    <tr><td>${item.time}</td><td>${formatNumber(item.ear, 3)}</td><td>${item.blink}</td><td>${item.perclos}</td><td>${item.score}</td><td>${item.status}</td></tr>
  `).join("");
}

async function ensureBrowserMonitor() {
  if (!browserMonitor) {
    browserMonitor = new BrowserEyeMonitor({
      modelPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      calibrationDurationSeconds: 8,
    });
  }
  await browserMonitor.initialize();
  return browserMonitor;
}

async function startCamera() {
  if (sessionEnded || captureRunning) return;
  unlockAudio();
  if (!navigator.mediaDevices?.getUserMedia) {
    return message("Browser tidak mendukung akses kamera. Gunakan Chrome, Edge, atau Safari terbaru.", "error");
  }
  if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    return message("Kamera membutuhkan HTTPS atau localhost.", "error");
  }

  disable("cameraButton", true);
  message("Memuat model MediaPipe di browser…");
  text("eyeStateValue", "Memuat model…");
  connection("Menyiapkan MediaPipe", "warning");

  try {
    const monitor = await ensureBrowserMonitor();
    if (!localSessionInitialized) monitor.reset();

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, min: 15 },
        facingMode: "user",
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await postJson(`/monitoring/resume/${encodeURIComponent(sessionCode())}`);
    if (localSessionInitialized) monitor.resume();
    localSessionInitialized = true;

    show("cameraPlaceholder", false);
    captureRunning = true;
    metricSyncInFlight = false;
    lastMetricSyncAt = 0;
    localFrameCount = 0;
    localFpsWindowStartedAt = performance.now();
    disable("stopCameraButton", false);
    disable("endSessionButton", false);
    connection("Deteksi lokal aktif", "success");
    message("Kamera aktif. Video diproses langsung di browser dan tidak dikirim ke Railway.", "success");
    animationFrameId = requestAnimationFrame(runLocalDetectionLoop);
  } catch (error) {
    captureRunning = false;
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    show("cameraPlaceholder", true);
    disable("cameraButton", false);
    disable("stopCameraButton", true);
    connection("MediaPipe gagal", "danger");
    message(error.message || "Model MediaPipe atau kamera gagal diaktifkan.", "error");
  }
}

function buildMetricPayload(data) {
  return {
    success: Boolean(data.success),
    phase: data.phase || "MONITORING",
    message: data.message || "Monitoring lokal aktif.",
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
    save_interval_seconds: 1,
  };
}

function syncMetricToBackend(data, nowMs, force = false) {
  if (!data?.is_calibrated) return Promise.resolve();
  if (metricSyncInFlight) return metricSyncPromise;
  if (!force && nowMs - lastMetricSyncAt < METRIC_SYNC_INTERVAL_MS) return Promise.resolve();

  metricSyncInFlight = true;
  lastMetricSyncAt = nowMs;
  metricSyncPromise = postJson(
    `/monitoring/client-metric/${encodeURIComponent(sessionCode())}`,
    buildMetricPayload(data),
  ).then((response) => {
    consecutiveFrameErrors = 0;
    if (response.storage_ok === false) {
      connection("Deteksi lokal • penyimpanan bermasalah", "warning");
    }
    return response;
  }).catch((error) => {
    consecutiveFrameErrors += 1;
    connection("Deteksi lokal • sinkronisasi tertunda", "warning");
    if (consecutiveFrameErrors === 1 || consecutiveFrameErrors % 10 === 0) {
      message(`Deteksi tetap berjalan lokal, tetapi sinkronisasi database gagal: ${error.message}`, "error");
    }
    throw error;
  }).finally(() => {
    metricSyncInFlight = false;
  });
  return metricSyncPromise;
}

function runLocalDetectionLoop(nowMs = performance.now()) {
  if (!captureRunning || sessionEnded || !browserMonitor) return;

  try {
    const data = browserMonitor.processVideoFrame(video, nowMs);
    if (data) {
      lastLocalMetric = data;
      localFrameCount += 1;
      updateDashboard(data);
      syncMetricToBackend(data, nowMs, data.phase === "CALIBRATION_DONE");

      if (nowMs - localFpsWindowStartedAt >= 2000) {
        const localFps = localFrameCount / ((nowMs - localFpsWindowStartedAt) / 1000);
        console.info(`NetraWare local inference: ${localFps.toFixed(1)} FPS`);
        localFrameCount = 0;
        localFpsWindowStartedAt = nowMs;
      }
    }
  } catch (error) {
    connection("Deteksi lokal gagal", "danger");
    message(`MediaPipe browser gagal memproses frame: ${error.message}`, "error");
  }

  animationFrameId = requestAnimationFrame(runLocalDetectionLoop);
}

function notifyBackendPause(silent = false) {
  if (!sessionCode() || sessionEnded) return;
  postJson(`/monitoring/pause/${encodeURIComponent(sessionCode())}`).catch(() => {
    if (!silent) message("Kamera berhenti, tetapi status jeda gagal disinkronkan ke server.", "error");
  });
}

function stopCamera({ silent = false, notifyBackend = true } = {}) {
  const wasRunning = captureRunning;
  captureRunning = false;
  if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
  browserMonitor?.pause();
  if (lastLocalMetric?.is_calibrated) {
    syncMetricToBackend(lastLocalMetric, performance.now(), true);
  }
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  overlayCanvas.getContext("2d").clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  show("cameraPlaceholder", true);
  disable("cameraButton", sessionEnded);
  disable("stopCameraButton", true);
  if (notifyBackend && wasRunning && sessionCode() && !sessionEnded) {
    notifyBackendPause(silent);
  }
  if (!silent) {
    connection("Kamera berhenti", "neutral");
    message("Kamera dihentikan. Deteksi lokal dijeda.");
  }
}

async function markRest() {
  try {
    await postJson(`/monitoring/rest/${encodeURIComponent(sessionCode())}`, { note: "Dicatat melalui dashboard." });
    browserMonitor?.markRest();
    show("alertBanner", false);
    text("restDurationValue", "00:00");
    message("Istirahat dicatat. Evidence temporal sebelumnya telah direset.", "success");
  } catch (error) {
    message(error.message, "error");
  }
}

async function endSession() {
  if (!confirm("Akhiri sesi monitoring ini?")) return;
  try {
    if (lastLocalMetric?.is_calibrated) {
      try {
        await syncMetricToBackend(lastLocalMetric, performance.now(), true);
      } catch {
        // Ringkasan tetap dapat dibuat dari snapshot terakhir yang berhasil tersimpan.
      }
    }
    stopCamera({ silent: true, notifyBackend: false });
    const data = await postJson(`/monitoring/session/end/${encodeURIComponent(sessionCode())}`);
    sessionEnded = true;
    disable("cameraButton", true);
    disable("stopCameraButton", true);
    disable("restButton", true);
    disable("endSessionButton", true);
    show("sessionFinishedCard", true);
    text("statusLabel", statusLabel(data.session.final_status));
    text("statusMessage", "Sesi telah diakhiri dan ringkasan disimpan.");
    connection("Sesi selesai", "neutral");
    message("Sesi selesai. Laporan dapat diunduh melalui panel laporan.", "success");
  } catch (error) {
    message(error.message, "error");
  }
}

async function startAgain() {
  try {
    const data = await postJson("/monitoring/session/start", {
      user_code: userCode(), mode: "LIVE_CAMERA", calibration_duration_seconds: 8,
    });
    location.assign(appUrl(`/dashboard?session_code=${encodeURIComponent(data.session_code)}`));
  } catch (error) {
    message(error.message, "error");
  }
}

async function downloadPdf() {
  const button = $("downloadPdfButton");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Menyiapkan…";
  try {
    const code = encodeURIComponent(sessionCode());
    await downloadFromApi(
      `/report/${code}/pdf`,
      `laporan_monitoring_${sessionCode()}.pdf`,
    );
    message("File PDF berhasil dibuat dan diunduh.", "success");
  } catch (error) {
    if (String(error.message || "").includes("token")) {
      const token = prompt("Masukkan token akses laporan dari peneliti/admin:");
      if (token) {
        setReportAccessToken(token);
        try {
          const code = encodeURIComponent(sessionCode());
          await downloadFromApi(
            `/report/${code}/pdf`,
            `laporan_monitoring_${sessionCode()}.pdf`,
          );
          message("File PDF berhasil dibuat dan diunduh.", "success");
          return;
        } catch (retryError) {
          message(retryError.message, "error");
        }
      } else {
        message("Unduhan dibatalkan karena token laporan belum diisi.", "error");
      }
    } else {
      message(error.message, "error");
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function loadSession() {
  text("sessionCodeLabel", sessionCode() || "-");
  text("userCodeLabel", userCode());
  if (!sessionCode()) {
    message("Kode sesi tidak ditemukan. Mulai sesi dari halaman beranda.", "error");
    disable("cameraButton", true);
    return;
  }

  try {
    const data = await getJson(`/monitoring/session/${encodeURIComponent(sessionCode())}`);
    if (data.session.final_status === "BERJALAN" && data.is_active) {
      text("statusLabel", "Siap dimulai");
      text("statusMessage", "Aktifkan kamera untuk memulai kalibrasi.");
      text("eyeStateValue", "Menunggu kamera");
      connection("Kamera nonaktif", "neutral");
      return;
    }
    sessionEnded = true;
    show("sessionFinishedCard", true);
    disable("cameraButton", true);
    disable("restButton", true);
    disable("endSessionButton", true);
    text("statusLabel", statusLabel(data.session.final_status));
    text("statusMessage", "Sesi ini sudah selesai atau backend telah dimulai ulang.");
  } catch (error) {
    message(error.message, "error");
  }
}

function bindNavigation() {
  document.querySelectorAll("[data-nav-target]").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll("[data-nav-target]").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });
}

initTheme();
initializeAudioSettings();
bindNavigation();
$("cameraButton").addEventListener("click", startCamera);
$("stopCameraButton").addEventListener("click", () => stopCamera());
$("restButton").addEventListener("click", markRest);
$("alertRestButton").addEventListener("click", markRest);
$("endSessionButton").addEventListener("click", endSession);
$("startAgainButton").addEventListener("click", startAgain);
$("downloadPdfButton").addEventListener("click", downloadPdf);
window.addEventListener("beforeunload", () => {
  const code = sessionCode();
  if (captureRunning && code && !sessionEnded) {
    navigator.sendBeacon(appUrl(`/api/monitoring/pause/${encodeURIComponent(code)}`));
  }
  stopCamera({ silent: true, notifyBackend: false });
});
loadSession();
