import { appUrl, postJson } from "./api.js?v=5.4.3";
import { initTheme } from "./theme.js?v=5.4.3";

const $ = (id) => document.getElementById(id);

function setMessage(message, type = "") {
  const element = $("startMessage");
  element.textContent = message;
  element.className = `form-message ${type}`;
}

async function handleSubmit(event) {
  event.preventDefault();
  const button = $("startButton");
  const userCode = $("userCodeInput").value.trim();
  const consent = $("consentInput").checked;

  if (!userCode) return setMessage("Kode responden wajib diisi.", "error");
  if (!consent) return setMessage("Persetujuan penggunaan data wajib dicentang.", "error");

  button.disabled = true;
  button.textContent = "Membuat sesi…";
  setMessage("Mempersiapkan sesi monitoring.");

  try {
    await postJson("/monitoring/users", {
      user_code: userCode,
      consent_given: true,
    });

    const session = await postJson("/monitoring/session/start", {
      user_code: userCode,
      mode: "LIVE_CAMERA",
      calibration_duration_seconds: 8,
    });

    sessionStorage.setItem("netraware-user-code", userCode);
    window.location.assign(appUrl(`/dashboard?session_code=${encodeURIComponent(session.session_code)}`));
  } catch (error) {
    setMessage(error.message, "error");
    button.disabled = false;
    button.textContent = "Mulai monitoring";
  }
}

initTheme();
$("startForm")?.addEventListener("submit", handleSubmit);
