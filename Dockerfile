# Dev image for the backend.
FROM node:22-bookworm-slim

# better-sqlite3 is a native module — needs a toolchain to compile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install from manifests only so this layer caches until deps change.
# Source arrives via bind mount at runtime.
COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 4000
CMD ["npm", "run", "dev"]
