const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const ROOT = __dirname;
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const PYTHON = process.env.PYTHON_BIN || path.join(ROOT, ".venv", "bin", "python");
const YTDLP = [ "-m", "yt_dlp" ];
const BGUTIL_DIR = path.join(ROOT, "bgutil-ytdlp-pot-provider", "server");
const BGUTIL_ENTRY = path.join(BGUTIL_DIR, "build", "main.js");
const NODE = process.execPath;
const PORT = Number(process.env.PORT || 10000);
const jobs = new Map();
let bgutilProcess = null;
let bgutilStarting = null;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(path.join(ROOT, "static")));

const allowedHosts = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
  "instagram.com", "www.instagram.com",
  "tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
  "facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch",
  "x.com", "www.x.com", "twitter.com", "www.twitter.com"
]);

function validUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

async function ensureBgutil() {
  if (!fs.existsSync(BGUTIL_ENTRY)) throw new Error("BGUtil HTTP provider build is missing.");
  if (bgutilStarting) return bgutilStarting;

  bgutilStarting = (async () => {
    try {
      const response = await fetch("http://127.0.0.1:4416/ping", { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
    } catch {}

    if (!bgutilProcess || bgutilProcess.exitCode !== null) {
      bgutilProcess = spawn(NODE, [BGUTIL_ENTRY, "--host", "127.0.0.1", "--port", "4416"], {
        cwd: BGUTIL_DIR,
        stdio: ["ignore", "pipe", "pipe"]
      });
      bgutilProcess.stdout.on("data", chunk => console.log("[BGUtil]", chunk.toString().trim()));
      bgutilProcess.stderr.on("data", chunk => console.error("[BGUtil]", chunk.toString().trim()));
      bgutilProcess.on("error", error => {
        console.error("BGUtil process failed to launch:", error);
        bgutilProcess = null;
      });
      bgutilProcess.on("exit", code => {
        console.error("BGUtil provider exited:", code);
        bgutilProcess = null;
      });
    }

    for (let attempt = 0; attempt < 30; attempt++) {
      if (bgutilProcess && bgutilProcess.exitCode !== null) throw new Error("BGUtil provider exited during startup.");
      try {
        const response = await fetch("http://127.0.0.1:4416/ping", { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("BGUtil provider did not become ready on port 4416.");
  })();

  try {
    await bgutilStarting;
  } finally {
    bgutilStarting = null;
  }
}

function runDownload(id, url, type, quality) {
  updateJob(id, { status: "downloading", message: "Connecting to the source..." });

  const formats = {
    best: "best[ext=mp4]/best",
    "1080": "best[height<=1080][ext=mp4]/best[height<=1080]/best",
    "720": "best[height<=720][ext=mp4]/best[height<=720]/best",
    "480": "best[height<=480][ext=mp4]/best[height<=480]/best"
  };

  const args = [
    ...YTDLP,
    "--no-playlist",
    "--newline",
    "--progress",
    "--restrict-filenames",
    "--no-warnings",
    "--progress-delta", "1",
    "--format", type === "mp3" ? "bestaudio/best" : formats[quality],
    "--output", path.join(DOWNLOAD_DIR, "%(title).150B-%(id)s.%(ext)s"),
    "--print", "after_move:filepath"
  ];

  if (type === "mp3") args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K");
  else args.push("--merge-output-format", "mp4");

  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416");
    args.push("--extractor-args", "youtube:player-client=mweb,tv,web_safari");
    args.push("--verbose");
  }

  args.push(url);

  let output = "";
  let errorOutput = "";
  let finalPath = "";

  const child = spawn(PYTHON, args, { cwd: ROOT, env: process.env });
  child.stdout.on("data", chunk => {
    const text = chunk.toString();
    output += text;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (match) updateJob(id, { progress: Math.min(99, Math.round(Number(match[1]))), message: "Downloading..." });
      if (line.trim() && fs.existsSync(line.trim())) finalPath = line.trim();
    }
  });
  child.stderr.on("data", chunk => {
    const text = chunk.toString();
    errorOutput += text;
    console.error("[yt-dlp]", text.trim());
    if (/merging|converting|fixing/i.test(text)) updateJob(id, { message: "Processing file..." });
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) updateJob(id, { progress: Math.min(99, Math.round(Number(match[1]))), message: "Downloading..." });
  });

  child.on("error", error => updateJob(id, { status: "error", message: error.message.slice(0, 500) }));
  child.on("close", code => {
    if (code !== 0) {
      const combined = errorOutput + "\n" + output;
      const useful = combined.split("\n").filter(line => /ERROR:|WARNING:/.test(line)).slice(-4).join(" ");
      updateJob(id, { status: "error", message: (useful || "Download failed. Check server logs.").slice(0, 500) });
      return;
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      updateJob(id, { status: "error", message: "Download completed but the output file could not be located." });
      return;
    }
    updateJob(id, {
      status: "done",
      message: "Ready! Your file is saved.",
      filename: path.basename(finalPath),
      path: finalPath,
      progress: 100
    });
  });
}

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "templates", "index.html")));

app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const type = req.body?.type || "mp4";
  const quality = req.body?.quality || "best";

  if (!validUrl(url)) return res.status(400).json({ error: "Please enter a supported YouTube, Instagram, TikTok, Facebook or X URL." });
  if (!["mp4", "mp3"].includes(type)) return res.status(400).json({ error: "Choose MP4 or MP3." });
  if (!["best", "1080", "720", "480"].includes(quality)) return res.status(400).json({ error: "Choose a valid quality." });

  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, { status: "queued", message: "Starting...", progress: 0, filename: null, path: null });

  res.json({ job_id: id });
  try {
    if (url.includes("youtube.com") || url.includes("youtu.be")) await ensureBgutil();
    runDownload(id, url, type, quality);
  } catch (error) {
    updateJob(id, { status: "error", message: error.message.slice(0, 500) });
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download job not found." });
  const { path: _privatePath, ...publicJob } = job;
  res.json(publicJob);
});

app.get("/api/file/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.path || !fs.existsSync(job.path)) {
    return res.status(404).json({ error: "File is not ready." });
  }
  res.download(job.path, job.filename);
});

app.listen(PORT, "0.0.0.0", () => console.log(`SONI DOWNLOADER (Node.js) listening on ${PORT}`));
