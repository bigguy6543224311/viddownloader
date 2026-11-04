const urlInput = document.getElementById("url");
const typeSelect = document.getElementById("type");
const qualitySelect = document.getElementById("quality");
const qualityField = document.getElementById("qualityField");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const saveLink = document.getElementById("saveLink");
const copyTitleBtn = document.getElementById("copyTitleBtn");
let completedVideoTitle = "";
const transferPanel = document.getElementById("transferPanel");
const transferEmpty = document.getElementById("transferEmpty");
const transferDetails = document.getElementById("transferDetails");
const transferName = document.getElementById("transferName");
const transferState = document.getElementById("transferState");
const transferPercent = document.getElementById("transferPercent");
const transferBar = document.getElementById("transferBar");
const transferSpeed = document.getElementById("transferSpeed");
const transferEta = document.getElementById("transferEta");
document.getElementById("transferClose").addEventListener("click", () => { transferPanel.hidden = true; });
function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let n = Number(value), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatEta(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0) return "";
  const seconds = Math.round(Number(value));
  return seconds < 60 ? `${seconds}s left` : `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
}
function updateTransfer(job) {
  transferPanel.hidden = false;
  transferEmpty.hidden = true;
  transferDetails.hidden = false;
  transferName.textContent = job.title || job.filename || "Preparing your file…";
  transferState.textContent = job.status === "done" ? "Ready to save" : job.status === "error" ? "Download failed" : (job.message || "Downloading…");
  const pct = Number.isFinite(Number(job.progress)) ? Math.max(0, Math.min(100, Number(job.progress))) : 0;
  transferPercent.textContent = `${pct}%`;
  transferBar.style.width = `${pct}%`;
  transferSpeed.textContent = job.status === "done" ? "Complete" : formatBytes(job.speed);
  transferEta.textContent = job.status === "done" ? "" : formatEta(job.eta);
  if (job.status === "error") transferBar.classList.add("transfer-error");
  else transferBar.classList.remove("transfer-error");
}

typeSelect.addEventListener("change", () => {
  qualityField.style.opacity = typeSelect.value === "mp3" ? ".4" : "1";
  qualitySelect.disabled = typeSelect.value === "mp3";
});

document.getElementById("pasteBtn").addEventListener("click", async () => {
  try { urlInput.value = await navigator.clipboard.readText(); statusEl.textContent = "Link pasted."; }
  catch { statusEl.textContent = "Clipboard access blocked — paste with Ctrl+V."; }
});

// PWA install button: use the native browser prompt when available, with
// clear manual-install instructions for Safari and unsupported browsers.
const installAppBtn = document.getElementById("installAppBtn");
const installHelp = document.getElementById("installHelp");
let deferredInstallPrompt = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function showInstallHelp(message) {
  installHelp.textContent = message;
  installHelp.hidden = false;
}

if (isStandalone) {
  installAppBtn.textContent = "✓ SONI APP INSTALLED";
  installAppBtn.disabled = true;
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installAppBtn.textContent = "✓ SONI APP INSTALLED";
  installAppBtn.disabled = true;
  installHelp.hidden = true;
});

installAppBtn.addEventListener("click", async () => {
  if (isStandalone) return;

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice?.outcome === "accepted") {
      installAppBtn.textContent = "✓ SONI APP INSTALLED";
      installAppBtn.disabled = true;
      installHelp.hidden = true;
    } else {
      showInstallHelp("No worries — you can install SONI later from your browser's install option.");
    }
    return;
  }

  if (isIOS) {
    showInstallHelp('On iPhone/iPad: tap the Share button in Safari, then choose “Add to Home Screen”.');
  } else {
    showInstallHelp('In Chrome or Edge: open the browser menu (⋮), then choose “Install SONI Downloader” or “Install page as app”.');
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(error => {
      console.warn("[SONI PWA] Service worker registration failed:", error);
    });
  });
}

// The final download button returns the interface to its ready state.
copyTitleBtn.addEventListener("click", async () => {
  if (!completedVideoTitle) return;
  try {
    await navigator.clipboard.writeText(completedVideoTitle);
    copyTitleBtn.textContent = "✓ TITLE COPIED";
  } catch {
    const field = document.createElement("textarea");
    field.value = completedVideoTitle;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    copyTitleBtn.textContent = copied ? "✓ TITLE COPIED" : "COPY FAILED";
  }
  setTimeout(() => { copyTitleBtn.textContent = "▢ COPY CAPTION"; }, 1800);
});

saveLink.addEventListener("click", () => {
  saveLink.hidden = true;
  downloadBtn.hidden = false;
  downloadBtn.disabled = false;
});

downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) { statusEl.textContent = "Paste a video link first."; urlInput.focus(); return; }

  downloadBtn.disabled = true;
  saveLink.hidden = true;
  copyTitleBtn.hidden = true;
  completedVideoTitle = "";
  copyTitleBtn.textContent = "▢ COPY CAPTION";
  progressEl.style.width = "0%";
  statusEl.textContent = "Starting download...";
  transferPanel.hidden = false;
  transferEmpty.hidden = false;
  transferDetails.hidden = true;
  transferEmpty.textContent = "Connecting to the source…";

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, type: typeSelect.value, quality: qualitySelect.value})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start download.");

    const jobId = data.job_id;
    const poll = async () => {
      try {
        const res = await fetch(`/api/status/${jobId}`);
        const job = await res.json();
        statusEl.textContent = job.message || "Working...";
        updateTransfer(job);
        if (job.progress !== null && job.progress !== undefined) {
          progressEl.style.width = `${job.progress}%`;
        }

        if (job.status === "done") {
          progressEl.style.width = "100%";
          completedVideoTitle = (job.title || "").trim();
          copyTitleBtn.hidden = !completedVideoTitle;
          saveLink.href = `/api/file/${jobId}`;
          saveLink.textContent = "↓ DOWNLOAD";
          saveLink.hidden = false;
          downloadBtn.hidden = true;
          return;
        }
        if (job.status === "error") {
          downloadBtn.disabled = false;
          return;
        }
        setTimeout(poll, 900);
      } catch (err) {
        statusEl.textContent = err.message || "Couldn't check download status.";
        downloadBtn.disabled = false;
      }
    };
    poll();
  } catch (err) {
    statusEl.textContent = err.message;
    downloadBtn.disabled = false;
  }
});