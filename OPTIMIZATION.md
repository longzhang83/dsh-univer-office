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
- ✅ **Behaviour tests for the three new files (51 assertions-level tests, 51 pass / 0 fail)**
- ⚠️ Not run: `pnpm typecheck` / build / integration tests (requires full dependency install incl. native bindings; not available in this environment)

### Behaviour tests

Run from the repository root (no dependencies, `node:test` only):

```sh
node --experimental-transform-types --test test/render-cache-smoke.mjs
node --experimental-transform-types --test test/merge-semantic-checks-smoke.mjs
node --experimental-transform-types --test test/worker-pool-smoke.mjs
# all three in one run: 51 tests, 51 pass, 0 fail (stable over repeated runs)
node --experimental-transform-types --test test/render-cache-smoke.mjs test/merge-semantic-checks-smoke.mjs test/worker-pool-smoke.mjs
```

`--experimental-transform-types` (not plain `--experimental-strip-types`) is
required: the sources use TypeScript parameter properties
(`constructor(private readonly x: string)`), which strip-only mode rejects.

The sources are loaded as real `.ts` through a loader hook
(`test/helpers/`) that resolves every *external* package
(`@deepseek-ai/*`, `@univer-cli/*`, …) to a generated stub, because this
worktree has no `node_modules`. Nothing inside the modules under test is
patched; only their unavailable dependencies are.

| File | Tests | Behaviours pinned |
| --- | --- | --- |
| `test/render-cache-smoke.mjs` | 20 | key changes on head/dependency revision, target, `maxPages`, `maxPixels`, worktree, kind, file, Unit; key stability under key reordering; hit/miss round-trip (PNG + PDF payloads byte-identical); revision move forces a miss while the old key stays cached; LRU eviction at the cap (entry dropped from disk); TTL expiry; concurrent same-key callers coalesce into one render (`hit: false` + `hit: true`); failed render is not cached and is retried; a follower re-renders when the leader it joined failed; unreadable/corrupt payload degrades to a fresh render; unwritable cache root still returns the artifact and never reports a hit; `clear()`; `assertCachedImageName` rejects escaping names |
| `test/merge-semantic-checks-smoke.mjs` | 16 | structural pass; inspection failure → `warn`; worker-transport failure → `error`; synchronous throw and non-Error rejection both swallowed; shared deadline settles near `timeoutMs` and aborts the in-flight read; Slide lint pass / `warn` with raw report / array report counted / uninterpretable report → `unavailable` (never a fake pass); lint failure keeps the structural entry; Sheet formula → `unavailable`; scope limited to the listed Units (per-Unit `unitId`, file, workspace, worktree, and no out-of-scope Unit); no `worktreeId` for trunk; empty Unit list is a no-op; one entry per Unit even when everything fails; `listMergedUnits` maps the Gateway worktree unit listing |
| `test/worker-pool-smoke.mjs` | 15 | warm worker reuse across tasks; rebuild at `maxTasksPerWorker`; live workers never exceed `size` and queued tasks reuse the worker; crash → `UNIT_CONTENT_WORKER_INVALID_RESPONSE`, worker not returned, child reaped, replacement spawned; protocol garbage → same, no reuse; worker-reported error → propagated, worker discarded; timeout → `UNIT_CONTENT_WORKER_TIMEOUT`, child killed, replaced; cancellation → `AbortError`, child killed, replaced; idle timeout recycles and kills; `dispose()` leaves no child process; queued tasks rejected on dispose; tasks rejected after dispose; `enabled: false` keeps prewarm/dispose no-ops (one-shot mode) while `enabled: true` prewarms and stops real workers; the one-shot `UnitContentWorker` still completes a task and exits |

### Still uncovered

- **Prewarmed workers are never handed out (implementation bug, not fixed here).** `UnitContentWorkerPool.prewarm()` only calls `track()`; the worker is added to `live` but never pushed to `idle`. After `prewarm()`, `run()` finds `idle` empty and `live.size === size`, so it queues in `waitForWorker()` forever (no timeout, no cancellation other than dispose/abort). Reproduced: `size: 1`, `prewarm()`, then `run()` never settles (`status()` → `{ live: 1, idle: 0, waiting: 1 }`). Not covered by a test because the assertion would hang; `prewarm()` is only tested together with `dispose()`. Suggested fix: `prewarm()` should push the tracked worker onto `idle` (and schedule its idle recycle).
- Real Univer child process: the pool is tested against `test/fixtures/fake-unit-content-worker.mjs` (same stdin/stdout JSON protocol) because the bundled `unit-content-worker.mjs` needs `pnpm build` + native bindings. Suggested integration test points: (1) run `size: 2` against the real bundled worker and assert one reused pid per worker; (2) a task that makes the real worker exit non-zero mid-request, asserting replacement; (3) 21st task on one worker asserting the rebuild at `maxTasksPerWorker: 20`; (4) leave the pool idle > `unitContentWorkerPoolIdleTimeoutMs` and assert the process exits.
- Cache wiring: `renderCacheKey` inputs are assembled by `gateway-univer-service.ts` / `render-source-operations.ts`. Suggested integration test: render a Sheet screenshot, edit through the Gateway (advancing the head revision), render again, and assert the produce path ran twice.
- Merge-check wiring: `semanticChecks` on the Gateway merge response and the Tools result. Suggested integration test: merge a worktree with a Sheet + Slide and assert one `structure` entry per Unit plus `unavailable` formula and a real `layout` verdict.
- PDF lint/print output verification (needs a real render machine).

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
