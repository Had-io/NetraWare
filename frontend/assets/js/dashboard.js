import { appUrl, downloadFromApi, getJson, postJson, setReportAccessToken } from "./api.js?v=5.5.0";
import { initTheme } from "./theme.js?v=5.5.0";
import { BrowserEyeMonitor } from "./browser-eye-monitor.js?v=5.5.0";

const $ = (id) => document.getElementById(id);
const METRIC_SYNC_INTERVAL_MS = 1000;
const BACKGROUND_SYNC_INTERVAL_MS = 5000;
const BACKGROUND_DETECTION_INTERVAL_MS = 1000;
const SESSION_CLOCK_INTERVAL_MS = 1000;
const STALE_FRAME_CLOCK_MS = 1250;
const DESKTOP_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

let stream = null;
let captureRunning = false;
let animationFrameId = null;
let detectionIntervalId = null;
let sessionClockIntervalId = null;
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
let lastVisualFrameProcessedAt = 0;
let lastBackgroundMetricSyncAt = 0;
let notificationPermissionAsked = false;
let lastDesktopNotificationAt = 0;
let pageCloseSignalSent = false;
let floatingMonitorWindow = null;
let floatingMonitorMode = "none";
let floatingMonitorStartedAt = 0;


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

function requestDesktopNotificationPermission() {
  if (!("Notification" in window) || notificationPermissionAsked) return;
  notificationPermissionAsked = true;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function showDesktopNotification(data) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const now = Date.now();
  if (now - lastDesktopNotificationAt < DESKTOP_NOTIFICATION_COOLDOWN_MS) return;
  lastDesktopNotificationAt = now;
  try {
    new Notification("NetraWare: waktunya istirahat mata", {
      body: data.message || "Alihkan pandangan dari layar dan istirahat sejenak.",
      tag: "netraware-rest-reminder",
      renotify: true,
    });
  } catch {
    // Notifikasi desktop bersifat opsional; banner dashboard tetap aktif.
  }
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
  if (data.background_mode || data.eye_state === "BACKGROUND") return "Timer berjalan";
  if (data.eye_state === "MENUNGGU_FRAME") return "Menunggu frame";
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
    text("phaseLabel", data.background_mode
      ? "Monitoring sesi tetap aktif; menunggu frame kamera baru."
      : (data.success ? "Monitoring aktif." : "Monitoring aktif, tetapi wajah belum terbaca."));
    text("statusLabel", statusLabel(data.status));
    text("statusMessage", data.message || "-");
    updateMetrics(data);
    updateStatusCard(data.status);
    if (data.storage_ok === false) {
      connection("Monitoring aktif • penyimpanan bermasalah", "warning");
      message(data.storage_warning || "Monitoring berjalan, tetapi data metrik belum dapat disimpan.", "error");
    } else if (data.background_mode) {
      connection("Timer sesi aktif", "warning");
    } else {
      connection(data.success ? "Monitoring aktif" : "Wajah tidak terbaca", data.success ? "success" : "neutral");
    }
    if (data.success && !data.background_mode) appendMetricLog(data);
    const needsRest = data.status === "PERLU_ISTIRAHAT";
    show("alertBanner", needsRest);
    if (needsRest) text("alertMessage", data.message);
    if (data.should_alert) {
      void playAlertSound();
      showDesktopNotification(data);
    }
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


function isFloatingMonitorAlive() {
  return Boolean(floatingMonitorWindow && !floatingMonitorWindow.closed);
}

function floatingModeLabel() {
  if (floatingMonitorMode === "document-picture-in-picture") return "Picture-in-Picture";
  if (floatingMonitorMode === "popup") return "popup monitor";
  return "floating monitor";
}

function handleFloatingMonitorEvent(event) {
  const type = event?.data?.type || event?.type;
  const payload = event?.data?.payload || event?.payload || {};
  if (!type) return;

  if (type === "ready") {
    connection("Floating monitor siap", "warning");
    return;
  }

  if (type === "metric") {
    lastLocalMetric = payload;
    if (payload.phase !== "CALIBRATING") lastVisualFrameProcessedAt = performance.now();
    updateDashboard(payload);
    return;
  }

  if (type === "status") {
    connection(payload.label || "Floating monitor aktif", payload.level || "success");
    if (payload.message) message(payload.message, payload.messageType || "");
    return;
  }

  if (type === "closed") {
    captureRunning = false;
    stopMonitoringSchedulers();
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    show("cameraPlaceholder", true);
    disable("cameraButton", true);
    disable("stopCameraButton", true);
    disable("restButton", true);
    disable("endSessionButton", true);
    show("sessionFinishedCard", true);
    sessionEnded = true;
    connection("Sesi ditutup", "neutral");
    text("statusLabel", "Sesi selesai");
    text("statusMessage", payload.message || "Sesi ditutup karena floating monitor ditutup.");
    message(payload.message || "Sesi ditutup karena floating monitor ditutup.", "success");
    return;
  }

  if (type === "error") {
    connection("Floating monitor bermasalah", "danger");
    message(payload.message || "Floating monitor gagal berjalan.", "error");
  }
}

function renderFloatingMonitorDocument(targetWindow, mode) {
  const isPip = mode === "document-picture-in-picture";
  targetWindow.__NETRAWARE_FLOATING_CONFIG__ = {
    sessionCode: sessionCode(),
    userCode: userCode(),
    appOrigin: location.origin,
    version: "5.5.0",
    mode,
  };
  targetWindow.__NETRAWARE_PARENT_BRIDGE__ = handleFloatingMonitorEvent;

  const doc = targetWindow.document;
  doc.open();
  doc.write(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <base href="${location.origin}/">
  <title>NetraWare Floating Monitor</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 25% 0%, #155e75 0, #0f172a 42%, #020617 100%);
      color: #e5f4ff;
      min-width: 320px;
      overflow: hidden;
    }
    .shell { min-height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 12px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .brand { display:flex; flex-direction:column; gap:1px; line-height:1.05; }
    .brand strong { font-size: 15px; letter-spacing: .01em; }
    .brand span { font-size: 11px; color:#93c5fd; text-transform: uppercase; letter-spacing:.12em; }
    .chip { border:1px solid rgba(148,163,184,.24); background:rgba(15,23,42,.68); color:#bbf7d0; border-radius:999px; padding:6px 9px; font-size:11px; white-space:nowrap; }
    .video-wrap { position:relative; width:100%; aspect-ratio:4/3; border-radius:18px; overflow:hidden; background:#020617; border:1px solid rgba(125,211,252,.25); box-shadow:0 20px 48px rgba(0,0,0,.34); }
    video, canvas { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transform:scaleX(-1); }
    canvas { pointer-events:none; }
    .placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; text-align:center; padding:18px; background:linear-gradient(145deg, rgba(15,23,42,.88), rgba(8,47,73,.82)); }
    .placeholder strong { font-size:16px; }
    .placeholder small { margin-top:6px; color:#bfdbfe; line-height:1.35; }
    .status-card { background:rgba(15,23,42,.72); border:1px solid rgba(148,163,184,.22); border-radius:16px; padding:11px; box-shadow:0 14px 34px rgba(0,0,0,.22); }
    .status-card small { color:#93c5fd; text-transform:uppercase; letter-spacing:.12em; font-size:10px; }
    .status-card h1 { margin:5px 0 4px; font-size:20px; }
    .status-card p { margin:0; color:#dbeafe; font-size:12px; line-height:1.35; }
    .metrics { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; }
    .metric { background:rgba(2,6,23,.54); border:1px solid rgba(148,163,184,.18); border-radius:14px; padding:9px; }
    .metric span { display:block; color:#93c5fd; font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
    .metric strong { display:block; margin-top:3px; font-size:18px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    button { border:0; border-radius:12px; padding:10px 12px; font-weight:700; cursor:pointer; color:#ecfeff; background:linear-gradient(135deg,#0f766e,#0ea5e9); box-shadow:0 10px 20px rgba(8,145,178,.2); }
    button.secondary { background:rgba(15,23,42,.8); border:1px solid rgba(148,163,184,.28); box-shadow:none; }
    button.danger { background:linear-gradient(135deg,#dc2626,#f97316); }
    .foot { color:#bae6fd; font-size:10px; line-height:1.35; text-align:center; opacity:.9; }
    .hidden { display:none !important; }
    @media (max-height: 560px) { .metric strong { font-size:16px; } .status-card h1{font-size:18px;} .shell{gap:8px;padding:10px;} }
  </style>
</head>
<body>
  <main class="shell">
    <section class="top">
      <div class="brand"><span>NetraWare</span><strong>Floating Monitor</strong></div>
      <div id="modeChip" class="chip">${isPip ? "PiP aktif" : "Popup aktif"}</div>
    </section>
    <section class="video-wrap">
      <video id="floatingVideo" autoplay muted playsinline></video>
      <canvas id="floatingOverlay"></canvas>
      <div id="floatingPlaceholder" class="placeholder"><strong>Menyiapkan kamera…</strong><small>Jaga jendela kecil ini tetap terbuka saat bekerja di Word/aplikasi lain.</small></div>
    </section>
    <section id="floatingStatusCard" class="status-card">
      <small>Status saat ini</small>
      <h1 id="floatingStatusLabel">Menyiapkan</h1>
      <p id="floatingStatusMessage">Memuat MediaPipe dan menunggu izin kamera.</p>
    </section>
    <section class="metrics">
      <div class="metric"><span>EAR</span><strong id="floatingEar">0.000</strong></div>
      <div class="metric"><span>Kedip</span><strong id="floatingBlink">0</strong></div>
      <div class="metric"><span>Skor</span><strong id="floatingScore">0.0</strong></div>
      <div class="metric"><span>Durasi</span><strong id="floatingDuration">00:00</strong></div>
    </section>
    <section class="actions">
      <button id="floatingRestButton" type="button" class="secondary">Tandai istirahat</button>
      <button id="floatingEndButton" type="button" class="danger">Akhiri sesi</button>
    </section>
    <div class="foot">Deteksi berjalan dari floating window, bukan dari tab dashboard yang tersembunyi.</div>
  </main>
  <script type="module" src="/assets/js/floating-monitor.js?v=5.5.0"></script>
</body>
</html>`);
  doc.close();
  targetWindow.__NETRAWARE_FLOATING_CONFIG__ = {
    sessionCode: sessionCode(),
    userCode: userCode(),
    appOrigin: location.origin,
    version: "5.5.0",
    mode,
  };
  targetWindow.__NETRAWARE_PARENT_BRIDGE__ = handleFloatingMonitorEvent;
}


async function openFloatingMonitorWindow() {
  if (isFloatingMonitorAlive()) {
    focusFloatingMonitor();
    return floatingMonitorWindow;
  }

  if ("documentPictureInPicture" in window) {
    floatingMonitorMode = "document-picture-in-picture";
    floatingMonitorWindow = await window.documentPictureInPicture.requestWindow({ width: 380, height: 620 });
    renderFloatingMonitorDocument(floatingMonitorWindow, floatingMonitorMode);
    return floatingMonitorWindow;
  }

  floatingMonitorMode = "popup";
  floatingMonitorWindow = window.open(
    "",
    "netraware-floating-monitor",
    "popup=yes,width=380,height=620,left=80,top=80,resizable=yes,scrollbars=no",
  );
  if (!floatingMonitorWindow) {
    floatingMonitorMode = "none";
    throw new Error("Popup floating monitor diblokir browser. Izinkan popup untuk netraware.my.id atau gunakan Chrome/Edge terbaru.");
  }
  renderFloatingMonitorDocument(floatingMonitorWindow, floatingMonitorMode);
  return floatingMonitorWindow;
}

function focusFloatingMonitor() {
  if (!isFloatingMonitorAlive()) {
    message("Floating monitor belum aktif. Tekan Mulai floating monitor.", "error");
    return;
  }
  try { floatingMonitorWindow.focus(); } catch {}
  message(`Floating monitor ${floatingModeLabel()} sudah aktif. Biarkan jendela kecil itu terbuka saat bekerja.`, "success");
}

function deliverStreamToFloatingMonitor() {
  if (!stream || !isFloatingMonitorAlive()) return;
  try {
    floatingMonitorWindow.__NETRAWARE_STREAM__ = stream;
    floatingMonitorWindow.dispatchEvent(new floatingMonitorWindow.CustomEvent("netraware-stream-ready"));
  } catch (error) {
    message(`Stream kamera gagal dikirim ke floating monitor: ${error.message}`, "error");
  }
}

function sendFloatingCommand(command) {
  if (!isFloatingMonitorAlive()) return false;
  try {
    if (typeof floatingMonitorWindow.__NETRAWARE_FLOATING_COMMAND__ === "function") {
      floatingMonitorWindow.__NETRAWARE_FLOATING_COMMAND__(command);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function disposeFloatingMonitor({ suppressCloseBeacon = true } = {}) {
  if (!isFloatingMonitorAlive()) return;
  try {
    sendFloatingCommand({ type: "dispose", suppressCloseBeacon });
    floatingMonitorWindow.close();
  } catch {}
  floatingMonitorWindow = null;
  floatingMonitorMode = "none";
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
  requestDesktopNotificationPermission();
  if (!navigator.mediaDevices?.getUserMedia) {
    return message("Browser tidak mendukung akses kamera. Gunakan Chrome atau Microsoft Edge terbaru di komputer/laptop.", "error");
  }
  if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    return message("Kamera membutuhkan HTTPS atau localhost.", "error");
  }

  disable("cameraButton", true);
  disable("stopCameraButton", true);
  message("Membuka floating monitor…");
  text("eyeStateValue", "Menyiapkan monitor…");
  connection("Membuka floating monitor", "warning");

  try {
    await openFloatingMonitorWindow();
  } catch (error) {
    disable("cameraButton", false);
    connection("Floating monitor gagal", "danger");
    return message(error.message || "Floating monitor gagal dibuka.", "error");
  }

  try {
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
    await video.play().catch(() => {});
    await postJson(`/monitoring/resume/${encodeURIComponent(sessionCode())}`).catch(() => {});

    captureRunning = true;
    localSessionInitialized = true;
    metricSyncInFlight = false;
    lastMetricSyncAt = 0;
    lastLocalMetric = null;
    localFrameCount = 0;
    localFpsWindowStartedAt = performance.now();
    lastVisualFrameProcessedAt = 0;
    lastBackgroundMetricSyncAt = 0;
    floatingMonitorStartedAt = Date.now();

    show("cameraPlaceholder", false);
    disable("stopCameraButton", false);
    disable("endSessionButton", false);
    connection("Floating monitor aktif", "success");
    message(`Floating monitor ${floatingModeLabel()} aktif. Deteksi mata sekarang berjalan di jendela kecil, sehingga tetap bekerja saat membuka Word/aplikasi lain.`, "success");
    deliverStreamToFloatingMonitor();
  } catch (error) {
    captureRunning = false;
    stopMonitoringSchedulers();
    disposeFloatingMonitor({ suppressCloseBeacon: true });
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    show("cameraPlaceholder", true);
    disable("cameraButton", false);
    disable("stopCameraButton", true);
    connection("Kamera gagal", "danger");
    message(error.message || "Kamera gagal diaktifkan.", "error");
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
    save_interval_seconds: Math.max(0.25, Number(data.save_interval_seconds) || 1),
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

function processDetectionFrame(nowMs = performance.now()) {
  if (!captureRunning || sessionEnded || !browserMonitor) return null;

  try {
    const data = browserMonitor.processVideoFrame(video, nowMs);
    if (data) {
      lastVisualFrameProcessedAt = nowMs;
      lastLocalMetric = data;
      localFrameCount += 1;
      updateDashboard(data);
      void syncMetricToBackend(data, nowMs, data.phase === "CALIBRATION_DONE").catch(() => {});

      if (nowMs - localFpsWindowStartedAt >= 2000) {
        const localFps = localFrameCount / ((nowMs - localFpsWindowStartedAt) / 1000);
        console.info(`NetraWare local inference: ${localFps.toFixed(1)} FPS`);
        localFrameCount = 0;
        localFpsWindowStartedAt = nowMs;
      }
    }
    return data;
  } catch (error) {
    connection("Deteksi lokal gagal", "danger");
    message(`MediaPipe browser gagal memproses frame: ${error.message}`, "error");
    return null;
  }
}

function updateSessionClockSnapshot({ forceSync = false } = {}) {
  if (!captureRunning || sessionEnded || !browserMonitor?.isCalibrated) return null;
  const nowMs = performance.now();
  const frameIsStale = !lastVisualFrameProcessedAt
    || nowMs - lastVisualFrameProcessedAt >= STALE_FRAME_CLOCK_MS;
  if (!frameIsStale && !forceSync) return lastLocalMetric;

  const data = browserMonitor.createClockSnapshot(nowMs, { hidden: document.hidden });
  if (!data) return null;
  lastLocalMetric = data;
  updateDashboard(data);

  const dueForSync = forceSync
    || data.should_alert
    || nowMs - lastBackgroundMetricSyncAt >= BACKGROUND_SYNC_INTERVAL_MS;
  if (dueForSync) {
    lastBackgroundMetricSyncAt = nowMs;
    void syncMetricToBackend(data, nowMs, true).catch(() => {});
  }
  return data;
}

function backgroundDetectionTick() {
  if (!captureRunning || sessionEnded || !browserMonitor) return;
  const nowMs = performance.now();
  const shouldAttempt = document.hidden
    || !document.hasFocus()
    || !lastVisualFrameProcessedAt
    || nowMs - lastVisualFrameProcessedAt >= STALE_FRAME_CLOCK_MS;
  if (shouldAttempt) processDetectionFrame(nowMs);
  updateSessionClockSnapshot();
}

function runLocalDetectionLoop(nowMs = performance.now()) {
  if (!captureRunning || sessionEnded || !browserMonitor) return;
  processDetectionFrame(nowMs);
  animationFrameId = requestAnimationFrame(runLocalDetectionLoop);
}

function startMonitoringSchedulers() {
  stopMonitoringSchedulers();
  animationFrameId = requestAnimationFrame(runLocalDetectionLoop);
  detectionIntervalId = window.setInterval(backgroundDetectionTick, BACKGROUND_DETECTION_INTERVAL_MS);
  sessionClockIntervalId = window.setInterval(() => updateSessionClockSnapshot(), SESSION_CLOCK_INTERVAL_MS);
}

function stopMonitoringSchedulers() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (detectionIntervalId !== null) {
    clearInterval(detectionIntervalId);
    detectionIntervalId = null;
  }
  if (sessionClockIntervalId !== null) {
    clearInterval(sessionClockIntervalId);
    sessionClockIntervalId = null;
  }
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
  stopMonitoringSchedulers();
  browserMonitor?.pause();
  disposeFloatingMonitor({ suppressCloseBeacon: true });
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
    connection("Floating monitor berhenti", "neutral");
    message("Floating monitor dihentikan. Deteksi lokal dijeda.");
  }
}

async function markRest() {
  try {
    await postJson(`/monitoring/rest/${encodeURIComponent(sessionCode())}`, { note: "Dicatat melalui dashboard." });
    browserMonitor?.markRest();
    sendFloatingCommand({ type: "markRest" });
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
    const finalMetric = browserMonitor?.isCalibrated
      ? browserMonitor.createClockSnapshot(performance.now(), { hidden: document.hidden, reason: "manual_end" })
      : lastLocalMetric;
    if (finalMetric?.is_calibrated) {
      try {
        lastLocalMetric = finalMetric;
        await syncMetricToBackend(finalMetric, performance.now(), true);
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
      text("statusMessage", "Aktifkan floating monitor untuk memulai kalibrasi.");
      text("eyeStateValue", "Menunggu floating monitor");
      connection("Floating monitor nonaktif", "neutral");
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

function sendCloseSessionBeacon() {
  const code = sessionCode();
  if (!code || sessionEnded || pageCloseSignalSent) return;
  pageCloseSignalSent = true;
  let finalMetric = lastLocalMetric;
  try {
    if (browserMonitor?.isCalibrated) {
      finalMetric = browserMonitor.createClockSnapshot(performance.now(), {
        hidden: true,
        reason: "page_close",
      }) || lastLocalMetric;
    }
  } catch {
    finalMetric = lastLocalMetric;
  }

  if (finalMetric?.is_calibrated) {
    try {
      const body = new Blob([JSON.stringify(buildMetricPayload(finalMetric))], {
        type: "application/json",
      });
      navigator.sendBeacon(appUrl(`/api/monitoring/session/close/${encodeURIComponent(code)}`), body);
      disposeFloatingMonitor({ suppressCloseBeacon: true });
      return;
    } catch {
      // Fallback di bawah tetap mencoba menutup sesi tanpa snapshot akhir.
    }
  }
  navigator.sendBeacon(appUrl(`/api/monitoring/session/close/${encodeURIComponent(code)}`));
  disposeFloatingMonitor({ suppressCloseBeacon: true });
}

function bindNavigation() {
  document.querySelectorAll("[data-nav-target]").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll("[data-nav-target]").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });
}

window.addEventListener("message", handleFloatingMonitorEvent);
initTheme();
initializeAudioSettings();
bindNavigation();
$("cameraButton").addEventListener("click", startCamera);
$("stopCameraButton").addEventListener("click", focusFloatingMonitor);
$("restButton").addEventListener("click", markRest);
$("alertRestButton").addEventListener("click", markRest);
$("endSessionButton").addEventListener("click", endSession);
$("startAgainButton").addEventListener("click", startAgain);
$("downloadPdfButton").addEventListener("click", downloadPdf);
document.addEventListener("visibilitychange", () => {
  if (!captureRunning || sessionEnded) return;
  processDetectionFrame(performance.now());
  updateSessionClockSnapshot({ forceSync: true });
  if (!document.hidden && browserMonitor?.isCalibrated) {
    message("Tab aktif kembali. Timer sesi tetap berjalan; deteksi EAR dilanjutkan dari frame kamera terbaru.", "success");
  }
});
window.addEventListener("blur", () => {
  if (!captureRunning || sessionEnded) return;
  processDetectionFrame(performance.now());
  updateSessionClockSnapshot({ forceSync: true });
});
window.addEventListener("focus", () => {
  if (!captureRunning || sessionEnded) return;
  processDetectionFrame(performance.now());
  updateSessionClockSnapshot({ forceSync: true });
});
window.addEventListener("pagehide", sendCloseSessionBeacon);
window.addEventListener("beforeunload", sendCloseSessionBeacon);
loadSession();
