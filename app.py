from pathlib import Path
from urllib.parse import urlparse
import re
import threading
import uuid

from flask import Flask, render_template, request, jsonify, send_file
import yt_dlp

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com",
    "tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
    "facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch",
    "x.com", "www.x.com", "twitter.com", "www.twitter.com"
}

jobs = {}
jobs_lock = threading.Lock()

# Keep one BGUtil HTTP provider alive instead of spawning a slow Node script
# for every YouTube token request.
bgutil_process = None
bgutil_lock = threading.Lock()


def ensure_bgutil_http_provider():
    global bgutil_process

    server_dir = BASE_DIR / "bgutil-ytdlp-pot-provider" / "server"
    node_path = BASE_DIR / ".node" / "node-v22.23.4-linux-x64" / "bin" / "node"
    entrypoint = server_dir / "build" / "main.js"

    if not entrypoint.exists() or not node_path.exists():
        raise RuntimeError("The BGUtil HTTP provider or Node.js runtime is missing.")

    with bgutil_lock:
        # Reuse an already-running provider if possible.
        try:
            from urllib.request import urlopen
            with urlopen("http://127.0.0.1:4416/ping", timeout=2):
                return
        except Exception:
            pass

        if bgutil_process is None or bgutil_process.poll() is not None:
            import subprocess
            bgutil_process = subprocess.Popen(
                [str(node_path), str(entrypoint)],
                cwd=str(server_dir),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )

        # Give the local provider a few seconds to bind its port.
        import time
        for _ in range(20):
            if bgutil_process.poll() is not None:
                raise RuntimeError("The BGUtil HTTP provider stopped during startup.")
            try:
                from urllib.request import urlopen
                with urlopen("http://127.0.0.1:4416/ping", timeout=1):
                    return
            except Exception:
                time.sleep(0.5)

        raise RuntimeError("The BGUtil HTTP provider did not start on port 4416.")


def valid_url(value):
    try:
        parsed = urlparse(value.strip())
        host = (parsed.hostname or "").lower()
        return parsed.scheme in ("http", "https") and host in ALLOWED_HOSTS
    except Exception:
        return False


def clean_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    return name[:150] or "video"


def run_download(job_id, url, media_type, quality):
    with jobs_lock:
        jobs[job_id]["status"] = "downloading"
        jobs[job_id]["message"] = "Connecting to the source..."

    def hook(data):
        with jobs_lock:
            job = jobs[job_id]
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                done = data.get("downloaded_bytes") or 0
                job["progress"] = round(done * 100 / total) if total else None
                job["downloaded_bytes"] = done
                job["total_bytes"] = total or None
                job["speed"] = data.get("speed")
                job["eta"] = data.get("eta")
                job["message"] = "Downloading..."
            elif data.get("status") == "finished":
                job["progress"] = 100
                job["message"] = "Processing file..."

    format_map = {
        "best": "best[ext=mp4]/best",
        "1080": "best[height<=1080][ext=mp4]/best[height<=1080]/best",
        "720": "best[height<=720][ext=mp4]/best[height<=720]/best",
        "480": "best[height<=480][ext=mp4]/best[height<=480]/best",
    }

    options = {
        "outtmpl": str(DOWNLOAD_DIR / "%(title).150B-%(id)s.%(ext)s"),
        "noplaylist": True,
        "restrictfilenames": True,
        "quiet": False,
        "verbose": True,
        "no_warnings": False,
        "progress_hooks": [hook],
        "overwrites": True,
        "format": format_map.get(quality, format_map["best"]),
        "merge_output_format": "mp4",

        # BGUtil HTTP provider is started once and reused for PO token requests.
        "extractor_args": {
            "youtubepot-bgutilhttp": {
                "base_url": ["http://127.0.0.1:4416"]
            }
        },
    }

    if media_type == "mp3":
        options["format"] = "bestaudio/best"
        options["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]

    try:
        ensure_bgutil_http_provider()
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info))

            if media_type == "mp3":
                filename = filename.with_suffix(".mp3")
            elif not filename.exists():
                possible = list(DOWNLOAD_DIR.glob(f"*{info.get('id', '')}*"))
                if possible:
                    filename = possible[0]

        if not filename.exists():
            raise FileNotFoundError("The processed file could not be found.")

        with jobs_lock:
            jobs[job_id].update({
                "status": "done",
                "message": "Ready! Your file is saved in the downloads folder.",
                "filename": filename.name,
                "title": info.get("title") or filename.stem,
                "path": str(filename),
                "progress": 100,
                "speed": 0,
                "eta": 0,
            })

    except Exception as exc:
        with jobs_lock:
            jobs[job_id].update({
                "status": "error",
                "message": str(exc)[:500],
            })


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    media_type = data.get("type", "mp4")
    quality = data.get("quality", "best")

    if not valid_url(url):
        return jsonify(
            error="Please enter a supported YouTube, Instagram, TikTok, Facebook or X URL."
        ), 400

    if media_type not in ("mp4", "mp3"):
        return jsonify(error="Choose MP4 or MP3."), 400

    if quality not in ("best", "1080", "720", "480"):
        return jsonify(error="Choose a valid quality."), 400

    job_id = uuid.uuid4().hex[:12]

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "message": "Starting...",
            "progress": 0,
            "filename": None,
            "title": None,
            "downloaded_bytes": 0,
            "total_bytes": None,
            "speed": None,
            "eta": None,
            "path": None
        }

    thread = threading.Thread(
        target=run_download,
        args=(job_id, url, media_type, quality),
        daemon=True
    )
    thread.start()

    return jsonify(job_id=job_id)


@app.route("/api/status/<job_id>")
def download_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)

        if not job:
            return jsonify(error="Download job not found."), 404

        return jsonify({k: v for k, v in job.items() if k != "path"})


@app.route("/api/file/<job_id>")
def get_file(job_id):
    with jobs_lock:
        job = jobs.get(job_id)

        if not job or job.get("status") != "done" or not job.get("path"):
            return jsonify(error="File is not ready."), 404

        path = job["path"]

    return send_file(
        path,
        as_attachment=True,
        download_name=Path(path).name
    )


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "5000"))
    print(f"\nSONI DOWNLOADER is running on port {port}\n")
    app.run(host="0.0.0.0", port=port, debug=False)
