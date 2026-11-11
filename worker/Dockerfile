# Lecture reel render worker (a Railway service with root directory worker/). See run.mjs.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 ca-certificates curl \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp (python zipapp); YouTube's player needs a JS runtime, so it uses node (--js-runtimes in run.mjs)
RUN curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp && chmod +x /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx hyperframes browser ensure
COPY . .
ENV HYPERFRAMES="npx hyperframes"
CMD ["node", "run.mjs"]
