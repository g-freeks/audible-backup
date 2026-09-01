FROM node:24-bookworm-slim

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

# Stamp the build so Settings can show which image is running.
ARG BUILD_COMMIT=""
RUN printf '{"build":"%s","commit":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BUILD_COMMIT" > build-info.json

EXPOSE 3000

CMD ["node", "server.ts"]
