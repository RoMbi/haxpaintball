# syntax=docker/dockerfile:1

# Build stage installs production deps and packs only the files the game needs to run.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends zip unzip rsync \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/haxpaintball

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY client ./client
COPY server ./server
COPY shared ./shared
COPY maps ./maps
COPY README.md ./

# Runtime image has no packer tools and no source checkout — only the built app.
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /opt/haxpaintball

COPY --from=build /opt/haxpaintball ./

EXPOSE 8080

USER node

CMD ["node", "server/index.js"]
