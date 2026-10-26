import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { UNIT_CONTENT_WORKER_ENTRY } from '../../artifacts/paths.ts'
import { UniverError } from '../../service/errors.ts'
import type { JsonValue } from '../../service/types.ts'
import {
  parseUnitContentWorkerEnvelope,
  type UnitContentWorkerEnvelope,
  type UnitContentWorkerRequest
} from './protocol.ts'
import { unitContentWorkerEnvironment, workerDiagnostic } from './worker.ts'

/** Pool sizing and recycling policy for Unit Content Worker processes. */
export interface UnitContentWorkerPoolSettings {
  /** Reuse warm worker processes instead of spawning one process per task. */
  readonly enabled: boolean
  /** Maximum number of live pooled worker processes; concurrent tasks beyond this queue. */
  readonly size: number
  /** Kill a pooled worker after this much idle time without a task. */
  readonly idleTimeoutMs: number
  /** Force-rebuild a worker once it has completed this many tasks. */
  readonly maxTasksPerWorker: number
}

/** Grace period before a stopping worker is force-killed; mirrors Gateway cleanup. */
const WORKER_STOP_GRACE_MS = 3_000

/**
 * Bounded pool of warm Unit Content Worker processes.
 *
 * The child protocol has no in-process reset primitive: every request runs the
 * full per-task lifecycle (collaboration runtime created and closed inside one
 * `main()` call, no module-level task state), so reuse safety relies on that
 * request boundary plus conservative recycling — a task-count cap forces
 * periodic rebuilds, idle workers are killed after a timeout, and a worker
 * whose task timed out, was cancelled, crashed, or broke the protocol is
 * always discarded instead of returned to the pool. Set `enabled: false` to
 * fall back to the one-shot worker.
 */
export class UnitContentWorkerPool {
  private readonly idle: PooledUnitContentWorker[] = []
  private readonly live = new Set<PooledUnitContentWorker>()
  private readonly waiters: Array<{
    resolve: (worker: PooledUnitContentWorker) => void
    reject: (error: unknown) => void
  }> = []
  private disposed = false

  constructor(
    private readonly settings: UnitContentWorkerPoolSettings,
    private readonly operationTimeoutMs: number
  ) {}

  /** Top the pool up to its size with warm workers ahead of the first task. */
  prewarm(): void {
    if (this.disposed) return
    while (this.live.size < this.settings.size) {
      // A prewarmed worker must land in the idle queue, otherwise `run()`
      // finds no idle worker while `live.size` already sits at the pool size
      // and waits forever for a release that will never happen.
      this.park(this.track(new PooledUnitContentWorker()))
      poolLog(
        `prewarmed Unit Content Worker (${String(this.live.size)}/${String(this.settings.size)} live)`
      )
    }
  }

  /** Run one request on an exclusively checked-out worker. */
  async run(request: UnitContentWorkerRequest, signal?: AbortSignal): Promise<JsonValue> {
    if (this.disposed)
      throw new UniverError(
        'Unit content worker pool has been disposed.',
        'UNIT_CONTENT_WORKER_INVALID_RESPONSE'
      )
    signal?.throwIfAborted()
    const idleWorker = this.idle.pop()
    const worker =
      idleWorker ??
      (this.live.size < this.settings.size
        ? this.track(new PooledUnitContentWorker())
        : await this.waitForWorker(signal))
    worker.beginTask()
    try {
      const result = await worker.run(request, this.operationTimeoutMs, signal)
      this.release(worker, true)
      return result
    } catch (error) {
      // Timeout, cancellation, crash, and protocol errors all poison the
      // worker: it is destroyed here and never handed to another task.
      this.release(worker, false)
      throw error
    }
  }

  /** Snapshot of the pool for diagnostics and tests. */
  status(): {
    readonly size: number
    readonly live: number
    readonly idle: number
    readonly waiting: number
    readonly disposed: boolean
  } {
    return {
      size: this.settings.size,
      live: this.live.size,
      idle: this.idle.length,
      waiting: this.waiters.length,
      disposed: this.disposed
    }
  }

  /** Kill every pooled worker and reject queued callers. */
  async dispose(): Promise<void> {
    this.disposed = true
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) {
      waiter.reject(
        new UniverError(
          'Unit content worker pool has been disposed.',
          'UNIT_CONTENT_WORKER_INVALID_RESPONSE'
        )
      )
    }
    const workers = [...this.live]
    this.live.clear()
    this.idle.length = 0
    await Promise.all(workers.map((worker) => worker.destroy()))
    if (workers.length > 0)
      poolLog(`disposed Unit Content Worker pool (${String(workers.length)} workers stopped)`)
  }

  /** Register a freshly spawned worker and watch it for unplanned exits. */
  private track(worker: PooledUnitContentWorker): PooledUnitContentWorker {
    this.live.add(worker)
    worker.onUnexpectedExit = () => this.forget(worker)
    return worker
  }

  /** Drop a worker from the pool without killing it (it already exited). */
  private forget(worker: PooledUnitContentWorker): void {
    this.live.delete(worker)
    const index = this.idle.indexOf(worker)
    if (index >= 0) this.idle.splice(index, 1)
  }

  private async waitForWorker(signal?: AbortSignal): Promise<PooledUnitContentWorker> {
    return await new Promise<PooledUnitContentWorker>((resolve, reject) => {
      const waiter = {
        resolve: (worker: PooledUnitContentWorker): void => {
          cleanup()
          resolve(worker)
        },
        reject: (error: unknown): void => {
          cleanup()
          reject(error)
        }
      }
      const cleanup = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        waiter.reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Return a finished worker to the pool or destroy it. */
  private release(worker: PooledUnitContentWorker, healthy: boolean): void {
    worker.endTask()
    if (!healthy || worker.taskCount >= this.settings.maxTasksPerWorker) {
      void this.discard(worker, healthy ? 'task limit reached' : 'unhealthy')
      return
    }
    this.park(worker)
  }

  /** Park a healthy, unused worker: hand it to a waiter or keep it idle. */
  private park(worker: PooledUnitContentWorker): void {
    if (this.disposed) {
      void this.discard(worker, 'disposed')
      return
    }
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(worker)
      return
    }
    this.idle.push(worker)
    worker.scheduleIdleRecycle(this.settings.idleTimeoutMs, () => {
      void this.discard(worker, 'idle timeout')
    })
  }

  private async discard(worker: PooledUnitContentWorker, reason: string): Promise<void> {
    this.forget(worker)
    await worker.destroy()
    poolLog(`discarded Unit Content Worker (${reason}; ${String(this.live.size)} live)`)
  }
}

/** One pooled Unit Content Worker child process serving one request at a time. */
class PooledUnitContentWorker {
  private readonly child: ChildProcess
  private stdoutBuffer = ''
  private readonly stderr: Buffer[] = []
  private pending: {
    readonly resolve: (envelope: UnitContentWorkerEnvelope) => void
    readonly reject: (error: unknown) => void
    readonly timeout: NodeJS.Timeout
    readonly timeoutMs: number
    timedOut: boolean
    abortReason: unknown
  } | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private destroyed = false
  private exitNotified = false
  taskCount = 0
  onUnexpectedExit: (() => void) | null = null

  constructor() {
    this.child = spawn(process.execPath, [UNIT_CONTENT_WORKER_ENTRY], {
      env: unitContentWorkerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Spurious or malformed output poisons the worker; kill it and let the
    // caller rebuild. Empty lines are framing noise and are skipped.
    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk)
      if (this.stderr.length > 100) this.stderr.shift()
    })
    this.child.once('error', () => {
      this.failPending(workerDiagnostic(this.stderr, 'Unit content worker failed to start.'))
    })
    this.child.once('close', () => this.onClose())
    // The child writes to its own stderr; keep it from surfacing in the Host.
    this.child.stdin?.on('error', () => {
      // Expected when the child already exited; 'close' settles the task.
    })
  }

  /** Mark the worker as checked out and stop any idle recycle timer. */
  beginTask(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** Count one completed task; called by the pool on release. */
  endTask(): void {
    this.taskCount += 1
  }

  scheduleIdleRecycle(idleTimeoutMs: number, onExpire: () => void): void {
    this.idleTimer = setTimeout(onExpire, idleTimeoutMs)
  }

  /** Run one request and return its JSON result; the worker stays alive on success. */
  async run(
    request: UnitContentWorkerRequest,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    signal?.throwIfAborted()
    if (this.destroyed || this.pending !== null)
      throw new UniverError(
        'Unit content worker is not available for a new task.',
        'UNIT_CONTENT_WORKER_INVALID_RESPONSE'
      )
    const envelope = await new Promise<UnitContentWorkerEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending
        if (pending !== null) {
          pending.timedOut = true
          this.child.kill()
        }
      }, timeoutMs)
      this.pending = {
        resolve,
        reject,
        timeout,
        timeoutMs,
        timedOut: false,
        abortReason: undefined
      }
      // The listener outlives the write callback on purpose: an abort after
      // the request was flushed must still kill the worker. It becomes a
      // no-op once `pending` is cleared, and dies with the task's signal.
      const onAbort = (): void => {
        const pending = this.pending
        if (pending !== null) {
          pending.abortReason = signal?.reason
          this.child.kill()
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.child.stdin?.write(`${JSON.stringify(request)}\n`)
    })
    signal?.throwIfAborted()
    if (envelope.ok) return envelope.result
    throw new UniverError(envelope.error.message, envelope.error.code)
  }

  /** Terminate the worker, escalating to SIGKILL after the grace period. */
  async destroy(): Promise<void> {
    this.destroyed = true
    this.clearIdleTimer()
    const child = this.child
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, WORKER_STOP_GRACE_MS))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8')
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.length > 0) this.onEnvelopeLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private onEnvelopeLine(line: string): void {
    let envelope: UnitContentWorkerEnvelope | null = null
    let parseError: unknown
    try {
      envelope = parseUnitContentWorkerEnvelope(JSON.parse(line) as unknown)
    } catch (error) {
      parseError = error
    }
    const pending = this.pending
    if (envelope !== null && pending !== null) {
      this.pending = null
      clearTimeout(pending.timeout)
      pending.resolve(envelope)
      return
    }
    const cause = envelope === null ? parseError : undefined
    this.failPending(
      workerDiagnostic(this.stderr, 'Unit content worker returned invalid output.'),
      cause
    )
    this.child.kill()
  }

  private onClose(): void {
    this.failPending(
      workerDiagnostic(
        this.stderr,
        `Unit content worker exited unexpectedly (${String(
          this.child.signalCode ?? this.child.exitCode ?? 'unknown'
        )}).`
      )
    )
    if (!this.destroyed && !this.exitNotified) {
      this.exitNotified = true
      this.onUnexpectedExit?.()
    }
  }

  /** Reject the pending task, if any; safe to call on every failure path. */
  private failPending(message: string, cause?: unknown): void {
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    clearTimeout(pending.timeout)
    if (pending.timedOut)
      pending.reject(
        new UniverError(
          `Unit content operation timed out after ${String(pending.timeoutMs)}ms.`,
          'UNIT_CONTENT_WORKER_TIMEOUT'
        )
      )
    else if (pending.abortReason !== undefined) pending.reject(pending.abortReason)
    else
      pending.reject(
        new UniverError(message, 'UNIT_CONTENT_WORKER_INVALID_RESPONSE', {
          ...(cause === undefined ? {} : { cause })
        })
      )
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

/** Debug trace in the style of `UNIVER_DSH_GATEWAY_DEBUG`. */
function poolLog(message: string): void {
  if (process.env.UNIVER_DSH_WORKER_POOL_DEBUG === '1')
    process.stderr.write(`[univer:worker-pool] ${message}\n`)
}
