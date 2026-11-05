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
  installAppBtn.textContent = "✓ VIDEO DOWNLOADER INSTALLED";
  installAppBtn.disabled = true;
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installAppBtn.textContent = "✓ VIDEO DOWNLOADER INSTALLED";
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
      installAppBtn.textContent = "✓ VIDEO DOWNLOADER INSTALLED";
      installAppBtn.disabled = true;
      installHelp.hidden = true;
    } else {
      showInstallHelp("No worries — you can install Video Downloader later from your browser's install option.");
    }
    return;
  }

  if (isIOS) {
    showInstallHelp('On iPhone/iPad: tap the Share button in Safari, then choose “Add to Home Screen”.');
  } else {
    showInstallHelp('In Chrome or Edge: open the browser menu (⋮), then choose “Install Video Downloader” or “Install page as app”.');
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(error => {
      console.warn("[Video Downloader PWA] Service worker registration failed:", error);
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

saveLink.addEventListener("click", event => {
  event.preventDefault();
  const fileUrl = saveLink.href;
  const startedAt = Date.now();
  let lastLoaded = 0;
  let lastTime = startedAt;
  let currentSpeed = 0;

  transferPanel.hidden = false;
  transferEmpty.hidden = true;
  transferDetails.hidden = false;
  transferName.textContent = completedVideoTitle || "Your download";
  transferState.textContent = "Saving to your device…";
  transferPercent.textContent = "0%";
  transferBar.style.width = "0%";
  transferBar.classList.remove("transfer-error");
  transferSpeed.textContent = "Starting…";
  transferEta.textContent = "";

  saveLink.textContent = "PREPARING…";
  saveLink.style.pointerEvents = "none";

  const xhr = new XMLHttpRequest();
  xhr.open("GET", fileUrl);
  xhr.responseType = "blob";

  xhr.onprogress = progress => {
    const now = Date.now();
    const elapsed = (now - lastTime) / 1000;
    if (elapsed > 0) currentSpeed = (progress.loaded - lastLoaded) / elapsed;
    lastLoaded = progress.loaded;
    lastTime = now;

    const total = progress.lengthComputable ? progress.total : 0;
    const pct = total ? Math.min(100, Math.round(progress.loaded * 100 / total)) : 0;
    transferPercent.textContent = total ? pct + "%" : formatBytes(progress.loaded) + " received";
    transferBar.style.width = pct + "%";
    transferSpeed.textContent = formatBytes(currentSpeed);
    transferEta.textContent = total && currentSpeed > 0
      ? formatEta((total - progress.loaded) / currentSpeed)
      : "";
  };

  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      transferState.textContent = "Download failed";
      transferEmpty.hidden = false;
      transferEmpty.textContent = "Couldn't download the file to your device.";
      transferDetails.hidden = true;
      saveLink.textContent = "↓ DOWNLOAD";
      saveLink.style.pointerEvents = "";
      return;
    }

    const disposition = xhr.getResponseHeader("Content-Disposition") || "";
    const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
    const filename = match
      ? decodeURIComponent(match[1] || match[2])
      : "video-download";
    const objectUrl = URL.createObjectURL(xhr.response);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    transferState.textContent = "Complete — saved to your device";
    transferPercent.textContent = "100%";
    transferBar.style.width = "100%";
    transferSpeed.textContent = "Complete";
    transferEta.textContent = "";
    saveLink.textContent = "↓ DOWNLOAD AGAIN";
    saveLink.style.pointerEvents = "";
  };

  xhr.onerror = () => {
    transferState.textContent = "Download failed";
    transferEmpty.hidden = false;
    transferEmpty.textContent = "Network error while saving the file.";
    transferDetails.hidden = true;
    saveLink.textContent = "↓ DOWNLOAD";
    saveLink.style.pointerEvents = "";
  };

  xhr.send();
});

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host);
  } catch { return false; }
}

downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) { statusEl.textContent = "Paste a video link first."; urlInput.focus(); return; }

  // All downloads run through the cloud server. Never route requests to localhost.
  const apiBase = "";

  downloadBtn.disabled = true;
  saveLink.hidden = true;
  copyTitleBtn.hidden = true;
  completedVideoTitle = "";
  copyTitleBtn.textContent = "▢ COPY CAPTION";
  progressEl.style.width = "0%";
  statusEl.textContent = "Starting cloud download...";

  try {
    const response = await fetch(apiBase + "/api/download", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, type: typeSelect.value, quality: qualitySelect.value})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start download.");

    const jobId = data.job_id;
    const poll = async () => {
      try {
        const res = await fetch(`${apiBase}/api/status/${jobId}`);
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
          saveLink.href = `${apiBase}/api/file/${jobId}`;
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
    statusEl.textContent = err.message || "Could not start cloud download.";
    downloadBtn.disabled = false;
  }
});