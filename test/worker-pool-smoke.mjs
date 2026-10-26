/**
 * Behaviour tests for `src/host/adapters/unit-content/worker-pool.ts`.
 *
 * Run: node --experimental-transform-types --test test/worker-pool-smoke.mjs
 *
 * The pool spawns real child processes; only the child *entry* is replaced
 * (see test/helpers/artifact-paths-seam.mjs) with a script that speaks the same
 * newline-delimited JSON protocol, because the bundled worker needs a build
 * plus Univer's native bindings. Spawn counting, reuse, replacement, and the
 * absence of orphan processes are therefore observed on real pids.
 */
import './helpers/load-ts-source.mjs'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import {
  alive,
  readPids,
  resetPidLog,
  sleep,
  waitForPids,
  waitUntilDead
} from './helpers/fake-worker-pid-log.mjs'

const { UnitContentWorkerPool } = await import(
  '../src/host/adapters/unit-content/worker-pool.ts'
)
const { UnitContentWorker } = await import('../src/host/adapters/unit-content/worker.ts')
const { UnitContentOperations } = await import('../src/host/provider/unit-content-operations.ts')

/** A request the fake worker understands; `mode` selects its behaviour. */
const request = (mode) => ({
  operation: 'inspect',
  gatewayOrigin: 'http://127.0.0.1:8199',
  commitTimeoutMs: 1_000,
  fileKey: 'demo',
  filePath: '/workspace/demo.univer',
  unitId: mode,
  unitType: 2
})

const pools = []
function makePool({ operationTimeoutMs = 3_000, ...settings } = {}) {
  const pool = new UnitContentWorkerPool(
    { enabled: true, size: 1, idleTimeoutMs: 5_000, maxTasksPerWorker: 10, ...settings },
    operationTimeoutMs
  )
  pools.push(pool)
  return pool
}

beforeEach(async () => {
  await resetPidLog()
})

after(async () => {
  await Promise.all(pools.map((pool) => pool.dispose()))
})

describe('UnitContentWorkerPool reuse', () => {
  it('serves consecutive tasks from one warm worker', async () => {
    const pool = makePool()
    const first = await pool.run(request('ok'))
    const second = await pool.run(request('ok'))

    assert.equal(first.pid, second.pid, 'a healthy worker must be reused')
    assert.equal(second.unitId, 'ok')
    assert.deepEqual(pool.status(), { size: 1, live: 1, idle: 1, waiting: 0, disposed: false })
    assert.equal(alive(first.pid), true)
  })

  it('rebuilds a worker that reached its task limit', async () => {
    const pool = makePool({ maxTasksPerWorker: 2 })
    const pids = []
    for (let index = 0; index < 3; index += 1) pids.push((await pool.run(request('ok'))).pid)

    assert.equal(pids[0], pids[1])
    assert.notEqual(pids[1], pids[2], 'the third task must run on a rebuilt worker')
    assert.deepEqual(pool.status(), { size: 1, live: 1, idle: 1, waiting: 0, disposed: false })
    assert.equal(await waitUntilDead(pids[0]), true)
  })

  it('never holds more live workers than its size', async () => {
    const pool = makePool({ size: 1 })
    const tasks = [pool.run(request('ok')), pool.run(request('ok')), pool.run(request('ok'))]

    assert.deepEqual(pool.status(), { size: 1, live: 1, idle: 0, waiting: 2, disposed: false })
    const results = await Promise.all(tasks)
    assert.equal(new Set(results.map((result) => result.pid)).size, 1, 'queued tasks reuse the worker')
    assert.equal(await readPids().then((pids) => pids.length), 1)
  })
})

describe('UnitContentWorkerPool failure handling', () => {
  it('discards a crashed worker and replaces it', async () => {
    const pool = makePool()
    await assert.rejects(
      pool.run(request('crash')),
      (error) =>
        error.code === 'UNIT_CONTENT_WORKER_INVALID_RESPONSE' &&
        /exited unexpectedly/u.test(error.message)
    )

    assert.equal(pool.status().live, 0, 'a crashed worker must not return to the pool')
    const [crashed] = await readPids()
    assert.equal(await waitUntilDead(crashed), true)

    const replacement = await pool.run(request('ok'))
    assert.notEqual(replacement.pid, crashed)
    assert.equal(pool.status().live, 1)
  })

  it('discards a worker that breaks the response protocol', async () => {
    const pool = makePool()
    await assert.rejects(
      pool.run(request('garbage')),
      (error) =>
        error.code === 'UNIT_CONTENT_WORKER_INVALID_RESPONSE' &&
        /invalid output/u.test(error.message)
    )
    assert.equal(pool.status().live, 0)

    const replacement = await pool.run(request('ok'))
    assert.equal(replacement.unitId, 'ok')
    assert.equal(pool.status().live, 1)
  })

  it('surfaces a worker-reported failure and still recycles the worker', async () => {
    const pool = makePool()
    await assert.rejects(
      pool.run(request('error')),
      (error) =>
        error.code === 'UNIT_CONTENT_WORKER_FAILED' && error.message === 'fake failure'
    )
    assert.equal(pool.status().live, 0)
  })

  it('kills and replaces a worker whose task timed out', async () => {
    const pool = makePool({ operationTimeoutMs: 200 })
    await assert.rejects(
      pool.run(request('hang')),
      (error) =>
        error.code === 'UNIT_CONTENT_WORKER_TIMEOUT' &&
        error.message === 'Unit content operation timed out after 200ms.'
    )

    const [hung] = await readPids()
    assert.equal(await waitUntilDead(hung), true, 'the timed-out child must be killed')
    assert.equal(pool.status().live, 0)

    const replacement = await pool.run(request('ok'))
    assert.notEqual(replacement.pid, hung)
  })

  it('kills and replaces a worker whose task was cancelled', async () => {
    const pool = makePool()
    const controller = new AbortController()
    const task = pool.run(request('slow:400'), controller.signal)
    await sleep(60)
    controller.abort()

    await assert.rejects(task, (error) => error.name === 'AbortError')
    const [cancelled] = await readPids()
    assert.equal(await waitUntilDead(cancelled), true, 'the cancelled child must be killed')
    assert.equal(pool.status().live, 0)

    const replacement = await pool.run(request('ok'))
    assert.notEqual(replacement.pid, cancelled)
  })
})

describe('UnitContentWorkerPool lifecycle', () => {
  it('recycles a worker left idle past the idle timeout', async () => {
    const pool = makePool({ idleTimeoutMs: 80 })
    const first = await pool.run(request('ok'))
    assert.deepEqual(pool.status(), { size: 1, live: 1, idle: 1, waiting: 0, disposed: false })

    await sleep(250)
    assert.equal(pool.status().live, 0, 'an idle worker must be recycled')
    assert.equal(await waitUntilDead(first.pid), true)

    const second = await pool.run(request('ok'))
    assert.notEqual(second.pid, first.pid)
  })

  it('leaves no child process behind after dispose', { timeout: 10_000 }, async () => {
    const pool = makePool({ size: 2 })
    pool.prewarm()
    const pids = await waitForPids(2)
    assert.equal(pids.length, 2)
    assert.equal(pool.status().live, 2)

    await pool.dispose()
    assert.deepEqual(pool.status(), { size: 2, live: 0, idle: 0, waiting: 0, disposed: true })
    for (const pid of pids) assert.equal(await waitUntilDead(pid), true, `pid ${String(pid)} outlived dispose`)
  })

  it('rejects tasks queued when dispose happens', async () => {
    const pool = makePool({ size: 1 })
    const running = pool.run(request('slow:400'))
    await sleep(60)
    const queued = pool.run(request('ok'))
    await sleep(60)
    // Attach both handlers before disposing: the in-flight task is rejected by
    // the same dispose, and an unhandled rejection would mask the assertion.
    const settled = Promise.all([
      running.then(
        () => null,
        (error) => error
      ),
      queued.then(
        () => null,
        (error) => error
      )
    ])

    assert.equal(pool.status().waiting, 1)
    await pool.dispose()
    const [runningError, queuedError] = await settled

    assert.equal(queuedError?.code, 'UNIT_CONTENT_WORKER_INVALID_RESPONSE')
    assert.equal(runningError?.code, 'UNIT_CONTENT_WORKER_INVALID_RESPONSE')
    assert.equal(pool.status().disposed, true)
  })

  it('refuses further tasks once disposed', async () => {
    const pool = makePool()
    await pool.dispose()
    await assert.rejects(
      pool.run(request('ok')),
      (error) =>
        error.code === 'UNIT_CONTENT_WORKER_INVALID_RESPONSE' &&
        /disposed/u.test(error.message)
    )
  })
})

describe('one-shot fallback', () => {
  it('spawns and disposes nothing while pooling is disabled', async () => {
    const operations = new UnitContentOperations(1_000, 1_000, 3_000, {
      enabled: false,
      size: 2,
      idleTimeoutMs: 5_000,
      maxTasksPerWorker: 4
    })
    operations.prewarm()
    await sleep(80)
    assert.deepEqual(await readPids(), [], 'prewarm is a no-op when pooling is disabled')
    await operations.dispose()
    assert.deepEqual(await readPids(), [])
  })

  it('prewarms and stops pooled workers while pooling is enabled', async () => {
    const operations = new UnitContentOperations(1_000, 1_000, 3_000, {
      enabled: true,
      size: 2,
      idleTimeoutMs: 5_000,
      maxTasksPerWorker: 4
    })
    operations.prewarm()
    const pids = await waitForPids(2)
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.equal(alive(pid), true)

    await operations.dispose()
    for (const pid of pids) assert.equal(await waitUntilDead(pid), true)
  })

  it('runs a task on a prewarmed worker instead of waiting forever', async () => {
    const pool = makePool({ size: 1, maxTasksPerWorker: 4 })
    pool.prewarm()
    await waitForPids(1)

    // Regression: workers created by prewarm() used to be tracked as live but
    // never parked in the idle queue, so the first run() reached
    // waitForWorker() and hung until something else released a worker.
    const result = await Promise.race([
      pool.run(request('ok')),
      sleep(1_500).then(() => 'TIMEOUT')
    ])

    assert.notEqual(result, 'TIMEOUT', 'a prewarmed worker must serve the next task')
    await pool.dispose()
  })

  it('still completes a task through the one-shot worker, which then exits', async () => {
    const worker = new UnitContentWorker(3_000)
    const result = await worker.run(request('ok'))
    const [pid] = await readPids()

    assert.equal(result.pid, pid)
    assert.equal(result.unitId, 'ok')
    assert.equal(await waitUntilDead(pid), true, 'the one-shot worker must exit after its task')
  })
})
