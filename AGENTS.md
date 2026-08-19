# Repository guide for coding agents

This is a local-first Intelbras camera viewer. `README.md` is the operator
guide; keep this file as a short map of invariants and workflows.

## Scope and layout

- Follow the user request first, then this file and existing conventions.
- Preserve unrelated working-tree changes; inspect `git status --short --branch`
  before edits and review the complete diff before Git operations.
- `src/` contains the React/Vite SPA, i18n, telemetry, and shared camera/profile
  JSON configuration (`src/config/camera-inventory.json` and
  `src/config/stream-profiles.json`, consumed through `src/config/cameras.ts`).
- `server/` is a loopback Hono API. `server/app.ts` is the dependency-injected
  app under test; `server/config.ts` owns validated server settings and camera
  credentials; repositories/services own names, PTZ, reliability, and snapshots.
  `server/index.ts` only wires production dependencies and lifecycle.
- `scripts/` contains dev/serve orchestration and the generator for the ignored
  credential-bearing `runtime/mediamtx.yml`.
- `vite.config.ts` conditionally enables Grafana's source-map uploader only for
  builds with the server/CI-only `FARO_SOURCE_MAP_API_KEY`.

## Runtime and security boundaries

- The SPA uses same-origin `/api`; the API defaults to `127.0.0.1:8787`.
  Keep API, SQLite, RTSP, MediaMTX control/metrics, and camera ports off LAN.
- Only HLS on `:8888` is intended for LAN clients. Never forward API, RTSP,
  control, metrics, or camera ports to the internet.
- Load variables with the existing `node --env-file-if-exists=.env` commands.
  `CAMERA_PASSWORD` is backend/generator-only: never put it in `VITE_*`,
  browser storage, URLs, logs, tests, source maps, or documentation.
- Grafana Faro URL/app key and app metadata are public client configuration.
  Faro is best effort; redact URL/IP/credential data and never add admin tokens
  or camera data to telemetry. Tracing must remain blocked from private bridge,
  HLS, camera, snapshot, PTZ, and reliability endpoints.
- `FARO_SOURCE_MAP_API_KEY` is never a `VITE_` variable. Keep it in ignored
  `.env` or CI secrets. Source maps are hidden from served JS and `.map` requests
  are blocked by the TV server.

## Product invariants

- Keep one live HLS `<video>` player. Camera/profile switches release the old
  source-on-demand path; HLS retries remain independent from telemetry.
- `pt-BR` is the default locale; user-visible strings belong in both locale
  files. Preserve TV remote, mobile, desktop, keyboard, and accessibility paths.
- The glance wall uses cached low-resolution snapshots and never creates a
  second live player. Snapshot failure must not stop live playback.
- Camera/profile changes flow from the shared JSON config; do not duplicate
  inventories or hard-code relay paths.

## Quality gates

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`pnpm check` runs format check, lint, typecheck, and deterministic Vitest.
The suite currently has 70 tests and uses jsdom/temporary SQLite; it does not
contact cameras or MediaMTX. Live HLS, TV, relay, and ffmpeg behavior require
an explicit integration check. Do not restart or reconfigure a running relay
for a docs-only task.

## Sources of truth

- Operator setup, controls, troubleshooting, architecture, Faro, and Mermaid:
  [`README.md`](README.md).
- Safe environment names/placeholders: [`.env.example`](.env.example).
- API proxy/server ports: [`vite.config.ts`](vite.config.ts) and
  [`scripts/serve.mjs`](scripts/serve.mjs).
- API behavior/config: [`server/app.ts`](server/app.ts),
  [`server/config.ts`](server/config.ts), and [`server/index.ts`](server/index.ts).
- Dependencies and commands: [`package.json`](package.json).
- GitHub renders Mermaid from fenced `mermaid` blocks.

## Git and runtime safety

- `.gitignore` must keep `.env`/`.env.*` ignored except `.env.example`, along
  with `runtime/`, SQLite files, `dist/`, sourcemaps/artifacts, snapshots, and
  local credential exports. Never stage these local outputs.
- Do not commit, push, deploy, delete runtime data, or alter production state
  unless the user explicitly requests that exact action.
- Keep documentation examples generic (`<BRIDGE_IP>`, invalid example hosts,
  and placeholders); never paste real camera or Grafana secrets.
