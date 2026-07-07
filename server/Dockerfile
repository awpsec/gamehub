# --- build stage -------------------------------------------------------------
# Slim images have no compiler toolchain. better-sqlite3 ships prebuilt binaries,
# but if one can't be fetched for this platform it falls back to compiling from
# source with node-gyp — which needs python3 + make + g++. Install them here so
# the build is reliable either way, then hand the built node_modules to a clean
# slim runtime image (the toolchain never ships in the final image).
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8686
CMD ["node", "src/index.js"]
