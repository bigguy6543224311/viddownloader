const urlInput = document.getElementById("url");
const typeSelect = document.getElementById("type");
const qualitySelect = document.getElementById("quality");
const qualityField = document.getElementById("qualityField");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const saveLink = document.getElementById("saveLink");

typeSelect.addEventListener("change", () => {
  qualityField.style.opacity = typeSelect.value === "mp3" ? ".4" : "1";
  qualitySelect.disabled = typeSelect.value === "mp3";
});

document.getElementById("pasteBtn").addEventListener("click", async () => {
  try { urlInput.value = await navigator.clipboard.readText(); statusEl.textContent = "Link pasted."; }
  catch { statusEl.textContent = "Clipboard access blocked — paste with Ctrl+V."; }
});

downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) { statusEl.textContent = "Paste a video link first."; urlInput.focus(); return; }

  downloadBtn.disabled = true;
  saveLink.hidden = true;
  progressEl.style.width = "0%";
  statusEl.textContent = "Starting download...";

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
      const res = await fetch(`/api/status/${jobId}`);
      const job = await res.json();
      statusEl.textContent = job.message || "Working...";
      if (job.progress !== null && job.progress !== undefined) progressEl.style.width = `${job.progress}%`;

      if (job.status === "done") {
        saveLink.href = `/api/file/${jobId}`;
        saveLink.textContent = `Save ${job.filename} to your PC ↓`;
        saveLink.hidden = false;
        downloadBtn.disabled = false;
        return;
      }
      if (job.status === "error") {
        downloadBtn.disabled = false;
        return;
      }
      setTimeout(poll, 900);
    };
    poll();
  } catch (err) {
    statusEl.textContent = err.message;
    downloadBtn.disabled = false;
  }
});
