# Optimization Branch Notes

Branch: `optimize/p0-p1` (baseline: `dream-num/dsh-univer-office@8f85ce4`)

Nine independently reviewed changes, merged from `opt/render-cache`, `opt/merge-guard`, `opt/worker-pool`, `opt/gateway-perf`, `opt/verification-tests`, `opt/sqlite-perf`, `opt/ws-push`, `opt/diff-summary`. 46 files changed, +4300 / −350 approx. All changed TypeScript files (33) pass esbuild syntax validation, and 52 behaviour tests pass.

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

## 4. Gateway snapshot checkpoints (P1, `5e46a13`)

`src/gateway-app/snapshot-checkpoint.ts` (new) + wiring in `collab-service.ts`, `transport/http.ts`, `univerfile-sqlite/{index,database-adapters/collaboration-database-adapter}.ts`, contracts.

- **Threshold-triggered, not timer-triggered**: when a trunk materialization replays ≥32 changesets, the materialized snapshot is written back so the next materialization starts from the nearest checkpoint instead of revision 0.
- No new tables / component version bumps: `CURRENT_V3_TABLES` changes would break v3 detection and `pruneCandidateToUpportSchema`, so checkpoints land in the SDK's own `collaboration_snapshots`. Keeps last 4 per Unit + the revision-1 baseline; snapshots are derived data and can always be rebuilt by replay.
- Touches none of the `history@2` rows, so segment primary keys, `endRevision` derivation, migration, backup verification (`verifyV3Candidate`) and the optimize-time history reset are unaffected. Write failures are swallowed and never affect the read path.

## 5. Paged / on-demand merge preview (P1, `5e46a13`)

- `GET .../preview/units/<unitId>` gains optional `blocks=omit`, `blockOffset`, `blockLimit`, plus a `blockManifest`; a new `GET .../preview/units/<unitId>/blocks` serves block pages.
- Default responses keep every existing field and semantics unchanged (Viewer keeps its inline default).
- Materialized results are cached per `(worktree, unit, trunk head)` (cap 32), so paging never re-runs the rebase/replay.

## 6. Behaviour tests for 1–3 (`726a65b`)

Three `node:test` suites under `test/` with no new dependencies. Sources load through a loader hook that stubs only *external* packages (`test/helpers/`), because this worktree has no `node_modules`; the modules under test are imported unmodified.

## Verification status

- ✅ esbuild syntax validation on all changed TS files
- ✅ Manual review of cache-key invalidation, degrade paths, dispose ordering, cancel paths
- ✅ **52 behaviour tests, 52 pass / 0 fail** (`test/render-cache-smoke.mjs`, `test/merge-semantic-checks-smoke.mjs`, `test/worker-pool-smoke.mjs`), stable across repeated runs
- ✅ Fixed a real bug the tests exposed: `prewarm()` now parks workers in the idle queue via the shared `park()` path (previously prewarmed workers were live but never handed out, hanging the first `run()`)
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

## 7. SQLite WAL + payload compression (P2, `b6bb836`)

`univerfile-sqlite/payload-codec.ts` (new) + connection/read-write split across adapters.

- WAL confirmed supported by the libsql native binding; `PRAGMA journal_mode=WAL` failure silently keeps the legacy journal mode. Lazy read-only connection carries pure reads; writes keep their connection; dispose runs `wal_checkpoint(TRUNCATE)` after closing the read connection. Migration/verify/optimizer connections stay on the default journal so candidate files never carry `-wal`/`-shm` and the Windows helper-process replacement flow is untouched.
- Payload compression: changeset/snapshot payloads >4 KiB are stored gzip with a `univer-z1:` prefix; the read path detects the prefix and transparently decompresses. Old plaintext rows keep working (no migration); `payloadCompression` can be disabled. Compression happens outside the write transaction.

## 8. WS push with polling fallback (P2, `0f29f14`)

`src/client/api/univer-events.ts` (new) + `use-univer-state.ts` rework. Zero server-side changes: reuses Gateway lifecycle events through the existing `/univer-viewer/ws?target=` tunnel.

- Push frames are invalidation hints only; authoritative state always comes from the session-scoped `/univer-api/state` fetch, so cross-session injection is impossible. All channels ready → polling timer pauses; any channel missing → legacy 900 ms full polling as fallback; reconnect with exponential backoff (0.5→30 s, jittered) and a full refetch after each recovery.
- Known gap (documented, not fixed): changeset-only edits (agent writes without worktree lifecycle events) arrive on the next lifecycle event or reconnect; parity with today's polling which is bounded by the 1 s Host state cache anyway.

## 9. Comparison diff summary layer (P2, `449d80d`)

`GET .../comparisons/<cmpId>/diff/summary` + typed client method, on top of the pinned-head comparison sessions.

- Cheap Unit-level summary derived from pinned heads and the changeset stream **without materializing snapshots** (added/removed/unchanged/changed + changeset/mutation counts). Semantic block-level statistics honestly report `unavailable: requires-semantic-comparison`; the fine-grained `/diff` endpoint is unchanged and still used on demand.
- 2 s wall-clock budget with per-Unit deadline; budget-exceeded degrades gracefully; results cached per comparisonId with stale overlay on live head changes.

## Round 2 follow-ups

Three targeted follow-ups closing known leftovers from Round 1.

### F1. Asset fingerprints folded into the render-cache key

An in-place embedded-image replacement (same `assetId` slot, unchanged head revisions) could be served stale from the render cache within its TTL. Fix is a lightweight fingerprint, not per-file content re-hashing of stored assets:

- `RenderSourceOperations.load` wraps the asset resolver it already installs: every resolved asset records a SHA-256 of the **in-memory** bytes it hands to the renderer (`null` = resolved missing). Zero extra IO — the bytes were already fetched during assembly.
- `RenderCacheKeyInput.assets` (sorted `(source, digest | null)` pairs) is part of the key; `KEY_VERSION` bumped to 2 (old entries simply never match).
- Missing fingerprints (any asset lookup failed) disable caching, mirroring the missing-revisions policy; `renderCacheKeyFor` enforces this at both call sites (screenshot + PDF).
- 3 new tests in `test/render-cache-smoke.mjs`: key changes on in-place replacement, on asset appear/disappear without a revision move, and a behavioural cache miss on fingerprint change under identical revisions.

### F2. Payload compression extended to sheet_blocks

The `univer-z1:` gzip codec now also covers Sheet-block storage columns; read paths already probe the marker prefix, so old plaintext rows stay readable and nothing migrates:

- `collaboration-database-adapter.ts`: `createUnit` / `saveSnapshot` / `saveCheckpoint` block payloads (collaboration_sheet_blocks.payload_json) — was `encodePayloadJson`, now `encodeStoredPayload`.
- `worktree-database-adapter.ts`: `collaboration_worktree_unit_seeds.sheet_blocks_json` and `collaboration_worktree_unit_merge_artifacts.sheet_blocks_json` — same switch; the seed-equality retry path compares decoded objects, so it is compression-transparent.
- **Skipped on purpose**: asset blobs (`asset-store.ts`) and resource plugin payloads stay plain. Asset bytes are raw (typically already-compressed) image media — gzip adds CPU for no size win — and deduplication already happens through the content-addressed digest table. Rationale documented in `payload-codec.ts` and `asset-store.ts`.
- The optimizer (`univerfile-optimizer.ts`) already lists these columns as `generic` payloads and decodes via the marker prefix, so optimize round-trips compressed rows unchanged.

### F3. Changeset edits now push `unit_updated` (investigated, implemented)

Gap: Round 1 WS push reuses Gateway lifecycle events, but pure changeset submissions (Agent writes through the SDK collaboration service) emit none, so push-mode Clients refreshed only on the next lifecycle event or reconnect.

**Investigation**: the SDK `UniverCollabService` has no commit callback/event of its own, **but the persistence boundary is inside the Gateway**: trunk changesets are durably committed by the CLI-owned `UniverfileSQLiteDatabaseAdapter.commitChangeset` (worktree draft commits go through the worktree adapter and are covered by the merge/ready lifecycle events). No upstream SDK change is needed — the hook point is our own database adapter, so this was implemented rather than filed as an upstream requirement.

Implementation (small, additive):

- `UniverfileSQLiteDatabaseAdapter.setChangesetCommitListener(fn)`: fired outside the write transaction, only on `committed`, listener faults swallowed (best-effort, never fails the commit).
- `CollabService.attachEventHub(events)`: registers a **500 ms per-Unit debounce** (bursts merge into the newest head) and emits the existing `{ type: 'unit_updated', unitId, name, headRev }` contract event on the univerfile channel — identifiers only, no content. Deleted units inside the window are skipped.
- `UniverfileManager._open` performs the one-line wiring; no hub attached (e.g. standalone runtimes) → nothing emitted, polling fallback unaffected. Timers are cleared on `dispose`.

### Verification status (Round 2)

- ✅ esbuild syntax validation on all changed TS files (9 source + 1 test)
- ✅ **55 behaviour tests, 55 pass / 0 fail** (52 existing + 3 new asset-fingerprint cases), stable across runs
- ⚠️ Not run: `pnpm typecheck` / build / integration tests (unchanged environment constraint)

## Deferred (documented, not implemented)

- CPU-heavy tasks (diff/materialization) off the Gateway event loop via `worker_threads`
- SQLite payload compression (zstd) + WAL + read/write connection split
- WS push instead of Client polling (lower priority, UX-only)
- Formula-aware merge checks (blocked on upstream SDK capability)

## Pushing to your own fork

```sh
cd dsh-univer-office
gh repo fork dream-num/dsh-univer-office --clone=false
git remote add fork https://github.com/<you>/dsh-univer-office.git
git push fork optimize/p0-p1
```
