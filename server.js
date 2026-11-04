const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");

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
let syncedYouTubeCookiesPath = null;

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
    const pingUrl = "http://127.0.0.1:4416/ping";
    const checkPing = async () => {
      const response = await fetch(pingUrl, { signal: AbortSignal.timeout(2000) });
      const body = await response.text();
      console.log(`[BGUtil health] HTTP ${response.status}: ${body.slice(0, 300)}`);
      return response.ok;
    };

    try {
      if (await checkPing()) return;
    } catch (error) {
      console.log("[BGUtil health] Initial check:", error.message);
    }

    if (!bgutilProcess || bgutilProcess.exitCode !== null || bgutilProcess.killed) {
      const child = spawn(NODE, [BGUTIL_ENTRY, "--host", "127.0.0.1", "--port", "4416"], {
        cwd: BGUTIL_DIR,
        stdio: ["ignore", "pipe", "pipe"]
      });
      bgutilProcess = child;
      child.stdout.on("data", chunk => console.log("[BGUtil]", chunk.toString().trim()));
      child.stderr.on("data", chunk => console.error("[BGUtil]", chunk.toString().trim()));
      child.on("error", error => console.error("BGUtil process failed to launch:", error));
      child.on("exit", code => {
        console.error("BGUtil provider exited:", code);
        if (bgutilProcess === child) bgutilProcess = null;
      });
    }

    let lastPingError = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (bgutilProcess && bgutilProcess.exitCode !== null) {
        throw new Error("BGUtil provider exited during startup; check the [BGUtil] logs.");
      }
      try {
        if (await checkPing()) {
          console.log("[BGUtil health] Provider is ready.");
          return;
        }
        lastPingError = new Error("Health endpoint returned a non-2xx status.");
      } catch (error) {
        lastPingError = error;
        const cause = error.cause;
        if (attempt === 0 || attempt % 10 === 9 || attempt === 59) {
          console.error("[BGUtil health] Connection attempt", attempt + 1, "failed:", error.message,
            cause ? { code: cause.code, message: cause.message, address: cause.address, port: cause.port } : "");
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error("[BGUtil health] Final connection error:", lastPingError?.cause || lastPingError);
    throw new Error("BGUtil provider did not become reachable at 127.0.0.1:4416 within 30 seconds. See [BGUtil health] logs.");
  })();

  try {
    await bgutilStarting;
  } finally {
    bgutilStarting = null;
  }
}

function getYouTubeCookiesFile() {
  if (syncedYouTubeCookiesPath && fs.existsSync(syncedYouTubeCookiesPath)) return syncedYouTubeCookiesPath;
  const raw = process.env.YOUTUBE_COOKIES || "";
  const encoded = process.env.YOUTUBE_COOKIES_B64 || "";
  if (!raw && !encoded) return null;

  let cookieText = raw;
  if (encoded) {
    try {
      cookieText = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      throw new Error("YOUTUBE_COOKIES_B64 is not valid base64.");
    }
  }

  if (!cookieText.includes("youtube.com") || !cookieText.includes("# Netscape HTTP Cookie File") && !cookieText.includes("# HTTP Cookie File")) {
    throw new Error("YouTube cookies must be in Netscape cookie-file format. Re-export your cookies and update the Render secret.");
  }

  const cookiePath = path.join(os.tmpdir(), "soni-youtube-cookies.txt");
  fs.writeFileSync(cookiePath, cookieText, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(cookiePath, 0o600); } catch {}
  return cookiePath;
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
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "--format", type === "mp3" ? "bestaudio/best" : formats[quality],
    "--output", path.join(DOWNLOAD_DIR, "%(title).150B-%(id)s.%(ext)s"),
    "--print", "before_dl:%(title)s",
    "--print", "after_move:filepath"
  ];

  if (type === "mp3") args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K");
  else args.push("--merge-output-format", "mp4");

  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;youtube:player-client=mweb,tv,web_safari");
    try {
      const cookiesFile = getYouTubeCookiesFile();
      if (cookiesFile) {
        args.push("--cookies", cookiesFile);
        console.log("[yt-dlp] Using YouTube cookies from the Render environment secret.");
      } else {
        console.log("[yt-dlp] No YouTube cookies configured; continuing without account cookies.");
      }
    } catch (error) {
      updateJob(id, { status: "error", message: error.message.slice(0, 500) });
      return;
    }
    args.push("--verbose");
  }

  args.push(url);

  let output = "";
  let errorOutput = "";
  let finalPath = "";
  let videoTitle = "";

  const child = spawn(PYTHON, args, { cwd: ROOT, env: process.env });
  child.stdout.on("data", chunk => {
    const text = chunk.toString();
    output += text;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (match) updateJob(id, { progress: Math.min(99, Math.round(Number(match[1]))), message: "Downloading..." });
      if (line.trim() && fs.existsSync(line.trim())) finalPath = line.trim();
      else if (line.trim() && !videoTitle) { videoTitle = line.trim(); updateJob(id, { title: videoTitle }); }
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

app.post("/api/cookies", (req, res) => {
  const expected = process.env.COOKIE_SYNC_TOKEN || "";
  const supplied = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected) return res.status(503).json({ error: "Cookie sync is not configured on this server." });
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const cookieText = String(req.body?.cookies || "");
  if (cookieText.length > 1_500_000 ||
      !cookieText.includes("youtube.com") ||
      (!cookieText.includes("# Netscape HTTP Cookie File") && !cookieText.includes("# HTTP Cookie File"))) {
    return res.status(400).json({ error: "Invalid Netscape-format YouTube cookies." });
  }

  const cookiePath = path.join(os.tmpdir(), "soni-youtube-cookies-synced.txt");
  try {
    fs.writeFileSync(cookiePath, cookieText, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(cookiePath, 0o600); } catch {}
    syncedYouTubeCookiesPath = cookiePath;
    console.log("[cookie sync] Fresh YouTube cookies received from the authorized local helper.");
    return res.json({ ok: true, message: "YouTube cookies refreshed for this running server." });
  } catch (error) {
    console.error("[cookie sync] Could not save cookies:", error.message);
    return res.status(500).json({ error: "Could not save cookies on the server." });
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "templates", "index.html")));

app.get("/sw.js", (_req, res) => {
  res.set("Service-Worker-Allowed", "/");
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(ROOT, "static", "sw.js"));
});

app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const type = req.body?.type || "mp4";
  const quality = req.body?.quality || "best";

  if (!validUrl(url)) return res.status(400).json({ error: "Please enter a supported YouTube, Instagram, TikTok, Facebook or X URL." });
  if (!["mp4", "mp3"].includes(type)) return res.status(400).json({ error: "Choose MP4 or MP3." });
  if (!["best", "1080", "720", "480"].includes(quality)) return res.status(400).json({ error: "Choose a valid quality." });

  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, { status: "queued", message: "Starting...", progress: 0, filename: null, title: null, path: null });

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


async function diagnoseOutboundIp() {
  try {
    const response = await fetch("https://api.ipapi.is/", {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/json", "User-Agent": "SONI-DOWNLOADER/1.0" }
    });
    if (!response.ok) throw new Error(`IP diagnostic returned HTTP ${response.status}`);
    const info = await response.json();
    const company = info.company || {};
    const asn = info.asn || {};
    console.log("[IP diagnostic] Render outbound network:", JSON.stringify({
      ip: info.ip || null,
      asn: asn.asn || company.asn || null,
      organization: company.name || asn.org || null,
      is_datacenter: info.is_datacenter ?? null,
      is_proxy: info.is_proxy ?? null,
      is_vpn: info.is_vpn ?? null,
      is_tor: info.is_tor ?? null,
      is_abuser: info.is_abuser ?? null
    }));
    console.log("[IP diagnostic] These reputation signals do not confirm whether YouTube blocks this IP.");
  } catch (error) {
    console.warn("[IP diagnostic] Could not inspect outbound IP:", error.message);
  }
}

app.listen(PORT, "0.0.0.0", () => console.log(`SONI DOWNLOADER (Node.js) listening on ${PORT}`));

diagnoseOutboundIp();
