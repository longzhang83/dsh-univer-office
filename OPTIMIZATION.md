# Optimization Branch Notes

Branch: `optimize/p0-p1` (baseline: `dream-num/dsh-univer-office@8f85ce4`)

Three independently reviewed changes, merged from `opt/render-cache`, `opt/merge-guard`, `opt/worker-pool`. 19 files changed, +1577 / −67. All changed TypeScript files pass esbuild syntax validation.

## 1. Render artifact cache (P0, `fdcc8b1`)

`src/host/provider/render-cache.ts` (new) + wiring in `gateway-univer-service.ts`, `render-source-operations.ts`, `config.ts`.

- Key = stable JSON (file identity, unitId, worktreeId, artifact kind, all output params) + **head revisions of the primary Unit and every render dependency**, hashed with SHA-256. Any content change advances a head revision → automatic miss. If any revision is unavailable, caching is skipped entirely.
- Artifacts stored under `$DSH_HOME/cache/dsh-univer-office/render` (configurable `renderCacheRoot`), never in user workspace; authorization (`assertAuthorizedPath`) still runs on every hit.
- Bounded: LRU `renderCacheMaxEntries: 32`, `renderCacheTtlMs: 300000`, `renderCache: true` (can be disabled). Same-key concurrent requests are deduplicated (in-flight promise merge). Failures are never cached; any cache error degrades to a normal render.

## 2. Post-merge semantic checks (P0, `c85bd71`)

`src/host/provider/merge-semantic-checks.ts` (new) + wiring in `gateway-univer-service.ts`, `webServer`/tools results, Gateway preview response (`semanticChecks` field, backward compatible).

- Report-only: never blocks or changes merge results. Checks run against merged trunk, scoped to the merged Units only.
- Real checks: structure (reuses the `univer_inspect` read path), layout lint for Slides (reuses `univer_lint`). Explicitly reported `unavailable`: formula evaluation (requires the Viewer-side engine) — not faked.
- One shared deadline (`mergeSemanticChecksTimeoutMs: 20000`), fully degradable, `mergeSemanticChecks: true` can be turned off.

## 3. Unit Content Worker pool (P1, `dfa1558`)

`src/host/adapters/unit-content/worker-pool.ts` (new) + `workers/unit-content/entry.ts` request loop + `config.ts`.

- Bounded pool (`unitContentWorkerPoolSize: 2`), prewarmed after Gateway readiness, idle recycle after 60s, hard rebuild after 20 tasks per worker, `unitContentWorkerPool: false` restores one-shot mode.
- Reuse safety is conservative: the child protocol had no reset primitive, so each request still owns its full task lifecycle; isolation relies on the request boundary + task cap + idle recycle, not on assuming in-process state can be zeroed.
- Cancel/timeout/crash/protocol error always destroys the worker (never returned to pool) and spawns a replacement. `dispose()` on the Cordis effect tears down all workers (SIGTERM → 3s → SIGKILL).

## Verification status

- ✅ esbuild syntax validation on all 16 changed TS files
- ✅ Manual review of cache-key invalidation, degrade paths, dispose ordering, cancel paths
- ⚠️ Not run: `pnpm typecheck` / build / integration tests (requires full dependency install incl. native bindings; not available in this environment)

## Deferred (documented, not implemented)

- Snapshot checkpointing for long changeset chains (needs Gateway storage layer work)
- Paged/lazy merge-preview materialization (needs Gateway HTTP contract extension)
- Layered (Unit→page→cell) diff; CPU-heavy tasks off the Gateway event loop; SQLite payload compression + WAL; WS push instead of polling — all multi-session/large-file optimizations, lower priority
- Formula-aware merge checks (blocked on upstream SDK capability)

## Pushing to your own fork

```sh
cd dsh-univer-office
gh repo fork dream-num/dsh-univer-office --clone=false
git remote add fork https://github.com/<you>/dsh-univer-office.git
git push fork optimize/p0-p1
```
