FROM node:20-bookworm-slim
WORKDIR /app
# copy the lockfile too and use `npm ci` for reproducible, deterministic builds
# (better-sqlite3 is rebuilt from its prebuilt binary inside the Linux image)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8686
CMD ["node", "src/index.js"]
