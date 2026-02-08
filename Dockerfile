FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      python3-venv && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/audible-venv && \
    /opt/audible-venv/bin/pip install --no-cache-dir audible-cli
ENV PATH="/opt/audible-venv/bin:$PATH"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "--experimental-sqlite", "server.ts"]
