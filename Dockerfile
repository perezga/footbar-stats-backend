# Dev image for the backend workspace.
# Build context is the repo root (workspace deps are hoisted there), so paths
# below are relative to the monorepo root, not backend/.
FROM node:22-bookworm-slim

# better-sqlite3 is a native module — needs a toolchain to compile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the whole workspace from the manifests only, so this layer is cached
# until a package.json or the lockfile changes. Source arrives via bind mount.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install

EXPOSE 4000
CMD ["npm", "run", "dev", "-w", "backend"]
