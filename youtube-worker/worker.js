const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.WORKER_SHARED_TOKEN || "";
const PYTHON = process.env.PYTHON_BIN || "python";
const BGUTIL_ENTRY = "/opt/bgutil/server/build/main.js";
let bgutil = null;
let bgutilPromise = null;

function startBgutil() {
  if (bgutilPromise) return bgutilPromise;
  bgutilPromise = new Promise((resolve, reject) => {
    bgutil = spawn("node", [BGUTIL_ENTRY, "--host", "127.0.0.1", "--port", "4416"], {
      stdio: ["ignore", "inherit", "inherit"]
    });
    bgutil.once("error", reject);
    bgutil.once("spawn", () => resolve());
    bgutil.once("exit", code => {
      if (code !== 0 && code !== null) console.error("BGUtil exited:", code);
      bgutil = null;
      bgutilPromise = null;
    });
  });
  return bgutilPromise;
}

function validYouTubeUrl(value) {
  try {
    const u = new URL(value);
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(u.hostname.toLowerCase())
      && ["http:", "https:"].includes(u.protocol);
  } catch { return false; }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "soni-youtube-worker" }));

app.post("/download", async (req, res) => {
  const supplied = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || supplied.length !== TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { url, type = "mp4", quality = "best", cookies = "" } = req.body || {};
  if (!validYouTubeUrl(String(url || ""))) return res.status(400).json({ error: "A valid YouTube URL is required." });
  if (!["mp4", "mp3"].includes(type)) return res.status(400).json({ error: "Invalid media type." });
  const formats = {
    best: "best[ext=mp4]/best",
    "1080": "best[height<=1080][ext=mp4]/best[height<=1080]/best",
    "720": "best[height<=720][ext=mp4]/best[height<=720]/best",
    "480": "best[height<=480][ext=mp4]/best[height<=480]/best"
  };
  if (!Object.hasOwn(formats, quality)) return res.status(400).json({ error: "Invalid quality." });
  if (typeof cookies !== "string" || cookies.length > 1500000) return res.status(400).json({ error: "Invalid cookies payload." });
  if (cookies && (!cookies.includes("youtube.com") ||
      (!cookies.includes("# Netscape HTTP Cookie File") && !cookies.includes("# HTTP Cookie File")))) {
    return res.status(400).json({ error: "Cookies must be in Netscape format." });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soni-yt-"));
  const cookieFile = path.join(dir, "cookies.txt");
  const output = path.join(dir, "%(title).150B-%(id)s.%(ext)s");
  if (cookies) fs.writeFileSync(cookieFile, cookies, { mode: 0o600 });

  try {
    await startBgutil();
    const args = [
      "-m", "yt_dlp", "--no-playlist", "--no-warnings", "--restrict-filenames",
      "--js-runtimes", "node", "--remote-components", "ejs:github",
      "--format", type === "mp3" ? "bestaudio/best" : formats[quality],
      "--output", output,
      "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;youtube:player-client=mweb,web_safari",
      "--force-ipv4"
    ];
    if (type === "mp3") args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K");
    else args.push("--merge-output-format", "mp4");
    if (cookies) args.push("--cookies", cookieFile);
    args.push(String(url));

    const child = spawn(PYTHON, args, { cwd: dir, env: process.env });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      if (!res.headersSent) res.status(500).json({ error: error.message });
    });
    child.on("close", code => {
      if (code !== 0) {
        const useful = stderr.split("\n").filter(line => /ERROR:|WARNING:/.test(line)).slice(-5).join(" ");
        if (!res.headersSent) res.status(502).json({ error: (useful || "YouTube download failed.") .slice(0, 1200) });
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      const files = fs.readdirSync(dir).filter(name => name !== "cookies.txt");
      const filename = files.find(name => /\.(mp4|webm|mkv|mp3|m4a)$/i.test(name));
      if (!filename) {
        if (!res.headersSent) res.status(500).json({ error: "Download finished but output file was not found." });
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      res.download(path.join(dir, filename), filename, () => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: error.message.slice(0, 1200) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("SONI YouTube worker listening on", PORT));
