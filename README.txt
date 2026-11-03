# SONI DOWNLOADER

A local-only Flask app for downloading media that you own or have permission to save.

## Requirements
- Windows 10/11
- Python 3.10 or newer
- FFmpeg (needed for merging separate video/audio streams and MP3 conversion)

## Install
1. Install Python from https://www.python.org/downloads/ (enable "Add Python to PATH").
2. Install FFmpeg and make sure `ffmpeg` and `ffprobe` are available in PATH.
3. Open this folder in File Explorer.
4. Double-click `start_windows.bat`.

The first launch creates a virtual environment and installs Python packages. It needs an internet connection for installation.

Then open http://127.0.0.1:5000 in your browser.

Downloaded files are saved in this project's `downloads` folder.

## Manual start
```powershell
py -m venv .venv
.venv\Scripts\activate
py -m pip install -r requirements.txt
py app.py
```

## Notes
- This app binds to 127.0.0.1, so it is available only on your own PC.
- Supported sites and formats can change; keep yt-dlp updated with:
  `py -m pip install -U yt-dlp`
- Use only for content you own, have permission to download, or that the platform makes available for download. Respect platform terms, copyright, privacy, and applicable law.
- It does not bypass DRM, private-account restrictions, login walls, or other access controls.
- Some sites may block automated access or require official download features instead.


## Deploy publicly on Render (free tier)
1. Push this folder to a GitHub repository.
2. In Render, choose New > Web Service and connect that repository.
3. Select the Docker runtime (Render detects the included Dockerfile).
4. Choose the Free instance plan and deploy.
5. Render will provide an https://*.onrender.com address.

Important: Render free services sleep after inactivity and have ephemeral storage.
Files and in-memory jobs can disappear when the service restarts or redeploys.
This is a hobby/demo deployment, not reliable permanent file hosting.
