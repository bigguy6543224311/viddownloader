FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir "yt-dlp==2026.10.26"

RUN git clone --depth 1 --single-branch --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /app/bgutil-ytdlp-pot-provider \
    && cd /app/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

COPY . .
RUN mkdir -p /app/downloads

EXPOSE 10000
CMD ["npm", "start"]
