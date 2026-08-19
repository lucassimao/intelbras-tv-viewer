# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Only public browser settings are accepted as build arguments. The camera
# password and Faro source-map key are deliberately not build arguments.
ARG VITE_FARO_URL=
ARG VITE_FARO_APP_KEY=
ARG VITE_FARO_APP_NAME=intelbras-tv-viewer
ARG VITE_FARO_ENVIRONMENT=production
ARG VITE_APP_VERSION=0.0.0
ARG FARO_UPLOAD_NONCE=cache
ENV VITE_FARO_URL=$VITE_FARO_URL \
    VITE_FARO_APP_KEY=$VITE_FARO_APP_KEY \
    VITE_FARO_APP_NAME=$VITE_FARO_APP_NAME \
    VITE_FARO_ENVIRONMENT=$VITE_FARO_ENVIRONMENT \
    VITE_APP_VERSION=$VITE_APP_VERSION
RUN --mount=type=secret,id=faro_source_map_api_key,required=false \
  test -n "$FARO_UPLOAD_NONCE" && \
  if [ -s /run/secrets/faro_source_map_api_key ]; then \
    FARO_SOURCE_MAP_API_KEY="$(cat /run/secrets/faro_source_map_api_key)" pnpm build; \
  else \
    pnpm build; \
  fi \
  && find dist -type f -name '*.map' -delete

FROM node:24-bookworm-slim AS runtime

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production \
    PNPM_HOME=/pnpm
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/runtime /app/relay-config /pnpm \
  && chown -R node:node /app /pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/config ./src/config
COPY --from=build --chown=node:node /app/scripts/generate-mediamtx-config.mjs ./scripts/generate-mediamtx-config.mjs
COPY --from=build --chown=node:node /app/scripts/prepare-runtime.mjs ./scripts/prepare-runtime.mjs
COPY --from=build --chown=node:node /app/scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
COPY --from=build --chown=node:node /app/scripts/serve.mjs ./scripts/serve.mjs

USER node
EXPOSE 8080
CMD ["node", "scripts/container-entrypoint.mjs"]
