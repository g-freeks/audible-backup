FROM node:24-bookworm-slim

# ffmpeg is the only external tool left: the Audible client is TypeScript,
# so the image needs no Python and no audible-cli.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

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
