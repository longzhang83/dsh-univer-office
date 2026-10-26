## Contribution offer: render cache, post-merge semantic checks, bounded worker pool — implemented & tested, requesting guidance on how to contribute

Hi — we've been running this plugin in heavy multi-turn agent workflows, prototyped three optimizations against `main` (`8f85ce4`), and now have a complete, tested branch we'd like to contribute back (`optimize/p0-p1`: 33 files, +3537/−109, 52 behaviour tests passing). Before pushing anything, we'd like to ask how you'd like to receive external contributions.

### The request

This repo resolves `@univerjs` / `@univerjs-pro` / `@univer-cli` from your insider registry (`insider-npm-registry.univer.work`), so external contributors cannot run `pnpm install --frozen-lockfile`, typecheck, or build locally — our branch has therefore been validated with dependency-stubbed behaviour tests only, never against the real SDK. Could you clarify which of these applies:

1. **Fork + PR is welcome** — we open a PR and your CI validates it (we'll fix anything it flags); or
2. **Contributor access to the insider registry** could be arranged so we can verify before submitting; or
3. **Add `@longzhang83` as a collaborator** (preferred, if you review external work this way); or
4. The repo does not accept external contributions for now — in that case we'll keep the branch available on request and would still appreciate your thoughts on the designs below.

### What we implemented (all behind config flags, all backward compatible)

**1. Revision-keyed render artifact cache** — `univer_screenshot` / `univer_print_pdf` currently re-assemble the render source and re-render in Chromium on every call. Key = stable JSON (file, unitId, worktreeId, artifact kind, output params) + **head revisions of the primary Unit and every render dependency**; any content change advances a revision → automatic miss; missing revisions disable caching entirely. Artifacts live under `$DSH_HOME/cache/…` (never in the user workspace), authorization still runs per hit; bounded LRU (32) + TTL (5 min) + same-key in-flight dedup; every cache error degrades to a normal render. *Known unsolved trade-off: embedded image assets don't advance head revisions, so an in-place asset swap inside the TTL can serve a stale image — asset content hashing would fix it at a cost.*

**2. Report-only post-merge semantic checks** — OT guarantees transformability, not business correctness: two worktrees can "merge cleanly" into a circular formula reference or a broken cross-Unit link. After merge (and on merge preview) we attach structured `semanticChecks: [{kind, status: 'pass'|'warn'|'unavailable'|'error', summary}]` to existing results — never blocking, never changing merge behavior. Real checks: structure (reusing the `univer_inspect` path) and Slide layout lint (reusing `univer_lint`); formula evaluation is explicitly reported `unavailable` rather than faked (it needs the Viewer-side engine). One shared deadline (20 s), fully degradable, off-switchable.

**3. Bounded Unit Content Worker pool** — the one-shot worker reloads the entire Univer runtime + native bindings per task. Our pool: default size 2, prewarmed after Gateway readiness, idle recycle after 60 s, hard rebuild after 20 tasks per worker, one-shot mode preserved via a switch. Reuse safety is deliberately conservative: the child protocol has no reset primitive, so each request still owns its full task lifecycle; isolation relies on the request boundary + task cap + idle recycle, not on assuming in-process state can be zeroed. Cancel/timeout/crash/protocol error always destroys the worker and spawns a replacement; dispose tears everything down (SIGTERM → 3 s → SIGKILL).

### A design pitfall worth knowing (we hit it, tests caught it)

When we added prewarming, the natural implementation — `track()` the worker, consider it "live" — silently deadlocks: `run()` finds the idle queue empty while `live.size` already equals the pool size, so it queues in `waitForWorker()` forever. The fix is that prewarmed workers must go through the **same park path as `release()`** (push to idle + schedule idle recycle). If you ever add warming to a pool with this shape, that's the trap.

### Also prototyped (not in the offer, just FYI)

- Snapshot checkpointing: materialization replays the changeset chain from 0; we checkpoint when a replay exceeds ~32 changesets, landing snapshots in the SDK's own `collaboration_snapshots` (no table/version changes, `history@2` untouched).
- Paged merge preview: full-snapshot HTTP responses get expensive on large Sheets; we added optional `blocks=omit` / `blockOffset` / `blockLimit` + a blocks endpoint, default responses unchanged.

### Verification status (honest)

- ✅ 52 `node:test` behaviour tests across the three new modules (invalidation, degrade paths, LRU/TTL, concurrency dedup, cancel/crash/replacement, dispose orphans), stable across runs
- ✅ Manual review of cache-key invalidation, merge-result invariance, dispose ordering
- ✅ esbuild syntax validation on all changed TS files
- ❌ **Not compiled against the real SDK** — impossible externally due to the insider registry, hence the request above
- ⚠️ Threshold values (checkpoint 32, keep 4, page cap 512, LRU 32, TTL 5 min) are first-pass heuristics, not benchmarked

Happy to split this into separate PRs (cache / merge checks / pool) however you prefer, and to adapt to your coding and review standards. Thanks for a great plugin.
