let intervalId = null;
let intervalMs = 1000;

function stopTimer() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function tick() {
  postMessage({ type: "tick", wallTimeMs: Date.now() });
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "start") {
    intervalMs = Math.max(500, Number(data.intervalMs) || 1000);
    stopTimer();
    tick();
    intervalId = setInterval(tick, intervalMs);
  }
  if (data.type === "stop") stopTimer();
};
