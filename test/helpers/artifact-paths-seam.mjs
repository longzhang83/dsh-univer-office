/**
 * Test seam for `src/host/artifacts/paths.ts`.
 *
 * The bundled entries (`unit-content-worker.mjs`, `gateway.cjs`, ...) only
 * exist after `pnpm build`, which this worktree cannot run. The Worker pool is
 * the only thing under test that needs one, so the entry is redirected to
 * `test/fixtures/fake-unit-content-worker.mjs`, a script speaking the very same
 * newline-delimited JSON protocol over stdin/stdout. Every other path keeps
 * pointing at its real location.
 */
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../src/host/artifacts/', import.meta.url))

export const GATEWAY_ENTRY = `${root}gateway.cjs`
export const VIEWER_ROOT = `${root}viewer/`
export const RENDER_MACHINE_ROOT = `${root}render-machine/`
export const PLUGIN_NODE_MODULES = fileURLToPath(new URL('../../node_modules/', import.meta.url))
export const UNIT_CONTENT_WORKER_ENTRY = fileURLToPath(
  new URL('../fixtures/fake-unit-content-worker.mjs', import.meta.url)
)
